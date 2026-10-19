// Release readiness probe: synthetic fixed bytes, exact namespace, no provider call.
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { loadR2Archive } from "../apps/knowledge-service/src/storage/raw-archive.ts";
const path = process.argv[2];
const namespace = process.argv[3];
if (!path || !["staging", "production"].includes(namespace ?? "")) process.exit(1);
const bytes = Buffer.from('{"kind":"personal-wiki-release-readiness","version":1}\n');
const object = {
  key: `providers/${namespace}/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000001.json`,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  byteLength: bytes.length,
};
await Effect.runPromise(
  Effect.gen(function* () {
    const archive = yield* loadR2Archive(path);
    yield* archive.retain(object, bytes);
    yield* archive.assertPrivate(object);
  }).pipe(
    Effect.catchCause(() =>
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  ),
);
