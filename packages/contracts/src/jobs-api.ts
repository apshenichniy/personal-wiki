import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as J from "./jobs.ts";
import * as K from "./knowledge.ts";
import { ErrorEnvelope } from "./index.ts";
import { ProviderApi } from "./provider-api.ts";
const errors = [400, 401, 403, 404, 409, 500, 503].map((status) =>
  ErrorEnvelope.pipe(HttpApiSchema.status(status)),
);
export class WorkerApi extends HttpApiGroup.make("worker").add(
  HttpApiEndpoint.post("resolve", "/internal/v1/jobs/resolve", {
    payload: J.ResolveSource,
    success: J.SourceResolution,
    error: errors,
  }),
  HttpApiEndpoint.post("claim", "/internal/v1/jobs/claim", {
    payload: J.ClaimRequest,
    success: J.Claim,
    error: errors,
  }),
  HttpApiEndpoint.post("heartbeat", "/internal/v1/jobs/heartbeat", {
    payload: J.WorkerRequest,
    success: J.JobView,
    error: errors,
  }),
  HttpApiEndpoint.post("reserve", "/internal/v1/jobs/reserve", {
    payload: J.ReserveSources,
    success: K.Draft,
    error: errors,
  }),
  HttpApiEndpoint.post("upload", "/internal/v1/jobs/upload", {
    payload: J.UploadSource,
    success: K.Asset,
    error: errors,
  }),
  HttpApiEndpoint.post("prepare", "/internal/v1/jobs/prepare", {
    payload: J.PrepareCapture,
    success: J.JobView,
    error: errors,
  }),
  HttpApiEndpoint.post("authorizeAttempt", "/internal/v1/jobs/attempt", {
    payload: J.ReserveAttempt,
    success: J.Attempt,
    error: errors,
  }),
  HttpApiEndpoint.post("completeAttempt", "/internal/v1/jobs/complete", {
    payload: J.CompleteAttempt,
    success: J.JobView,
    error: errors,
  }),
  HttpApiEndpoint.post("publish", "/internal/v1/jobs/publish", {
    payload: J.WorkerRequest,
    success: J.JobView,
    error: errors,
  }),
  HttpApiEndpoint.post("block", "/internal/v1/jobs/block", {
    payload: J.BlockJob,
    success: J.JobView,
    error: errors,
  }),
) {}
export class OwnerJobsApi extends HttpApiGroup.make("jobs").add(
  HttpApiEndpoint.post("revokeCredential", "/api/v1/operator/credentials/revoke", {
    payload: Schema.Struct({ identityId: K.Id }),
    success: HttpApiSchema.NoContent,
    error: errors,
  }),
  HttpApiEndpoint.post("submit", "/api/v1/submissions", {
    payload: J.Submission,
    success: J.SubmissionResult,
    error: errors,
  }),
  HttpApiEndpoint.get("get", "/api/v1/jobs/:jobId", {
    params: { jobId: K.Id },
    success: J.JobView,
    error: errors,
  }),
  HttpApiEndpoint.post("cancel", "/api/v1/jobs/cancel", {
    payload: J.JobCommand,
    success: J.JobView,
    error: errors,
  }),
  HttpApiEndpoint.post("resume", "/api/v1/jobs/resume", {
    payload: J.JobCommand,
    success: J.JobView,
    error: errors,
  }),
  HttpApiEndpoint.post("retryRetained", "/api/v1/jobs/retry-retained", {
    payload: J.JobCommand,
    success: J.JobView,
    error: errors,
  }),
) {}
export class WorkflowApi extends HttpApi.make("personal-wiki-workflow")
  .add(WorkerApi)
  .add(ProviderApi)
  .add(OwnerJobsApi) {}
