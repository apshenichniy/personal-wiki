import { isAbsolute, relative } from "node:path";
import { Config, Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/http";
import { Routes, StorageWrites } from "./http.ts";
import { Authentication, WorkflowRoutes } from "./jobs/http.ts";
import { JobError } from "./jobs/policy.ts";
import { jobRuntime } from "./jobs/runtime.ts";
import { recoveryArchive } from "./storage/recovery-archive.ts";
import { loadR2Archive } from "./storage/raw-archive.ts";
import { Server, Ready, BunRuntime } from "./server.ts";
import { OwnerServer } from "./access/server.ts";
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
    const recoveryPath = yield* Config.String("WIKI_RECOVERY_ARCHIVE_DIR").pipe(Config.option);
    const archivePath = yield* Config.String("WIKI_R2_CREDENTIALS_FILE").pipe(Config.option);
    if (Option.isSome(recoveryPath) === Option.isSome(archivePath))
      return yield* Effect.die("Configure exactly one primary or recovery archive");
    const archive = Option.isSome(recoveryPath)
      ? recoveryArchive(recoveryPath.value)
      : yield* loadR2Archive(Option.getOrThrow(archivePath));
    return jobRuntime(root, { path: providerPath.value, namespace, archive });
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
  ),
  {
    disableListenLog: true,
    disableLogger: true,
  },
).pipe(Layer.provideMerge(Server));
Layer.launch(
  Layer.mergeAll(Ready.pipe(Layer.provide(Serving)), OwnerServer).pipe(Layer.provide(Runtime)),
).pipe(BunRuntime.runMain);
