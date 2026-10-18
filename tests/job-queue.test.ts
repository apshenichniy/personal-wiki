import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { Counters } from "@personal-wiki/contracts/jobs";

async function run(root: string, jobId: string, fault?: string) {
  const child = Bun.spawn(
    [
      "python3",
      "tools/runtime/locked-service.py",
      process.execPath,
      "tests/helpers/queue-probe.ts",
    ],
    {
      env: {
        PATH: process.env.PATH,
        WIKI_DATA_DIR: root,
        WIKI_TEST_JOB_ID: jobId,
        ...(fault ? { WIKI_TEST_FAULT: fault } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 18000);
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
const Result = Schema.fromJsonString(
  Schema.Struct({
    jobs: Schema.Int,
    jobId: Schema.String,
    counters: Counters,
    queueRows: Schema.Int,
    attempts: Schema.Int,
    stage: Schema.String,
    startedAt: Schema.Null,
    deadline: Schema.Null,
  }),
);
for (const fault of [undefined, "job-persisted", "queue-offered", "queue-claimed"]) {
  test(`service SQL queue preserves one accepted job across ${fault ?? "normal delivery"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-queue-"));
    const id = crypto.randomUUID();
    try {
      if (fault) {
        expect((await run(root, id, fault)).code).not.toBe(0);
        expect(await Bun.file(join(root, `fault-${fault}`)).exists()).toBe(true);
      }
      const completed = await run(root, id);
      expect(completed.code, completed.output + completed.errors).toBe(0);
      const result = Schema.decodeSync(Result)(completed.output.trim());
      expect(result.jobs).toBe(1);
      expect(result.jobId).toBe(id);
      expect(result.queueRows).toBe(1);
      expect(result.stage).toBe("failed");
      expect(result.counters).toEqual({ launches: 0, repair: 0, transient: 0, stale: 0 });
      if (fault === "queue-claimed") expect(result.attempts).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 25000);
}
