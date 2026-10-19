import { Schema } from "effect";
import * as K from "@personal-wiki/contracts/knowledge";
import * as P from "@personal-wiki/contracts/processing";

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const id = (value: unknown): string | null => (Schema.is(K.ProviderId)(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const timestamp = (value: unknown): string | null => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};
function references(value: Row): P.XPost["references"] {
  const refs: Array<P.XPost["references"][number]> = [];
  const add = (kind: P.XPost["references"][number]["kind"], value: unknown) => {
    if (typeof value === "string" && value.length <= 4096) {
      try {
        const url = new URL(value);
        if (["https:", "http:"].includes(url.protocol)) refs.push({ kind, url: url.href });
      } catch {
        /* Malformed references never become fetch targets. */
      }
    }
  };
  for (const entities of [row(value.entities), row(row(value.noteTweet).entities)]) {
    if (Array.isArray(entities.urls))
      for (const item of entities.urls) {
        const url = row(item);
        add("external_page", url.expandedUrl ?? url.url);
      }
  }
  if (Array.isArray(value.media))
    for (const item of value.media) {
      const media = row(item);
      const kind =
        media.type === "photo"
          ? "image"
          : ["video", "animated_gif"].includes(String(media.type))
            ? "video"
            : null;
      if (kind) add(kind, media.expandedUrl ?? media.mediaUrl ?? media.url);
    }
  if (typeof value.coverImageUrl === "string") add("image", value.coverImageUrl);
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.url}`, ref])).values()];
}
/** Pinned xquik raw/nested output. Do not flatten quoted posts or omit diagnostic
 * rows: array index remains the row in the retained original JSON page. */
export function xquikPost(value: unknown): P.XPost | null {
  const source = row(value);
  const postId = id(source.id);
  if (!postId || source.resultType === "article") return null;
  const short = text(source.text);
  const long = text(row(source.noteTweet).text);
  if (short === null && long === null) return null;
  const parentId = id(source.inReplyToId);
  return {
    id: postId,
    text: short ?? "",
    longText: long,
    authorId: id(row(source.author).id),
    parentId,
    parentStatus:
      source.isReply === false
        ? "root"
        : source.isReply === true || parentId !== null
          ? "reply"
          : "unknown",
    conversationId: id(source.conversationId),
    language: text(source.lang),
    quotedId: id(source.quotedTweetId) ?? id(row(source.quotedTweet).id),
    articleId: id(row(source.article).id) ?? id(row(source.article).articleId),
    postedAt: timestamp(source.createdAt),
    isBot: bool(row(source.author).isBot),
    references: references(source),
  };
}
export function xquikArticle(value: unknown): P.XArticle | null {
  const source = row(value);
  if (source.resultType !== "article") return null;
  const article = row(source.article);
  const articleId = id(article.articleId);
  if (!articleId) return null;
  const markdown = text(article.bodyMarkdown);
  const body = markdown?.trim() ? markdown : text(article.bodyText);
  const acquired = Boolean(body?.trim());
  return {
    id: articleId,
    title: text(article.title) ?? "",
    body: acquired ? body : null,
    bodyStatus: acquired
      ? "acquired"
      : text(article.previewText)?.trim()
        ? "preview"
        : "unavailable",
    language: text(article.lang) ?? text(source.lang),
    references: references(article),
  };
}
export function normalizeXquikPage(
  values: ReadonlyArray<unknown>,
  raw: typeof P.RawEvidence.Type,
  mode: P.AcquisitionRequest["mode"],
): typeof P.AcquiredPage.Type {
  return mode === "article"
    ? { raw, posts: [], articles: values.map(xquikArticle) }
    : { raw, posts: values.map(xquikPost), articles: [] };
}
/** Article requests in the processing model use article IDs; xquik's
 * articleTweetIds option instead requires a post containing that article. */
export function articleTargets(
  values: ReadonlyArray<unknown>,
  targets = new Map<string, string>(),
) {
  for (const value of values) {
    const source = row(value);
    const post = xquikPost(source);
    if (post?.articleId && !targets.has(post.articleId)) targets.set(post.articleId, post.id);
    if (source.resultType === "article") {
      const article = xquikArticle(source);
      const tweetId = id(source.sourceTweetId);
      if (article && tweetId && !targets.has(article.id)) targets.set(article.id, tweetId);
    }
  }
  return targets;
}
export function xquikInput(request: P.AcquisitionRequest, articles: ReadonlyMap<string, string>) {
  const plan = Schema.decodeUnknownSync(P.AcquisitionRequest)(request);
  const options = {
    queryType: "Latest",
    outputVariant: "raw",
    outputPreset: "nested",
    alwaysSaveRunRecords: true,
    maxItems: plan.limit,
    maxItemsPerTarget: Math.max(...plan.allocations.map((target) => target.limit)),
  };
  const ids = plan.allocations.map((target) => target.targetId);
  if (
    !ids.length ||
    ids.length > 1000 ||
    new Set(ids).size !== ids.length ||
    plan.limit !== plan.allocations.reduce((sum, target) => sum + target.limit, 0)
  )
    throw new Error("Invalid acquisition allocation");
  switch (plan.mode) {
    case "anchor":
    case "parents":
    case "quotes":
      return JSON.stringify({ ...options, mode: "tweets", tweetIds: ids });
    case "author":
      return JSON.stringify({ ...options, mode: "thread", threadTweetIds: ids });
    case "direct":
    case "nested":
      return JSON.stringify({ ...options, mode: "replies", replyTweetIds: ids });
    case "latest":
      if (!plan.conversationId) throw new Error("Conversation identity is required for search");
      return JSON.stringify({ ...options, mode: "search", conversationIds: [plan.conversationId] });
    case "article":
      return JSON.stringify({
        ...options,
        mode: "article",
        articleTweetIds: ids.map((article) => {
          const post = articles.get(article);
          if (!post) throw new Error("Article containing-post evidence is missing");
          return post;
        }),
      });
  }
}
