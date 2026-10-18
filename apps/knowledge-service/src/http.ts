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
          return HttpServerResponse.schemaJson(ErrorEnvelope)(
            {
              code: invalid ? "invalid_request" : "internal_error",
              message: invalid
                ? "Request does not match the API contract."
                : "Request could not be completed.",
              requestId,
            },
            { status: invalid ? 400 : 500 },
          ).pipe(Effect.orDie);
        }),
      );
      return HttpServerResponse.setHeader(response, "x-request-id", requestId);
    }),
  { global: true },
);

export const Routes = Layer.mergeAll(
  HttpApiBuilder.layer(WikiApi, { openapiPath: "/openapi.json" }).pipe(Layer.provide(Handlers)),
  Boundary,
);
