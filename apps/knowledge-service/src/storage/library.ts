import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import * as K from "@personal-wiki/contracts/knowledge";
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

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, json: string): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(json));
const empty: K.Snapshot = { schemaVersion: 1, sources: [], captures: [], assets: [], notes: [] };
const fail = (code: LibraryError["code"], message: string) =>
  Effect.fail(new LibraryError({ code, message }));

export const makeLibrary = Effect.fn("Knowledge.makeLibrary")(function* (root: string) {
  const sql = yield* SqlClient.SqlClient;
  const lane = yield* Semaphore.make(1);
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
    yield* git(root, [
      "update-ref",
      canonicalRef,
      genesis,
      "0000000000000000000000000000000000000000",
    ]);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* index(empty);
        yield* sql`INSERT INTO library_state VALUES(1,${genesis},0)`;
      }),
    );
  }
  const current = yield* read();
  if ((yield* git(root, ["rev-parse", canonicalRef])) !== current.appliedRevision)
    return yield* fail(
      "unavailable",
      "Unapplied publication requires recovery before this development service starts.",
    );

  const reserve = Effect.fn("Knowledge.reserve")(function* (input: typeof K.ReserveRequest.Type) {
    return yield* lane.withPermit(
      sql.withTransaction(
        Effect.gen(function* () {
          const payloadDigest = digest(stable(input));
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
          const draft: K.Draft = { schemaVersion: 1, jobId: randomUUID(), slots };
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
  const upload = Effect.fn("Knowledge.upload")(function* (input: typeof K.AssetUpload.Type) {
    return yield* lane.withPermit(
      Effect.gen(function* () {
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
        return asset;
      }),
    );
  });
  const verifiedAssets = Effect.fn("Knowledge.verifyAssets")(function* (
    ids: ReadonlyArray<string>,
  ) {
    const assets: K.Asset[] = [];
    for (const id of new Set(ids)) {
      const row = (yield* sql<{
        payload: string;
      }>`SELECT payload FROM assets WHERE asset_id=${id}`)[0];
      if (!row) return yield* fail("invalid_request", "Referenced asset has not been verified.");
      const asset = decode(K.Asset, row.payload);
      yield* io(async () => {
        const bytes = await readFile(join(root, "objects", id));
        if (bytes.length !== asset.byteLength || digest(bytes) !== asset.sha256)
          throw invalid("Retained asset checksum differs.");
      });
      assets.push(asset);
    }
    return assets;
  });
  const publish = Effect.fn("Knowledge.publish")(function* (proposal: K.Proposal) {
    return yield* lane.withPermit(
      Effect.gen(function* () {
        const payloadDigest = digest(stable(proposal));
        const old = (yield* sql<{
          digest: string;
          phase: string;
          rejection: string | null;
        }>`SELECT digest,phase,rejection FROM operations WHERE operation_id=${proposal.operationId}`)[0];
        if (old) {
          if (old.digest !== payloadDigest)
            return yield* fail("idempotency_conflict", "Operation identity has different input.");
          const receipt = (yield* sql<{
            payload: string;
          }>`SELECT payload FROM receipts WHERE operation_id=${proposal.operationId}`)[0];
          if (receipt) return decode(K.Receipt, receipt.payload);
          if (old.phase === "rejected" && old.rejection)
            return yield* Effect.fail(decode(LibraryError, old.rejection));
          return yield* fail("unavailable", "Publication is pending recovery.");
        }
        if ((yield* sql`SELECT operation_id FROM receipts WHERE job_id=${proposal.jobId}`).length)
          return yield* fail("already_published", "This job already has a publication receipt.");
        if (
          (yield* sql`SELECT operation_id FROM operations WHERE phase NOT IN ('applied','rejected','cancelled')`)
            .length
        )
          return yield* fail("unavailable", "An earlier publication must be reconciled first.");
        const draft = yield* getDraft(proposal.jobId);
        const base = yield* read();
        const publicationId = randomUUID();
        const publishedAt = new Date().toISOString();
        yield* sql`INSERT INTO operations(operation_id,digest,publication_id,job_id,base_revision,payload,published_at,phase) VALUES (${proposal.operationId},${payloadDigest},${publicationId},${proposal.jobId},${proposal.baseRevision},${stable(proposal)},${publishedAt},'received')`;
        if (
          base.appliedRevision !== proposal.baseRevision ||
          (yield* git(root, ["rev-parse", canonicalRef])) !== proposal.baseRevision
        ) {
          yield* sql`UPDATE operations SET phase='rejected',rejection=${stable({ _tag: "LibraryError", code: "stale_proposal", message: "Proposal base is stale." })} WHERE operation_id=${proposal.operationId}`;
          return yield* fail("stale_proposal", "Proposal base is stale.");
        }
        const snapshot = yield* Effect.gen(function* () {
          const assets = yield* verifiedAssets(
            [...base.snapshot.captures, ...proposal.captures].flatMap((c) => c.assetIds),
          );
          return yield* Effect.try({
            try: () => validateBatch(proposal, draft, base.snapshot, assets),
            catch: (error) =>
              error instanceof LibraryError ? error : invalid("Invalid proposed metadata."),
          });
        }).pipe(
          Effect.catchTag("LibraryError", (error) =>
            Effect.gen(function* () {
              yield* sql`UPDATE operations SET phase='rejected',rejection=${stable({ _tag: error._tag, code: error.code, message: error.message })} WHERE operation_id=${proposal.operationId}`;
              return yield* Effect.fail(error);
            }),
          ),
        );
        const manifest = {
          schemaVersion: 1,
          operationId: proposal.operationId,
          publicationId,
          jobId: proposal.jobId,
          payloadDigest,
          baseRevision: proposal.baseRevision,
          noteIds: proposal.notes.map((n) => n.noteId),
          publishedAt,
        };
        const candidate = yield* createCommit(
          root,
          snapshot,
          proposal.baseRevision,
          manifest,
          publishedAt,
        );
        yield* git(root, ["update-ref", `refs/prepared/${publicationId}`, candidate]);
        yield* sql`UPDATE operations SET phase='prepared',candidate=${candidate} WHERE operation_id=${proposal.operationId}`;
        yield* sql`UPDATE operations SET phase='committing' WHERE operation_id=${proposal.operationId}`;
        yield* git(root, ["update-ref", canonicalRef, candidate, proposal.baseRevision]);
        yield* sql`UPDATE operations SET phase='committed' WHERE operation_id=${proposal.operationId}`;
        const committed = yield* readTree(root, candidate);
        const receipt: K.Receipt = {
          schemaVersion: 1,
          operationId: proposal.operationId,
          publicationId,
          jobId: proposal.jobId,
          appliedRevision: candidate,
          sequence: base.sequence + 1,
          noteIds: proposal.notes.map((n) => n.noteId),
          publishedAt,
        };
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const before = yield* read(proposal.baseRevision);
            if (before.sequence !== base.sequence)
              return yield* fail("unavailable", "Publication sequence changed.");
            yield* index(committed);
            yield* sql`UPDATE library_state SET applied_revision=${candidate},sequence=${receipt.sequence} WHERE singleton=1`;
            yield* sql`INSERT INTO receipts VALUES (${proposal.operationId},${proposal.jobId},${stable(receipt)})`;
            yield* sql`INSERT INTO outbox(event_id,operation_id,revision) VALUES (${publicationId},${proposal.operationId},${candidate})`;
            yield* sql`UPDATE operations SET phase='applied' WHERE operation_id=${proposal.operationId}`;
          }),
        );
        return receipt;
      }),
    );
  });
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
  return { reserve, upload, publish, list, note, capture, search, rebuild };
});
export class Library extends Context.Service<
  Library,
  Effect.Success<ReturnType<typeof makeLibrary>>
>()("personal-wiki/Library") {
  static layer = (root: string) =>
    Layer.effect(Library, makeLibrary(root)).pipe(Layer.provide(databaseLayer(root)));
}
