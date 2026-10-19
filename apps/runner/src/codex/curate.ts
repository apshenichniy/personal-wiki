import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import type { Claim } from "@personal-wiki/contracts/jobs";
import { makeJobClient } from "@personal-wiki/client";
import { admit, failure } from "./profile.ts";
import { executeCodex, type CodexInput, type CodexRuntime } from "./execute.ts";
import { privateRead, subscriptionAuth } from "./files.ts";

// The caller supplies the trusted, revision-pinned context (P8) and owns the
// lifetime supervisor lock. This module never acquires source material.
export function curatePrepared(options: {
  client: Effect.Success<ReturnType<typeof makeJobClient>>;
  runtime: CodexRuntime;
  claim: NonNullable<typeof Claim.Type>;
  input: CodexInput;
}) {
  return Effect.gen(function* () {
    const { client, runtime, claim, input } = options;
    const admission = yield* Effect.try({
      try: () => admit(input),
      catch: () => failure("capacity"),
    });
    const auth = yield* Effect.tryPromise({
      try: async () => subscriptionAuth(await privateRead(runtime.authFile)),
      catch: () => failure("auth"),
    }).pipe(Effect.result);
    if (auth._tag === "Failure")
      return yield* client.worker.block({
        payload: {
          requestId: randomUUID(),
          scope: claim.scope,
          reason: "auth",
        },
      });
    const attempt = yield* client.worker.authorizeAttempt({
      payload: {
        requestId: randomUUID(),
        scope: claim.scope,
        reason: claim.nextReason,
        inputDigest: admission.inputDigest,
      },
    });
    const result = yield* executeCodex({
      runtime,
      attempt,
      input,
      heartbeat: () =>
        client.worker.heartbeat({ payload: { requestId: randomUUID(), scope: claim.scope } }),
    });
    return yield* client.worker.completeAttempt({
      payload: {
        requestId: randomUUID(),
        scope: claim.scope,
        attemptId: attempt.attemptId,
        processStopped: true,
        outcome: result.outcome,
        output: result.output,
      },
    });
  });
}
