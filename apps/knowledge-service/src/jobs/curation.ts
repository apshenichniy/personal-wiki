import { Context, Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import * as C from "@personal-wiki/contracts/curation";
import * as J from "@personal-wiki/contracts/jobs";
import { buildProposal, CurationError } from "@personal-wiki/curation";
import { Library } from "../storage/library.ts";
import { stable } from "../storage/io.ts";
import { Jobs } from "./service.ts";
import { JobStore } from "./store.ts";
import { JobScheduler } from "./scheduler.ts";
import { JobError } from "./policy.ts";

function excerpt(text: string, maxBytes: number) {
  let result = "",
    bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    result += char;
    bytes += size;
  }
  return result;
}
export const makeCuration = Effect.gen(function* () {
  const jobs = yield* Jobs,
    store = yield* JobStore,
    library = yield* Library,
    scheduler = yield* JobScheduler;
  const prepare = (identityId: string, input: typeof J.PrepareCuration.Type) =>
    store.transaction(
      Effect.gen(function* () {
        const saved = yield* jobs.owned(identityId, input.scope);
        const prior = yield* jobs.priorRequest(
          identityId,
          input.requestId,
          input,
          C.CurationContext,
        );
        if (prior) return prior;
        const job = saved.record;
        if (job.stage !== "prepared" || !job.capture || job.activeAttemptId)
          return yield* new JobError({
            code: "invalid_transition",
            message: "Curation context requires a prepared, idle job.",
          });
        const search = yield* library.search(input.query);
        const ownIds = new Set(job.capture.draft.slots.map((s) => s.noteId));
        const previous: C.CurationContext["previous"][number][] = [];
        // Existing notes are fetched at the same revision, independently of search.
        const current = yield* library.list(search.appliedRevision);
        for (const note of current.notes.filter((n) => ownIds.has(n.noteId))) {
          const captures = yield* Effect.forEach(note.captureIds, (id) =>
            library.capture(id, search.appliedRevision).pipe(Effect.map((r) => r.capture)),
          );
          previous.push({ note, captures });
        }
        const related: C.CurationContext["related"][number][] = [];
        let bytes = 0;
        for (const { note } of search.results) {
          if (ownIds.has(note.noteId) || related.length >= 12) continue;
          const text = excerpt(note.markdown, Math.min(1600, 6000 - bytes));
          if (!text) break;
          const candidate = {
            noteId: note.noteId,
            revision: search.appliedRevision,
            title: note.title,
            text,
            start: 0,
            end: text.length,
          };
          const size = Buffer.byteLength(JSON.stringify(candidate));
          if (bytes + size > 7500) break;
          related.push(candidate);
          bytes += size;
        }
        const feedback = (yield* store.sql<{
          checks: string;
        }>`SELECT checks FROM curation_feedback WHERE job_id=${job.jobId}`)[0];
        const context: C.CurationContext = {
          schemaVersion: 1,
          skillVersion: "x-curation-v1",
          contextId: randomUUID(),
          jobId: job.jobId,
          operationId: randomUUID(),
          proposalId: randomUUID(),
          baseRevision: search.appliedRevision,
          draft: job.capture.draft,
          captures: job.capture.captures,
          related,
          previous,
          feedback: feedback
            ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
                feedback.checks,
              )
            : [],
        };
        yield* store.sql`INSERT INTO curation_contexts VALUES(${context.contextId},${job.jobId},${stable(context)})`;
        yield* jobs.remember(identityId, input.requestId, input, context);
        return context;
      }),
    );
  const get = (contextId: string, jobId: string) =>
    Effect.gen(function* () {
      const row = (yield* store.sql<{
        record: string;
      }>`SELECT record FROM curation_contexts WHERE context_id=${contextId} AND job_id=${jobId}`)[0];
      if (!row)
        return yield* new JobError({
          code: "invalid_request",
          message: "Unknown retained curation context.",
        });
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(C.CurationContext))(
        row.record,
      );
    });
  const proposal = (contextId: string, jobId: string, output: string) =>
    Effect.gen(function* () {
      const context = yield* get(contextId, jobId);
      const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(C.CurationResult))(
        output,
      ).pipe(
        Effect.mapError(
          () =>
            new CurationError({
              code: "quality",
              checks: ["Output must match the supplied CurationResult JSON schema."],
            }),
        ),
      );
      return yield* Effect.try({
        try: () => buildProposal(context, parsed, "gpt-5.6-sol"),
        catch: (e) =>
          e instanceof CurationError
            ? e
            : new CurationError({
                code: "quality",
                checks: ["Unable to compile a valid, attributable publication."],
              }),
      });
    }).pipe(
      Effect.tapError((error) => {
        const checks =
          error instanceof CurationError ? error.checks : ["Retained context is unavailable."];
        return store.sql`INSERT INTO curation_feedback VALUES(${jobId},${stable(checks)}) ON CONFLICT(job_id) DO UPDATE SET checks=excluded.checks`;
      }),
    );
  const fail = (identityId: string, input: typeof J.FailCuration.Type) =>
    store
      .transaction(
        Effect.gen(function* () {
          yield* store.assertOwner();
          yield* jobs.authorizedRunner(identityId);
          const saved = yield* jobs.requireJob(input.scope.jobId);
          if (saved.record.epoch !== input.scope.epoch)
            return yield* new JobError({
              code: "stale_owner",
              message: "Curation ownership changed.",
            });
          const prior = yield* jobs.priorRequest(identityId, input.requestId, input, J.JobView);
          if (prior) return prior;
          yield* jobs.owned(identityId, input.scope);
          if (
            saved.record.stage !== "prepared" ||
            saved.record.activeAttemptId ||
            saved.record.cleanupPending
          )
            return yield* new JobError({
              code: "invalid_transition",
              message: "Curation capacity failure requires an idle prepared job.",
            });
          const next = {
            ...saved.record,
            stage: "failed" as const,
            reason: input.reason,
            lease: null,
          };
          yield* store.put(next, saved.version);
          const result = yield* jobs.view(next);
          yield* jobs.remember(identityId, input.requestId, input, result);
          return result;
        }),
      )
      .pipe(
        Effect.tap((job) =>
          Effect.gen(function* () {
            const saved = yield* store.get(job.jobId);
            if (saved) yield* scheduler.settle(job.jobId, saved.record.generation);
          }),
        ),
      );
  return { prepare, get, proposal, fail };
});
export class JobCuration extends Context.Service<
  JobCuration,
  Effect.Success<typeof makeCuration>
>()("personal-wiki/JobCuration") {
  static layer = Layer.effect(JobCuration, makeCuration);
}
