import { Console, Effect, Layer, Schema } from "effect";
import { Library } from "../../apps/knowledge-service/src/storage/library.ts";
import { publicationFault } from "../../apps/knowledge-service/src/storage/faults.ts";
import { JobStore } from "../../apps/knowledge-service/src/jobs/store.ts";
import { makeScheduler } from "../../apps/knowledge-service/src/jobs/scheduler.ts";
import { defaultPolicy, emptyCounters } from "../../apps/knowledge-service/src/jobs/policy.ts";
import { JobRecord } from "../../apps/knowledge-service/src/jobs/model.ts";
const root = process.env.WIKI_DATA_DIR;
const id = process.env.WIKI_TEST_JOB_ID;
if (!root || !id) throw new Error("Synthetic probe configuration required");
const Storage = JobStore.layer.pipe(Layer.provideMerge(Library.layer(root)));
let phase = "startup";
const program = Effect.gen(function* () {
  const store = yield* JobStore;
  if (!(yield* store.get(id))) {
    const record = Schema.decodeUnknownSync(JobRecord)({
      jobId: id,
      sourceKey: "x:post:123",
      stage: "queued",
      submittedUrl: "https://x.com/example/status/123",
      normalizedUrl: "https://x.com/i/status/123",
      anchorId: "123",
      mode: "save",
      createdAt: 1000,
      startedAt: null,
      deadline: null,
      policy: defaultPolicy,
      counters: emptyCounters,
      generation: 1,
      ready: false,
      epoch: 0,
      lease: null,
      reason: null,
      warnings: [],
      stopReason: null,
      cleanupPending: false,
      previousJobId: null,
      capture: null,
      result: null,
      resultDigest: null,
      operationId: null,
      receiptOperationId: null,
      activeAttemptId: null,
      nextReason: "initial",
      retryAt: null,
    });
    yield* store.transaction(
      Effect.gen(function* () {
        yield* store.insert(record);
        yield* store.schedule(record);
      }),
    );
    yield* publicationFault(root, "job-persisted");
  }
  const scheduler = yield* makeScheduler(root);
  // Dispatch writes/fsyncs its crash marker asynchronously. Do not let this
  // synthetic worker finish the job before that background fault kills it.
  if (process.env.WIKI_TEST_FAULT === "queue-offered") return yield* Effect.never;
  phase = "waiting-for-delivery";
  while (scheduler.current()?.jobId !== id) yield* Effect.sleep("20 millis");
  yield* publicationFault(root, "queue-claimed");
  yield* store.transaction(
    Effect.gen(function* () {
      const saved = yield* store.get(id);
      if (!saved) return yield* Effect.die("Missing accepted job");
      yield* store.put(
        { ...saved.record, stage: "failed", ready: false, reason: "synthetic-probe-complete" },
        saved.version,
      );
    }),
  );
  yield* scheduler.settle(id, 1);
  phase = "waiting-for-acknowledgement";
  let state = "";
  while (state !== "completed") {
    state =
      (yield* store.sql<{ state: string }>`SELECT state FROM job_queue WHERE id=${`${id}/1`}`)[0]
        ?.state ?? "";
    yield* Effect.sleep("20 millis");
  }
  const saved = yield* store.get(id);
  if (!saved) return yield* Effect.die("Missing completed job");
  const jobs = [saved];
  const rows = yield* store.sql<{ attempts: number }>`SELECT attempts FROM job_queue`;
  yield* Console.log(
    JSON.stringify({
      jobs: jobs.length,
      jobId: jobs[0]!.record.jobId,
      counters: jobs[0]!.record.counters,
      queueRows: rows.length,
      attempts: rows[0]!.attempts,
      stage: jobs[0]!.record.stage,
      startedAt: jobs[0]!.record.startedAt,
      deadline: jobs[0]!.record.deadline,
    }),
  );
}).pipe(
  Effect.timeout("15 seconds"),
  Effect.tapCause(() =>
    Effect.gen(function* () {
      const store = yield* JobStore;
      yield* Console.error(
        JSON.stringify({
          probePhase: phase,
          queue: yield* store.sql`SELECT id,state,attempts,acquired_at,acquired_by FROM job_queue`,
          schedules: yield* store.sql`SELECT * FROM scheduling_outbox`,
          jobs: yield* store.sql`SELECT job_id,stage,generation,ready,version FROM ingestion_jobs`,
        }),
      );
    }),
  ),
  Effect.scoped,
  Effect.provide(Storage),
);
await Effect.runPromise(program);
