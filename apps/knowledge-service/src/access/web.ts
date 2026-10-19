import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { HttpServerResponse } from "effect/http";

export type WebBundle = {
  html: string;
  files: ReadonlyMap<string, { bytes: Uint8Array; contentType: string }>;
};
/** Build files are loaded once from an operator-selected release. Request paths
 * never become filesystem paths, and no source map or arbitrary file is served. */
export async function loadWebBundle(directory: string): Promise<WebBundle> {
  if (!isAbsolute(directory)) throw new Error("Reader directory must be absolute");
  const manifest: unknown = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("script" in manifest) ||
    !("style" in manifest) ||
    typeof manifest.script !== "string" ||
    typeof manifest.style !== "string" ||
    !/^main-[A-Za-z0-9_-]+\.js$/.test(manifest.script) ||
    !/^main-[A-Za-z0-9_-]+\.css$/.test(manifest.style)
  )
    throw new Error("Reader manifest is invalid");
  const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  for (const name of [manifest.script, manifest.style]) {
    const bytes = new Uint8Array(await readFile(join(directory, name)));
    if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024)
      throw new Error("Reader bundle exceeds bounds");
    files.set(`/static/${name}`, {
      bytes,
      contentType: name.endsWith(".js") ? "text/javascript" : "text/css",
    });
  }
  return {
    files,
    html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Personal Wiki</title><link rel="stylesheet" href="/static/${manifest.style}"><script type="module" src="/static/${manifest.script}"></script></head><body><div id="root"></div><noscript>Для чтения библиотеки включите JavaScript.</noscript></body></html>`,
  };
}
export function staticResponse(bundle: WebBundle | undefined, path: string, method: string) {
  const file = bundle?.files.get(path);
  if (!file || !["GET", "HEAD"].includes(method)) return undefined;
  return HttpServerResponse.uint8Array(method === "HEAD" ? new Uint8Array() : file.bytes, {
    contentType: file.contentType,
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
export const readerPath = (path: string) =>
  path === "/" || /^\/(notes|jobs)\/[a-f0-9-]{36}$/.test(path);
export const htmlPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
