import { expect, test } from "bun:test";
import {
  allowedActions,
  defaultPolicy,
  emptyCounters,
  nextLaunch,
  normalizeSubmission,
} from "../apps/knowledge-service/src/jobs/policy.ts";
import type { AttemptReason } from "@personal-wiki/contracts/jobs";

const alternatives: AttemptReason[] = ["repair", "transient", "stale"];
for (const second of alternatives)
  for (const third of alternatives.filter((reason) => reason !== second)) {
    test(`initial + ${second} + ${third} exhausts the shared ceiling`, () => {
      let state = nextLaunch(defaultPolicy, emptyCounters, "initial", 1_800_000, 0);
      state = nextLaunch(defaultPolicy, state.counters, second, 1_800_000, 100);
      state = nextLaunch(defaultPolicy, state.counters, third, 1_800_000, 200);
      expect(state.counters.launches).toBe(3);
      const remaining = alternatives.find((reason) => reason !== second && reason !== third)!;
      expect(() => nextLaunch(defaultPolicy, state.counters, remaining, 1_800_000, 300)).toThrow(
        "shared launch allowance",
      );
    });
  }
test("category limits and first-launch identity cannot be reset by delivery or a new request", () => {
  const first = nextLaunch(defaultPolicy, emptyCounters, "initial", 1_800_000, 0);
  expect(() => nextLaunch(defaultPolicy, first.counters, "initial", 1_800_000, 1)).toThrow(
    "execution history",
  );
  for (const reason of alternatives) {
    const next = nextLaunch(defaultPolicy, first.counters, reason, 1_800_000, 1);
    expect(() => nextLaunch(defaultPolicy, next.counters, reason, 1_800_000, 2)).toThrow(
      "recovery allowance",
    );
    expect(() => nextLaunch(defaultPolicy, emptyCounters, reason, 1_800_000, 1)).toThrow(
      "execution history",
    );
  }
});
test("an absolute job deadline caps an attempt and does not grant a launch at expiry", () => {
  expect(nextLaunch(defaultPolicy, emptyCounters, "initial", 1_800_000, 0).attemptDeadline).toBe(
    900_000,
  );
  expect(
    nextLaunch(defaultPolicy, emptyCounters, "initial", 1_800_000, 1_799_999).attemptDeadline,
  ).toBe(1_800_000);
  expect(() => nextLaunch(defaultPolicy, emptyCounters, "initial", 1_800_000, 1_800_000)).toThrow(
    "deadline has elapsed",
  );
});
test("unresolved external or process ownership cannot be bypassed by generic resume", () => {
  for (const reason of ["provider_start_unknown", "process_ownership_unknown"])
    expect(allowedActions("blocked", reason, true, 100, 0)).toEqual([]);
  expect(allowedActions("blocked", "auth_required", true, 100, 0)).toEqual(["resume", "cancel"]);
  expect(allowedActions("expired", "deadline", true, 100, 101)).toEqual([
    "retry_retained",
    "refresh",
  ]);
  expect(allowedActions("publishing", null, true, 100, 101)).toEqual([]);
});
test("post identity excludes sharing parameters and preserves decimal strings", () => {
  const expected = {
    anchorId: "2111467943313969589",
    sourceKey: "x:post:2111467943313969589",
    normalizedUrl: "https://x.com/i/status/2111467943313969589",
  };
  expect(
    normalizeSubmission("https://fxtwitter.com/Example/status/2111467943313969589?s=20"),
  ).toEqual(expected);
  expect(normalizeSubmission(expected.normalizedUrl)).toEqual(expected);
  for (const url of [
    "https://x.com.evil.test/a/status/123",
    "https://user@x.com/a/status/123",
    "https://x.com:8443/a/status/123",
    "file:///a/status/123",
    "https://x.com/a/status/1e20",
    "https://x.com/a/status/123/other",
  ])
    expect(() => normalizeSubmission(url)).toThrow("supported X post URL");
});
