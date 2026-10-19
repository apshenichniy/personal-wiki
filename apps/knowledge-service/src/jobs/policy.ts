import { normalizeSubmission as normalizeXUrl } from "@personal-wiki/contracts/x-url";
import { Schema } from "effect";
import type * as J from "@personal-wiki/contracts/jobs";

export class JobError extends Schema.TaggedError<JobError>()("JobError", {
  code: Schema.Literals([
    "invalid_request",
    "idempotency_conflict",
    "not_found",
    "unavailable",
    "invalid_transition",
    "deadline_exceeded",
    "launch_limit",
    "stale_owner",
    "unauthenticated",
    "forbidden",
  ]),
  message: Schema.String,
}) {}
export const defaultPolicy: J.Policy = {
  version: "execution-v1",
  activeJobMs: 30 * 60_000,
  attemptMs: 15 * 60_000,
  maxLaunches: 3,
  maxRepair: 1,
  maxTransient: 1,
  maxStale: 1,
};
export const emptyCounters: J.Counters = { launches: 0, repair: 0, transient: 0, stale: 0 };

/** The caller reserves the returned counters and attempt in one service transaction. */
export function nextLaunch(
  policy: J.Policy,
  counters: J.Counters,
  reason: J.AttemptReason,
  deadline: number,
  now: number,
) {
  if (now >= deadline)
    throw new JobError({
      code: "deadline_exceeded",
      message: "The active job deadline has elapsed.",
    });
  if ((reason === "initial") !== (counters.launches === 0))
    throw new JobError({
      code: "invalid_transition",
      message: "This attempt reason does not match the execution history.",
    });
  if (counters.launches >= policy.maxLaunches)
    throw new JobError({
      code: "launch_limit",
      message: "The shared launch allowance is exhausted.",
    });
  if (reason !== "initial") {
    const limit = {
      repair: policy.maxRepair,
      transient: policy.maxTransient,
      stale: policy.maxStale,
    }[reason];
    if (counters[reason] >= limit)
      throw new JobError({
        code: "launch_limit",
        message: "This recovery allowance is exhausted.",
      });
  }
  return {
    counters: {
      ...counters,
      launches: counters.launches + 1,
      ...(reason === "initial" ? {} : { [reason]: counters[reason] + 1 }),
    },
    attemptDeadline: Math.min(deadline, now + policy.attemptMs),
  };
}
export function allowedActions(
  stage: J.JobStage,
  reason: string | null,
  retainedCapture: boolean,
  deadline: number | null,
  now: number,
): J.JobAction[] {
  if (stage === "succeeded") return ["refresh"];
  if (["failed", "expired", "cancelled"].includes(stage))
    return retainedCapture ? ["retry_retained", "refresh"] : ["refresh"];
  if (stage === "publishing" || stage === "stopping") return [];
  if (stage === "blocked") {
    if (reason === "restore_accounting_unknown") return [];
    if (reason === "retry_scheduled") return ["cancel"];
    if (reason === "provider_start_unknown" || reason === "process_ownership_unknown") return [];
    if (deadline !== null && now >= deadline)
      return retainedCapture ? ["retry_retained", "refresh"] : ["refresh"];
    return ["resume", "cancel"];
  }
  return ["cancel"];
}
export function normalizeSubmission(input: string) {
  try {
    return normalizeXUrl(input);
  } catch {
    throw new JobError({ code: "invalid_request", message: "Supply a supported X post URL." });
  }
}
