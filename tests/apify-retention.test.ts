import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Effect, Redacted } from "effect";
import { makeJobClient } from "@personal-wiki/client";
import type * as P from "@personal-wiki/contracts/provider";
import { makeRetention, rawSpool } from "../apps/runner/src/apify/retention.ts";
import { makeApifyHttp } from "../apps/runner/src/apify/http.ts";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const op = (): P.Operation => ({
  operationId: crypto.randomUUID(),
  job: {
    jobId: crypto.randomUUID(),
    namespace: "staging",
    startedAt: Date.now() - 600_000,
    deadline: Date.now() - 300_000,
  },
  planKey: "anchor",
  digest: "a".repeat(64),
  inputJson: "{}",
  chargeNanos: 150_000,
  platformNanos: 20_000_000,
  retrievalNanos: 20_000_000,
  replacementOf: null,
  phase: "known",
  month: "2026-10",
  campaignId: "synthetic",
  reservedAt: Date.now() - 600_000,
  dispatchedAt: Date.now() - 600_000,
  dispatchNonce: crypto.randomUUID(),
  run: {
    runId: "run",
    datasetId: "dataset",
    keyValueStoreId: "kv",
    buildId: "build",
    startedAt: Date.now() - 600_000,
  },
  status: "SUCCEEDED",
  finishedAt: Date.now() - 550_000,
  observedCost: 150_000,
  costSample: 150_000,
  costSampleAt: Date.now() - 530_000,
  costStable: true,
  stopRequested: true,
  archived: false,
  transientFailure: false,
  resolutionEvidence: null,
});

test("retention replays exact spooled bytes after Service failure without a second provider download", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-retention-"));
  const operation = op();
  const pages: P.Page[] = [];
  let pageGets = 0;
  let runGets = 0;
  let failUpload = true;
  const received: string[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.method).toBe("GET");
      const path = new URL(request.url).pathname;
      if (path === "/v2/actor-runs/run") {
        runGets++;
        return Response.json({
          data: {
            id: "run",
            actId: "actor",
            buildId: "build",
            defaultDatasetId: "dataset",
            defaultKeyValueStoreId: "kv",
            status: "SUCCEEDED",
            startedAt: new Date(operation.run!.startedAt).toISOString(),
            finishedAt: new Date(operation.finishedAt!).toISOString(),
            usageTotalUsd: runGets * 0.001,
          },
        });
      }
      expect(path).toBe("/v2/datasets/dataset/items");
      pageGets++;
      return Response.json([{ id: "100", text: `Response ${pageGets}` }], {
        headers: {
          "x-apify-pagination-offset": "0",
          "x-apify-pagination-limit": "100",
          "x-apify-pagination-count": "1",
          "x-apify-pagination-total": "1",
        },
      });
    },
  });
  const service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const input = (await request.json()) as {
        kind: string;
        base64: string;
        offset: number;
        total: number;
        sha256: string;
      };
      if (path.endsWith("/pages")) return Response.json(pages);
      if (path.endsWith("/inspect"))
        return Response.json({ shouldStop: true, operations: [operation] });
      if (path.endsWith("/archive")) return Response.json({ ...operation, archived: true });
      expect(path).toBe("/internal/v1/providers/retain");
      if (input.kind === "dataset") {
        received.push(input.base64);
        if (failUpload) {
          failUpload = false;
          return Response.json(
            {
              code: "unavailable",
              message: "Synthetic loss before retention",
              requestId: crypto.randomUUID(),
            },
            { status: 503 },
          );
        }
      }
      const page: P.Page = {
        operationId: operation.operationId,
        pageKey: input.kind === "dataset" ? `dataset:${input.offset}:${input.total}` : input.kind,
        assetId: crypto.randomUUID(),
        sha256: input.sha256,
        byteLength: Buffer.from(input.base64, "base64").length,
        offset: input.offset,
        itemCount: input.kind === "dataset" ? 1 : 0,
      };
      pages.push(page);
      return Response.json(page);
    },
  });
  try {
    const client = await Effect.runPromise(makeJobClient(service.url.origin, "synthetic-token"));
    const options = {
      client,
      http: makeApifyHttp(Redacted.make("synthetic-token"), provider.url.origin),
      spool: join(root, "raw"),
    };
    expect(
      await Effect.runPromise(
        makeRetention(options)(operation, Date.now() + 10000).pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure" });
    expect(pageGets).toBe(1);
    expect(runGets).toBe(1);
    expect(
      (await Effect.runPromise(makeRetention(options)(operation, Date.now() + 10000))).archived,
    ).toBe(true);
    expect(pageGets).toBe(1);
    expect(runGets).toBe(1);
    expect(received).toHaveLength(2);
    expect(received[0]).toBe(received[1]);
    expect(pages).toHaveLength(2);
  } finally {
    await service.stop(true);
    await provider.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("raw spool rejects corrupt, changed and symlinked evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-raw-spool-"));
  const spool = rawSpool(root);
  const id = crypto.randomUUID();
  const bytes = Buffer.from("[]");
  const input = {
    operationId: id,
    kind: "dataset" as const,
    offset: 0,
    total: 0,
    sha256: sha(bytes),
    base64: bytes.toString("base64"),
  };
  try {
    expect(await Effect.runPromise(spool.load(id, "dataset-0"))).toBeNull();
    expect(await Effect.runPromise(spool.save(input))).toEqual(input);
    const changed = Buffer.from("[{}]");
    expect(
      await Effect.runPromise(
        spool
          .save({ ...input, sha256: sha(changed), base64: changed.toString("base64") })
          .pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } });
    expect(await Effect.runPromise(spool.load(id, "dataset-0"))).toEqual(input);
    const other = crypto.randomUUID();
    await symlink(
      join(root, `${id}.dataset-0.raw.json`),
      join(root, `${other}.dataset-0.raw.json`),
    );
    expect(
      await Effect.runPromise(spool.load(other, "dataset-0").pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "storage" } });
    await writeFile(join(root, `${id}.dataset-0.raw.json`), "broken", { mode: 0o600 });
    expect(await Effect.runPromise(spool.load(id, "dataset-0").pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
