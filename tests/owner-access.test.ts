import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("owner OIDC and session boundary denies invalid identities, capabilities and revoked private reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-owner-"));
  const child = Bun.spawn(
    [
      "python3",
      "tools/runtime/locked-service.py",
      process.execPath,
      "tests/helpers/owner-access-probe.ts",
    ],
    {
      env: { PATH: process.env.PATH, WIKI_DATA_DIR: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 55_000);
  try {
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, output + errors).toBe(0);
    expect(output).toContain('"status":"passed"');
  } finally {
    clearTimeout(timeout);
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
