import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { makeRawArchive, r2Archive } from "../apps/knowledge-service/src/storage/raw-archive.ts";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const key = `providers/staging/${crypto.randomUUID()}/${crypto.randomUUID()}.json`;
const bytes = Buffer.from('[{"id":"100","text":"Synthetic evidence"}]');
const object = { key, sha256: sha(bytes), byteLength: bytes.length };

test("conditional immutable writes survive lost readback, deny anonymous access and never overwrite", async () => {
  const objects = new Map<string, Uint8Array>();
  let writes = 0;
  let gets = 0;
  let breakRead = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.searchParams.get("signature") !== "synthetic")
        return new Response(null, { status: 403 });
      if (request.method === "PUT") {
        expect(request.headers.get("if-none-match")).toBe("*");
        if (objects.has(url.pathname)) return new Response(null, { status: 412 });
        objects.set(url.pathname, new Uint8Array(await request.arrayBuffer()));
        writes++;
        return new Response(null, { status: 200 });
      }
      gets++;
      if (breakRead) return new Response(null, { status: 503 });
      return new Response(Buffer.from(objects.get(url.pathname)!), { status: 200 });
    },
  });
  const archive = makeRawArchive((path) => `${server.url}${path}?signature=synthetic`);
  try {
    const lost = await Effect.runPromise(archive.retain(object, bytes).pipe(Effect.result));
    expect(lost).toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } });
    breakRead = false;
    await Effect.runPromise(archive.retain(object, bytes));
    await Effect.runPromise(archive.retain(object, bytes));
    expect(writes).toBe(1);
    expect(gets).toBe(3);
    await Effect.runPromise(archive.assertPrivate(object));
    expect(await Effect.runPromise(archive.read(object))).toEqual(bytes);
    const changed = Buffer.from("[{}]");
    const conflict = await Effect.runPromise(
      archive
        .retain({ ...object, sha256: sha(changed), byteLength: changed.length }, changed)
        .pipe(Effect.result),
    );
    expect(conflict).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } });
    expect(writes).toBe(1);
    expect(objects.get(`/${key}`)).toEqual(bytes);
  } finally {
    await server.stop(true);
  }
});

test("bounded readback rejects decoded over-return, corruption, public access, redirects and unsafe keys", async () => {
  let mode = "oversized";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (mode === "redirect")
        return new Response(null, { status: 302, headers: { location: "https://example.com" } });
      if (mode === "oversized")
        return new Response(Bun.gzipSync(Buffer.alloc(1000)), {
          headers: { "content-encoding": "gzip" },
        });
      if (mode === "corrupt") return new Response(Buffer.alloc(bytes.length));
      return new Response(bytes);
    },
  });
  const archive = makeRawArchive((path) => `${server.url}${path}?signature=synthetic`);
  try {
    for (mode of ["oversized", "corrupt"])
      expect(await Effect.runPromise(archive.read(object).pipe(Effect.result))).toMatchObject({
        _tag: "Failure",
        failure: { code: "conflict" },
      });
    mode = "public";
    expect(
      await Effect.runPromise(archive.assertPrivate(object).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } });
    mode = "redirect";
    const result = await Effect.runPromise(archive.read(object).pipe(Effect.result));
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("signature");
    expect(
      await Effect.runPromise(archive.read({ ...object, key: "../../secret" }).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } });
  } finally {
    await server.stop(true);
  }
});

test("R2 signer restricts credentials to an HTTPS R2 endpoint", () => {
  for (const endpoint of [
    "http://localhost",
    "https://example.com",
    "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/wrong",
  ])
    expect(() =>
      r2Archive({
        endpoint,
        bucket: "synthetic",
        region: "auto",
        accessKeyId: "synthetic",
        secretAccessKey: "synthetic",
      }),
    ).toThrow();
});
