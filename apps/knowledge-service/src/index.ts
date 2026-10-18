import { isAbsolute } from "node:path";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { Routes, StorageWrites } from "./http.ts";
import { Authentication, WorkflowRoutes } from "./jobs/http.ts";
import { JobError } from "./jobs/policy.ts";
import { jobRuntime } from "./jobs/runtime.ts";
import { Server, Ready, BunRuntime } from "./server.ts";
const Runtime = Layer.unwrap(
  Effect.flatMap(Config.String("WIKI_DATA_DIR"), (root) =>
    isAbsolute(root)
      ? Effect.succeed(jobRuntime(root))
      : Effect.die("WIKI_DATA_DIR must be an absolute private path"),
  ),
);
const Serving = HttpRouter.serve(
  Layer.mergeAll(Routes, WorkflowRoutes, Authentication).pipe(
    Layer.provide(
      Layer.succeed(StorageWrites, {
        authorize: Effect.fail(
          new JobError({ code: "forbidden", message: "Use the fenced job protocol." }),
        ),
      }),
    ),
    Layer.provideMerge(Runtime),
  ),
  {
    disableListenLog: true,
    disableLogger: true,
  },
).pipe(Layer.provideMerge(Server));
Layer.launch(Ready.pipe(Layer.provide(Serving))).pipe(BunRuntime.runMain);
