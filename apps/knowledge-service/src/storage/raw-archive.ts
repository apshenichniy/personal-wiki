import { S3Client } from "bun";
import { Context, Effect, Layer, Schema } from "effect";
import { digest } from "./io.ts";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export class ArchiveError extends Schema.TaggedError<ArchiveError>()("ArchiveError", {
  code: Schema.Literals(["unavailable", "invalid_request", "conflict"]),
  message: Schema.String,
}) {}
const error = (code: ArchiveError["code"], message: string) => new ArchiveError({ code, message });
const maxBytes = 16_777_216;
const keyPattern = /^providers\/(staging|production)\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.json$/;
export type ObjectIdentity = { key: string; sha256: string; byteLength: number };
type Sign = (key: string, method: "GET" | "PUT") => string;

/** URLs never escape this boundary, including errors. Production supplies the
 * Bun S3 signer; synthetic tests supply a loopback signer to exercise real HTTP. */
export const makeRawArchive = (sign: Sign) => {
  const validate = (object: ObjectIdentity) => {
    if (
      !keyPattern.test(object.key) ||
      !/^[a-f0-9]{64}$/.test(object.sha256) ||
      !Number.isSafeInteger(object.byteLength) ||
      object.byteLength < 1 ||
      object.byteLength > maxBytes
    )
      throw error("invalid_request", "Invalid raw object identity.");
  };
  const call = <A>(action: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: (signal) => action(AbortSignal.any([signal, AbortSignal.timeout(30_000)])),
      catch: (cause) =>
        cause instanceof ArchiveError
          ? cause
          : error("unavailable", "Private archive operation failed."),
    });
  const readBytes = async (object: ObjectIdentity, signal: AbortSignal) => {
    const response = await fetch(sign(object.key, "GET"), { signal, redirect: "error" });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw error("unavailable", "Retained object is unavailable.");
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > object.byteLength)
          throw error("conflict", "Retained object exceeds its reserved size.");
        parts.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = Buffer.concat(parts);
    if (size !== object.byteLength || digest(bytes) !== object.sha256)
      throw error("conflict", "Retained object checksum differs.");
    return bytes;
  };
  const read = (object: ObjectIdentity) =>
    call(async (signal) => {
      validate(object);
      return await readBytes(object, signal);
    });
  const retain = (object: ObjectIdentity, bytes: Uint8Array) =>
    call(async (signal) => {
      validate(object);
      if (bytes.length !== object.byteLength || digest(bytes) !== object.sha256)
        throw error("invalid_request", "Raw upload checksum differs.");
      // Conditional PUT is atomic in R2. A timed-out write may still commit: the
      // caller must keep the same key/checksum on retry, never allocate a new key.
      const response = await fetch(sign(object.key, "PUT"), {
        method: "PUT",
        signal,
        redirect: "error",
        body: Buffer.from(bytes),
        headers: { "if-none-match": "*", "content-type": "application/json" },
      });
      await response.body?.cancel();
      if (!response.ok && response.status !== 412)
        throw error("unavailable", "Raw archive write was not confirmed.");
      await readBytes(object, signal);
    });
  const assertPrivate = (object: ObjectIdentity) =>
    call(async (signal) => {
      validate(object);
      await readBytes(object, signal);
      const anonymous = new URL(sign(object.key, "GET"));
      anonymous.search = "";
      const response = await fetch(anonymous, { signal, redirect: "error" });
      // R2's S3 endpoint rejects unsigned requests with this specific XML error.
      // A generic 400/404/5xx is not evidence of an authentication boundary.
      let missingAuthorization = false;
      if (response.status === 400 && response.body) {
        const reader = response.body.getReader();
        let body = "";
        try {
          while (body.length < 4096) {
            const part = await reader.read();
            if (part.done) break;
            body += new TextDecoder().decode(part.value.slice(0, 4096));
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        missingAuthorization =
          body.length < 4096 &&
          /<Code>InvalidArgument<\/Code>/.test(body) &&
          /<Message>Authorization<\/Message>/.test(body);
      }
      await response.body?.cancel();
      if (![401, 403].includes(response.status) && !missingAuthorization)
        throw error("conflict", "Anonymous archive denial was not verified.");
    });
  return { read, retain, assertPrivate };
};
export const R2Configuration = Schema.Struct({
  endpoint: Schema.String,
  bucket: Schema.String,
  region: Schema.String,
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
});
export function r2Archive(config: typeof R2Configuration.Type) {
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    !/^[a-f0-9]{32}(\.eu)?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw error("invalid_request", "A private R2 S3 endpoint is required.");
  const client = new S3Client(config);
  return makeRawArchive((key, method) => client.presign(key, { method, expiresIn: 120 }));
}
export const loadR2Archive = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(path))
        throw error("invalid_request", "R2 configuration needs an absolute private path.");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16_384)
          throw error("invalid_request", "R2 configuration must be a private regular file.");
        return r2Archive(
          Schema.decodeUnknownSync(R2Configuration)(JSON.parse(await file.readFile("utf8"))),
        );
      } finally {
        await file.close();
      }
    },
    catch: () => error("unavailable", "Private R2 configuration could not be loaded."),
  });
export class RawArchive extends Context.Service<RawArchive, ReturnType<typeof makeRawArchive>>()(
  "personal-wiki/RawArchive",
) {
  static disabled = Layer.succeed(RawArchive, {
    read: () => Effect.fail(error("unavailable", "Private R2 archive is not configured.")),
    retain: () => Effect.fail(error("unavailable", "Private R2 archive is not configured.")),
    assertPrivate: () => Effect.fail(error("unavailable", "Private R2 archive is not configured.")),
  });
}
