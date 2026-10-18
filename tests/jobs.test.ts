import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("durable synthetic workflow preserves output, budgets, epochs and publication results", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-jobs-"));
  const child = Bun.spawn(
    ["python3", "tools/runtime/locked-service.py", process.execPath, "tests/helpers/job-probe.ts"],
    {
      env: { PATH: process.env.PATH, WIKI_DATA_DIR: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 55000);
  try {
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, output + errors).toBe(0);
    expect(output).toContain('"status":"passed"');
  } finally {
    clearTimeout(timer);
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
