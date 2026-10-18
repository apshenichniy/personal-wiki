# Apify X capture for the first vertical slice

**Checked:** 2026-10-18. **Evidence:** live public provider documentation and schemas; no Actor execution, paid calls, or capture-quality benchmark. The owner approved an X-first slice with bounded discussion capture and an explicit incompleteness marker. Detailed acquisition choices below remain planning proposals.

## Recommendation

Reuse the existing `xquik/x-tweet-scraper` Actor. An X post or author thread with its discussion is a suitable first source type because it matches the owner's main workflow. It introduces a conversation graph and incomplete-source handling, but does not require a different storage, Runner, or publication architecture.

The agreed outcome is **a real X URL → Apify capture → raw archive → Codex curation → linked Russian wiki note → private minimal web reader on CX33**. Capture is bounded and incomplete coverage is explicit. Keep the complete acquired material before semantic filtering; filtering changes the derived representation and note, not the archive.

## What the provider documents

| Requirement | Documented capability and boundary |
| --- | --- |
| Fetch a submitted post | A status URL in `startUrls`, or an ID/URL in `tweetIds`, retrieves the specified post. A URL lookup alone is not a conversation crawl. [Actor README](https://apify.com/xquik/x-tweet-scraper) |
| Read an author thread | The provider's own thread recipe uses `searchTerms: ["conversation_id:<root> from:<author>"]`, `queryType: "Latest"`. It describes collecting that author's posts in the conversation. [Thread example](https://apify.com/xquik/x-tweet-scraper/examples/extract-complete-twitter-thread) |
| Explicit thread mode | `mode: "thread"` with `threadTweetIds` exists. The inspected schema does not establish exactly which ancestors, descendants, or authors it includes; verify before relying on this mode. [Input schema](https://apify.com/xquik/x-tweet-scraper/input-schema) |
| Direct comments | `mode: "replies"` with `replyTweetIds` returns direct children: `inReplyToId` matches a requested target. Nested descendants are excluded from that direct-reply set. [Actor README](https://apify.com/xquik/x-tweet-scraper) |
| Broader discussion | `conversation_id` and `conversationIds` select conversation searches. `searchTerms` accepts the equivalent operator. This is the candidate route for nested discussion, subject to X search coverage. [Input schema](https://apify.com/xquik/x-tweet-scraper/input-schema) |
| Bounds and pagination | Actor input has global `maxItems` and optional `maxItemsPerTarget`; no caller-controlled cursor was found in that schema. `Top` is explicitly non-exhaustive. Do not confuse Actor collection with paginating the resulting Apify dataset. [Input schema](https://apify.com/xquik/x-tweet-scraper/input-schema) |
| Originals and normalized output | `outputVariant: "raw"` adds a sanitized source snapshot; `fieldStyle: "camelCase"` selects normalized naming. This is provider-sanitized data, not an untouched X network response. [Input schema](https://apify.com/xquik/x-tweet-scraper/input-schema) |

The actor exposes post identity, text, URL, author, timestamps, language, `conversationId`, `inReplyToId`, reply-author identifiers, media, entities, and nested quoted/reposted posts. Its output contract distinguishes tweet, article, translation, embed, user, and diagnostic records; stable tweet rows may omit `resultType`. Preserve optional fields and diagnose missing relationships rather than manufacturing parents. [Output schema](https://apify.com/xquik/x-tweet-scraper/output-schema)

The README claims full Note Tweet text up to 25,000 characters. X Articles use a separate `article` mode. Media metadata and video variants do not establish that media bytes, OCR text, or transcripts have been retained. The same README describes incomplete-reply diagnostics and pagination/deadline stop causes. A missing/protected target can still produce a successful run outcome: success is not proof of useful or exhaustive content. These are provider claims, not results demonstrated here. [Actor README](https://apify.com/xquik/x-tweet-scraper)

The input schema and README are not perfectly aligned on diagnostic rows and `maxItems`: the schema says diagnostics count toward the cap; the README describes separate free diagnostics. Treat that as a contract-test question and archive the diagnostics output explicitly.

## Proposed acquisition sequence

1. **Resolve the anchor.** Parse and retain the submitted URL, look up its post ID, then resolve `conversationId` and the root if the URL points into the middle. Keep the submitted anchor distinct from the conversation root.
2. **Prioritize author material.** Fetch the author's conversation posts independently of the discussion cap. Reconstruct self-reply chains using parent IDs. An author answering a commenter is a useful clarification, but is not automatically part of the original numbered thread.
3. **Collect discussion.** Fetch a bounded conversation search; merge by post ID. Use direct-reply mode only when its narrower scope is intentional or to investigate missing branches. Avoid an unbounded recursive crawl.
4. **Archive first.** Store acquired JSON, capture parameters, Actor/build/run IDs, timestamps, diagnostics, stop reasons, and checksums in private R2. Produce normalized source text and per-post provenance for the library. Distinguish provider-reported counters from actually acquired records.
5. **Interpret with Codex.** Supply the source graph and relevant existing wiki material. Preserve concrete corrections, counterexamples, useful questions/answers, and technical details. Remove empty praise, repetitive reactions, irrelevant promotion, and duplicate wording from the reading representation. Likes are a possible ranking signal, not a truth or quality filter.
6. **Publish through the service.** Codex submits a Russian note with original terminology where useful, direct post citations, a separate discussion section when warranted, and proposed related-note links. Service validation and the existing batch-publication rules remain authoritative.

Example input shapes below are documentation-derived starting points, **not executed recipes or approved limits**. Separate runs protect author material from a large discussion exhausting the shared cap.

```json
{"tweetIds":["<anchor-id>"],"maxItems":1,"outputVariant":"raw","fieldStyle":"camelCase"}
```

```json
{"mode":"search","searchTerms":["conversation_id:<root-id> from:<author>"],"queryType":"Latest","maxItems":100,"outputVariant":"raw","fieldStyle":"camelCase"}
```

```json
{"mode":"search","searchTerms":["conversation_id:<root-id>"],"queryType":"Latest","maxItems":300,"outputVariant":"raw","fieldStyle":"camelCase"}
```

The acquisition adapter should report a bounded snapshot with an observed stop reason. Even exhausting provider pagination does not prove that every X reply was exposed. Missing parents, cap exhaustion, unavailable posts, and media-dependent meaning should remain visible to both Codex and the owner.

## MCP and durable execution

The current Apify MCP documentation says `call-actor` returns run status and storage IDs, not the dataset itself. Read results through `get-dataset-items`. Loading an Actor or `call-actor` also loads run status, dataset retrieval, key-value retrieval, and abort tools. The remote service supports both OAuth and bearer-token authentication. [Apify MCP documentation](https://docs.apify.com/mcp)

The API supports asynchronous starts, run/build identification, finite timeout and charge limits; dataset results are retrieved separately. Its run-level `maxItems` is a charging control and differs from the Actor's input-level collection cap. [Run Actor API](https://docs.apify.com/api/v2/actors-runs-post), [Dataset items API](https://docs.apify.com/api/v2/dataset-items-get)

**Design recommendation:** keep acquisition behind a small adapter that returns a retained `Capture`, whether invoked through MCP or the Apify SDK/API. Persist external run identity before subsequent polling; resume an existing run after interruption instead of blindly paying for another one. Resolve the start-request/response-loss ambiguity explicitly during implementation. Download every required dataset page and diagnostics before declaring capture complete. A tool transcript or a handful of returned rows is not the archive.

The existing desktop connection reduces discovery work; VPS headless credentials, tool availability, and recovery still require verification. No second Actor is justified by the documentation reviewed so far.

## Acceptance tests needed before fixing the contract

1. **Graph coverage:** an owner-selected public thread with a root, author self-replies, direct comments, a nested exchange, and an author clarification. Submit both root and middle URLs; inspect parent relationships, ordering, duplicates, and missed posts.
2. **Text fidelity:** long Note Tweet, quoted post, links, multilingual text, and an X Article. Confirm exact extracted text and explicitly choose whether Article mode belongs in the first slice.
3. **Incomplete input:** inaccessible anchor, missing parent, cap hit, timeout, empty search, and partial provider results. A successful Actor run must not silently create a purportedly complete note.
4. **Selection quality:** a useful low-engagement correction survives while empty popular replies are omitted from the note. Every retained claim traces to a captured post. The original capture remains unchanged.
5. **Durability:** interruption during execution and dataset download resumes safely; replay does not duplicate publication. Cancellation also addresses a still-running external Actor.
6. **Operational limits:** measure elapsed time, complete run cost, result count, and context size on a few representative inputs. Select budgets from these observations rather than provider marketing.

External research beyond the submitted conversation is excluded by the owner. Additional scope proposals: do not follow arbitrary linked articles; defer video/audio transcription and image OCR. Retain media references and indicate when they carry unprocessed meaning. Remaining decisions include numeric capture budgets, image handling, precise presentation of the already-agreed incompleteness marker, and the first note's expected depth.
