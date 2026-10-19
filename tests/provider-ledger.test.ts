import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { ProviderLedger } from "../apps/knowledge-service/src/providers/ledger.ts";
import * as P from "@personal-wiki/contracts/provider";

const now = Date.parse("2026-10-19T12:00:00Z");
const hash = "a".repeat(64);
const profile: P.Profile = {
  version: "apify-x-v1",
  actorId: "synthetic-actor",
  buildId: "synthetic-build",
  buildNumber: "1.0.0",
  privacyEvidence: hash,
  pricingEvidence: hash,
  inputSchemaDigest: hash,
  campaignId: "synthetic-acceptance",
  eventNanos: 150_000,
  platformNanos: 20_000_000,
  retrievalNanos: 20_000_000,
};
const input = (patch: Partial<P.ReserveOperation> = {}): P.ReserveOperation => ({
  job: {
    jobId: crypto.randomUUID(),
    namespace: "staging",
    startedAt: now,
    deadline: now + 300_000,
  },
  planKey: "0:anchor:100/1",
  inputJson: '{"tweetId":"100"}',
  chargeNanos: 20_000_000,
  platformNanos: 0,
  retrievalNanos: 500_000,
  replacementOf: null,
  ...patch,
});
const run = (patch: Partial<P.RunIdentity> = {}): P.RunIdentity => ({
  runId: crypto.randomUUID(),
  datasetId: "synthetic-dataset",
  keyValueStoreId: "synthetic-kv",
  buildId: profile.buildId,
  startedAt: now,
  ...patch,
});
const failed = <A, E>(effect: Effect.Effect<A, E>, code: string) =>
  effect.pipe(
    Effect.result,
    Effect.tap((r) =>
      Effect.sync(() => expect(r).toMatchObject({ _tag: "Failure", failure: { code } })),
    ),
  );
async function withLedger<A, E>(
  body: (ledger: typeof ProviderLedger.Service) => Effect.Effect<A, E>,
) {
  const root = await mkdtemp(join(tmpdir(), "wiki-provider-"));
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        return yield* body(yield* ProviderLedger);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(ProviderLedger.layer(join(root, "accounting.sqlite")), TestClock.layer()),
        ),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const page = (operationId: string, pageKey = "dataset:0"): P.Page => ({
  operationId,
  pageKey,
  assetId: crypto.randomUUID(),
  sha256: hash,
  byteLength: 100,
  offset: 0,
  itemCount: 1,
});

test("accounting fails closed until provisioned; plan retries preserve identity and quota", async () =>
  withLedger((ledger) =>
    Effect.gen(function* () {
      const value = input();
      yield* failed(ledger.reserve(value), "disabled");
      yield* ledger.provision(profile, []);
      const first = yield* ledger.reserve(value);
      expect(yield* ledger.reserve(value)).toEqual(first);
      yield* failed(ledger.reserve({ ...value, inputJson: "{}" }), "conflict");
      yield* failed(
        ledger.reserve({
          ...value,
          planKey: "new",
          job: { ...value.job, deadline: now + 600_000 },
        }),
        "conflict",
      );
      expect((yield* ledger.all()).length).toBe(1);
    }),
  ));

test("a consumed permit cannot be repeated and unknown starts block both namespaces", async () =>
  withLedger((ledger) =>
    Effect.gen(function* () {
      yield* ledger.provision(profile, []);
      const value = input();
      const op = yield* ledger.reserve(value);
      const permit = yield* ledger.beginDispatch(op.operationId);
      expect(permit.phase).toBe("dispatching");
      expect(permit.dispatchNonce).not.toBeNull();
      yield* failed(ledger.beginDispatch(op.operationId), "invalid_transition");
      yield* ledger.unknown(op.operationId);
      yield* failed(
        ledger.reserve(input({ job: { ...input().job, namespace: "production" } })),
        "remote_pending",
      );
      yield* ledger.requestStop(value.job.jobId);
      expect(P.liability(yield* ledger.get(op.operationId))).toBe(20_500_000);
      yield* failed(ledger.attachRun(op.operationId, run()), "invalid_request");
      const identity = run();
      yield* ledger.attachRun(op.operationId, identity, hash);
      expect((yield* ledger.unknown(op.operationId)).phase).toBe("known");
      expect((yield* ledger.get(op.operationId)).stopRequested).toBe(true);
    }),
  ));

test("terminal and charge observations are monotonic; delayed costs retain reservation until archive and stability", async () =>
  withLedger((ledger) =>
    Effect.gen(function* () {
      yield* ledger.provision(profile, []);
      const op = yield* ledger.reserve(input());
      const identity = run();
      yield* ledger.beginDispatch(op.operationId);
      yield* ledger.attachRun(op.operationId, identity);
      const report: P.RunObservation = {
        runId: identity.runId,
        status: "SUCCEEDED",
        finishedAt: now,
        usageNanos: 0,
        transientFailure: false,
      };
      yield* ledger.observe(op.operationId, report);
      expect(P.liability(yield* ledger.get(op.operationId))).toBe(20_500_000);
      yield* TestClock.adjust("11 seconds");
      yield* ledger.observe(op.operationId, { ...report, usageNanos: 1_000_000 });
      yield* ledger.retainPage(page(op.operationId));
      yield* ledger.archived(op.operationId);
      expect(P.liability(yield* ledger.get(op.operationId))).toBe(20_500_000);
      yield* TestClock.adjust("11 seconds");
      yield* ledger.observe(op.operationId, { ...report, usageNanos: 1_000_000 });
      expect(P.liability(yield* ledger.get(op.operationId))).toBe(1_500_000);
      yield* ledger.observe(op.operationId, {
        ...report,
        status: "RUNNING",
        finishedAt: null,
        usageNanos: 0,
      });
      const final = yield* ledger.get(op.operationId);
      expect(final.status).toBe("SUCCEEDED");
      expect(final.observedCost).toBe(1_000_000);
      expect(final.costStable).toBe(true);
    }),
  ));

test("late overcharge is retained and quarantines new spending without blocking evidence recovery", async () =>
  withLedger((ledger) =>
    Effect.gen(function* () {
      yield* ledger.provision(profile, []);
      const value = input();
      const op = yield* ledger.reserve(value);
      const identity = run();
      yield* ledger.beginDispatch(op.operationId);
      yield* ledger.attachRun(op.operationId, identity);
      yield* ledger.observe(op.operationId, {
        runId: identity.runId,
        status: "SUCCEEDED",
        finishedAt: now,
        usageNanos: 21_000_000,
        transientFailure: false,
      });
      expect((yield* ledger.configuration()).quarantined).toBe(true);
      expect((yield* ledger.get(op.operationId)).observedCost).toBe(21_000_000);
      expect((yield* ledger.reserve(value)).operationId).toBe(op.operationId);
      yield* ledger.retainPage(page(op.operationId));
      yield* failed(ledger.reserve(input()), "disabled");
    }),
  ));

test("job, monthly and campaign reservations cannot be replenished by namespace changes or import replay", async () =>
  withLedger((ledger) =>
    Effect.gen(function* () {
      const baseline = {
        baselineId: "pilot",
        month: "2026-10",
        campaignId: null,
        nanos: 4_750_000_000,
        evidence: hash,
      };
      yield* ledger.provision(profile, [baseline]);
      yield* ledger.provision(profile, [baseline]);
      const value = input({ chargeNanos: 249_500_000 });
      yield* ledger.reserve(value);
      yield* failed(ledger.reserve({ ...value, planKey: "second" }), "budget");
      yield* failed(
        ledger.reserve(input({ job: { ...input().job, namespace: "production" } })),
        "budget",
      );
      yield* failed(ledger.provision(profile, [{ ...baseline, nanos: 0 }]), "conflict");
    }),
  ));

test("the campaign ceiling is shared across jobs even with separate month allowance", async () =>
  withLedger((ledger) =>
    Effect.gen(function* () {
      yield* ledger.provision(profile, [
        {
          baselineId: "prior-campaign",
          month: "2026-09",
          campaignId: profile.campaignId,
          nanos: 1_750_000_000,
          evidence: hash,
        },
      ]);
      yield* ledger.reserve(input({ chargeNanos: 249_500_000 }));
      yield* failed(ledger.reserve(input()), "budget");
    }),
  ));

test("a never-dispatched stop releases liability, but stop before reservation is durable", async () =>
  withLedger((ledger) =>
    Effect.gen(function* () {
      yield* ledger.provision(profile, []);
      const value = input();
      const op = yield* ledger.reserve(value);
      yield* ledger.requestStop(value.job.jobId);
      expect(P.liability(yield* ledger.get(op.operationId))).toBe(0);
      yield* failed(ledger.beginDispatch(op.operationId), "invalid_transition");
      const other = input();
      yield* ledger.requestStop(other.job.jobId);
      yield* failed(ledger.reserve(other), "deadline");
    }),
  ));

test("only a confirmed transient terminal failure allows one budgeted replacement", async () =>
  withLedger((ledger) =>
    Effect.gen(function* () {
      yield* ledger.provision(profile, []);
      const value = input();
      const op = yield* ledger.reserve(value);
      yield* ledger.beginDispatch(op.operationId);
      const identity = run();
      yield* ledger.attachRun(op.operationId, identity);
      yield* failed(
        ledger.reserve({ ...value, planKey: "retry", replacementOf: op.operationId }),
        "remote_pending",
      );
      yield* ledger.observe(op.operationId, {
        runId: identity.runId,
        status: "FAILED",
        finishedAt: now,
        usageNanos: 1_000_000,
        transientFailure: true,
      });
      const retry = yield* ledger.reserve({
        ...value,
        planKey: "retry",
        replacementOf: op.operationId,
      });
      yield* failed(
        ledger.reserve({ ...value, planKey: "retry-again", replacementOf: op.operationId }),
        "invalid_transition",
      );
      expect(P.liability(retry) + P.liability(yield* ledger.get(op.operationId))).toBe(41_000_000);
    }),
  ));

test("page checkpoints are immutable, resume after expiry, and enforce shared raw bytes", async () =>
  withLedger((ledger) =>
    Effect.gen(function* () {
      yield* ledger.provision(profile, []);
      const op = yield* ledger.reserve(input());
      yield* ledger.beginDispatch(op.operationId);
      yield* ledger.attachRun(op.operationId, run());
      const first = { ...page(op.operationId), byteLength: 16_777_216 };
      yield* ledger.retainPage(first);
      yield* ledger.retainPage(first);
      yield* failed(ledger.retainPage({ ...first, sha256: "b".repeat(64) }), "conflict");
      yield* TestClock.adjust("6 minutes");
      for (let i = 1; i < 4; i++)
        yield* ledger.retainPage({
          ...page(op.operationId, `dataset:${i}`),
          byteLength: 16_777_216,
        });
      yield* failed(ledger.retainPage(page(op.operationId, "dataset:4")), "capacity");
      expect((yield* ledger.pages(op.operationId)).length).toBe(4);
    }),
  ));

test("dispatch month rollover checks the new allowance and never resets the deadline", async () =>
  withLedger((ledger) =>
    Effect.gen(function* () {
      const boundary = Date.parse("2026-10-31T23:59:59Z");
      yield* TestClock.setTime(boundary);
      yield* ledger.provision(profile, [
        {
          baselineId: "next-month",
          month: "2026-11",
          campaignId: null,
          nanos: 5_000_000_000,
          evidence: hash,
        },
      ]);
      const value = input({
        job: { ...input().job, startedAt: boundary, deadline: boundary + 300_000 },
      });
      const op = yield* ledger.reserve(value);
      yield* TestClock.adjust("2 seconds");
      yield* failed(ledger.beginDispatch(op.operationId), "budget");
      expect((yield* ledger.get(op.operationId)).phase).toBe("reserved");
      yield* TestClock.adjust("5 minutes");
      yield* failed(ledger.beginDispatch(op.operationId), "deadline");
    }),
  ));

test("known runs and reservations survive a fresh database connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-provider-restart-"));
  const path = join(root, "accounting.sqlite");
  const value = input();
  try {
    const id = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const ledger = yield* ProviderLedger;
        yield* ledger.provision(profile, []);
        const op = yield* ledger.reserve(value);
        yield* ledger.beginDispatch(op.operationId);
        return op.operationId;
      }).pipe(Effect.provide(Layer.mergeAll(ProviderLedger.layer(path), TestClock.layer()))),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(now + 1000);
        const ledger = yield* ProviderLedger;
        expect((yield* ledger.get(id)).phase).toBe("dispatching");
        yield* failed(ledger.beginDispatch(id), "invalid_transition");
        yield* failed(ledger.reserve(input()), "remote_pending");
      }).pipe(Effect.provide(Layer.mergeAll(ProviderLedger.layer(path), TestClock.layer()))),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decimal dollar amounts round liabilities upward", () => {
  expect(P.usdToNanos(0.021634755251652666)).toBe(21_634_756);
  expect(() => P.usdToNanos(Number.NaN)).toThrow();
  expect(() => P.usdToNanos(-0.1)).toThrow();
});

test("platform usage is reserved separately from the Actor event ceiling", async () =>
  withLedger((ledger) =>
    Effect.gen(function* () {
      yield* ledger.provision(profile, []);
      const op = yield* ledger.reserve(
        input({ chargeNanos: 10_000_000, platformNanos: 5_000_000 }),
      );
      expect(P.liability(op)).toBe(15_500_000);
      yield* ledger.beginDispatch(op.operationId);
      const identity = run();
      yield* ledger.attachRun(op.operationId, identity);
      yield* ledger.observe(op.operationId, {
        runId: identity.runId,
        status: "SUCCEEDED",
        finishedAt: now,
        usageNanos: 14_000_000,
        transientFailure: false,
      });
      expect((yield* ledger.configuration()).quarantined).toBe(false);
    }),
  ));

test("two physical service processes share the remaining monthly allowance", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-provider-race-"));
  const path = join(root, "accounting.sqlite");
  const startedAt = Date.now();
  const month = P.monthOf(startedAt);
  const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* ProviderLedger;
        yield* ledger.provision(profile, [
          {
            baselineId: "already-spent",
            month,
            campaignId: null,
            nanos: 4_800_000_000,
            evidence: hash,
          },
        ]);
      }).pipe(Effect.provide(ProviderLedger.layer(path))),
    );
    for (const namespace of ["staging", "production"])
      children.push(
        Bun.spawn([process.execPath, "tests/helpers/provider-probe.ts"], {
          env: {
            PATH: process.env.PATH,
            WIKI_TEST_LEDGER: path,
            WIKI_TEST_JOB: crypto.randomUUID(),
            WIKI_TEST_PLAN: namespace,
            WIKI_TEST_STARTED: String(startedAt),
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
    const outputs = await Promise.all(
      children.map(async (child) => {
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, error).toBe(0);
        return JSON.parse(output);
      }),
    );
    expect(outputs.filter((o) => o.outcome === "reserved")).toHaveLength(1);
    expect(outputs.filter((o) => o.outcome === "rejected" && o.code === "budget")).toHaveLength(1);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("SIGKILL after a dispatch intent does not authorize a replacement POST", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-provider-kill-"));
  const path = join(root, "accounting.sqlite");
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* ProviderLedger;
        yield* ledger.provision(profile, []);
      }).pipe(Effect.provide(ProviderLedger.layer(path))),
    );
    child = Bun.spawn([process.execPath, "tests/helpers/provider-probe.ts"], {
      env: {
        PATH: process.env.PATH,
        WIKI_TEST_LEDGER: path,
        WIKI_TEST_JOB: crypto.randomUUID(),
        WIKI_TEST_PLAN: "crash",
        WIKI_TEST_STARTED: String(Date.now()),
        WIKI_TEST_MODE: "crash",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    let text = "";
    const timer = setTimeout(() => child?.kill("SIGKILL"), 10000);
    try {
      while (!text.includes("\n")) {
        const part = await reader.read();
        if (part.done) throw new Error("Probe exited before intent");
        text += new TextDecoder().decode(part.value);
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
    const result = JSON.parse(text.trim());
    expect(result.outcome).toBe("dispatching");
    child.kill("SIGKILL");
    await child.exited;
    await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* ProviderLedger;
        expect((yield* ledger.get(result.operationId)).phase).toBe("dispatching");
        yield* failed(ledger.beginDispatch(result.operationId), "invalid_transition");
      }).pipe(Effect.provide(ProviderLedger.layer(path))),
    );
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    if (child) await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
