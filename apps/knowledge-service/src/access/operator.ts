import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { revokeOwnerSessions } from "./sessions.ts";

export const revokeDatabaseSessions = (path: string) =>
  Effect.gen(function* () {
    if (!isAbsolute(path)) return yield* Effect.die("Existing absolute database path required");
    const canonicalPath = yield* Effect.tryPromise(async () => {
      const stat = await lstat(path);
      const canonical = await realpath(path);
      const parent = await lstat(dirname(canonical));
      if (!stat.isFile() || stat.mode & 0o022 || !parent.isDirectory() || parent.mode & 0o077)
        throw new Error("Existing private regular database required");
      return canonical;
    });
    // No migrations, publisher claim, new library or OIDC secrets for revocation.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout=5000`;
      yield* sql`PRAGMA synchronous=FULL`;
      yield* revokeOwnerSessions;
    }).pipe(Effect.provide(SqliteClient.layer({ filename: canonicalPath })));
  });
