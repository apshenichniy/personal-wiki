import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { makeClient, makeJobClient } from "@personal-wiki/client";
import { launch } from "./helpers/service.ts";
import { postSource, prepareSource } from "./helpers/source.ts";
import { recoveryArchive } from "../apps/knowledge-service/src/storage/recovery-archive.ts";
import { digest } from "../apps/knowledge-service/src/storage/io.ts";

async function prepare(root: string, originals: string) {
  const child = Bun.spawn(
    [
      "python3",
      "tools/runtime/locked-service.py",
      process.execPath,
      "tools/prepare-restore.ts",
      root,
      originals,
    ],
    { env: { PATH: process.env.PATH, WIKI_DATA_DIR: root }, stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, errors).toBe(0);
  } finally {
    clearTimeout(timer);
  }
}

test("recovery originals require exact bytes and cannot fall back to primary storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-original-restore-"));
  try {
    const bytes = Buffer.from("Retained source, with qualifications.");
    const object = {
      key: "providers/staging/source/page.json",
      sha256: digest(bytes),
      byteLength: bytes.length,
    };
    const archive = recoveryArchive(root);
    await writeFile(join(root, object.sha256), bytes, { mode: 0o600 });
    expect(await Effect.runPromise(archive.read(object))).toEqual(bytes);
    expect((await Effect.runPromise(archive.retain(object, bytes).pipe(Effect.result)))._tag).toBe(
      "Failure",
    );
    await writeFile(join(root, object.sha256), Buffer.alloc(bytes.length));
    expect((await Effect.runPromise(archive.read(object).pipe(Effect.result)))._tag).toBe(
      "Failure",
    );
    await rm(join(root, object.sha256));
    await symlink("/etc/hosts", join(root, object.sha256));
    expect((await Effect.runPromise(archive.read(object).pipe(Effect.result)))._tag).toBe(
      "Failure",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restored publication completes once from its pinned candidate without new acquisition", async () => {
  const temp = await mkdtemp(join(tmpdir(), "wiki-restore-intent-"));
  const root = join(temp, "live"),
    cut = join(temp, "cut"),
    originals = join(temp, "originals");
  await mkdir(originals, { mode: 0o700 });
  let service = await launch(root);
  try {
    const client = await Effect.runPromise(makeClient(service.url));
    const { proposal } = await prepareSource(client, [postSource("1177330000000000001")]);
    await service.stop();
    service = await launch(root, { WIKI_TEST_FAULT: "ref-advanced" });
    await fetch(service.url + "/api/v1/worker/publications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposal),
    }).catch(() => null);
    await service.child.exited;
    const copy = Bun.spawn(
      [
        "python3",
        "-c",
        "import sys;sys.path.insert(0,'ops/backup');from core import copy_cut;copy_cut(sys.argv[1],sys.argv[2])",
        root,
        cut,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await copy.exited, await new Response(copy.stderr).text()).toBe(0);
    await prepare(cut, originals);
    const db = new Database(join(cut, "library.sqlite"), { readonly: true });
    try {
      expect(db.query("SELECT operation_id FROM receipts").all()).toHaveLength(1);
      expect(db.query("SELECT phase FROM operations").get()).toEqual({ phase: "applied" });
    } finally {
      db.close();
    }
    service = await launch(cut);
    const restored = await Effect.runPromise(makeClient(service.url));
    const first = await Effect.runPromise(restored.knowledge.publish({ payload: proposal }));
    expect(await Effect.runPromise(restored.knowledge.publish({ payload: proposal }))).toEqual(
      first,
    );
    expect(
      (
        await Effect.runPromise(
          restored.knowledge.search({ payload: { query: "Flibbertigibbet" } }),
        )
      ).results,
    ).toHaveLength(1);
  } finally {
    await service.stop();
    await rm(temp, { recursive: true, force: true });
  }
}, 30000);

test("restore revokes old capabilities, preserves old launch limits and permits only new controlled work", async () => {
  const temp = await mkdtemp(join(tmpdir(), "wiki-restore-access-"));
  const root = join(temp, "library"),
    originals = join(temp, "originals"),
    config = join(temp, "credentials.json"),
    runnerPath = join(temp, "runner-token");
  await mkdir(originals, { mode: 0o700 });
  const oldOperator = `wk_${randomBytes(32).toString("base64url")}`,
    oldRunner = `wk_${randomBytes(32).toString("base64url")}`;
  const writeCredentials = async (operator: string, runner: string) =>
    writeFile(
      config,
      JSON.stringify({
        credentials: [
          { identityId: randomUUID(), role: "operator", token: operator },
          { identityId: randomUUID(), role: "runner", token: runner },
        ],
      }),
      { mode: 0o600 },
    );
  await writeCredentials(oldOperator, oldRunner);
  let service = await launch(root, { WIKI_MACHINE_CREDENTIALS_FILE: config }, true);
  try {
    const client = await Effect.runPromise(makeJobClient(service.url, oldOperator));
    const accepted = await Effect.runPromise(
      client.jobs.submit({
        payload: {
          requestId: randomUUID(),
          mode: "save",
          url: "https://x.com/example/status/91001",
        },
      }),
    );
    const oldId = accepted.job!.jobId;
    await service.stop();
    const db = new Database(join(root, "library.sqlite"));
    const row = db
      .query<{ record: string }, [string]>("SELECT record FROM ingestion_jobs WHERE job_id=?")
      .get(oldId)!;
    const old = JSON.parse(row.record);
    old.startedAt = Date.now() - 1000;
    old.deadline = Date.now() + 600000;
    old.counters.launches = 2;
    db.run("UPDATE ingestion_jobs SET record=? WHERE job_id=?", [JSON.stringify(old), oldId]);
    db.run("INSERT INTO owner_sessions VALUES ('old-session','old-owner',?)", [
      Date.now() + 600000,
    ]);
    db.close();
    await prepare(root, originals);
    const restoredDb = new Database(join(root, "library.sqlite"), { readonly: true });
    try {
      const after = JSON.parse(
        restoredDb
          .query<{ record: string }, [string]>("SELECT record FROM ingestion_jobs WHERE job_id=?")
          .get(oldId)!.record,
      );
      expect(after).toMatchObject({
        stage: "blocked",
        reason: "restore_accounting_unknown",
        deadline: old.deadline,
        counters: old.counters,
      });
      expect(restoredDb.query("SELECT * FROM owner_sessions").all()).toHaveLength(0);
      expect(
        restoredDb.query("SELECT * FROM machine_credentials WHERE revoked=0").all(),
      ).toHaveLength(0);
    } finally {
      restoredDb.close();
    }
    const operator = `wk_${randomBytes(32).toString("base64url")}`,
      runner = `wk_${randomBytes(32).toString("base64url")}`;
    await writeCredentials(operator, runner);
    await writeFile(runnerPath, runner, { mode: 0o600 });
    service = await launch(root, { WIKI_MACHINE_CREDENTIALS_FILE: config }, true);
    for (const token of [oldOperator, oldRunner])
      expect(
        (
          await fetch(service.url + "/api/v1/notes", {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(401);
    const fresh = await Effect.runPromise(makeJobClient(service.url, operator));
    expect(
      (await Effect.runPromise(fresh.jobs.get({ params: { jobId: oldId } }))).allowedActions,
    ).toEqual([]);
    expect(
      (
        await Effect.runPromise(
          fresh.jobs
            .resume({ payload: { requestId: randomUUID(), jobId: oldId } })
            .pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure");
    await Effect.runPromise(
      fresh.jobs.submit({
        payload: {
          requestId: randomUUID(),
          mode: "save",
          url: "https://x.com/example/status/91002",
        },
      }),
    );
    const child = Bun.spawn([process.execPath, "apps/runner/dist/synthetic.js"], {
      env: {
        PATH: process.env.PATH,
        WIKI_SERVICE_URL: service.url,
        WIKI_RUNNER_TOKEN_FILE: runnerPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    try {
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, output + errors).toBe(0);
      expect(output).toContain('"stage":"succeeded"');
    } finally {
      clearTimeout(timer);
    }
    expect(
      (await Effect.runPromise(fresh.jobs.get({ params: { jobId: oldId } }))).counters.launches,
    ).toBe(2);
  } finally {
    await service.stop();
    await rm(temp, { recursive: true, force: true });
  }
}, 45000);
