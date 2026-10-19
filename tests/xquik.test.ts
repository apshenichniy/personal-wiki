import { expect, test } from "bun:test";
import { Effect } from "effect";
import type * as P from "@personal-wiki/contracts/processing";
import {
  normalizeXquikPage,
  xquikPost,
  xquikArticle,
  xquikInput,
  articleTargets,
} from "../apps/runner/src/apify/xquik.ts";
import { admitActorInput } from "../apps/knowledge-service/src/providers/admission.ts";
import { createObservations } from "../packages/source-processing/src/observations.ts";
const post = {
  id: "100",
  text: "Short preview",
  noteTweet: { text: "Full substantive original source text" },
  author: { id: "10" },
  isReply: false,
  conversationId: "100",
  createdAt: "Mon Oct 19 12:00:00 +0000 2026",
  lang: "en",
  article: { id: "900", previewText: "Preview is not article body" },
  quotedTweet: { id: "200", text: "Quote preview" },
  entities: {
    urls: [{ expandedUrl: "https://example.com/source" }, { expandedUrl: "javascript:alert(1)" }],
  },
};
const plan = (mode: P.AcquisitionRequest["mode"] = "anchor"): P.AcquisitionRequest => ({
  key: "0:anchor:100/1",
  mode,
  allocations: [{ targetId: "100", limit: 1 }],
  limit: 1,
  authorId: "10",
  conversationId: "100",
  sort: "Latest",
});
const raw = {
  assetId: crypto.randomUUID(),
  sha256: "a".repeat(64),
  byteLength: 400,
  provider: "xquik",
  runId: "synthetic",
  page: 0,
};

test("pinned output preserves long original text, explicit graph metadata and inert external references", () => {
  const normalized = xquikPost(post);
  expect(normalized).toMatchObject({
    id: "100",
    text: "Short preview",
    longText: post.noteTweet.text,
    parentStatus: "root",
    parentId: null,
    articleId: "900",
    quotedId: "200",
    isBot: null,
    postedAt: "2026-10-19T12:00:00.000Z",
  });
  expect(normalized?.references).toEqual([
    { kind: "external_page", url: "https://example.com/source" },
  ]);
  expect(xquikPost({ id: "100", text: "No relation evidence" })?.parentStatus).toBe("unknown");
  expect(xquikPost({ error: "not available" })).toBeNull();
  expect(xquikArticle(post)).toBeNull();
});

test("normalization preserves raw row indexes and diagnostic counts without flattening quote previews", async () => {
  const page = normalizeXquikPage([{ error: "diagnostic" }, post], raw, "anchor");
  expect(page.posts).toHaveLength(2);
  expect(page.posts[0]).toBeNull();
  const observations = createObservations();
  await Effect.runPromise(
    observations.record(plan(), { status: "succeeded", pages: [page], diagnostics: [] }),
  );
  expect(observations.posts.get("100")?.origins[0]?.row).toBe(1);
  expect(observations.posts.has("200")).toBe(false);
  expect(observations.acquisitions[0]?.rowCount).toBe(2);
  expect(observations.warnings.has("malformed_post_row")).toBe(true);
});

test("article retrieval uses the containing post ID, and preview never becomes acquired body", () => {
  const targets = articleTargets([post]);
  const request = { ...plan("article"), allocations: [{ targetId: "900", limit: 1 }] };
  expect(admitActorInput(xquikInput(request, targets))).toMatchObject({
    mode: "article",
    articleTweetIds: ["100"],
  });
  expect(() => xquikInput(request, new Map())).toThrow();
  expect(
    xquikArticle({
      resultType: "article",
      article: { articleId: "900", title: "A", previewText: "Preview" },
    }),
  ).toMatchObject({ id: "900", body: null, bodyStatus: "preview" });
  expect(
    xquikArticle({
      resultType: "article",
      article: { articleId: "900", title: "A", bodyMarkdown: "# Full article\n\nSubstantive body" },
    }),
  ).toMatchObject({ body: "# Full article\n\nSubstantive body", bodyStatus: "acquired" });
});

test("every processor mode uses admitted bounded options, including 50 main-post reply targets", () => {
  for (const mode of [
    "anchor",
    "parents",
    "quotes",
    "author",
    "direct",
    "nested",
    "latest",
  ] as const) {
    const input = admitActorInput(xquikInput(plan(mode), new Map()));
    expect(input.maxItems).toBe(1);
    expect(input.queryType).toBe("Latest");
    expect(input.outputVariant).toBe("raw");
  }
  const many = {
    ...plan("direct"),
    allocations: Array.from({ length: 50 }, (_, i) => ({ targetId: String(i + 100), limit: 2 })),
    limit: 100,
  };
  expect(admitActorInput(xquikInput(many, new Map())).replyTweetIds).toHaveLength(50);
  expect(() => xquikInput({ ...plan("latest"), conversationId: null }, new Map())).toThrow();
});
