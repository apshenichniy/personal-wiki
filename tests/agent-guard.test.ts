import { sandboxCommand } from "../apps/runner/src/codex/sandbox.ts";
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
  const executable = join(workspace, "fake.py");
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
    argv:
      process.platform === "linux"
        ? await sandboxCommand({
            binary: python,
            workspace,
            codexHome: workspace,
            input,
            args: [executable],
          })
        : [python, executable],
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
  child.stdin.write(`heartbeat ${Date.now()}\n`);
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
  return setInterval(() => child.stdin.write(`heartbeat ${Date.now()}\n`), 100);
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
    'import os, signal, pathlib, time\ntry: pid=os.fork()\nexcept PermissionError: pid=0\nif pid==0:\n signal.signal(signal.SIGTERM, signal.SIG_IGN)\n pathlib.Path("descendant").write_text(str(os.getpid()))\n while True: time.sleep(.1)\nelse:\n while True: time.sleep(.1)\n',
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
    if (process.platform === "darwin")
      expect(alive(Number(await readFile(join(f.workspace, "descendant"), "utf8")))).toBe(false);
    else expect(await readFile(join(f.workspace, "descendant"), "utf8")).toMatch(/^[0-9]+$/);
    await expect(access(join(f.slot, "active.json"))).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 12000);

test("guardian death leaves both inherited exclusion and durable recovery evidence", async () => {
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
    expect([73, 74].includes((await second.exited) ?? -1)).toBe(true);
    if (alive(childPid)) process.kill(-childPid, "SIGKILL");
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

test("paused guardian keeps physical exclusion after its renewal expires", async () => {
  const f = await fixture(
    "import signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nwhile True: time.sleep(.1)\n",
  );
  try {
    const first = run(f.path);
    await running(first);
    first.child.kill("SIGSTOP");
    await sleep(1000);
    const second = run(f.path);
    expect(await second.exited).toBe(73);
    first.child.kill("SIGCONT");
    expect(await first.exited).toBe(0);
    const result = JSON.parse(await readFile(join(f.attempt, "exit.json"), "utf8"));
    expect(result.reason).toBe("heartbeat_lost");
    expect(result.processStopped).toBe(true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 12000);

test("a stale launch acknowledgment cannot start the executable", async () => {
  const f = await fixture('import pathlib\npathlib.Path("started").write_text("yes")\n');
  try {
    const child = spawn(python, [guard, f.path], { stdio: "pipe" });
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.write(`heartbeat ${Date.now() - 10000}\n`);
    const code = await new Promise((resolve) => child.once("close", resolve));
    expect(code).toBe(0);
    const result = JSON.parse(await readFile(join(f.attempt, "exit.json"), "utf8"));
    expect(result.reason).toBe("launch_lease_missing");
    expect(result.spawned).toBe(false);
    expect(
      await access(join(f.workspace, "started")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("proposal overflow is stopped while reading, without a truncated output checkpoint", async () => {
  const f = await fixture(
    'import pathlib\nwith open("output.json","w") as f:\n f.write("x"*2097152)\n',
  );
  try {
    const first = run(f.path);
    const timer = heartbeat(first.child);
    expect(await first.exited).toBe(0);
    clearInterval(timer);
    const result = JSON.parse(await readFile(join(f.attempt, "exit.json"), "utf8"));
    expect(result.reason).toBe("output_capacity");
    expect(result.outputDigest).toBe(null);
    expect(
      await access(join(f.attempt, "output.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 10000);

test("physical inspector distinguishes a completed spool, live helper, and ambiguous orphan", async () => {
  const f = await fixture(
    'import time\ntime.sleep(.4)\nopen("output.json","w").write(\'{"ok":true}\')',
  );
  const inspect = async () => {
    const child = Bun.spawn([
      python,
      join(import.meta.dir, "../tools/runtime/inspect-agent.py"),
      f.slot,
      f.attempt,
    ]);
    const value = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    return value.status;
  };
  try {
    expect(await inspect()).toBe("not_started");
    const first = run(f.path);
    const timer = heartbeat(first.child);
    await running(first);
    expect(await inspect()).toBe("running");
    expect(await first.exited).toBe(0);
    clearInterval(timer);
    expect(await inspect()).toBe("stopped");
    await rm(join(f.attempt, "exit.json"));
    expect(await inspect()).toBe("unknown");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("lifetime Runner lock survives exec and a paused Bun process", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-supervisor-"));
  const file = join(root, "probe.ts");
  await writeFile(file, 'console.log("ready");setInterval(()=>{},1000);');
  const start = () =>
    spawn(
      python,
      [join(import.meta.dir, "../tools/runtime/locked-runner.py"), process.execPath, file],
      { env: { PATH: process.env.PATH, WIKI_AGENT_SLOT: join(root, "slot") }, stdio: "pipe" },
    );
  const first = start();
  try {
    await new Promise<void>((resolve) => first.stdout.once("data", () => resolve()));
    first.kill("SIGSTOP");
    const second = start();
    second.stdout.resume();
    second.stderr.resume();
    expect(await new Promise((resolve) => second.once("close", resolve))).not.toBe(0);
    first.kill("SIGCONT");
    first.kill("SIGTERM");
    await new Promise((resolve) => first.once("close", resolve));
    const third = start();
    await new Promise<void>((resolve) => third.stdout.once("data", () => resolve()));
    third.kill("SIGTERM");
    await new Promise((resolve) => third.once("close", resolve));
  } finally {
    first.kill("SIGCONT");
    first.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("deadline and workspace overflow stop the child without an output checkpoint", async () => {
  for (const overflow of [false, true]) {
    const f = await fixture(
      overflow
        ? 'import os,time\nf=open("large","wb");f.truncate(270*1024*1024)\ntime.sleep(10)'
        : "import time\ntime.sleep(10)",
    );
    // Sparse size is counted, and the child is still subject to per-file limits.
    if (overflow) await writeFile(join(f.job, "large"), new Uint8Array(0));
    if (overflow) {
      const { truncate } = await import("node:fs/promises");
      await truncate(join(f.job, "large"), 270 * 1024 * 1024);
    } else {
      f.config.deadline = Date.now() + 500;
      await writeFile(f.path, JSON.stringify(f.config), { mode: 0o600 });
    }
    try {
      const first = run(f.path);
      const timer = heartbeat(first.child);
      expect(await first.exited).toBe(0);
      clearInterval(timer);
      const result = JSON.parse(await readFile(join(f.attempt, "exit.json"), "utf8"));
      expect(result.reason).toBe(overflow ? "workspace_capacity" : "deadline");
      expect(result.outputDigest).toBe(null);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
}, 10000);

test("kernel containment prevents fork+exec escape even when the child closes inherited descriptors", async () => {
  const f = await fixture(
    'import subprocess,sys,time,pathlib\ntry:\n child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n pathlib.Path("forked").write_text("yes")\nexcept PermissionError:\n pathlib.Path("forked").write_text("denied")\ntime.sleep(.1)\npathlib.Path("output.json").write_text("{}")',
  );
  try {
    const first = run(f.path);
    const timer = heartbeat(first.child);
    expect(await first.exited).toBe(0);
    clearInterval(timer);
    const result = JSON.parse(await readFile(join(f.attempt, "exit.json"), "utf8"));
    expect(result.processStopped).toBe(true);
    expect(await readFile(join(f.workspace, "forked"), "utf8")).toBe(
      process.platform === "darwin" ? "denied" : "yes",
    );
    const record = JSON.parse(await readFile(join(f.attempt, "process.json"), "utf8"));
    expect(alive(record.group)).toBe(false);
    // macOS cannot fork; Linux's PID-namespace init has exited, killing every
    // contained descendant independently of session or inherited descriptors.
    expect(await run(f.path).exited).toBe(75);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 10000);

test.skipIf(process.platform !== "linux")(
  "cleanup waits for a late inherited lock and reaps escaped-group descendants",
  async () => {
    const child = Bun.spawn([python, join(import.meta.dir, "helpers/agent-cleanup-probe.py")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, error }).toEqual({ status: 0, error: "" });
    expect(output).toContain("persistent holder remains blocked");
  },
  10000,
);
