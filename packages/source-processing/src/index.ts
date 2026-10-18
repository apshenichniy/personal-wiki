import { createObservations, ProcessingError } from "./observations.ts";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import * as P from "@personal-wiki/contracts/processing";
import type { SourceInput } from "@personal-wiki/contracts/knowledge";
import { normalizeSubmission } from "@personal-wiki/contracts/x-url";
import {
  allocate,
  compatibleConversation,
  missingParents,
  originalText,
  reaches,
  resolveFocus,
  sourceOrder,
  type Posts,
} from "./graph.ts";

export const defaultCapturePolicy: P.CapturePolicy = {
  version: "x-capture-v1",
  main: 50,
  discussion: 200,
  context: 30,
  direct: 100,
  latest: 75,
  nestedReserve: 25,
  preparedBytes: 1_048_576,
};
export { ProcessingError } from "./observations.ts";
export type Acquire<E, R> = (
  request: P.AcquisitionRequest,
) => Effect.Effect<P.AcquisitionResult, E, R>;

/** Sequential acquisition plan. The adapter must durably archive/replay each
 * request key and enforce external time, budget and streaming bounds before I/O.
 * This module neither spends money nor assigns canonical library identities. */
export const prepareX = <E, R>(input: P.ProcessingInput, acquire: Acquire<E, R>) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(P.ProcessingInput)(input);
    const normalized = yield* Effect.try({
      try: () => normalizeSubmission(decoded.submittedUrl),
      catch: () =>
        new ProcessingError({
          code: "invalid_input",
          message: "A supported X post URL is required.",
        }),
    });
    const policy = decoded.policy;
    if (policy.direct + policy.latest + policy.nestedReserve > policy.discussion)
      return yield* new ProcessingError({
        code: "invalid_input",
        message: "Discussion allocations exceed the shared allowance.",
      });
    const observations = createObservations();
    const { posts, articles, warnings, acquisitions } = observations;
    const unprocessed: P.PreparedSource["coverage"]["unprocessed"][number][] = [];
    const requestedContext = new Set<string>();
    const postUrl = (id: string) => `https://x.com/i/status/${id}`;
    const articleUrl = (id: string) => `https://x.com/i/article/${id}`;
    const request = Effect.fn(function* (
      mode: typeof P.AcquisitionMode.Type,
      allocations: P.AcquisitionRequest["allocations"],
      authorId: string | null = null,
      conversationId: string | null = null,
    ) {
      if (observations.halted || !allocations.length) return;
      const limit = allocations.reduce((sum, allocation) => sum + allocation.limit, 0);
      const plan: P.AcquisitionRequest = {
        key: `${acquisitions.length}:${mode}:${allocations.map((a) => `${a.targetId}/${a.limit}`).join(",")}`,
        mode,
        allocations,
        limit,
        authorId,
        conversationId,
        sort: "Latest",
      };
      const result = yield* acquire(plan).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(P.AcquisitionResult)),
      );
      yield* observations.record(plan, result);
    });
    const context = Effect.fn(function* (ids: ReadonlyArray<string>, mode: "parents" | "quotes") {
      if (observations.halted) return;
      const wanted = [...new Set(ids)].filter((id) => !posts.has(id) && !requestedContext.has(id));
      const remaining = policy.context - requestedContext.size;
      if (wanted.length > remaining) warnings.add("context_limit_reached");
      const admitted = wanted.slice(0, remaining);
      for (const id of admitted) requestedContext.add(id);
      yield* request(
        mode,
        admitted.map((targetId) => ({ targetId, limit: 1 })),
      );
    });
    const repair = Effect.fn(function* (focus: ReadonlyArray<string>) {
      for (let i = 0; i < policy.context && !observations.halted; i++) {
        const missing = missingParents(focus, posts).filter((id) => !requestedContext.has(id));
        if (!missing.length) break;
        const before = requestedContext.size;
        yield* context(missing, "parents");
        if (requestedContext.size === before) break;
      }
    });
    yield* request("anchor", [{ targetId: normalized.anchorId, limit: 1 }]);
    // Unrelated provider rows must not replace the selected focus.
    let anchor = posts.get(normalized.anchorId)?.post;
    if (anchor) {
      yield* repair([anchor.id]);
      if (anchor.conversationId && anchor.conversationId !== anchor.id)
        yield* context([anchor.conversationId], "parents");
      if (anchor.authorId)
        yield* request(
          "author",
          [{ targetId: normalized.anchorId, limit: policy.main }],
          anchor.authorId,
          anchor.conversationId,
        );
      const authorAnchor = posts.get(normalized.anchorId)!.post;
      const possibleAuthors = [...posts.values()]
        .filter(
          ({ post }) =>
            post.authorId !== null &&
            post.authorId === authorAnchor.authorId &&
            compatibleConversation(authorAnchor, post),
        )
        .map(({ post }) => post.id);
      yield* repair([anchor.id, ...possibleAuthors]);
    }
    anchor = posts.get(normalized.anchorId)?.post;
    let focus = resolveFocus(normalized.anchorId, posts);
    const selectMain = () => {
      const full = resolveFocus(normalized.anchorId, posts).main;
      if (full.length > policy.main) warnings.add("main_limit_reached");
      // Always preserve the submitted anchor even if an over-returned thread is
      // longer than the admitted bound. Every omitted record remains in raw evidence.
      const priority = [...new Set([normalized.anchorId, focus.primaryId, ...full])];
      const chosen = new Set(priority.filter((id) => full.includes(id)).slice(0, policy.main));
      return full.filter((id) => chosen.has(id));
    };
    let main = selectMain();
    let quoteIds: string[] = [];
    let order: string[] = [];
    let selectedArticle: string | undefined;
    // Revisit discoveries before spending another optional discussion allowance.
    // An already dispatched Article consumes the single slot even if later rows
    // reveal a higher-priority candidate; retain that gap instead of spending twice.
    const expandMain = Effect.fn(function* () {
      const current = posts.get(normalized.anchorId)?.post;
      quoteIds = [...new Set(main.flatMap((id) => posts.get(id)?.post.quotedId ?? []))];
      yield* context(quoteIds, "quotes");
      const primary = posts.get(focus.primaryId)?.post;
      order = [
        ...new Set(
          [
            normalized.anchorId,
            current?.quotedId,
            primary?.id,
            primary?.quotedId,
            ...main.flatMap((id) => [id, posts.get(id)?.post.quotedId]),
          ].filter((id): id is string => Boolean(id)),
        ),
      ];
      const preferred = order.flatMap((id) => posts.get(id)?.post.articleId ?? [])[0];
      if (!selectedArticle && preferred) {
        selectedArticle = preferred;
        yield* request("article", [{ targetId: selectedArticle, limit: 1 }]);
      } else if (preferred && preferred !== selectedArticle) {
        warnings.add("article_priority_changed_after_acquisition");
      }
    });
    yield* expandMain();
    const discussionIds = () => {
      const roots = new Set(main);
      const fullMain = new Set(resolveFocus(normalized.anchorId, posts).main);
      return [...posts.keys()]
        .filter((id) => !fullMain.has(id) && reaches(id, roots, posts))
        .sort(sourceOrder);
    };
    if (anchor && main.length) {
      yield* request("direct", allocate(main, policy.direct));
      yield* request(
        "latest",
        [{ targetId: normalized.anchorId, limit: policy.latest }],
        null,
        anchor.conversationId,
      );
      yield* repair(discussionCandidates(posts, anchor));
      focus = resolveFocus(normalized.anchorId, posts);
      main = selectMain();
      yield* expandMain();
      // Different branches share the remaining allowance. One provider branch
      // cannot consume the nested reserve by appearing first or having more likes.
      const branches = discussionIds().filter((id) => main.includes(posts.get(id)!.post.parentId!));
      const remaining = Math.max(0, policy.discussion - discussionIds().length);
      if (remaining) yield* request("nested", allocate(branches, remaining));
      yield* repair(discussionCandidates(posts, anchor));
    }
    focus = resolveFocus(normalized.anchorId, posts);
    main = selectMain();
    anchor = posts.get(normalized.anchorId)?.post;
    yield* expandMain();
    const articleCandidates = [
      ...new Set(order.flatMap((id) => posts.get(id)?.post.articleId ?? [])),
    ];
    for (const id of articleCandidates.filter((id) => id !== selectedArticle))
      unprocessed.push({
        kind: "article",
        url: articleUrl(id),
        fromKind: "post",
        fromProviderId: order.find((postId) => posts.get(postId)?.post.articleId === id)!,
        reason: "one_article_limit",
      });
    const allDiscussion = discussionIds();
    const discussion = allDiscussion.slice(0, policy.discussion);
    if (allDiscussion.length >= policy.discussion) warnings.add("discussion_limit_reached");
    const roles = new Map<string, P.PreparedPost["role"]>(main.map((id) => [id, "main"]));
    for (const id of discussion) roles.set(id, "discussion");
    // Repair fetches are evidence, not proof of membership. Only ancestry of
    // admitted material and the declared conversation root qualify as context.
    const fullMain = new Set(focus.main);
    const relevantContext = new Set<string>();
    for (const id of roles.keys()) {
      const seen = new Set<string>();
      let parentId = posts.get(id)?.post.parentId;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = posts.get(parentId);
        if (!parent || parent.conflict || (anchor && !compatibleConversation(anchor, parent.post)))
          break;
        if (!fullMain.has(parentId)) relevantContext.add(parentId);
        parentId = parent.post.parentId;
      }
    }
    if (anchor?.conversationId) relevantContext.add(anchor.conversationId);
    for (const id of relevantContext) {
      const candidate = posts.get(id);
      if (
        candidate &&
        !candidate.conflict &&
        !fullMain.has(id) &&
        !roles.has(id) &&
        anchor &&
        compatibleConversation(anchor, candidate.post)
      )
        roles.set(id, "context");
    }
    for (const id of quoteIds) {
      if (posts.has(id) && (!roles.has(id) || roles.get(id) === "context") && !fullMain.has(id))
        roles.set(id, "quote");
      if (!posts.has(id))
        unprocessed.push({
          kind: "quote",
          url: postUrl(id),
          fromKind: "post",
          fromProviderId: main.find((mainId) => posts.get(mainId)?.post.quotedId === id)!,
          reason: "quote_unavailable_or_context_limit",
        });
    }
    const unresolved = anchor
      ? discussionCandidates(posts, anchor).filter(
          (id) => !roles.has(id) && missingParents([id], posts).length,
        )
      : [];
    if (unresolved.length) warnings.add("unresolved_discussion_ancestry");
    const missing = missingParents([...roles.keys(), ...unresolved], posts);
    if (missing.length) warnings.add("missing_parent_context");
    if (focus.uncertain) warnings.add("uncertain_source_resolution");
    if ([...roles.keys()].some((id) => posts.get(id)?.post.parentStatus === "unknown"))
      warnings.add("unknown_parent_metadata");
    const preparedPosts: P.PreparedPost[] = [...roles].map(([id, role]) => {
      const found = posts.get(id)!;
      if (
        found.post.articleId &&
        found.post.articleId !== selectedArticle &&
        !unprocessed.some((r) => r.kind === "article" && r.fromProviderId === id)
      )
        unprocessed.push({
          kind: "article",
          url: articleUrl(found.post.articleId),
          fromKind: "post",
          fromProviderId: id,
          reason: "article_not_selected",
        });
      if (
        found.post.quotedId &&
        !roles.has(found.post.quotedId) &&
        !unprocessed.some((r) => r.kind === "quote" && r.fromProviderId === id)
      )
        unprocessed.push({
          kind: "quote",
          url: postUrl(found.post.quotedId),
          fromKind: "post",
          fromProviderId: id,
          reason: "quote_expansion_bound",
        });
      for (const reference of found.post.references) {
        try {
          const url = new URL(reference.url);
          if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
            unprocessed.push({
              ...reference,
              fromKind: "post",
              fromProviderId: id,
              reason: "processor_not_supported",
            });
          else warnings.add(`unsafe_reference:${id}`);
        } catch {
          warnings.add(`invalid_reference:${id}`);
        }
      }
      return {
        post: { ...found.post, text: originalText(found.post), longText: null },
        canonicalUrl: postUrl(id),
        role,
        origins: found.origins,
        textVariantDigests: found.variants.map((text) =>
          createHash("sha256").update(text).digest("hex"),
        ),
      };
    });
    const known = decoded.knownSources.filter((source) =>
      [source.primaryId, ...source.aliases].some((id) => main.includes(id)),
    );
    const identityConflict =
      focus.conflict || new Set(known.map((source) => source.primaryId)).size > 1;
    if (identityConflict) warnings.add("published_identity_or_relationship_conflict");
    const primaryId = known[0]?.primaryId ?? focus.primaryId;
    const source: typeof SourceInput.Type = {
      kind: main.length > 1 ? "x_author_thread" : "x_post",
      primaryId,
      aliases: focus.uncertain ? [] : main.filter((id) => id !== primaryId),
      resolution: focus.uncertain ? "uncertain" : "resolved",
    };
    const text = preparedPosts
      .map((item) => `[${item.role}] ${item.canonicalUrl}\n${item.post.text}`)
      .join("\n\n");
    const languages = [
      ...new Set(preparedPosts.map((p) => p.post.language).filter((x): x is string => Boolean(x))),
    ];
    const materials: P.PreparedSource["materials"][number][] = anchor
      ? [
          {
            source,
            posts: preparedPosts,
            article: null,
            originalText: text,
            language:
              languages.length === 1 ? languages[0]! : languages.length === 0 ? "und" : "mul",
          },
        ]
      : [];
    const article = selectedArticle ? articles.get(selectedArticle) : undefined;
    if (
      selectedArticle &&
      article?.article.body?.trim() &&
      ["acquired", "partial"].includes(article.article.bodyStatus)
    ) {
      const articleText = article.article.body.replace(/\r\n?/g, "\n");
      materials.push({
        source: {
          kind: "x_article",
          primaryId: selectedArticle,
          aliases: [],
          resolution: "resolved",
        },
        posts: [],
        article,
        originalText: articleText,
        language: article.article.language ?? "und",
      });
      warnings.add("article_body_completeness_unverified");
      if (article.article.bodyStatus === "partial") warnings.add("article_body_partial");
      for (const reference of article.article.references) {
        try {
          const url = new URL(reference.url);
          if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
            unprocessed.push({
              ...reference,
              fromKind: "article",
              fromProviderId: selectedArticle,
              reason: "processor_not_supported",
            });
          else warnings.add(`unsafe_article_reference:${selectedArticle}`);
        } catch {
          warnings.add(`invalid_article_reference:${selectedArticle}`);
        }
      }
    } else if (selectedArticle)
      unprocessed.push({
        kind: "article",
        url: articleUrl(selectedArticle),
        fromKind: "post",
        fromProviderId: order.find((id) => posts.get(id)?.post.articleId === selectedArticle)!,
        reason: "article_body_unavailable",
      });
    const bytes = materials.reduce(
      (sum, material) => sum + Buffer.byteLength(material.originalText),
      0,
    );
    const capacity = observations.rawCapacity || bytes > policy.preparedBytes;
    if (capacity) warnings.add("prepared_capacity_exceeded_no_truncation");
    const usable = anchor && originalText(anchor).trim().length > 0;
    if (!usable) warnings.add("selected_main_unavailable_or_unsupported_media");
    const outcome = identityConflict
      ? "identity_conflict"
      : capacity
        ? "capacity"
        : usable
          ? "ready"
          : "unavailable";
    const result: P.PreparedSource = {
      schemaVersion: 1,
      outcome,
      submittedUrl: decoded.submittedUrl,
      normalizedUrl: normalized.normalizedUrl,
      anchorId: normalized.anchorId,
      policy,
      materials: outcome === "ready" ? materials : [],
      acquisitions,
      coverage: {
        main: !usable
          ? "unavailable"
          : focus.uncertain
            ? "uncertain"
            : warnings.has("main_limit_reached")
              ? "limited"
              : "bounded",
        discussion: !acquisitions.some((a) =>
          ["direct", "latest", "nested"].includes(a.request.mode),
        )
          ? "not_acquired"
          : warnings.has("discussion_limit_reached")
            ? "limited"
            : "bounded",
        missingParents: missing,
        warnings: [...warnings],
        unprocessed,
      },
      counts: {
        ...observations.counts,
        uniquePosts: posts.size,
        excludedPosts: posts.size - roles.size,
        main: main.length,
        discussion: discussion.length,
        context: roles.size - main.length - discussion.length,
        parentLookups: requestedContext.size,
        presentedPosts: outcome === "ready" ? preparedPosts.length : 0,
        preparedBytes: bytes,
      },
    };
    return yield* Schema.decodeUnknownEffect(P.PreparedSource)(result);
  });

function discussionCandidates(posts: Posts, anchor: P.XPost) {
  return [...posts.values()]
    .filter(({ post }) => compatibleConversation(post, anchor) && post.parentId !== null)
    .map(({ post }) => post.id);
}
