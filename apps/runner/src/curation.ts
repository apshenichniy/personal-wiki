import { Effect, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { makeJobClient } from "@personal-wiki/client";
import type { Claim } from "@personal-wiki/contracts/jobs";
import { CurationResult, type CurationContext } from "@personal-wiki/contracts/curation";
import { admit, CodexError, failure } from "./codex/profile.ts";
import { curatePrepared } from "./codex/curate.ts";
import type { CodexRuntime } from "./codex/execute.ts";

// Codex Structured Outputs requires an inline object root and closed objects.
// Effect's public JSON Schema intentionally permits extra fields and uses a root ref.
function closedObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(closedObjects);
  if (value === null || typeof value !== "object") return value;
  const fields = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, closedObjects(item)]),
  );
  return fields.type === "object" ? { ...fields, additionalProperties: false } : fields;
}
export function curationOutputSchema() {
  const document = Schema.toJsonSchemaDocument(CurationResult);
  const root = document.definitions.CurationResult;
  if (!root) throw failure("configuration");
  return JSON.stringify(closedObjects({ ...root, $defs: document.definitions }));
}
export function contextInput(context: CurationContext, instructions: string) {
  const data = {
    schemaVersion: 1,
    skillVersion: context.skillVersion,
    contextId: context.contextId,
    revision: context.baseRevision,
    materials: context.draft.slots.map((slot) => {
      const capture = context.captures.find((c) => c.captureId === slot.captureId)!;
      return {
        noteId: slot.noteId,
        source: slot.source,
        captureId: capture.captureId,
        capturedAt: capture.endedAt,
        submittedAnchorId: capture.submittedAnchorId,
        focusIds: capture.focusIds,
        observations: capture.observations,
        coverage: capture.coverage,
        warnings: capture.warnings,
      };
    }),
    related: context.related,
    previous: context.previous.map((p) => ({
      note: p.note,
      dates: p.captures.map((c) => c.endedAt),
    })),
    repairChecks: context.feedback,
  };
  const input = {
    prompt: JSON.stringify(data),
    instructions,
    schema: curationOutputSchema(),
    related: context.related.map((note) => JSON.stringify(note)),
  };
  admit(input);
  return input;
}
export function retrievalQuery(claim: NonNullable<typeof Claim.Type>) {
  const text =
    claim.capture?.captures
      .flatMap((c) =>
        c.observations.filter((o) => c.focusIds.includes(o.providerId)).map((o) => o.text),
      )
      .join(" ") ?? "";
  const stop = new Set(
    "about after again before being between could every first from have into more most other should their there these they this those through using very what when where which while will with would your that than then them also some such because people things something really just like make much were been only does dont have from https twitter article source author post thread today need want think know look used even over each both same many further world still better different really getting".split(
      " ",
    ),
  );
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{M}]{4,40}/gu) ?? [])
    if (!stop.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return (
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ""
  );
}
export function curateClaim(options: {
  client: Effect.Success<ReturnType<typeof makeJobClient>>;
  runtime: CodexRuntime;
  claim: NonNullable<typeof Claim.Type>;
  skillFile: string;
}) {
  return Effect.gen(function* () {
    const { client, runtime, claim } = options;
    const context = yield* client.worker.prepareCuration({
      payload: { requestId: randomUUID(), scope: claim.scope, query: retrievalQuery(claim) },
    });
    const input = yield* Effect.tryPromise({
      try: async () => contextInput(context, await readFile(options.skillFile, "utf8")),
      catch: (e) => (e instanceof CodexError ? e : failure("configuration")),
    }).pipe(Effect.result);
    if (input._tag === "Failure")
      return yield* client.worker.failCuration({
        payload: {
          requestId: randomUUID(),
          scope: claim.scope,
          reason:
            input.failure.code === "capacity" ? "curation_capacity" : "curation_configuration",
        },
      });
    return yield* curatePrepared({
      client,
      runtime,
      claim,
      input: input.success,
      contextId: context.contextId,
    });
  });
}
