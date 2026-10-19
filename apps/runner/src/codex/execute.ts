import { Effect } from "effect";
import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { Attempt } from "@personal-wiki/contracts/jobs";
import {
  profile,
  modelCatalog,
  admit,
  codexArguments,
  hash,
  failure,
  tokens,
  CodexError,
} from "./profile.ts";
import { privateDirectory, privateRead, durableWrite, subscriptionAuth } from "./files.ts";
import { sandboxCommand } from "./sandbox.ts";

export interface CodexInput {
  prompt: string;
  instructions: string;
  schema: string;
  related?: readonly string[];
}
export interface CodexRuntime {
  binary: string;
  binarySha256: string;
  python: string;
  guardian: string;
  slotDirectory: string;
  spool: string;
  authFile: string;
}
interface ExitManifest {
  version: 1;
  generation: string;
  attemptId: string;
  processStopped: true;
  exitCode: number | null;
  reason: string | null;
  outputDigest: string | null;
  outputBytes: number;
  inputDigest: string;
  profileDigest: string;
  completedAt: number;
  elapsedMs: number;
}
export interface CodexResult {
  manifest: ExitManifest;
  output: string | null;
  outcome: "output" | "auth" | "quota" | "failed";
}
const io = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof CodexError ? e : failure("storage")) });
export async function savedResult(
  directory: string,
  attempt: typeof Attempt.Type,
  inputDigest: string,
): Promise<CodexResult | null> {
  if (
    !(await access(join(directory, "exit.json")).then(
      () => true,
      () => false,
    ))
  )
    return null;
  const manifest = JSON.parse(await privateRead(join(directory, "exit.json"))) as ExitManifest;
  if (
    manifest.version !== 1 ||
    manifest.attemptId !== attempt.attemptId ||
    manifest.inputDigest !== inputDigest ||
    manifest.profileDigest !== hash(JSON.stringify(profile) + modelCatalog) ||
    manifest.processStopped !== true ||
    !Number.isFinite(manifest.completedAt) ||
    manifest.completedAt < Date.parse(attempt.authorizedAt)
  )
    throw failure("ownership");
  let output: string | null = null;
  if (manifest.outputDigest) {
    output = await privateRead(join(directory, "output.json"));
    if (
      hash(output) !== manifest.outputDigest ||
      Buffer.byteLength(output) !== manifest.outputBytes
    )
      throw failure("storage");
    if (tokens(output) > profile.maxOutputTokens) output = null;
  }
  // Provider messages stay in the private bounded spool; only explicit access
  // diagnostics classify a gate. Unclassified errors never trigger auto-retry.
  const diagnostic = await privateRead(join(directory, "diagnostic.log"), 8 * 1024 * 1024);
  const providerErrors = diagnostic
    .split("\n")
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        // Ignore assistant messages/tool data containing source-supplied phrases.
        if (event?.type === "error" && typeof event.message === "string") return [event.message];
        if (event?.type === "turn.failed" && typeof event.error?.message === "string")
          return [event.error.message];
      } catch {
        /* Non-event stderr cannot classify subscription gates. */
      }
      return [];
    })
    .join("\n");
  const outcome =
    manifest.reason === null && manifest.exitCode === 0 && output !== null
      ? "output"
      : /(?:not logged in|authentication required|invalid authentication|refresh token.*expired|401 unauthorized)/i.test(
            providerErrors,
          )
        ? "auth"
        : /(?:usage limit.*reached|quota.*exceeded|insufficient_quota)/i.test(providerErrors)
          ? "quota"
          : "failed";
  return { manifest, output: outcome === "output" ? output : null, outcome };
}

export function executeCodex<E, R>(options: {
  runtime: CodexRuntime;
  attempt: typeof Attempt.Type;
  input: CodexInput;
  heartbeat: () => Effect.Effect<unknown, E, R>;
}) {
  return Effect.gen(function* () {
    if (process.platform !== "linux") return yield* failure("configuration");
    const admitted = yield* Effect.try({
      try: () => admit(options.input),
      catch: (e) => (e instanceof CodexError ? e : failure("capacity")),
    });
    if (options.attempt.inputDigest !== admitted.inputDigest)
      return yield* failure("configuration");
    const runtime = options.runtime;
    const root = join(runtime.spool, options.attempt.jobId);
    const directory = join(root, options.attempt.attemptId);
    const prior = yield* io(() => savedResult(directory, options.attempt, admitted.inputDigest));
    if (prior) return prior;
    const prepared = yield* io(async () => {
      if (hash(await readFile(runtime.binary)) !== runtime.binarySha256)
        throw failure("configuration");
      for (const path of [runtime.slotDirectory, root, directory]) await privateDirectory(path);
      const workspace = join(directory, "work");
      const home = join(directory, "auth");
      await privateDirectory(workspace);
      await privateDirectory(home);
      const input = join(workspace, "input.txt");
      await durableWrite(input, options.input.prompt);
      await durableWrite(join(workspace, "models.json"), modelCatalog);
      await durableWrite(join(workspace, "instructions.md"), options.input.instructions);
      await durableWrite(join(workspace, "schema.json"), options.input.schema);
      await durableWrite(
        join(home, "auth.json"),
        subscriptionAuth(await privateRead(runtime.authFile)),
      );
      await durableWrite(
        join(directory, "profile.json"),
        JSON.stringify({ ...profile, ...admitted, binarySha256: runtime.binarySha256 }),
      );
      const argv = await sandboxCommand({
        binary: runtime.binary,
        workspace,
        codexHome: home,
        input,
        args: codexArguments(workspace, home),
      });
      const config = join(directory, "guard.json");
      await durableWrite(
        config,
        JSON.stringify({
          slotDirectory: runtime.slotDirectory,
          attemptDirectory: directory,
          workspace,
          jobRoot: root,
          attemptId: options.attempt.attemptId,
          profileDigest: admitted.profileDigest,
          inputDigest: admitted.inputDigest,
          deadline: Date.parse(options.attempt.deadline),
          inputFile: input,
          outputFile: join(workspace, "result.json"),
          argv,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: home,
            CODEX_HOME: home,
            TMPDIR: workspace,
            LANG: "en_US.UTF-8",
          },
        }),
      );
      return { config, home };
    });
    yield* options.heartbeat();
    const running = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const child = spawn(runtime.python, [runtime.guardian, prepared.config], { stdio: "pipe" });
        child.stdin.on("error", () => {});
        // Guardian stdout contains bounded status only. Its private child logs
        // never flow into CI/application logging.
        child.stdout.resume();
        child.stderr.resume();
        const finished = new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        return { child, finished };
      }),
      ({ child, finished }) =>
        Effect.promise(async () => {
          child.stdin.end();
          const timer = setTimeout(() => child.kill("SIGKILL"), 17000);
          try {
            await finished;
          } catch {
            /* Missing exit certificate keeps the slot blocked. */
          } finally {
            clearTimeout(timer);
          }
        }),
    );
    const renew = Effect.gen(function* () {
      while (true) {
        yield* options.heartbeat().pipe(Effect.timeout("10 seconds"));
        yield* Effect.sync(() => running.child.stdin.write(`heartbeat ${Date.now()}\n`));
        yield* Effect.sleep("5 seconds");
      }
    });
    const code = yield* io(() => running.finished).pipe(Effect.raceFirst(renew));
    if (code !== 0) return yield* failure("ownership");
    const result = yield* io(() => savedResult(directory, options.attempt, admitted.inputDigest));
    if (!result) return yield* failure("ownership");
    // Preserve refreshed subscription credentials only after process death.
    yield* io(async () =>
      durableWrite(
        runtime.authFile,
        subscriptionAuth(await privateRead(join(prepared.home, "auth.json"))),
        true,
      ),
    );
    return result;
  }).pipe(Effect.scoped);
}
