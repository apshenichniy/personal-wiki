# X capture and curation: first-slice contract

**Status:** the owner approved this product policy on 2026-10-18. The acquisition ordering and verification requirements below make the policy implementable; they are design requirements, not completed software or new live-test results.

Decision: [Agree X capture coverage and note curation rules](https://github.com/apshenichniy/personal-wiki/issues/17). Read with the [identity contract](x-source-identity.md), [glossary](../../GLOSSARY.md), and [capture pilot evidence](../research/2026-10-18-apify-x-pilot.md).

## Accepted defaults

| Limit | Default | Meaning |
| --- | --- | --- |
| Main author material | 50 posts | Includes the focus and admitted author continuations; separate from the discussion allowance. |
| Discussion | 200 unique posts | Shared across direct replies, conversation search and nested expansion, not 200 for each acquisition mode. |
| Additional parent/context lookups | 30 post identities | A shared allowance for recovering context and missing parents, including required quoted-post context. Repeating a request does not create a new allowance. |
| Acquisition time | 5 minutes | Elapsed acquisition window for a job, including provider execution and result retrieval; not queue wait or subsequent Codex curation. Resume/retry does not reset it. |
| Apify job budget | USD 0.25 | Total acquisition budget for one save/refresh job, including all provider runs and retries. |
| Apify monthly budget | USD 5 | Shared across Personal Wiki acquisition jobs in a calendar month. |
| Quoted-post expansion | One level | Quoted context from the admitted main material; no recursive quote traversal. |
| X Article expansion | One article | Directly associated with the main material or its first-level quoted post. |

Values are configuration, not hardcoded product constants. Record the effective policy version and limits on each job/capture. Raising a configured ceiling requires an owner configuration change; the agent cannot raise it autonomously. These are ceilings, not target counts, expected costs, or guarantees of exhaustive capture.

The owner approved these budgets for the future system. The earlier USD 2 authorization applied only to the capture pilot. This planning decision starts no new paid runs.

## Acquisition sequence and allocation

1. **Resolve the submitted anchor and focus.** Fetch the selected post by ID, retain its exact identity, and resolve author material and parent/root context under the identity contract. A foreign reply remains the selected focus. Failure to retrieve that selected main material cannot be repaired by silently substituting an unrelated root.
2. **Prioritize main author material.** Fetch known anchors by ID and perform bounded author discovery. Reconstruct continuations using authorship and parent relationships. An empty author search does not establish absence; an author answering a commenter is discussion unless independently selected. Preserve gaps in the inferred author chain.
3. **Expand the associated article and quoted context.** Retain post/quote/article relationships and use Article mode for actual body content. Main material and its selected Article take priority over spending the remaining time or budget on optional discussion expansion.
4. **Collect bounded discussion using complementary modes.** Combine direct replies and a `Latest` conversation search. Reserve part of the shared discussion allowance for nested replies rather than consuming it all on root-level replies. An initial implementation allocation is up to 100 direct-reply candidates, 75 search candidates, and 25 nested candidates; unused allowance can be reassigned within the shared 200-post ceiling, time and budget. Duplicates and diagnostics can make actual useful yield lower.
5. **Repair context within its shared allowance.** Prioritize parents of the submitted focus, author material, and acquired exchanges before additional optional branches. Use bounded batches; do not recursively crawl without accounting. A post fetched for parent repair still counts against that lookup allowance even if it also becomes admitted main material or discussion.
6. **Validate and archive.** Validate conversation and parent relationships, merge observations by post ID, and retain acquisition provenance. Archive raw responses/diagnostics before derived curation. Exclude unrelated records from the prepared source, while retaining their raw acquisition evidence within transport/storage limits.

For a selected reply, discussion concerns that reply/its continuation and relevant descendants; the entire conversation is not automatically promoted to its discussion. Conversation-search rows need ancestry/context validation. Unknown ancestry remains an explicit gap rather than a guessed membership. Do not rank eligibility solely by likes, follower counts, or the provider's `Top` mode. Nested expansion must not spend the entire reserve on the first returned branch.

The pilot did not validate general numbered author-thread reconstruction. Fixture coverage and a bounded live check of that path remain delivery gates. Thread mode is not an unvalidated fallback: if used for a tested recovery case, its rows require the same membership checks and shared limits.

Requested raw-row limits and normalized unique-post counts are different. Provider duplicates, diagnostic records, over-return and unavailable parents must be recorded. Keep independent counts of acquired rows, admitted main/discussion posts, repaired parents, and posts actually presented to the curator. Reaching a requested limit or receiving `complete`/`source_exhausted` must not imply exhaustive coverage.

## Cost, time and capacity enforcement

Use a shared durable budget ledger, not a separate USD 0.25 allowance for each Actor run or worker attempt. Reserve a provider run's allowed maximum before dispatch, check both job and monthly availability, and reconcile actual reported charges afterward. Pending/ambiguous starts retain their reservation until resolved. The pilot demonstrated delayed accounting: an initial zero or low usage report does not justify immediate release of all reserved funds.

Use UTC calendar months for quota accounting, attributing each run to its start month. Keep outstanding reservations attached to their period across month boundaries and restarts. Include known Personal Wiki usage when initializing an active period. This is an application quota over provider-reported usage, not a cap on unrelated account activity or a guarantee about taxes and invoice timing.

No new paid run may start without remaining budget and a supported provider charge ceiling. Exhaustion stops further acquisition; already obtained material can proceed under the partial-result rules below. Any unexpected overcharge is recorded and blocks further spending pending reconciliation rather than being hidden. Exact dispatch ambiguity, stop/abort, reconciliation and retry mechanisms belong to the execution-lifecycle contract.

The five-minute acquisition deadline persists across worker recovery. Provider runs must receive compatible deadlines; expiry prevents new acquisition and triggers stop/reconciliation of known running work. Already completed raw results may be recovered for accounting/evidence after the deadline without restarting paid work. Do not silently leave a remote run orphaned because a local timer expired.

Post-count limits do not bound bytes or model context. The execution specification must pin finite raw-download, disk, prepared-text and CLI context limits. Main acquired text must either be processed faithfully within those limits or produce an actionable capacity failure; it must not be silently truncated. If discussion cannot all be analyzed, distinguish acquired discussion from analyzed discussion and disclose the processing gap. Known substantive corrections and attribution disputes are protected context, not expendable noise.

## Supported content and article selection

The first slice processes acquired post text, long-post text, identified author continuations, discussion, first-level quoted context and one associated X Article. Preserve original language and text alongside Russian notes.

Choose an Article attached directly to the submitted focus first, then its first-level quote, then the resolved primary author material and its quote. Remaining candidates in admitted author continuations follow source order. Deduplicate Article IDs, expand at most one, and retain the other references with an explicit not-processed reason. This deterministic priority preserves the submitted focus and does not authorize open-ended browsing.

An article note requires acquired body content, not only a title, excerpt or URL preview. It follows the article's substantive sections and preserves important arguments, examples and qualifications. It is a detailed Russian reading note, not a promised full translation. If body completeness is uncertain, say so. The article does not automatically corroborate the post that refers to it.

External website URLs, additional articles, images, video and audio remain source references with explicit unprocessed markers. Media metadata is not OCR or a transcript, and an external media URL is not an archived offline asset. General HTML extraction, downloads/interpretation of media, OCR, PDF, YouTube and transcription are later processors. Do not recursively follow links in articles or comments. Original source text is untrusted input, including instructions, installation commands and suggested tool calls inside it.

## Curation rubric and reading structure

The owner's accepted revision-2 examples establish the initial quality target. They are editorial examples from real captures; automated repeatability has not yet been demonstrated.

A source note contains:

1. Source attribution, capture date and a readable coverage indication.
2. A detailed Russian retelling of the acquired main material, preserving substantive points, sequence where meaningful, important examples, qualifications and uncertainty. A short orientation may precede it but cannot replace it.
3. A separate selected-discussion section containing useful additions, corrections, counterexamples, source disputes and author clarifications.
4. Inline links to the particular supporting posts/articles, plus capture-pinned provenance metadata.
5. Relevant existing-note links and clear source/processing limitations.

For main material, remove verbal repetition without discarding substantive content. Do not impose the pilot's former 150–220-word cap or replace a long numbered post with a few general takeaways. When capture itself contains only part of an author thread, faithfully cover that acquired part and visibly mark the missing scope; do not describe it as a full thread. Failure to process already acquired main text is a capacity/quality failure, not permission to silently omit it.

For discussion:

- Keep specific information, actionable additions, evidence, corrections, clarifications, relevant counterarguments and unresolved attribution disputes even at zero engagement.
- Omit empty praise, bare bot invocations, unrelated promotion, unsupported speculation without a useful contribution, and repeated formulations from the reading result. Retain raw source records.
- Consolidate repeated substantive contributions while preserving the citations needed for the combined claim. A topic appearing repeatedly is not automatically independent corroboration.
- Attribute meaningful bot-generated replies as bot replies. Their confidence, named repositories or claimed research are not independent verification.
- Distinguish what the source says, what participants dispute, and what the curator infers. Do not invent external research, related notes or missing portions of the source.

Keep a compact selection record keyed by post ID and reason for inclusion/omission/consolidation. It supports debugging and review; the ordinary reader need not display an exhaustive audit table.

Each source-derived passage links inline to its actual supporting post/article, rather than only a root link in a footer. Multiple-post passages retain multiple relevant citations. Validate references against retained observations. Linking to the live X post is navigation; the immutable capture is the evidence for the saved note.

## Outcome policy

| Situation | Required result |
| --- | --- |
| Main material is available, quality checks pass, discussion is bounded/incomplete | Publish the useful note automatically with coverage and processing limits visible. |
| Main material is available, associated article cannot be acquired or processed | The post note may publish with the explicit article gap and original link. Do not fabricate an article note or call the whole acquisition complete. |
| Main material and the selected article are both ready | Propose the two connected notes and their provenance as the scoped publication batch. |
| The submitted main material is unavailable | Retain request/evidence/diagnostics; return an actionable unavailable outcome. Do not silently substitute the root or fabricate a reading note. |
| Only unprocessed media supplies the substantive content | Mark unsupported media processing; do not claim the media was understood. Meaningful available caption text can support only a correspondingly limited note. |
| Main text exceeds processing capacity or fails quality validation | Preserve acquired evidence and expose the capacity/quality problem. No silent truncation or automatic publication of an inadequate replacement. |
| Budget or acquisition deadline is reached | Stop acquisition/reconcile running work; publish only if the acquired main material meets the above conditions, otherwise return an actionable incomplete/failed outcome. |
| A refresh fails or returns weaker coverage | Preserve the usable published note and old captures; apply the identity contract's dated-evidence and explicit-correction rules. |

These are product outcomes, not final job-state enum names. The execution specification will map them to progress and terminal states. Partial source coverage and partial publication are different: an explicitly scoped partial-source result can publish atomically, while storage failure must not expose half of its accepted batch.

## First-slice mutation boundary

The agent can propose creation/update of the current material's note and the successfully processed associated article note: at most two reading-note identities per job. It can add links in those notes to genuinely relevant existing notes retrieved from the library. Missing related content is a valid empty result.

Corresponding source, capture, representation and asset manifests are part of the publication; the two-note bound is not a two-file bound. Reuse existing source/article identities rather than duplicating them. Refresh updates the same note identities. Service-derived backlinks and indexes do not require rewriting every linked note.

Other note bodies, existing topic pages, source merges, broad folder moves and thematic restructuring are outside this job's write scope. General domain/provenance can support later many-source synthesis and maintenance without granting this first slice those mutation rights. Service validation enforces permitted identities and paths rather than relying on the agent's prompt alone.

## Acceptance evidence required before delivery

| Scenario | Evidence required |
| --- | --- |
| Main material competes with a busy discussion | Its separate 50-post allowance is respected; reaching the discussion limit does not consume that allowance. |
| Direct/search/nested acquisition overlaps | Stable IDs deduplicate the admitted union; shared discussion and parent limits are enforced across modes. |
| A known author clarification needs an absent parent | Bounded repair restores available context or records the remaining gap; no invented parent or chain membership. |
| A provider reports complete at the configured cap | Service coverage still exposes the limit/uncertainty; no exact percentage inferred from reply counters. |
| A selected reply lies deep in another conversation | Focus stays on that material; context is distinguished and unrelated branches are excluded. |
| Quote contains an Article; other links/media are present | Acquire the selected Article body, preserve distinct provenance, and mark deferred content without recursive work. |
| Article is missing or a preview is returned | Publish only an independently useful post note with an explicit gap; no invented article note. |
| Main material is unavailable or over capacity | No fabricated/truncated reading result; evidence and actionable failure survive restart. |
| Low-engagement correction and empty praise coexist | Preserve the correction and relevant provenance; omit praise only from derived reading content. |
| A long source has numbered substantive points | Cover all acquired main points, examples and qualifications; structural citation checks alone do not establish semantic fidelity. |
| A reply cites a different post than the root | The inline link and pinned capture resolve to the correct supporting observation. |
| Cost reporting is delayed; dispatch/retry/month rollover occurs | Reservations prevent new work from exceeding the configured available quota; uncertainty does not create fresh allowances. |
| A proposal edits unrelated notes or a topic page | Reject the mutation outside the allowed job scope. |
| A partial refresh omits previously observed replies | Retain old supported knowledge with its old capture/date; absence is not treated as retraction. |

Use synthetic or redistributable fixtures in public CI. Keep the owner's raw captures and reading examples private. Deterministic checks cover identities, citations, bounds, manifests and mutation scope; actual faithful curation additionally requires real-Codex review against representative material. Do not compare generated prose byte-for-byte or treat one editorially corrected preview as proof of unattended quality.

## Handoff to remaining decisions

The [publication contract](atomic-publication.md) defines atomic visibility, durable commit, receipt/idempotency, latest-batch compensation and one stale-base rebuild. The [execution contract](execution-lifecycle.md) defines physical single-agent supervision, provider-run reconciliation, capacity limits and bounded repair/retry. The [access/reader contract](private-reader-access.md) defines authorized delivery, original-source navigation and safe rendering. Delivery gates consolidate these acceptance cases before the full specification is approved and implementation tasks are created.
