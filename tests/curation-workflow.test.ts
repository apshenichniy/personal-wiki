import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { Effect } from "effect";
import { makeClient, makeJobClient } from "@personal-wiki/client";
import type { Claim } from "@personal-wiki/contracts/jobs";
import { launch } from "./helpers/service.ts";
import { prepareSource, postSource } from "./helpers/source.ts";
import { editorial } from "./helpers/curation.ts";

test("retained curation context survives restart, repair and stale rebuild with no new capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-curation-"));
  const token = () => `wk_${randomBytes(32).toString("base64url")}`;
  const runner = token(),
    operator = token(),
    credentials = join(root, "credentials.json");
  await writeFile(
    credentials,
    JSON.stringify({
      credentials: [
        { identityId: randomUUID(), role: "runner", token: runner },
        { identityId: randomUUID(), role: "operator", token: operator },
      ],
    }),
    { mode: 0o600 },
  );
  const env = { WIKI_MACHINE_CREDENTIALS_FILE: credentials };
  let service = await launch(join(root, "library"));
  const seedClient = await Effect.runPromise(makeClient(service.url));
  const seed = await prepareSource(seedClient, [postSource("12200003")]);
  const seedReceipt = await Effect.runPromise(
    seedClient.knowledge.publish({ payload: seed.proposal }),
  );
  await service.stop();
  service = await launch(join(root, "library"), env, true);
  try {
    let client = await Effect.runPromise(makeJobClient(service.url, runner));
    let owner = await Effect.runPromise(makeJobClient(service.url, operator));
    let reader = await Effect.runPromise(makeClient(service.url, runner));
    const submit = await Effect.runPromise(
      owner.jobs.submit({
        payload: {
          requestId: randomUUID(),
          mode: "save",
          url: "https://x.com/example/status/12200001",
        },
      }),
    );
    const instanceId = randomUUID();
    let claim: typeof Claim.Type = null;
    for (let n = 0; !claim && n < 100; n++) {
      claim = await Effect.runPromise(
        client.worker.claim({ payload: { requestId: randomUUID(), instanceId } }),
      );
      if (!claim) await Bun.sleep(20);
    }
    if (!claim) throw Error("No claim");
    let scope = claim.scope;
    const fixture = await prepareSource(
      {
        knowledge: {
          reserve: ({ payload }) => client.worker.reserve({ payload: { ...payload, scope } }),
          list: () => reader.knowledge.list({ query: {} }),
          upload: ({ payload }) =>
            client.worker.upload({ payload: { requestId: randomUUID(), scope, asset: payload } }),
        },
      },
      [postSource("12200001"), { ...postSource("12200002"), kind: "x_article" }],
    );
    await Effect.runPromise(
      client.worker.prepare({
        payload: { requestId: randomUUID(), scope, captures: fixture.proposal.captures },
      }),
    );
    const request = { requestId: randomUUID(), scope, query: "widgets" };
    const first = await Effect.runPromise(client.worker.prepareCuration({ payload: request }));
    expect(await Effect.runPromise(client.worker.prepareCuration({ payload: request }))).toEqual(
      first,
    );
    expect(first.captures).toEqual(fixture.proposal.captures);
    const attempt = await Effect.runPromise(
      client.worker.authorizeAttempt({
        payload: {
          requestId: randomUUID(),
          scope,
          reason: "initial",
          contextId: first.contextId,
          inputDigest: "a".repeat(64),
        },
      }),
    );
    await service.stop();
    service = await launch(join(root, "library"), env, true);
    client = await Effect.runPromise(makeJobClient(service.url, runner));
    owner = await Effect.runPromise(makeJobClient(service.url, operator));
    reader = await Effect.runPromise(makeClient(service.url, runner));
    const pending = await Effect.runPromise(client.worker.pendingExecutions());
    scope = { ...scope, instanceId: randomUUID(), epoch: pending[0]!.epoch };
    const invalid = { ...editorial(first), contextId: randomUUID() };
    const repaired = await Effect.runPromise(
      client.worker.recoverAttempt({
        payload: {
          requestId: randomUUID(),
          scope,
          attemptId: attempt.attemptId,
          processStopped: true,
          outcome: "output",
          output: JSON.stringify(invalid),
          completedAt: new Date().toISOString(),
        },
      }),
    );
    expect(repaired.stage).toBe("prepared");
    const resumed = await Effect.runPromise(
      client.worker.claim({ payload: { requestId: randomUUID(), instanceId: scope.instanceId } }),
    );
    expect(resumed?.scope).toEqual(scope);
    expect(resumed?.nextReason).toBe("repair");
    const second = await Effect.runPromise(
      client.worker.prepareCuration({
        payload: { requestId: randomUUID(), scope, query: "widgets" },
      }),
    );
    expect(second.feedback).toContain("Output must use the supplied context and skill identities.");
    expect(second.captures).toEqual(first.captures);
    const repair = await Effect.runPromise(
      client.worker.authorizeAttempt({
        payload: {
          requestId: randomUUID(),
          scope,
          reason: "repair",
          contextId: second.contextId,
          inputDigest: "b".repeat(64),
        },
      }),
    );
    expect(
      (
        await Effect.runPromise(
          client.worker.completeAttempt({
            payload: {
              requestId: randomUUID(),
              scope,
              attemptId: repair.attemptId,
              processStopped: true,
              outcome: "output",
              output: JSON.stringify(editorial(second)),
            },
          }),
        )
      ).stage,
    ).toBe("validating");
    // Operator compensation legitimately advances the library while the agent works.
    const writer = await Effect.runPromise(makeClient(service.url, operator));
    await Effect.runPromise(
      writer.knowledge.compensate({
        payload: {
          operationId: randomUUID(),
          targetPublicationId: seedReceipt.publicationId,
          expectedRevision: seedReceipt.appliedRevision,
        },
      }),
    );
    expect(
      (
        await Effect.runPromise(
          client.worker.publish({ payload: { requestId: randomUUID(), scope } }),
        )
      ).stage,
    ).toBe("prepared");
    const third = await Effect.runPromise(
      client.worker.prepareCuration({
        payload: { requestId: randomUUID(), scope, query: "widgets" },
      }),
    );
    expect(third.baseRevision).not.toBe(first.baseRevision);
    expect(third.captures).toEqual(first.captures);
    expect(first.related.length).toBeGreaterThan(0);
    expect(third.related).toHaveLength(0);
    const rebuild = await Effect.runPromise(
      client.worker.authorizeAttempt({
        payload: {
          requestId: randomUUID(),
          scope,
          reason: "stale",
          contextId: third.contextId,
          inputDigest: "c".repeat(64),
        },
      }),
    );
    await Effect.runPromise(
      client.worker.completeAttempt({
        payload: {
          requestId: randomUUID(),
          scope,
          attemptId: rebuild.attemptId,
          processStopped: true,
          outcome: "output",
          output: JSON.stringify(editorial(third)),
        },
      }),
    );
    const publication = { requestId: randomUUID(), scope };
    const result = await Effect.runPromise(client.worker.publish({ payload: publication }));
    expect(result.stage).toBe("succeeded");
    expect(result.counters).toMatchObject({ launches: 3, repair: 1, stale: 1 });
    expect(result.receipt?.noteIds).toHaveLength(2);
    expect((await Effect.runPromise(reader.knowledge.list({ query: {} }))).notes).toHaveLength(2);
    expect(await Effect.runPromise(client.worker.publish({ payload: publication }))).toEqual(
      result,
    );
    expect(submit.job?.jobId).toBe(result.jobId);
    await Effect.runPromise(
      owner.jobs.submit({
        payload: { requestId: randomUUID(), mode: "save", url: "https://x.com/i/status/12200004" },
      }),
    );
    let capacityClaim: typeof Claim.Type = null;
    const nextInstance = randomUUID();
    for (let n = 0; !capacityClaim && n < 100; n++) {
      capacityClaim = await Effect.runPromise(
        client.worker.claim({ payload: { requestId: randomUUID(), instanceId: nextInstance } }),
      );
      if (!capacityClaim) await Bun.sleep(20);
    }
    if (!capacityClaim) throw Error("No capacity claim");
    const capacityScope = capacityClaim.scope;
    const capacitySource = await prepareSource(
      {
        knowledge: {
          reserve: ({ payload }) =>
            client.worker.reserve({ payload: { ...payload, scope: capacityScope } }),
          list: () => reader.knowledge.list({ query: {} }),
          upload: ({ payload }) =>
            client.worker.upload({
              payload: { requestId: randomUUID(), scope: capacityScope, asset: payload },
            }),
        },
      },
      [postSource("12200004")],
    );
    await Effect.runPromise(
      client.worker.prepare({
        payload: {
          requestId: randomUUID(),
          scope: capacityScope,
          captures: capacitySource.proposal.captures,
        },
      }),
    );
    const capacity = {
      requestId: randomUUID(),
      scope: capacityScope,
      reason: "curation_capacity" as const,
    };
    const failed = await Effect.runPromise(client.worker.failCuration({ payload: capacity }));
    expect(failed.stage).toBe("failed");
    expect(failed.counters.launches).toBe(0);
    expect(await Effect.runPromise(client.worker.failCuration({ payload: capacity }))).toEqual(
      failed,
    );
    expect((await Effect.runPromise(reader.knowledge.list({ query: {} }))).notes).toHaveLength(2);
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
