import { Schema } from "effect";
export async function launch(
  root: string,
  extra: Record<string, string> = {},
  production = false,
  entry?: string,
) {
  const child = Bun.spawn(
    [
      "python3",
      "tools/runtime/locked-service.py",
      process.execPath,
      entry ??
        (production ? "apps/knowledge-service/dist/index.js" : "tests/helpers/library-service.ts"),
    ],
    {
      env: { PATH: process.env.PATH, WIKI_DATA_DIR: root, PORT: "0", ...extra },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let output = "";
  let url = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    while (!url) {
      const part = await reader.read();
      if (part.done) throw new Error(`Startup failed: ${output} ${await errors}`);
      output += new TextDecoder().decode(part.value);
      for (const line of output.split("\n"))
        if (line.startsWith('{"event":"ready"'))
          url = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ url: Schema.String })))(
            line,
          ).url;
    }
  } finally {
    clearTimeout(timer);
  }
  const logs = (async () => {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      output += new TextDecoder().decode(part.value);
    }
    reader.releaseLock();
    return output;
  })();
  return {
    child,
    url,
    stop: async () => {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await logs;
      await errors;
    },
  };
}
