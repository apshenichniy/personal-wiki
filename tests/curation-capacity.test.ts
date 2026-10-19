import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Effect } from "effect";
import { makeClient, makeJobClient } from "@personal-wiki/client";
import type { Claim } from "@personal-wiki/contracts/jobs";
import { launch } from "./helpers/service.ts";
import { prepareSource, postSource } from "./helpers/source.ts";
import { contextInput } from "../apps/runner/src/curation.ts";
import { editorial } from "./helpers/curation.ts";

test("compiled historical evidence exceeding publication capacity fails without another model launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-curation-capacity-"));
  let service = await launch(join(root, "library"));
  try {
    const seedClient = await Effect.runPromise(makeClient(service.url));
    const seed = await prepareSource(seedClient, [postSource("13300001")]);
    const original = {
      ...seed.proposal,
      notes: seed.proposal.notes.map((n) => ({
        ...n,
        markdown: n.markdown + (" ".repeat(99) + "\n").repeat(6000),
      })),
    };
    await Effect.runPromise(seedClient.knowledge.publish({ payload: original }));
    await service.stop();
    const credentials = ["runner", "operator"].map((role) => ({
      role,
      identityId: randomUUID(),
      token: `wk_${randomBytes(32).toString("base64url")}`,
    }));
    const path = join(root, "credentials.json");
    await writeFile(path, JSON.stringify({ credentials }), { mode: 0o600 });
    service = await launch(join(root, "library"), { WIKI_MACHINE_CREDENTIALS_FILE: path }, true);
    const client = await Effect.runPromise(makeJobClient(service.url, credentials[0]!.token));
    const owner = await Effect.runPromise(makeJobClient(service.url, credentials[1]!.token));
    const reader = await Effect.runPromise(makeClient(service.url, credentials[0]!.token));
    await Effect.runPromise(
      owner.jobs.submit({
        payload: {
          requestId: randomUUID(),
          mode: "refresh",
          url: "https://x.com/i/status/13300001",
        },
      }),
    );
    const instanceId = randomUUID();
    let claim: typeof Claim.Type = null;
    for (let i = 0; !claim && i < 100; i++) {
      claim = await Effect.runPromise(
        client.worker.claim({ payload: { requestId: randomUUID(), instanceId } }),
      );
      if (!claim) await Bun.sleep(20);
    }
    if (!claim) throw Error("No claim");
    const scope = claim.scope;
    const fixture = await prepareSource(
      {
        knowledge: {
          reserve: ({ payload }) => client.worker.reserve({ payload: { ...payload, scope } }),
          list: () => reader.knowledge.list({ query: {} }),
          upload: () => Effect.die("Explicit upload below"),
        },
      },
      [postSource("13300001")],
      false,
    );
    const text = "Changed substantive synthetic source. " + (" ".repeat(99) + "\n").repeat(2400);
    const captures = fixture.proposal.captures.map((c) => ({
      ...c,
      observations: c.observations.map((o) => ({ ...o, text })),
      representations: c.representations.map((r) => ({ ...r, text })),
    }));
    const slot = fixture.draft.slots[0]!;
    await Effect.runPromise(
      client.worker.upload({
        payload: {
          requestId: randomUUID(),
          scope,
          asset: {
            jobId: scope.jobId,
            assetId: slot.assetId,
            mediaType: "text/plain",
            base64: Buffer.from(text).toString("base64"),
            sha256: createHash("sha256").update(text).digest("hex"),
          },
        },
      }),
    );
    await Effect.runPromise(
      client.worker.prepare({ payload: { requestId: randomUUID(), scope, captures } }),
    );
    const context = await Effect.runPromise(
      client.worker.prepareCuration({ payload: { requestId: randomUUID(), scope, query: "" } }),
    );
    expect(context.previous[0]?.note.markdown.length).toBeGreaterThan(600000);
    expect(() => contextInput(context, "Synthetic capacity fixture")).not.toThrow();
    const attempt = await Effect.runPromise(
      client.worker.authorizeAttempt({
        payload: {
          requestId: randomUUID(),
          scope,
          reason: "initial",
          contextId: context.contextId,
          inputDigest: "a".repeat(64),
        },
      }),
    );
    const result = await Effect.runPromise(
      client.worker.completeAttempt({
        payload: {
          requestId: randomUUID(),
          scope,
          attemptId: attempt.attemptId,
          processStopped: true,
          outcome: "output",
          output: JSON.stringify(editorial(context)),
        },
      }),
    );
    expect(result.stage).toBe("failed");
    expect(result.reason).toBe("curation_capacity");
    expect(result.counters.launches).toBe(1);
    expect(result.counters.repair).toBe(0);
    expect((await Effect.runPromise(reader.knowledge.list({ query: {} }))).notes[0]!.markdown).toBe(
      original.notes[0]!.markdown,
    );
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
