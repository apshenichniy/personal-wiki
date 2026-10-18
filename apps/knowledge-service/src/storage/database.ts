import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { io, prepareDirectory, LibraryError } from "./io.ts";

const migrations = {
  "0001_library": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE library_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), applied_revision TEXT NOT NULL, sequence INTEGER NOT NULL)`;
    yield* sql`CREATE TABLE library_projection (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL)`;
    yield* sql`CREATE TABLE identities (external_key TEXT PRIMARY KEY, source_id TEXT UNIQUE NOT NULL, note_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)`;
    yield* sql`CREATE TABLE drafts (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, job_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)`;
    yield* sql`CREATE TABLE assets (asset_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
    yield* sql`CREATE TABLE operations (operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, publication_id TEXT UNIQUE NOT NULL, job_id TEXT NOT NULL, base_revision TEXT NOT NULL, payload TEXT NOT NULL, published_at TEXT NOT NULL, phase TEXT NOT NULL, candidate TEXT, rejection TEXT)`;
    yield* sql`CREATE TABLE receipts (operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id), job_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)`;
    yield* sql`CREATE TABLE outbox (event_id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL REFERENCES operations(operation_id), revision TEXT NOT NULL, delivered_at TEXT)`;
    yield* sql`CREATE VIRTUAL TABLE knowledge_fts USING fts5(note_id UNINDEXED, kind UNINDEXED, language UNINDEXED, representation_id UNINDEXED, content, tokenize='unicode61')`;
  }),
};
export const databaseLayer = (root: string) =>
  Layer.unwrap(
    io(async () => {
      await prepareDirectory(root);
      return Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode=WAL`;
          yield* sql`PRAGMA synchronous=FULL`;
          yield* sql`PRAGMA foreign_keys=ON`;
          yield* sql`PRAGMA read_uncommitted=OFF`;
          yield* sql`PRAGMA busy_timeout=5000`;
          const wal = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`;
          const sync = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;
          const foreign = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`;
          const isolation = yield* sql<{ read_uncommitted: number }>`PRAGMA read_uncommitted`;
          if (
            wal[0]?.journal_mode !== "wal" ||
            sync[0]?.synchronous !== 2 ||
            foreign[0]?.foreign_keys !== 1 ||
            isolation[0]?.read_uncommitted !== 0
          )
            return yield* new LibraryError({
              code: "unavailable",
              message: "Required SQLite durability settings are unavailable.",
            });
          yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) });
        }),
      ).pipe(Layer.provideMerge(SqliteClient.layer({ filename: join(root, "library.sqlite") })));
    }),
  );
