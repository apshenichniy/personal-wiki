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

for (const scenario of ["output", "cancel", "invalid"] as const) {
  test(`retained Codex ${scenario} is reconciled after actual Service restart without a new launch`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-codex-recovery-"));
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
    let service = await launch(join(root, "library"), env, true);
    try {
      let client = await Effect.runPromise(makeJobClient(service.url, runner));
      const owner = await Effect.runPromise(makeJobClient(service.url, operator));
      const reader = await Effect.runPromise(makeClient(service.url, runner));
      await Effect.runPromise(
        owner.jobs.submit({
          payload: {
            requestId: randomUUID(),
            mode: "save",
            url: "https://x.com/example/status/17770001",
          },
        }),
      );
      let claim: typeof Claim.Type = null;
      const instanceId = randomUUID();
      for (let n = 0; !claim && n < 100; n++) {
        claim = await Effect.runPromise(
          client.worker.claim({ payload: { requestId: randomUUID(), instanceId } }),
        );
        if (!claim) await Bun.sleep(20);
      }
      if (!claim) throw Error("No synthetic claim");
      const scope = claim.scope;
      const fixture = await prepareSource(
        {
          knowledge: {
            reserve: ({ payload }) => client.worker.reserve({ payload: { ...payload, scope } }),
            list: () => reader.knowledge.list({ query: {} }),
            upload: ({ payload }) =>
              client.worker.upload({ payload: { requestId: randomUUID(), scope, asset: payload } }),
          },
        },
        [postSource(claim.job.anchorId)],
      );
      await Effect.runPromise(
        client.worker.prepare({
          payload: { requestId: randomUUID(), scope, captures: fixture.proposal.captures },
        }),
      );
      const attempt = await Effect.runPromise(
        client.worker.authorizeAttempt({
          payload: {
            requestId: randomUUID(),
            scope,
            reason: "initial",
            inputDigest: "a".repeat(64),
          },
        }),
      );
      const completedAt = new Date().toISOString();
      if (scenario === "cancel")
        await Effect.runPromise(
          owner.jobs.cancel({ payload: { requestId: randomUUID(), jobId: scope.jobId } }),
        );
      await service.stop();
      service = await launch(join(root, "library"), env, true);
      client = await Effect.runPromise(makeJobClient(service.url, runner));
      const pending = await Effect.runPromise(client.worker.pendingExecutions());
      expect(pending).toHaveLength(1);
      expect(pending[0]!.leaseActive).toBe(false);
      expect(pending[0]!.attempt.attemptId).toBe(attempt.attemptId);
      const recovery = {
        requestId: randomUUID(),
        scope: { ...scope, instanceId: randomUUID(), epoch: pending[0]!.epoch },
        attemptId: attempt.attemptId,
        processStopped: true as const,
        outcome: "output" as const,
        output: scenario === "invalid" ? '{"invalid":true}' : JSON.stringify(fixture.proposal),
        completedAt,
      };
      expect(
        (
          await Effect.runPromise(
            client.worker.completeAttempt({ payload: { ...recovery, scope } }).pipe(Effect.result),
          )
        )._tag,
      ).toBe("Failure");
      expect(
        (
          await Effect.runPromise(
            client.worker
              .recoverAttempt({
                payload: {
                  ...recovery,
                  requestId: randomUUID(),
                  completedAt: new Date(Date.now() + 60000).toISOString(),
                },
              })
              .pipe(Effect.result),
          )
        )._tag,
      ).toBe("Failure");
      if (scenario === "cancel") {
        expect(
          (
            await Effect.runPromise(
              client.worker.recoverAttempt({ payload: recovery }).pipe(Effect.result),
            )
          )._tag,
        ).toBe("Failure");
        const settled = await Effect.runPromise(
          client.worker.settleExecution({
            payload: { jobId: scope.jobId, epoch: pending[0]!.epoch, processStopped: true },
          }),
        );
        expect(settled.stage).toBe("cancelled");
        expect(settled.counters.launches).toBe(1);
      } else {
        const result = await Effect.runPromise(client.worker.recoverAttempt({ payload: recovery }));
        expect(result.stage).toBe(scenario === "output" ? "validating" : "prepared");
        expect(result.counters.launches).toBe(1);
        expect(
          await Effect.runPromise(client.worker.recoverAttempt({ payload: recovery })),
        ).toEqual(result);
        if (scenario === "output") {
          const published = await Effect.runPromise(
            client.worker.publish({ payload: { requestId: randomUUID(), scope: recovery.scope } }),
          );
          expect(published.stage).toBe("succeeded");
          expect(published.counters.launches).toBe(1);
        } else {
          const repair = await Effect.runPromise(
            client.worker.authorizeAttempt({
              payload: {
                requestId: randomUUID(),
                scope: recovery.scope,
                reason: "repair",
                inputDigest: "b".repeat(64),
              },
            }),
          );
          expect(repair.number).toBe(2);
        }
      }
    } finally {
      await service.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
}
