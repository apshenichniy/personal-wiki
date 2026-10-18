import { Clock, Context, Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import * as J from "@personal-wiki/contracts/jobs";
import * as K from "@personal-wiki/contracts/knowledge";
import { Library } from "../storage/library.ts";
import { digest, stable } from "../storage/io.ts";
import { publicationFault } from "../storage/faults.ts";
import { JobStore } from "./store.ts";
import { JobScheduler } from "./scheduler.ts";
import { type JobRecord, isTerminal } from "./model.ts";
import {
  allowedActions,
  defaultPolicy,
  emptyCounters,
  JobError,
  normalizeSubmission,
  nextLaunch,
} from "./policy.ts";

export const makeJobs = Effect.fn("Jobs.make")(function* (root: string) {
  const store = yield* JobStore;
  const library = yield* Library;
  const scheduler = yield* JobScheduler;
  const sql = store.sql;
  const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, value: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(value);
  const requireJob = Effect.fn("Jobs.requireRecord")(function* (id: string) {
    const saved = yield* store.get(id);
    if (!saved) return yield* new JobError({ code: "not_found", message: "Job not found." });
    return saved;
  });
  const view = Effect.fn("Jobs.view")(function* (job: JobRecord) {
    const row = job.receiptOperationId
      ? (yield* sql<{
          payload: string;
        }>`SELECT payload FROM receipts WHERE operation_id=${job.receiptOperationId}`)[0]
      : undefined;
    const receipt = row ? yield* decode(K.Receipt, row.payload) : null;
    const now = yield* Clock.currentTimeMillis;
    let actions = allowedActions(job.stage, job.reason, job.capture !== null, job.deadline, now);
    if (job.stage === "blocked" && actions.includes("resume")) {
      const gated =
        (yield* sql`SELECT adapter FROM adapter_gates WHERE adapter='codex'`).length > 0;
      const eligible =
        job.result || job.deadline === null
          ? true
          : (yield* Effect.try(() =>
              nextLaunch(job.policy, job.counters, job.nextReason, job.deadline!, now),
            ).pipe(Effect.result))._tag === "Success";
      if (gated || !eligible) actions = actions.filter((action) => action !== "resume");
    }
    if (!isTerminal(job.stage) && job.deadline !== null && job.deadline <= now)
      actions = job.cleanupPending || job.stage === "publishing" ? [] : ["cancel"];
    const result: J.JobView = {
      schemaVersion: 1,
      jobId: job.jobId,
      stage: job.stage,
      submittedUrl: job.submittedUrl,
      normalizedUrl: job.normalizedUrl,
      anchorId: job.anchorId,
      sourceKey: job.sourceKey,
      createdAt: new Date(job.createdAt).toISOString(),
      startedAt: job.startedAt === null ? null : new Date(job.startedAt).toISOString(),
      deadline: job.deadline === null ? null : new Date(job.deadline).toISOString(),
      policy: job.policy,
      counters: job.counters,
      reason: job.reason,
      warnings: job.warnings,
      allowedActions: actions,
      receipt,
      previousJobId: job.previousJobId,
      retainedCapture: job.capture !== null,
      cleanupPending: job.cleanupPending,
    };
    return result;
  });
  const get = (id: string) =>
    store.transaction(
      Effect.gen(function* () {
        const target = yield* store.resolveRedirect(id);
        return yield* view((yield* requireJob(target)).record);
      }),
    );
  const resolvedKey = Effect.fn("Jobs.resolvedSource")(function* (input: string) {
    let key = input;
    const seen = new Set<string>();
    while (!seen.has(key)) {
      seen.add(key);
      const alias = (yield* sql<{
        canonical_key: string;
      }>`SELECT canonical_key FROM source_aliases WHERE alias_key=${key}`)[0];
      if (!alias || alias.canonical_key === key) return key;
      key = alias.canonical_key;
    }
    return yield* new JobError({
      code: "invalid_transition",
      message: "Source resolution is inconsistent.",
    });
  });
  const submit = Effect.fn("Jobs.submit")(function* (input: typeof J.Submission.Type) {
    const result = yield* store.transaction(
      Effect.gen(function* () {
        yield* store.assertOwner();
        const payloadDigest = digest(stable(input));
        const previous = (yield* sql<{
          digest: string;
          result: string;
        }>`SELECT digest,result FROM submissions WHERE request_id=${input.requestId}`)[0];
        if (previous) {
          if (previous.digest !== payloadDigest)
            return yield* new JobError({
              code: "idempotency_conflict",
              message: "Submission identity has different input.",
            });
          return yield* decode(J.SubmissionResult, previous.result);
        }
        const normalized = yield* Effect.try({
          try: () => normalizeSubmission(input.url),
          catch: (error) =>
            error instanceof JobError
              ? error
              : new JobError({ code: "invalid_request", message: "Invalid source URL." }),
        });
        const key = yield* resolvedKey(normalized.sourceKey);
        const snapshot = yield* library.list();
        const identity = (yield* sql<{
          note_id: string;
        }>`SELECT note_id FROM identities WHERE external_key=${key}`)[0];
        const note = identity
          ? snapshot.notes.find((candidate) => candidate.noteId === identity.note_id)
          : undefined;
        const active = yield* store.activeSource(key);
        const old = yield* store.latest(key);
        let job: JobRecord | null = active?.record ?? null;
        let outcome: (typeof J.SubmissionResult.Type)["outcome"];
        if (input.mode === "save" && note) outcome = "existing_note";
        else if (active) outcome = "existing_job";
        else if (input.mode === "save" && old && old.record.stage !== "succeeded") {
          outcome = "previous_outcome";
          job = old.record;
        } else {
          job = {
            jobId: randomUUID(),
            sourceKey: key,
            stage: "queued",
            submittedUrl: input.url,
            normalizedUrl: normalized.normalizedUrl,
            anchorId: normalized.anchorId,
            mode: input.mode,
            createdAt: yield* Clock.currentTimeMillis,
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
          };
          yield* store.insert(job);
          yield* store.schedule(job);
          outcome = "accepted";
        }
        const result: typeof J.SubmissionResult.Type = {
          schemaVersion: 1,
          outcome,
          job: job ? yield* view(job) : null,
          noteId: note?.noteId ?? null,
          appliedRevision: snapshot.appliedRevision,
        };
        yield* sql`INSERT INTO submissions VALUES(${input.requestId},${payloadDigest},${job?.jobId ?? null},${note?.noteId ?? null},${stable(result)})`;
        return result;
      }),
    );
    yield* publicationFault(root, "job-persisted");
    return result;
  });
  const authorizedRunner = Effect.fn("Jobs.authorizedRunner")(function* (identityId: string) {
    if (
      !(yield* sql`SELECT identity_id FROM machine_credentials WHERE identity_id=${identityId} AND role='runner' AND revoked=0`)
        .length
    )
      return yield* new JobError({
        code: "unauthenticated",
        message: "Runner credential is revoked or unavailable.",
      });
  });
  const owned = Effect.fn("Jobs.requireOwnership")(function* (
    identityId: string,
    scope: J.JobScope,
  ) {
    yield* store.assertOwner();
    yield* authorizedRunner(identityId);
    const saved = yield* requireJob(scope.jobId);
    const job = saved.record;
    const now = yield* Clock.currentTimeMillis;
    if (
      !job.lease ||
      job.lease.identityId !== identityId ||
      job.lease.instanceId !== scope.instanceId ||
      job.epoch !== scope.epoch ||
      job.lease.expiresAt <= now
    )
      return yield* new JobError({
        code: "stale_owner",
        message: "Job ownership is missing, expired or superseded.",
      });
    if (
      isTerminal(job.stage) ||
      job.stage === "blocked" ||
      job.stage === "stopping" ||
      job.stopReason
    )
      return yield* new JobError({
        code: "invalid_transition",
        message: "This job does not permit execution.",
      });
    if (job.deadline !== null && job.deadline <= now && job.stage !== "publishing")
      return yield* new JobError({
        code: "deadline_exceeded",
        message: "The active job deadline has elapsed.",
      });
    return saved;
  });
  const priorRequest = Effect.fn("Jobs.priorRequest")(function* <A>(
    identityId: string,
    requestId: string,
    input: unknown,
    schema: Schema.ConstraintDecoder<A, never>,
  ) {
    const prior = (yield* sql<{
      digest: string;
      result: string;
    }>`SELECT digest,result FROM job_requests WHERE identity_id=${identityId} AND request_id=${requestId}`)[0];
    if (!prior) return null;
    if (prior.digest !== digest(stable(input)))
      return yield* new JobError({
        code: "idempotency_conflict",
        message: "Worker request identity has different input.",
      });
    return yield* decode(schema, prior.result);
  });
  const remember = (identityId: string, requestId: string, input: unknown, result: unknown) =>
    sql`INSERT INTO job_requests VALUES(${identityId},${requestId},${digest(stable(input))},${stable(result)})`;
  const claim = (identityId: string, input: typeof J.ClaimRequest.Type) =>
    store.transaction(
      Effect.gen(function* () {
        yield* store.assertOwner();
        yield* authorizedRunner(identityId);
        const prior = yield* priorRequest(identityId, input.requestId, input, J.Claim);
        if (prior) return prior;
        const delivery = scheduler.current();
        if (!delivery) return null;
        const saved = yield* requireJob(delivery.jobId);
        let job = saved.record;
        if (
          job.generation !== delivery.generation ||
          isTerminal(job.stage) ||
          job.stage === "blocked" ||
          job.stage === "stopping"
        )
          return null;
        const now = yield* Clock.currentTimeMillis;
        if (job.lease) {
          if (
            job.lease.identityId !== identityId ||
            job.lease.instanceId !== input.instanceId ||
            job.lease.expiresAt <= now
          )
            return null;
        } else {
          if (
            !job.ready ||
            (yield* store.active()).some(
              ({ record }) =>
                record.jobId !== job.jobId &&
                !isTerminal(record.stage) &&
                (record.lease !== null || record.cleanupPending),
            )
          )
            return null;
          job = {
            ...job,
            stage: job.result ? "validating" : job.capture ? "prepared" : "acquiring",
            ready: false,
            epoch: job.epoch + 1,
            lease: { identityId, instanceId: input.instanceId, expiresAt: now + 30_000 },
            startedAt: job.startedAt ?? now,
            deadline: job.deadline ?? now + job.policy.activeJobMs,
          };
          yield* store.put(job, saved.version);
        }
        const result: typeof J.Claim.Type = {
          scope: { jobId: job.jobId, instanceId: input.instanceId, epoch: job.epoch },
          job: yield* view(job),
        };
        yield* remember(identityId, input.requestId, input, result);
        return result;
      }),
    );
  const heartbeat = (identityId: string, input: typeof J.WorkerRequest.Type) =>
    store.transaction(
      Effect.gen(function* () {
        const saved = yield* owned(identityId, input.scope);
        const prior = yield* priorRequest(identityId, input.requestId, input, J.JobView);
        if (prior) return prior;
        const now = yield* Clock.currentTimeMillis;
        const job = { ...saved.record, lease: { ...saved.record.lease!, expiresAt: now + 30_000 } };
        yield* store.put(job, saved.version);
        const result = yield* view(job);
        yield* remember(identityId, input.requestId, input, result);
        return result;
      }),
    );
  return {
    submit,
    get,
    view,
    owned,
    priorRequest,
    remember,
    claim,
    heartbeat,
    requireJob,
    authorizedRunner,
  };
});
export class Jobs extends Context.Service<Jobs, Effect.Success<ReturnType<typeof makeJobs>>>()(
  "personal-wiki/Jobs",
) {
  static layer = (root: string) => Layer.effect(Jobs, makeJobs(root));
}
