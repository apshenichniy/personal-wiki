import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { io, prepareDirectory, LibraryError } from "./io.ts";

const migrations = {
  "0006_curation": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE curation_contexts (context_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id), record TEXT NOT NULL)`;
    yield* sql`CREATE TABLE curation_feedback (job_id TEXT PRIMARY KEY REFERENCES ingestion_jobs(job_id), checks TEXT NOT NULL)`;
  }),
  "0005_capture_policy": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE job_capture_policies (job_id TEXT PRIMARY KEY REFERENCES ingestion_jobs(job_id), payload TEXT NOT NULL)`;
  }),
  "0004_raw_assets": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE job_assets (job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id), asset_id TEXT NOT NULL REFERENCES assets(asset_id), PRIMARY KEY(job_id,asset_id))`;
  }),
  "0003_jobs": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE ingestion_jobs (job_id TEXT PRIMARY KEY, source_key TEXT NOT NULL, stage TEXT NOT NULL, generation INTEGER NOT NULL, ready INTEGER NOT NULL, version INTEGER NOT NULL, record TEXT NOT NULL)`;
    yield* sql`CREATE INDEX jobs_source_history ON ingestion_jobs(source_key)`;
    yield* sql`CREATE UNIQUE INDEX jobs_one_active_source ON ingestion_jobs(source_key) WHERE stage NOT IN ('succeeded','failed','expired','cancelled')`;
    yield* sql`CREATE TABLE job_redirects (job_id TEXT PRIMARY KEY REFERENCES ingestion_jobs(job_id), target_job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id))`;
    yield* sql`CREATE TABLE submissions (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, job_id TEXT REFERENCES ingestion_jobs(job_id), note_id TEXT, result TEXT NOT NULL)`;
    yield* sql`CREATE TABLE source_resolutions (job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id), request_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
    yield* sql`CREATE TABLE source_aliases (alias_key TEXT PRIMARY KEY, canonical_key TEXT NOT NULL)`;
    yield* sql`CREATE TABLE scheduling_outbox (job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id), generation INTEGER NOT NULL, offered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job_id,generation))`;
    yield* sql`CREATE TABLE job_requests (identity_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(identity_id,request_id))`;
    yield* sql`CREATE TABLE publication_requests (identity_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY(identity_id,request_id))`;
    yield* sql`CREATE TABLE execution_attempts (attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id), number INTEGER NOT NULL, record TEXT NOT NULL, state TEXT NOT NULL, output TEXT, UNIQUE(job_id,number))`;
    yield* sql`CREATE TABLE adapter_gates (adapter TEXT PRIMARY KEY, reason TEXT NOT NULL)`;
    yield* sql`CREATE TABLE machine_credentials (identity_id TEXT PRIMARY KEY, verifier TEXT UNIQUE NOT NULL, role TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`;
  }),
  "0002_publisher_epoch": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE publisher_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL)`;
    yield* sql`INSERT INTO publisher_state VALUES(1,0)`;
    yield* sql`ALTER TABLE operations ADD COLUMN publisher_epoch INTEGER NOT NULL DEFAULT 0`;
    yield* sql`ALTER TABLE operations ADD COLUMN kind TEXT NOT NULL DEFAULT 'ingestion'`;
    yield* sql`ALTER TABLE operations ADD COLUMN target_publication_id TEXT`;
  }),
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
