import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";

const start = (root: string, entry = "apps/knowledge-service/dist/index.js") =>
  Bun.spawn(["python3", "tools/runtime/locked-service.py", process.execPath, entry], {
    env: {
      PATH: process.env.PATH,
      WIKI_DATA_DIR: root,
      PORT: "0",
      WIKI_TEST_THREAD_SIGNAL: "1",
      WIKI_TEST_ORPHAN_MARKER: join(root, "orphan-ready.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
async function ready(child: ReturnType<typeof start>) {
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const reader = child.stdout.getReader();
    let text = "";
    while (!text.includes('"event":"ready"')) {
      const data = await reader.read();
      if (data.done)
        throw new Error(
          `Startup output: ${text}; stderr: ${await new Response(child.stderr).text()}`,
        );
      text += new TextDecoder().decode(data.value);
    }
    reader.releaseLock();
  } finally {
    clearTimeout(timer);
  }
}
async function rejected(root: string) {
  const second = start(root);
  const timer = setTimeout(() => second.kill("SIGKILL"), 3000);
  try {
    const [code, errors] = await Promise.all([second.exited, new Response(second.stderr).text()]);
    expect(code).not.toBe(0);
    expect(errors).toContain("still owns the storage lock");
  } finally {
    clearTimeout(timer);
  }
}

test("a paused publisher keeps exclusive ownership regardless of elapsed time", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-lock-paused-"));
  const first = start(root);
  try {
    await ready(first);
    process.kill(first.pid, "SIGSTOP");
    await Bun.sleep(150);
    await rejected(root);
    process.kill(first.pid, "SIGCONT");
    first.kill();
    await first.exited;
    const next = start(root);
    try {
      await ready(next);
    } finally {
      next.kill();
      await next.exited;
    }
  } finally {
    if (first.exitCode === null) {
      process.kill(first.pid, "SIGCONT");
      first.kill("SIGKILL");
      await first.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("an orphaned Git-capable child retains the lock after its parent dies", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-lock-orphan-"));
  const seed = start(root);
  let holder: ReturnType<typeof start> | undefined;
  let childPid: number | undefined;
  try {
    await ready(seed);
    seed.kill();
    await seed.exited;
    holder = start(root, "tests/helpers/lock-holder.ts");
    const marker = join(root, "orphan-ready.json");
    for (let i = 0; i < 200 && !(await Bun.file(marker).exists()); i++) await Bun.sleep(10);
    const markerValue = Schema.decodeSync(
      Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })),
    )(await readFile(marker, "utf8"));
    childPid = markerValue.pid;
    holder.kill("SIGKILL");
    await holder.exited;
    await rejected(root);
    await Bun.sleep(2200);
    const probe = Bun.spawn(
      ["git", "--git-dir", join(root, "knowledge.git"), "rev-parse", "refs/test/orphan"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await probe.exited).toBe(0);
    expect((await new Response(probe.stdout).text()).trim()).toMatch(/^[a-f0-9]{40}$/);
    childPid = undefined;
    const next = start(root);
    try {
      await ready(next);
    } finally {
      next.kill();
      await next.exited;
    }
  } finally {
    if (seed.exitCode === null) {
      seed.kill("SIGKILL");
      await seed.exited;
    }
    if (holder?.exitCode === null) {
      holder.kill("SIGKILL");
      await holder.exited;
    }
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* The child may already have exited. */
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("direct Bun startup without supervisor ownership never opens writable storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-unowned-"));
  try {
    const child = Bun.spawn([process.execPath, "apps/knowledge-service/dist/index.js"], {
      env: { PATH: process.env.PATH, WIKI_DATA_DIR: root, PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(await output).toContain("persistent-lock supervisor");
    await errors;
    expect(await Bun.file(join(root, "library.sqlite")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor handles a stop signal received by a non-main thread while waiting for Service", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-thread-signal-"));
  const child = start(root, "tests/helpers/signal-holder.ts");
  try {
    await ready(child);
    const completed = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(2000).then(() => false),
    ]);
    expect(completed).toBe(true);
  } finally {
    if (child.exitCode === null) {
      process.kill(child.pid, "SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 5000);
