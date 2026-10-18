import { isAbsolute, relative } from "node:path";
import { Config, Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/http";
import { Routes, StorageWrites } from "./http.ts";
import { Authentication, WorkflowRoutes } from "./jobs/http.ts";
import { JobError } from "./jobs/policy.ts";
import { jobRuntime } from "./jobs/runtime.ts";
import { Server, Ready, BunRuntime } from "./server.ts";
const Runtime = Layer.unwrap(
  Effect.gen(function* () {
    const root = yield* Config.String("WIKI_DATA_DIR");
    if (!isAbsolute(root))
      return yield* Effect.die("WIKI_DATA_DIR must be an absolute private path");
    const providerPath = yield* Config.String("WIKI_PROVIDER_LEDGER_FILE").pipe(Config.option);
    if (Option.isNone(providerPath)) return jobRuntime(root);
    const namespace = yield* Config.Literals(["staging", "production"], "WIKI_NAMESPACE");
    const relativePath = relative(root, providerPath.value);
    if (
      !isAbsolute(providerPath.value) ||
      !(relativePath === ".." || relativePath.startsWith("../"))
    )
      return yield* Effect.die(
        "Shared provider accounting must live outside the namespace library",
      );
    return jobRuntime(root, { path: providerPath.value, namespace });
  }),
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
