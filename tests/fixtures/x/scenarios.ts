import { createHash } from "node:crypto";
import { Effect } from "effect";
import type * as P from "@personal-wiki/contracts/processing";
import { defaultCapturePolicy, prepareX } from "../../../packages/source-processing/src/index.ts";

/** Entirely synthetic, redistributable fixtures; no private pilot records. */
export const post = (id: string, patch: Partial<P.XPost> = {}): P.XPost => ({
  id,
  authorId: "10",
  parentId: null,
  conversationId: "100",
  text: `Original point ${id}.`,
  parentStatus: patch.parentId ? "reply" : "root",
  longText: null,
  language: "en",
  quotedId: null,
  articleId: null,
  postedAt: null,
  isBot: false,
  references: [],
  ...patch,
});
export const numberedThread = [
  post("100", { text: "1. Preserve the complete argument and its qualification." }),
  post("101", {
    parentId: "100",
    text: "Legacy preview",
    longText: "2. A detailed example with a non-obvious exception.\r\nA second paragraph.",
  }),
  post("102", { parentId: "101", text: "3. A final example and a limitation." }),
  post("200", {
    parentId: "100",
    authorId: "20",
    text: "This fails for the following concrete reason.",
  }),
  post("201", { parentId: "200", text: "Author clarification: the exception is intentional." }),
  post("202", {
    parentId: "201",
    authorId: "30",
    text: "Correction with zero engagement: check the counterexample.",
  }),
  post("999", {
    parentId: "888",
    authorId: "30",
    text: "Unknown ancestry in the same wider conversation.",
  }),
  post("900", {
    parentId: "901",
    authorId: "40",
    conversationId: "900",
    text: "Unrelated conversation.",
  }),
];
export const article = (id: string, patch: Partial<P.XArticle> = {}): P.XArticle => ({
  id,
  title: "Synthetic article",
  body: "Section A\nThe argument.\n\nSection B\nAn important qualification.",
  bodyStatus: "acquired",
  language: "en",
  references: [],
  ...patch,
});
export type Reply = {
  posts?: ReadonlyArray<unknown>;
  articles?: ReadonlyArray<unknown>;
  status?: P.AcquisitionResult["status"];
  diagnostics?: ReadonlyArray<string>;
};
export function fixtureDriver(handler: (request: P.AcquisitionRequest) => Reply) {
  const calls: P.AcquisitionRequest[] = [];
  const acquire = (request: P.AcquisitionRequest) =>
    Effect.sync((): P.AcquisitionResult => {
      calls.push(request);
      const response = handler(request);
      const posts = response.posts ?? [];
      const articles = response.articles ?? [];
      const raw = JSON.stringify({ posts, articles });
      return {
        status: response.status ?? "succeeded",
        diagnostics: response.diagnostics ?? [],
        pages: [
          {
            raw: {
              assetId: `00000000-0000-4000-8000-${String(calls.length).padStart(12, "0")}`,
              sha256: createHash("sha256").update(raw).digest("hex"),
              byteLength: Buffer.byteLength(raw),
              provider: "fixture",
              runId: `synthetic-${calls.length}`,
              page: 0,
            },
            posts,
            articles,
          },
        ],
      };
    });
  return { calls, acquire };
}
export function poolDriver(
  pool: ReadonlyArray<P.XPost>,
  bodies: ReadonlyArray<P.XArticle> = [],
  latest = pool,
) {
  return fixtureDriver((request) => {
    const targets = request.allocations.map((a) => a.targetId);
    if (request.mode === "article")
      return { articles: bodies.filter((a) => targets.includes(a.id)) };
    if (["anchor", "parents", "quotes"].includes(request.mode))
      return { posts: pool.filter((p) => targets.includes(p.id)) };
    if (request.mode === "author")
      return {
        posts: pool
          .filter(
            (p) => p.authorId === request.authorId && p.conversationId === request.conversationId,
          )
          .slice(0, request.limit),
      };
    if (request.mode === "latest") return { posts: latest.slice(0, request.limit) };
    return {
      posts: request.allocations.flatMap((a) =>
        pool.filter((p) => p.parentId === a.targetId).slice(0, a.limit),
      ),
    };
  });
}
export const input = (id = "100", policy = defaultCapturePolicy): P.ProcessingInput => ({
  submittedUrl: `https://fxtwitter.com/example/status/${id}?s=20`,
  policy,
  knownSources: [],
});
export const runFixture = (value: P.ProcessingInput, driver: ReturnType<typeof fixtureDriver>) =>
  Effect.runPromise(prepareX(value, driver.acquire));
