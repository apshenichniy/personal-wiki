// Synthetic HTTPS integration host. Test controls exist only in this entrypoint.
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { jobRuntime } from "../../apps/knowledge-service/src/jobs/runtime.ts";
import { OwnerSessions } from "../../apps/knowledge-service/src/access/sessions.ts";
import { discoverOwnerProvider } from "../../apps/knowledge-service/src/access/oidc.ts";
import { ownerHandler } from "../../apps/knowledge-service/src/access/server.ts";
import { loadWebBundle } from "../../apps/knowledge-service/src/access/web.ts";
import { Routes, StorageWrites } from "../../apps/knowledge-service/src/http.ts";
import { WorkflowRoutes, Authentication } from "../../apps/knowledge-service/src/jobs/http.ts";
import { JobError } from "../../apps/knowledge-service/src/jobs/policy.ts";
import { ownerProviderFixture, ownerSettings } from "./owner-provider.ts";
const root = process.env.WIKI_DATA_DIR;
const directory = process.env.WIKI_BROWSER_FIXTURE_DIR;
if (!root || !directory) throw new Error("Disposable browser fixture required");
const settings = { ...ownerSettings, publicOrigin: "https://127.0.0.1:4173" };
const peer = await ownerProviderFixture(settings);
const provider = await discoverOwnerProvider(settings, peer.transport);
const token = `wk_${randomBytes(32).toString("base64url")}`;
const tokenPath = `${directory}/runner-token`;
const credentials = `${directory}/credentials.json`;
await writeFile(tokenPath, token, { mode: 0o600 });
await writeFile(
  credentials,
  JSON.stringify({ credentials: [{ identityId: randomUUID(), role: "runner", token }] }),
  { mode: 0o600 },
);
process.env.WIKI_MACHINE_CREDENTIALS_FILE = credentials;
const Runtime = OwnerSessions.layer(settings, provider).pipe(Layer.provideMerge(jobRuntime(root)));
const web = await loadWebBundle(resolve("apps/web/dist"));
const program = Effect.gen(function* () {
  const context = yield* Effect.context<Layer.Success<typeof Runtime>>();
  const sessions = yield* OwnerSessions;
  const owner = ownerHandler(context, web);
  const worker = HttpRouter.toWebHandler(
    Layer.mergeAll(Routes, WorkflowRoutes, Authentication).pipe(
      Layer.provide(
        Layer.succeed(StorageWrites, {
          authorize: Effect.fail(new JobError({ code: "forbidden", message: "Use the job API." })),
        }),
      ),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provide(BunHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  const machine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => worker.handler(request),
  });
  let running = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 4173,
    tls: { key: Bun.file(`${directory}/key.pem`), cert: Bun.file(`${directory}/cert.pem`) },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__test/authorize")
        return Response.redirect(peer.callback(url.searchParams.get("authorization")!).href, 302);
      if (url.pathname === "/__test/revoke" && request.method === "POST") {
        await Effect.runPromise(sessions.revokeAll());
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__test/run" && request.method === "POST") {
        if (running) return new Response(null, { status: 409 });
        running = true;
        const child = Bun.spawn([process.execPath, "apps/runner/dist/synthetic.js"], {
          env: {
            PATH: process.env.PATH,
            WIKI_SERVICE_URL: machine.url.href,
            WIKI_RUNNER_TOKEN_FILE: tokenPath,
            WIKI_SYNTHETIC_ARTICLE: "true",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 35000);
        try {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return new Response(code === 0 ? stdout : stderr, { status: code === 0 ? 200 : 500 });
        } finally {
          clearTimeout(timeout);
          running = false;
        }
      }
      const response = await owner.handler(request);
      if (url.pathname === "/auth/login" && response.status === 302) {
        const headers = new Headers(response.headers);
        headers.set(
          "location",
          `/__test/authorize?authorization=${encodeURIComponent(headers.get("location")!)}`,
        );
        return new Response(null, { status: 302, headers });
      }
      return response;
    },
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await server.stop(true);
      await machine.stop(true);
      await owner.dispose();
      await worker.dispose();
    }),
  );
  return yield* Effect.never;
});
program.pipe(Effect.provide(Runtime), Effect.scoped, BunRuntime.runMain);
