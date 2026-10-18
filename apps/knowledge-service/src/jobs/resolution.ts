import { Context, Effect, Layer } from "effect";
import * as J from "@personal-wiki/contracts/jobs";
import { Jobs } from "./service.ts";
import { JobStore } from "./store.ts";
import { Library } from "../storage/library.ts";
import { JobError } from "./policy.ts";
import { stable } from "../storage/io.ts";
export const makeResolution = Effect.gen(function* () {
  const jobs = yield* Jobs;
  const store = yield* JobStore;
  const library = yield* Library;
  const sql = store.sql;
  const resolve = (identityId: string, input: typeof J.ResolveSource.Type) =>
    store.transaction(
      Effect.gen(function* () {
        yield* jobs.authorizedRunner(identityId);
        const prior = yield* jobs.priorRequest(
          identityId,
          input.requestId,
          input,
          J.SourceResolution,
        );
        if (prior) return prior;
        const saved = yield* jobs.owned(identityId, input.scope);
        const job = saved.record;
        if (
          job.stage !== "acquiring" ||
          job.cleanupPending ||
          job.capture ||
          (yield* sql`SELECT job_id FROM drafts WHERE job_id=${job.jobId}`).length
        )
          return yield* new JobError({
            code: "invalid_transition",
            message: "Resolve source identity before reserving capture identities.",
          });
        const source = input.source;
        const changed = source.primaryId !== job.anchorId;
        if (
          source.kind === "x_article" ||
          (changed &&
            (source.kind !== "x_author_thread" ||
              source.resolution !== "resolved" ||
              !source.aliases.includes(job.anchorId))) ||
          (source.resolution !== "resolved" && source.aliases.some((id) => id !== job.anchorId))
        )
          return yield* new JobError({
            code: "invalid_request",
            message: "Only a resolved author continuation can alias another material.",
          });
        const canonical = `x:post:${source.primaryId}`;
        const keys = [
          ...new Set([job.sourceKey, canonical, ...source.aliases.map((id) => `x:post:${id}`)]),
        ];
        for (const key of keys) {
          const alias = (yield* sql<{
            canonical_key: string;
          }>`SELECT canonical_key FROM source_aliases WHERE alias_key=${key}`)[0];
          if (alias && alias.canonical_key !== canonical)
            return yield* new JobError({
              code: "invalid_transition",
              message: "Existing source resolution cannot be silently changed.",
            });
          if (
            key !== canonical &&
            (yield* sql`SELECT external_key FROM identities WHERE external_key=${key}`).length
          )
            return yield* new JobError({
              code: "invalid_transition",
              message: "Already reserved source identities require an explicit merge decision.",
            });
        }
        const active = yield* store.activeSource(canonical);
        const identity = (yield* sql<{
          note_id: string;
        }>`SELECT note_id FROM identities WHERE external_key=${canonical}`)[0];
        const current = yield* library.list();
        const note = identity
          ? current.notes.find((note) => note.noteId === identity.note_id)
          : undefined;
        let result: typeof J.SourceResolution.Type;
        if ((active && active.record.jobId !== job.jobId) || (note && job.mode === "save")) {
          const redundant = {
            ...job,
            stage: "cancelled" as const,
            reason: note && job.mode === "save" ? "existing_note" : "duplicate_source",
            lease: null,
            ready: false,
            epoch: job.epoch + 1,
          };
          yield* store.put(redundant, saved.version);
          if (active && active.record.jobId !== job.jobId) {
            yield* sql`INSERT INTO job_redirects VALUES(${job.jobId},${active.record.jobId})`;
            result = {
              outcome: "existing_job",
              job: yield* jobs.view(active.record),
              noteId: note?.noteId ?? null,
            };
          } else
            result = {
              outcome: "existing_note",
              job: yield* jobs.view(redundant),
              noteId: note!.noteId,
            };
        } else {
          const next = { ...job, sourceKey: canonical };
          yield* store.put(next, saved.version);
          result = { outcome: "continued", job: yield* jobs.view(next), noteId: null };
        }
        for (const key of source.resolution === "resolved" ? keys : [])
          yield* sql`INSERT INTO source_aliases VALUES(${key},${canonical}) ON CONFLICT(alias_key) DO NOTHING`;
        // Exact extractor evidence is operational state, separate from agent prose.
        yield* sql`INSERT INTO source_resolutions(job_id,request_id,payload) VALUES(${job.jobId},${input.requestId},${stable(input)})`;
        yield* jobs.remember(identityId, input.requestId, input, result);
        return result;
      }),
    );
  return { resolve };
});
export class SourceResolution extends Context.Service<
  SourceResolution,
  Effect.Success<typeof makeResolution>
>()("personal-wiki/SourceResolution") {
  static layer = Layer.effect(SourceResolution, makeResolution);
}
