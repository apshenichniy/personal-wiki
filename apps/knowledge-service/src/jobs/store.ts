import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { stable } from "../storage/io.ts";
import { JobError } from "./policy.ts";
import { JobRecord } from "./model.ts";

export const makeJobStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const owner = (yield* sql<{
    epoch: number;
  }>`SELECT epoch FROM publisher_state WHERE singleton=1`)[0];
  if (!owner)
    return yield* new JobError({
      code: "stale_owner",
      message: "Publisher ownership is unavailable.",
    });
  const epoch = owner.epoch;
  const assertOwner = Effect.fn("Jobs.assertPublisher")(function* () {
    if (
      !(yield* sql`SELECT epoch FROM publisher_state WHERE singleton=1 AND epoch=${epoch}`).length
    )
      return yield* new JobError({ code: "stale_owner", message: "Publisher ownership changed." });
  });
  type Row = {
    source_key: string;
    stage: string;
    generation: number;
    ready: number;
    version: number;
    record: string;
  };
  const decodeRow = Effect.fn("Jobs.decodeRecord")(function* (row: Row) {
    const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JobRecord))(row.record);
    if (
      record.sourceKey !== row.source_key ||
      record.stage !== row.stage ||
      record.generation !== row.generation ||
      Number(record.ready) !== row.ready
    )
      return yield* new JobError({
        code: "invalid_transition",
        message: "Job journal indexes disagree with its record.",
      });
    return { record, version: row.version };
  });
  const get = Effect.fn("Jobs.getRecord")(function* (id: string) {
    const row = (yield* sql<Row>`SELECT * FROM ingestion_jobs WHERE job_id=${id}`)[0];
    return row ? yield* decodeRow(row) : null;
  });
  const active = Effect.fn("Jobs.activeRecords")(function* () {
    return yield* Effect.forEach(
      yield* sql<Row>`SELECT * FROM ingestion_jobs WHERE stage NOT IN ('succeeded','failed','expired','cancelled') ORDER BY rowid`,
      decodeRow,
    );
  });
  const latest = Effect.fn("Jobs.latestSourceRecord")(function* (sourceKey: string) {
    const row =
      (yield* sql<Row>`SELECT * FROM ingestion_jobs WHERE source_key=${sourceKey} ORDER BY rowid DESC LIMIT 1`)[0];
    return row ? yield* decodeRow(row) : null;
  });
  const activeSource = Effect.fn("Jobs.activeSourceRecord")(function* (sourceKey: string) {
    const row =
      (yield* sql<Row>`SELECT * FROM ingestion_jobs WHERE source_key=${sourceKey} AND stage NOT IN ('succeeded','failed','expired','cancelled') LIMIT 1`)[0];
    return row ? yield* decodeRow(row) : null;
  });
  const insert = Effect.fn("Jobs.insertRecord")(function* (record: JobRecord) {
    yield* assertOwner();
    yield* sql`INSERT INTO ingestion_jobs VALUES (${record.jobId},${record.sourceKey},${record.stage},${record.generation},${Number(record.ready)},1,${stable(record)})`;
    return { record, version: 1 };
  });
  const put = Effect.fn("Jobs.putRecord")(function* (record: JobRecord, version: number) {
    const changed =
      yield* sql`UPDATE ingestion_jobs SET source_key=${record.sourceKey},stage=${record.stage},generation=${record.generation},ready=${Number(record.ready)},version=version+1,record=${stable(record)} WHERE job_id=${record.jobId} AND version=${version} AND EXISTS(SELECT 1 FROM publisher_state WHERE singleton=1 AND epoch=${epoch}) RETURNING version`;
    if (!changed.length)
      return yield* new JobError({
        code: "stale_owner",
        message: "Job state or publisher ownership changed.",
      });
    return { record, version: version + 1 };
  });
  const schedule = Effect.fn("Jobs.schedule")(function* (record: JobRecord) {
    yield* assertOwner();
    yield* sql`INSERT INTO scheduling_outbox(job_id,generation) VALUES(${record.jobId},${record.generation}) ON CONFLICT(job_id,generation) DO NOTHING`;
  });
  const pendingSchedules = () =>
    sql<{
      job_id: string;
      generation: number;
    }>`SELECT job_id,generation FROM scheduling_outbox WHERE offered=0 ORDER BY rowid`;
  const offered = Effect.fn("Jobs.offered")(function* (id: string, generation: number) {
    yield* assertOwner();
    yield* sql`UPDATE scheduling_outbox SET offered=1 WHERE job_id=${id} AND generation=${generation}`;
  });
  const resolveRedirect = Effect.fn("Jobs.resolveRedirect")(function* (id: string) {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const next = (yield* sql<{
        target_job_id: string;
      }>`SELECT target_job_id FROM job_redirects WHERE job_id=${id}`)[0];
      if (!next) return id;
      id = next.target_job_id;
    }
    return yield* new JobError({
      code: "invalid_transition",
      message: "Job redirection is inconsistent.",
    });
  });
  return {
    sql,
    assertOwner,
    get,
    active,
    latest,
    activeSource,
    insert: (record: JobRecord) => sql.withTransaction(insert(record)),
    put,
    schedule: (record: JobRecord) => sql.withTransaction(schedule(record)),
    pendingSchedules,
    offered: (id: string, generation: number) => sql.withTransaction(offered(id, generation)),
    resolveRedirect,
    transaction: sql.withTransaction,
  };
});
export class JobStore extends Context.Service<JobStore, Effect.Success<typeof makeJobStore>>()(
  "personal-wiki/JobStore",
) {
  static layer = Layer.effect(JobStore, makeJobStore);
}
