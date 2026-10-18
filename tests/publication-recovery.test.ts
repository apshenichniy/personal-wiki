import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { makeClient } from "@personal-wiki/client";
import { launch } from "./helpers/service.ts";
import { prepareSource, postSource } from "./helpers/source.ts";

async function journal(root: string) {
  const db = new Database(join(root, "library.sqlite"), { readonly: true });
  try {
    return {
      operations: db
        .query<{ candidate: string | null; phase: string; publisher_epoch: number }, []>(
          "SELECT candidate,phase,publisher_epoch FROM operations ORDER BY rowid",
        )
        .all(),
      receipts: db.query("SELECT * FROM receipts").all(),
      events: db.query("SELECT * FROM outbox").all(),
      captures: db.query<{ payload: string }, []>("SELECT payload FROM library_projection").get(),
    };
  } finally {
    db.close();
  }
}
async function git(root: string, ...args: string[]) {
  const child = Bun.spawn(["git", "--git-dir", join(root, "knowledge.git"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return output.trim();
}
async function marker(root: string, point: string) {
  for (let i = 0; i < 1000; i++) {
    if (await Bun.file(join(root, `fault-${point}`)).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Fault ${point} was not reached`);
}
const sources = [
  postSource("1111111111111111111"),
  { ...postSource("2222222222222222222"), kind: "x_article" as const },
];
for (const point of [
  "received",
  "candidate",
  "prepared",
  "committing",
  "ref-advanced",
  "committed",
  "activating",
  "activated",
]) {
  test(`restart reconciles the exact operation after process death at ${point}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-recovery-"));
    let server = await launch(root);
    try {
      const client = await Effect.runPromise(makeClient(server.url));
      const { proposal } = await prepareSource(client, sources);
      await server.stop();
      server = await launch(root, { WIKI_TEST_FAULT: point });
      await fetch(`${server.url}/api/v1/worker/publications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposal),
      }).catch(() => null);
      await server.child.exited;
      const before = await journal(root);
      const pinned = await git(root, "for-each-ref", "--format=%(objectname)", "refs/prepared/");
      expect(before.operations).toHaveLength(1);
      expect(before.receipts).toHaveLength(point === "activated" ? 1 : 0);
      // After commit intent recovery must not depend on re-acquiring originals.
      if (["ref-advanced", "committed", "activating", "activated"].includes(point))
        await rm(join(root, "objects"), { recursive: true });
      server = await launch(root);
      const recovered = await Effect.runPromise(makeClient(server.url));
      const receipt = await Effect.runPromise(recovered.knowledge.publish({ payload: proposal }));
      if (pinned) expect(receipt.appliedRevision).toBe(pinned);
      if (before.operations[0]?.candidate)
        expect(receipt.appliedRevision).toBe(before.operations[0].candidate);
      const list = await Effect.runPromise(recovered.knowledge.list({ query: {} }));
      expect(list.notes).toHaveLength(2);
      expect(list.appliedRevision).toBe(receipt.appliedRevision);
      expect(await git(root, "rev-list", "--count", "refs/heads/knowledge")).toBe("2");
      const after = await journal(root);
      expect(after.receipts).toHaveLength(1);
      expect(after.events).toHaveLength(1);
      expect(after.operations[0]?.phase).toBe("applied");
      expect(after.operations[0]!.publisher_epoch).toBeGreaterThan(
        before.operations[0]!.publisher_epoch,
      );
      expect(
        (
          await Effect.runPromise(
            recovered.knowledge.search({ payload: { query: "Flibbertigibbet" } }),
          )
        ).results,
      ).toHaveLength(1);
      await Effect.runPromise(recovered.knowledge.rebuild({}));
      expect(await Effect.runPromise(recovered.knowledge.publish({ payload: proposal }))).toEqual(
        receipt,
      );
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 25000);
}
for (const point of ["prepared", "committing", "ref-advanced"]) {
  test(`cancellation and consistent readers at the ${point} fence`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-cancel-"));
    const server = await launch(root, { WIKI_TEST_FAULT: point, WIKI_TEST_PAUSE: "1" });
    try {
      const client = await Effect.runPromise(makeClient(server.url));
      const { proposal } = await prepareSource(client, sources);
      const pending = fetch(`${server.url}/api/v1/worker/publications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposal),
      });
      await marker(root, point);
      const list = await Effect.runPromise(client.knowledge.list({ query: {} }));
      expect(list.appliedRevision).toBe(proposal.baseRevision);
      expect(list.notes).toHaveLength(0);
      expect(
        (await Effect.runPromise(client.knowledge.search({ payload: { query: "публикация" } })))
          .results,
      ).toHaveLength(0);
      const stopped = await Effect.runPromise(
        client.knowledge.cancelPublication({ payload: { operationId: proposal.operationId } }),
      );
      expect(stopped.outcome).toBe(point === "prepared" ? "cancelled" : "too_late");
      await writeFile(join(root, `release-${point}`), "release");
      expect((await pending).status).toBe(point === "prepared" ? 409 : 200);
      expect((await Effect.runPromise(client.knowledge.list({ query: {} }))).notes).toHaveLength(
        point === "prepared" ? 0 : 2,
      );
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}

test("compensation retains evidence and IDs, and lost acknowledgements replay one receipt/event", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-compensate-"));
  const server = await launch(root);
  try {
    const client = await Effect.runPromise(makeClient(server.url));
    const { proposal } = await prepareSource(client, sources);
    const receipt = await Effect.runPromise(client.knowledge.publish({ payload: proposal }));
    const events = await Effect.runPromise(client.knowledge.outbox({}));
    expect(events).toHaveLength(1);
    expect(await Effect.runPromise(client.knowledge.outbox({}))).toEqual(events);
    await Effect.runPromise(
      client.knowledge.ackEvent({ payload: { eventId: events[0]!.eventId } }),
    );
    await Effect.runPromise(
      client.knowledge.ackEvent({ payload: { eventId: events[0]!.eventId } }),
    );
    expect(await Effect.runPromise(client.knowledge.outbox({}))).toHaveLength(0);
    const undo = {
      operationId: crypto.randomUUID(),
      targetPublicationId: receipt.publicationId,
      expectedRevision: receipt.appliedRevision,
    };
    const compensated = await Effect.runPromise(client.knowledge.compensate({ payload: undo }));
    expect(compensated.appliedRevision).not.toBe(receipt.appliedRevision);
    expect((await Effect.runPromise(client.knowledge.list({ query: {} }))).notes).toHaveLength(0);
    expect(
      (await Effect.runPromise(client.knowledge.search({ payload: { query: "Flibbertigibbet" } })))
        .results,
    ).toHaveLength(0);
    expect(await Effect.runPromise(client.knowledge.compensate({ payload: undo }))).toEqual(
      compensated,
    );
    expect(await Effect.runPromise(client.knowledge.publish({ payload: proposal }))).toEqual(
      receipt,
    );
    await Effect.runPromise(client.knowledge.rebuild({}));
    expect((await Effect.runPromise(client.knowledge.list({ query: {} }))).notes).toHaveLength(0);
    const state = await journal(root);
    expect(state.receipts).toHaveLength(2);
    expect(state.events).toHaveLength(2);
    expect(state.captures?.payload).toContain(proposal.captures[0]!.captureId);
    expect(await git(root, "rev-list", "--count", "refs/heads/knowledge")).toBe("3");
    const again = await prepareSource(client, sources);
    expect(again.proposal.notes.map((n) => n.noteId)).toEqual(proposal.notes.map((n) => n.noteId));
    await Effect.runPromise(client.knowledge.publish({ payload: again.proposal }));
    const stale = await fetch(`${server.url}/api/v1/operator/compensations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...undo, operationId: crypto.randomUUID() }),
    });
    expect(stale.status).toBe(409);
    expect((await Effect.runPromise(client.knowledge.list({ query: {} }))).notes).toHaveLength(2);
    expect(await git(root, "rev-list", "--count", "refs/heads/knowledge")).toBe("4");
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("a stale publisher epoch cannot activate a callback; startup adopts the retained candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-epoch-"));
  let server = await launch(root, { WIKI_TEST_FAULT: "prepared", WIKI_TEST_PAUSE: "1" });
  try {
    const client = await Effect.runPromise(makeClient(server.url));
    const { proposal } = await prepareSource(client, sources);
    const pending = fetch(`${server.url}/api/v1/worker/publications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposal),
    });
    await marker(root, "prepared");
    const db = new Database(join(root, "library.sqlite"));
    try {
      db.run("UPDATE publisher_state SET epoch=epoch+1");
    } finally {
      db.close();
    }
    await writeFile(join(root, "release-prepared"), "release");
    expect((await pending).status).toBe(503);
    expect(await git(root, "rev-parse", "refs/heads/knowledge")).toBe(proposal.baseRevision);
    expect((await journal(root)).receipts).toHaveLength(0);
    await server.stop();
    server = await launch(root);
    const recovered = await Effect.runPromise(makeClient(server.url));
    expect(
      (await Effect.runPromise(recovered.knowledge.publish({ payload: proposal }))).sequence,
    ).toBe(1);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("a canonical ref that contradicts a committed journal fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-diverged-"));
  let server = await launch(root);
  try {
    const client = await Effect.runPromise(makeClient(server.url));
    const { proposal } = await prepareSource(client, sources);
    await server.stop();
    server = await launch(root, { WIKI_TEST_FAULT: "committed" });
    await fetch(`${server.url}/api/v1/worker/publications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposal),
    }).catch(() => null);
    await server.child.exited;
    await git(root, "update-ref", "refs/heads/knowledge", proposal.baseRevision);
    await expect(launch(root)).rejects.toThrow("Publication cannot be activated");
    expect((await journal(root)).operations[0]?.phase).toBe("committed");
    expect((await journal(root)).receipts).toHaveLength(0);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("genesis creation recovers an advanced ref before its first SQLite activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-genesis-"));
  try {
    await expect(launch(root, { WIKI_TEST_FAULT: "genesis" })).rejects.toThrow("Startup failed");
    const revision = await git(root, "rev-parse", "refs/heads/knowledge");
    const server = await launch(root);
    try {
      const client = await Effect.runPromise(makeClient(server.url));
      expect(await Effect.runPromise(client.knowledge.list({ query: {} }))).toEqual({
        appliedRevision: revision,
        notes: [],
      });
      expect(await git(root, "rev-list", "--count", "refs/heads/knowledge")).toBe("1");
    } finally {
      await server.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
