import { Schema } from "effect";
import {
  Id,
  Instant,
  Receipt,
  Revision,
  Capture,
  Draft,
  SourceInput,
  AssetUpload,
} from "./knowledge.ts";

export const JobStage = Schema.Literals([
  "queued",
  "acquiring",
  "prepared",
  "curating",
  "validating",
  "publishing",
  "blocked",
  "stopping",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
]);
export const AttemptReason = Schema.Literals(["initial", "repair", "transient", "stale"]);
export const JobAction = Schema.Literals(["cancel", "resume", "retry_retained", "refresh"]);
export const Policy = Schema.Struct({
  version: Schema.Literal("execution-v1"),
  activeJobMs: Schema.Int.check(Schema.isGreaterThan(0)),
  attemptMs: Schema.Int.check(Schema.isGreaterThan(0)),
  maxLaunches: Schema.Literal(3),
  maxRepair: Schema.Literal(1),
  maxTransient: Schema.Literal(1),
  maxStale: Schema.Literal(1),
}).annotate({ identifier: "ExecutionPolicy" });
export const Counters = Schema.Struct({
  launches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(3)),
  repair: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  transient: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  stale: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
}).annotate({ identifier: "ExecutionCounters" });
export const Submission = Schema.Struct({
  requestId: Id,
  mode: Schema.Literals(["save", "refresh"]),
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
}).annotate({ identifier: "Submission" });
export const JobScope = Schema.Struct({
  jobId: Id,
  instanceId: Id,
  epoch: Schema.Int.check(Schema.isGreaterThan(0)),
}).annotate({ identifier: "JobScope" });
export const WorkerRequest = Schema.Struct({ requestId: Id, scope: JobScope });
export const JobView = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  jobId: Id,
  stage: JobStage,
  submittedUrl: Schema.String,
  normalizedUrl: Schema.String,
  anchorId: Schema.String,
  sourceKey: Schema.String,
  createdAt: Instant,
  startedAt: Schema.NullOr(Instant),
  deadline: Schema.NullOr(Instant),
  policy: Policy,
  counters: Counters,
  reason: Schema.NullOr(Schema.String),
  warnings: Schema.Array(Schema.String),
  allowedActions: Schema.Array(JobAction),
  receipt: Schema.NullOr(Receipt),
  previousJobId: Schema.NullOr(Id),
  captureSummary: Schema.optional(
    Schema.Array(
      Schema.Struct({
        captureId: Id,
        endedAt: Instant,
        posts: Schema.Int,
        coverage: Capture.fields.coverage,
        warnings: Schema.Array(Schema.String),
      }),
    ),
  ),
  retainedCapture: Schema.Boolean,
  cleanupPending: Schema.Boolean,
}).annotate({ identifier: "JobView" });
export const SubmissionResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  outcome: Schema.Literals(["accepted", "existing_job", "existing_note", "previous_outcome"]),
  job: Schema.NullOr(JobView),
  noteId: Schema.NullOr(Id),
  appliedRevision: Revision,
}).annotate({ identifier: "SubmissionResult" });
export const ClaimRequest = Schema.Struct({ requestId: Id, instanceId: Id });
export const RetainedCapture = Schema.Struct({
  draft: Draft,
  captures: Schema.Array(Capture).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
});
export const Claim = Schema.NullOr(
  Schema.Struct({
    scope: JobScope,
    job: JobView,
    capture: Schema.NullOr(RetainedCapture),
    nextReason: AttemptReason,
  }),
);
export const Attempt = Schema.Struct({
  attemptId: Id,
  jobId: Id,
  scope: JobScope,
  reason: AttemptReason,
  number: Schema.Int,
  authorizedAt: Instant,
  deadline: Instant,
  inputDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  contextId: Schema.optional(Id),
}).annotate({ identifier: "ExecutionAttempt" });
export const ReserveAttempt = Schema.Struct({
  ...WorkerRequest.fields,
  reason: AttemptReason,
  inputDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  contextId: Schema.optional(Id),
});
export const CompleteAttempt = Schema.Struct({
  ...WorkerRequest.fields,
  attemptId: Id,
  // Only the trusted supervisor can attest termination. P7 supplies physical
  // evidence; a CLI exit code alone is not sufficient.
  processStopped: Schema.Literal(true),
  outcome: Schema.Literals(["output", "transient", "auth", "quota", "failed"]),
  output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_048_576))),
});
export const JobCommand = Schema.Struct({ requestId: Id, jobId: Id });
export const BlockJob = Schema.Struct({
  ...WorkerRequest.fields,
  reason: Schema.Literals(["auth", "quota", "provider_start_unknown", "process_ownership_unknown"]),
});
export const ReserveSources = Schema.Struct({
  ...WorkerRequest.fields,
  sources: Schema.Array(SourceInput).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
});
export const UploadSource = Schema.Struct({ ...WorkerRequest.fields, asset: AssetUpload });
export const PrepareCapture = Schema.Struct({
  ...WorkerRequest.fields,
  captures: Schema.Array(Capture).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
});
export const QueueMessage = Schema.Struct({
  jobId: Id,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const FailAcquisition = Schema.Struct({
  ...WorkerRequest.fields,
  reason: Schema.Literals([
    "source_unavailable",
    "source_capacity",
    "provider_failure",
    "identity_conflict",
  ]),
  warnings: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(64),
  ),
});
export type JobStage = typeof JobStage.Type;
export type AttemptReason = typeof AttemptReason.Type;
export type JobAction = typeof JobAction.Type;
export type Policy = typeof Policy.Type;
export type Counters = typeof Counters.Type;
export type JobView = typeof JobView.Type;
export type JobScope = typeof JobScope.Type;
export const ResolveSource = Schema.Struct({
  ...WorkerRequest.fields,
  source: SourceInput,
  evidence: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});
export const SourceResolution = Schema.Struct({
  outcome: Schema.Literals(["continued", "existing_job", "existing_note"]),
  job: JobView,
  noteId: Schema.NullOr(Id),
});

export const RecoverAttempt = Schema.Struct({
  ...CompleteAttempt.fields,
  completedAt: Instant,
});
export const ExecutionPending = Schema.Array(
  Schema.Struct({
    job: JobView,
    epoch: Schema.Int,
    attempt: Attempt,
    leaseActive: Schema.Boolean,
    stopRequested: Schema.Boolean,
  }),
);
export const SettleExecution = Schema.Struct({
  jobId: Id,
  epoch: Schema.Int,
  processStopped: Schema.Literal(true),
});

export const PrepareCuration = Schema.Struct({
  ...WorkerRequest.fields,
  query: Schema.String.check(Schema.isMaxLength(512)),
});
export const FailCuration = Schema.Struct({
  ...WorkerRequest.fields,
  reason: Schema.Literals(["curation_capacity", "curation_configuration"]),
});
