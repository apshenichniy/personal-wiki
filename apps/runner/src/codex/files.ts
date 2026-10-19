import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { isAbsolute, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { failure } from "./profile.ts";

export async function privateDirectory(path: string) {
  if (!isAbsolute(path)) throw failure("storage");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.mode & 0o077) throw failure("storage");
}
export async function privateRead(path: string, maxBytes = 1048576) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > maxBytes) throw failure("storage");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
export async function durableWrite(path: string, text: string, replace = false) {
  const temporary = replace ? `${path}.${randomUUID()}` : path;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  if (replace) await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export function subscriptionAuth(text: string) {
  const auth: unknown = JSON.parse(text);
  if (
    typeof auth !== "object" ||
    auth === null ||
    !("tokens" in auth) ||
    typeof auth.tokens !== "object" ||
    auth.tokens === null ||
    !("access_token" in auth.tokens) ||
    typeof auth.tokens.access_token !== "string" ||
    !auth.tokens.access_token.trim() ||
    ("OPENAI_API_KEY" in auth && auth.OPENAI_API_KEY !== null) ||
    ("auth_mode" in auth && auth.auth_mode !== "chatgpt")
  )
    throw failure("auth");
  return text;
}
