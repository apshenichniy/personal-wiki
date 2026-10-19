import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Redacted } from "effect";
import { makeJobClient } from "@personal-wiki/client";
import { ProviderLedger } from "../apps/knowledge-service/src/providers/ledger.ts";
import { makeApifyHttp } from "../apps/runner/src/apify/http.ts";
import { ingestX } from "../apps/runner/src/apify/ingest.ts";
import { defaultCapturePolicy } from "../packages/source-processing/src/index.ts";
import { launch } from "./helpers/service.ts";

test("X to retained thread and Article resumes across a Service restart without another Actor POST", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-acquisition-pipeline-"));
  const ledgerFile = join(root, "accounting.sqlite");
  const credentialFile = join(root, "credentials.json");
  const operator = `wk_${Buffer.alloc(32, 1).toString("base64url")}`;
  const runner = `wk_${Buffer.alloc(32, 2).toString("base64url")}`;
  await writeFile(
    credentialFile,
    JSON.stringify({
      credentials: [
        { identityId: randomUUID(), role: "operator", token: operator },
        { identityId: randomUUID(), role: "runner", token: runner },
      ],
    }),
    { mode: 0o600 },
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* ProviderLedger).provision(
        {
          version: "apify-x-v1",
          actorId: "actor",
          buildId: "build",
          buildNumber: "1.0.0",
          privacyEvidence: "a".repeat(64),
          pricingEvidence: "b".repeat(64),
          inputSchemaDigest: "c".repeat(64),
          campaignId: "synthetic",
          eventNanos: 150_000,
          platformNanos: 50_000_000,
          retrievalNanos: 20_000_000,
        },
        [],
      );
    }).pipe(Effect.provide(ProviderLedger.layer(ledgerFile))),
  );
  const post = (id: string, parent: string | null, author = "10") => ({
    id,
    text: `Substantive synthetic statement ${id}.`,
    author: { id: author },
    isReply: parent !== null,
    inReplyToId: parent,
    conversationId: "100",
    lang: "en",
    createdAt: "2026-10-19T12:00:00.000Z",
  });
  const anchor = { ...post("100", null), quotedTweetId: "200" };
  const continuation = post("101", "100");
  const quote = {
    ...post("200", null, "30"),
    conversationId: "200",
    article: { id: "900", previewText: "Article preview only" },
  };
  const reply = post("201", "100", "20");
  const correction = post("202", "201", "10");
  const values = new Map([
    ["100", anchor],
    ["101", continuation],
    ["200", quote],
    ["201", reply],
    ["202", correction],
  ]);
  const runs = new Map<string, { rows: unknown[]; startedAt: string; finishedAt: string }>();
  const articleInputs: unknown[] = [];
  let starts = 0;
  const apify = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v2/acts/actor/runs") {
        starts++;
        const input = (await request.json()) as Record<string, unknown>;
        let rows: unknown[] = [];
        if (input.mode === "tweets")
          rows = (input.tweetIds as string[]).flatMap((id) =>
            values.has(id) ? [values.get(id)!] : [],
          );
        if (input.mode === "thread") rows = [anchor, continuation, post("999", null, "90")];
        if (input.mode === "replies")
          rows = [reply, correction].filter((row) =>
            (input.replyTweetIds as string[]).includes(row.inReplyToId!),
          );
        if (input.mode === "search") rows = [reply, correction];
        if (input.mode === "article") {
          articleInputs.push(input.articleTweetIds);
          rows = [
            {
              resultType: "article",
              sourceTweetId: "200",
              article: {
                articleId: "900",
                title: "Synthetic Article",
                bodyMarkdown: "# Synthetic Article\n\nComplete substantive article source.",
              },
            },
          ];
        }
        const id = `run${starts}`;
        const now = new Date().toISOString();
        runs.set(id, { rows, startedAt: now, finishedAt: now });
        return Response.json({
          data: {
            id,
            actId: "actor",
            buildId: "build",
            defaultDatasetId: id,
            defaultKeyValueStoreId: id,
            startedAt: now,
            finishedAt: null,
            status: "RUNNING",
            usageTotalUsd: 0,
          },
        });
      }
      const id = url.pathname.split("/")[3]!;
      const run = runs.get(id);
      if (!run) return new Response(null, { status: 404 });
      if (url.pathname.startsWith("/v2/actor-runs/"))
        return Response.json({
          data: {
            id,
            actId: "actor",
            buildId: "build",
            defaultDatasetId: id,
            defaultKeyValueStoreId: id,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            status: "SUCCEEDED",
            usageTotalUsd: run.rows.length * 0.00015,
          },
        });
      if (url.pathname.startsWith("/v2/key-value-stores/"))
        return Response.json({
          schemaVersion: 1,
          outcome: "success",
          results: { completionReason: "bounded", realRows: run.rows.length },
        });
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const page = run.rows.slice(offset, offset + limit);
      return Response.json(page, {
        headers: {
          "x-apify-pagination-offset": String(offset),
          "x-apify-pagination-count": String(page.length),
          "x-apify-pagination-limit": String(limit),
          "x-apify-pagination-total": String(run.rows.length),
        },
      });
    },
  });
  const objects = new Map<string, Uint8Array>();
  let objectWrites = 0;
  const archive = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const key = new URL(request.url).pathname;
      if (request.method === "PUT") {
        expect(request.headers.get("if-none-match")).toBe("*");
        if (objects.has(key)) return new Response(null, { status: 412 });
        objects.set(key, new Uint8Array(await request.arrayBuffer()));
        objectWrites++;
        return new Response(null);
      }
      return objects.has(key)
        ? new Response(Buffer.from(objects.get(key)!))
        : new Response(null, { status: 404 });
    },
  });
  const env = {
    WIKI_PROVIDER_LEDGER_FILE: ledgerFile,
    WIKI_MACHINE_CREDENTIALS_FILE: credentialFile,
    WIKI_TEST_ARCHIVE_ORIGIN: archive.url.origin,
  };
  let service = await launch(
    join(root, "library"),
    env,
    false,
    "tests/helpers/provider-pipeline-service.ts",
  );
  const http = makeApifyHttp(Redacted.make("synthetic-provider-token"), apify.url.origin);
  const claim = async (
    client: Effect.Success<ReturnType<typeof makeJobClient>>,
    instanceId: string,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (let i = 0; i < 200; i++) {
          const result = yield* client.worker.claim({
            payload: { requestId: randomUUID(), instanceId },
          });
          if (result) return result;
          yield* Effect.sleep("20 millis");
        }
        return yield* Effect.die("Claim not delivered");
      }),
    );
  try {
    let owner = await Effect.runPromise(makeJobClient(service.url, operator));
    let client = await Effect.runPromise(makeJobClient(service.url, runner));
    await Effect.runPromise(
      owner.jobs.submit({
        payload: { requestId: randomUUID(), mode: "save", url: "https://x.com/example/status/100" },
      }),
    );
    const first = await claim(client, randomUUID());
    const heartbeat = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("5 seconds");
        yield* client.worker.heartbeat({
          payload: { requestId: randomUUID(), scope: first.scope },
        });
      }
    });
    const crashClient = {
      ...client,
      worker: {
        ...client.worker,
        prepare: () => Effect.die("Synthetic interruption after source uploads"),
      },
    };
    const interrupted = await Effect.runPromise(
      ingestX({ client: crashClient, http, spool: join(root, "spool"), claim: first }).pipe(
        Effect.raceFirst(heartbeat),
        Effect.exit,
      ),
    );
    expect(interrupted._tag).toBe("Failure");
    expect(
      (await Effect.runPromise(owner.jobs.get({ params: { jobId: first.scope.jobId } }))).stage,
    ).toBe("acquiring");
    expect(articleInputs).toEqual([["200"]]);
    expect(starts).toBeGreaterThan(4);
    const paidBefore = starts;
    const objectsBefore = objectWrites;
    await service.stop();
    service = await launch(
      join(root, "library"),
      env,
      false,
      "tests/helpers/provider-pipeline-service.ts",
    );
    owner = await Effect.runPromise(makeJobClient(service.url, operator));
    client = await Effect.runPromise(makeJobClient(service.url, runner));
    const resumed = await claim(client, randomUUID());
    expect(resumed.scope.epoch).toBeGreaterThan(first.scope.epoch);
    const policy = await Effect.runPromise(
      client.providers.configure({
        payload: {
          requestId: randomUUID(),
          scope: resumed.scope,
          policy: { ...defaultCapturePolicy, main: 1 },
        },
      }),
    );
    expect(policy.main).toBe(50);
    const result = await Effect.runPromise(
      ingestX({ client, http, spool: join(root, "spool"), claim: resumed }),
    );
    expect(result.stage).toBe("prepared");
    expect(result.warnings.some((warning) => warning.endsWith(":budget"))).toBe(false);
    expect(result.counters.launches).toBe(0);
    expect(starts).toBe(paidBefore);
    expect(objectWrites).toBe(objectsBefore);
    const ready = await claim(client, resumed.scope.instanceId);
    expect(ready.capture?.captures).toHaveLength(2);
    const main = ready.capture!.captures[0]!;
    expect(main.observations.map((post) => post.providerId)).toContain("101");
    expect(main.observations.map((post) => post.providerId)).not.toContain("999");
    expect(main.observations.map((post) => post.providerId)).toContain("202");
    expect(main.assetIds.length).toBeGreaterThan(2);
    expect(main.coverage.main).not.toBe("complete");
    expect(ready.capture!.captures[1]?.observations[0]?.text).toContain(
      "Complete substantive article source",
    );
  } finally {
    await service.stop();
    await archive.stop(true);
    await apify.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
