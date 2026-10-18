import { Library } from "./storage/library.ts";
import { LibraryError } from "./storage/io.ts";
import { Cause, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { ErrorEnvelope, RequestId, WikiApi } from "@personal-wiki/contracts";

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
    return handlers.handleAll({
      reserve: ({ payload }) => library.reserve(payload).pipe(Effect.orDie),
      upload: ({ payload }) => library.upload(payload).pipe(Effect.orDie),
      publish: ({ payload }) => library.publish(payload).pipe(Effect.orDie),
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
          const domain = error instanceof LibraryError ? error : undefined;
          const status = domain
            ? {
                invalid_request: 400,
                idempotency_conflict: 409,
                stale_proposal: 409,
                already_published: 409,
                revision_changed: 409,
                not_found: 404,
                unavailable: 503,
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
