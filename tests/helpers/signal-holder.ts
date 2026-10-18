import { Console, Effect } from "effect";
import {
  ownershipLayer,
  publisherRequest,
} from "../../apps/knowledge-service/src/storage/ownership.ts";
await Effect.runPromise(
  Effect.gen(function* () {
    yield* Console.log(JSON.stringify({ event: "ready" }));
    yield* Effect.promise(() => publisherRequest({ method: "test-stop" }));
    return yield* Effect.never;
  }).pipe(Effect.provide(ownershipLayer())),
);
