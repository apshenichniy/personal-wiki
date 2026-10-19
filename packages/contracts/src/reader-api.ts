import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { ErrorEnvelope, KnowledgeApi } from "./index.ts";
import { OwnerJobsApi } from "./jobs-api.ts";
import { JobView } from "./jobs.ts";
import { Id } from "./knowledge.ts";

export const OwnerSession = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  expiresAt: Schema.String,
  csrfToken: Schema.String,
});
const errors = [400, 401, 403, 404, 409, 500, 503].map((status) =>
  ErrorEnvelope.pipe(HttpApiSchema.status(status)),
);
export class ReaderKnowledge extends HttpApiGroup.make("knowledge").add(
  KnowledgeApi.endpoints.list,
  KnowledgeApi.endpoints.note,
  KnowledgeApi.endpoints.capture,
  KnowledgeApi.endpoints.search,
  HttpApiEndpoint.get("asset", "/api/v1/assets/:assetId", {
    params: { assetId: Id },
    success: HttpApiSchema.WithHeaders(
      Schema.Uint8Array.pipe(
        HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" }),
      ),
      {
        "content-disposition": Schema.Literal("attachment; filename=retained-source.bin"),
        "accept-ranges": Schema.Literal("none"),
      },
    ),
    error: errors,
  }),
) {}
export class ReaderJobs extends HttpApiGroup.make("jobs").add(
  HttpApiEndpoint.get("recent", "/api/v1/jobs", {
    success: Schema.Struct({ jobs: Schema.Array(JobView), hasMore: Schema.Boolean }),
    error: errors,
  }),
  OwnerJobsApi.endpoints.submit,
  OwnerJobsApi.endpoints.get,
  OwnerJobsApi.endpoints.cancel,
  OwnerJobsApi.endpoints.resume,
  OwnerJobsApi.endpoints.retryRetained,
) {}
export class ReaderSession extends HttpApiGroup.make("session").add(
  HttpApiEndpoint.get("get", "/api/v1/session", { success: OwnerSession, error: errors }),
  HttpApiEndpoint.post("logout", "/api/v1/session/logout", {
    success: HttpApiSchema.NoContent,
    error: errors,
  }),
) {}
/** Reuse the existing domain contracts while excluding all worker/operator paths. */
export class ReaderApi extends HttpApi.make("personal-wiki-reader")
  .add(ReaderKnowledge)
  .add(ReaderJobs)
  .add(ReaderSession) {}
