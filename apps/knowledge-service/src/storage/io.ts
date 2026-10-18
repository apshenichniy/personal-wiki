import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";

export class LibraryError extends Schema.TaggedError<LibraryError>()("LibraryError", {
  code: Schema.Literals([
    "invalid_request",
    "idempotency_conflict",
    "stale_proposal",
    "already_published",
    "revision_changed",
    "not_found",
    "unavailable",
  ]),
  message: Schema.String,
}) {}
export const invalid = (message: string) => new LibraryError({ code: "invalid_request", message });
export const io = <A>(action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (error) =>
      error instanceof LibraryError
        ? error
        : new LibraryError({ code: "unavailable", message: "Private storage operation failed." }),
  });
export const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw invalid("Undefined semantic input.");
  return result;
}
export async function durableCreate(path: string, bytes: Uint8Array) {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  ).catch(async (error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      const current = await readFile(path);
      if (digest(current) !== digest(bytes))
        throw invalid("Immutable asset identity already contains different bytes.");
      return null;
    }
    throw error;
  });
  if (file) {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
export async function syncDirectory(path: string) {
  const dir = await open(path, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function prepareDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}
const execute = promisify(execFile);
export const git = (
  root: string,
  args: ReadonlyArray<string>,
  options?: { raw?: boolean; env?: NodeJS.ProcessEnv },
) =>
  io(async () => {
    const { stdout } = await execute("git", ["--git-dir", join(root, "knowledge.git"), ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...options?.env,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    return options?.raw ? stdout : stdout.trim();
  });
