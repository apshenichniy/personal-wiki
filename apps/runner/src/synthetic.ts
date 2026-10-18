// P4 fixture executor. This entry point makes no model/provider calls and is not
// the production Codex adapter or evidence of physical process supervision.
import { BunRuntime } from "@effect/platform-bun";
import { Config, Console, Effect, Schedule } from "effect";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { makeClient, makeJobClient } from "@personal-wiki/client";
import { prepareSource, postSource, syntheticProposal } from "../../../tests/helpers/source.ts";
const program = Effect.gen(function* () {
  const url = yield* Config.String("WIKI_SERVICE_URL");
  const tokenPath = yield* Config.String("WIKI_RUNNER_TOKEN_FILE");
  const token = (yield* Effect.tryPromise(() => readFile(tokenPath, "utf8"))).trim();
  const client = yield* makeJobClient(url, token);
  const reader = yield* makeClient(url, token);
  const instanceId = randomUUID();
  let claim = yield* client.worker.claim({ payload: { requestId: randomUUID(), instanceId } });
  while (!claim) {
    yield* Effect.sleep("50 millis");
    claim = yield* client.worker.claim({ payload: { requestId: randomUUID(), instanceId } });
  }
  const scope = claim.scope;
  yield* Effect.suspend(() =>
    client.worker.heartbeat({ payload: { requestId: randomUUID(), scope } }),
  ).pipe(Effect.repeat({ schedule: Schedule.spaced("5 seconds") }), Effect.forkScoped);
  let capture = claim.capture;
  if (claim.job.stage === "acquiring") {
    const fixture = yield* Effect.tryPromise(() =>
      prepareSource(
        {
          knowledge: {
            reserve: ({ payload }) => client.worker.reserve({ payload: { ...payload, scope } }),
            list: () => reader.knowledge.list({ query: {} }),
            upload: ({ payload }) =>
              client.worker.upload({ payload: { requestId: randomUUID(), scope, asset: payload } }),
          },
        },
        [postSource(claim!.job.anchorId)],
      ),
    );
    yield* client.worker.prepare({
      payload: { requestId: randomUUID(), scope, captures: fixture.proposal.captures },
    });
    capture = { draft: fixture.draft, captures: fixture.proposal.captures };
  }
  // A validating checkpoint already holds durable output; publication never
  // launches curation again. A prepared checkpoint reuses its immutable capture.
  if (claim.job.stage !== "validating") {
    if (!capture) return yield* Effect.die("Prepared capture is missing");
    const current = yield* reader.knowledge.list({ query: {} });
    const proposal = syntheticProposal(capture.draft, capture.captures, current.appliedRevision);
    const attempt = yield* client.worker.authorizeAttempt({
      payload: {
        requestId: randomUUID(),
        scope,
        reason: claim.nextReason,
        inputDigest: createHash("sha256").update(JSON.stringify(capture.captures)).digest("hex"),
      },
    });
    yield* client.worker.completeAttempt({
      payload: {
        requestId: randomUUID(),
        scope,
        attemptId: attempt.attemptId,
        processStopped: true,
        outcome: "output",
        output: JSON.stringify(proposal),
      },
    });
  }
  const result = yield* client.worker.publish({ payload: { requestId: randomUUID(), scope } });
  if (result.stage !== "succeeded") return yield* Effect.die("Synthetic workflow did not publish");
  yield* Console.log(
    JSON.stringify({
      synthetic: true,
      jobId: result.jobId,
      stage: result.stage,
      counters: result.counters,
    }),
  );
}).pipe(Effect.timeout("30 seconds"), Effect.scoped);
program.pipe(BunRuntime.runMain);
