import { Clock, Context, Effect, Layer } from "effect";
import * as J from "@personal-wiki/contracts/jobs";
import * as K from "@personal-wiki/contracts/knowledge";
import { Jobs } from "./service.ts";
import { JobStore } from "./store.ts";
import { Library } from "../storage/library.ts";
import { digest, stable } from "../storage/io.ts";
import { JobError, nextLaunch } from "./policy.ts";
import type { JobRecord } from "./model.ts";

export const makeJobPublication = Effect.gen(function* () {
  const jobs = yield* Jobs;
  const store = yield* JobStore;
  const library = yield* Library;
  const failAcquisition = (identityId: string, input: typeof J.FailAcquisition.Type) =>
    store.transaction(
      Effect.gen(function* () {
        yield* store.assertOwner();
        yield* jobs.authorizedRunner(identityId);
        const prior = yield* jobs.priorRequest(identityId, input.requestId, input, J.JobView);
        if (prior) return prior;
        const saved = yield* jobs.owned(identityId, input.scope);
        if (
          saved.record.stage !== "acquiring" ||
          saved.record.capture ||
          saved.record.cleanupPending ||
          saved.record.activeAttemptId
        )
          return yield* new JobError({
            code: "invalid_transition",
            message: "Only settled acquisition can fail without curation.",
          });
        const next = {
          ...saved.record,
          stage: "failed" as const,
          lease: null,
          ready: false,
          reason: input.reason,
          warnings: input.warnings,
        };
        yield* store.put(next, saved.version);
        const result = yield* jobs.view(next);
        yield* jobs.remember(identityId, input.requestId, input, result);
        return result;
      }),
    );
  const reserve = (identityId: string, scope: J.JobScope, input: typeof K.ReserveRequest.Type) =>
    library.reserve(input, {
      jobId: scope.jobId,
      authorize: Effect.gen(function* () {
        const saved = yield* jobs.owned(identityId, scope);
        if (saved.record.stage !== "acquiring" || saved.record.capture)
          return yield* new JobError({
            code: "invalid_transition",
            message: "Source reservation requires the acquisition stage.",
          });
        const main = input.sources[0];
        if (
          !main ||
          `x:post:${main.primaryId}` !== saved.record.sourceKey ||
          main.kind === "x_article"
        )
          return yield* new JobError({
            code: "invalid_request",
            message: "Reserve the resolved material identity first.",
          });
      }),
    });
  const upload = (identityId: string, input: typeof J.UploadSource.Type) =>
    library.upload(
      input.asset,
      Effect.gen(function* () {
        const saved = yield* jobs.owned(identityId, input.scope);
        yield* jobs.priorRequest(identityId, input.requestId, input, K.Asset);
        if (saved.record.stage !== "acquiring" || input.asset.jobId !== input.scope.jobId)
          return yield* new JobError({
            code: "forbidden",
            message: "Asset upload is outside the active acquisition scope.",
          });
      }),
      (asset) =>
        Effect.gen(function* () {
          if (!(yield* jobs.priorRequest(identityId, input.requestId, input, K.Asset)))
            yield* jobs.remember(identityId, input.requestId, input, asset);
        }),
    );
  const prepare = (
    identityId: string,
    input: typeof J.WorkerRequest.Type & { captures: ReadonlyArray<K.Capture> },
  ) =>
    store.transaction(
      Effect.gen(function* () {
        const saved = yield* jobs.owned(identityId, input.scope);
        const prior = yield* jobs.priorRequest(identityId, input.requestId, input, J.JobView);
        if (prior) return prior;
        if (
          saved.record.stage !== "acquiring" ||
          saved.record.cleanupPending ||
          saved.record.capture
        )
          return yield* new JobError({
            code: "invalid_transition",
            message: "Acquisition must be settled before preparing a capture.",
          });
        if (
          !input.captures.length ||
          input.captures.length > 2 ||
          Buffer.byteLength(stable(input.captures)) > 1_048_576
        )
          return yield* new JobError({
            code: "invalid_request",
            message: "Prepared capture exceeds its admitted scope.",
          });
        const draft = yield* library.checkCapture(input.scope.jobId, input.captures);
        const next: JobRecord = {
          ...saved.record,
          stage: "prepared",
          capture: { draft, captures: input.captures },
          warnings: [...new Set(input.captures.flatMap((capture) => capture.warnings))],
        };
        yield* store.put(next, saved.version);
        const result = yield* jobs.view(next);
        yield* jobs.remember(identityId, input.requestId, input, result);
        return result;
      }),
    );
  const publish = (identityId: string, input: typeof J.WorkerRequest.Type) =>
    Effect.gen(function* () {
      const proposal = yield* store.transaction(
        Effect.gen(function* () {
          yield* store.assertOwner();
          yield* jobs.authorizedRunner(identityId);
          const saved = yield* jobs.requireJob(input.scope.jobId);
          if (saved.record.epoch !== input.scope.epoch)
            return yield* new JobError({
              code: "stale_owner",
              message: "Publication ownership changed.",
            });
          const prior = yield* jobs.priorRequest(identityId, input.requestId, input, J.JobView);
          if (prior) return { prior, proposal: null };
          const intent = (yield* store.sql<{
            digest: string;
            operation_id: string;
          }>`SELECT digest,operation_id FROM publication_requests WHERE identity_id=${identityId} AND request_id=${input.requestId}`)[0];
          if (intent && intent.digest !== digest(stable(input)))
            return yield* new JobError({
              code: "idempotency_conflict",
              message: "Publication request identity has different input.",
            });
          // The request was authorized before Git work. Activation can commit its
          // receipt and clear the lease before the HTTP response is recorded.
          if (
            intent &&
            saved.record.stage === "succeeded" &&
            saved.record.receiptOperationId === intent.operation_id
          ) {
            const result = yield* jobs.view(saved.record);
            yield* jobs.remember(identityId, input.requestId, input, result);
            return { prior: result, proposal: null };
          }
          yield* jobs.owned(identityId, input.scope);
          const job = saved.record;
          if (
            !job.result ||
            !job.resultDigest ||
            !["validating", "publishing"].includes(job.stage) ||
            job.cleanupPending
          )
            return yield* new JobError({
              code: "invalid_transition",
              message: "No retained completed output is ready for publication.",
            });
          if (!intent)
            yield* store.sql`INSERT INTO publication_requests VALUES(${identityId},${input.requestId},${digest(stable(input))},${job.result.operationId})`;
          yield* store.put(
            { ...job, stage: "publishing", operationId: job.result.operationId },
            saved.version,
          );
          return { prior: null, proposal: job.result };
        }),
      );
      if (proposal.prior) return proposal.prior;
      // Git work cannot hold the SQL transaction. The Library repeats the stop /
      // deadline fence inside its commit-intent transaction and activates the job
      // result atomically with the receipt, projection and event.
      yield* library.publish(proposal.proposal!).pipe(
        Effect.catchTag("LibraryError", (error) =>
          Effect.gen(function* () {
            if (!["stale_proposal", "invalid_request"].includes(error.code))
              return yield* Effect.fail(error);
            yield* store.transaction(
              Effect.gen(function* () {
                const saved = yield* jobs.requireJob(input.scope.jobId);
                if (
                  saved.record.stage !== "publishing" ||
                  saved.record.operationId !== proposal.proposal!.operationId
                )
                  return;
                const job = saved.record;
                const reason = error.code === "stale_proposal" ? "stale" : "repair";
                const now = yield* Clock.currentTimeMillis;
                const eligible = yield* Effect.try(() =>
                  nextLaunch(job.policy, job.counters, reason, job.deadline!, now),
                ).pipe(Effect.result);
                const next: JobRecord = {
                  ...job,
                  result: null,
                  resultDigest: null,
                  operationId: null,
                  nextReason: reason,
                  reason: error.code,
                  stage: eligible._tag === "Success" ? "prepared" : "failed",
                  lease: eligible._tag === "Success" ? job.lease : null,
                };
                yield* store.put(next, saved.version);
              }),
            );
          }),
        ),
      );
      return yield* store.transaction(
        Effect.gen(function* () {
          const saved = yield* jobs.requireJob(input.scope.jobId);
          const result = yield* jobs.view(saved.record);
          // Idempotent response after SQL activation; a lost response never reruns
          // curation. A concurrent duplicate request may already have stored it.
          const previous = yield* jobs.priorRequest(identityId, input.requestId, input, J.JobView);
          if (previous) return previous;
          yield* jobs.remember(identityId, input.requestId, input, result);
          return result;
        }),
      );
    });
  return { reserve, upload, prepare, publish, failAcquisition };
});
export class JobPublication extends Context.Service<
  JobPublication,
  Effect.Success<typeof makeJobPublication>
>()("personal-wiki/JobPublication") {
  static layer = Layer.effect(JobPublication, makeJobPublication);
}
