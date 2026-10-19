import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { makeJobClient } from "@personal-wiki/client";
import * as J from "@personal-wiki/contracts/jobs";
import * as K from "@personal-wiki/contracts/knowledge";
import type * as X from "@personal-wiki/contracts/processing";
import { prepareX, defaultCapturePolicy } from "@personal-wiki/source-processing";
import { makeXAcquisition } from "./processor.ts";
import { RetentionError } from "./retention.ts";
import type { makeApifyHttp } from "./http.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
class CapturePreparationError extends Schema.TaggedError<CapturePreparationError>()(
  "CapturePreparationError",
  {
    code: Schema.Literals(["capacity", "contract"]),
    message: Schema.String,
  },
) {}
const capacity = () =>
  new CapturePreparationError({
    code: "capacity",
    message: "Prepared source exceeds retained capacity.",
  });
function requestId(jobId: string, purpose: string) {
  const hex = sha(`${jobId}/${purpose}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function captureFromPrepared(
  prepared: X.PreparedSource,
  draft: K.Draft,
  rawAssetIds: ReadonlyArray<string>,
  runIds: ReadonlyArray<string>,
  startedAt: string,
  endedAt: string,
) {
  const captures: K.Capture[] = [];
  const uploads: Array<typeof K.AssetUpload.Type> = [];
  for (const slot of draft.slots) {
    const material = prepared.materials.find(
      (value) =>
        value.source.primaryId === slot.source.primaryId && value.source.kind === slot.source.kind,
    );
    if (!material)
      throw new CapturePreparationError({
        code: "contract",
        message: "Reserved material differs from prepared source.",
      });
    // Keep the normalized P5 manifest (including exact raw-row origins, policy,
    // coverage, unprocessed references and counts) as a durable linked asset.
    const normalized = JSON.stringify({
      schemaVersion: 1,
      material,
      policy: prepared.policy,
      acquisitions: prepared.acquisitions,
      coverage: prepared.coverage,
      counts: prepared.counts,
    });
    if (Buffer.byteLength(normalized) > 1_048_576) throw capacity();
    uploads.push({
      jobId: draft.jobId,
      assetId: slot.assetId,
      mediaType: "application/json",
      base64: Buffer.from(normalized).toString("base64"),
      sha256: sha(normalized),
    });
    const observations: Array<typeof K.Observation.Type> = material.article
      ? [
          {
            providerId: material.article.article.id,
            canonicalUrl: material.article.canonicalUrl,
            text: [material.article.article.title, material.article.article.body ?? ""]
              .filter(Boolean)
              .join("\n\n"),
            authorId: null,
            parentId: null,
            conversationId: null,
            quotedId: null,
            articleId: material.article.article.id,
            postedAt: null,
          },
        ]
      : material.posts.map(({ post, canonicalUrl }) => ({
          providerId: post.id,
          canonicalUrl,
          text: post.longText?.trim() ? post.longText : post.text,
          authorId: post.authorId,
          parentId: post.parentId,
          conversationId: post.conversationId,
          quotedId: post.quotedId,
          articleId: post.articleId,
          postedAt: post.postedAt,
        }));
    captures.push({
      schemaVersion: 1,
      captureId: slot.captureId,
      sourceId: slot.source.sourceId,
      startedAt,
      endedAt,
      submittedUrl: prepared.submittedUrl,
      submittedAnchorId: prepared.anchorId,
      focusIds: material.article
        ? [material.article.article.id]
        : material.posts.filter((post) => post.role === "main").map((post) => post.post.id),
      observations,
      assetIds: [...new Set([slot.assetId, ...rawAssetIds])],
      representations: [
        {
          schemaVersion: 1,
          representationId: slot.representationId,
          captureId: slot.captureId,
          assetId: slot.assetId,
          language: material.language,
          kind: "extracted_text",
          text: material.originalText,
          derivation:
            "Pinned xquik normalization; original text at /material/originalText in the linked normalized JSON asset.",
        },
      ],
      provenance: {
        provider: "xquik/x-tweet-scraper",
        runIds: [...runIds],
        policyVersion: prepared.policy.version,
      },
      coverage: {
        main: material.article ? material.article.article.bodyStatus : prepared.coverage.main,
        discussion: material.article ? "not_applicable" : prepared.coverage.discussion,
        context: prepared.coverage.missingParents.length ? "partial" : "bounded",
      },
      warnings: [
        ...prepared.coverage.warnings,
        ...prepared.coverage.unprocessed.map(
          (reference) => `unprocessed:${JSON.stringify(reference)}`,
        ),
      ],
    });
  }
  if (Buffer.byteLength(JSON.stringify(captures)) > 1_048_576) throw capacity();
  return { captures: Schema.decodeUnknownSync(Schema.Array(K.Capture))(captures), uploads };
}

/** Acquisition stops at the durable prepared state. P8 consumes the retained
 * capture and invokes Codex; this function never launches a model or publishes. */
export function ingestX(options: {
  client: Effect.Success<ReturnType<typeof makeJobClient>>;
  http: ReturnType<typeof makeApifyHttp>;
  spool: string;
  claim: NonNullable<typeof J.Claim.Type>;
}) {
  return Effect.gen(function* () {
    const { client, claim } = options;
    if (claim.capture) return claim.job;
    const scope = claim.scope;
    const policy = yield* client.providers.configure({
      payload: { requestId: randomUUID(), scope, policy: defaultCapturePolicy },
    });
    const spool = join(options.spool, scope.jobId);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(spool, { recursive: true, mode: 0o700 });
        const stat = await lstat(spool);
        if (!stat.isDirectory() || stat.mode & 0o077) throw new Error("Private spool required");
      },
      catch: () =>
        new RetentionError({
          code: "storage",
          message: "Private acquisition spool is unavailable.",
        }),
    });
    const prepared = yield* prepareX(
      { submittedUrl: claim.job.submittedUrl, policy, knownSources: [] },
      makeXAcquisition({ ...options, spool, scope }),
    );
    const fail = (reason: (typeof J.FailAcquisition.Type)["reason"]) =>
      client.worker.failAcquisition({
        payload: {
          requestId: requestId(scope.jobId, `${scope.epoch}:fail:${reason}`),
          scope,
          reason,
          warnings: prepared.coverage.warnings.slice(0, 64),
        },
      });
    if (prepared.outcome !== "ready")
      return yield* fail(
        prepared.outcome === "capacity"
          ? "source_capacity"
          : prepared.outcome === "identity_conflict"
            ? "identity_conflict"
            : "source_unavailable",
      );
    const source = prepared.materials[0]!.source;
    const resolution = yield* client.worker.resolve({
      payload: {
        requestId: requestId(scope.jobId, `${scope.epoch}:resolve`),
        scope,
        source,
        evidence: `xquik-normalized-source:${sha(JSON.stringify(source))}`,
      },
    });
    if (resolution.outcome !== "continued") return resolution.job;
    const draft = yield* client.worker.reserve({
      payload: {
        requestId: requestId(scope.jobId, "reserve"),
        scope,
        sources: prepared.materials.map((material) => material.source),
      },
    });
    const operations = (yield* client.providers.inspect({ payload: { jobId: scope.jobId } }))
      .operations;
    const raw: string[] = [];
    for (const operation of operations)
      for (const page of yield* client.providers.pages({
        payload: { operationId: operation.operationId },
      }))
        raw.push(page.assetId);
    const timestamps = operations.flatMap((operation) =>
      operation.finishedAt === null ? [] : [operation.finishedAt],
    );
    const endedAt = new Date(
      timestamps.length ? Math.max(...timestamps) : Date.parse(claim.job.startedAt!),
    ).toISOString();
    const built = yield* Effect.try({
      try: () =>
        captureFromPrepared(
          prepared,
          draft,
          raw,
          operations.flatMap((operation) => (operation.run ? [operation.run.runId] : [])),
          claim.job.startedAt!,
          endedAt,
        ),
      catch: (error) =>
        error instanceof CapturePreparationError
          ? error
          : new CapturePreparationError({ code: "contract", message: "Invalid prepared capture." }),
    }).pipe(Effect.result);
    if (built._tag === "Failure") {
      if (built.failure.code === "capacity") return yield* fail("source_capacity");
      return yield* built.failure;
    }
    for (const asset of built.success.uploads)
      yield* client.worker.upload({
        payload: {
          requestId: requestId(scope.jobId, `${scope.epoch}:upload:${asset.assetId}`),
          scope,
          asset,
        },
      });
    return yield* client.worker.prepare({
      payload: {
        requestId: requestId(scope.jobId, `${scope.epoch}:prepare`),
        scope,
        captures: built.success.captures,
      },
    });
  });
}
