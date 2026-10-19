import { Schema } from "effect";
import { getEncoding } from "js-tiktoken";
import { createHash } from "node:crypto";

export class CodexError extends Schema.TaggedError<CodexError>()("CodexError", {
  code: Schema.Literals([
    "configuration",
    "capacity",
    "auth",
    "quota",
    "ownership",
    "storage",
    "failed",
  ]),
  message: Schema.String,
}) {}
export const failure = (code: CodexError["code"]) =>
  new CodexError({ code, message: `Codex adapter: ${code}.` });
export const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
export const profile = {
  version: "codex-curation-v1",
  cliVersion: "0.163.0",
  model: "gpt-5.6-sol",
  reasoning: "medium",
  contextWindow: 272000,
  tokenizer: "o200k_base",
  tokenizerLibrary: "js-tiktoken@1.0.21",
  tokenizerEvidence:
    "https://github.com/openai/tiktoken/blob/4e71bbe0c078468e00fefbf94b39849389f346e5/tiktoken/model.py",
  maxInputTokens: 64000,
  maxOutputTokens: 16000,
  headroomTokens: 8000,
  protocolReserveTokens: 8192,
  maxPreparedBytes: 1048576,
  maxRelatedTokens: 8000,
  maxRelatedNotes: 12,
} as const;
const encoder = getEncoding("o200k_base");
// Treat special-token-looking strings in untrusted source text as ordinary data.
export const tokens = (text: string) => encoder.encode(text, [], []).length;
export function admit(input: {
  prompt: string;
  instructions: string;
  schema: string;
  related?: readonly string[];
}) {
  if (Buffer.byteLength(input.prompt) > profile.maxPreparedBytes) throw failure("capacity");
  const related = input.related ?? [];
  if (
    related.length > profile.maxRelatedNotes ||
    related.reduce((n, x) => n + tokens(x), 0) > profile.maxRelatedTokens
  )
    throw failure("capacity");
  const inputTokens =
    tokens(input.prompt) +
    tokens(input.instructions) +
    tokens(input.schema) +
    profile.protocolReserveTokens;
  if (
    inputTokens > profile.maxInputTokens ||
    inputTokens + profile.maxOutputTokens + profile.headroomTokens > profile.contextWindow * 0.95
  )
    throw failure("capacity");
  return {
    inputTokens,
    profileDigest: hash(JSON.stringify(profile)),
    inputDigest: hash(JSON.stringify(input)),
    instructionsDigest: hash(input.instructions),
    schemaDigest: hash(input.schema),
  };
}
export function validateOutput(text: string) {
  if (Buffer.byteLength(text) > 1048576 || tokens(text) > profile.maxOutputTokens)
    throw failure("capacity");
  try {
    JSON.parse(text);
  } catch {
    throw failure("failed");
  }
  return text;
}
export function codexArguments(workspace: string, home: string) {
  const config: Record<string, unknown> = {
    model: profile.model,
    model_provider: "openai",
    model_reasoning_effort: profile.reasoning,
    forced_login_method: "chatgpt",
    cli_auth_credentials_store: "file",
    approval_policy: "never",
    model_context_window: profile.contextWindow,
    model_auto_compact_token_limit: 240000,
    project_doc_max_bytes: 0,
    model_instructions_file: `${workspace}/instructions.md`,
    web_search: "disabled",
    "features.shell_tool": false,
    "features.unified_exec": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "features.goals": false,
    "features.shell_snapshot": false,
    "features.apps": false,
    "features.plugins": false,
    "features.remote_plugin": false,
    "features.hooks": false,
    "features.skill_search": false,
    "features.skill_mcp_dependency_install": false,
    "features.skip_host_skill_discovery": true,
    mcp_servers: {},
    "history.persistence": "none",
    "shell_environment_policy.inherit": "none",
    "analytics.enabled": false,
  };
  return [
    "exec",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--json",
    "--cd",
    workspace,
    "--output-schema",
    `${workspace}/schema.json`,
    "--output-last-message",
    `${workspace}/result.json`,
    ...Object.entries(config).flatMap(([k, v]) => [
      "-c",
      `${k}=${JSON.stringify(v) === "{}" ? "{}" : JSON.stringify(v)}`,
    ]),
    "-c",
    `log_dir=${JSON.stringify(home)}`,
    "-",
  ];
}
