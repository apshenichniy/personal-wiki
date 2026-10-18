import { Effect } from "effect";
import { ownershipLayer } from "../../apps/knowledge-service/src/storage/ownership.ts";
import { git } from "../../apps/knowledge-service/src/storage/io.ts";
const root = process.env.WIKI_DATA_DIR;
if (!root) throw new Error("Test root required");
await Effect.runPromise(
  Effect.gen(function* () {
    const revision = yield* git(root, ["rev-parse", "refs/heads/knowledge"]);
    yield* git(root, ["update-ref", "refs/test/orphan", revision]);
  }).pipe(Effect.provide(ownershipLayer())),
);
