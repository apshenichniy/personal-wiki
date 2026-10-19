import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import type { makeJobClient } from "@personal-wiki/client";
import type { JobScope } from "@personal-wiki/contracts/jobs";
import * as P from "@personal-wiki/contracts/provider";
import { dispatchOnce, retainedDispatch } from "./dispatch.ts";
import type { makeApifyHttp } from "./http.ts";

export class AcquisitionError extends Schema.TaggedError<AcquisitionError>()("AcquisitionError", {
  code: Schema.Literals(["conflict", "stopped", "missing_run"]),
  message: Schema.String,
}) {}
const fail = (code: AcquisitionError["code"]) =>
  new AcquisitionError({ code, message: `Acquisition: ${code}.` });

/** Runner owns provider I/O and its private spool, never a database connection.
 * All grants, run identities and observations cross the authenticated Service
 * API. This adapter is also used by the loopback integration tests. */
export function makeServiceAcquisition(options: {
  client: Effect.Success<ReturnType<typeof makeJobClient>>;
  http: ReturnType<typeof makeApifyHttp>;
  spool: string;
}) {
  const api = options.client.providers;
  const start = Effect.fn("Acquisition.startOrAdopt")(function* (
    scope: JobScope,
    input: {
      planKey: string;
      inputJson: string;
      replacementOf: string | null;
    },
  ) {
    const inspection = yield* api.inspect({ payload: { jobId: scope.jobId } });
    const old = inspection.operations.find((op) => op.planKey === input.planKey);
    if (old && (old.inputJson !== input.inputJson || old.replacementOf !== input.replacementOf))
      return yield* fail("conflict");
    if (old?.run) return old; // Retention is allowed even when the job is stopped.
    if (old && ["dispatching", "unknown"].includes(old.phase)) {
      const adopted = yield* recover(old);
      if (adopted.run) return adopted;
    }
    if (inspection.shouldStop || old?.stopRequested || old?.phase === "closed")
      return yield* fail("stopped");
    const operation =
      old ?? (yield* api.reserve({ payload: { ...input, scope, requestId: randomUUID() } }));
    const profile = yield* api.profile();
    yield* dispatchOnce({
      root: options.spool,
      resumeUnissuedPermit: operation.phase === "reserved",
      identity: {
        operationId: operation.operationId,
        inputDigest: operation.digest,
        actorId: profile.actorId,
        buildId: profile.buildId,
      },
      client: options.http,
      permit: api
        .begin({ payload: { requestId: randomUUID(), scope, operationId: operation.operationId } })
        .pipe(
          Effect.map(({ operation: granted, profile: pinned }) => ({
            actorId: pinned.actorId,
            buildId: pinned.buildId,
            buildNumber: pinned.buildNumber,
            inputJson: granted.inputJson,
            chargeNanos: granted.chargeNanos,
            acquisitionDeadline: granted.job.deadline,
          })),
        ),
      accept: ({ run, raw }) =>
        api
          .attach({
            payload: {
              operationId: operation.operationId,
              run: {
                runId: run.id,
                datasetId: run.defaultDatasetId,
                keyValueStoreId: run.defaultKeyValueStoreId,
                buildId: run.buildId,
                startedAt: Date.parse(run.startedAt),
              },
              evidence: raw.sha256,
            },
          })
          .pipe(Effect.asVoid),
      uncertain: api
        .unknown({ payload: { operationId: operation.operationId } })
        .pipe(Effect.asVoid),
    });
    const after = yield* api.inspect({ payload: { jobId: scope.jobId } });
    const known = after.operations.find((op) => op.operationId === operation.operationId);
    if (!known?.run) return yield* fail("missing_run");
    return known;
  });
  const refresh = Effect.fn("Acquisition.refreshKnownRun")(function* (
    operation: P.Operation,
    deadline: number,
  ) {
    if (!operation.run) return yield* fail("missing_run");
    const response = yield* options.http.status(operation.run.runId, deadline);
    const run = response.run;
    // Do not silently adopt a substituted store/build from later metadata.
    if (
      run.buildId !== operation.run.buildId ||
      run.defaultDatasetId !== operation.run.datasetId ||
      run.defaultKeyValueStoreId !== operation.run.keyValueStoreId
    )
      return yield* fail("conflict");
    const usageNanos = yield* Effect.try({
      try: () => (run.usageTotalUsd == null ? null : P.usdToNanos(run.usageTotalUsd)),
      catch: () => fail("conflict"),
    });
    const updated = yield* api.observe({
      payload: {
        operationId: operation.operationId,
        observation: {
          runId: run.id,
          status: run.status,
          finishedAt: run.finishedAt === null ? null : Date.parse(run.finishedAt),
          usageNanos,
          transientFailure: false,
        },
      },
    });
    return { operation: updated, raw: response.raw };
  });
  const recover = Effect.fn("Acquisition.adoptRetainedReceipt")(function* (operation: P.Operation) {
    if (operation.run || !["dispatching", "unknown"].includes(operation.phase)) return operation;
    const profile = yield* api.profile();
    const receipt = yield* retainedDispatch(options.spool, {
      operationId: operation.operationId,
      inputDigest: operation.digest,
      actorId: profile.actorId,
      buildId: profile.buildId,
    });
    if (!receipt) return operation;
    const run = receipt.run;
    return yield* api.attach({
      payload: {
        operationId: operation.operationId,
        evidence: receipt.raw.sha256,
        run: {
          runId: run.id,
          datasetId: run.defaultDatasetId,
          keyValueStoreId: run.defaultKeyValueStoreId,
          buildId: run.buildId,
          startedAt: Date.parse(run.startedAt),
        },
      },
    });
  });
  const stop = Effect.fn("Acquisition.requestRemoteStop")(function* (
    operation: P.Operation,
    deadline: number,
  ) {
    if (!operation.run) return yield* fail("missing_run");
    if (!P.terminal(operation.status)) yield* options.http.abort(operation.run.runId, deadline);
    // Even a successful abort response does not settle the Service obligation.
    return yield* refresh(operation, deadline);
  });
  return { start, refresh, stop, recover };
}
