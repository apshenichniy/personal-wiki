import { Config, Console, Context, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { BunHttpServer } from "@effect/platform-bun";
import { Library } from "../storage/library.ts";
import { Jobs } from "../jobs/service.ts";
import { JobLifecycle } from "../jobs/lifecycle.ts";
import { loadAccessConfiguration } from "./config.ts";
import { discoverOwnerProvider } from "./oidc.ts";
import { OwnerSessions } from "./sessions.ts";
import { loadWebBundle, type WebBundle } from "./web.ts";
import { ownerRoutes } from "./http.ts";
import { JobError } from "../jobs/policy.ts";

export const ownerHandler = (
  context: Context.Context<OwnerSessions | Library | Jobs | JobLifecycle>,
  web?: WebBundle,
) =>
  HttpRouter.toWebHandler(
    ownerRoutes(web).pipe(
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provide(BunHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );

export const OwnerServer = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Config.String("WIKI_OWNER_ACCESS_FILE").pipe(Config.withDefault(""));
    // Private worker-only development remains possible; an absent owner identity
    // never enables an unauthenticated public listener or a first-user claim.
    if (!path) return Layer.empty;
    const settings = yield* loadAccessConfiguration(path);
    const provider = yield* Effect.tryPromise({
      try: () => discoverOwnerProvider(settings),
      catch: () => new JobError({ code: "unavailable", message: "Owner OIDC discovery failed." }),
    });
    const webPath = yield* Config.String("WIKI_WEB_DIR").pipe(Config.withDefault(""));
    const web = webPath ? yield* Effect.tryPromise(() => loadWebBundle(webPath)) : undefined;
    const port = yield* Config.Int("WIKI_PUBLIC_PORT").pipe(Config.withDefault(3001));
    if (port < 0 || port > 65535) return yield* Effect.die("Invalid public listener port");
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const context = yield* Effect.context<OwnerSessions | Library | Jobs | JobLifecycle>();
        const app = ownerHandler(context, web);
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port,
              maxRequestBodySize: 64 * 1024,
              fetch: (request) => app.handler(request),
            }),
          ),
          (server) =>
            Effect.promise(async () => {
              await server.stop(true);
              await app.dispose();
            }),
        );
        yield* Console.log(JSON.stringify({ event: "owner-ready", port: server.port }));
      }),
    ).pipe(Layer.provide(OwnerSessions.layer(settings, provider)));
  }),
);
