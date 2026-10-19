import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { dirname } from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { io, prepareDirectory } from "../storage/io.ts";

/** Separate service-owned accounting authority shared by all library namespaces.
 * Neither Runner nor a staging library database can create a fresh allowance. */
export class ProviderDatabase extends Context.Service<ProviderDatabase, SqlClient.SqlClient>()(
  "personal-wiki/ProviderDatabase",
) {
  static layer = (path: string) =>
    Layer.unwrap(
      io(async () => {
        await prepareDirectory(dirname(path));
        const file = await open(
          path,
          constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.mode & 0o077)
            throw new Error("Private accounting database required");
        } finally {
          await file.close();
        }
        return Layer.effect(
          ProviderDatabase,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`PRAGMA synchronous=FULL`;
            yield* sql`PRAGMA foreign_keys=ON`;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`CREATE TABLE IF NOT EXISTS provider_configuration (singleton INTEGER PRIMARY KEY CHECK(singleton=1), profile TEXT NOT NULL, quarantined INTEGER NOT NULL DEFAULT 0, reason TEXT)`;
                yield* sql`CREATE TABLE IF NOT EXISTS provider_baselines (baseline_id TEXT PRIMARY KEY, month TEXT NOT NULL, campaign_id TEXT, nanos INTEGER NOT NULL, evidence TEXT NOT NULL)`;
                yield* sql`CREATE TABLE IF NOT EXISTS provider_stops (job_id TEXT PRIMARY KEY)`;
                yield* sql`CREATE TABLE IF NOT EXISTS provider_jobs (job_id TEXT PRIMARY KEY, record TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0)`;
                yield* sql`CREATE TABLE IF NOT EXISTS provider_operations (operation_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES provider_jobs(job_id), plan_key TEXT NOT NULL, run_id TEXT UNIQUE, record TEXT NOT NULL, UNIQUE(job_id,plan_key))`;
                yield* sql`CREATE TABLE IF NOT EXISTS provider_pages (operation_id TEXT NOT NULL REFERENCES provider_operations(operation_id), page_key TEXT NOT NULL, asset_id TEXT UNIQUE NOT NULL, record TEXT NOT NULL, PRIMARY KEY(operation_id,page_key))`;
                yield* sql`CREATE TABLE IF NOT EXISTS provider_page_intents (operation_id TEXT NOT NULL REFERENCES provider_operations(operation_id), page_key TEXT NOT NULL, asset_id TEXT UNIQUE NOT NULL, record TEXT NOT NULL, PRIMARY KEY(operation_id,page_key))`;
              }),
            );
            return sql;
          }),
        ).pipe(Layer.provide(SqliteClient.layer({ filename: path })));
      }),
    );
}
