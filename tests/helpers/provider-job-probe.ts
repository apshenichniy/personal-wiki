import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Clock, Console, Effect, Layer } from "effect";
import { Library } from "../../apps/knowledge-service/src/storage/library.ts";
import { digest } from "../../apps/knowledge-service/src/storage/io.ts";
import { JobStore } from "../../apps/knowledge-service/src/jobs/store.ts";
import { JobScheduler } from "../../apps/knowledge-service/src/jobs/scheduler.ts";
import { Jobs } from "../../apps/knowledge-service/src/jobs/service.ts";
import { JobLifecycle } from "../../apps/knowledge-service/src/jobs/lifecycle.ts";
import { JobProviders, makeJobProviders } from "../../apps/knowledge-service/src/providers/jobs.ts";
import { ProviderLedger } from "../../apps/knowledge-service/src/providers/ledger.ts";
import { ProviderArchive } from "../../apps/knowledge-service/src/providers/archive.ts";
import { RawArchive } from "../../apps/knowledge-service/src/storage/raw-archive.ts";
import type * as P from "@personal-wiki/contracts/provider";

const root = process.env.WIKI_DATA_DIR;
if (!root) throw new Error("Synthetic data directory is required");
const storage = JobStore.layer.pipe(Layer.provideMerge(Library.layer(root)));
const scheduled = JobScheduler.layer(root).pipe(Layer.provideMerge(storage));
const accounting = ProviderLedger.layer(join(root, "provider-accounting.sqlite"));
const base = Layer.mergeAll(
  Jobs.layer(root).pipe(Layer.provideMerge(scheduled)),
  ProviderArchive.layer.pipe(Layer.provideMerge(Layer.mergeAll(accounting, RawArchive.disabled))),
);
const runtime = Layer.mergeAll(JobProviders.layer("staging"), JobLifecycle.layer).pipe(
  Layer.provideMerge(base),
);
const program = Effect.gen(function* () {
  const jobs = yield* Jobs;
  const store = yield* JobStore;
  const lifecycle = yield* JobLifecycle;
  const provider = yield* JobProviders;
  const ledger = yield* ProviderLedger;
  const identity = randomUUID();
  const instanceId = randomUUID();
  yield* store.sql`INSERT INTO machine_credentials VALUES(${identity},${digest(identity)},'runner',0)`;
  yield* ledger.provision(
    {
      version: "apify-x-v1",
      actorId: "syntheticActor",
      buildId: "syntheticBuild",
      buildNumber: "1.12.394",
      privacyEvidence: "a".repeat(64),
      pricingEvidence: "b".repeat(64),
      inputSchemaDigest: "c".repeat(64),
      campaignId: "synthetic-campaign",
      eventNanos: 150_000,
      platformNanos: 20_000_000,
      retrievalNanos: 20_000_000,
    },
    [],
  );
  let serial = 100;
  const claim = Effect.fn(function* () {
    const id = String(serial++);
    const submission = yield* jobs.submit({
      requestId: randomUUID(),
      mode: "save",
      url: `https://x.com/example/status/${id}`,
    });
    assert(submission.job);
    for (let i = 0; i < 200; i++) {
      const claim = yield* jobs.claim(identity, { requestId: randomUUID(), instanceId });
      if (claim) {
        assert.equal(claim.job.jobId, submission.job.jobId);
        return claim;
      }
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die("Synthetic claim not delivered");
  });
  const input = (planKey = "anchor") => ({
    planKey,
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
  });
  const run = (startedAt: number): P.RunIdentity => ({
    runId: randomUUID(),
    datasetId: randomUUID(),
    keyValueStoreId: randomUUID(),
    buildId: "syntheticBuild",
    startedAt,
  });
  const failure = Effect.fn(function* <A, E>(action: Effect.Effect<A, E>, code: string) {
    const result = yield* Effect.result(action);
    assert.equal(result._tag, "Failure");
    assert(
      result._tag === "Failure" &&
        typeof result.failure === "object" &&
        result.failure !== null &&
        "code" in result.failure,
    );
    assert.equal(result.failure.code, code);
  });
  const reclaim = Effect.fn(function* (jobId: string) {
    for (let i = 0; i < 200; i++) {
      const value = yield* jobs.claim(identity, { requestId: randomUUID(), instanceId });
      if (value) {
        assert.equal(value.job.jobId, jobId);
        return value;
      }
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die("Synthetic recovery claim not delivered");
  });

  // A pre-permit crash has no remote obligation and must not poison the job's
  // original acquisition window when a new epoch resumes it.
  const unissued = yield* claim();
  const reserved = yield* provider.reserve(identity, unissued.scope, input());
  yield* lifecycle.sweep(true);
  yield* provider.inspect(identity, unissued.scope.jobId);
  assert.equal((yield* ledger.get(reserved.operationId)).phase, "reserved");
  const resumed = yield* reclaim(unissued.scope.jobId);
  assert.equal(
    (yield* provider.reserve(identity, resumed.scope, input())).operationId,
    reserved.operationId,
  );
  yield* lifecycle.cancel("synthetic-owner", {
    requestId: randomUUID(),
    jobId: unissued.scope.jobId,
  });
  yield* provider.inspect(identity, unissued.scope.jobId);
  assert.equal((yield* ledger.get(reserved.operationId)).phase, "closed");

  const cancelled = yield* claim();
  const first = yield* provider.reserve(identity, cancelled.scope, input());
  assert.equal(first.chargeNanos, 150_000);
  assert.equal(first.platformNanos, 20_000_000);
  assert.equal(first.retrievalNanos, 20_000_000);
  assert.deepEqual(yield* provider.reserve(identity, cancelled.scope, input()), first);
  yield* failure(
    provider.reserve(identity, { ...cancelled.scope, epoch: cancelled.scope.epoch + 1 }, input()),
    "stale_owner",
  );
  yield* failure(provider.reserve(identity, cancelled.scope, input("other")), "invalid_transition");
  const foreign = yield* makeJobProviders("production");
  yield* failure(foreign.unknown(identity, first.operationId), "not_found");
  const permitted = yield* provider.begin(identity, cancelled.scope, first.operationId);
  assert.equal(permitted.operation.phase, "dispatching");
  assert.equal((yield* jobs.get(cancelled.scope.jobId)).cleanupPending, true);
  yield* failure(
    provider.begin(identity, cancelled.scope, first.operationId),
    "invalid_transition",
  );
  assert.equal(
    (yield* lifecycle.cancel("synthetic-owner", {
      requestId: randomUUID(),
      jobId: cancelled.scope.jobId,
    })).stage,
    "stopping",
  );
  yield* failure(provider.begin(identity, cancelled.scope, first.operationId), "stale_owner");
  const firstRun = run(yield* Clock.currentTimeMillis);
  yield* provider.attach(identity, first.operationId, firstRun);
  assert.equal((yield* provider.inspect(identity, cancelled.scope.jobId)).shouldStop, true);
  yield* provider.observe(identity, first.operationId, {
    runId: firstRun.runId,
    status: "RUNNING",
    finishedAt: null,
    usageNanos: null,
    transientFailure: false,
  });
  assert.equal((yield* jobs.get(cancelled.scope.jobId)).stage, "stopping");
  yield* provider.observe(identity, first.operationId, {
    runId: firstRun.runId,
    status: "ABORTED",
    finishedAt: yield* Clock.currentTimeMillis,
    usageNanos: 500_000,
    transientFailure: false,
  });
  const cancelledView = yield* jobs.get(cancelled.scope.jobId);
  assert.equal(cancelledView.stage, "cancelled");
  assert.equal(cancelledView.cleanupPending, false);
  assert.equal(cancelledView.counters.launches, 0);

  // Restart revocation must not let local process cleanup dismiss a remote run.
  const restarted = yield* claim();
  const second = yield* provider.reserve(identity, restarted.scope, input());
  yield* provider.begin(identity, restarted.scope, second.operationId);
  yield* lifecycle.sweep(true);
  const stopped = yield* jobs.get(restarted.scope.jobId);
  assert.equal(stopped.stage, "blocked");
  assert.equal(stopped.reason, "provider_start_unknown");
  const epoch = (yield* jobs.requireJob(restarted.scope.jobId)).record.epoch;
  yield* failure(lifecycle.reconciledProcess(restarted.scope.jobId, epoch), "invalid_transition");
  const secondRun = run(yield* Clock.currentTimeMillis);
  yield* provider.attach(identity, second.operationId, secondRun);
  yield* provider.observe(identity, second.operationId, {
    runId: secondRun.runId,
    status: "SUCCEEDED",
    finishedAt: yield* Clock.currentTimeMillis,
    usageNanos: 500_000,
    transientFailure: false,
  });
  assert.equal((yield* jobs.get(restarted.scope.jobId)).stage, "queued");
  yield* provider.inspect(identity, restarted.scope.jobId);
  const resumedAcquisition = yield* reclaim(restarted.scope.jobId);
  assert.equal(
    (yield* provider.reserve(identity, resumedAcquisition.scope, input("author"))).phase,
    "reserved",
  );
  yield* lifecycle.cancel("synthetic-owner", {
    requestId: randomUUID(),
    jobId: restarted.scope.jobId,
  });
  yield* provider.inspect(identity, restarted.scope.jobId);

  // A crash in the two-database gap is conservative until cancellation proves
  // the never-issued permit can no longer be consumed.
  const gap = yield* claim();
  const third = yield* provider.reserve(identity, gap.scope, input());
  const gapSaved = yield* jobs.requireJob(gap.scope.jobId);
  yield* store.transaction(
    store.put(
      { ...gapSaved.record, cleanupPending: true, reason: "provider_start_unknown" },
      gapSaved.version,
    ),
  );
  yield* provider.inspect(identity, gap.scope.jobId);
  assert.equal((yield* jobs.get(gap.scope.jobId)).cleanupPending, true);
  yield* lifecycle.sweep(true);
  yield* provider.inspect(identity, gap.scope.jobId);
  assert.equal((yield* jobs.get(gap.scope.jobId)).cleanupPending, false);
  assert.equal((yield* jobs.get(gap.scope.jobId)).stage, "queued");
  assert.equal((yield* ledger.get(third.operationId)).phase, "reserved");
  const gapResumed = yield* reclaim(gap.scope.jobId);
  assert.equal(
    (yield* provider.reserve(identity, gapResumed.scope, input())).operationId,
    third.operationId,
  );
  yield* lifecycle.cancel("synthetic-owner", { requestId: randomUUID(), jobId: gap.scope.jobId });
  yield* provider.inspect(identity, gap.scope.jobId);
  assert.equal((yield* ledger.get(third.operationId)).phase, "closed");
  assert.equal((yield* jobs.get(gap.scope.jobId)).stage, "cancelled");

  const expired = yield* claim();
  const fourth = yield* provider.reserve(identity, expired.scope, input());
  yield* provider.begin(identity, expired.scope, fourth.operationId);
  const saved = yield* jobs.requireJob(expired.scope.jobId);
  const now = yield* Clock.currentTimeMillis;
  yield* store.transaction(store.put({ ...saved.record, startedAt: now - 300_001 }, saved.version));
  assert.equal((yield* provider.inspect(identity, expired.scope.jobId)).shouldStop, true);
  const fourthRun = run(now);
  yield* provider.attach(identity, fourth.operationId, fourthRun);
  yield* provider.observe(identity, fourth.operationId, {
    runId: fourthRun.runId,
    status: "TIMED-OUT",
    finishedAt: now,
    usageNanos: 500_000,
    transientFailure: false,
  });
  assert.equal((yield* jobs.get(expired.scope.jobId)).stage, "acquiring");
  assert.equal((yield* jobs.get(expired.scope.jobId)).cleanupPending, false);
  yield* failure(provider.reserve(identity, expired.scope, input("late")), "deadline_exceeded");
  yield* store.sql`UPDATE machine_credentials SET revoked=1 WHERE identity_id=${identity}`;
  yield* failure(provider.inspect(identity, expired.scope.jobId), "unauthenticated");
  yield* Console.log(
    JSON.stringify({
      status: "passed",
      checks:
        "budgets, fencing, cancellation, restart, namespace, two-database gap, acquisition expiry, revocation",
    }),
  );
}).pipe(Effect.timeout("40 seconds"), Effect.scoped, Effect.provide(runtime));
await Effect.runPromise(program);
