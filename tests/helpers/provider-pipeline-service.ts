// Synthetic archive transport is dependency injection in this test executable,
// never an environment-controlled bypass in the production Service artifact.
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { Routes, StorageWrites } from "../../apps/knowledge-service/src/http.ts";
import { Authentication, WorkflowRoutes } from "../../apps/knowledge-service/src/jobs/http.ts";
import { jobRuntime } from "../../apps/knowledge-service/src/jobs/runtime.ts";
import { makeRawArchive } from "../../apps/knowledge-service/src/storage/raw-archive.ts";
import { JobError } from "../../apps/knowledge-service/src/jobs/policy.ts";
import { Server, Ready, BunRuntime } from "../../apps/knowledge-service/src/server.ts";
const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const root = yield* Config.String("WIKI_DATA_DIR");
    const path = yield* Config.String("WIKI_PROVIDER_LEDGER_FILE");
    const origin = yield* Config.String("WIKI_TEST_ARCHIVE_ORIGIN");
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
      return yield* Effect.die("Synthetic archive must be loopback");
    return jobRuntime(root, {
      path,
      namespace: "staging",
      archive: makeRawArchive((key) => `${origin}/${key}`),
    });
  }),
);
const serving = HttpRouter.serve(
  Layer.mergeAll(Routes, WorkflowRoutes, Authentication).pipe(
    Layer.provide(
      Layer.succeed(StorageWrites, {
        authorize: Effect.fail(new JobError({ code: "forbidden", message: "Use job API" })),
      }),
    ),
    Layer.provideMerge(runtime),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(Server));
Layer.launch(Ready.pipe(Layer.provide(serving))).pipe(BunRuntime.runMain);
