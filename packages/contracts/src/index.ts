import * as K from "./knowledge.ts";
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
  code: Schema.Literals([
    "invalid_request",
    "internal_error",
    "idempotency_conflict",
    "stale_proposal",
    "already_published",
    "revision_changed",
    "not_found",
    "unavailable",
    "cancelled",
    "invalid_transition",
    "deadline_exceeded",
    "launch_limit",
    "stale_owner",
    "unauthenticated",
    "forbidden",
    "conflict",
    "disabled",
    "budget",
    "deadline",
    "remote_pending",
  ]),
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
const errors = [400, 401, 403, 404, 409, 500, 503].map((status) =>
  ErrorEnvelope.pipe(HttpApiSchema.status(status)),
);
export class KnowledgeApi extends HttpApiGroup.make("knowledge").add(
  HttpApiEndpoint.post("cancelPublication", "/api/v1/worker/publications/cancel", {
    payload: K.CancelPublication,
    success: K.CancellationResult,
    error: errors,
  }),
  HttpApiEndpoint.post("compensate", "/api/v1/operator/compensations", {
    payload: K.Compensation,
    success: K.Receipt,
    error: errors,
  }),
  HttpApiEndpoint.get("outbox", "/api/v1/operator/outbox", { success: K.Outbox, error: errors }),
  HttpApiEndpoint.post("ackEvent", "/api/v1/operator/outbox/ack", {
    payload: K.AckEvent,
    success: HttpApiSchema.NoContent,
    error: errors,
  }),

  HttpApiEndpoint.post("reserve", "/api/v1/worker/reservations", {
    payload: K.ReserveRequest,
    success: K.Draft,
    error: errors,
  }),
  HttpApiEndpoint.post("upload", "/api/v1/worker/assets", {
    payload: K.AssetUpload,
    success: K.Asset,
    error: errors,
  }),
  HttpApiEndpoint.post("publish", "/api/v1/worker/publications", {
    payload: K.Proposal,
    success: K.Receipt,
    error: errors,
  }),
  HttpApiEndpoint.get("list", "/api/v1/notes", {
    query: K.ReadRequest,
    success: K.NoteList,
    error: errors,
  }),
  HttpApiEndpoint.get("note", "/api/v1/notes/:noteId", {
    params: { noteId: K.Id },
    query: K.ReadRequest,
    success: K.NoteDetail,
    error: errors,
  }),
  HttpApiEndpoint.get("capture", "/api/v1/captures/:captureId", {
    params: { captureId: K.Id },
    query: K.ReadRequest,
    success: K.CaptureDetail,
    error: errors,
  }),
  HttpApiEndpoint.post("search", "/api/v1/search", {
    payload: K.SearchRequest,
    success: K.SearchResult,
    error: errors,
  }),
  HttpApiEndpoint.post("rebuild", "/api/v1/operator/rebuild", {
    success: K.NoteList,
    error: errors,
  }),
) {}
export class WikiApi extends HttpApi.make("personal-wiki")
  .add(SystemApi)
  .add(KnowledgeApi)
  .annotateMerge(OpenApi.annotations({ title: "Personal Wiki", version: "0.1.0" })) {}
