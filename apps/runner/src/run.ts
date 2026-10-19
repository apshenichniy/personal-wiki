import { BunRuntime } from "@effect/platform-bun";
import { Cause, Config, Console, Effect, Redacted, Schema } from "effect";
import { fstatSync } from "node:fs";
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeJobClient } from "@personal-wiki/client";
import { makeApifyHttp } from "./apify/http.ts";
import { makePipeline } from "./pipeline.ts";
import { privateRead, privateDirectory } from "./codex/files.ts";
import { failure } from "./codex/profile.ts";

const Configuration = Schema.Struct({
  serviceUrl: Schema.String,
  runnerTokenFile: Schema.String,
  apifyTokenFile: Schema.String,
  spool: Schema.String,
  skillFile: Schema.String,
  codex: Schema.Struct({
    binary: Schema.String,
    binarySha256: Schema.String,
    python: Schema.String,
    guardian: Schema.String,
    slotDirectory: Schema.String,
    spool: Schema.String,
    authFile: Schema.String,
  }),
});
export const run = Effect.gen(function* () {
  const path = yield* Config.String("WIKI_RUNNER_CONFIG_FILE");
  const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration))(
    yield* Effect.tryPromise(() => privateRead(path, 16384)),
  );
  yield* Effect.tryPromise({
    try: async () => {
      const url = new URL(config.serviceUrl);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
      )
        throw failure("configuration");
      for (const path of [
        config.runnerTokenFile,
        config.apifyTokenFile,
        config.spool,
        config.skillFile,
        ...Object.entries(config.codex)
          .filter(([k]) => k !== "binarySha256")
          .map(([, v]) => v),
      ])
        if (!isAbsolute(path)) throw failure("configuration");
      if (
        process.platform !== "linux" ||
        process.env.WIKI_AGENT_SLOT !== config.codex.slotDirectory
      )
        throw failure("configuration");
      const fd = Number(process.env.WIKI_SUPERVISOR_LOCK_FD);
      if (!Number.isInteger(fd) || fd < 3) throw failure("ownership");
      const held = fstatSync(fd),
        file = await lstat(join(config.codex.slotDirectory, "supervisor.lock"));
      const info = await readFile(`/proc/self/fdinfo/${fd}`, "utf8");
      if (held.ino !== file.ino || held.dev !== file.dev || !/lock:.*FLOCK.*WRITE/.test(info))
        throw failure("ownership");
      await privateDirectory(config.spool);
      await privateDirectory(config.codex.spool);
    },
    catch: () => failure("configuration"),
  });
  const client = yield* makeJobClient(
    config.serviceUrl,
    (yield* Effect.tryPromise(() => privateRead(config.runnerTokenFile, 16384))).trim(),
  );
  const http = makeApifyHttp(
    Redacted.make(
      (yield* Effect.tryPromise(() => privateRead(config.apifyTokenFile, 16384))).trim(),
    ),
  );
  const tick = makePipeline({
    client,
    http,
    spool: config.spool,
    runtime: config.codex,
    skillFile: config.skillFile,
    instanceId: randomUUID(),
  });
  let last = "";
  while (true) {
    const result = yield* tick().pipe(Effect.result);
    const event = result._tag === "Success" ? result.success : { status: "unavailable" };
    const line = JSON.stringify(event);
    if (line !== last) {
      yield* Console.log(line);
      last = line;
    }
    // Service journals and physical process recovery decide whether work may
    // continue. A transport error never authorizes a blind replacement launch.
    yield* Effect.sleep(
      result._tag === "Failure" || event.status === "blocked" ? "5 seconds" : "1 second",
    );
  }
});
if (import.meta.main)
  run.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return Console.error(
        JSON.stringify({
          status: "startup_failed",
          code:
            typeof error === "object" && error !== null && "code" in error
              ? error.code
              : "configuration",
        }),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      );
    }),
    Effect.scoped,
    BunRuntime.runMain,
  );
