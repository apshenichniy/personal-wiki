import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { makeClient } from "@personal-wiki/client";
import * as K from "@personal-wiki/contracts/knowledge";

let server: Bun.Subprocess<"ignore", "pipe", "pipe">;
let root = "";
let url = "";
let client: Effect.Success<ReturnType<typeof makeClient>>;
const request = async (path: string, body?: unknown) => {
  const result = await fetch(
    `${url}${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  return { status: result.status, body: (await result.json()) as unknown };
};
const checksum = (value: string) => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "personal-wiki-library-"));
  server = Bun.spawn([process.execPath, "apps/knowledge-service/dist/index.js"], {
    env: { PATH: process.env.PATH, PORT: "0", WIKI_DATA_DIR: root },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const errors = new Response(server.stderr).text();
  const timer = setTimeout(() => server.kill("SIGKILL"), 10000);
  try {
    const reader = server.stdout.getReader();
    let text = "";
    while (!url) {
      const part = await reader.read();
      if (part.done) throw new Error(`Service did not start: ${await errors}`);
      text += new TextDecoder().decode(part.value);
      for (const line of text.split("\n").slice(0, -1))
        if (line.startsWith('{"event":"ready"'))
          url = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ url: Schema.String })))(
            line,
          ).url;
    }
    reader.releaseLock();
    client = await Effect.runPromise(makeClient(url));
  } finally {
    clearTimeout(timer);
  }
}, 15000);
afterAll(async () => {
  server?.kill();
  if (server) await server.exited;
  if (root) await rm(root, { recursive: true, force: true });
});

async function prepare(sources: (typeof K.ReserveRequest.Type)["sources"], upload = true) {
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
const postSource = (id: string) => ({
  kind: "x_post" as const,
  primaryId: id,
  aliases: [],
  resolution: "resolved" as const,
});
let first: Awaited<ReturnType<typeof prepare>>;
let receipt: K.Receipt;

test("retains a source/article batch and activates notes, original text and FTS together", async () => {
  first = await prepare([
    postSource("1111111111111111111"),
    { ...postSource("2222222222222222222"), kind: "x_article" },
  ]);
  expect((await Effect.runPromise(client.knowledge.list({ query: {} }))).notes).toHaveLength(0);
  const hidden = await request(`/api/v1/captures/${first.draft.slots[0]!.captureId}`);
  expect(hidden.status).toBe(404);
  const observations: Array<{ revision: string; count: number }> = [];
  let observing = true;
  const observe = (async () => {
    while (observing) {
      const list = await Effect.runPromise(client.knowledge.list({ query: {} }));
      observations.push({ revision: list.appliedRevision, count: list.notes.length });
      await Bun.sleep(2);
    }
  })();
  try {
    const [applied, duplicate] = await Promise.all([
      Effect.runPromise(client.knowledge.publish({ payload: first.proposal })),
      Effect.runPromise(client.knowledge.publish({ payload: first.proposal })),
    ]);
    receipt = applied;
    expect(duplicate).toEqual(receipt);
  } finally {
    observing = false;
    await observe;
  }
  const list = await Effect.runPromise(
    client.knowledge.list({ query: { revision: receipt.appliedRevision } }),
  );
  expect(list.notes).toHaveLength(2);
  expect(
    observations.every((o) =>
      o.revision === receipt.appliedRevision
        ? o.count === 2
        : o.revision === first.proposal.baseRevision && o.count === 0,
    ),
  ).toBe(true);
  const source = await Effect.runPromise(
    client.knowledge.capture({
      params: { captureId: first.draft.slots[0]!.captureId },
      query: { revision: receipt.appliedRevision },
    }),
  );
  expect(source.capture.representations[0]!.text).toContain("Flibbertigibbet");
  expect(source.appliedRevision).toBe(receipt.appliedRevision);
  const original = await Effect.runPromise(
    client.knowledge.search({
      payload: { query: "FLIBBERTIGIBBET", revision: receipt.appliedRevision },
    }),
  );
  expect(original.results).toHaveLength(1);
  expect(original.results[0]!.matchedKind).toBe("original");
  expect(original.results[0]!.language).toBe("en");
  expect(original.results[0]!.note.noteId).toBe(first.draft.slots[0]!.noteId);
  const russian = await Effect.runPromise(
    client.knowledge.search({ payload: { query: '"ПУБЛИКАЦИЯ" согласованность' } }),
  );
  expect(russian.results).toHaveLength(2);
  const malicious = await Effect.runPromise(
    client.knowledge.search({ payload: { query: '" OR *' } }),
  );
  expect(malicious.results).toHaveLength(0);
  const tooMany = await request("/api/v1/search", {
    query: Array.from({ length: 33 }, (_, i) => `term${i}`).join(" "),
  });
  expect(tooMany.status).toBe(400);
}, 15000);

test("replay returns the same receipt before stale-base and current asset checks", async () => {
  const path = join(root, "objects", first.draft.slots[0]!.assetId);
  const bytes = await readFile(path);
  await rm(path);
  try {
    const repeated = await Effect.runPromise(client.knowledge.publish({ payload: first.proposal }));
    expect(repeated).toEqual(receipt);
    const conflict = await request("/api/v1/worker/publications", {
      ...first.proposal,
      policyVersion: "different",
    });
    expect(conflict.status).toBe(409);
    const second = await request("/api/v1/worker/publications", {
      ...first.proposal,
      operationId: crypto.randomUUID(),
    });
    expect(second.status).toBe(409);
  } finally {
    await writeFile(path, bytes, { mode: 0o600 });
  }
});

test("invalid asset and mutation scope reject the whole batch without blocking subsequent work", async () => {
  const invalid = await prepare([postSource("3333333333333333333")], false);
  const before = await Effect.runPromise(client.knowledge.list({ query: {} }));
  expect((await request("/api/v1/worker/publications", invalid.proposal)).status).toBe(400);
  expect((await request("/api/v1/worker/publications", invalid.proposal)).status).toBe(400);
  expect((await Effect.runPromise(client.knowledge.list({ query: {} }))).appliedRevision).toBe(
    before.appliedRevision,
  );
  const slot = invalid.draft.slots[0]!;
  expect(
    (
      await request("/api/v1/worker/assets", {
        jobId: invalid.draft.jobId,
        assetId: slot.assetId,
        mediaType: "text/plain",
        base64: Buffer.from("x").toString("base64"),
        sha256: "0".repeat(64),
      })
    ).status,
  ).toBe(400);
  const unsafe = await prepare([postSource("4444444444444444444")]);
  expect(
    (
      await request("/api/v1/worker/publications", {
        ...unsafe.proposal,
        notes: unsafe.proposal.notes.map((n) => ({ ...n, path: "../escape.md" })),
      })
    ).status,
  ).toBe(400);
  const foreign = await prepare([postSource("5555555555555555555")]);
  expect(
    (
      await request("/api/v1/worker/publications", {
        ...foreign.proposal,
        notes: foreign.proposal.notes.map((n) => ({ ...n, noteId: first.draft.slots[0]!.noteId })),
      })
    ).status,
  ).toBe(400);
  expect((await Effect.runPromise(client.knowledge.list({ query: {} }))).notes).toHaveLength(2);
});

test("path changes and projection rebuild preserve IDs, pinned old citations, evidence and receipts", async () => {
  const next = await prepare([postSource("1111111111111111111")]);
  const original = first.proposal.notes[0]!;
  expect(next.draft.slots[0]!.noteId).toBe(original.noteId);
  const updated: K.Proposal = {
    ...next.proposal,
    notes: [
      {
        ...original,
        path: "notes/reorganized/material.md",
        title: "Переименованная заметка",
        captureIds: [...original.captureIds, next.draft.slots[0]!.captureId],
      },
    ],
  };
  const second = await Effect.runPromise(client.knowledge.publish({ payload: updated }));
  expect(second.sequence).toBe(2);
  const stale = await request(`/api/v1/notes?revision=${receipt.appliedRevision}`);
  expect(stale.status).toBe(409);
  const database = new Database(join(root, "library.sqlite"));
  const operationsBefore = database
    .query("SELECT operation_id,digest,phase FROM operations ORDER BY operation_id")
    .all();
  const receiptsBefore = database.query("SELECT payload FROM receipts ORDER BY operation_id").all();
  database.exec("DELETE FROM knowledge_fts");
  expect(
    (await Effect.runPromise(client.knowledge.search({ payload: { query: "Flibbertigibbet" } })))
      .results,
  ).toHaveLength(0);
  const rebuilt = await Effect.runPromise(client.knowledge.rebuild({}));
  expect(
    database.query("SELECT operation_id,digest,phase FROM operations ORDER BY operation_id").all(),
  ).toEqual(operationsBefore);
  expect(database.query("SELECT payload FROM receipts ORDER BY operation_id").all()).toEqual(
    receiptsBefore,
  );
  database.close();
  expect(rebuilt.appliedRevision).toBe(second.appliedRevision);
  const after = await Effect.runPromise(
    client.knowledge.note({ params: { noteId: original.noteId }, query: {} }),
  );
  expect(after.note.path).toBe("notes/reorganized/material.md");
  expect(after.note.citations).toEqual(original.citations);
  const oldSource = await Effect.runPromise(
    client.knowledge.capture({ params: { captureId: first.draft.slots[0]!.captureId }, query: {} }),
  );
  expect(oldSource.capture).toEqual(first.proposal.captures[0]!);
  expect(await Effect.runPromise(client.knowledge.publish({ payload: first.proposal }))).toEqual(
    receipt,
  );
  const search = await Effect.runPromise(
    client.knowledge.search({ payload: { query: "Flibbertigibbet" } }),
  );
  expect(search.results).toHaveLength(1);
}, 15000);

test("corrupt retained bytes prevent publication; conditional upload never overwrites an identity", async () => {
  const item = await prepare([postSource("6666666666666666666")]);
  const slot = item.draft.slots[0]!;
  const path = join(root, "objects", slot.assetId);
  const before = await readFile(path);
  const different = "Different retained content";
  const overwritten = await request("/api/v1/worker/assets", {
    jobId: item.draft.jobId,
    assetId: slot.assetId,
    mediaType: "text/plain",
    base64: Buffer.from(different).toString("base64"),
    sha256: checksum(different),
  });
  expect(overwritten.status).toBe(409);
  expect(await readFile(path)).toEqual(before);
  await writeFile(path, "corrupt");
  const current = await Effect.runPromise(client.knowledge.list({ query: {} }));
  const rejected = await request("/api/v1/worker/publications", item.proposal);
  expect(rejected.status).toBe(400);
  expect((await Effect.runPromise(client.knowledge.list({ query: {} }))).appliedRevision).toBe(
    current.appliedRevision,
  );
  await writeFile(path, before);
});

test("citation metadata cannot point to unobserved content or omit its inline evidence", async () => {
  const item = await prepare([postSource("7777777777777777777")]);
  const missingCitation = {
    ...item.proposal,
    notes: item.proposal.notes.map((n) => ({
      ...n,
      markdown: "Unsupported text without an inline source.",
    })),
  };
  expect((await request("/api/v1/worker/publications", missingCitation)).status).toBe(400);
  const incorrectCapture = {
    ...item.proposal,
    operationId: crypto.randomUUID(),
    notes: item.proposal.notes.map((n) => ({
      ...n,
      citations: n.citations.map((c) => ({ ...c, providerId: "8888888888888888888" })),
    })),
  };
  expect((await request("/api/v1/worker/publications", incorrectCapture)).status).toBe(400);
  const current = await Effect.runPromise(client.knowledge.list({ query: {} }));
  expect(current.notes).toHaveLength(2);
});
