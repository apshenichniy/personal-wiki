import { Schema } from "effect";
import * as J from "@personal-wiki/contracts/jobs";
import * as K from "@personal-wiki/contracts/knowledge";

const Millis = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
export const Lease = Schema.Struct({ identityId: K.Id, instanceId: K.Id, expiresAt: Millis });
export const RetainedCapture = Schema.Struct({
  draft: K.Draft,
  captures: Schema.Array(K.Capture).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
});
export const JobRecord = Schema.Struct({
  jobId: K.Id,
  sourceKey: Schema.String,
  stage: J.JobStage,
  submittedUrl: Schema.String,
  normalizedUrl: Schema.String,
  anchorId: K.ProviderId,
  mode: Schema.Literals(["save", "refresh", "retry_retained"]),
  createdAt: Millis,
  startedAt: Schema.NullOr(Millis),
  deadline: Schema.NullOr(Millis),
  policy: J.Policy,
  counters: J.Counters,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  ready: Schema.Boolean,
  epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lease: Schema.NullOr(Lease),
  reason: Schema.NullOr(Schema.String),
  warnings: Schema.Array(Schema.String),
  stopReason: Schema.NullOr(Schema.Literals(["cancelled", "deadline"])),
  cleanupPending: Schema.Boolean,
  previousJobId: Schema.NullOr(K.Id),
  capture: Schema.NullOr(RetainedCapture),
  result: Schema.NullOr(K.Proposal),
  resultDigest: Schema.NullOr(Schema.String),
  operationId: Schema.NullOr(K.Id),
  receiptOperationId: Schema.NullOr(K.Id),
  activeAttemptId: Schema.NullOr(K.Id),
  nextReason: J.AttemptReason,
  retryAt: Schema.NullOr(Millis),
}).annotate({ identifier: "JobRecord" });
export type JobRecord = typeof JobRecord.Type;
export type RetainedCapture = typeof RetainedCapture.Type;
export const terminalStages = ["succeeded", "failed", "expired", "cancelled"] as const;
export const isTerminal = (stage: J.JobStage) => terminalStages.some((value) => value === stage);
