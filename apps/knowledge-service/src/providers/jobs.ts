import { Clock, Context, Effect, Layer, Schema } from "effect";
import type * as J from "@personal-wiki/contracts/jobs";
import { JobStore } from "../jobs/store.ts";
import { Jobs } from "../jobs/service.ts";
import { JobError } from "../jobs/policy.ts";
import { isTerminal, type JobRecord } from "../jobs/model.ts";
import { ProviderLedger } from "./ledger.ts";
import * as P from "@personal-wiki/contracts/provider";
import { admitActorInput } from "./admission.ts";
import { ProviderArchive, rawObject } from "./archive.ts";
import { Library } from "../storage/library.ts";
import { CapturePolicy } from "@personal-wiki/contracts/processing";
import { stable } from "../storage/io.ts";
import type { ProviderRawUpload } from "@personal-wiki/contracts/provider-api";

const invalid = (message: string) => new JobError({ code: "invalid_transition", message });
const providerCleanup = (reason: string | null) =>
  reason === "provider_start_unknown" || reason === "provider_execution_pending";
const acquisitionStopped = (job: JobRecord, now: number) =>
  isTerminal(job.stage) ||
  job.stopReason !== null ||
  job.lease === null ||
  job.lease.expiresAt <= now ||
  (job.startedAt !== null && now >= job.startedAt + 300_000);

export const makeJobProviders = (namespace: typeof P.Namespace.Type, enabled = true) =>
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    const store = yield* JobStore;
    const ledger = yield* ProviderLedger;
    const archive = yield* ProviderArchive;
    const library = yield* Library;
    const configure = (
      identityId: string,
      scope: J.JobScope,
      proposed: typeof CapturePolicy.Type,
    ) =>
      store.transaction(
        Effect.gen(function* () {
          const job = (yield* jobs.owned(identityId, scope)).record;
          if (job.stage !== "acquiring" || job.capture)
            return yield* invalid("Capture policy requires an acquisition job.");
          const old = (yield* store.sql<{
            payload: string;
          }>`SELECT payload FROM job_capture_policies WHERE job_id=${scope.jobId}`)[0];
          if (old)
            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CapturePolicy))(
              old.payload,
            );
          const policy = yield* Schema.decodeUnknownEffect(CapturePolicy)(proposed);
          if (
            policy.version !== "x-capture-v1" ||
            policy.main > 50 ||
            policy.discussion > 200 ||
            policy.context > 30 ||
            policy.direct + policy.latest + policy.nestedReserve > policy.discussion
          )
            return yield* invalid("Policy exceeds the first-slice representation bounds.");
          yield* store.sql`INSERT INTO job_capture_policies VALUES(${scope.jobId},${stable(policy)})`;
          return policy;
        }),
      );
    const member = Effect.fn("Provider.jobMembership")(function* (
      identityId: string,
      operationId: string,
    ) {
      yield* store.assertOwner();
      yield* jobs.authorizedRunner(identityId);
      const operation = yield* ledger.get(operationId);
      if (operation.job.namespace !== namespace)
        return yield* new JobError({ code: "not_found", message: "Provider operation not found." });
      const saved = yield* jobs.requireJob(operation.job.jobId);
      return { operation, saved };
    });
    const eligible = Effect.fn("Provider.acquisitionOwnership")(function* (
      identityId: string,
      scope: J.JobScope,
    ) {
      if (!enabled)
        return yield* new P.ProviderError({
          code: "disabled",
          message: "Live provider accounting is not configured.",
        });
      const saved = yield* jobs.owned(identityId, scope);
      const job = saved.record;
      const now = yield* Clock.currentTimeMillis;
      if (
        job.stage !== "acquiring" ||
        job.capture ||
        job.activeAttemptId ||
        job.startedAt === null ||
        job.deadline === null
      )
        return yield* invalid("Only acquisition jobs may start provider work.");
      if (now >= Math.min(job.startedAt + 300_000, job.deadline))
        return yield* new JobError({
          code: "deadline_exceeded",
          message: "Acquisition window has elapsed.",
        });
      return {
        saved,
        job: {
          jobId: job.jobId,
          namespace,
          startedAt: job.startedAt,
          deadline: Math.min(job.startedAt + 300_000, job.deadline),
        } satisfies P.AcquisitionJob,
      };
    });
    const reserve = (
      identityId: string,
      scope: J.JobScope,
      input: {
        planKey: string;
        inputJson: string;
        replacementOf: string | null;
      },
    ) =>
      store.transaction(
        Effect.gen(function* () {
          const { saved, job } = yield* eligible(identityId, scope);
          if (saved.record.cleanupPending)
            return yield* invalid(
              "Reconcile remote execution before reserving another acquisition.",
            );
          if (
            (yield* ledger.all()).some(
              (op) =>
                op.job.jobId === job.jobId &&
                op.phase === "reserved" &&
                op.planKey !== input.planKey,
            )
          )
            return yield* invalid("Only one reserved acquisition may await dispatch for a job.");
          const profile = (yield* ledger.configuration()).profile;
          const actor = yield* Effect.try({
            try: () => admitActorInput(input.inputJson),
            catch: () =>
              new JobError({
                code: "invalid_request",
                message: "Actor input does not match the admitted profile.",
              }),
          });
          return yield* ledger.reserve({
            ...input,
            job,
            chargeNanos: profile.eventNanos * actor.maxItems,
            platformNanos: profile.platformNanos,
            retrievalNanos: profile.retrievalNanos,
          });
        }),
      );
    const begin = (identityId: string, scope: J.JobScope, operationId: string) =>
      Effect.gen(function* () {
        // Commit the job's cleanup obligation before the independent accounting DB
        // can issue a permit. Neither DB transaction pretends to cover the other.
        yield* store.transaction(
          Effect.gen(function* () {
            const { saved } = yield* eligible(identityId, scope);
            const { operation } = yield* member(identityId, operationId);
            if (operation.job.jobId !== scope.jobId || operation.phase !== "reserved")
              return yield* invalid("A provider permit cannot be replayed or moved between jobs.");
            if (saved.record.cleanupPending && !providerCleanup(saved.record.reason))
              return yield* invalid("Physical process cleanup is unresolved.");
            yield* store.put(
              { ...saved.record, cleanupPending: true, reason: "provider_start_unknown" },
              saved.version,
            );
          }),
        );
        // Cancellation can commit between these transactions. Check ownership again
        // while holding the job transaction through the accounting permit commit.
        return yield* store.transaction(
          Effect.gen(function* () {
            yield* eligible(identityId, scope);
            const operation = yield* ledger.beginDispatch(operationId);
            const profile = (yield* ledger.configuration()).profile;
            return { operation, profile };
          }),
        );
      });
    const unknown = (identityId: string, operationId: string) =>
      store.transaction(
        Effect.gen(function* () {
          yield* member(identityId, operationId);
          return yield* ledger.unknown(operationId);
        }),
      );
    const attach = (
      identityId: string,
      operationId: string,
      run: P.RunIdentity,
      evidence: string | null = null,
    ) =>
      store.transaction(
        Effect.gen(function* () {
          const { saved } = yield* member(identityId, operationId);
          // A retained receipt may arrive after cancellation or lease expiry.
          // Adopt its identity for cleanup without reviving the acquisition.
          if (acquisitionStopped(saved.record, yield* Clock.currentTimeMillis))
            yield* ledger.requestStop(saved.record.jobId);
          const result = yield* ledger.attachRun(operationId, run, evidence);
          if (saved.record.cleanupPending && providerCleanup(saved.record.reason))
            yield* store.put(
              { ...saved.record, reason: "provider_execution_pending" },
              saved.version,
            );
          return result;
        }),
      );
    const settle = Effect.fn("Provider.settleExecution")(function* (jobId: string) {
      const saved = yield* jobs.requireJob(jobId);
      const job = saved.record;
      if (!job.cleanupPending || !providerCleanup(job.reason) || job.activeAttemptId) return;
      const operations = (yield* ledger.all()).filter((op) => op.job.jobId === jobId);
      if (
        operations.some(
          (op) =>
            ["reserved", "dispatching", "unknown"].includes(op.phase) ||
            (op.phase === "known" && !P.terminal(op.status)),
        )
      )
        return;
      const now = yield* Clock.currentTimeMillis;
      const next = { ...job, cleanupPending: false, reason: null };
      if (job.stopReason || (job.deadline !== null && now >= job.deadline)) {
        yield* ledger.requestStop(jobId);
        const cancelled = job.stopReason === "cancelled";
        yield* store.put(
          {
            ...next,
            stage: cancelled ? "cancelled" : "expired",
            lease: null,
            reason: cancelled ? "cancelled" : "deadline",
          },
          saved.version,
        );
      } else if (job.stage === "blocked" || !job.lease) {
        const queued = {
          ...next,
          stage: "queued" as const,
          lease: null,
          ready: false,
          generation: job.generation + 1,
        };
        yield* store.put(queued, saved.version);
        yield* store.schedule(queued);
      } else yield* store.put(next, saved.version);
    });
    // Accounting/retention can outlive an expired lease or cancelled job, but still
    // require a current Runner credential and namespace membership.
    const observe = (identityId: string, operationId: string, update: P.RunObservation) =>
      store.transaction(
        Effect.gen(function* () {
          const { operation } = yield* member(identityId, operationId);
          const result = yield* ledger.observe(operationId, update);
          yield* settle(operation.job.jobId);
          return result;
        }),
      );
    const inspect = (identityId: string, jobId: string) =>
      store.transaction(
        Effect.gen(function* () {
          yield* store.assertOwner();
          yield* jobs.authorizedRunner(identityId);
          const job = (yield* jobs.requireJob(jobId)).record;
          if (
            (yield* ledger.all()).some(
              (op) => op.job.jobId === jobId && op.job.namespace !== namespace,
            )
          )
            return yield* new JobError({
              code: "not_found",
              message: "Provider job not found in this namespace.",
            });
          const now = yield* Clock.currentTimeMillis;
          const shouldStop = acquisitionStopped(job, now);
          if (shouldStop) yield* ledger.requestStop(jobId);
          yield* settle(jobId);
          return {
            shouldStop,
            operations: (yield* ledger.all()).filter(
              (op) => op.job.jobId === jobId && op.job.namespace === namespace,
            ),
          };
        }),
      );
    const pending = (identityId: string) =>
      store.transaction(
        Effect.gen(function* () {
          yield* store.assertOwner();
          yield* jobs.authorizedRunner(identityId);
          return (yield* ledger.all()).filter(
            (op) =>
              op.job.namespace === namespace &&
              op.phase !== "closed" &&
              (!P.terminal(op.status) || !op.archived || !op.costStable),
          );
        }),
      );
    const profile = (identityId: string) =>
      store.transaction(
        Effect.gen(function* () {
          yield* store.assertOwner();
          yield* jobs.authorizedRunner(identityId);
          if (!enabled)
            return yield* new P.ProviderError({
              code: "disabled",
              message: "Live provider accounting is not configured.",
            });
          return (yield* ledger.configuration()).profile;
        }),
      );
    const retain = Effect.fn("Provider.retainAuthorized")(function* (
      identityId: string,
      input: typeof ProviderRawUpload.Type,
    ) {
      const { operation } = yield* member(identityId, input.operationId);
      const page = yield* archive.retain(input);
      // Replaying a lost acknowledgment repairs either database boundary without
      // another R2 object or a fresh acquisition, including after cancellation.
      yield* member(identityId, input.operationId);
      yield* library.registerRaw(operation.job.jobId, {
        schemaVersion: 1,
        assetId: page.assetId,
        objectKey: rawObject(namespace, page).key,
        mediaType: "application/json",
        byteLength: page.byteLength,
        sha256: page.sha256,
      });
      return page;
    });
    const raw = Effect.fn("Provider.readAuthorized")(function* (
      identityId: string,
      operationId: string,
      pageKey: string,
    ) {
      yield* member(identityId, operationId);
      return yield* archive.read(operationId, pageKey);
    });
    const pages = Effect.fn("Provider.pagesAuthorized")(function* (
      identityId: string,
      operationId: string,
    ) {
      const { operation } = yield* member(identityId, operationId);
      const retained = yield* ledger.pages(operationId);
      // A process can die after archive checkpointing and before the namespace
      // library registration. Discovery repairs this cross-database boundary.
      for (const page of retained)
        yield* library.registerRaw(operation.job.jobId, {
          schemaVersion: 1,
          assetId: page.assetId,
          objectKey: rawObject(namespace, page).key,
          mediaType: "application/json",
          byteLength: page.byteLength,
          sha256: page.sha256,
        });
      return retained;
    });
    const completeArchive = Effect.fn("Provider.archiveAuthorized")(function* (
      identityId: string,
      operationId: string,
    ) {
      yield* member(identityId, operationId);
      return yield* archive.complete(operationId);
    });
    return {
      configure,
      reserve,
      begin,
      unknown,
      attach,
      observe,
      inspect,
      pending,
      profile,
      retain,
      raw,
      pages,
      completeArchive,
    };
  });
export class JobProviders extends Context.Service<
  JobProviders,
  Effect.Success<ReturnType<typeof makeJobProviders>>
>()("personal-wiki/JobProviders") {
  static layer = (namespace: typeof P.Namespace.Type, enabled = true) =>
    Layer.effect(JobProviders, makeJobProviders(namespace, enabled));
}
