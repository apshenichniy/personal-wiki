import { Config, Clock, Context, Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import * as J from "@personal-wiki/contracts/jobs";
import * as K from "@personal-wiki/contracts/knowledge";
import { publicationFault } from "../storage/faults.ts";
import { digest, stable } from "../storage/io.ts";
import { JobCuration } from "./curation.ts";
import { Jobs } from "./service.ts";
import { JobStore } from "./store.ts";
import { JobScheduler } from "./scheduler.ts";
import { JobError, nextLaunch } from "./policy.ts";
import type { JobRecord } from "./model.ts";

export const makeExecution = Effect.gen(function* () {
  const root = yield* Config.String("WIKI_DATA_DIR");
  const jobs = yield* Jobs;
  const curation = yield* JobCuration;
  const store = yield* JobStore;
  const scheduler = yield* JobScheduler;
  const sql = store.sql;
  const reserve = (identityId: string, input: typeof J.ReserveAttempt.Type) =>
    store.transaction(
      Effect.gen(function* () {
        const saved = yield* jobs.owned(identityId, input.scope);
        const prior = yield* jobs.priorRequest(identityId, input.requestId, input, J.Attempt);
        if (prior) return prior;
        const job = saved.record;
        if (
          job.stage !== "prepared" ||
          !job.capture ||
          job.result ||
          job.activeAttemptId ||
          job.nextReason !== input.reason ||
          job.deadline === null
        )
          return yield* new JobError({
            code: "invalid_transition",
            message: "Job is not eligible for this launch.",
          });
        if ((yield* sql`SELECT adapter FROM adapter_gates WHERE adapter='codex'`).length)
          return yield* new JobError({
            code: "unavailable",
            message: "Codex access must be restored before execution.",
          });
        if (input.contextId) yield* curation.get(input.contextId, job.jobId);
        const now = yield* Clock.currentTimeMillis;
        const reservation = yield* Effect.try({
          try: () => nextLaunch(job.policy, job.counters, input.reason, job.deadline!, now),
          catch: (error) =>
            error instanceof JobError
              ? error
              : new JobError({
                  code: "invalid_transition",
                  message: "Invalid launch reservation.",
                }),
        });
        const attempt: typeof J.Attempt.Type = {
          attemptId: randomUUID(),
          jobId: job.jobId,
          scope: input.scope,
          reason: input.reason,
          number: reservation.counters.launches,
          authorizedAt: new Date(now).toISOString(),
          deadline: new Date(reservation.attemptDeadline).toISOString(),
          inputDigest: input.inputDigest,
          ...(input.contextId ? { contextId: input.contextId } : {}),
        };
        yield* sql`INSERT INTO execution_attempts VALUES(${attempt.attemptId},${job.jobId},${attempt.number},${stable(attempt)},'authorized',NULL)`;
        yield* store.put(
          {
            ...job,
            counters: reservation.counters,
            stage: "curating",
            activeAttemptId: attempt.attemptId,
            cleanupPending: true,
            reason: null,
          },
          saved.version,
        );
        yield* jobs.remember(identityId, input.requestId, input, attempt);
        return attempt;
      }),
    );
  const complete = (
    identityId: string,
    input: typeof J.CompleteAttempt.Type | typeof J.RecoverAttempt.Type,
  ) =>
    store
      .transaction(
        Effect.gen(function* () {
          yield* store.assertOwner();
          yield* jobs.authorizedRunner(identityId);
          const saved = yield* jobs.requireJob(input.scope.jobId);
          // A lost completion acknowledgement may be replayed after the transition
          // cleared its lease, but never after ownership was superseded.
          if (saved.record.epoch !== input.scope.epoch)
            return yield* new JobError({
              code: "stale_owner",
              message: "Execution ownership changed.",
            });
          const prior = yield* jobs.priorRequest(identityId, input.requestId, input, J.JobView);
          if (prior) return prior;
          const recovering = "completedAt" in input;
          const now = yield* Clock.currentTimeMillis;
          let job = saved.record;
          if (recovering) {
            if (
              job.lease ||
              job.stage !== "blocked" ||
              job.reason !== "process_ownership_unknown" ||
              !job.cleanupPending ||
              job.stopReason ||
              job.deadline === null ||
              job.deadline <= now
            )
              return yield* new JobError({
                code: "invalid_transition",
                message: "Execution is not eligible for retained-result recovery.",
              });
            // Physical death is attested by the trusted, globally exclusive
            // guardian. Grant only a completion lease; no launch is authorized.
            job = {
              ...job,
              stage: "curating",
              lease: { identityId, instanceId: input.scope.instanceId, expiresAt: now + 30_000 },
            };
          } else yield* jobs.owned(identityId, input.scope);
          const row = (yield* sql<{
            record: string;
            state: string;
          }>`SELECT record,state FROM execution_attempts WHERE attempt_id=${input.attemptId} AND job_id=${job.jobId}`)[0];
          if (
            !row ||
            row.state !== "authorized" ||
            job.activeAttemptId !== input.attemptId ||
            job.stage !== "curating"
          )
            return yield* new JobError({
              code: "invalid_transition",
              message: "Attempt is not awaiting completion.",
            });
          const attempt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(J.Attempt))(
            row.record,
          );
          const completedAt = "completedAt" in input ? Date.parse(input.completedAt) : now;
          if (
            !Number.isFinite(completedAt) ||
            completedAt > now ||
            completedAt < Date.parse(attempt.authorizedAt)
          )
            return yield* new JobError({
              code: "invalid_request",
              message: "Invalid retained completion time.",
            });
          if (input.outcome === "output" && completedAt >= Date.parse(attempt.deadline))
            return yield* new JobError({
              code: "deadline_exceeded",
              message: "Attempt deadline elapsed; reconcile termination without accepting output.",
            });
          if (
            (input.outcome === "output") !== (input.output !== null) ||
            (input.output !== null && Buffer.byteLength(input.output, "utf8") > 1_048_576)
          )
            return yield* new JobError({
              code: "invalid_request",
              message: "Attempt output is missing, unexpected or exceeds its byte limit.",
            });
          let next: JobRecord = { ...job, activeAttemptId: null, cleanupPending: false };
          let state: string = input.outcome;
          if (input.outcome === "output") {
            const parsed = yield* (
              attempt.contextId
                ? curation.proposal(attempt.contextId, job.jobId, input.output!)
                : Schema.decodeUnknownEffect(Schema.fromJsonString(K.Proposal))(input.output!)
            ).pipe(Effect.result);
            const valid =
              parsed._tag === "Success" &&
              parsed.success.jobId === job.jobId &&
              stable(parsed.success.captures) === stable(job.capture?.captures) &&
              parsed.success.notes.every((note) =>
                job.capture?.draft.slots.some((slot) => slot.noteId === note.noteId),
              );
            const freshOperation =
              parsed._tag === "Success" &&
              !(yield* sql`SELECT operation_id FROM operations WHERE operation_id=${parsed.success.operationId}`)
                .length;
            if (valid && freshOperation && parsed._tag === "Success") {
              next = {
                ...next,
                stage: "validating",
                result: parsed.success,
                resultDigest: digest(stable(parsed.success)),
                reason: null,
              };
              state = "output_retained";
            } else {
              state = "invalid_output";
              const eligible = yield* Effect.try(() =>
                nextLaunch(job.policy, job.counters, "repair", job.deadline!, now),
              ).pipe(Effect.result);
              next =
                eligible._tag === "Success"
                  ? { ...next, stage: "prepared", nextReason: "repair", reason: "invalid_output" }
                  : { ...next, stage: "failed", lease: null, reason: "repair_exhausted" };
            }
          } else if (input.outcome === "transient") {
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
                    lease: null,
                  }
                : { ...next, stage: "failed", reason: "retry_exhausted", lease: null };
          } else if (input.outcome === "auth" || input.outcome === "quota") {
            yield* sql`INSERT INTO adapter_gates VALUES('codex',${input.outcome}) ON CONFLICT(adapter) DO UPDATE SET reason=excluded.reason`;
            next = {
              ...next,
              stage: "blocked",
              reason: input.outcome,
              nextReason: "transient",
              lease: null,
            };
          } else next = { ...next, stage: "failed", reason: "execution_failed", lease: null };
          yield* sql`UPDATE execution_attempts SET state=${state},output=${input.output} WHERE attempt_id=${input.attemptId}`;
          yield* store.put(next, saved.version);
          const result = yield* jobs.view(next);
          yield* jobs.remember(identityId, input.requestId, input, result);
          return result;
        }),
      )
      .pipe(
        Effect.tap((job) =>
          job.stage === "validating" ? publicationFault(root, "output-retained") : Effect.void,
        ),
        Effect.tap((job) =>
          job.stage === "blocked" || job.stage === "failed"
            ? Effect.gen(function* () {
                const saved = yield* store.get(job.jobId);
                if (saved) yield* scheduler.settle(job.jobId, saved.record.generation);
              })
            : Effect.void,
        ),
      );
  const pending = (identityId: string) =>
    Effect.gen(function* () {
      yield* store.assertOwner();
      yield* jobs.authorizedRunner(identityId);
      const now = yield* Clock.currentTimeMillis;
      const result: (typeof J.ExecutionPending.Type)[number][] = [];
      for (const { record: job } of yield* store.active()) {
        if (!job.activeAttemptId || !job.cleanupPending) continue;
        const row = (yield* sql<{
          record: string;
        }>`SELECT record FROM execution_attempts WHERE attempt_id=${job.activeAttemptId}`)[0];
        if (!row)
          return yield* new JobError({
            code: "invalid_transition",
            message: "Execution intent is missing.",
          });
        result.push({
          job: yield* jobs.view(job),
          epoch: job.epoch,
          attempt: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(J.Attempt))(row.record),
          leaseActive: job.lease !== null && job.lease.expiresAt > now,
          stopRequested: job.stopReason !== null || (job.deadline !== null && job.deadline <= now),
        });
      }
      return result;
    });
  return { reserve, complete, pending };
});
export class JobExecution extends Context.Service<
  JobExecution,
  Effect.Success<typeof makeExecution>
>()("personal-wiki/JobExecution") {
  static layer = Layer.effect(JobExecution, makeExecution);
}
