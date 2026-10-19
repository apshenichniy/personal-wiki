import { Schema } from "effect";
import * as K from "./knowledge.ts";

export const curationModel = "gpt-5.6-sol" as const;
export const SkillVersion = Schema.Literal("x-curation-v1");
export const Excerpt = Schema.Struct({
  noteId: K.Id,
  revision: K.Revision,
  title: Schema.String,
  text: Schema.String,
  start: Schema.Int,
  end: Schema.Int,
});
export const CurationContext = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  skillVersion: SkillVersion,
  contextId: K.Id,
  jobId: K.Id,
  operationId: K.Id,
  proposalId: K.Id,
  baseRevision: K.Revision,
  draft: K.Draft,
  captures: Schema.Array(K.Capture),
  related: Schema.Array(Excerpt).check(Schema.isMaxLength(12)),
  previous: Schema.Array(Schema.Struct({ note: K.Note, captures: Schema.Array(K.Capture) })),
  feedback: Schema.Array(Schema.String),
}).annotate({ identifier: "CurationContext" });
const Prose = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000));
export const Passage = Schema.Struct({
  heading: Schema.NullOr(Schema.String.check(Schema.isMaxLength(240))),
  text: Prose,
  attribution: Schema.Literals(["source", "participant", "inference"]),
  supports: Schema.Array(K.ProviderId).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
});
export const Selection = Schema.Struct({
  postId: K.ProviderId,
  decision: Schema.Literals(["include", "omit", "consolidate"]),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export const CuratedNote = Schema.Struct({
  noteId: K.Id,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  overview: Passage,
  main: Schema.Array(Passage).check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  discussion: Schema.Array(Passage).check(Schema.isMaxLength(100)),
  selection: Schema.Array(Selection).check(Schema.isMaxLength(300)),
  relatedNoteIds: Schema.Array(K.Id).check(Schema.isMaxLength(13)),
  limitations: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  ).check(Schema.isMaxLength(32)),
});
export const CurationResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  skillVersion: SkillVersion,
  contextId: K.Id,
  notes: Schema.Array(CuratedNote).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
}).annotate({ identifier: "CurationResult" });
export type CurationContext = typeof CurationContext.Type;
export type CurationResult = typeof CurationResult.Type;
export type CuratedNote = typeof CuratedNote.Type;
export type Passage = typeof Passage.Type;
