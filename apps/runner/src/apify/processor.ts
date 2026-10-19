import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { makeJobClient } from "@personal-wiki/client";
import type { JobScope } from "@personal-wiki/contracts/jobs";
import type * as X from "@personal-wiki/contracts/processing";
import * as P from "@personal-wiki/contracts/provider";
import { makeServiceAcquisition } from "./service.ts";
import { makeRetention } from "./retention.ts";
import { articleTargets, normalizeXquikPage, xquikInput } from "./xquik.ts";
import type { makeApifyHttp } from "./http.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const empty = (status: X.AcquisitionResult["status"], diagnostic: string): X.AcquisitionResult => ({
  status,
  pages: [],
  diagnostics: [diagnostic],
});
/** The processing package replays its deterministic plan after restart. Every
 * step adopts the Service operation and retained pages before considering POST. */
export function makeXAcquisition(options: {
  client: Effect.Success<ReturnType<typeof makeJobClient>>;
  http: ReturnType<typeof makeApifyHttp>;
  spool: string;
  scope: JobScope;
}) {
  const service = makeServiceAcquisition(options);
  const retain = makeRetention({ ...options, spool: `${options.spool}/raw` });
  const api = options.client.providers;
  const articles = new Map<string, string>();
  return Effect.fn("Acquisition.processPlan")(function* (plan: X.AcquisitionRequest) {
    for (const pending of yield* api.pending()) {
      if (
        pending.run &&
        P.terminal(pending.status) &&
        !pending.costStable &&
        (pending.costSampleAt === null || Date.now() - pending.costSampleAt >= 10_000)
      )
        yield* service.refresh(pending, Date.now() + 15_000).pipe(Effect.ignore);
      // Failed accounting reads leave the conservative reservation in place.
    }
    const input = yield* Effect.try({
      try: () => xquikInput(plan, articles),
      catch: () => "input_unavailable" as const,
    }).pipe(Effect.result);
    if (input._tag === "Failure")
      return empty("unavailable", "Required target relationship is unavailable.");
    const start = service.start(options.scope, {
      planKey: `${plan.mode}:${hash(plan.key)}`,
      inputJson: input.success,
      replacementOf: null,
    });
    let dispatched = yield* start.pipe(Effect.result);
    // Conservative reservations can temporarily exhaust the job allowance while
    // completed runs await their second billing sample. Reconcile within the
    // original window before abandoning optional capture; never enlarge a cap.
    for (
      let retry = 0;
      retry < 2 &&
      dispatched._tag === "Failure" &&
      "code" in dispatched.failure &&
      dispatched.failure.code === "budget";
      retry++
    ) {
      const pending = (yield* api.pending()).filter(
        (op) =>
          op.job.jobId === options.scope.jobId &&
          op.run &&
          P.terminal(op.status) &&
          op.archived &&
          !op.costStable &&
          op.job.deadline > Date.now() + 11_000,
      );
      if (!pending.length) break;
      yield* Effect.sleep("11 seconds");
      for (const op of pending) yield* service.refresh(op, Date.now() + 15_000).pipe(Effect.ignore);
      dispatched = yield* start.pipe(Effect.result);
    }
    if (dispatched._tag === "Failure") {
      const error = dispatched.failure;
      if ("code" in error && error.code === "budget")
        return empty("budget", "Shared provider budget reached.");
      if (
        "code" in error &&
        ["deadline", "deadline_exceeded", "stopped"].includes(String(error.code))
      )
        return empty("deadline", "No new acquisition is permitted.");
      return yield* Effect.fail(error);
    }
    let operation = dispatched.success;
    let abortRequested = false;
    while (!P.terminal(operation.status)) {
      const inspection = yield* api.inspect({ payload: { jobId: options.scope.jobId } });
      const stopped =
        inspection.shouldStop || operation.stopRequested || Date.now() >= operation.job.deadline;
      operation = (yield* stopped && !abortRequested
        ? service.stop(operation, Date.now() + 15_000)
        : service.refresh(operation, Date.now() + 15_000)).operation;
      if (stopped) abortRequested = true;
      if (!P.terminal(operation.status)) yield* Effect.sleep("1 second");
    }
    const result = yield* retain(operation, Date.now() + 120_000).pipe(Effect.result);
    let status: X.AcquisitionResult["status"] =
      operation.status === "SUCCEEDED" ? "succeeded" : "partial";
    const diagnostics: string[] = [];
    if (result._tag === "Failure") {
      const error = result.failure;
      if ("code" in error && error.code === "capacity") {
        status = "capacity";
        diagnostics.push("Raw evidence capacity reached; retention remains incomplete.");
      } else return yield* Effect.fail(error);
    }
    const manifests = yield* api.pages({ payload: { operationId: operation.operationId } });
    const pages: X.AcquisitionResult["pages"][number][] = [];
    for (const manifest of manifests
      .filter((page) => page.pageKey.startsWith("dataset:"))
      .sort((a, b) => a.offset - b.offset)) {
      const retained = yield* api.raw({
        payload: { operationId: operation.operationId, pageKey: manifest.pageKey },
      });
      const values: unknown = JSON.parse(Buffer.from(retained.base64, "base64").toString("utf8"));
      if (!Array.isArray(values)) return yield* Effect.die("Verified dataset is not an array");
      articleTargets(values, articles);
      pages.push(
        normalizeXquikPage(
          values,
          {
            assetId: manifest.assetId,
            sha256: manifest.sha256,
            byteLength: manifest.byteLength,
            provider: "xquik/x-tweet-scraper",
            runId: operation.run!.runId,
            page: manifest.offset,
          },
          plan.mode,
        ),
      );
    }
    if (!manifests.some((page) => page.pageKey === "report"))
      diagnostics.push("Actor run-report unavailable; no exhaustive coverage is inferred.");
    if (operation.status !== "SUCCEEDED")
      diagnostics.push(`Provider terminal status: ${operation.status}.`);
    return { status, pages, diagnostics } satisfies X.AcquisitionResult;
  });
}
