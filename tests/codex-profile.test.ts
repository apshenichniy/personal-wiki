import { test, expect } from "bun:test";
import {
  admit,
  tokens,
  validateOutput,
  codexArguments,
  profile,
} from "../apps/runner/src/codex/profile.ts";
import { subscriptionAuth } from "../apps/runner/src/codex/files.ts";

test("pinned admission counts complete Unicode data and schema without special-token execution", () => {
  const text = "Русский текст. Español. 中文 👩🏽‍💻 <|endoftext|>";
  expect(tokens(text)).toBeGreaterThan(10);
  const admitted = admit({
    prompt: text,
    instructions: "Trusted instructions",
    schema: '{"type":"object"}',
  });
  expect(admitted.inputTokens).toBe(
    tokens(text) + tokens("Trusted instructions") + tokens('{"type":"object"}') + 8192,
  );
  expect(profile.contextWindow).toBeGreaterThan(admitted.inputTokens + 24000);
  expect(() => admit({ prompt: "x".repeat(1048577), instructions: "", schema: "{}" })).toThrow();
  expect(() =>
    admit({ prompt: "", instructions: "", schema: "{}", related: Array(13).fill("a") }),
  ).toThrow();
  expect(() =>
    admit({ prompt: "", instructions: "", schema: "{}", related: [" a".repeat(8001)] }),
  ).toThrow();
  expect(() => validateOutput(JSON.stringify({ text: " a".repeat(16001) }))).toThrow();
  expect(() => validateOutput('{"unfinished":')).toThrow();
});
test("dedicated CLI configuration disables inherited tools and requires subscription authentication", () => {
  const argv = codexArguments("/private/work", "/private/auth");
  expect(argv).toContain("--ignore-user-config");
  expect(argv).toContain("--ignore-rules");
  expect(argv).toContain("features.shell_tool=false");
  expect(argv).toContain("features.multi_agent=false");
  expect(argv).toContain("features.plugins=false");
  expect(argv).toContain("features.hooks=false");
  expect(argv).toContain('forced_login_method="chatgpt"');
  expect(argv).toContain('web_search="disabled"');
  expect(argv.at(-1)).toBe("-");
  expect(() =>
    subscriptionAuth(
      JSON.stringify({
        OPENAI_API_KEY: "synthetic-api-key",
        tokens: { access_token: "synthetic" },
      }),
    ),
  ).toThrow();
  expect(
    subscriptionAuth(
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: "synthetic" } }),
    ),
  ).toContain("synthetic");
});
