import { expect, test } from "bun:test";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import * as K from "@personal-wiki/contracts/knowledge";
import { buildProposal, validateCuration, CurationError } from "../packages/curation/src/index.ts";
import { contextInput, curationOutputSchema } from "../apps/runner/src/curation.ts";
import { contextFixture, editorial } from "./helpers/curation.ts";

test("server builds two connected Russian notes, inline exact citations, selection audit and safe prose", async () => {
  const context = await contextFixture(true);
  const output = editorial(context);
  const result = buildProposal(context, output, "synthetic");
  expect(Schema.is(K.Proposal)(result)).toBe(true);
  expect(result.notes).toHaveLength(2);
  const note = result.notes[0]!;
  expect(note.relatedNoteIds).toEqual([result.notes[1]!.noteId]);
  expect(note.markdown).toContain("https://x.com/i/status/201");
  expect(note.markdown).not.toContain("https://x.com/i/status/999");
  expect(note.markdown).toContain("## Подробный пересказ");
  expect(note.markdown).toContain("## Обсуждение");
  expect(note.citations.map((c) => c.providerId)).toEqual(["100", "101", "201"]);
  expect(context.captures[0]!.observations).toHaveLength(4);
  expect(output.notes[0]!.selection).toContainEqual({
    postId: "999",
    decision: "omit",
    reason: "Empty praise",
  });
  expect(result.notes[1]!.markdown).toContain("https://x.com/i/article/900");
  const unsafe = {
    ...output,
    notes: output.notes.map((n) => ({
      ...n,
      main: n.main.map((p) => ({
        ...p,
        text: "Текст <script>alert(1)</script> [click](javascript:alert(1))",
      })),
    })),
  };
  const rendered = buildProposal(context, unsafe, "synthetic").notes[0]!.markdown;
  expect(rendered).toContain("\\<script\\>");
  expect(rendered).not.toContain("[click](javascript:");
});

test("quality checks reject missing main material, invented identities and contradictory selection", async () => {
  const context = await contextFixture();
  const valid = editorial(context);
  const note = valid.notes[0]!;
  const reject = (patch: Partial<typeof note>) =>
    expect(() => validateCuration(context, { ...valid, notes: [{ ...note, ...patch }] })).toThrow();
  reject({ main: [note.main[0]!] });
  reject({ noteId: randomUUID() });
  reject({ main: [{ ...note.main[0]!, supports: ["777"] }] });
  reject({ selection: [] });
  reject({ selection: note.selection.map((s) => ({ ...s, decision: "omit" })) });
  reject({ discussion: [] });
  reject({ relatedNoteIds: [randomUUID()] });
  reject({ limitations: [] });
  reject({ main: note.main.map((p) => ({ ...p, text: "English only" })) });
  expect(() => validateCuration(context, { ...valid, contextId: randomUUID() })).toThrow();
});

test("citation repair identifies the exact note and passage without allowing cross-material IDs", async () => {
  const context = await contextFixture(true);
  const valid = editorial(context);
  const note = valid.notes[0]!;
  const invalid = {
    ...valid,
    notes: [
      {
        ...note,
        overview: { ...note.overview, supports: ["100", "900"] },
        main: [{ ...note.main[0]!, supports: ["100", "100"] }, ...note.main.slice(1)],
      },
      valid.notes[1]!,
    ],
  };
  let checks: readonly string[] = [];
  try {
    validateCuration(context, invalid);
  } catch (error) {
    expect(error).toBeInstanceOf(CurationError);
    checks = (error as CurationError).checks;
  }
  expect(checks).toContain(
    `Note ${note.noteId}, overview: unexpected support IDs [900]. Use only this material's observation providerIds; link the other note through relatedNoteIds.`,
  );
  expect(checks).toContain(
    `Note ${note.noteId}, main[0]: repeated support IDs [100]. List each supporting ID once.`,
  );
  expect(() => validateCuration(context, valid)).not.toThrow();
});

test("weaker refresh preserves dated original evidence and stable note identity", async () => {
  const before = await contextFixture();
  const prior = buildProposal(before, editorial(before), "synthetic").notes[0]!;
  const id = randomUUID();
  const capture = {
    ...before.captures[0]!,
    captureId: id,
    endedAt: "2026-10-19T12:00:00.000Z",
    observations: before.captures[0]!.observations.filter((o) => o.providerId !== "201"),
    representations: before.captures[0]!.representations.map((r) => ({ ...r, captureId: id })),
  };
  const next = {
    ...before,
    contextId: randomUUID(),
    draft: { ...before.draft, slots: before.draft.slots.map((s) => ({ ...s, captureId: id })) },
    captures: [capture],
    previous: [{ note: prior, captures: before.captures }],
  };
  const refreshed = buildProposal(next, editorial(next), "synthetic").notes[0]!;
  expect(refreshed.noteId).toBe(prior.noteId);
  expect(refreshed.path).toBe(prior.path);
  expect(refreshed.captureIds).toEqual([id, before.captures[0]!.captureId]);
  expect(refreshed.markdown).toContain("Предыдущая версия");
  expect(refreshed.markdown).toContain("https://x.com/i/status/201");
  expect(refreshed.markdown).toContain(before.captures[0]!.endedAt);
  expect(refreshed.markdown).toContain(`"wiki-citation:${id}:100"`);
  expect(refreshed.markdown).toContain(`"wiki-citation:${before.captures[0]!.captureId}:100"`);
  // Even an unchanged capture must not silently drop a previously useful reply.
  const omission = editorial(before);
  const omitted = {
    ...omission,
    notes: omission.notes.map((n) => ({
      ...n,
      discussion: [],
      selection: n.selection.map((s) => ({ ...s, decision: "omit" as const })),
    })),
  };
  expect(
    buildProposal(
      { ...before, previous: [{ note: prior, captures: before.captures }] },
      omitted,
      "synthetic",
    ).notes[0]!.markdown,
  ).toContain("Предыдущая версия");
});

test("model context includes full main text and bot/role metadata; capacity fails without truncation", async () => {
  const context = await contextFixture();
  const input = contextInput(context, "Synthetic instructions");
  expect(input.prompt).toContain("Second substantive point");
  expect(input.prompt).toContain('"isBot":true');
  expect(input.prompt).not.toContain('"representations"');
  expect(() =>
    contextInput(
      {
        ...context,
        captures: context.captures.map((c) => ({
          ...c,
          observations: c.observations.map((o) => ({
            ...o,
            text: "Long source details ".repeat(100000),
          })),
        })),
      },
      "Synthetic",
    ),
  ).toThrow();
});

test("Codex output schema has an inline object root with recursively closed objects", () => {
  const schema = JSON.parse(curationOutputSchema());
  expect(schema.type).toBe("object");
  expect(schema.$ref).toBeUndefined();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if ("type" in value && value.type === "object") {
      expect("additionalProperties" in value && value.additionalProperties).toBe(false);
    }
    Object.values(value).forEach(visit);
  };
  visit(schema);
});

test("unprocessed sources remain safe explicit links even when the model omits the warning", async () => {
  const context = await contextFixture();
  const warning = (url: string, kind = "external_page", fromProviderId = "100") =>
    "unprocessed:" +
    JSON.stringify({
      kind,
      url,
      fromKind: "post",
      fromProviderId,
      reason: "processor_not_supported",
    });
  const captures = context.captures.map((c) => ({
    ...c,
    warnings: [
      ...c.warnings,
      warning("https://example.com/report"),
      warning("https://x.com/i/article/910", "article"),
      warning("javascript:alert(1)"),
      warning("https://other.example/", "image", "777"),
      warning("https://example.com/x)text("),
    ],
  }));
  const note = buildProposal({ ...context, captures }, editorial(context), "synthetic").notes[0]!;
  expect(note.markdown).toContain("[открыть источник](https://example.com/report) — не обработано");
  expect(note.markdown).toContain("https://x.com/i/article/910");
  expect(note.markdown).toContain("https://example.com/x%29text%28");
  expect(note.markdown).not.toContain("javascript:");
  expect(note.markdown).not.toContain("https://other.example/");
  expect(note.markdown).not.toContain("unprocessed:");
});
