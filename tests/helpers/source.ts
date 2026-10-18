import { createHash } from "node:crypto";
import { Effect } from "effect";
import { makeClient } from "@personal-wiki/client";
import * as K from "@personal-wiki/contracts/knowledge";
const checksum = (value: string) => createHash("sha256").update(value).digest("hex");
export async function prepareSource(
  client: Effect.Success<ReturnType<typeof makeClient>>,
  sources: (typeof K.ReserveRequest.Type)["sources"],
  upload = true,
) {
  const draft = await Effect.runPromise(
    client.knowledge.reserve({ payload: { requestId: crypto.randomUUID(), sources } }),
  );
  const current = await Effect.runPromise(client.knowledge.list({ query: {} }));
  const captures: K.Capture[] = [];
  const notes: K.Note[] = [];
  for (const slot of draft.slots) {
    const original =
      slot.source.kind === "x_article"
        ? "Efficient widget architecture and an article example."
        : "Durable widgets use a transactional outbox. Original-only keyword Flibbertigibbet.";
    if (upload)
      await Effect.runPromise(
        client.knowledge.upload({
          payload: {
            jobId: draft.jobId,
            assetId: slot.assetId,
            mediaType: "text/plain",
            base64: Buffer.from(original).toString("base64"),
            sha256: checksum(original),
          },
        }),
      );
    captures.push({
      schemaVersion: 1,
      captureId: slot.captureId,
      sourceId: slot.source.sourceId,
      startedAt: "2026-10-18T12:00:00.000Z",
      endedAt: "2026-10-18T12:00:01.000Z",
      submittedUrl: slot.source.canonicalUrl,
      submittedAnchorId: slot.source.primaryId,
      focusIds: [slot.source.primaryId],
      assetIds: [slot.assetId],
      observations: [
        {
          providerId: slot.source.primaryId,
          canonicalUrl: slot.source.canonicalUrl,
          text: original,
          authorId: "12345",
          parentId: null,
          conversationId: slot.source.primaryId,
          quotedId: null,
          articleId: null,
          postedAt: null,
        },
      ],
      representations: [
        {
          schemaVersion: 1,
          representationId: slot.representationId,
          captureId: slot.captureId,
          assetId: slot.assetId,
          language: "en",
          kind: "original_text",
          text: original,
          derivation: "Synthetic fixture; retained UTF-8 source.",
        },
      ],
      provenance: { provider: "synthetic", runIds: [], policyVersion: "fixture-v1" },
      coverage: { main: "acquired", discussion: "not_acquired", context: "not_required" },
      warnings: ["Synthetic evidence; no live provider."],
    });
    notes.push({
      schemaVersion: 1,
      noteId: slot.noteId,
      kind: slot.source.kind === "x_article" ? "article" : "material",
      language: "ru",
      title: slot.source.kind === "x_article" ? "Архитектура виджетов" : "Надёжная публикация",
      path: `notes/${slot.noteId}.md`,
      markdown: `# Синтетическая заметка\n\nТранзакционная публикация сохраняет согласованность. [Источник](${slot.source.canonicalUrl})\n`,
      sourceId: slot.source.sourceId,
      captureIds: [slot.captureId],
      citations: [
        {
          citationId: "c1",
          sourceId: slot.source.sourceId,
          captureId: slot.captureId,
          providerId: slot.source.primaryId,
          canonicalUrl: slot.source.canonicalUrl,
        },
      ],
      relatedNoteIds: draft.slots.filter((s) => s.noteId !== slot.noteId).map((s) => s.noteId),
      aliases: ["batch publication"],
    });
  }
  const proposal: K.Proposal = {
    schemaVersion: 1,
    operationId: crypto.randomUUID(),
    proposalId: crypto.randomUUID(),
    jobId: draft.jobId,
    baseRevision: current.appliedRevision,
    notes,
    captures,
    policyVersion: "fixture-v1",
    derivation: { agent: "synthetic", model: "none", skillVersion: "fixture-v1" },
  };
  return { draft, proposal };
}
export const postSource = (id: string) => ({
  kind: "x_post" as const,
  primaryId: id,
  aliases: [],
  resolution: "resolved" as const,
});
