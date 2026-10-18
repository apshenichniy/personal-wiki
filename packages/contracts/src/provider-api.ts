import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Id } from "./knowledge.ts";
import { WorkerRequest } from "./jobs.ts";
import { ErrorEnvelope } from "./index.ts";
import * as P from "./provider.ts";
const errors = [400, 401, 403, 404, 409, 500, 503].map((status) =>
  ErrorEnvelope.pipe(HttpApiSchema.status(status)),
);
export const ProviderReservation = Schema.Struct({
  ...WorkerRequest.fields,
  planKey: P.Name,
  inputJson: Schema.String.check(Schema.isMaxLength(65_536)),
  replacementOf: Schema.NullOr(Id),
});
export const ProviderStart = Schema.Struct({ ...WorkerRequest.fields, operationId: Id });
export const ProviderOperationId = Schema.Struct({ operationId: Id });
export const ProviderAttachment = Schema.Struct({
  operationId: Id,
  run: P.RunIdentity,
  evidence: Schema.NullOr(P.Hash),
});
export const ProviderObservation = Schema.Struct({
  operationId: Id,
  observation: P.RunObservation,
});
export const ProviderInspection = Schema.Struct({
  shouldStop: Schema.Boolean,
  operations: Schema.Array(P.Operation),
});
export const ProviderPermit = Schema.Struct({ operation: P.Operation, profile: P.Profile });
export class ProviderApi extends HttpApiGroup.make("providers").add(
  HttpApiEndpoint.get("profile", "/internal/v1/providers/profile", {
    success: P.Profile,
    error: errors,
  }),
  HttpApiEndpoint.get("pending", "/internal/v1/providers/pending", {
    success: Schema.Array(P.Operation),
    error: errors,
  }),
  HttpApiEndpoint.post("reserve", "/internal/v1/providers/reserve", {
    payload: ProviderReservation,
    success: P.Operation,
    error: errors,
  }),
  HttpApiEndpoint.post("begin", "/internal/v1/providers/begin", {
    payload: ProviderStart,
    success: ProviderPermit,
    error: errors,
  }),
  HttpApiEndpoint.post("unknown", "/internal/v1/providers/unknown", {
    payload: ProviderOperationId,
    success: P.Operation,
    error: errors,
  }),
  HttpApiEndpoint.post("attach", "/internal/v1/providers/attach", {
    payload: ProviderAttachment,
    success: P.Operation,
    error: errors,
  }),
  HttpApiEndpoint.post("observe", "/internal/v1/providers/observe", {
    payload: ProviderObservation,
    success: P.Operation,
    error: errors,
  }),
  HttpApiEndpoint.post("inspect", "/internal/v1/providers/inspect", {
    payload: Schema.Struct({ jobId: Id }),
    success: ProviderInspection,
    error: errors,
  }),
) {}
