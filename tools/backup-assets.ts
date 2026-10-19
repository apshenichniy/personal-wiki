// Offline cut only. Called by the root-owned backup service, never by Runner.
import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { Asset } from "@personal-wiki/contracts/knowledge";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import {
  loadR2Archive,
  type ObjectIdentity,
} from "../apps/knowledge-service/src/storage/raw-archive.ts";
import { digest } from "../apps/knowledge-service/src/storage/io.ts";
const root = process.argv[2];
if (!root || !isAbsolute(root)) process.exit(1);
const program = Effect.gen(function* () {
  const objects = new Map<string, ObjectIdentity>();
  const destination = join(root, "originals");
  yield* Effect.promise(() => mkdir(destination, { recursive: true, mode: 0o700 }));
  const add = (value: ObjectIdentity) => {
    const prior = objects.get(value.key);
    if (prior && (prior.sha256 !== value.sha256 || prior.byteLength !== value.byteLength))
      throw new Error("Conflicting object identity");
    objects.set(value.key, value);
  };
  for (const namespace of ["staging", "production"]) {
    const path = join(root, "libraries", namespace, "library.sqlite");
    if (!(yield* Effect.promise(() => Bun.file(path).exists()))) continue;
    const db = new Database(path, { readonly: true });
    try {
      for (const row of db.query<{ payload: string }, []>("SELECT payload FROM assets").all()) {
        const asset = yield* Schema.decodeEffect(Schema.fromJsonString(Asset))(row.payload);
        if (asset.objectKey.startsWith("providers/"))
          add({ key: asset.objectKey, sha256: asset.sha256, byteLength: asset.byteLength });
        else {
          if (asset.objectKey !== `objects/${asset.assetId}`)
            throw new Error("Unsupported retained object");
          const bytes = yield* Effect.promise(() =>
            readFile(join(root, "libraries", namespace, "objects", asset.assetId)),
          );
          if (bytes.length !== asset.byteLength || digest(bytes) !== asset.sha256)
            throw new Error("Retained local object differs");
          yield* Effect.promise(() =>
            writeFile(join(destination, asset.sha256), bytes, { mode: 0o600 }),
          );
          add({
            key: `local/${namespace}/${asset.assetId}`,
            sha256: asset.sha256,
            byteLength: asset.byteLength,
          });
        }
      }
    } finally {
      db.close();
    }
  }
  const accounting = new Database(join(root, "accounting/provider-accounting.sqlite"), {
    readonly: true,
  });
  try {
    for (const table of ["provider_pages", "provider_page_intents"]) {
      for (const row of accounting
        .query<{ record: string; operation: string }, []>(
          `SELECT p.record, o.record AS operation FROM ${table} p JOIN provider_operations o ON o.operation_id=p.operation_id`,
        )
        .all()) {
        const page = JSON.parse(row.record),
          operation = JSON.parse(row.operation);
        // An intent may have been retained before its SQL acknowledgement. Its
        // bytes are required; an absent object blocks a complete recovery point.
        add({
          key: `providers/${operation.job.namespace}/${page.operationId}/${page.assetId}.json`,
          sha256: page.sha256,
          byteLength: page.byteLength,
        });
      }
    }
  } finally {
    accounting.close();
  }

  for (const namespace of ["staging", "production"]) {
    const selected = [...objects.values()].filter((o) =>
      o.key.startsWith(`providers/${namespace}/`),
    );
    if (!selected.length) continue;
    const archive = yield* loadR2Archive(join(root, "configuration/deploy", namespace, "r2.json"));
    for (const object of selected) {
      const bytes = yield* archive.read(object);
      yield* Effect.promise(async () => {
        const path = join(destination, object.sha256);
        await writeFile(path, bytes, { mode: 0o600 });
        if (digest(await readFile(path)) !== object.sha256)
          throw new Error("Recovery readback failed");
      });
    }
  }
  yield* Effect.promise(() =>
    writeFile(join(root, "originals.json"), JSON.stringify([...objects.values()]), { mode: 0o600 }),
  );
});
await Effect.runPromise(
  program.pipe(
    Effect.catchCause(() =>
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  ),
);
