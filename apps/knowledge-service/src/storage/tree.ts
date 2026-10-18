import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { Snapshot } from "@personal-wiki/contracts/knowledge";
import { git, io, prepareDirectory, stable, LibraryError } from "./io.ts";

export const canonicalRef = "refs/heads/knowledge";
export const readTree = Effect.fn("Knowledge.readTree")(function* (root: string, revision: string) {
  const snapshot = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot))(
    yield* git(root, ["show", `${revision}:.wiki/library.json`]),
  );
  for (const note of snapshot.notes) {
    const content = yield* git(root, ["show", `${revision}:${note.path}`], { raw: true });
    if (content !== note.markdown)
      return yield* Effect.fail(
        new LibraryError({ code: "unavailable", message: "Canonical note and manifest differ." }),
      );
  }
  return snapshot;
});
export const createCommit = Effect.fn("Knowledge.createCommit")(function* (
  root: string,
  snapshot: Snapshot,
  base: string | null,
  manifest: { publicationId?: string; [key: string]: unknown },
  timestamp: string,
) {
  const temporary = join(root, `prepare-${randomUUID()}`);
  yield* io(() => prepareDirectory(temporary));
  const env = {
    GIT_INDEX_FILE: join(temporary, "index"),
    GIT_WORK_TREE: temporary,
    GIT_AUTHOR_NAME: "Personal Wiki",
    GIT_AUTHOR_EMAIL: "wiki@localhost",
    GIT_COMMITTER_NAME: "Personal Wiki",
    GIT_COMMITTER_EMAIL: "wiki@localhost",
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  };
  return yield* Effect.gen(function* () {
    if (base) yield* git(root, ["read-tree", base], { env });
    else yield* git(root, ["read-tree", "--empty"], { env });
    const old = base ? yield* readTree(root, base) : null;
    for (const note of old?.notes ?? [])
      if (!snapshot.notes.some((n) => n.path === note.path))
        yield* git(root, ["update-index", "--force-remove", "--", note.path], { env });
    const files = new Map(snapshot.notes.map((note) => [note.path, note.markdown]));
    files.set(".wiki/library.json", stable(snapshot));
    files.set(
      `.wiki/publications/${snapshot.notes.length === 0 && base === null ? "genesis" : manifest.publicationId}.json`,
      stable(manifest),
    );
    for (const [path, content] of files) {
      const inputFile = join(temporary, "blob");
      yield* io(() => writeFile(inputFile, content, { mode: 0o600 }));
      const hash = yield* git(root, ["hash-object", "-w", "--", inputFile]);
      yield* git(root, ["update-index", "--add", "--cacheinfo", `100644,${hash},${path}`], { env });
    }
    const tree = yield* git(root, ["write-tree"], { env });
    const messageFile = join(temporary, "message");
    yield* io(() => writeFile(messageFile, "Personal Wiki publication\n", { mode: 0o600 }));
    return yield* git(
      root,
      ["commit-tree", tree, ...(base ? ["-p", base] : []), "-F", messageFile],
      { env },
    );
  }).pipe(
    Effect.ensuring(io(() => rm(temporary, { recursive: true, force: true })).pipe(Effect.orDie)),
  );
});
