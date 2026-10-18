// Focused storage protocol harness. Never imported by the production entry point.
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { Library } from "../../apps/knowledge-service/src/storage/library.ts";
import { Routes, StorageWrites } from "../../apps/knowledge-service/src/http.ts";
import { Server, Ready, BunRuntime } from "../../apps/knowledge-service/src/server.ts";
const LibraryLive = Layer.unwrap(Effect.map(Config.String("WIKI_DATA_DIR"), Library.layer));
const Serving = HttpRouter.serve(
  Routes.pipe(
    Layer.provide(Layer.succeed(StorageWrites, { authorize: Effect.void })),
    Layer.provide(LibraryLive),
  ),
  {
    disableListenLog: true,
    disableLogger: true,
  },
).pipe(Layer.provideMerge(Server));
Layer.launch(Ready.pipe(Layer.provide(Serving))).pipe(BunRuntime.runMain);
