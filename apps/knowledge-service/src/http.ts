import { JobError } from "./jobs/policy.ts";
import { ProviderError } from "@personal-wiki/contracts/provider";
import { Library } from "./storage/library.ts";
import { LibraryError } from "./storage/io.ts";
import { ArchiveError } from "./storage/raw-archive.ts";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { ErrorEnvelope, RequestId, WikiApi } from "@personal-wiki/contracts";

// The storage protocol is exposed only by a dedicated synthetic test harness.
// Production provides a denying capability; URL normalization cannot bypass it.
export class StorageWrites extends Context.Service<
  StorageWrites,
  { authorize: Effect.Effect<void, JobError> }
>()("personal-wiki/StorageWrites") {}
const Handlers = HttpApiBuilder.group(WikiApi, "system", (handlers) =>
  handlers.handleAll({
    health: () => Effect.void,
    echo: ({ payload, headers }) =>
      Effect.succeed({
        requestId: headers["x-request-id"],
        message: payload.message,
        synthetic: true as const,
      }),
  }),
);
const KnowledgeHandlers = HttpApiBuilder.group(
  WikiApi,
  "knowledge",
  Effect.fn(function* (handlers) {
    const library = yield* Library;
    const writes = yield* StorageWrites;
    return handlers.handleAll({
      cancelPublication: ({ payload }) =>
        writes.authorize.pipe(
          Effect.andThen(library.cancelPublication(payload.operationId)),
          Effect.orDie,
        ),
      compensate: ({ payload }) => library.compensate(payload).pipe(Effect.orDie),
      outbox: () => library.outbox().pipe(Effect.orDie),
      ackEvent: ({ payload }) => library.ackEvent(payload.eventId).pipe(Effect.orDie),
      reserve: ({ payload }) =>
        writes.authorize.pipe(Effect.andThen(library.reserve(payload)), Effect.orDie),
      upload: ({ payload }) =>
        writes.authorize.pipe(Effect.andThen(library.upload(payload)), Effect.orDie),
      publish: ({ payload }) =>
        writes.authorize.pipe(Effect.andThen(library.publish(payload)), Effect.orDie),
      list: ({ query }) => library.list(query.revision).pipe(Effect.orDie),
      note: ({ params, query }) => library.note(params.noteId, query.revision).pipe(Effect.orDie),
      capture: ({ params, query }) =>
        library.capture(params.captureId, query.revision).pipe(Effect.orDie),
      search: ({ payload }) => library.search(payload.query, payload.revision).pipe(Effect.orDie),
      rebuild: () => library.rebuild().pipe(Effect.orDie),
    });
  }),
);
const Boundary = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const supplied = request.headers["x-request-id"];
      const requestId = Schema.is(RequestId)(supplied) ? supplied : crypto.randomUUID();
      const response = yield* httpEffect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          const error = Cause.squash(cause);
          const invalid =
            HttpApiError.HttpApiSchemaError.is(error) &&
            error.kind !== "Body" &&
            error.kind !== "ResponseHeaders";
          const domain =
            error instanceof LibraryError ||
            error instanceof JobError ||
            error instanceof ProviderError ||
            error instanceof ArchiveError
              ? error
              : undefined;
          const status = domain
            ? {
                invalid_request: 400,
                idempotency_conflict: 409,
                stale_proposal: 409,
                already_published: 409,
                revision_changed: 409,
                not_found: 404,
                unavailable: 503,
                cancelled: 409,
                invalid_transition: 409,
                capacity: 409,
                deadline_exceeded: 409,
                launch_limit: 409,
                stale_owner: 409,
                unauthenticated: 401,
                forbidden: 403,
                conflict: 409,
                disabled: 503,
                budget: 409,
                deadline: 409,
                remote_pending: 409,
              }[domain.code]
            : invalid
              ? 400
              : 500;
          return HttpServerResponse.schemaJson(ErrorEnvelope)(
            {
              code: domain?.code ?? (invalid ? "invalid_request" : "internal_error"),
              message:
                domain?.message ??
                (invalid
                  ? "Request does not match the API contract."
                  : "Request could not be completed."),
              requestId,
            },
            { status },
          ).pipe(Effect.orDie);
        }),
      );
      return HttpServerResponse.setHeader(response, "x-request-id", requestId);
    }),
  { global: true },
);

export const Routes = Layer.mergeAll(
  HttpApiBuilder.layer(WikiApi, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide([Handlers, KnowledgeHandlers]),
  ),
  Boundary,
);
