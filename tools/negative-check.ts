import assert from "node:assert/strict";
import { Schema } from "effect";

const child = Bun.spawn(
  [
    process.execPath,
    "node_modules/@effect/tsgo/dist/effect-tsgo.cjs",
    "diagnostics",
    "--project",
    "negative/tsconfig.json",
    "--format",
    "json",
    "--strict",
  ],
  { stdout: "pipe", stderr: "pipe" },
);
const [code, output, error] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);
const report = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      diagnostics: Schema.Array(Schema.Struct({ name: Schema.String, severity: Schema.String })),
    }),
  ),
)(output);
assert.notEqual(code, 0, error || "Invalid fixture must fail");
assert.ok(report.diagnostics.some((d) => d.name === "floatingEffect" && d.severity === "error"));
console.log("PASS: negative fixture produces floatingEffect error and a nonzero exit");
