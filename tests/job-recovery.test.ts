import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
async function run(root: string, fault?: string) {
  const child = Bun.spawn(
    ["python3", "tools/runtime/locked-service.py", process.execPath, "tests/helpers/job-probe.ts"],
    {
      env: {
        PATH: process.env.PATH,
        WIKI_DATA_DIR: root,
        WIKI_TEST_JOB_CRASH: "1",
        ...(fault ? { WIKI_TEST_FAULT: fault } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 35000);
  try {
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output, errors };
  } finally {
    clearTimeout(timer);
  }
}
for (const fault of [
  "output-retained",
  "received",
  "prepared",
  "committing",
  "ref-advanced",
  "activating",
  "activated",
]) {
  test(`managed publication recovers one result and one launch after ${fault}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-job-recovery-"));
    try {
      const crash = await run(root, fault);
      expect(crash.code).not.toBe(0);
      expect(
        await Bun.file(join(root, `fault-${fault}`)).exists(),
        crash.output + crash.errors,
      ).toBe(true);
      const recovered = await run(root);
      expect(recovered.code, recovered.output + recovered.errors).toBe(0);
      expect(recovered.output).toContain('"status":"recovered"');
      expect(recovered.output).toContain('"launches":1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);
}
