import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { WorkflowApi } from "@personal-wiki/contracts/jobs-api";
import { SourceResolution } from "./resolution.ts";
import { Jobs } from "./service.ts";
import { JobExecution } from "./execution.ts";
import { JobLifecycle } from "./lifecycle.ts";
import { JobPublication } from "./publication.ts";
import { MachineCredentials } from "./credentials.ts";
import { JobProviders } from "../providers/jobs.ts";
const actor = <A, E, R>(
  credentials: typeof MachineCredentials.Service,
  run: (identityId: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const principal = yield* credentials.authenticate(request.headers.authorization);
    return yield* run(principal.identityId);
  }).pipe(Effect.orDie);
const WorkerHandlers = HttpApiBuilder.group(
  WorkflowApi,
  "worker",
  Effect.fn(function* (handlers) {
    const credentials = yield* MachineCredentials;
    const jobs = yield* Jobs;
    const resolution = yield* SourceResolution;
    const execution = yield* JobExecution;
    const lifecycle = yield* JobLifecycle;
    const publication = yield* JobPublication;
    return handlers.handleAll({
      resolve: ({ payload }) => actor(credentials, (id) => resolution.resolve(id, payload)),
      claim: ({ payload }) => actor(credentials, (id) => jobs.claim(id, payload)),
      heartbeat: ({ payload }) => actor(credentials, (id) => jobs.heartbeat(id, payload)),
      reserve: ({ payload }) =>
        actor(credentials, (id) =>
          publication.reserve(id, payload.scope, {
            requestId: payload.requestId,
            sources: payload.sources,
          }),
        ),
      upload: ({ payload }) => actor(credentials, (id) => publication.upload(id, payload)),
      prepare: ({ payload }) => actor(credentials, (id) => publication.prepare(id, payload)),
      authorizeAttempt: ({ payload }) => actor(credentials, (id) => execution.reserve(id, payload)),
      completeAttempt: ({ payload }) => actor(credentials, (id) => execution.complete(id, payload)),
      publish: ({ payload }) => actor(credentials, (id) => publication.publish(id, payload)),
      block: ({ payload }) => actor(credentials, (id) => lifecycle.block(id, payload)),
    });
  }),
);
const OwnerHandlers = HttpApiBuilder.group(
  WorkflowApi,
  "jobs",
  Effect.fn(function* (handlers) {
    const credentials = yield* MachineCredentials;
    const jobs = yield* Jobs;
    const lifecycle = yield* JobLifecycle;
    return handlers.handleAll({
      revokeCredential: ({ payload }) => credentials.revoke(payload.identityId).pipe(Effect.orDie),
      submit: ({ payload }) => jobs.submit(payload).pipe(Effect.orDie),
      get: ({ params }) => jobs.get(params.jobId).pipe(Effect.orDie),
      cancel: ({ payload }) => actor(credentials, (id) => lifecycle.cancel(id, payload)),
      resume: ({ payload }) => actor(credentials, (id) => lifecycle.resume(id, payload)),
      retryRetained: ({ payload }) =>
        actor(credentials, (id) => lifecycle.retryRetained(id, payload)),
    });
  }),
);
const ProviderHandlers = HttpApiBuilder.group(
  WorkflowApi,
  "providers",
  Effect.fn(function* (handlers) {
    const credentials = yield* MachineCredentials;
    const providers = yield* JobProviders;
    return handlers.handleAll({
      retain: ({ payload }) => actor(credentials, (id) => providers.retain(id, payload)),
      pages: ({ payload }) => actor(credentials, (id) => providers.pages(id, payload.operationId)),
      raw: ({ payload }) =>
        actor(credentials, (id) => providers.raw(id, payload.operationId, payload.pageKey)),
      archive: ({ payload }) =>
        actor(credentials, (id) => providers.completeArchive(id, payload.operationId)),
      pending: () => actor(credentials, (id) => providers.pending(id)),
      profile: () => actor(credentials, (id) => providers.profile(id)),
      reserve: ({ payload }) =>
        actor(credentials, (id) => providers.reserve(id, payload.scope, payload)),
      begin: ({ payload }) =>
        actor(credentials, (id) => providers.begin(id, payload.scope, payload.operationId)),
      unknown: ({ payload }) =>
        actor(credentials, (id) => providers.unknown(id, payload.operationId)),
      attach: ({ payload }) =>
        actor(credentials, (id) =>
          providers.attach(id, payload.operationId, payload.run, payload.evidence),
        ),
      observe: ({ payload }) =>
        actor(credentials, (id) => providers.observe(id, payload.operationId, payload.observation)),
      inspect: ({ payload }) => actor(credentials, (id) => providers.inspect(id, payload.jobId)),
    });
  }),
);
export const WorkflowRoutes = HttpApiBuilder.layer(WorkflowApi, {
  openapiPath: "/internal/openapi.json",
}).pipe(Layer.provide([WorkerHandlers, OwnerHandlers, ProviderHandlers]));
// This middleware is wired only by the production entry point. The focused P2/P3
// storage harness mounts its own route layer, outside the production artifact.
export const Authentication = Layer.unwrap(
  Effect.map(MachineCredentials, (credentials) =>
    HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const path = new URL(request.url, "http://localhost").pathname;
          if (path === "/health" || path === "/api/v1/synthetic/echo") return yield* httpEffect;
          const result = yield* credentials
            .authenticate(request.headers.authorization)
            .pipe(Effect.result);
          if (result._tag === "Failure")
            return HttpServerResponse.jsonUnsafe(
              {
                code: "unauthenticated",
                message: "Authentication required.",
                requestId: crypto.randomUUID(),
              },
              { status: 401, headers: { "cache-control": "no-store" } },
            );
          const principal = result.success;
          // Old storage mutation paths are deliberately unavailable from the deployed
          // service: Runner must use the fenced job protocol, even with a valid token.
          const rawWrite = path.startsWith("/api/v1/worker/");
          const workerOnly = path.startsWith("/internal/");
          const read =
            (request.method === "GET" &&
              (path.startsWith("/api/v1/notes") ||
                path.startsWith("/api/v1/captures") ||
                /^\/api\/v1\/jobs\/[a-f0-9-]+$/.test(path))) ||
            path === "/api/v1/search";
          if (
            rawWrite ||
            (workerOnly ? principal.role !== "runner" : !read && principal.role !== "operator")
          )
            return HttpServerResponse.jsonUnsafe(
              {
                code: "forbidden",
                message: "This credential cannot perform that action.",
                requestId: crypto.randomUUID(),
              },
              { status: 403, headers: { "cache-control": "no-store" } },
            );
          return yield* httpEffect;
        }),
      { global: true },
    ),
  ),
);
