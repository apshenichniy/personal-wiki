import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const python = Bun.which("python3")!;
const guard = join(import.meta.dir, "../tools/runtime/agent-guard.py");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(script: string) {
  const root = await mkdtemp(join(tmpdir(), "wiki-agent-"));
  const slot = join(root, "slot");
  const job = join(root, "job");
  const workspace = join(job, "work");
  const attempt = join(job, "attempt");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(attempt, { mode: 0o700 });
  await mkdir(slot, { mode: 0o700 });
  const executable = join(root, "fake.py");
  await writeFile(executable, script);
  const input = join(job, "input");
  await writeFile(input, "synthetic");
  const config = {
    attemptId: randomUUID(),
    slotDirectory: slot,
    attemptDirectory: attempt,
    jobRoot: job,
    workspace,
    inputFile: input,
    outputFile: join(workspace, "output.json"),
    argv: [python, executable],
    env: { PATH: "/usr/bin:/bin" },
    deadline: Date.now() + 15000,
    heartbeatTimeoutMs: 800,
    graceMs: 100,
    profileDigest: "a".repeat(64),
    inputDigest: "b".repeat(64),
  };
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return { root, slot, job, workspace, attempt, config, path };
}
function run(path: string) {
  const child = spawn(python, [guard, path], { stdio: "pipe" });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { child, exited, output: () => stdout };
}
async function running(process: ReturnType<typeof run>) {
  for (let n = 0; n < 100; n++) {
    if (process.output().includes('"running"')) return;
    if (process.child.exitCode !== null) throw Error(process.output());
    await sleep(20);
  }
  throw Error("Guardian did not start");
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function heartbeat(child: ChildProcessWithoutNullStreams) {
  child.stdin.on("error", () => {});
  return setInterval(() => child.stdin.write("heartbeat\n"), 100);
}

test("guardian spools exact result and prevents replay of an authorized launch", async () => {
  const f = await fixture(
    'import pathlib, time\ntime.sleep(.1)\npathlib.Path("output.json").write_text(\'{"ok":true}\')\n',
  );
  try {
    const first = run(f.path);
    const timer = heartbeat(first.child);
    expect(await first.exited).toBe(0);
    clearInterval(timer);
    const result = JSON.parse(await readFile(join(f.attempt, "exit.json"), "utf8"));
    expect(result.processStopped).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.outputBytes).toBe(11);
    expect(await readFile(join(f.attempt, "output.json"), "utf8")).toBe('{"ok":true}');
    const replay = run(f.path);
    expect(await replay.exited).toBe(75);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("lost renewal kills a TERM-resistant descendant before releasing the shared slot", async () => {
  const f = await fixture(
    'import os, signal, pathlib, time\npid=os.fork()\nif pid==0:\n signal.signal(signal.SIGTERM, signal.SIG_IGN)\n pathlib.Path("descendant").write_text(str(os.getpid()))\n while True: time.sleep(.1)\nelse:\n while True: time.sleep(.1)\n',
  );
  try {
    const first = run(f.path);
    await running(first);
    const second = run(f.path);
    expect(await second.exited).toBe(73);
    expect(await first.exited).toBe(0);
    const result = JSON.parse(await readFile(join(f.attempt, "exit.json"), "utf8"));
    expect(result.reason).toBe("heartbeat_lost");
    expect(result.processStopped).toBe(true);
    expect(alive(Number(await readFile(join(f.workspace, "descendant"), "utf8")))).toBe(false);
    await expect(access(join(f.slot, "active.json"))).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 12000);

test("guardian death leaves durable exclusion even after its flock is released", async () => {
  const f = await fixture(
    "import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nwhile True: time.sleep(.1)\n",
  );
  let childPid = 0;
  try {
    const first = run(f.path);
    await running(first);
    childPid = JSON.parse(await readFile(join(f.attempt, "process.json"), "utf8")).group;
    first.child.kill("SIGKILL");
    // Orphan retains pipe handles, so close may wait until the orphan is stopped.
    await sleep(100);
    const second = run(f.path);
    expect(await second.exited).toBe(74);
    expect(alive(childPid)).toBe(true);
    process.kill(-childPid, "SIGKILL");
    await first.exited;
  } finally {
    if (childPid && alive(childPid)) process.kill(-childPid, "SIGKILL");
    await rm(f.root, { recursive: true, force: true });
  }
}, 12000);

test("parent disconnect and diagnostic overflow terminate rather than publish", async () => {
  for (const overflow of [false, true]) {
    const f = await fixture(
      overflow
        ? 'import os\nwhile True: os.write(1,b"x"*65536)\n'
        : "import time\nwhile True: time.sleep(.1)\n",
    );
    try {
      const first = run(f.path);
      await running(first);
      const timer = heartbeat(first.child);
      if (!overflow) first.child.stdin.end();
      expect(await first.exited).toBe(0);
      clearInterval(timer);
      const result = JSON.parse(await readFile(join(f.attempt, "exit.json"), "utf8"));
      expect(result.reason).toBe(overflow ? "diagnostic_capacity" : "parent_disconnected");
      expect(result.outputDigest).toBe(null);
      const log = await readFile(join(f.attempt, "diagnostic.log"));
      expect(log.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
}, 15000);
