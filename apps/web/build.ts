import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
const root = import.meta.dir;
const outdir = join(root, "dist");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "src/main.tsx")],
  outdir,
  target: "browser",
  minify: true,
  naming: "[name]-[hash].[ext]",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) throw new AggregateError(result.logs, "Reader bundle failed");
const files = result.outputs.map((file) => file.path.split("/").at(-1)!);
const script = files.find((file) => file.endsWith(".js"));
const style = files.find((file) => file.endsWith(".css"));
if (!script || !style || files.length !== 2) throw new Error("Unexpected reader assets");
await Bun.write(join(outdir, "manifest.json"), JSON.stringify({ script, style, files }));
console.log(`Reader built: ${files.length} immutable assets`);
