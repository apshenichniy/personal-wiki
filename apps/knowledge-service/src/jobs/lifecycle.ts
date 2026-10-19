import { Clock, Context, Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import * as J from "@personal-wiki/contracts/jobs";
import { stable } from "../storage/io.ts";
import { Jobs } from "./service.ts";
import { JobStore } from "./store.ts";
import { JobScheduler } from "./scheduler.ts";
import { defaultPolicy, emptyCounters, JobError, nextLaunch } from "./policy.ts";
import { isTerminal, type JobRecord } from "./model.ts";

export const makeLifecycle = Effect.gen(function* () {
  const jobs = yield* Jobs;
  const store = yield* JobStore;
  const scheduler = yield* JobScheduler;
  const sql = store.sql;
  const inCommit = Effect.fn("Jobs.commitFence")(function* (job: JobRecord) {
    const op = job.operationId
      ? (yield* sql<{
          phase: string;
        }>`SELECT phase FROM operations WHERE operation_id=${job.operationId}`)[0]
      : null;
    return op && ["committing", "committed", "applied"].includes(op.phase);
  });
  const stopRecord = Effect.fn("Jobs.stopRecord")(function* (
    saved: { record: JobRecord; version: number },
    reason: "cancelled" | "deadline",
  ) {
    const job = saved.record;
    if (job.reason === "restore_accounting_unknown")
      return yield* new JobError({
        code: "invalid_transition",
        message: "Restored execution accounting requires independent reconciliation.",
      });
    if (isTerminal(job.stage) || (yield* inCommit(job))) return job;
    if (job.operationId)
      yield* sql`UPDATE operations SET phase='cancelled' WHERE operation_id=${job.operationId} AND phase IN ('received','prepared')`;
    const next: JobRecord = {
      ...job,
      stopReason: reason,
      epoch: job.epoch + 1,
      lease: null,
      ready: false,
      retryAt: null,
      stage: job.cleanupPending ? "stopping" : reason === "deadline" ? "expired" : "cancelled",
      reason: job.cleanupPending ? (job.reason ?? "process_ownership_unknown") : reason,
    };
    yield* store.put(next, saved.version);
    return next;
  });
  const settle = Effect.fn("Jobs.settleStopped")(function* (job: J.JobView) {
    const saved = yield* store.get(job.jobId);
    if (saved && (isTerminal(job.stage) || job.stage === "blocked" || job.stage === "stopping"))
      yield* scheduler.settle(job.jobId, saved.record.generation);
  });
  const cancel = (identityId: string, input: typeof J.JobCommand.Type) =>
    store
      .transaction(
        Effect.gen(function* () {
          yield* store.assertOwner();
          const prior = yield* jobs.priorRequest(identityId, input.requestId, input, J.JobView);
          if (prior) return prior;
          const next = yield* stopRecord(yield* jobs.requireJob(input.jobId), "cancelled");
          const result = yield* jobs.view(next);
          yield* jobs.remember(identityId, input.requestId, input, result);
          return result;
        }),
      )
      .pipe(Effect.tap(settle));
  const block = (identityId: string, input: typeof J.BlockJob.Type) =>
    store
      .transaction(
        Effect.gen(function* () {
          const saved = yield* jobs.owned(identityId, input.scope);
          const prior = yield* jobs.priorRequest(identityId, input.requestId, input, J.JobView);
          if (prior) return prior;
          if (yield* inCommit(saved.record))
            return yield* new JobError({
              code: "invalid_transition",
              message: "Publication intent must be reconciled.",
            });
          const unknown =
            input.reason === "provider_start_unknown" ||
            input.reason === "process_ownership_unknown";
          if (!unknown && saved.record.cleanupPending)
            return yield* new JobError({
              code: "invalid_transition",
              message: "Execution must be stopped before blocking for access.",
            });
          if (input.reason === "auth" || input.reason === "quota")
            yield* sql`INSERT INTO adapter_gates VALUES('codex',${input.reason}) ON CONFLICT(adapter) DO UPDATE SET reason=excluded.reason`;
          const next: JobRecord = {
            ...saved.record,
            stage: "blocked",
            reason: input.reason,
            lease: null,
            ready: false,
            cleanupPending: unknown || saved.record.cleanupPending,
          };
          yield* store.put(next, saved.version);
          const result = yield* jobs.view(next);
          yield* jobs.remember(identityId, input.requestId, input, result);
          return result;
        }),
      )
      .pipe(Effect.tap(settle));
  const requeue = Effect.fn("Jobs.requeue")(function* (saved: {
    record: JobRecord;
    version: number;
  }) {
    const next: JobRecord = {
      ...saved.record,
      stage: "queued",
      lease: null,
      ready: false,
      reason: null,
      retryAt: null,
      generation: saved.record.generation + 1,
    };
    yield* store.put(next, saved.version);
    yield* store.schedule(next);
    return next;
  });
  const resume = (identityId: string, input: typeof J.JobCommand.Type) =>
    store.transaction(
      Effect.gen(function* () {
        yield* store.assertOwner();
        const prior = yield* jobs.priorRequest(identityId, input.requestId, input, J.JobView);
        if (prior) return prior;
        const saved = yield* jobs.requireJob(input.jobId);
        const job = saved.record;
        const now = yield* Clock.currentTimeMillis;
        if (
          job.stage !== "blocked" ||
          job.cleanupPending ||
          job.reason === "retry_scheduled" ||
          job.reason === "restore_accounting_unknown" ||
          job.stopReason ||
          job.deadline === null ||
          job.deadline <= now
        )
          return yield* new JobError({
            code: "invalid_transition",
            message: "This job cannot be resumed without reconciliation or an explicit new job.",
          });
        if ((yield* sql`SELECT adapter FROM adapter_gates WHERE adapter='codex'`).length)
          return yield* new JobError({
            code: "unavailable",
            message: "Restore adapter access before resuming.",
          });
        if (!job.result)
          yield* Effect.try({
            try: () => nextLaunch(job.policy, job.counters, job.nextReason, job.deadline!, now),
            catch: (error) =>
              error instanceof JobError
                ? error
                : new JobError({
                    code: "invalid_transition",
                    message: "Execution allowance is unavailable.",
                  }),
          });
        const result = yield* jobs.view(yield* requeue(saved));
        yield* jobs.remember(identityId, input.requestId, input, result);
        return result;
      }),
    );
  const restoreAdapter = () =>
    store.transaction(
      Effect.gen(function* () {
        yield* store.assertOwner();
        yield* sql`DELETE FROM adapter_gates WHERE adapter='codex'`;
      }),
    );
  const retryRetained = (identityId: string, input: typeof J.JobCommand.Type) =>
    store.transaction(
      Effect.gen(function* () {
        yield* store.assertOwner();
        const prior = yield* jobs.priorRequest(identityId, input.requestId, input, J.JobView);
        if (prior) return prior;
        const old = (yield* jobs.requireJob(input.jobId)).record;
        if (
          !isTerminal(old.stage) ||
          old.stage === "succeeded" ||
          !old.capture ||
          old.cleanupPending ||
          (yield* store.activeSource(old.sourceKey))
        )
          return yield* new JobError({
            code: "invalid_transition",
            message:
              "Retained retry requires a settled previous outcome with no active source job.",
          });
        const jobId = randomUUID();
        const draft = { ...old.capture.draft, jobId };
        const next: JobRecord = {
          ...old,
          jobId,
          stage: "queued",
          mode: "retry_retained",
          createdAt: yield* Clock.currentTimeMillis,
          startedAt: null,
          deadline: null,
          policy: defaultPolicy,
          counters: emptyCounters,
          epoch: 0,
          generation: 1,
          lease: null,
          ready: false,
          stopReason: null,
          cleanupPending: false,
          reason: null,
          retryAt: null,
          capture: { ...old.capture, draft },
          previousJobId: old.jobId,
          result: null,
          resultDigest: null,
          operationId: null,
          receiptOperationId: null,
          activeAttemptId: null,
          nextReason: "initial",
        };
        yield* store.insert(next);
        // This is a new authorized curation job over immutable retained evidence.
        yield* sql`INSERT INTO drafts VALUES(${randomUUID()},'retained-retry',${jobId},${stable(draft)})`;
        yield* store.schedule(next);
        const result = yield* jobs.view(next);
        yield* jobs.remember(identityId, input.requestId, input, result);
        return result;
      }),
    );
  const sweep = (restart = false) =>
    store.transaction(
      Effect.gen(function* () {
        yield* store.assertOwner();
        const now = yield* Clock.currentTimeMillis;
        for (const saved of yield* store.active()) {
          const job = saved.record;
          if (job.reason === "restore_accounting_unknown") continue;
          if (yield* inCommit(job)) continue;
          if (job.stopReason || job.stage === "stopping") continue;
          if (job.deadline !== null && job.deadline <= now) {
            yield* stopRecord(saved, "deadline");
            continue;
          }
          if (job.stage === "blocked" && job.cleanupPending) continue;
          if (job.activeAttemptId) {
            const attempt = (yield* sql<{
              record: string;
            }>`SELECT record FROM execution_attempts WHERE attempt_id=${job.activeAttemptId}`)[0];
            if (!attempt)
              return yield* new JobError({
                code: "invalid_transition",
                message: "Active execution record is missing.",
              });
            const retained = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(J.Attempt))(
              attempt.record,
            );
            if (Date.parse(retained.deadline) <= now) {
              yield* store.put(
                {
                  ...job,
                  stage: "blocked",
                  reason: "process_ownership_unknown",
                  lease: null,
                  ready: false,
                  epoch: job.epoch + 1,
                  cleanupPending: true,
                },
                saved.version,
              );
              continue;
            }
          }
          if (job.lease && (restart || job.lease.expiresAt <= now)) {
            const revoked = { ...job, lease: null, ready: false, epoch: job.epoch + 1 };
            if (job.cleanupPending)
              yield* store.put(
                {
                  ...revoked,
                  stage: "blocked",
                  reason:
                    !job.activeAttemptId &&
                    (job.reason === "provider_start_unknown" ||
                      job.reason === "provider_execution_pending")
                      ? job.reason
                      : "process_ownership_unknown",
                },
                saved.version,
              );
            else yield* requeue({ record: revoked, version: saved.version });
          } else if (
            job.stage === "blocked" &&
            job.reason === "retry_scheduled" &&
            !job.cleanupPending &&
            job.retryAt !== null &&
            job.retryAt <= now
          ) {
            yield* requeue(saved);
          }
        }
      }),
    );
  // Called only after the trusted physical supervisor has verified the old
  // process boundary is empty. Provider reconciliation is a separate contract.
  const reconciledProcess = (jobId: string, epoch: number) =>
    store.transaction(
      Effect.gen(function* () {
        yield* store.assertOwner();
        const saved = yield* jobs.requireJob(jobId);
        const job = saved.record;
        if (
          job.epoch !== epoch ||
          !job.cleanupPending ||
          job.reason !== "process_ownership_unknown"
        )
          return yield* new JobError({
            code: "invalid_transition",
            message: "This job does not await physical process reconciliation.",
          });
        const now = yield* Clock.currentTimeMillis;
        if (job.activeAttemptId)
          yield* sql`UPDATE execution_attempts SET state='interrupted' WHERE attempt_id=${job.activeAttemptId} AND state='authorized'`;
        let next: JobRecord = { ...job, cleanupPending: false, activeAttemptId: null, lease: null };
        if (job.stopReason || (job.deadline !== null && job.deadline <= now)) {
          const cancelled = job.stopReason === "cancelled";
          next = {
            ...next,
            stage: cancelled ? "cancelled" : "expired",
            reason: cancelled ? "cancelled" : "deadline",
          };
          yield* store.put(next, saved.version);
        } else if (job.result) {
          next = yield* requeue({ record: next, version: saved.version });
        } else {
          const eligible = yield* Effect.try(() =>
            nextLaunch(job.policy, job.counters, "transient", job.deadline!, now),
          ).pipe(Effect.result);
          next =
            eligible._tag === "Success"
              ? {
                  ...next,
                  stage: "blocked",
                  reason: "retry_scheduled",
                  nextReason: "transient",
                  retryAt: now + 1000,
                }
              : { ...next, stage: "failed", reason: "retry_exhausted" };
          yield* store.put(next, saved.version);
        }
        return yield* jobs.view(next);
      }),
    );
  return { cancel, block, resume, retryRetained, restoreAdapter, sweep, reconciledProcess };
});
export class JobLifecycle extends Context.Service<
  JobLifecycle,
  Effect.Success<typeof makeLifecycle>
>()("personal-wiki/JobLifecycle") {
  static layer = Layer.effect(JobLifecycle, makeLifecycle);
}
