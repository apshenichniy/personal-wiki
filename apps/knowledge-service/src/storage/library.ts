import { publicationFault } from "./faults.ts";
import { ownershipLayer } from "./ownership.ts";
import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import * as K from "@personal-wiki/contracts/knowledge";
import { JobRecord } from "../jobs/model.ts";
import { databaseLayer } from "./database.ts";
import { canonicalRef, createCommit, readTree } from "./tree.ts";
import {
  digest,
  durableCreate,
  git,
  invalid,
  io,
  LibraryError,
  prepareDirectory,
  stable,
  syncDirectory,
} from "./io.ts";
import { canonicalUrl, queryTerms, validateBatch } from "./validation.ts";
import type { RawArchive } from "./raw-archive.ts";

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, json: string): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(json));
const empty: K.Snapshot = { schemaVersion: 1, sources: [], captures: [], assets: [], notes: [] };
const fail = (code: LibraryError["code"], message: string) =>
  Effect.fail(new LibraryError({ code, message }));

export const makeLibrary = Effect.fn("Knowledge.makeLibrary")(function* (
  root: string,
  archive?: typeof RawArchive.Service,
) {
  const sql = yield* SqlClient.SqlClient;
  const lane = yield* Semaphore.make(1);
  const epoch = yield* sql.withTransaction(
    Effect.gen(function* () {
      const changed = yield* sql<{
        epoch: number;
      }>`UPDATE publisher_state SET epoch=epoch+1 WHERE singleton=1 RETURNING epoch`;
      const value = changed[0]?.epoch;
      if (!value) return yield* fail("unavailable", "Publisher epoch is unavailable.");
      yield* sql`UPDATE operations SET publisher_epoch=${value}`;
      return value;
    }),
  );
  yield* io(() => prepareDirectory(join(root, "objects")));
  yield* git(root, ["init", "--bare"]);
  yield* git(root, ["config", "core.fsync", "all"]);
  yield* git(root, ["config", "core.fsyncMethod", "fsync"]);
  yield* git(root, ["config", "core.hooksPath", "/dev/null"]);

  const read = Effect.fn("Knowledge.readSnapshot")(function* (revision?: string) {
    const rows = yield* sql<{
      applied_revision: string;
      sequence: number;
      payload: string;
    }>`SELECT s.applied_revision,s.sequence,p.payload FROM library_state s JOIN library_projection p ON p.singleton=s.singleton WHERE s.singleton=1`;
    const row = rows[0];
    if (!row) return yield* fail("unavailable", "Library projection is unavailable.");
    if (revision && revision !== row.applied_revision)
      return yield* fail("revision_changed", "The library changed; restart this read.");
    return {
      appliedRevision: row.applied_revision,
      sequence: row.sequence,
      snapshot: decode(K.Snapshot, row.payload),
    };
  });
  const index = Effect.fn("Knowledge.indexSnapshot")(function* (snapshot: K.Snapshot) {
    yield* sql`DELETE FROM knowledge_fts`;
    for (const note of snapshot.notes) {
      yield* sql`INSERT INTO knowledge_fts VALUES (${note.noteId},'title',${note.language},NULL,${[note.title, ...note.aliases].join(" ")})`;
      yield* sql`INSERT INTO knowledge_fts VALUES (${note.noteId},'body',${note.language},NULL,${note.markdown})`;
      for (const capture of snapshot.captures.filter((c) => note.captureIds.includes(c.captureId)))
        for (const representation of capture.representations) {
          yield* sql`INSERT INTO knowledge_fts VALUES (${note.noteId},'original',${representation.language},${representation.representationId},${representation.text})`;
        }
    }
    yield* sql`INSERT INTO library_projection VALUES (1,${stable(snapshot)}) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload`;
  });
  const initialized = yield* sql`SELECT singleton FROM library_state`;
  if (!initialized.length) {
    const genesis = yield* createCommit(
      root,
      empty,
      null,
      { schemaVersion: 1, kind: "genesis" },
      "2000-01-01T00:00:00.000Z",
    );
    const existing = yield* git(root, ["for-each-ref", "--format=%(objectname)", canonicalRef]);
    if (existing && existing !== genesis)
      return yield* fail("unavailable", "Unrecorded canonical history requires recovery.");
    if (!existing)
      yield* git(root, [
        "update-ref",
        canonicalRef,
        genesis,
        "0000000000000000000000000000000000000000",
      ]);
    yield* publicationFault(root, "genesis");
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* index(empty);
        yield* sql`INSERT INTO library_state VALUES(1,${genesis},0)`;
      }),
    );
  }

  const reserve = Effect.fn("Knowledge.reserve")(function* <E = never>(
    input: typeof K.ReserveRequest.Type,
    binding?: { jobId: string; authorize: Effect.Effect<void, E> },
  ) {
    return yield* lane.withPermit(
      sql.withTransaction(
        Effect.gen(function* () {
          if (binding) yield* binding.authorize;
          const payloadDigest = digest(
            stable(binding ? { ...input, jobId: binding.jobId } : input),
          );
          const existing = (yield* sql<{
            digest: string;
            payload: string;
          }>`SELECT digest,payload FROM drafts WHERE request_id=${input.requestId}`)[0];
          if (existing) {
            if (existing.digest !== payloadDigest)
              return yield* fail(
                "idempotency_conflict",
                "Reservation identity has different input.",
              );
            return decode(K.Draft, existing.payload);
          }
          const slots: K.Slot[] = [];
          for (const source of input.sources) {
            const externalKey = `x:${source.kind === "x_article" ? "article" : "post"}:${source.primaryId}`;
            const found = (yield* sql<{
              source_id: string;
              note_id: string;
              payload: string;
            }>`SELECT * FROM identities WHERE external_key=${externalKey}`)[0];
            const record: K.Source = found
              ? decode(K.Source, found.payload)
              : {
                  schemaVersion: 1,
                  ...source,
                  sourceId: randomUUID(),
                  externalKey,
                  canonicalUrl: canonicalUrl(source.kind, source.primaryId),
                };
            if (slots.some((s) => s.source.sourceId === record.sourceId))
              return yield* fail("invalid_request", "Duplicate reserved source.");
            const noteId = found?.note_id ?? randomUUID();
            if (!found)
              yield* sql`INSERT INTO identities VALUES (${externalKey},${record.sourceId},${noteId},${stable(record)})`;
            slots.push({
              source: record,
              noteId,
              captureId: randomUUID(),
              representationId: randomUUID(),
              assetId: randomUUID(),
            });
          }
          const draft: K.Draft = { schemaVersion: 1, jobId: binding?.jobId ?? randomUUID(), slots };
          yield* sql`INSERT INTO drafts VALUES (${input.requestId},${payloadDigest},${draft.jobId},${stable(draft)})`;
          return draft;
        }),
      ),
    );
  });
  const getDraft = Effect.fn("Knowledge.getDraft")(function* (jobId: string) {
    const row = (yield* sql<{
      payload: string;
    }>`SELECT payload FROM drafts WHERE job_id=${jobId}`)[0];
    if (!row) return yield* fail("invalid_request", "Unknown reserved job.");
    return decode(K.Draft, row.payload);
  });
  const upload = Effect.fn("Knowledge.upload")(function* <E = never>(
    input: typeof K.AssetUpload.Type,
    authorize?: Effect.Effect<void, E>,
    record?: (asset: K.Asset) => Effect.Effect<void, E>,
  ) {
    return yield* lane.withPermit(
      sql.withTransaction(
        Effect.gen(function* () {
          if (authorize) yield* authorize;
          const draft = yield* getDraft(input.jobId);
          if (!draft.slots.some((s) => s.assetId === input.assetId))
            return yield* fail("invalid_request", "Asset is outside this job scope.");
          const bytes = Buffer.from(input.base64, "base64");
          if (
            bytes.toString("base64") !== input.base64 ||
            bytes.length > 1_048_576 ||
            digest(bytes) !== input.sha256
          )
            return yield* fail("invalid_request", "Asset bytes or checksum are invalid.");
          const asset: K.Asset = {
            schemaVersion: 1,
            assetId: input.assetId,
            objectKey: `objects/${input.assetId}`,
            mediaType: input.mediaType,
            byteLength: bytes.length,
            sha256: input.sha256,
          };
          const old = (yield* sql<{
            payload: string;
          }>`SELECT payload FROM assets WHERE asset_id=${input.assetId}`)[0];
          if (old && old.payload !== stable(asset))
            return yield* fail("idempotency_conflict", "Immutable asset metadata differs.");
          yield* io(async () => {
            await durableCreate(join(root, "objects", input.assetId), bytes);
            await syncDirectory(join(root, "objects"));
            const retained = await readFile(join(root, "objects", input.assetId));
            if (retained.length !== bytes.length || digest(retained) !== asset.sha256)
              throw invalid("Asset readback checksum differs.");
          });
          yield* sql`INSERT INTO assets VALUES (${asset.assetId},${stable(asset)}) ON CONFLICT(asset_id) DO NOTHING`;
          if (record) yield* record(asset);
          return asset;
        }),
      ),
    );
  });
  const verifiedAssets = Effect.fn("Knowledge.verifyAssets")(function* (
    ids: ReadonlyArray<string>,
    readRaw = true,
  ) {
    const assets: K.Asset[] = [];
    for (const id of new Set(ids)) {
      const row = (yield* sql<{
        payload: string;
      }>`SELECT payload FROM assets WHERE asset_id=${id}`)[0];
      if (!row) return yield* fail("invalid_request", "Referenced asset has not been verified.");
      const asset = decode(K.Asset, row.payload);
      if (asset.objectKey.startsWith("providers/")) {
        if (!archive) return yield* fail("unavailable", "Private archive is not configured.");
        if (readRaw)
          yield* archive.read({
            key: asset.objectKey,
            sha256: asset.sha256,
            byteLength: asset.byteLength,
          });
        assets.push(asset);
        continue;
      }
      yield* io(async () => {
        const bytes = await readFile(join(root, "objects", id));
        if (bytes.length !== asset.byteLength || digest(bytes) !== asset.sha256)
          throw invalid("Retained asset checksum differs.");
      });
      assets.push(asset);
    }
    return assets;
  });
  // Trusted Service archive code supplies readback-confirmed manifests. This is
  // never exposed as a Runner assertion or arbitrary object-key registration.
  const registerRaw = (jobId: string, asset: K.Asset) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const old = (yield* sql<{
          payload: string;
        }>`SELECT payload FROM assets WHERE asset_id=${asset.assetId}`)[0];
        if (old && old.payload !== stable(asset))
          return yield* fail("idempotency_conflict", "Raw asset metadata changed.");
        yield* sql`INSERT INTO assets VALUES(${asset.assetId},${stable(asset)}) ON CONFLICT(asset_id) DO NOTHING`;
        yield* sql`INSERT INTO job_assets VALUES(${jobId},${asset.assetId}) ON CONFLICT(job_id,asset_id) DO NOTHING`;
      }),
    );
  const jobAssets = Effect.fn("Knowledge.jobAssets")(function* (jobId: string) {
    return (yield* sql<{
      asset_id: string;
    }>`SELECT asset_id FROM job_assets WHERE job_id=${jobId}`).map((row) => row.asset_id);
  });
  const checkCapture = Effect.fn("Knowledge.checkCapture")(function* (
    jobId: string,
    captures: ReadonlyArray<K.Capture>,
  ) {
    const draft = yield* getDraft(jobId);
    const base = yield* read();
    const assets = yield* verifiedAssets(
      [...base.snapshot.captures, ...captures].flatMap((capture) => capture.assetIds),
      false,
    );
    const scopeAssets = yield* jobAssets(jobId);
    yield* Effect.try({
      try: () =>
        validateBatch(
          {
            schemaVersion: 1,
            operationId: randomUUID(),
            proposalId: randomUUID(),
            jobId,
            baseRevision: base.appliedRevision,
            notes: [],
            captures,
            policyVersion: "capture-check-v1",
            derivation: { agent: "none", model: "none", skillVersion: "none" },
          },
          draft,
          base.snapshot,
          assets,
          scopeAssets,
        ),
      catch: (error) =>
        error instanceof LibraryError ? error : invalid("Invalid retained capture."),
    });
    return draft;
  });
  type Operation = {
    operation_id: string;
    digest: string;
    publication_id: string;
    job_id: string;
    base_revision: string;
    payload: string;
    published_at: string;
    phase: string;
    candidate: string | null;
    rejection: string | null;
    publisher_epoch: number;
    kind: "ingestion" | "compensation";
    target_publication_id: string | null;
  };
  const assertEpoch = Effect.fn("Knowledge.assertEpoch")(function* () {
    const rows = yield* sql`SELECT epoch FROM publisher_state WHERE singleton=1 AND epoch=${epoch}`;
    if (!rows.length) return yield* fail("unavailable", "Publisher ownership changed.");
  });
  const operation = Effect.fn("Knowledge.operation")(function* (id: string) {
    const row = (yield* sql<Operation>`SELECT * FROM operations WHERE operation_id=${id}`)[0];
    if (!row) return yield* fail("not_found", "Publication operation not found.");
    if (row.publisher_epoch !== epoch)
      return yield* fail("unavailable", "Publisher ownership changed.");
    return row;
  });
  const transition = Effect.fn("Knowledge.transition")(function* (
    id: string,
    from: string,
    to: string,
    candidate: string | null = null,
  ) {
    const changed =
      yield* sql`UPDATE operations SET phase=${to},candidate=COALESCE(${candidate},candidate) WHERE operation_id=${id} AND phase=${from} AND publisher_epoch=${epoch} AND EXISTS(SELECT 1 FROM publisher_state WHERE epoch=${epoch}) RETURNING operation_id`;
    if (!changed.length) {
      const row = yield* operation(id);
      return yield* fail(
        row.phase === "cancelled" ? "cancelled" : "unavailable",
        row.phase === "cancelled"
          ? "Publication was cancelled before commit intent."
          : "Publication transition was fenced.",
      );
    }
  });
  const terminal = Effect.fn("Knowledge.terminalResult")(function* (op: Operation) {
    const result = (yield* sql<{
      payload: string;
    }>`SELECT payload FROM receipts WHERE operation_id=${op.operation_id}`)[0];
    if (result) return decode(K.Receipt, result.payload);
    if (op.phase === "cancelled")
      return yield* fail("cancelled", "Publication was cancelled before commit intent.");
    if (op.phase === "rejected" && op.rejection)
      return yield* Effect.fail(decode(LibraryError, op.rejection));
    return null;
  });
  const manifestFor = (op: Operation, noteIds: ReadonlyArray<string>) => ({
    schemaVersion: 1,
    kind: op.kind,
    operationId: op.operation_id,
    publicationId: op.publication_id,
    jobId: op.job_id,
    payloadDigest: op.digest,
    baseRevision: op.base_revision,
    targetPublicationId: op.target_publication_id,
    noteIds: [...noteIds].sort(),
    publishedAt: op.published_at,
  });
  const prepareOperation = Effect.fn("Knowledge.prepareOperation")(function* (op: Operation) {
    const base = yield* read();
    if (
      base.appliedRevision !== op.base_revision ||
      (yield* git(root, ["rev-parse", canonicalRef])) !== op.base_revision
    )
      return yield* fail("stale_proposal", "Proposal base is stale.");
    let snapshot: K.Snapshot;
    let noteIds: ReadonlyArray<string>;
    if (op.kind === "compensation") {
      const target =
        (yield* sql<Operation>`SELECT * FROM operations WHERE publication_id=${op.target_publication_id} AND phase='applied'`)[0];
      if (!target || target.candidate !== op.base_revision)
        return yield* fail(
          "stale_proposal",
          "Compensation target is no longer the latest publication.",
        );
      const parent = yield* readTree(root, target.base_revision);
      snapshot = { ...base.snapshot, notes: parent.notes };
      noteIds = [...new Set([...parent.notes, ...base.snapshot.notes].map((n) => n.noteId))];
      yield* verifiedAssets(snapshot.captures.flatMap((capture) => capture.assetIds));
    } else {
      const proposal = decode(K.Proposal, op.payload);
      const draft = yield* getDraft(proposal.jobId);
      const assets = yield* verifiedAssets(
        [...base.snapshot.captures, ...proposal.captures].flatMap((c) => c.assetIds),
      );
      const scopeAssets = yield* jobAssets(proposal.jobId);
      snapshot = yield* Effect.try({
        try: () => validateBatch(proposal, draft, base.snapshot, assets, scopeAssets),
        catch: (error) =>
          error instanceof LibraryError ? error : invalid("Invalid proposed metadata."),
      });
      noteIds = proposal.notes.map((n) => n.noteId);
    }
    const candidate = yield* createCommit(
      root,
      snapshot,
      op.base_revision,
      manifestFor(op, noteIds),
      op.published_at,
    );
    yield* git(root, ["update-ref", `refs/prepared/${op.publication_id}`, candidate]);
    yield* publicationFault(root, "candidate");
    yield* transition(op.operation_id, "received", "prepared", candidate);
  });
  const executeOperation = Effect.fn("Knowledge.executeOperation")(function* (id: string) {
    yield* assertEpoch();
    let op = yield* operation(id);
    const previous = yield* terminal(op);
    if (previous) return previous;
    if (op.phase === "received") {
      yield* prepareOperation(op).pipe(
        Effect.catchTag("LibraryError", (error) =>
          Effect.gen(function* () {
            if (error.code !== "unavailable" && error.code !== "cancelled") {
              yield* sql`UPDATE operations SET phase='rejected',rejection=${stable({ _tag: error._tag, code: error.code, message: error.message })} WHERE operation_id=${id} AND phase='received' AND publisher_epoch=${epoch} AND EXISTS(SELECT 1 FROM publisher_state WHERE epoch=${epoch})`;
            }
            return yield* Effect.fail(error);
          }),
        ),
      );
      yield* publicationFault(root, "prepared");
      op = yield* operation(id);
    }
    const afterPreparation = yield* terminal(op);
    if (afterPreparation) return afterPreparation;
    if (!op.candidate) return yield* fail("unavailable", "Publication candidate is missing.");
    const candidate = op.candidate;
    const committed = yield* readTree(root, candidate);
    const storedManifest = yield* git(root, [
      "show",
      `${candidate}:.wiki/publications/${op.publication_id}.json`,
    ]);
    const noteIds =
      op.kind === "ingestion"
        ? decode(K.Proposal, op.payload).notes.map((n) => n.noteId)
        : [
            ...new Set(
              [...(yield* readTree(root, op.base_revision)).notes, ...committed.notes].map(
                (n) => n.noteId,
              ),
            ),
          ];
    if (
      storedManifest !== stable(manifestFor(op, noteIds)) ||
      (yield* git(root, ["rev-parse", `${candidate}^`])) !== op.base_revision
    )
      return yield* fail("unavailable", "Publication candidate manifest or parent diverged.");
    if (op.phase === "prepared") {
      if ((yield* git(root, ["rev-parse", canonicalRef])) !== op.base_revision)
        return yield* fail("unavailable", "Canonical revision changed before commit intent.");
      yield* verifiedAssets(committed.captures.flatMap((capture) => capture.assetIds));
      const permitted = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* assertEpoch();
          const saved = (yield* sql<{
            record: string;
          }>`SELECT record FROM ingestion_jobs WHERE job_id=${op.job_id}`)[0];
          if (saved && op.kind === "ingestion") {
            const job = decode(JobRecord, saved.record);
            const now = yield* Clock.currentTimeMillis;
            const authorized =
              job.lease &&
              (yield* sql`SELECT identity_id FROM machine_credentials WHERE identity_id=${job.lease.identityId} AND role='runner' AND revoked=0`)
                .length > 0;
            if (!authorized || job.stopReason || (job.deadline !== null && now >= job.deadline)) {
              const next = {
                ...job,
                stage: job.cleanupPending
                  ? "stopping"
                  : !authorized || job.stopReason === "cancelled"
                    ? "cancelled"
                    : "expired",
                stopReason: job.stopReason ?? (!authorized ? "cancelled" : "deadline"),
                reason: !authorized ? "credential_revoked" : (job.stopReason ?? "deadline"),
                lease: null,
                ready: false,
                epoch: job.epoch + 1,
              };
              yield* sql`UPDATE operations SET phase='cancelled' WHERE operation_id=${id} AND phase='prepared'`;
              yield* sql`UPDATE ingestion_jobs SET stage=${next.stage},ready=0,version=version+1,record=${stable(next)} WHERE job_id=${job.jobId}`;
              return false;
            }
            if (
              job.stage !== "publishing" ||
              job.operationId !== id ||
              job.resultDigest !== op.digest ||
              job.cleanupPending
            )
              return yield* fail("unavailable", "Job publication checkpoint is inconsistent.");
          }
          yield* read(op.base_revision);
          yield* transition(id, "prepared", "committing");
          return true;
        }),
      );
      if (!permitted) return yield* fail("cancelled", "Job stopped before publication intent.");
      yield* publicationFault(root, "committing");
      op = yield* operation(id);
    }
    if (op.phase === "committing") {
      const canonical = yield* git(root, ["rev-parse", canonicalRef]);
      if (canonical === op.base_revision)
        yield* git(root, ["update-ref", canonicalRef, candidate, op.base_revision]);
      else if (canonical !== candidate)
        return yield* fail("unavailable", "Canonical revision diverged from publication intent.");
      yield* publicationFault(root, "ref-advanced");
      yield* transition(id, "committing", "committed");
      yield* publicationFault(root, "committed");
      op = yield* operation(id);
    }
    if (op.phase !== "committed" || (yield* git(root, ["rev-parse", canonicalRef])) !== candidate)
      return yield* fail("unavailable", "Publication cannot be activated from this state.");
    const receipt = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertEpoch();
        const before = yield* read(op.base_revision);
        const receipt: K.Receipt = {
          schemaVersion: 1,
          operationId: id,
          publicationId: op.publication_id,
          jobId: op.job_id,
          appliedRevision: candidate,
          sequence: before.sequence + 1,
          noteIds,
          publishedAt: op.published_at,
        };
        yield* index(committed);
        yield* publicationFault(root, "activating");
        yield* sql`UPDATE library_state SET applied_revision=${candidate},sequence=${receipt.sequence} WHERE singleton=1`;
        yield* sql`INSERT INTO receipts VALUES (${id},${op.job_id},${stable(receipt)})`;
        const savedJob = (yield* sql<{
          record: string;
        }>`SELECT record FROM ingestion_jobs WHERE job_id=${op.job_id}`)[0];
        if (savedJob && op.kind === "ingestion") {
          const job = decode(JobRecord, savedJob.record);
          if (job.operationId !== id || job.cleanupPending)
            return yield* fail("unavailable", "Job publication result cannot be activated.");
          const completed: JobRecord = {
            ...job,
            stage: "succeeded",
            ready: false,
            lease: null,
            receiptOperationId: id,
            reason: null,
            stopReason: null,
          };
          yield* sql`UPDATE ingestion_jobs SET stage='succeeded',ready=0,version=version+1,record=${stable(completed)} WHERE job_id=${op.job_id}`;
        }
        yield* sql`INSERT INTO outbox(event_id,operation_id,revision) VALUES (${op.publication_id},${id},${candidate})`;
        yield* transition(id, "committed", "applied");
        return receipt;
      }),
    );
    yield* publicationFault(root, "activated");
    return receipt;
  });
  const submit = Effect.fn("Knowledge.submitPublication")(function* (
    input: K.Proposal | typeof K.Compensation.Type,
    kind: Operation["kind"],
  ) {
    return yield* lane.withPermit(
      Effect.gen(function* () {
        yield* assertEpoch();
        const payload = stable(input);
        const payloadDigest = digest(payload);
        const old =
          (yield* sql<Operation>`SELECT * FROM operations WHERE operation_id=${input.operationId}`)[0];
        if (old) {
          if (old.digest !== payloadDigest || old.kind !== kind)
            return yield* fail("idempotency_conflict", "Operation identity has different input.");
          return yield* executeOperation(old.operation_id);
        }
        if (Buffer.byteLength(payload, "utf8") > 1_048_576)
          return yield* fail(
            "invalid_request",
            "Publication input exceeds the retained byte limit.",
          );
        const jobId = "jobId" in input ? input.jobId : randomUUID();
        if ((yield* sql`SELECT operation_id FROM receipts WHERE job_id=${jobId}`).length)
          return yield* fail("already_published", "This job already has a publication receipt.");
        if (
          (yield* sql`SELECT operation_id FROM operations WHERE phase NOT IN ('applied','rejected','cancelled')`)
            .length
        )
          return yield* fail("unavailable", "An earlier publication must be reconciled first.");
        if (kind === "ingestion") yield* getDraft(jobId);
        const baseRevision = "baseRevision" in input ? input.baseRevision : input.expectedRevision;
        const target = "targetPublicationId" in input ? input.targetPublicationId : null;
        yield* sql`INSERT INTO operations(operation_id,digest,publication_id,job_id,base_revision,payload,published_at,phase,publisher_epoch,kind,target_publication_id) VALUES (${input.operationId},${payloadDigest},${randomUUID()},${jobId},${baseRevision},${payload},${new Date().toISOString()},'received',${epoch},${kind},${target})`;
        yield* publicationFault(root, "received");
        return yield* executeOperation(input.operationId);
      }),
    );
  });
  const publish = (proposal: K.Proposal) => submit(proposal, "ingestion");
  const compensate = (input: typeof K.Compensation.Type) => submit(input, "compensation");
  const cancelPublication = Effect.fn("Knowledge.cancelPublication")(function* (id: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertEpoch();
        yield* sql`UPDATE operations SET phase='cancelled' WHERE operation_id=${id} AND phase IN ('received','prepared') AND publisher_epoch=${epoch}`;
        const op = yield* operation(id);
        return {
          operationId: id,
          outcome:
            op.phase === "cancelled"
              ? ("cancelled" as const)
              : op.phase === "rejected"
                ? ("rejected" as const)
                : ("too_late" as const),
        };
      }),
    );
  });
  const outbox = () =>
    sql<{
      eventId: string;
      operationId: string;
      revision: string;
    }>`SELECT event_id AS eventId,operation_id AS operationId,revision FROM outbox WHERE delivered_at IS NULL ORDER BY rowid`;
  const ackEvent = (id: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* assertEpoch();
        if (!(yield* sql`SELECT event_id FROM outbox WHERE event_id=${id}`).length)
          return yield* fail("not_found", "Publication event not found.");
        yield* sql`UPDATE outbox SET delivered_at=COALESCE(delivered_at,${new Date().toISOString()}) WHERE event_id=${id}`;
      }),
    );
  // Startup adopts the journal under the new epoch and reconciles before admission.
  const pending =
    yield* sql<Operation>`SELECT * FROM operations WHERE phase NOT IN ('applied','rejected','cancelled') ORDER BY rowid`;
  if (pending.length > 1)
    return yield* fail("unavailable", "Multiple pending publications require investigation.");
  for (const op of pending)
    yield* executeOperation(op.operation_id).pipe(
      Effect.catchTag("LibraryError", (error) =>
        error.code === "invalid_request" ||
        error.code === "stale_proposal" ||
        error.code === "cancelled"
          ? Effect.void
          : Effect.fail(error),
      ),
    );
  if ((yield* git(root, ["rev-parse", canonicalRef])) !== (yield* read()).appliedRevision)
    return yield* fail("unavailable", "Canonical and applied revisions diverged.");
  const list = (revision?: string) =>
    sql.withTransaction(
      read(revision).pipe(
        Effect.map((s) => ({ appliedRevision: s.appliedRevision, notes: s.snapshot.notes })),
      ),
    );
  const note = (noteId: string, revision?: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* read(revision);
        const note = state.snapshot.notes.find((n) => n.noteId === noteId);
        if (!note) return yield* fail("not_found", "Note not found.");
        return { appliedRevision: state.appliedRevision, note };
      }),
    );
  const capture = (captureId: string, revision?: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* read(revision);
        const capture = state.snapshot.captures.find(
          (c) =>
            c.captureId === captureId &&
            state.snapshot.notes.some((n) => n.captureIds.includes(c.captureId)),
        );
        if (!capture) return yield* fail("not_found", "Capture not found.");
        const source = state.snapshot.sources.find((s) => s.sourceId === capture.sourceId);
        if (!source) return yield* fail("unavailable", "Source projection is inconsistent.");
        return { appliedRevision: state.appliedRevision, capture, source };
      }),
    );
  const asset = (assetId: string) =>
    Effect.gen(function* () {
      if (!Schema.is(K.Id)(assetId)) return yield* fail("not_found", "Asset not found.");
      const manifest = yield* sql.withTransaction(
        Effect.gen(function* () {
          const state = yield* read();
          const retained = state.snapshot.captures.some((capture) =>
            capture.assetIds.includes(assetId),
          );
          const job = yield* sql`SELECT asset_id FROM job_assets WHERE asset_id=${assetId} LIMIT 1`;
          if (!retained && !job.length) return yield* fail("not_found", "Asset not found.");
          const row = (yield* sql<{
            payload: string;
          }>`SELECT payload FROM assets WHERE asset_id=${assetId}`)[0];
          if (!row) return yield* fail("not_found", "Asset not found.");
          return decode(K.Asset, row.payload);
        }),
      );
      const bytes = manifest.objectKey.startsWith("providers/")
        ? archive
          ? yield* archive.read({
              key: manifest.objectKey,
              sha256: manifest.sha256,
              byteLength: manifest.byteLength,
            })
          : yield* fail("unavailable", "Private archive is unavailable.")
        : yield* io(() => readFile(join(root, "objects", assetId)));
      if (bytes.length !== manifest.byteLength || digest(bytes) !== manifest.sha256)
        return yield* fail("unavailable", "Retained asset verification failed.");
      return bytes;
    });
  const search = (query: string, revision?: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* read(revision);
        const terms = yield* Effect.try({
          try: () => queryTerms(query),
          catch: () => invalid("Search exceeds the supported bounds."),
        });
        if (!terms)
          return {
            appliedRevision: state.appliedRevision,
            results: state.snapshot.notes
              .slice(-20)
              .reverse()
              .map((note) => ({
                note,
                matchedKind: "title" as const,
                language: note.language,
                representationId: null,
                excerpt: note.title,
              })),
          };
        const hits = yield* sql<{
          note_id: string;
          kind: "title" | "body" | "original";
          language: string;
          representation_id: string | null;
          content: string;
        }>`SELECT note_id,kind,language,representation_id,content FROM knowledge_fts WHERE knowledge_fts MATCH ${terms} ORDER BY CASE kind WHEN 'title' THEN 0 WHEN 'body' THEN 1 ELSE 2 END, bm25(knowledge_fts), note_id, representation_id`;
        const seen = new Set<string>();
        const results = [];
        for (const hit of hits) {
          if (seen.has(hit.note_id)) continue;
          const note = state.snapshot.notes.find((n) => n.noteId === hit.note_id);
          if (!note) return yield* fail("unavailable", "Search projection is inconsistent.");
          seen.add(note.noteId);
          results.push({
            note,
            matchedKind: hit.kind,
            language: hit.language,
            representationId: hit.representation_id,
            excerpt: hit.content.slice(0, 240),
          });
          if (results.length === 20) break;
        }
        return { appliedRevision: state.appliedRevision, results };
      }),
    );
  const rebuild = () =>
    lane.withPermit(
      Effect.gen(function* () {
        const state = yield* read();
        const snapshot = yield* readTree(root, state.appliedRevision);
        yield* sql.withTransaction(index(snapshot));
        return { appliedRevision: state.appliedRevision, notes: snapshot.notes };
      }),
    );
  return {
    reserve,
    upload,
    registerRaw,
    publish,
    list,
    note,
    capture,
    asset,
    search,
    rebuild,
    checkCapture,
    cancelPublication,
    compensate,
    outbox,
    ackEvent,
  };
});
export class Library extends Context.Service<
  Library,
  Effect.Success<ReturnType<typeof makeLibrary>>
>()("personal-wiki/Library") {
  static layer = (root: string, archive?: typeof RawArchive.Service) =>
    Layer.effect(Library, makeLibrary(root, archive)).pipe(
      Layer.provideMerge(databaseLayer(root)),
      Layer.provide(ownershipLayer()),
    );
}
