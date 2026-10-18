import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { makeClient, makeJobClient } from "@personal-wiki/client";
import { launch } from "./helpers/service.ts";
import { postSource, prepareSource } from "./helpers/source.ts";

for (const checkpoint of ["prepared", "validating", "retry_retained"] as const) {
  test(`separate built Runner continues ${checkpoint} without reacquisition`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-runner-recovery-"));
    const token = `wk_${randomBytes(32).toString("base64url")}`;
    const operator = `wk_${randomBytes(32).toString("base64url")}`;
    const credentials = join(root, "credentials.json");
    const tokenFile = join(root, "token");
    await writeFile(
      credentials,
      JSON.stringify({
        credentials: [
          { identityId: randomUUID(), role: "runner", token },
          { identityId: randomUUID(), role: "operator", token: operator },
        ],
      }),
      { mode: 0o600 },
    );
    await writeFile(tokenFile, token, { mode: 0o600 });
    const data = join(root, "data");
    const environment = { WIKI_MACHINE_CREDENTIALS_FILE: credentials };
    let service = await launch(data, environment, true);
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      const reader = await Effect.runPromise(makeClient(service.url, token));
      const worker = await Effect.runPromise(makeJobClient(service.url, token));
      const owner = await Effect.runPromise(makeJobClient(service.url, operator));
      const submission = await Effect.runPromise(
        owner.jobs.submit({
          payload: {
            requestId: randomUUID(),
            mode: "save",
            url: "https://x.com/example/status/9601",
          },
        }),
      );
      let jobId = submission.job!.jobId;
      const instanceId = randomUUID();
      let claim = await Effect.runPromise(
        worker.worker.claim({ payload: { requestId: randomUUID(), instanceId } }),
      );
      for (let i = 0; !claim && i < 100; i++) {
        await Bun.sleep(30);
        claim = await Effect.runPromise(
          worker.worker.claim({ payload: { requestId: randomUUID(), instanceId } }),
        );
      }
      expect(claim).not.toBeNull();
      const scope = claim!.scope;
      const fixture = await prepareSource(
        {
          knowledge: {
            reserve: ({ payload }) => worker.worker.reserve({ payload: { ...payload, scope } }),
            list: () => reader.knowledge.list({ query: {} }),
            upload: ({ payload }) =>
              worker.worker.upload({ payload: { requestId: randomUUID(), scope, asset: payload } }),
          },
        },
        [postSource("9601")],
      );
      await Effect.runPromise(
        worker.worker.prepare({
          payload: {
            requestId: randomUUID(),
            scope,
            captures: fixture.proposal.captures,
          },
        }),
      );
      if (checkpoint === "validating") {
        const attempt = await Effect.runPromise(
          worker.worker.authorizeAttempt({
            payload: {
              requestId: randomUUID(),
              scope,
              reason: "initial",
              inputDigest: "a".repeat(64),
            },
          }),
        );
        await Effect.runPromise(
          worker.worker.completeAttempt({
            payload: {
              requestId: randomUUID(),
              scope,
              attemptId: attempt.attemptId,
              processStopped: true,
              outcome: "output",
              output: JSON.stringify(fixture.proposal),
            },
          }),
        );
      } else if (checkpoint === "retry_retained") {
        await Effect.runPromise(owner.jobs.cancel({ payload: { requestId: randomUUID(), jobId } }));
        const retry = await Effect.runPromise(
          owner.jobs.retryRetained({ payload: { requestId: randomUUID(), jobId } }),
        );
        expect(retry.previousJobId).toBe(jobId);
        jobId = retry.jobId;
      }
      // No Service internals: restart the production artifact and recover only
      // through its authenticated HTTP protocol in a separate Runner process.
      await service.stop();
      service = await launch(data, environment, true);
      child = Bun.spawn([process.execPath, "apps/runner/dist/synthetic.js"], {
        env: {
          PATH: process.env.PATH,
          WIKI_SERVICE_URL: service.url,
          WIKI_RUNNER_TOKEN_FILE: tokenFile,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, errors + output).toBe(0);
      const freshOwner = await Effect.runPromise(makeJobClient(service.url, operator));
      const result = await Effect.runPromise(freshOwner.jobs.get({ params: { jobId } }));
      expect(result.stage).toBe("succeeded");
      expect(result.counters.launches).toBe(1);
      expect(result.receipt?.noteIds).toEqual(fixture.draft.slots.map((slot) => slot.noteId));
      const freshReader = await Effect.runPromise(makeClient(service.url, token));
      const note = await Effect.runPromise(freshReader.knowledge.list({ query: {} }));
      expect(note.notes[0]?.captureIds).toEqual(
        fixture.proposal.captures.map((capture) => capture.captureId),
      );
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      if (child) await child.exited;
      await service.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);
}
