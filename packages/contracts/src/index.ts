import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";

export const RequestId = Schema.String.check(Schema.isUUID());
export const EchoRequest = Schema.Struct({
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});
export const EchoResponse = Schema.Struct({
  requestId: RequestId,
  message: Schema.String,
  synthetic: Schema.Literal(true),
});
export const ErrorEnvelope = Schema.Struct({
  code: Schema.Literals(["invalid_request", "internal_error"]),
  message: Schema.String,
  requestId: RequestId,
});
export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }),
  HttpApiEndpoint.post("echo", "/api/v1/synthetic/echo", {
    headers: { "x-request-id": RequestId },
    payload: EchoRequest,
    success: EchoResponse,
    error: [
      ErrorEnvelope.pipe(HttpApiSchema.status(400)),
      ErrorEnvelope.pipe(HttpApiSchema.status(500)),
    ],
  }),
) {}
export class WikiApi extends HttpApi.make("personal-wiki")
  .add(SystemApi)
  .annotateMerge(OpenApi.annotations({ title: "Personal Wiki", version: "0.1.0" })) {}
