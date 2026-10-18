import { Console, Effect, Redacted } from "effect";
import { dispatchOnce } from "../../apps/runner/src/apify/dispatch.ts";
import { makeApifyHttp } from "../../apps/runner/src/apify/http.ts";
const [root, operationId, origin, mode] = process.argv.slice(2);
if (!root || !operationId || !origin || !["intent", "receipt"].includes(mode ?? ""))
  throw new Error("Synthetic probe arguments are required.");
const keepAlive = setInterval(() => {}, 1000);
try {
  await Effect.runPromise(
    dispatchOnce({
      root,
      identity: {
        operationId,
        inputDigest: "a".repeat(64),
        actorId: "syntheticActor",
        buildId: "syntheticBuild",
      },
      client: makeApifyHttp(Redacted.make("synthetic-token"), origin),
      permit: Effect.gen(function* () {
        if (mode === "intent") {
          yield* Console.log("INTENT_DURABLE");
          return yield* Effect.never;
        }
        return {
          actorId: "syntheticActor",
          buildId: "syntheticBuild",
          buildNumber: "1.12.394",
          inputJson: '{"tweetIds":["100"]}',
          chargeNanos: 1_500_000,
          acquisitionDeadline: Date.now() + 60_000,
        };
      }),
      accept: () =>
        Effect.gen(function* () {
          yield* Console.log("RECEIPT_DURABLE");
          return yield* Effect.never;
        }),
      uncertain: Effect.void,
    }),
  );
} finally {
  clearInterval(keepAlive);
}
