import { Schema } from "effect";
import * as C from "@personal-wiki/contracts/curation";
import * as K from "@personal-wiki/contracts/knowledge";

export class CurationError extends Schema.TaggedError<CurationError>()("CurationError", {
  code: Schema.Literals(["quality", "capacity"]),
  checks: Schema.Array(Schema.String),
}) {}
const invalid = (...checks: string[]) => new CurationError({ code: "quality", checks });
const unique = (values: readonly string[]) => new Set(values).size === values.length;
// Model prose is plain text. Only this renderer creates Markdown links/markup.
export const prose = (text: string) => text.replace(/[\\`*_{}[\]()#+.!<>|~-]/g, "\\$&");
const canonical = (kind: string, id: string) =>
  kind === "x_article" ? `https://x.com/i/article/${id}` : `https://x.com/i/status/${id}`;

export function validateCuration(context: C.CurationContext, output: C.CurationResult) {
  const checks: string[] = [];
  if (output.contextId !== context.contextId || output.skillVersion !== context.skillVersion)
    checks.push("Output must use the supplied context and skill identities.");
  if (
    !unique(output.notes.map((n) => n.noteId)) ||
    output.notes.length !== context.draft.slots.length
  )
    checks.push("Produce exactly one note per admitted slot, including the acquired Article.");
  for (const note of output.notes) {
    const slot = context.draft.slots.find((s) => s.noteId === note.noteId);
    const capture = slot && context.captures.find((c) => c.captureId === slot.captureId);
    if (!slot || !capture) {
      checks.push("Note is outside the admitted scope.");
      continue;
    }
    const known = new Set(capture.observations.map((o) => o.providerId));
    const focus = new Set(capture.focusIds);
    const mainRefs = new Set(note.main.flatMap((p) => p.supports));
    if (![...focus].every((id) => mainRefs.has(id)))
      checks.push(
        `Detailed main body must cover every admitted main post: ${[...focus].filter((id) => !mainRefs.has(id)).join(",")}.`,
      );
    if (!note.main.every((p) => p.supports.some((id) => focus.has(id))))
      checks.push("Every main passage must cite admitted main material.");
    for (const passage of [note.overview, ...note.main, ...note.discussion]) {
      if (!unique(passage.supports) || passage.supports.some((id) => !known.has(id)))
        checks.push("Every passage must cite unique, capture-pinned post/Article IDs.");
      if (!/[А-Яа-яЁё]/u.test(passage.text))
        checks.push("Reading passages must be written in Russian.");
    }
    const eligible = capture.observations
      .filter((o) => !focus.has(o.providerId))
      .map((o) => o.providerId);
    if (
      !unique(note.selection.map((s) => s.postId)) ||
      note.selection.length !== eligible.length ||
      note.selection.some((s) => !eligible.includes(s.postId))
    )
      checks.push("Selection audit must account for each non-main observation exactly once.");
    const discussionRefs = new Set(note.discussion.flatMap((p) => p.supports));
    for (const selection of note.selection) {
      if (selection.decision !== "omit" && !discussionRefs.has(selection.postId))
        checks.push(
          `Included/consolidated post ${selection.postId} must appear in the discussion with its citation.`,
        );
      if (selection.decision === "omit" && discussionRefs.has(selection.postId))
        checks.push(`Omitted post ${selection.postId} cannot support selected discussion.`);
    }
    const allowed = new Set([
      ...context.related.map((n) => n.noteId),
      ...context.draft.slots.map((s) => s.noteId),
    ]);
    if (
      !unique(note.relatedNoteIds) ||
      note.relatedNoteIds.some((id) => id === note.noteId || !allowed.has(id))
    )
      checks.push("Related notes must come from the retrieved revision or this batch.");
    if (!note.limitations.length)
      checks.push(
        "Provide explicit source/processing limitations, including absence of independent verification.",
      );
  }
  if (checks.length) throw invalid(...[...new Set(checks)].slice(0, 64));
  return output;
}

const coverageLabels: Record<string, string> = {
  acquired: "получен",
  bounded: "захвачен в установленных пределах; полнота не гарантируется",
  limited: "неполный",
  partial: "частичный",
  uncertain: "полнота не установлена",
  unavailable: "недоступен",
  not_acquired: "не получено",
  not_required: "не требовался",
  not_applicable: "не применяется",
  preview: "только предварительный фрагмент",
};
const coverageLabel = (value: string) => coverageLabels[value] ?? "см. ограничения источника";

export function buildProposal(
  context: C.CurationContext,
  output: C.CurationResult,
  model: string,
): K.Proposal {
  validateCuration(context, output);
  const notes = output.notes.map((note): K.Note => {
    const slot = context.draft.slots.find((s) => s.noteId === note.noteId)!;
    const capture = context.captures.find((c) => c.captureId === slot.captureId)!;
    const citations = new Map<string, typeof K.Citation.Type>();
    const passage = (p: C.Passage) => {
      const links = p.supports
        .map((id) => {
          const observation = capture.observations.find((o) => o.providerId === id)!;
          if (observation.canonicalUrl !== canonical(slot.source.kind, id))
            throw invalid("Captured citation URL differs from its provider identity.");
          const key = `${capture.captureId}:${id}`;
          citations.set(key, {
            citationId: key,
            sourceId: slot.source.sourceId,
            captureId: capture.captureId,
            providerId: id,
            canonicalUrl: observation.canonicalUrl,
          });
          return `[Источник](${observation.canonicalUrl})`;
        })
        .join(" ");
      return `${p.heading ? `### ${prose(p.heading)}\n\n` : ""}${p.attribution === "inference" ? "Комментарий составителя: " : ""}${prose(p.text)} ${links}`;
    };
    const relatedIds = [
      ...new Set([
        ...note.relatedNoteIds,
        ...context.draft.slots.filter((s) => s.noteId !== note.noteId).map((s) => s.noteId),
      ]),
    ];
    const related = relatedIds.map((id) => {
      const title =
        context.related.find((n) => n.noteId === id)?.title ??
        output.notes.find((n) => n.noteId === id)?.title;
      return `- [${prose(title ?? id)}](/notes/${id})`;
    });
    const limitations = [
      ...new Set([
        ...note.limitations,
        ...(capture.warnings.length
          ? [
              "При захвате сохранены диагностические предупреждения; снимок не считается исчерпывающим.",
            ]
          : []),
        ...(slot.source.kind === "x_article" &&
        capture.warnings.includes("article_body_completeness_unverified")
          ? ["Полнота полученного тела статьи отдельно не подтверждена."]
          : []),
      ]),
    ];
    const emptyDiscussion = ["not_applicable", "not_acquired"].includes(capture.coverage.discussion)
      ? "Обсуждение этого материала отдельно не получено."
      : "Содержательных дополнений в отобранном обсуждении нет; это не означает отсутствия других ответов в X.";
    let markdown = `# ${prose(note.title)}\n\nИсточник: [X](${slot.source.canonicalUrl}). Захват: ${capture.endedAt}.\n\nПокрытие: основной материал — ${coverageLabel(capture.coverage.main)}; обсуждение — ${coverageLabel(capture.coverage.discussion)}; контекст — ${coverageLabel(capture.coverage.context)}.\n\n## Кратко\n\n${passage(note.overview)}\n\n## Подробный пересказ\n\n${note.main.map(passage).join("\n\n")}\n\n## Обсуждение\n\n${note.discussion.length ? note.discussion.map(passage).join("\n\n") : emptyDiscussion}\n\n## Связанные заметки\n\n${related.join("\n") || "Подходящие заметки в доступном контексте не найдены."}\n\n## Ограничения\n\n${limitations.map((x) => `- ${prose(x)}`).join("\n")}\n`;
    const previous = context.previous.find((p) => p.note.noteId === note.noteId);
    const captureIds = [capture.captureId];
    if (previous) {
      const changed = previous.note.citations.some((c) => {
        const before = previous.captures
          .find((p) => p.captureId === c.captureId)
          ?.observations.find((o) => o.providerId === c.providerId);
        const after = capture.observations.find((o) => o.providerId === c.providerId);
        return (
          !before ||
          !after ||
          before.text !== after.text ||
          ![...citations.values()].some((citation) => citation.providerId === c.providerId)
        );
      });
      if (changed) {
        markdown += `\n## Предыдущая версия — сохранённые свидетельства\n\nНовый захват не подтверждает все прежние цитаты в неизменном виде. Ниже сохранена предыдущая заметка как датированное свидетельство; расхождения не означают независимой проверки одной из версий. Даты захватов: ${[...new Set(previous.captures.map((c) => c.endedAt))].join(", ")}.\n\n${previous.note.markdown}\n`;
        for (const c of previous.note.citations)
          citations.set(`${c.captureId}:${c.providerId}`, {
            ...c,
            citationId: `${c.captureId}:${c.providerId}`,
          });
        captureIds.push(...previous.note.captureIds);
      }
    }
    return {
      schemaVersion: 1,
      noteId: note.noteId,
      kind: slot.source.kind === "x_article" ? "article" : "material",
      language: "ru",
      title: note.title,
      path: previous?.note.path ?? `notes/${note.noteId}.md`,
      markdown,
      sourceId: slot.source.sourceId,
      captureIds: [...new Set(captureIds)],
      citations: [...citations.values()],
      relatedNoteIds: relatedIds,
      aliases: previous?.note.aliases ?? [],
    };
  });
  const proposal: K.Proposal = {
    schemaVersion: 1,
    operationId: context.operationId,
    proposalId: context.proposalId,
    jobId: context.jobId,
    baseRevision: context.baseRevision,
    notes,
    captures: context.captures,
    policyVersion: "x-curation-v1",
    derivation: { agent: "codex", model, skillVersion: context.skillVersion },
  };
  if (Buffer.byteLength(JSON.stringify(proposal)) > 1048576)
    throw new CurationError({
      code: "capacity",
      checks: ["Compiled publication exceeds its byte ceiling; source text was not truncated."],
    });
  return proposal;
}
