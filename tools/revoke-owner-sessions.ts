// Local operator command; no HTTP route or Runner capability exposes this action.
import { Console, Effect } from "effect";
import { revokeDatabaseSessions } from "../apps/knowledge-service/src/access/operator.ts";

const command = Effect.gen(function* () {
  const path = process.argv[2];
  if (!path) return yield* Effect.die("Existing database path required");
  yield* revokeDatabaseSessions(path);
  yield* Console.log(
    JSON.stringify({ status: "revoked", target: "owner_sessions_and_pending_logins" }),
  );
}).pipe(
  Effect.catchCause(() =>
    Console.log(JSON.stringify({ status: "failed", code: "revocation_failed" })).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
);
await Effect.runPromise(command);
