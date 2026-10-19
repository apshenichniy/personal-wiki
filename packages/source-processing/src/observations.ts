import { Effect, Schema } from "effect";
import * as P from "@personal-wiki/contracts/processing";
import { originalText, type Posts } from "./graph.ts";

export class ProcessingError extends Schema.TaggedError<ProcessingError>()("ProcessingError", {
  code: Schema.Literals(["invalid_input", "invalid_evidence"]),
  message: Schema.String,
}) {}
/** Mutable state is scoped to one replayable acquisition plan. Raw pages remain
 * immutable; this collector only builds a provenance-preserving normalized view. */
export function createObservations() {
  const posts: Posts = new Map();
  const articles = new Map<string, P.PreparedArticle>();
  const warnings = new Set<string>(["bounded_snapshot_not_exhaustive"]);
  const acquisitions: P.PreparedSource["acquisitions"][number][] = [];
  const rawAssets = new Map<string, string>();
  let rawBytes = 0;
  let acquiredRows = 0;
  let malformedRows = 0;
  let duplicateRows = 0;
  let halted = false;
  let rawCapacity = false;
  const articleUrl = (id: string) => `https://x.com/i/article/${id}`;
  const record = Effect.fn(function* (plan: P.AcquisitionRequest, result: P.AcquisitionResult) {
    const { mode, allocations, limit, authorId, conversationId } = plan;
    const rowCount = result.pages.reduce(
      (sum, page) => sum + page.posts.length + page.articles.length,
      0,
    );
    acquiredRows += rowCount;
    acquisitions.push({
      request: plan,
      status: result.status,
      raw: result.pages.map((p) => p.raw),
      rowCount,
      diagnostics: result.diagnostics,
    });
    if (result.status !== "succeeded") warnings.add(`${mode}:${result.status}`);
    if (result.status === "budget" || result.status === "deadline") halted = true;
    if (result.status === "capacity") {
      halted = true;
      // Missing required main/ancestry bytes is actionable; an optional discussion
      // or quote/article overflow may preserve already retained useful main text.
      if (["anchor", "parents", "author"].includes(mode)) rawCapacity = true;
      else warnings.add(`${mode}:processing_gap`);
    }
    if (rowCount >= limit) warnings.add(`${mode}:requested_limit_reached`);
    if (rowCount > limit) warnings.add(`${mode}:provider_over_return`);
    let seen = 0;
    const acceptedIds = new Set<string>();
    const allocatedRows = new Map<string, number>();
    for (const page of result.pages) {
      const oldHash = rawAssets.get(page.raw.assetId);
      if (oldHash && oldHash !== page.raw.sha256)
        return yield* new ProcessingError({
          code: "invalid_evidence",
          message: "An immutable raw asset changed its checksum.",
        });
      if (!oldHash) {
        rawAssets.set(page.raw.assetId, page.raw.sha256);
        rawBytes += page.raw.byteLength;
      }
      if (page.raw.byteLength > 16_777_216 || rawBytes > 67_108_864) {
        rawCapacity = true;
        halted = true;
        warnings.add("raw_capacity_exceeded");
        continue;
      }
      for (const [row, value] of page.posts.entries()) {
        const parsed = Schema.decodeUnknownResult(P.XPost)(value);
        if (parsed._tag === "Failure") {
          malformedRows++;
          warnings.add("malformed_post_row");
          continue;
        }
        if (mode === "article") {
          warnings.add("article:unrelated_row");
          continue;
        }
        const post = parsed.success;
        if ((post.parentStatus === "reply") !== (post.parentId !== null)) {
          malformedRows++;
          warnings.add("invalid_parent_metadata");
          continue;
        }
        const duplicate = acceptedIds.has(post.id);
        if (
          ["anchor", "parents", "quotes"].includes(mode) &&
          !allocations.some((a) => a.targetId === post.id)
        ) {
          warnings.add(`${mode}:unrelated_row`);
          continue;
        }
        if (
          mode === "author" &&
          (post.authorId !== authorId ||
            (conversationId && post.conversationId && post.conversationId !== conversationId))
        ) {
          warnings.add("author:unrelated_row");
          continue;
        }
        if (mode === "direct" || mode === "nested") {
          const allocation = allocations.find((a) => a.targetId === post.parentId);
          if (!allocation) {
            warnings.add(`${mode}:unrelated_row`);
            continue;
          }
          const count = allocatedRows.get(allocation.targetId) ?? 0;
          if (!duplicate && count >= allocation.limit) {
            warnings.add(`${mode}:branch_limit_reached`);
            continue;
          }
          if (!duplicate) allocatedRows.set(allocation.targetId, count + 1);
        }
        if (!duplicate && seen >= limit) continue;
        if (!duplicate) {
          seen++;
          acceptedIds.add(post.id);
        }
        const origin: P.AcquisitionOrigin = { requestKey: plan.key, mode, raw: page.raw, row };
        const previous = posts.get(post.id);
        if (previous) {
          duplicateRows++;
          previous.origins.push(origin);
          const text = originalText(post);
          if (!previous.variants.includes(text)) {
            previous.variants.push(text);
            warnings.add(`text_variants:${post.id}`);
          }
          // Do not conceal contradictory graph identities behind deduplication.
          if (
            ["authorId", "conversationId"].some((field) => {
              const key = field as "authorId" | "conversationId";
              return (
                previous.post[key] !== null &&
                post[key] !== null &&
                previous.post[key] !== post[key]
              );
            }) ||
            (previous.post.parentStatus !== "unknown" &&
              post.parentStatus !== "unknown" &&
              previous.post.parentId !== post.parentId)
          ) {
            previous.conflict = true;
            warnings.add(`relationship_conflict:${post.id}`);
          }
          // Long-post text takes precedence over a legacy truncated text field.
          // Otherwise keep the first observed version with all variants traceable.
          previous.post = {
            ...previous.post,
            longText: previous.post.longText ?? post.longText,
            authorId: previous.post.authorId ?? post.authorId,
            conversationId: previous.post.conversationId ?? post.conversationId,
            parentId:
              previous.post.parentStatus === "unknown" ? post.parentId : previous.post.parentId,
            parentStatus:
              previous.post.parentStatus === "unknown"
                ? post.parentStatus
                : previous.post.parentStatus,
            quotedId: previous.post.quotedId ?? post.quotedId,
            articleId: previous.post.articleId ?? post.articleId,
            language: previous.post.language ?? post.language,
            postedAt: previous.post.postedAt ?? post.postedAt,
            isBot: previous.post.isBot ?? post.isBot,
            references: [
              ...new Map(
                [...previous.post.references, ...post.references].map((ref) => [
                  `${ref.kind}:${ref.url}`,
                  ref,
                ]),
              ).values(),
            ],
          };
        } else
          posts.set(post.id, {
            post,
            origins: [origin],
            variants: [originalText(post)],
            conflict: false,
          });
      }
      for (const [row, value] of page.articles.entries()) {
        const parsed = Schema.decodeUnknownResult(P.XArticle)(value);
        if (parsed._tag === "Failure") {
          malformedRows++;
          warnings.add("malformed_article_row");
          continue;
        }
        if (mode !== "article" || !allocations.some((a) => a.targetId === parsed.success.id))
          continue;
        const article = parsed.success;
        if (!acceptedIds.has(article.id)) {
          if (seen >= limit) continue;
          seen++;
          acceptedIds.add(article.id);
        }
        const origin: P.AcquisitionOrigin = { requestKey: plan.key, mode, raw: page.raw, row };
        const previous = articles.get(article.id);
        if (previous) {
          duplicateRows++;
          const quality = (value: P.XArticle) =>
            value.body?.trim()
              ? { acquired: 3, partial: 2, preview: 1, unavailable: 0 }[value.bodyStatus]
              : 0;
          const preferred =
            quality(article) > quality(previous.article) ? article : previous.article;
          if (article.body !== previous.article.body)
            warnings.add(`article_text_variants:${article.id}`);
          articles.set(article.id, {
            ...previous,
            article: {
              ...preferred,
              references: [
                ...new Map(
                  [...previous.article.references, ...article.references].map((ref) => [
                    `${ref.kind}:${ref.url}`,
                    ref,
                  ]),
                ).values(),
              ],
            },
            origins: [...previous.origins, origin],
          });
        } else
          articles.set(article.id, {
            article,
            canonicalUrl: articleUrl(article.id),
            origins: [origin],
          });
      }
    }
  });
  return {
    posts,
    articles,
    warnings,
    acquisitions,
    record,
    get halted() {
      return halted;
    },
    get rawCapacity() {
      return rawCapacity;
    },
    get counts() {
      return { acquiredRows, malformedRows, duplicateRows };
    },
  };
}
