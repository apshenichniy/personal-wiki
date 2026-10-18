import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Redacted } from "effect";
import { makeJobClient } from "@personal-wiki/client";
import { ProviderLedger } from "../apps/knowledge-service/src/providers/ledger.ts";
import { launch } from "./helpers/service.ts";
import { makeApifyHttp } from "../apps/runner/src/apify/http.ts";
import { makeServiceAcquisition } from "../apps/runner/src/apify/service.ts";

test("built provider HTTP enforces roles and one-use permits while allowing cancelled-run reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-provider-http-"));
  const credentials = join(root, "credentials.json");
  const ledgerFile = join(root, "accounting.sqlite");
  const operator = `wk_${randomBytes(32).toString("base64url")}`;
  const runner = `wk_${randomBytes(32).toString("base64url")}`;
  await writeFile(
    credentials,
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
          actorId: "syntheticActor",
          buildId: "syntheticBuild",
          buildNumber: "1.12.394",
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
    }).pipe(Effect.provide(ProviderLedger.layer(ledgerFile))),
  );
  const service = await launch(
    join(root, "library"),
    {
      WIKI_MACHINE_CREDENTIALS_FILE: credentials,
      WIKI_PROVIDER_LEDGER_FILE: ledgerFile,
      WIKI_NAMESPACE: "staging",
    },
    true,
  );
  const post = async (path: string, body: unknown, token?: string) =>
    fetch(service.url + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    expect((await post("/internal/v1/providers/inspect", { jobId: randomUUID() })).status).toBe(
      401,
    );
    expect(
      (await post("/internal/v1/providers/inspect", { jobId: randomUUID() }, operator)).status,
    ).toBe(403);
    const ownerClient = await Effect.runPromise(makeJobClient(service.url, operator));
    const client = await Effect.runPromise(makeJobClient(service.url, runner));
    const accepted = await Effect.runPromise(
      ownerClient.jobs.submit({
        payload: { requestId: randomUUID(), mode: "save", url: "https://x.com/example/status/100" },
      }),
    );
    expect(accepted.job).not.toBeNull();
    const instanceId = randomUUID();
    const claim = await Effect.runPromise(
      Effect.gen(function* () {
        for (let i = 0; i < 200; i++) {
          const result = yield* client.worker.claim({
            payload: { requestId: randomUUID(), instanceId },
          });
          if (result) return result;
          yield* Effect.sleep("20 millis");
        }
        return yield* Effect.die("Synthetic claim not delivered");
      }),
    );
    const input = {
      requestId: randomUUID(),
      scope: claim.scope,
      planKey: "anchor",
      replacementOf: null,
      inputJson: JSON.stringify({
        mode: "tweets",
        tweetIds: ["100"],
        maxItems: 1,
        maxItemsPerTarget: 1,
        queryType: "Latest",
        outputVariant: "raw",
        outputPreset: "nested",
        alwaysSaveRunRecords: true,
      }),
    };
    const operation = await Effect.runPromise(client.providers.reserve({ payload: input }));
    expect(operation.job.namespace).toBe("staging");
    expect(operation.chargeNanos).toBe(150_000);
    expect(
      (await Effect.runPromise(client.providers.pending())).map((op) => op.operationId),
    ).toEqual([operation.operationId]);
    expect(
      (
        await post(
          "/internal/v1/providers/reserve",
          { ...input, scope: { ...claim.scope, epoch: claim.scope.epoch + 1 } },
          runner,
        )
      ).status,
    ).toBe(409);
    const begin = {
      requestId: randomUUID(),
      scope: claim.scope,
      operationId: operation.operationId,
    };
    const permitted = await Effect.runPromise(client.providers.begin({ payload: begin }));
    expect(permitted.operation.phase).toBe("dispatching");
    expect(permitted.profile.buildId).toBe("syntheticBuild");
    const retry = await post("/internal/v1/providers/begin", begin, runner);
    expect(retry.status).toBe(409);
    const inspect = await Effect.runPromise(
      client.providers.inspect({ payload: { jobId: claim.scope.jobId } }),
    );
    expect(inspect.operations[0]?.phase).toBe("dispatching");
    expect(inspect.shouldStop).toBe(false);
    const cancelled = await Effect.runPromise(
      ownerClient.jobs.cancel({ payload: { requestId: randomUUID(), jobId: claim.scope.jobId } }),
    );
    expect(cancelled.stage).toBe("stopping");
    const providerRun = {
      runId: "syntheticRun",
      datasetId: "syntheticDataset",
      keyValueStoreId: "syntheticKv",
      buildId: "syntheticBuild",
      startedAt: Date.now(),
    };
    await Effect.runPromise(
      client.providers.attach({
        payload: { operationId: operation.operationId, run: providerRun, evidence: null },
      }),
    );
    expect(
      (await Effect.runPromise(client.providers.inspect({ payload: { jobId: claim.scope.jobId } })))
        .shouldStop,
    ).toBe(true);
    await Effect.runPromise(
      client.providers.observe({
        payload: {
          operationId: operation.operationId,
          observation: {
            runId: providerRun.runId,
            status: "ABORTING",
            finishedAt: null,
            usageNanos: null,
            transientFailure: false,
          },
        },
      }),
    );
    expect(
      (await Effect.runPromise(ownerClient.jobs.get({ params: { jobId: claim.scope.jobId } })))
        .stage,
    ).toBe("stopping");
    await Effect.runPromise(
      client.providers.observe({
        payload: {
          operationId: operation.operationId,
          observation: {
            runId: providerRun.runId,
            status: "ABORTED",
            finishedAt: Date.now(),
            usageNanos: 150_000,
            transientFailure: false,
          },
        },
      }),
    );
    const final = await Effect.runPromise(
      ownerClient.jobs.get({ params: { jobId: claim.scope.jobId } }),
    );
    expect(final.stage).toBe("cancelled");
    expect(final.cleanupPending).toBe(false);
    expect(final.counters.launches).toBe(0);
    // The actual Runner adapter reaches the built Service through HTTP and a
    // fake provider through another HTTP listener; it receives no SQL handle.
    await Effect.runPromise(
      ownerClient.jobs.submit({
        payload: { requestId: randomUUID(), mode: "save", url: "https://x.com/example/status/101" },
      }),
    );
    const nextClaim = await Effect.runPromise(
      Effect.gen(function* () {
        for (let i = 0; i < 200; i++) {
          const result = yield* client.worker.claim({
            payload: { requestId: randomUUID(), instanceId },
          });
          if (result) return result;
          yield* Effect.sleep("20 millis");
        }
        return yield* Effect.die("Synthetic claim not delivered");
      }),
    );
    let starts = 0;
    let remoteStatus = "RUNNING";
    const startedAt = new Date().toISOString();
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/v2/acts/syntheticActor/runs") {
          expect(request.method).toBe("POST");
          starts++;
        } else expect(path).toBe("/v2/actor-runs/secondSyntheticRun");
        return Response.json({
          data: {
            id: "secondSyntheticRun",
            actId: "syntheticActor",
            buildId: "syntheticBuild",
            defaultDatasetId: "secondDataset",
            defaultKeyValueStoreId: "secondKv",
            startedAt,
            finishedAt: remoteStatus === "SUCCEEDED" ? new Date().toISOString() : null,
            status: remoteStatus,
            usageTotalUsd: 0.001,
          },
        });
      },
    });
    try {
      const acquisition = makeServiceAcquisition({
        client,
        http: makeApifyHttp(Redacted.make("synthetic-provider-token"), fake.url.origin),
        spool: join(root, "spool"),
      });
      const plan = {
        planKey: "anchor",
        inputJson: input.inputJson.replace('"100"', '"101"'),
        replacementOf: null,
      };
      const known = await Effect.runPromise(acquisition.start(nextClaim.scope, plan));
      expect(known.phase).toBe("known");
      expect(known.run?.runId).toBe("secondSyntheticRun");
      expect((await Effect.runPromise(acquisition.start(nextClaim.scope, plan))).operationId).toBe(
        known.operationId,
      );
      expect(starts).toBe(1);
      remoteStatus = "SUCCEEDED";
      const settled = await Effect.runPromise(acquisition.refresh(known, Date.now() + 10000));
      expect(settled.operation.status).toBe("SUCCEEDED");
      expect(settled.operation.observedCost).toBe(1_000_000);
      expect(settled.operation.archived).toBe(false);
      expect(
        (
          await Effect.runPromise(
            ownerClient.jobs.get({ params: { jobId: nextClaim.scope.jobId } }),
          )
        ).cleanupPending,
      ).toBe(false);
    } finally {
      await fake.stop(true);
    }
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
