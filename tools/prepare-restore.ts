// Called only inside a new, fenced recovery directory before serving any requests.
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { isAbsolute, join } from "node:path";
import { Library } from "../apps/knowledge-service/src/storage/library.ts";
import { recoveryArchive } from "../apps/knowledge-service/src/storage/recovery-archive.ts";
import { JobRecord, isTerminal } from "../apps/knowledge-service/src/jobs/model.ts";
import { revokeOwnerSessions } from "../apps/knowledge-service/src/access/sessions.ts";
import { stable } from "../apps/knowledge-service/src/storage/io.ts";
const root = process.argv[2],
  originals = process.argv[3];
if (
  !root ||
  !originals ||
  !isAbsolute(root) ||
  !isAbsolute(originals) ||
  !(await Bun.file(join(root, "library.sqlite")).exists())
)
  process.exit(1);
const program = Effect.gen(function* () {
  // Library startup adopts pending publication candidates before quarantine.
  // No HTTP listener, provider call or executor is started by this command.
  yield* Library;
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* revokeOwnerSessions;
      yield* sql`UPDATE machine_credentials SET revoked=1`;
      yield* sql`UPDATE publisher_state SET epoch=epoch+1 WHERE singleton=1`;
      const rows = yield* sql<{ record: string }>`SELECT record FROM ingestion_jobs`;
      for (const row of rows) {
        const old = Schema.decodeUnknownSync(Schema.fromJsonString(JobRecord))(row.record);
        if (isTerminal(old.stage)) continue;
        const next: JobRecord = {
          ...old,
          stage: "blocked",
          reason: "restore_accounting_unknown",
          ready: false,
          lease: null,
          epoch: old.epoch + 1,
          cleanupPending: false,
          retryAt: null,
        };
        yield* sql`UPDATE ingestion_jobs SET stage='blocked',ready=0,version=version+1,record=${stable(next)} WHERE job_id=${old.jobId}`;
      }
    }),
  );
}).pipe(Effect.provide(Library.layer(root, recoveryArchive(originals))));
await Effect.runPromise(
  program.pipe(
    Effect.catchCause(() =>
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  ),
);
