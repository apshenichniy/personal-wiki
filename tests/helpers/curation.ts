import { randomUUID } from "node:crypto";
import type * as C from "@personal-wiki/contracts/curation";
import type * as K from "@personal-wiki/contracts/knowledge";
import { postSource, prepareSource } from "./source.ts";
import { Effect } from "effect";

export function editorial(context: C.CurationContext): C.CurationResult {
  return {
    schemaVersion: 1,
    skillVersion: context.skillVersion,
    contextId: context.contextId,
    notes: context.draft.slots.map((slot) => {
      const capture = context.captures.find((c) => c.captureId === slot.captureId)!;
      const passage = (id: string): C.Passage => ({
        heading: null,
        text: `Автор описывает надёжную публикацию и ограничения метода ${id}.`,
        attribution: "source",
        supports: [id],
      });
      const discussion = capture.observations.filter(
        (o) => !capture.focusIds.includes(o.providerId),
      );
      return {
        noteId: slot.noteId,
        title: "Надёжная публикация",
        overview: passage(capture.focusIds[0]!),
        main: capture.focusIds.map(passage),
        discussion: discussion
          .filter((o) => o.providerId !== "999")
          .map((o) => ({ ...passage(o.providerId), attribution: "participant" as const })),
        selection: discussion.map((o) => ({
          postId: o.providerId,
          decision: o.providerId === "999" ? ("omit" as const) : ("include" as const),
          reason: o.providerId === "999" ? "Empty praise" : "Concrete correction",
        })),
        relatedNoteIds: [],
        limitations: ["Ограниченный захват; независимой проверки нет."],
      };
    }),
  };
}
export async function contextFixture(article = false): Promise<C.CurationContext> {
  const sources = [
    postSource("100"),
    ...(article ? [{ ...postSource("900"), kind: "x_article" as const }] : []),
  ];
  const draft: K.Draft = {
    schemaVersion: 1,
    jobId: randomUUID(),
    slots: sources.map((s) => ({
      source: {
        schemaVersion: 1,
        ...s,
        sourceId: randomUUID(),
        externalKey: `x:${s.kind}:${s.primaryId}`,
        canonicalUrl: `https://x.com/i/${s.kind === "x_article" ? "article" : "status"}/${s.primaryId}`,
      },
      noteId: randomUUID(),
      captureId: randomUUID(),
      representationId: randomUUID(),
      assetId: randomUUID(),
    })),
  };
  const fixture = await prepareSource(
    {
      knowledge: {
        reserve: () => Effect.succeed(draft),
        list: () => Effect.succeed({ appliedRevision: "a".repeat(40), notes: [] }),
        upload: () => Effect.die("Not used"),
      },
    },
    sources,
    false,
  );
  const captures = fixture.proposal.captures.map((c, i) =>
    i
      ? c
      : {
          ...c,
          observations: [
            ...c.observations,
            ...["101", "201", "999"].map((id) => ({
              ...c.observations[0]!,
              providerId: id,
              canonicalUrl: `https://x.com/i/status/${id}`,
              text:
                id === "999"
                  ? "Great!"
                  : id === "101"
                    ? "Second substantive point"
                    : "Correction: only under stated conditions.",
              parentId: "100",
              isBot: id === "201",
            })),
          ],
          focusIds: ["100", "101"],
        },
  );
  return {
    schemaVersion: 1,
    skillVersion: "x-curation-v1",
    contextId: randomUUID(),
    jobId: draft.jobId,
    operationId: randomUUID(),
    proposalId: randomUUID(),
    baseRevision: fixture.proposal.baseRevision,
    draft,
    captures,
    related: [],
    previous: [],
    feedback: [],
  };
}
