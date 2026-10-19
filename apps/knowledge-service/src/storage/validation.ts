import { citationTitle } from "@personal-wiki/contracts/citation";
import { Snapshot, Proposal, Draft, Note, Asset } from "@personal-wiki/contracts/knowledge";
import { invalid } from "./io.ts";

const unique = (values: ReadonlyArray<string>, label: string) => {
  if (new Set(values).size !== values.length) throw invalid(`Duplicate ${label}.`);
};
export const canonicalUrl = (kind: string, id: string) =>
  kind === "x_article" ? `https://x.com/i/article/${id}` : `https://x.com/i/status/${id}`;
export function validateBatch(
  proposal: Proposal,
  draft: Draft,
  current: Snapshot,
  readyAssets: ReadonlyArray<Asset>,
  jobAssetIds: ReadonlyArray<string> = [],
): Snapshot {
  if (Buffer.byteLength(JSON.stringify(proposal)) > 1_048_576)
    throw invalid("Proposal exceeds the 1 MiB limit.");
  unique(
    proposal.notes.map((n) => n.noteId),
    "note identity",
  );
  unique(
    proposal.captures.map((c) => c.captureId),
    "capture identity",
  );
  const captures = [...current.captures];
  for (const capture of proposal.captures) {
    const slot = draft.slots.find(
      (s) => s.captureId === capture.captureId && s.source.sourceId === capture.sourceId,
    );
    if (!slot) throw invalid("Capture is outside the reserved job scope.");
    if (captures.some((c) => c.captureId === capture.captureId))
      throw invalid("A finalized capture is immutable.");
    if (
      !capture.focusIds.includes(slot.source.primaryId) ||
      !capture.observations.some((o) => o.providerId === slot.source.primaryId && o.text.trim())
    )
      throw invalid("The admitted main source is missing.");
    if (
      new Date(capture.startedAt).toISOString() !== capture.startedAt ||
      new Date(capture.endedAt).toISOString() !== capture.endedAt ||
      capture.startedAt > capture.endedAt
    )
      throw invalid("Invalid capture timestamps.");
    unique(
      capture.observations.map((o) => o.providerId),
      "observation",
    );
    for (const observation of capture.observations)
      if (observation.canonicalUrl !== canonicalUrl(slot.source.kind, observation.providerId))
        throw invalid("Observation URL does not identify the retained post/article.");
    for (const assetId of capture.assetIds)
      if (
        !draft.slots.some((s) => s.assetId === assetId) &&
        !current.assets.some((a) => a.assetId === assetId) &&
        !jobAssetIds.includes(assetId)
      )
        throw invalid("Asset is outside the reserved or published scope.");
    if (!capture.assetIds.includes(slot.assetId)) throw invalid("A retained asset is required.");
    unique(
      capture.representations.map((r) => r.representationId),
      "representation identity",
    );
    unique(capture.assetIds, "asset reference");
    for (const representation of capture.representations) {
      if (
        representation.representationId !== slot.representationId ||
        representation.captureId !== capture.captureId ||
        !capture.assetIds.includes(representation.assetId)
      )
        throw invalid("Invalid representation provenance.");
    }
    if (!capture.representations.length)
      throw invalid("A retained reading representation is required.");
    captures.push(capture);
  }
  const notes: Note[] = current.notes.filter(
    (n) => !proposal.notes.some((changed) => changed.noteId === n.noteId),
  );
  for (const note of proposal.notes) {
    const slot = draft.slots.find(
      (s) => s.noteId === note.noteId && s.source.sourceId === note.sourceId,
    );
    if (!slot) throw invalid("Note is outside the reserved job scope.");
    if ((slot.source.kind === "x_article") !== (note.kind === "article"))
      throw invalid("Note kind differs from its source.");
    if (!/^notes\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.md$/.test(note.path))
      throw invalid("Unsafe note path.");
    if (!note.markdown.trim() || !note.captureIds.length || !note.citations.length)
      throw invalid("Note must contain source-backed content.");
    unique(note.captureIds, "capture reference");
    unique(
      note.citations.map((c) => c.citationId),
      "citation identity",
    );
    for (const id of note.captureIds)
      if (!captures.some((c) => c.captureId === id && c.sourceId === note.sourceId))
        throw invalid("Unknown or mismatched note capture.");
    for (const citation of note.citations) {
      const capture = captures.find(
        (c) => c.captureId === citation.captureId && c.sourceId === citation.sourceId,
      );
      const observation = capture?.observations.find((o) => o.providerId === citation.providerId);
      if (
        !note.captureIds.includes(citation.captureId) ||
        !observation ||
        observation.canonicalUrl !== citation.canonicalUrl ||
        !(
          note.markdown.includes(`](${citation.canonicalUrl})`) ||
          note.markdown.includes(
            `](${citation.canonicalUrl} "${citationTitle(citation.citationId)}")`,
          )
        )
      )
        throw invalid("Citation does not resolve to retained inline evidence.");
    }
    notes.push(note);
  }
  unique(
    notes.map((n) => n.path),
    "note path",
  );
  unique(
    notes.map((n) => n.sourceId),
    "source note",
  );
  for (const note of notes)
    for (const related of note.relatedNoteIds)
      if (related === note.noteId || !notes.some((n) => n.noteId === related))
        throw invalid("Related note does not exist in the proposed tree.");
  const sources = [...current.sources];
  for (const slot of draft.slots)
    if (captures.some((c) => c.sourceId === slot.source.sourceId)) {
      const index = sources.findIndex((s) => s.sourceId === slot.source.sourceId);
      if (index < 0) sources.push(slot.source);
      else sources[index] = slot.source;
    }
  const assets = [...current.assets];
  for (const capture of captures)
    for (const id of capture.assetIds) {
      const asset = readyAssets.find((a) => a.assetId === id);
      if (!asset) throw invalid("Capture references a missing or unverified asset.");
      if (!assets.some((a) => a.assetId === id)) assets.push(asset);
    }
  return { schemaVersion: 1, sources, captures, assets, notes };
}
export function queryTerms(query: string) {
  if (query.length > 512) throw invalid("Search is limited to 512 characters.");
  const terms = query.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  if (terms.length > 32) throw invalid("Search is limited to 32 terms.");
  return [...new Set(terms.map((term) => term.toLowerCase()))]
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}
