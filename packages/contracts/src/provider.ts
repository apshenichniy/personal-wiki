import { Schema } from "effect";
import { Id } from "./knowledge.ts";

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  code: Schema.Literals([
    "invalid_request",
    "conflict",
    "not_found",
    "disabled",
    "budget",
    "deadline",
    "remote_pending",
    "capacity",
    "invalid_transition",
  ]),
  message: Schema.String,
}) {}
export const Nanos = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const Millis = Nanos;
export const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
export const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/));
export const Namespace = Schema.Literals(["staging", "production"]);
export const Profile = Schema.Struct({
  version: Schema.Literal("apify-x-v1"),
  actorId: Name,
  buildId: Name,
  buildNumber: Name,
  privacyEvidence: Hash,
  pricingEvidence: Hash,
  inputSchemaDigest: Hash,
  campaignId: Name,
  eventNanos: Nanos.check(Schema.isGreaterThan(0)),
  platformNanos: Nanos.check(Schema.isGreaterThan(0)),
  retrievalNanos: Nanos.check(Schema.isGreaterThan(0)),
});
export type Profile = typeof Profile.Type;
export const AcquisitionJob = Schema.Struct({
  jobId: Id,
  namespace: Namespace,
  startedAt: Millis,
  deadline: Millis,
});
export type AcquisitionJob = typeof AcquisitionJob.Type;
export const ReserveOperation = Schema.Struct({
  job: AcquisitionJob,
  planKey: Name,
  inputJson: Schema.String.check(Schema.isMaxLength(65_536)),
  chargeNanos: Nanos,
  platformNanos: Nanos,
  retrievalNanos: Nanos,
  replacementOf: Schema.NullOr(Id),
});
export type ReserveOperation = typeof ReserveOperation.Type;
export const RunIdentity = Schema.Struct({
  runId: Name,
  datasetId: Name,
  keyValueStoreId: Name,
  buildId: Name,
  startedAt: Millis,
});
export type RunIdentity = typeof RunIdentity.Type;
export const RunStatus = Schema.Literals([
  "READY",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "TIMING-OUT",
  "TIMED-OUT",
  "ABORTING",
  "ABORTED",
]);
export type RunStatus = typeof RunStatus.Type;
export const RunObservation = Schema.Struct({
  runId: Name,
  status: RunStatus,
  finishedAt: Schema.NullOr(Millis),
  usageNanos: Schema.NullOr(Nanos),
  transientFailure: Schema.Boolean,
});
export type RunObservation = typeof RunObservation.Type;
export const Operation = Schema.Struct({
  operationId: Id,
  job: AcquisitionJob,
  planKey: Name,
  digest: Hash,
  inputJson: Schema.String,
  chargeNanos: Nanos,
  platformNanos: Nanos,
  retrievalNanos: Nanos,
  replacementOf: Schema.NullOr(Id),
  phase: Schema.Literals(["reserved", "dispatching", "unknown", "known", "closed"]),
  month: Month,
  campaignId: Name,
  reservedAt: Millis,
  dispatchedAt: Schema.NullOr(Millis),
  dispatchNonce: Schema.NullOr(Id),
  run: Schema.NullOr(RunIdentity),
  status: Schema.NullOr(RunStatus),
  finishedAt: Schema.NullOr(Millis),
  observedCost: Nanos,
  costSample: Schema.NullOr(Nanos),
  costSampleAt: Schema.NullOr(Millis),
  costStable: Schema.Boolean,
  stopRequested: Schema.Boolean,
  archived: Schema.Boolean,
  transientFailure: Schema.Boolean,
  resolutionEvidence: Schema.NullOr(Hash),
});
export type Operation = typeof Operation.Type;
export const Page = Schema.Struct({
  operationId: Id,
  pageKey: Name,
  assetId: Id,
  sha256: Hash,
  byteLength: Nanos.check(Schema.isLessThanOrEqualTo(16_777_216)),
  offset: Nanos,
  itemCount: Nanos,
});
export type Page = typeof Page.Type;
export const terminal = (status: RunStatus | null) =>
  status !== null && ["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"].includes(status);
export const monthOf = (millis: number) => new Date(millis).toISOString().slice(0, 7);
// Round liabilities upward. Provider decimal USD never becomes an optimistic
// floating-point subtraction from the remaining quota.
export function usdToNanos(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0 || usd > Number.MAX_SAFE_INTEGER / 1e9)
    throw new ProviderError({ code: "invalid_request", message: "Invalid provider cost." });
  return Math.ceil(usd * 1e9);
}
export function liability(op: Operation) {
  if (op.phase === "closed" && !op.run) return 0;
  const actual = op.costStable && op.archived;
  return (
    (actual ? op.observedCost : Math.max(op.chargeNanos + op.platformNanos, op.observedCost)) +
    op.retrievalNanos
  );
}
