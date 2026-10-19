import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitActorInput } from "../apps/knowledge-service/src/providers/admission.ts";

test("provider operations compose with actual job ownership and cancellation databases", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-provider-jobs-"));
  const child = Bun.spawn(
    [
      "python3",
      "tools/runtime/locked-service.py",
      process.execPath,
      "tests/helpers/provider-job-probe.ts",
    ],
    {
      env: { PATH: process.env.PATH, WIKI_DATA_DIR: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
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
}, 50000);

test("admitted Actor inputs exclude unbounded, mixed-mode or output-dropping options", () => {
  const input = {
    mode: "tweets",
    tweetIds: ["100"],
    maxItems: 1,
    maxItemsPerTarget: 1,
    queryType: "Latest",
    outputVariant: "raw",
    outputPreset: "nested",
    alwaysSaveRunRecords: true,
  } as const;
  expect(admitActorInput(JSON.stringify(input))).toEqual(input);
  for (const extra of [
    { maxItems: 0 },
    { maxItems: 1001 },
    { mode: "legacy" },
    { queryType: "Top" },
    { searchTerms: ["arbitrary"] },
    { fields: ["id"] },
    { replyTweetIds: ["200"] },
    { tweetIds: ["100", "100"] },
    { maxItemsPerTarget: 2 },
    { tweetIds: ["../other"] },
  ]) {
    expect(() => admitActorInput(JSON.stringify({ ...input, ...extra }))).toThrow();
  }
  expect(() =>
    admitActorInput(JSON.stringify(input).replace('"mode"', '"__proto__":{},"mode"')),
  ).toThrow();
});
