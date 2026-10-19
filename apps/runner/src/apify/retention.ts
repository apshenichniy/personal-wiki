import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Clock, Effect, Schedule, Schema } from "effect";
import type { makeJobClient } from "@personal-wiki/client";
import { ProviderRawUpload } from "@personal-wiki/contracts/provider-api";
import * as P from "@personal-wiki/contracts/provider";
import type { makeApifyHttp, RawResponse } from "./http.ts";

export class RetentionError extends Schema.TaggedError<RetentionError>()("RetentionError", {
  code: Schema.Literals(["storage", "capacity", "conflict", "not_terminal"]),
  message: Schema.String,
}) {}
const fail = (code: RetentionError["code"]) =>
  new RetentionError({ code, message: `Raw retention: ${code}.` });
const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof RetentionError ? error : fail("storage")),
  });
const isCode = (error: unknown, code: string) =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Upload = typeof ProviderRawUpload.Type;

const RetentionDebt = Schema.Struct({
  reason: Schema.Literals(["capacity", "retryable"]),
  retryAt: Schema.NullOr(P.Millis),
});
/** Terminal evidence debt must not monopolize the Runner or suppress billing
 * reconciliation. Keep conservative Service liability and throttle local reads.
 * Capacity needs operator intervention; changing the byte limit is not a retry. */
export const recoverProviderDebt = <E, R>(
  root: string,
  operation: P.Operation,
  kind: "retention" | "accounting",
  retain: Effect.Effect<P.Operation, E, R>,
  now: number,
) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(P.Operation.fields.operationId)(operation.operationId);
    const path = join(root, `${operation.operationId}.${kind}-debt.json`);
    const old = yield* io(async () => {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        (error: unknown) => {
          if (isCode(error, "ENOENT")) return null;
          throw error;
        },
      );
      if (!file) return null;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > 4096) throw fail("storage");
        return Schema.decodeUnknownSync(Schema.fromJsonString(RetentionDebt))(
          await file.readFile("utf8"),
        );
      } finally {
        await file.close();
      }
    });
    if (old && (old.retryAt === null || now < old.retryAt)) return { operation, deferred: true };
    const attemptedAt = yield* Clock.currentTimeMillis;
    const result = yield* retain.pipe(Effect.result);
    if (result._tag === "Success") return { operation: result.success, deferred: false };
    const elapsed = Math.max(0, (yield* Clock.currentTimeMillis) - attemptedAt);
    const capacity = kind === "retention" && isCode(result.failure, "capacity");
    yield* io(async () => {
      const directory = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await directory.stat();
      if (!stat.isDirectory() || stat.mode & 0o077) {
        await directory.close();
        throw fail("storage");
      }
      const temp = join(root, `.${randomUUID()}.debt-pending`);
      try {
        const file = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(
            JSON.stringify({
              reason: capacity ? "capacity" : "retryable",
              retryAt: capacity ? null : now + elapsed + 60_000,
            }),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temp, path);
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    return { operation, deferred: true };
  });

/** Fsync exact response bytes before sending the Service a write intent. Terminal
 * run metadata (including costs) can change, so a failed upload must replay the
 * saved bytes instead of downloading a different response under the same key. */
export function rawSpool(root: string) {
  const path = (id: string, name: string) => {
    if (!Schema.is(P.Operation.fields.operationId)(id) || !/^(run|dataset-\d+|report)$/.test(name))
      throw fail("storage");
    return join(root, `${id}.${name}.raw.json`);
  };
  const read = async (id: string, name: string): Promise<Upload | null> => {
    const file = await open(path(id, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: unknown) => {
        if (isCode(error, "ENOENT")) return null;
        throw error;
      },
    );
    if (!file) return null;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 22_371_000) throw fail("storage");
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      const input = Schema.decodeUnknownSync(ProviderRawUpload)(value);
      const bytes = Buffer.from(input.base64, "base64");
      const expected = input.kind === "dataset" ? `dataset-${input.offset}` : input.kind;
      if (
        input.operationId !== id ||
        expected !== name ||
        bytes.length > 16_777_216 ||
        bytes.toString("base64") !== input.base64 ||
        sha(bytes) !== input.sha256
      )
        throw fail("conflict");
      return input;
    } finally {
      await file.close();
    }
  };
  const load = (id: string, name: string) => io(() => read(id, name));
  const save = (input: Upload) =>
    io(async () => {
      const name = input.kind === "dataset" ? `dataset-${input.offset}` : input.kind;
      await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
        if (!isCode(error, "EEXIST")) throw error;
      });
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.mode & 0o077) throw fail("storage");
      const directory = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
      const parent = await open(join(root, ".."), constants.O_RDONLY | constants.O_NOFOLLOW);
      const target = path(input.operationId, name);
      const temp = join(root, `.${randomUUID()}.pending`);
      try {
        await parent.sync();
        const file = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(JSON.stringify(input));
          await file.sync();
        } finally {
          await file.close();
        }
        await link(temp, target).catch((error: unknown) => {
          if (!isCode(error, "EEXIST")) throw error;
        });
        await directory.sync();
        const retained = await read(input.operationId, name);
        if (!retained || retained.sha256 !== input.sha256 || retained.total !== input.total)
          throw fail("conflict");
        return retained;
      } finally {
        await unlink(temp).catch((error: unknown) => {
          if (!isCode(error, "ENOENT")) throw error;
        });
        await directory.sync();
        await directory.close();
        await parent.close();
      }
    });
  return { load, save };
}
export function makeRetention(options: {
  client: Effect.Success<ReturnType<typeof makeJobClient>>;
  http: ReturnType<typeof makeApifyHttp>;
  spool: string;
}) {
  const api = options.client.providers;
  const journal = rawSpool(options.spool);
  const inputFor = (
    operationId: string,
    kind: Upload["kind"],
    raw: RawResponse,
    offset = 0,
    total = 0,
  ): Upload => ({
    operationId,
    kind,
    offset,
    total,
    sha256: raw.sha256,
    base64: Buffer.from(raw.bytes).toString("base64"),
  });
  return Effect.fn("Acquisition.retainKnownResult")(function* (
    operation: P.Operation,
    deadline: number,
  ) {
    if (!operation.run || !P.terminal(operation.status)) return yield* fail("not_terminal");
    const id = operation.operationId;
    let pages = yield* api.pages({ payload: { operationId: id } });
    if (!pages.some((page) => page.pageKey === "run")) {
      const saved = yield* journal.load(id, "run");
      const input =
        saved ??
        (yield* journal.save(
          inputFor(id, "run", (yield* options.http.status(operation.run.runId, deadline)).raw),
        ));
      yield* api.retain({ payload: input });
    }
    // Charge all operations belonging to the job against the same decoded-byte
    // allowance. The Service independently reserves pending writes before R2 I/O.
    const inspection = yield* api.inspect({ payload: { jobId: operation.job.jobId } });
    let bytes = 0;
    for (const op of inspection.operations) {
      const retained = yield* api.pages({ payload: { operationId: op.operationId } });
      bytes += retained.reduce((sum, page) => sum + page.byteLength, 0);
      if (op.operationId === id) pages = retained;
    }
    let offset = 0;
    let total: number | undefined;
    do {
      const existing = pages.find(
        (page) => page.pageKey.startsWith("dataset:") && page.offset === offset,
      );
      if (existing) {
        total = Number(existing.pageKey.split(":")[2]);
        offset += existing.itemCount;
      } else {
        if (bytes >= 67_108_864) return yield* fail("capacity");
        let input = yield* journal.load(id, `dataset-${offset}`);
        if (!input) {
          const response = yield* options.http
            .page(operation.run.datasetId, offset, 100, 67_108_864 - bytes, deadline)
            .pipe(
              Effect.retry({
                times: 5,
                schedule: Schedule.exponential("500 millis"),
                while: (error) => error.code === "protocol" && Date.now() < deadline,
              }),
            );
          input = yield* journal.save(
            inputFor(id, "dataset", response.raw, offset, response.total),
          );
        }
        const retained = yield* api.retain({ payload: input });
        bytes += retained.byteLength;
        total = input.total;
        offset += retained.itemCount;
      }
    } while (offset < total);
    if (!pages.some((page) => page.pageKey === "report")) {
      if (bytes >= 67_108_864) return yield* fail("capacity");
      const saved = yield* journal.load(id, "report");
      const report = saved
        ? null
        : yield* options.http
            .report(operation.run.keyValueStoreId, 67_108_864 - bytes, deadline)
            .pipe(
              Effect.catchTag("ApifyTransportError", (error) =>
                error.code === "http" && error.status === 404
                  ? Effect.succeed(null)
                  : Effect.fail(error),
              ),
            );
      const input = saved ?? (report ? yield* journal.save(inputFor(id, "report", report)) : null);
      if (input) yield* api.retain({ payload: input });
    }
    return yield* api.archive({ payload: { operationId: id } });
  });
}
