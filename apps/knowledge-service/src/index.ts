import { isAbsolute } from "node:path";
import { Library } from "./storage/library.ts";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Console, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { Routes } from "./http.ts";

const Server = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Int("PORT").pipe(Config.withDefault(3000));
    if (port < 0 || port > 65535) return yield* Effect.die("PORT must be 0..65535");
    // Loopback is intentional until authenticated ingress is implemented.
    return BunHttpServer.layer({ hostname: "127.0.0.1", port });
  }),
);
const Ready = Layer.effectDiscard(
  HttpServer.addressFormattedWith((url) => Console.log(JSON.stringify({ event: "ready", url }))),
);
const LibraryLive = Layer.unwrap(
  Effect.flatMap(Config.String("WIKI_DATA_DIR"), (root) =>
    isAbsolute(root)
      ? Effect.succeed(Library.layer(root))
      : Effect.die("WIKI_DATA_DIR must be an absolute private path"),
  ),
);
const Serving = HttpRouter.serve(Routes.pipe(Layer.provide(LibraryLive)), {
  disableListenLog: true,
  disableLogger: true,
}).pipe(Layer.provideMerge(Server));
const App = Ready.pipe(Layer.provide(Serving));
Layer.launch(App).pipe(BunRuntime.runMain);
