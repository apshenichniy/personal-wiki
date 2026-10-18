import { Context, Deferred, Effect, Layer, Schedule } from "effect";
import { PersistedQueue } from "effect/persistence";
import { QueueMessage } from "@personal-wiki/contracts/jobs";
import { JobStore } from "./store.ts";
import { isTerminal } from "./model.ts";
import { publicationFault } from "../storage/faults.ts";

type Delivery = { jobId: string; generation: number; done: Deferred.Deferred<void> };
export const makeScheduler = Effect.fn("Jobs.makeScheduler")(function* (root: string) {
  const store = yield* JobStore;
  const queueStore = yield* PersistedQueue.makeStoreSql({
    tableName: "job_queue",
    pollInterval: "100 millis",
    lockRefreshInterval: "1 second",
    lockExpiration: "5 seconds",
  });
  const factory = yield* PersistedQueue.makeFactory.pipe(
    Effect.provideService(PersistedQueue.PersistedQueueStore, queueStore),
  );
  const queue = yield* factory.make({
    name: "ingestion",
    schema: QueueMessage,
    maxAttempts: 10,
    retrySchedule: Schedule.spaced("1 second"),
  });
  let active: Delivery | null = null;
  const dispatch = Effect.fn("Jobs.dispatchSchedules")(function* () {
    for (const intent of yield* store.pendingSchedules()) {
      yield* store.assertOwner();
      yield* queue.offer(
        { jobId: intent.job_id, generation: intent.generation },
        { id: `${intent.job_id}/${intent.generation}` },
      );
      yield* publicationFault(root, "queue-offered");
      yield* store.offered(intent.job_id, intent.generation);
    }
  });
  const consume = queue.take(
    Effect.fn("Jobs.consumeDelivery")(function* (message) {
      const accepted = yield* store.transaction(
        Effect.gen(function* () {
          yield* store.assertOwner();
          const saved = yield* store.get(message.jobId);
          if (
            !saved ||
            saved.record.generation !== message.generation ||
            isTerminal(saved.record.stage) ||
            saved.record.stage === "blocked" ||
            saved.record.stage === "stopping"
          )
            return false;
          yield* store.put({ ...saved.record, ready: saved.record.lease === null }, saved.version);
          return true;
        }),
      );
      if (!accepted) return;
      const delivery: Delivery = { ...message, done: yield* Deferred.make<void>() };
      active = delivery;
      yield* Deferred.await(delivery.done).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (active === delivery) active = null;
          }),
        ),
      );
    }),
  );
  const settle = Effect.fn("Jobs.settleDelivery")(function* (jobId: string, generation: number) {
    const delivery = active;
    if (delivery?.jobId === jobId && delivery.generation === generation)
      yield* Deferred.succeed(delivery.done, undefined);
  });
  const reconcile = Effect.fn("Jobs.reconcileSchedules")(function* () {
    // Completed history may contain large captures. Inspect only the current
    // delivery and active jobs; polling must not decode the whole library.
    if (active) {
      const saved = yield* store.get(active.jobId);
      if (
        !saved ||
        saved.record.generation !== active.generation ||
        isTerminal(saved.record.stage) ||
        saved.record.stage === "blocked" ||
        saved.record.stage === "stopping"
      )
        yield* settle(active.jobId, active.generation);
    }
    for (const saved of yield* store.active()) {
      const job = saved.record;
      if (isTerminal(job.stage) || job.stage === "blocked" || job.stage === "stopping") {
        yield* settle(job.jobId, job.generation);
        continue;
      }
      if (active?.jobId === job.jobId && active.generation === job.generation) continue;
      const queued = (yield* store.sql<{
        state: string;
      }>`SELECT state FROM job_queue WHERE id=${`${job.jobId}/${job.generation}`} AND queue_name='ingestion'`)[0];
      if (!queued) {
        yield* store.transaction(
          Effect.gen(function* () {
            yield* store.assertOwner();
            yield* store.sql`UPDATE scheduling_outbox SET offered=0 WHERE job_id=${job.jobId} AND generation=${job.generation}`;
            yield* store.schedule(job);
          }),
        );
      } else if (
        (queued.state === "failed" || queued.state === "completed") &&
        job.lease === null
      ) {
        yield* store.transaction(
          Effect.gen(function* () {
            const fresh = yield* store.get(job.jobId);
            if (!fresh || fresh.version !== saved.version) return;
            const next = { ...job, generation: job.generation + 1, ready: false };
            yield* store.put(next, saved.version);
            yield* store.schedule(next);
          }),
        );
      }
    }
  });
  // The queue handler's scope survives HTTP requests. Product counters belong to
  // the job journal; queue acknowledgement never grants another agent launch.
  yield* consume.pipe(
    Effect.catchCause(() => Effect.sleep("1 second")),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* dispatch().pipe(
    Effect.andThen(reconcile),
    Effect.catchCause(() => Effect.sleep("1 second")),
    Effect.repeat({ schedule: Schedule.spaced("250 millis") }),
    Effect.forkScoped,
  );
  return {
    settle,
    dispatch,
    reconcile,
    current: () => (active ? { jobId: active.jobId, generation: active.generation } : null),
  };
});
export class JobScheduler extends Context.Service<
  JobScheduler,
  Effect.Success<ReturnType<typeof makeScheduler>>
>()("personal-wiki/JobScheduler") {
  static layer = (root: string) => Layer.effect(JobScheduler, makeScheduler(root));
}
