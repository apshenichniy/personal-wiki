import { Clock, Context, Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { stable, digest } from "../storage/io.ts";
import { ProviderDatabase } from "./database.ts";
import * as P from "./model.ts";

const fail = (code: P.ProviderError["code"], message: string) =>
  Effect.fail(new P.ProviderError({ code, message }));
const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(json);
const Baseline = Schema.Struct({
  baselineId: P.Name,
  month: P.Month,
  campaignId: Schema.NullOr(P.Name),
  nanos: P.Nanos,
  evidence: P.Hash,
});
const limits = { job: 250_000_000, month: 5_000_000_000, campaign: 2_000_000_000 };

export const makeProviderLedger = Effect.gen(function* () {
  const sql = yield* ProviderDatabase;
  const configuration = Effect.fn("Provider.configuration")(function* () {
    const row = (yield* sql<{
      profile: string;
      quarantined: number;
      reason: string | null;
    }>`SELECT * FROM provider_configuration WHERE singleton=1`)[0];
    if (!row) return yield* fail("disabled", "Paid acquisition has not been provisioned.");
    return {
      profile: yield* decode(P.Profile, row.profile),
      quarantined: row.quarantined !== 0,
      reason: row.reason,
    };
  });
  const get = Effect.fn("Provider.operation")(function* (id: string) {
    const row = (yield* sql<{
      record: string;
    }>`SELECT record FROM provider_operations WHERE operation_id=${id}`)[0];
    if (!row) return yield* fail("not_found", "Provider operation not found.");
    return yield* decode(P.Operation, row.record);
  });
  const all = Effect.fn("Provider.operations")(function* () {
    return yield* Effect.forEach(
      yield* sql<{ record: string }>`SELECT record FROM provider_operations ORDER BY rowid`,
      (row) => decode(P.Operation, row.record),
    );
  });
  const put = (op: P.Operation) =>
    sql`UPDATE provider_operations SET record=${stable(op)},run_id=${op.run?.runId ?? null} WHERE operation_id=${op.operationId}`;
  const checkEnabled = Effect.fn("Provider.enabled")(function* () {
    const config = yield* configuration();
    if (config.quarantined)
      return yield* fail("disabled", "Provider accounting requires operator reconciliation.");
    return config.profile;
  });
  const checkRemote = Effect.fn("Provider.singleRemote")(function* (except?: string) {
    const pending = (yield* all()).some(
      (op) =>
        op.operationId !== except &&
        (op.phase === "dispatching" ||
          op.phase === "unknown" ||
          (op.run !== null && !P.terminal(op.status))),
    );
    if (pending)
      return yield* fail(
        "remote_pending",
        "An unresolved or active provider run prevents another dispatch.",
      );
  });
  const checkQuota = Effect.fn("Provider.quota")(function* (candidate: P.Operation) {
    const records = (yield* all()).filter((op) => op.operationId !== candidate.operationId);
    records.push(candidate);
    const baseline = yield* sql<{
      month: string;
      campaign_id: string | null;
      nanos: number;
    }>`SELECT month,campaign_id,nanos FROM provider_baselines`;
    const job = records
      .filter((op) => op.job.jobId === candidate.job.jobId)
      .reduce((sum, op) => sum + P.liability(op), 0);
    const month =
      records
        .filter((op) => op.month === candidate.month)
        .reduce((sum, op) => sum + P.liability(op), 0) +
      baseline.filter((b) => b.month === candidate.month).reduce((sum, b) => sum + b.nanos, 0);
    const campaign =
      records
        .filter((op) => op.campaignId === candidate.campaignId)
        .reduce((sum, op) => sum + P.liability(op), 0) +
      baseline
        .filter((b) => b.campaign_id === candidate.campaignId)
        .reduce((sum, b) => sum + b.nanos, 0);
    if (job > limits.job || month > limits.month || campaign > limits.campaign)
      return yield* fail(
        "budget",
        "The shared job, month or acceptance-campaign allowance is exhausted.",
      );
  });
  const jobOpen = Effect.fn("Provider.jobOpen")(function* (job: P.AcquisitionJob) {
    const row = (yield* sql<{
      record: string;
      stopped: number;
    }>`SELECT record,stopped FROM provider_jobs WHERE job_id=${job.jobId}`)[0];
    if (row && row.record !== stable(job))
      return yield* fail("conflict", "Acquisition deadlines and namespace cannot be reset.");
    if (
      row?.stopped ||
      (yield* sql`SELECT job_id FROM provider_stops WHERE job_id=${job.jobId}`).length
    )
      return yield* fail("deadline", "Acquisition is stopped.");
    const now = yield* Clock.currentTimeMillis;
    if (job.startedAt > now || now >= job.deadline || job.deadline > job.startedAt + 300_000)
      return yield* fail("deadline", "The original acquisition window has elapsed or is invalid.");
  });
  /** Trusted operator bootstrap/import only; deliberately absent from Runner APIs.
   * Restoring an older library does not reset this independent accounting file. */
  const provision = (profile: P.Profile, baselines: ReadonlyArray<typeof Baseline.Type>) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(P.Profile)(profile);
        const previous = (yield* sql<{
          profile: string;
        }>`SELECT profile FROM provider_configuration WHERE singleton=1`)[0];
        if (previous && previous.profile !== stable(profile))
          return yield* fail("conflict", "Provisioned provider profile cannot change implicitly.");
        yield* sql`INSERT INTO provider_configuration(singleton,profile) VALUES(1,${stable(profile)}) ON CONFLICT(singleton) DO NOTHING`;
        for (const value of baselines) {
          const b = yield* Schema.decodeUnknownEffect(Baseline)(value);
          const old = (yield* sql<{
            month: string;
            campaign_id: string | null;
            nanos: number;
            evidence: string;
          }>`SELECT * FROM provider_baselines WHERE baseline_id=${b.baselineId}`)[0];
          if (
            old &&
            (old.month !== b.month ||
              old.campaign_id !== b.campaignId ||
              old.nanos !== b.nanos ||
              old.evidence !== b.evidence)
          )
            return yield* fail("conflict", "Imported usage identity has different evidence.");
          yield* sql`INSERT INTO provider_baselines VALUES(${b.baselineId},${b.month},${b.campaignId},${b.nanos},${b.evidence}) ON CONFLICT(baseline_id) DO NOTHING`;
        }
      }),
    );
  const reserve = (value: P.ReserveOperation) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(P.ReserveOperation)(value);
        const semanticDigest = digest(stable(input));
        const old = (yield* sql<{
          operation_id: string;
        }>`SELECT operation_id FROM provider_operations WHERE job_id=${input.job.jobId} AND plan_key=${input.planKey}`)[0];
        if (old) {
          const existing = yield* get(old.operation_id);
          if (existing.digest !== semanticDigest)
            return yield* fail("conflict", "A provider plan key was reused with different input.");
          return existing;
        }
        const config = yield* checkEnabled();
        yield* jobOpen(input.job);
        yield* checkRemote();
        if (
          input.chargeNanos <= 0 ||
          input.retrievalNanos <= 0 ||
          input.chargeNanos + input.platformNanos + input.retrievalNanos > limits.job
        )
          return yield* fail(
            "invalid_request",
            "A finite provider ceiling and retrieval reserve are required.",
          );
        yield* Effect.try({
          try: () => JSON.parse(input.inputJson),
          catch: () =>
            new P.ProviderError({
              code: "invalid_request",
              message: "Provider input must be JSON.",
            }),
        });
        if (input.replacementOf) {
          const prior = yield* get(input.replacementOf);
          if (
            prior.job.jobId !== input.job.jobId ||
            !P.terminal(prior.status) ||
            !prior.transientFailure ||
            prior.status === "SUCCEEDED" ||
            prior.stopRequested
          )
            return yield* fail(
              "invalid_transition",
              "Replacement requires a confirmed transient terminal failure.",
            );
          if (
            (yield* all()).some(
              (op) => op.job.jobId === input.job.jobId && op.replacementOf !== null,
            )
          )
            return yield* fail(
              "invalid_transition",
              "The single replacement allowance has been consumed.",
            );
        }
        const now = yield* Clock.currentTimeMillis;
        const op: P.Operation = {
          operationId: randomUUID(),
          job: input.job,
          planKey: input.planKey,
          digest: semanticDigest,
          inputJson: input.inputJson,
          chargeNanos: input.chargeNanos,
          platformNanos: input.platformNanos,
          retrievalNanos: input.retrievalNanos,
          replacementOf: input.replacementOf,
          phase: "reserved",
          month: P.monthOf(now),
          campaignId: config.campaignId,
          reservedAt: now,
          dispatchedAt: null,
          dispatchNonce: null,
          run: null,
          status: null,
          finishedAt: null,
          observedCost: 0,
          costSample: null,
          costSampleAt: null,
          costStable: false,
          stopRequested: false,
          archived: false,
          transientFailure: false,
          resolutionEvidence: null,
        };
        yield* checkQuota(op);
        yield* sql`INSERT INTO provider_jobs(job_id,record) VALUES(${input.job.jobId},${stable(input.job)}) ON CONFLICT(job_id) DO NOTHING`;
        yield* sql`INSERT INTO provider_operations VALUES(${op.operationId},${op.job.jobId},${op.planKey},NULL,${stable(op)})`;
        return op;
      }),
    );
  /** Never replay this permit: even a lost local response leaves dispatching state.
   * The transport writes its own durable intent before calling this operation. */
  const beginDispatch = (id: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* checkEnabled();
        const op = yield* get(id);
        if (op.phase !== "reserved")
          return yield* fail("invalid_transition", "A start permit has already been consumed.");
        yield* jobOpen(op.job);
        yield* checkRemote(id);
        const now = yield* Clock.currentTimeMillis;
        const next: P.Operation = {
          ...op,
          phase: "dispatching",
          dispatchedAt: now,
          dispatchNonce: randomUUID(),
          month: P.monthOf(now),
        };
        yield* checkQuota(next);
        yield* put(next);
        return next;
      }),
    );
  const unknown = (id: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const op = yield* get(id);
        if (op.phase === "dispatching") {
          const next = { ...op, phase: "unknown" as const };
          yield* put(next);
          return next;
        }
        return op; // A delayed lost-response notification cannot regress a known run.
      }),
    );
  const attachRun = (id: string, value: P.RunIdentity, evidence: string | null = null) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const run = yield* Schema.decodeUnknownEffect(P.RunIdentity)(value);
        const op = yield* get(id);
        const config = yield* configuration();
        if (op.run) {
          if (stable(op.run) !== stable(run))
            return yield* fail("conflict", "Provider run identity changed.");
          return op;
        }
        if (
          !["dispatching", "unknown"].includes(op.phase) ||
          run.buildId !== config.profile.buildId ||
          op.dispatchedAt === null ||
          run.startedAt < op.dispatchedAt - 10_000
        )
          return yield* fail(
            "invalid_transition",
            "Run identity does not match the dispatch intent and pinned build.",
          );
        if (op.phase === "unknown") {
          if (evidence === null)
            return yield* fail(
              "invalid_request",
              "Unambiguous reconciliation evidence is required.",
            );
          yield* Schema.decodeUnknownEffect(P.Hash)(evidence);
        }
        const next: P.Operation = {
          ...op,
          phase: "known",
          run,
          month: P.monthOf(run.startedAt),
          status: "READY",
          resolutionEvidence: evidence,
        };
        // Actual provider start month wins even when the outbound request crossed UTC
        // midnight. Record liability first, then quarantine any resulting overspend.
        yield* put(next);
        const quota = yield* checkQuota(next).pipe(Effect.result);
        if (quota._tag === "Failure")
          yield* sql`UPDATE provider_configuration SET quarantined=1,reason='start_month_budget' WHERE singleton=1`;
        return next;
      }),
    );
  const observe = (id: string, value: P.RunObservation) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const update = yield* Schema.decodeUnknownEffect(P.RunObservation)(value);
        const op = yield* get(id);
        if (!op.run || op.run.runId !== update.runId)
          return yield* fail("conflict", "Status is for a different provider run.");
        if (P.terminal(update.status) && update.finishedAt === null)
          return yield* fail(
            "invalid_request",
            "Terminal observation requires provider finish time.",
          );
        const now = yield* Clock.currentTimeMillis;
        const status = P.terminal(op.status) ? op.status : update.status;
        const finishedAt = op.finishedAt ?? (P.terminal(update.status) ? update.finishedAt : null);
        const usableCost = update.usageNanos !== null && update.usageNanos >= op.observedCost;
        const changed = usableCost && update.usageNanos !== op.costSample;
        const next: P.Operation = {
          ...op,
          status,
          finishedAt,
          observedCost: usableCost ? update.usageNanos! : op.observedCost,
          costSample: usableCost ? update.usageNanos : op.costSample,
          costSampleAt: usableCost && (changed || op.costSampleAt === null) ? now : op.costSampleAt,
          costStable: changed
            ? false
            : op.costStable ||
              (usableCost &&
                P.terminal(status) &&
                finishedAt !== null &&
                now - finishedAt >= 10_000 &&
                op.costSampleAt !== null &&
                now - op.costSampleAt >= 10_000),
          transientFailure: P.terminal(op.status)
            ? op.transientFailure
            : P.terminal(update.status) && update.transientFailure,
        };
        yield* put(next);
        if (next.observedCost > op.chargeNanos + op.platformNanos)
          yield* sql`UPDATE provider_configuration SET quarantined=1,reason='provider_overcharge' WHERE singleton=1`;
        return next;
      }),
    );
  const requestStop = (jobId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO provider_stops VALUES(${jobId}) ON CONFLICT(job_id) DO NOTHING`;
        yield* sql`UPDATE provider_jobs SET stopped=1 WHERE job_id=${jobId}`;
        for (const op of yield* all())
          if (op.job.jobId === jobId) {
            // Only a never-issued permit proves no outbound POST. An abort request or
            // expired lease does not prove remote termination or a refund.
            yield* put({
              ...op,
              stopRequested: true,
              phase: op.phase === "reserved" ? "closed" : op.phase,
            });
          }
      }),
    );
  const resolveAbsent = (id: string, evidence: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(P.Hash)(evidence);
        const op = yield* get(id);
        if (op.run || !["dispatching", "unknown"].includes(op.phase))
          return yield* fail("invalid_transition", "Only an unknown start can be resolved absent.");
        const next: P.Operation = { ...op, phase: "closed", resolutionEvidence: evidence };
        yield* put(next);
        return next;
      }),
    );
  const retainPage = (value: P.Page) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const page = yield* Schema.decodeUnknownEffect(P.Page)(value);
        const op = yield* get(page.operationId);
        if (!op.run)
          return yield* fail("invalid_transition", "Page retention needs an exact known run.");
        const old = (yield* sql<{
          record: string;
        }>`SELECT record FROM provider_pages WHERE operation_id=${page.operationId} AND page_key=${page.pageKey}`)[0];
        if (old) {
          if (old.record !== stable(page))
            return yield* fail("conflict", "Retained page identity changed.");
          return page;
        }
        if (op.archived)
          return yield* fail("invalid_transition", "Archived page manifests are immutable.");
        const rows = yield* sql<{
          record: string;
        }>`SELECT p.record FROM provider_pages p JOIN provider_operations o ON o.operation_id=p.operation_id WHERE o.job_id=${op.job.jobId}`;
        let bytes = 0;
        for (const row of rows) bytes += (yield* decode(P.Page, row.record)).byteLength;
        if (bytes + page.byteLength > 67_108_864)
          return yield* fail("invalid_request", "Raw job capacity exceeded.");
        yield* sql`INSERT INTO provider_pages VALUES(${page.operationId},${page.pageKey},${page.assetId},${stable(page)})`;
        return page;
      }),
    );
  const pages = Effect.fn("Provider.pages")(function* (id: string) {
    return yield* Effect.forEach(
      yield* sql<{
        record: string;
      }>`SELECT record FROM provider_pages WHERE operation_id=${id} ORDER BY rowid`,
      (row) => decode(P.Page, row.record),
    );
  });
  const archived = (id: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const op = yield* get(id);
        if (!P.terminal(op.status) || !(yield* pages(id)).length)
          return yield* fail(
            "invalid_transition",
            "Terminal raw evidence must be retained before archive completion.",
          );
        const next = { ...op, archived: true };
        yield* put(next);
        return next;
      }),
    );
  const quarantine = (reason: string) =>
    sql.withTransaction(
      sql`UPDATE provider_configuration SET quarantined=1,reason=${reason} WHERE singleton=1`,
    );
  return {
    provision,
    configuration,
    reserve,
    beginDispatch,
    unknown,
    attachRun,
    observe,
    requestStop,
    resolveAbsent,
    retainPage,
    pages,
    archived,
    get,
    all,
    quarantine,
  };
});
export class ProviderLedger extends Context.Service<
  ProviderLedger,
  Effect.Success<typeof makeProviderLedger>
>()("personal-wiki/ProviderLedger") {
  static layer = (path: string) =>
    Layer.effect(ProviderLedger, makeProviderLedger).pipe(
      Layer.provide(ProviderDatabase.layer(path)),
    );
}
