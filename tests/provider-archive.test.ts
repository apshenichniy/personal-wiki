import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { ProviderLedger } from "../apps/knowledge-service/src/providers/ledger.ts";
import { ProviderArchive } from "../apps/knowledge-service/src/providers/archive.ts";
import { RawArchive, makeRawArchive } from "../apps/knowledge-service/src/storage/raw-archive.ts";
import { digest } from "../apps/knowledge-service/src/storage/io.ts";
import type * as P from "@personal-wiki/contracts/provider";
import type { ProviderRawUpload } from "@personal-wiki/contracts/provider-api";

async function harness<A, E>(
  body: (
    archive: typeof ProviderArchive.Service,
    ledger: typeof ProviderLedger.Service,
    state: { failRead: boolean; writes: number },
  ) => Effect.Effect<A, E>,
) {
  const root = await mkdtemp(join(tmpdir(), "wiki-provider-archive-"));
  const state = { failRead: false, writes: 0 };
  const objects = new Map<string, Uint8Array>();
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") {
        if (objects.has(path)) return new Response(null, { status: 412 });
        objects.set(path, new Uint8Array(await request.arrayBuffer()));
        state.writes++;
        return new Response(null);
      }
      if (state.failRead || !objects.has(path)) return new Response(null, { status: 503 });
      return new Response(Buffer.from(objects.get(path)!));
    },
  });
  const layer = ProviderArchive.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ProviderLedger.layer(join(root, "ledger.sqlite")),
        Layer.succeed(
          RawArchive,
          makeRawArchive((key) => `${http.url}${key}`),
        ),
      ),
    ),
  );
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        return yield* body(yield* ProviderArchive, yield* ProviderLedger, state);
      }).pipe(Effect.provide(layer)),
    );
  } finally {
    await http.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}
const setup = Effect.fn(function* (ledger: typeof ProviderLedger.Service) {
  yield* ledger.provision(
    {
      version: "apify-x-v1",
      actorId: "synthetic",
      buildId: "build",
      buildNumber: "1.0.0",
      privacyEvidence: "a".repeat(64),
      pricingEvidence: "b".repeat(64),
      inputSchemaDigest: "c".repeat(64),
      campaignId: "synthetic",
      eventNanos: 150_000,
      platformNanos: 20_000_000,
      retrievalNanos: 20_000_000,
    },
    [],
  );
  const now = Date.now();
  const op = yield* ledger.reserve({
    job: {
      jobId: crypto.randomUUID(),
      namespace: "staging",
      startedAt: now,
      deadline: now + 300_000,
    },
    planKey: "anchor",
    inputJson: "{}",
    chargeNanos: 150_000,
    platformNanos: 20_000_000,
    retrievalNanos: 20_000_000,
    replacementOf: null,
  });
  yield* ledger.beginDispatch(op.operationId);
  yield* ledger.attachRun(op.operationId, {
    runId: "run",
    buildId: "build",
    datasetId: "dataset",
    keyValueStoreId: "kv",
    startedAt: now,
  });
  yield* ledger.observe(op.operationId, {
    runId: "run",
    status: "SUCCEEDED",
    finishedAt: now,
    usageNanos: 150_000,
    transientFailure: false,
  });
  return op.operationId;
});
const upload = (
  operationId: string,
  kind: "dataset" | "run" | "report",
  value: unknown,
  offset = 0,
  total = 0,
): typeof ProviderRawUpload.Type => {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    operationId,
    kind,
    offset,
    total,
    sha256: digest(bytes),
    base64: bytes.toString("base64"),
  };
};
const runBody = {
  data: {
    id: "run",
    buildId: "build",
    defaultDatasetId: "dataset",
    defaultKeyValueStoreId: "kv",
    status: "SUCCEEDED",
  },
};

test("archive checkpoints only verified R2 bytes and resumes a committed write after lost readback", async () =>
  harness((archive, ledger, state) =>
    Effect.gen(function* () {
      const id = yield* setup(ledger);
      const input = upload(id, "dataset", [{ id: "100" }], 0, 1);
      state.failRead = true;
      expect(yield* archive.retain(input).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { code: "unavailable" },
      });
      expect(yield* ledger.pages(id)).toHaveLength(0);
      const intent = (yield* ledger.pageIntents(id))[0]!;
      expect(intent.byteLength).toBe(Buffer.from(input.base64, "base64").length);
      state.failRead = false;
      const page = yield* archive.retain(input);
      expect(page.assetId).toBe(intent.assetId);
      expect(state.writes).toBe(1);
      expect(yield* archive.retain(input)).toEqual(page);
      expect(state.writes).toBe(1);
      expect(yield* archive.read(id, page.pageKey)).toEqual({ page, base64: input.base64 });
      expect(
        yield* archive.retain(upload(id, "dataset", [{ id: "changed" }], 0, 1)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } });
      expect(yield* archive.complete(id).pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      yield* archive.retain(upload(id, "run", runBody));
      yield* ledger.requestStop((yield* ledger.get(id)).job.jobId);
      expect((yield* archive.complete(id)).archived).toBe(true);
      expect(yield* archive.retain(input)).toEqual(page);
      expect(yield* archive.retain(upload(id, "report", {})).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { code: "invalid_transition" },
      });
    }),
  ));

test("archive completion requires contiguous final dataset pages and matching terminal metadata", async () =>
  harness((archive, ledger) =>
    Effect.gen(function* () {
      const id = yield* setup(ledger);
      yield* archive.retain(upload(id, "dataset", [{ id: "101" }], 1, 2));
      yield* archive.retain(upload(id, "run", runBody));
      expect(yield* archive.complete(id).pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      expect(
        yield* archive.retain(upload(id, "dataset", [{ id: "100" }], 0, 3)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        yield* archive.retain(upload(id, "dataset", [], 0, 2)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      yield* archive.retain(upload(id, "dataset", [{ id: "100" }], 0, 2));
      expect((yield* archive.complete(id)).archived).toBe(true);
      expect(
        yield* archive
          .retain(upload(id, "run", { data: { ...runBody.data, defaultDatasetId: "foreign" } }))
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
    }),
  ));

test("pending raw writes consume capacity and block archive completion without releasing reservations", async () =>
  harness((archive, ledger) =>
    Effect.gen(function* () {
      const id = yield* setup(ledger);
      for (let i = 0; i < 4; i++) {
        const page: P.Page = {
          operationId: id,
          pageKey: `dataset:${i}:4`,
          assetId: crypto.randomUUID(),
          sha256: "a".repeat(64),
          byteLength: 16_777_216,
          offset: i,
          itemCount: 1,
        };
        yield* ledger.reservePage(page);
        yield* ledger.reservePage(page);
      }
      expect(yield* ledger.pageIntents(id)).toHaveLength(4);
      expect(yield* ledger.pages(id)).toHaveLength(0);
      expect(yield* archive.retain(upload(id, "run", runBody)).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { code: "capacity" },
      });
      expect(yield* ledger.archived(id).pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
    }),
  ));
