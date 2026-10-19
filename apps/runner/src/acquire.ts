import { BunRuntime } from "@effect/platform-bun";
import { Cause, Config, Console, Effect, Redacted, Schema } from "effect";
import { constants } from "node:fs";
import { open, mkdir, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { makeJobClient } from "@personal-wiki/client";
import { ingestX } from "./apify/ingest.ts";
import { makeApifyHttp } from "./apify/http.ts";
import { makeProviderRecovery } from "./apify/recovery.ts";

const Configuration = Schema.Struct({
  serviceUrl: Schema.String,
  runnerTokenFile: Schema.String,
  apifyTokenFile: Schema.String,
  spool: Schema.String,
});
class RunnerConfigurationError extends Schema.TaggedError<RunnerConfigurationError>()(
  "RunnerConfigurationError",
  {
    code: Schema.Literal("configuration"),
    message: Schema.String,
  },
) {}
const configurationError = () =>
  new RunnerConfigurationError({
    code: "configuration",
    message: "Private Runner configuration is unavailable.",
  });
const privateText = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(path)) throw configurationError();
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16_384) throw configurationError();
        return await file.readFile("utf8");
      } finally {
        await file.close();
      }
    },
    catch: configurationError,
  });

export const acquireOnce = Effect.gen(function* () {
  const configPath = yield* Config.String("WIKI_RUNNER_CONFIG_FILE");
  const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration))(
    yield* privateText(configPath),
  );
  const url = new URL(config.serviceUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
    !isAbsolute(config.spool)
  )
    return yield* Effect.die("Invalid private Runner transport configuration");
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(config.spool, { recursive: true, mode: 0o700 });
      const stat = await lstat(config.spool);
      if (!stat.isDirectory() || stat.mode & 0o077) throw configurationError();
    },
    catch: configurationError,
  });
  const client = yield* makeJobClient(
    config.serviceUrl,
    (yield* privateText(config.runnerTokenFile)).trim(),
  );
  const http = makeApifyHttp(Redacted.make((yield* privateText(config.apifyTokenFile)).trim()));
  const recover = makeProviderRecovery({ client, http, spool: config.spool });
  const recovery = yield* recover();
  if (recovery.unresolved) return { status: "blocked", ...recovery };
  const instanceId = randomUUID();
  const claim = yield* client.worker.claim({ payload: { requestId: randomUUID(), instanceId } });
  if (!claim) return { status: "idle", ...recovery };
  const heartbeat = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("5 seconds");
      yield* client.worker.heartbeat({ payload: { requestId: randomUUID(), scope: claim.scope } });
    }
  });
  const job = yield* ingestX({ client, http, spool: config.spool, claim }).pipe(
    Effect.raceFirst(heartbeat),
  );
  // Cost/evidence obligations remain recoverable independently of whether the
  // job is prepared, failed, expired or cancelled. No curation is launched here.
  const remaining = yield* recover();
  return {
    status: job.stage,
    jobId: job.jobId,
    warnings: job.warnings.length,
    ...remaining,
  };
});

if (import.meta.main)
  acquireOnce
    .pipe(
      Effect.flatMap((result) => Console.log(JSON.stringify(result))),
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "acquisition_failed";
        return Console.log(JSON.stringify({ status: "failed", code })).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        );
      }),
      Effect.scoped,
    )
    .pipe(BunRuntime.runMain);
