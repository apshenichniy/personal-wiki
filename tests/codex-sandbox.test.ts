import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sandboxCommand } from "../apps/runner/src/codex/sandbox.ts";

test("actual OS boundary denies a same-user private file outside the admitted workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-boundary-"));
  try {
    const workspace = join(root, "workspace");
    const codexHome = join(root, "home");
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(codexHome, { mode: 0o700 });
    const secret = join(root, "outside-secret");
    const input = join(workspace, "input");
    const binary = join(root, "probe");
    await writeFile(secret, "synthetic-private", { mode: 0o600 });
    await writeFile(input, "admitted");
    const compiler = Bun.spawn(
      [
        "cc",
        join(import.meta.dir, "helpers/sandbox-probe.c"),
        "-o",
        binary,
        ...(process.platform === "darwin" ? ["-framework", "CoreFoundation"] : []),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await compiler.exited).toBe(0);
    const argv = await sandboxCommand({
      binary,
      workspace,
      codexHome,
      input,
      args: [secret, input],
    });
    const child = Bun.spawn(argv, {
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin", HOME: codexHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    const result = JSON.parse(out);
    expect(result.forbiddenReadable).toBe(false);
    expect(result.inputReadable).toBe(true);
    expect(result.secretEnvironment).toBe(false);
    if (process.platform === "darwin") expect(result.forkAllowed).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
