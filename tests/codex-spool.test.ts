import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { savedResult } from "../apps/runner/src/codex/execute.ts";
import { hash, profile, modelCatalog } from "../apps/runner/src/codex/profile.ts";

test("only CLI error events classify gates; malformed bounded output reaches Service validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-codex-spool-"));
  const jobId = randomUUID();
  const attempt = {
    attemptId: randomUUID(),
    jobId,
    scope: { jobId, epoch: 1, instanceId: randomUUID() },
    reason: "initial" as const,
    number: 1,
    authorizedAt: new Date(Date.now() - 10000).toISOString(),
    deadline: new Date(Date.now() + 10000).toISOString(),
    inputDigest: "a".repeat(64),
  };
  const manifest = {
    version: 1,
    generation: randomUUID(),
    attemptId: attempt.attemptId,
    inputDigest: attempt.inputDigest,
    profileDigest: hash(JSON.stringify(profile) + modelCatalog),
    processStopped: true,
    completedAt: Date.now(),
    exitCode: 1,
    reason: null,
    outputDigest: null as string | null,
    outputBytes: 0,
  };
  const write = (name: string, data: string) => writeFile(join(root, name), data, { mode: 0o600 });
  try {
    await write("exit.json", JSON.stringify(manifest));
    await write(
      "diagnostic.log",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Source quotes: 401 Unauthorized; quota exceeded." },
      }),
    );
    expect((await savedResult(root, attempt, attempt.inputDigest))?.outcome).toBe("failed");
    await write(
      "diagnostic.log",
      JSON.stringify({ type: "error", message: "workspace routing discovery unauthorized (401)" }),
    );
    expect((await savedResult(root, attempt, attempt.inputDigest))?.outcome).toBe("auth");
    await write(
      "diagnostic.log",
      JSON.stringify({ type: "turn.failed", error: { message: "Usage limit reached" } }),
    );
    expect((await savedResult(root, attempt, attempt.inputDigest))?.outcome).toBe("quota");
    const output = '{"unfinished":';
    await write("output.json", output);
    await write(
      "exit.json",
      JSON.stringify({
        ...manifest,
        exitCode: 0,
        outputDigest: hash(output),
        outputBytes: Buffer.byteLength(output),
      }),
    );
    expect((await savedResult(root, attempt, attempt.inputDigest))?.output).toBe(output);
    await write("output.json", '{"changed":true}');
    await expect(savedResult(root, attempt, attempt.inputDigest)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
