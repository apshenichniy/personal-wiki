import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  decodeRun,
  type ApifyRun,
  type RawResponse,
  type StartRequest,
  type makeApifyHttp,
} from "./http.ts";

const Identity = Schema.Struct({
  operationId: Schema.String.check(Schema.isUUID()),
  inputDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  actorId: Schema.String,
  buildId: Schema.String,
});
export type DispatchIdentity = typeof Identity.Type;
export type StartReceipt = { raw: RawResponse; run: ApifyRun };
export class DispatchError extends Schema.TaggedError<DispatchError>()("DispatchError", {
  code: Schema.Literals(["storage", "identity_conflict", "start_unknown"]),
  message: Schema.String,
}) {}
const failure = (code: DispatchError["code"]) =>
  new DispatchError({ code, message: `Provider dispatch: ${code}.` });
const io = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => (cause instanceof DispatchError ? cause : failure("storage")),
  });
const missing = (e: unknown) =>
  e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT";
const exists = (e: unknown) =>
  e !== null && typeof e === "object" && "code" in e && e.code === "EEXIST";

async function syncDirectory(root: string) {
  const directory = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function readPrivate(path: string): Promise<Uint8Array | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((e: unknown) => {
    if (missing(e)) return null;
    throw e;
  });
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1_048_576)
      throw failure("storage");
    return new Uint8Array(await file.readFile());
  } finally {
    await file.close();
  }
}
async function createPrivate(root: string, path: string, bytes: Uint8Array) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  ).catch((e: unknown) => {
    if (exists(e)) return null;
    throw e;
  });
  if (!file) return false;
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(root);
  return true;
}

/** Recovery never creates an intent or asks for a fresh permit. A complete
 * durable receipt is positive evidence even after the original lease expired. */
export const retainedDispatch = (root: string, identity: DispatchIdentity) =>
  io(async () => {
    const canonical = JSON.stringify({
      operationId: identity.operationId,
      inputDigest: identity.inputDigest,
      actorId: identity.actorId,
      buildId: identity.buildId,
    });
    const intent = await readPrivate(join(root, `${identity.operationId}.intent.json`));
    const bytes = await readPrivate(join(root, `${identity.operationId}.response.json`));
    if (!bytes) return null;
    if (!intent || new TextDecoder().decode(intent) !== canonical)
      throw failure("identity_conflict");
    const raw: RawResponse = {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      json: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      headers: new Headers(),
    };
    const run = decodeRun(raw, true);
    if (run.actId !== identity.actorId || run.buildId !== identity.buildId)
      throw failure("identity_conflict");
    return { raw, run };
  });

/** Local intent precedes the Service's one-use permit. A surviving intent without
 * a receipt is unresolved unless the Service proves its permit is still unissued.
 * A receipt is fsynced before Service acknowledgment and can be adopted without
 * another permit or POST. The Service still owns fencing, budgets and run IDs. */
export const dispatchOnce = <E, R>(options: {
  root: string;
  identity: DispatchIdentity;
  client: ReturnType<typeof makeApifyHttp>;
  permit: Effect.Effect<StartRequest, E, R>;
  accept: (receipt: StartReceipt) => Effect.Effect<void, E, R>;
  uncertain: Effect.Effect<void, E, R>;
  resumeUnissuedPermit?: boolean;
}) =>
  Effect.gen(function* () {
    const identity = yield* Schema.decodeUnknownEffect(Identity)(options.identity);
    const canonical = JSON.stringify({
      operationId: identity.operationId,
      inputDigest: identity.inputDigest,
      actorId: identity.actorId,
      buildId: identity.buildId,
    });
    const intentPath = join(options.root, `${identity.operationId}.intent.json`);
    const receiptPath = join(options.root, `${identity.operationId}.response.json`);
    const created = yield* io(async () => {
      await mkdir(options.root, { mode: 0o700 }).catch((e: unknown) => {
        if (!exists(e)) throw e;
      });
      const stat = await lstat(options.root);
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw failure("storage");
      await syncDirectory(join(options.root, ".."));
      const created = await createPrivate(
        options.root,
        intentPath,
        new TextEncoder().encode(canonical),
      );
      if (!created) {
        const previous = await readPrivate(intentPath);
        if (!previous || new TextDecoder().decode(previous) !== canonical)
          throw failure("identity_conflict");
      }
      return created;
    });
    const validate = (receipt: StartReceipt) => {
      if (receipt.run.actId !== identity.actorId || receipt.run.buildId !== identity.buildId)
        throw failure("identity_conflict");
      return receipt;
    };
    if (!created) {
      const retained = yield* io(async () => {
        const bytes = await readPrivate(receiptPath);
        if (!bytes) {
          if (options.resumeUnissuedPermit) return null;
          throw failure("start_unknown");
        }
        const raw: RawResponse = {
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          json: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          headers: new Headers(),
        };
        return validate({ raw, run: decodeRun(raw, true) });
      });
      if (retained) {
        yield* options.accept(retained);
        return retained;
      }
    }
    return yield* Effect.gen(function* () {
      const input = yield* options.permit;
      if (input.actorId !== identity.actorId || input.buildId !== identity.buildId)
        return yield* failure("identity_conflict");
      const receipt = yield* options.client.start(input);
      yield* io(async () => {
        validate(receipt);
        if (!(await createPrivate(options.root, receiptPath, receipt.raw.bytes)))
          throw failure("identity_conflict");
      });
      yield* options.accept(receipt);
      return receipt;
      // Failure to notify the Service cannot remove either durable intent; its
      // dispatching state remains blocking until reconciliation succeeds.
    }).pipe(Effect.onError(() => options.uncertain.pipe(Effect.ignore)));
  });
