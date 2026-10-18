import { BunRuntime } from "@effect/platform-bun";
import { Config, Console, Effect } from "effect";
import { makeClient } from "@personal-wiki/client";

const program = Effect.gen(function* () {
  const url = yield* Config.String("WIKI_SERVICE_URL").pipe(
    Config.withDefault("http://127.0.0.1:3000"),
  );
  const client = yield* makeClient(url);
  const requestId = crypto.randomUUID();
  const response = yield* client.echo({
    headers: { "x-request-id": requestId },
    payload: { message: "synthetic-runner-probe" },
  });
  if (response.requestId !== requestId) return yield* Effect.die("Correlation identity changed");
  yield* Console.log(JSON.stringify(response));
}).pipe(Effect.timeout("10 seconds"));
program.pipe(BunRuntime.runMain);
