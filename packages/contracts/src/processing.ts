import { Schema } from "effect";
import { ProviderId, Id, Instant, SourceInput, BoundedText } from "./knowledge.ts";

const RawText = Schema.String.check(Schema.isMaxLength(16_777_216));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Limit = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000));
export const CapturePolicy = Schema.Struct({
  version: Schema.String.check(Schema.isMinLength(1)),
  main: Limit,
  discussion: Limit,
  context: Limit,
  direct: Limit,
  latest: Limit,
  nestedReserve: Limit,
  preparedBytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_048_576)),
}).annotate({ identifier: "CapturePolicy" });
export const AcquisitionMode = Schema.Literals([
  "anchor",
  "parents",
  "author",
  "quotes",
  "article",
  "direct",
  "latest",
  "nested",
]);
export const AcquisitionRequest = Schema.Struct({
  key: Schema.String,
  mode: AcquisitionMode,
  allocations: Schema.Array(Schema.Struct({ targetId: ProviderId, limit: Limit })),
  limit: Limit,
  authorId: Schema.NullOr(ProviderId),
  conversationId: Schema.NullOr(ProviderId),
  sort: Schema.Literal("Latest"),
}).annotate({ identifier: "AcquisitionRequest" });
export const RawEvidence = Schema.Struct({
  assetId: Id,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  byteLength: Count,
  provider: Schema.String,
  runId: Schema.String,
  page: Count,
}).annotate({ identifier: "RawEvidence" });
export const UnprocessedReference = Schema.Struct({
  kind: Schema.Literals(["external_page", "image", "video", "audio", "article", "quote"]),
  url: Schema.String,
  fromProviderId: ProviderId,
  fromKind: Schema.Literals(["post", "article"]),
  reason: Schema.String,
}).annotate({ identifier: "UnprocessedReference" });
// Provider adapters map observed fields to this boundary; they may not infer
// missing parents/authors or turn a preview into a full article body.
export const XPost = Schema.Struct({
  authorHandle: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(128)))),
  authorName: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
  id: ProviderId,
  authorId: Schema.NullOr(ProviderId),
  parentId: Schema.NullOr(ProviderId),
  parentStatus: Schema.Literals(["root", "reply", "unknown"]),
  conversationId: Schema.NullOr(ProviderId),
  text: RawText,
  longText: Schema.NullOr(RawText),
  language: Schema.NullOr(Schema.String),
  quotedId: Schema.NullOr(ProviderId),
  articleId: Schema.NullOr(ProviderId),
  postedAt: Schema.NullOr(Instant),
  isBot: Schema.NullOr(Schema.Boolean),
  references: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["external_page", "image", "video", "audio"]),
      url: Schema.String,
    }),
  ),
}).annotate({ identifier: "XPost" });
export const XArticle = Schema.Struct({
  id: ProviderId,
  title: Schema.String,
  body: Schema.NullOr(RawText),
  bodyStatus: Schema.Literals(["acquired", "partial", "preview", "unavailable"]),
  language: Schema.NullOr(Schema.String),
  references: XPost.fields.references,
}).annotate({ identifier: "XArticle" });
export const AcquiredPage = Schema.Struct({
  raw: RawEvidence,
  posts: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(10000)),
  articles: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1000)),
}).annotate({ identifier: "AcquiredPage" });
export const AcquisitionResult = Schema.Struct({
  status: Schema.Literals([
    "succeeded",
    "partial",
    "unavailable",
    "failed",
    "budget",
    "deadline",
    "capacity",
  ]),
  pages: Schema.Array(AcquiredPage).check(Schema.isMaxLength(256)),
  diagnostics: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(64),
  ),
}).annotate({ identifier: "AcquisitionResult" });
export const AcquisitionOrigin = Schema.Struct({
  requestKey: Schema.String,
  mode: AcquisitionMode,
  raw: RawEvidence,
  row: Count,
}).annotate({ identifier: "AcquisitionOrigin" });
export const PreparedPost = Schema.Struct({
  post: XPost,
  canonicalUrl: Schema.String,
  role: Schema.Literals(["main", "discussion", "context", "quote"]),
  origins: Schema.Array(AcquisitionOrigin),
  textVariantDigests: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
}).annotate({ identifier: "PreparedPost" });
export const PreparedArticle = Schema.Struct({
  article: XArticle,
  canonicalUrl: Schema.String,
  origins: Schema.Array(AcquisitionOrigin),
}).annotate({ identifier: "PreparedArticle" });
export const PreparedMaterial = Schema.Struct({
  source: SourceInput,
  posts: Schema.Array(PreparedPost),
  article: Schema.NullOr(PreparedArticle),
  originalText: BoundedText,
  language: Schema.String,
}).annotate({ identifier: "PreparedMaterial" });
export const ProcessingInput = Schema.Struct({
  submittedUrl: Schema.String,
  policy: CapturePolicy,
  knownSources: Schema.Array(
    Schema.Struct({ primaryId: ProviderId, aliases: Schema.Array(ProviderId) }),
  ),
}).annotate({ identifier: "ProcessingInput" });
export const PreparedSource = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  outcome: Schema.Literals(["ready", "unavailable", "capacity", "identity_conflict"]),
  submittedUrl: Schema.String,
  normalizedUrl: Schema.String,
  anchorId: ProviderId,
  policy: CapturePolicy,
  materials: Schema.Array(PreparedMaterial).check(Schema.isMaxLength(2)),
  acquisitions: Schema.Array(
    Schema.Struct({
      request: AcquisitionRequest,
      status: AcquisitionResult.fields.status,
      raw: Schema.Array(RawEvidence),
      rowCount: Count,
      diagnostics: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
        Schema.isMaxLength(64),
      ),
    }),
  ),
  coverage: Schema.Struct({
    main: Schema.Literals(["unavailable", "bounded", "limited", "uncertain"]),
    discussion: Schema.Literals(["not_acquired", "bounded", "limited"]),
    missingParents: Schema.Array(ProviderId),
    warnings: Schema.Array(Schema.String),
    unprocessed: Schema.Array(UnprocessedReference),
  }),
  counts: Schema.Struct({
    acquiredRows: Count,
    malformedRows: Count,
    uniquePosts: Count,
    duplicateRows: Count,
    excludedPosts: Count,
    main: Count,
    discussion: Count,
    context: Count,
    parentLookups: Count,
    presentedPosts: Count,
    preparedBytes: Count,
  }),
}).annotate({ identifier: "PreparedSource" });
export type CapturePolicy = typeof CapturePolicy.Type;
export type AcquisitionRequest = typeof AcquisitionRequest.Type;
export type AcquisitionResult = typeof AcquisitionResult.Type;
export type AcquisitionOrigin = typeof AcquisitionOrigin.Type;
export type XPost = typeof XPost.Type;
export type XArticle = typeof XArticle.Type;
export type PreparedPost = typeof PreparedPost.Type;
export type PreparedArticle = typeof PreparedArticle.Type;
export type PreparedSource = typeof PreparedSource.Type;
export type ProcessingInput = typeof ProcessingInput.Type;
