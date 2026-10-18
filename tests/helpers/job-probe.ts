import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Console, Effect, Layer } from "effect";
import * as J from "@personal-wiki/contracts/jobs";
import { Library } from "../../apps/knowledge-service/src/storage/library.ts";
import { JobStore } from "../../apps/knowledge-service/src/jobs/store.ts";
import { JobScheduler } from "../../apps/knowledge-service/src/jobs/scheduler.ts";
import { Jobs } from "../../apps/knowledge-service/src/jobs/service.ts";
import { JobExecution } from "../../apps/knowledge-service/src/jobs/execution.ts";
import { JobLifecycle } from "../../apps/knowledge-service/src/jobs/lifecycle.ts";
import { SourceResolution } from "../../apps/knowledge-service/src/jobs/resolution.ts";
import { JobPublication } from "../../apps/knowledge-service/src/jobs/publication.ts";
import { digest } from "../../apps/knowledge-service/src/storage/io.ts";
import { prepareSource, postSource } from "./source.ts";
const root = process.env.WIKI_DATA_DIR;
if (!root) throw new Error("Synthetic probe root required");
const Storage = JobStore.layer.pipe(Layer.provideMerge(Library.layer(root)));
const Scheduled = JobScheduler.layer(root).pipe(Layer.provideMerge(Storage));
const Base = Jobs.layer(root).pipe(Layer.provideMerge(Scheduled));
const Runtime = Layer.mergeAll(
  SourceResolution.layer,
  JobExecution.layer,
  JobLifecycle.layer,
  JobPublication.layer,
).pipe(Layer.provideMerge(Base));
const program = Effect.gen(function* () {
  const jobs = yield* Jobs;
  const execution = yield* JobExecution;
  const lifecycle = yield* JobLifecycle;
  const publication = yield* JobPublication;
  const resolution = yield* SourceResolution;
  const library = yield* Library;
  const store = yield* JobStore;
  const scheduler = yield* JobScheduler;
  const identity = randomUUID();
  const instanceId = randomUUID();
  yield* store.sql`INSERT INTO machine_credentials VALUES(${identity},${digest(identity)},'runner',0)`;
  let serial = 1000;
  const submit = Effect.fn(function* () {
    const id = String(serial++);
    const request = {
      requestId: randomUUID(),
      mode: "save" as const,
      url: `https://x.com/example/status/${id}`,
    };
    const result = yield* jobs.submit(request);
    assert.equal(result.outcome, "accepted");
    assert(result.job);
    assert.equal(result.job.startedAt, null);
    assert.deepEqual(yield* jobs.submit(request), result);
    const alias = yield* jobs.submit({
      ...request,
      requestId: randomUUID(),
      url: `https://fxtwitter.com/example/status/${id}?s=20`,
    });
    assert.equal(alias.outcome, "existing_job");
    assert.equal(alias.job?.jobId, result.job.jobId);
    return { jobId: result.job.jobId, id };
  });
  const claim = Effect.fn(function* (jobId: string) {
    for (let i = 0; i < 200; i++) {
      const result = yield* jobs.claim(identity, { requestId: randomUUID(), instanceId });
      if (result) {
        assert.equal(result.scope.jobId, jobId);
        return result;
      }
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die("Synthetic job was not delivered");
  });
  const prepared = Effect.fn(function* () {
    const input = yield* submit();
    const claimed = yield* claim(input.jobId);
    const fixture = yield* Effect.tryPromise(() =>
      prepareSource(
        {
          knowledge: {
            reserve: ({ payload }) => publication.reserve(identity, claimed.scope, payload),
            list: () => library.list(),
            upload: ({ payload }) => library.upload(payload),
          },
        },
        [postSource(input.id)],
      ),
    );
    const request = {
      requestId: randomUUID(),
      scope: claimed.scope,
      captures: fixture.proposal.captures,
    };
    assert.equal((yield* publication.prepare(identity, request)).stage, "prepared");
    assert.equal((yield* publication.prepare(identity, request)).stage, "prepared");
    return { ...input, ...claimed, fixture };
  });
  const launch = Effect.fn(function* (scope: J.JobScope, reason: J.AttemptReason) {
    const request = {
      requestId: randomUUID(),
      scope,
      reason,
      inputDigest: digest("synthetic-input"),
    };
    const result = yield* execution.reserve(identity, request);
    assert.deepEqual(yield* execution.reserve(identity, request), result);
    return result;
  });
  if (process.env.WIKI_TEST_JOB_CRASH === "1") {
    const existing = yield* store.latest("x:post:1000");
    if (existing) {
      yield* lifecycle.sweep(true);
      let restored = yield* jobs.get(existing.record.jobId);
      if (restored.stage !== "succeeded") {
        const ownership = yield* claim(existing.record.jobId);
        assert.equal(ownership.job.stage, "validating");
        restored = yield* publication.publish(identity, {
          requestId: randomUUID(),
          scope: ownership.scope,
        });
      }
      assert.equal(restored.stage, "succeeded");
      assert.equal(restored.counters.launches, 1);
      assert(restored.receipt);
      assert.equal((yield* library.list()).notes.length, 1);
      assert.equal((yield* library.outbox()).length, 1);
      yield* Console.log(
        JSON.stringify({
          status: "recovered",
          jobId: restored.jobId,
          operationId: restored.receipt.operationId,
          launches: restored.counters.launches,
        }),
      );
      return;
    }
  }
  // Successful output is retained before publication; both response replays are
  // durable and neither consumes another launch.
  const happy = yield* prepared();
  const first = yield* launch(happy.scope, "initial");
  const completedInput = {
    requestId: randomUUID(),
    scope: happy.scope,
    attemptId: first.attemptId,
    processStopped: true as const,
    outcome: "output" as const,
    output: JSON.stringify(happy.fixture.proposal),
  };
  const output = yield* execution.complete(identity, completedInput);
  assert.equal(output.stage, "validating");
  assert.deepEqual(yield* execution.complete(identity, completedInput), output);
  const publicationInput = { requestId: randomUUID(), scope: happy.scope };
  const result = yield* publication.publish(identity, publicationInput);
  assert.equal(result.stage, "succeeded");
  assert(result.receipt);
  assert.equal(result.counters.launches, 1);
  assert.deepEqual(yield* publication.publish(identity, publicationInput), result);
  const saved = yield* jobs.get(happy.jobId);
  assert.equal(saved.receipt?.operationId, result.receipt.operationId);
  assert.equal((yield* library.list()).appliedRevision, result.receipt.appliedRevision);
  assert.equal(
    (yield* jobs.submit({ requestId: randomUUID(), mode: "save", url: happy.job.normalizedUrl }))
      .outcome,
    "existing_note",
  );
  yield* scheduler.reconcile();
  if (process.env.WIKI_TEST_JOB_CRASH === "1") {
    yield* Console.log(JSON.stringify({ status: "initial", jobId: happy.jobId }));
    return;
  }
  // Malformed output uses one repair, then a classified transient failure uses
  // the final shared launch. Queue redelivery does not change the deadline.
  const retry = yield* prepared();
  const bad = yield* launch(retry.scope, "initial");
  assert.equal(
    (yield* execution.complete(identity, {
      requestId: randomUUID(),
      scope: retry.scope,
      attemptId: bad.attemptId,
      processStopped: true,
      outcome: "output",
      output: "{broken",
    })).stage,
    "prepared",
  );
  const repair = yield* launch(retry.scope, "repair");
  const transient = yield* execution.complete(identity, {
    requestId: randomUUID(),
    scope: retry.scope,
    attemptId: repair.attemptId,
    processStopped: true,
    outcome: "transient",
    output: null,
  });
  assert.equal(transient.stage, "blocked");
  assert.deepEqual(transient.allowedActions, ["cancel"]);
  yield* Effect.sleep("1100 millis");
  yield* lifecycle.sweep();
  const next = yield* claim(retry.jobId);
  assert.equal(next.job.deadline, retry.job.deadline);
  assert.equal(next.job.counters.launches, 2);
  const final = yield* launch(next.scope, "transient");
  const exhausted = yield* execution.complete(identity, {
    requestId: randomUUID(),
    scope: next.scope,
    attemptId: final.attemptId,
    processStopped: true,
    outcome: "output",
    output: "not-json",
  });
  assert.equal(exhausted.stage, "failed");
  assert.deepEqual(exhausted.counters, { launches: 3, repair: 1, transient: 1, stale: 0 });
  const explicit = yield* lifecycle.retryRetained(identity, {
    requestId: randomUUID(),
    jobId: retry.jobId,
  });
  assert.equal(explicit.previousJobId, retry.jobId);
  assert.equal(explicit.counters.launches, 0);
  assert.equal(explicit.startedAt, null);
  assert.equal(explicit.retainedCapture, true);
  assert.equal((yield* jobs.get(retry.jobId)).counters.launches, 3);
  yield* lifecycle.cancel(identity, { requestId: randomUUID(), jobId: explicit.jobId });
  yield* scheduler.reconcile();
  // Unknown provider work cannot be cleared through generic resume or physical
  // process reconciliation, including after its active deadline expires.
  const ambiguous = yield* submit();
  const unknown = yield* claim(ambiguous.jobId);
  yield* lifecycle.block(identity, {
    requestId: randomUUID(),
    scope: unknown.scope,
    reason: "provider_start_unknown",
  });
  assert.equal(
    (yield* lifecycle
      .resume(identity, { requestId: randomUUID(), jobId: ambiguous.jobId })
      .pipe(Effect.result))._tag,
    "Failure",
  );
  assert.equal(
    (yield* lifecycle.reconciledProcess(ambiguous.jobId, unknown.scope.epoch).pipe(Effect.result))
      ._tag,
    "Failure",
  );
  const stopped = yield* lifecycle.cancel(identity, {
    requestId: randomUUID(),
    jobId: ambiguous.jobId,
  });
  assert.equal(stopped.stage, "stopping");
  assert.equal(stopped.cleanupPending, true);
  // Remove only this synthetic unresolved obligation so the remaining independent
  // assertions can proceed. No production operation has this shortcut.
  yield* store.transaction(
    Effect.gen(function* () {
      const old = yield* store.get(ambiguous.jobId);
      assert(old);
      yield* store.put({ ...old.record, stage: "cancelled", cleanupPending: false }, old.version);
    }),
  );
  yield* scheduler.reconcile();
  // Service restart revokes the old epoch and retains an ambiguous launch. Its
  // allowance remains consumed; a physical proof must precede the retry.
  const orphan = yield* prepared();
  yield* launch(orphan.scope, "initial");
  yield* lifecycle.sweep(true);
  const uncertain = yield* jobs.get(orphan.jobId);
  assert.equal(uncertain.stage, "blocked");
  assert.equal(uncertain.reason, "process_ownership_unknown");
  assert.equal(
    (yield* jobs
      .heartbeat(identity, { requestId: randomUUID(), scope: orphan.scope })
      .pipe(Effect.result))._tag,
    "Failure",
  );
  const before = yield* store.get(orphan.jobId);
  assert(before);
  yield* lifecycle.sweep();
  assert.equal((yield* store.get(orphan.jobId))?.record.epoch, before.record.epoch);
  const cancel = yield* lifecycle.cancel(identity, {
    requestId: randomUUID(),
    jobId: orphan.jobId,
  });
  assert.equal(cancel.stage, "stopping");
  const fenced = yield* store.get(orphan.jobId);
  assert(fenced);
  assert.equal(
    (yield* lifecycle.reconciledProcess(orphan.jobId, fenced.record.epoch)).stage,
    "cancelled",
  );
  yield* scheduler.reconcile();
  const expired = yield* prepared();
  yield* store.transaction(
    Effect.gen(function* () {
      const old = yield* store.get(expired.jobId);
      assert(old);
      yield* store.put({ ...old.record, deadline: Date.now() - 1 }, old.version);
    }),
  );
  assert.equal((yield* launch(expired.scope, "initial").pipe(Effect.result))._tag, "Failure");
  yield* lifecycle.sweep();
  assert.equal((yield* jobs.get(expired.jobId)).stage, "expired");
  assert.equal((yield* jobs.get(expired.jobId)).counters.launches, 0);
  yield* scheduler.reconcile();
  for (const pair of [
    ["repair", "transient"],
    ["repair", "stale"],
    ["transient", "repair"],
    ["transient", "stale"],
    ["stale", "repair"],
    ["stale", "transient"],
  ] as const) {
    const item = yield* prepared();
    let scope = item.scope;
    const reasons = ["initial", ...pair] as const;
    for (let index = 0; index < reasons.length; index++) {
      const attempt = yield* launch(scope, reasons[index]!);
      const nextReason = pair[index];
      const request = {
        requestId: randomUUID(),
        scope,
        attemptId: attempt.attemptId,
        processStopped: true as const,
      };
      if (nextReason === "stale") {
        const stale = {
          ...item.fixture.proposal,
          operationId: randomUUID(),
          proposalId: randomUUID(),
          baseRevision: "0".repeat(40),
        };
        yield* execution.complete(identity, {
          ...request,
          outcome: "output",
          output: JSON.stringify(stale),
        });
        assert.equal(
          (yield* publication.publish(identity, { requestId: randomUUID(), scope })).stage,
          "prepared",
        );
      } else if (nextReason === "transient") {
        yield* execution.complete(identity, { ...request, outcome: "transient", output: null });
        // Controllable eligibility time, without resetting job/attempt clocks.
        yield* store.transaction(
          Effect.gen(function* () {
            const old = yield* store.get(item.jobId);
            assert(old);
            yield* store.put({ ...old.record, retryAt: Date.now() - 1 }, old.version);
          }),
        );
        yield* lifecycle.sweep();
        scope = (yield* claim(item.jobId)).scope;
      } else
        yield* execution.complete(identity, { ...request, outcome: "output", output: "invalid" });
    }
    const final = yield* jobs.get(item.jobId);
    assert.equal(final.counters.launches, 3);
    assert.equal(final.counters[pair[0]], 1);
    assert.equal(final.counters[pair[1]], 1);
    assert.equal(final.stage, "failed");
    yield* scheduler.reconcile();
  }
  const gate = yield* prepared();
  yield* lifecycle.block(identity, { requestId: randomUUID(), scope: gate.scope, reason: "quota" });
  assert.deepEqual((yield* jobs.get(gate.jobId)).allowedActions, ["cancel"]);
  assert.equal(
    (yield* lifecycle
      .resume(identity, { requestId: randomUUID(), jobId: gate.jobId })
      .pipe(Effect.result))._tag,
    "Failure",
  );
  yield* lifecycle.restoreAdapter();
  assert.deepEqual((yield* jobs.get(gate.jobId)).allowedActions, ["resume", "cancel"]);
  yield* lifecycle.resume(identity, { requestId: randomUUID(), jobId: gate.jobId });
  const reopened = yield* claim(gate.jobId);
  assert.equal(reopened.job.deadline, gate.job.deadline);
  assert.equal(reopened.job.counters.launches, 0);
  yield* lifecycle.cancel(identity, { requestId: randomUUID(), jobId: gate.jobId });
  yield* scheduler.reconcile();
  const anchor = yield* submit();
  const anchorClaim = yield* claim(anchor.jobId);
  const canonical = yield* submit();
  const resolved = yield* resolution.resolve(identity, {
    requestId: randomUUID(),
    scope: anchorClaim.scope,
    source: {
      kind: "x_author_thread",
      primaryId: canonical.id,
      aliases: [anchor.id],
      resolution: "resolved",
    },
    evidence: "Synthetic verified author-continuation relationship.",
  });
  assert.equal(resolved.outcome, "existing_job");
  assert.equal(resolved.job.jobId, canonical.jobId);
  assert.equal((yield* jobs.get(anchor.jobId)).jobId, canonical.jobId);
  assert.equal(
    (yield* jobs.submit({
      requestId: randomUUID(),
      mode: "save",
      url: `https://x.com/example/status/${anchor.id}`,
    })).job?.jobId,
    canonical.jobId,
  );
  yield* lifecycle.cancel(identity, { requestId: randomUUID(), jobId: canonical.jobId });
  yield* scheduler.reconcile();
  const revoked = yield* prepared();
  const other = yield* submit();
  assert.equal(
    (yield* jobs
      .heartbeat(identity, {
        requestId: randomUUID(),
        scope: { ...revoked.scope, jobId: other.jobId },
      })
      .pipe(Effect.result))._tag,
    "Failure",
  );
  const reserved = yield* launch(revoked.scope, "initial");
  yield* store.sql`UPDATE machine_credentials SET revoked=1 WHERE identity_id=${identity}`;
  assert.equal(
    (yield* execution
      .complete(identity, {
        requestId: randomUUID(),
        scope: revoked.scope,
        attemptId: reserved.attemptId,
        processStopped: true,
        outcome: "output",
        output: JSON.stringify(revoked.fixture.proposal),
      })
      .pipe(Effect.result))._tag,
    "Failure",
  );
  assert.equal((yield* jobs.get(revoked.jobId)).stage, "curating");
  assert.equal((yield* jobs.get(revoked.jobId)).counters.launches, 1);
  yield* Console.log(
    JSON.stringify({
      status: "passed",
      scenarios: [
        "atomic-result",
        "output-replay",
        "repair-transient-budget",
        "retained-retry",
        "provider-ambiguity",
        "epoch-revocation",
        "cleanup",
        "deadline",
      ],
    }),
  );
}).pipe(Effect.timeout("50 seconds"), Effect.scoped, Effect.provide(Runtime));
await Effect.runPromise(program);
