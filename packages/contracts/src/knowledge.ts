import { Schema } from "effect";

export const Id = Schema.String.check(Schema.isUUID());
export const ProviderId = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,24}$/));
export const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
export const Instant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
);
export const BoundedText = Schema.String.check(Schema.isMaxLength(1_048_576));
export const SourceInput = Schema.Struct({
  kind: Schema.Literals(["x_post", "x_author_thread", "x_article"]),
  primaryId: ProviderId,
  aliases: Schema.Array(ProviderId).check(Schema.isMaxLength(50)),
  resolution: Schema.Literals(["resolved", "uncertain"]),
}).annotate({ identifier: "SourceInput" });
export const Source = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceId: Id,
  ...SourceInput.fields,
  externalKey: Schema.String,
  canonicalUrl: Schema.String,
}).annotate({ identifier: "Source" });
export const Slot = Schema.Struct({
  source: Source,
  noteId: Id,
  captureId: Id,
  representationId: Id,
  assetId: Id,
}).annotate({ identifier: "Slot" });
export const ReserveRequest = Schema.Struct({
  requestId: Id,
  sources: Schema.Array(SourceInput).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
}).annotate({ identifier: "ReserveRequest" });
export const Draft = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  jobId: Id,
  slots: Schema.Array(Slot),
}).annotate({ identifier: "Draft" });
export const AssetUpload = Schema.Struct({
  jobId: Id,
  assetId: Id,
  mediaType: Schema.Literals(["text/plain", "application/json", "text/html", "text/markdown"]),
  base64: Schema.String.check(Schema.isMaxLength(1_398_104)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
}).annotate({ identifier: "AssetUpload" });
export const Asset = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  assetId: Id,
  objectKey: Schema.String,
  mediaType: Schema.String,
  byteLength: Schema.Int,
  sha256: Schema.String,
}).annotate({ identifier: "Asset" });
export const Observation = Schema.Struct({
  authorHandle: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(128)))),
  authorName: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
  isBot: Schema.optional(Schema.NullOr(Schema.Boolean)),
  role: Schema.optional(Schema.Literals(["main", "discussion", "context", "quote"])),
  providerId: ProviderId,
  canonicalUrl: Schema.String,
  text: BoundedText,
  authorId: Schema.NullOr(ProviderId),
  parentId: Schema.NullOr(ProviderId),
  conversationId: Schema.NullOr(ProviderId),
  quotedId: Schema.NullOr(ProviderId),
  articleId: Schema.NullOr(ProviderId),
  postedAt: Schema.NullOr(Instant),
}).annotate({ identifier: "Observation" });
export const Representation = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  representationId: Id,
  captureId: Id,
  assetId: Id,
  language: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(35)),
  kind: Schema.Literals(["original_text", "extracted_text", "translation"]),
  text: BoundedText,
  derivation: Schema.String.check(Schema.isMaxLength(512)),
}).annotate({ identifier: "Representation" });
export const Capture = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  captureId: Id,
  sourceId: Id,
  startedAt: Instant,
  endedAt: Instant,
  submittedUrl: Schema.String,
  submittedAnchorId: ProviderId,
  focusIds: Schema.Array(ProviderId),
  observations: Schema.Array(Observation).check(Schema.isMaxLength(300)),
  assetIds: Schema.Array(Id),
  representations: Schema.Array(Representation),
  provenance: Schema.Struct({
    provider: Schema.String,
    runIds: Schema.Array(Schema.String),
    policyVersion: Schema.String,
  }),
  coverage: Schema.Struct({
    main: Schema.String,
    discussion: Schema.String,
    context: Schema.String,
  }),
  warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "Capture" });
export const Citation = Schema.Struct({
  citationId: Schema.String,
  sourceId: Id,
  captureId: Id,
  providerId: ProviderId,
  canonicalUrl: Schema.String,
}).annotate({ identifier: "Citation" });
export const Note = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  noteId: Id,
  kind: Schema.Literals(["material", "article"]),
  language: Schema.Literal("ru"),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  path: Schema.String.check(Schema.isMaxLength(240)),
  markdown: BoundedText,
  sourceId: Id,
  captureIds: Schema.Array(Id),
  citations: Schema.Array(Citation),
  relatedNoteIds: Schema.Array(Id),
  aliases: Schema.Array(Schema.String),
}).annotate({ identifier: "Note" });
export const Proposal = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operationId: Id,
  proposalId: Id,
  jobId: Id,
  baseRevision: Revision,
  notes: Schema.Array(Note).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  captures: Schema.Array(Capture).check(Schema.isMaxLength(2)),
  policyVersion: Schema.String,
  derivation: Schema.Struct({
    agent: Schema.String,
    model: Schema.String,
    skillVersion: Schema.String,
  }),
}).annotate({ identifier: "Proposal" });
export const Receipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operationId: Id,
  publicationId: Id,
  jobId: Id,
  appliedRevision: Revision,
  sequence: Schema.Int,
  noteIds: Schema.Array(Id),
  publishedAt: Instant,
}).annotate({ identifier: "Receipt" });
export const Snapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sources: Schema.Array(Source),
  captures: Schema.Array(Capture),
  assets: Schema.Array(Asset),
  notes: Schema.Array(Note),
}).annotate({ identifier: "Snapshot" });
export const NoteList = Schema.Struct({ appliedRevision: Revision, notes: Schema.Array(Note) });
export const NoteDetail = Schema.Struct({ appliedRevision: Revision, note: Note });
export const CaptureDetail = Schema.Struct({
  appliedRevision: Revision,
  capture: Capture,
  source: Source,
}).annotate({ identifier: "CaptureDetail" });
export const SearchRequest = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(512)),
  revision: Schema.optional(Revision),
}).annotate({ identifier: "SearchRequest" });
export const SearchResult = Schema.Struct({
  appliedRevision: Revision,
  results: Schema.Array(
    Schema.Struct({
      note: Note,
      matchedKind: Schema.Literals(["title", "body", "original"]),
      language: Schema.String,
      representationId: Schema.NullOr(Id),
      excerpt: Schema.String,
    }),
  ),
}).annotate({ identifier: "SearchResult" });
export const ReadRequest = Schema.Struct({ revision: Schema.optional(Revision) });
export type Draft = typeof Draft.Type;
export type Source = typeof Source.Type;
export type Capture = typeof Capture.Type;
export type Asset = typeof Asset.Type;
export type Note = typeof Note.Type;
export type Proposal = typeof Proposal.Type;
export type Receipt = typeof Receipt.Type;
export type Snapshot = typeof Snapshot.Type;
export type Slot = typeof Slot.Type;

export const CancelPublication = Schema.Struct({ operationId: Id });
export const CancellationResult = Schema.Struct({
  operationId: Id,
  outcome: Schema.Literals(["cancelled", "too_late", "rejected"]),
});
export const Compensation = Schema.Struct({
  operationId: Id,
  targetPublicationId: Id,
  expectedRevision: Revision,
});
export const OutboxEvent = Schema.Struct({ eventId: Id, operationId: Id, revision: Revision });
export const Outbox = Schema.Array(OutboxEvent);
export const AckEvent = Schema.Struct({ eventId: Id });
