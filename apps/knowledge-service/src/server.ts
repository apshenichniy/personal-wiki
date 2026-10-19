import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Console, Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
export { BunRuntime };
export const Server = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Int("PORT").pipe(Config.withDefault(3000));
    if (port < 0 || port > 65535) return yield* Effect.die("PORT must be 0..65535");
    // Loopback is intentional until authenticated ingress is implemented.
    // A 16 MiB raw provider page expands to at most 22,369,624 base64 bytes.
    // Bun enforces the transport ceiling before schema decoding allocates JSON.
    return BunHttpServer.layer({
      hostname: "127.0.0.1",
      port,
      maxRequestBodySize: 24 * 1024 * 1024,
    });
  }),
);
export const Ready = Layer.effectDiscard(
  HttpServer.addressFormattedWith((url) => Console.log(JSON.stringify({ event: "ready", url }))),
);
