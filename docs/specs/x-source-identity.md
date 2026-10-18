# X source identity and provenance: first-slice contract

**Status:** the owner approved the three product choices below on 2026-10-18. The minimal v1 model derives from those choices and the accepted brief; it is a design baseline, not an implemented API or the complete first-slice specification.

Decision: [Define knowledge identity and provenance for X captures](https://github.com/apshenichniy/personal-wiki/issues/15). Vocabulary: [Personal Wiki glossary](../../GLOSSARY.md).

## Accepted behavior

1. Preserve the owner's focus. A submitted participant reply is an independently saved material, with parent/root context. A post identified as an author-thread continuation resolves to that author material while retaining the exact submitted anchor.
2. Separate save from refresh. Saving an already known material returns its existing note or active job. Explicit refresh makes a new capture and may update the same note, keeping its identity and history. A weaker capture must not silently remove previously retained knowledge.
3. Keep a substantive post/discussion and its acquired linked article as separate connected reading notes and separate source identities. The accepted separation does not itself approve a general external-page processor; supported article types and acquisition bounds belong to the capture/curation decision.

## Source resolution

X post and article IDs are provider identities and remain decimal strings. Do not parse them as JavaScript numbers, identify posts by usernames, or include sharing query parameters in identity. Preserve the submitted URL, normalized URL, and submitted post ID as input provenance.

A post and a confidently resolved author thread use the first post of that material as their canonical external identity, `x:post:<primaryPostId>`. Discovering continuations does not change an established source's identity. An article uses `x:article:<articleId>`. The service assigns each source a separate opaque application `sourceId`.

`conversationId` identifies wider context; it is not a sufficient deduplication key. A deliberately selected reply can share a conversation with its parent source while retaining its own source ID and primary post. Context posts do not each become standalone sources or notes merely because they were fetched.

Resolve a continuation using acquired authorship and parent relationships, not a shared conversation ID or the author's name alone. A clarification replying to someone else belongs to discussion unless it is explicitly selected as a focus. If a required relationship is unavailable, record uncertain resolution and missing context; do not guess that an arbitrary reply belongs to the main thread. Preserve known alias post IDs only when the relationship is established.

A newly submitted alias of an already resolved source reuses that source. If later evidence would combine two already published identities, retain both and report a reconciliation conflict; automatic note merging is outside this slice. This avoids destructive assumptions while keeping the ordinary resolved-duplicate path automatic.

## Minimal v1 records

All application IDs below are service-owned opaque strings, independent of paths, titles and provider-run identifiers. Serialized knowledge metadata carries `schemaVersion: 1`; timestamps are UTC instants. Exact HTTP routes, error envelopes and implementation libraries belong to the API specification.

| Record | Minimum information |
| --- | --- |
| Source | `sourceId`, provider and external key, kind (`x_post`, `x_author_thread`, `x_article`), canonical URL, primary post/article ID, known member/alias post IDs, resolution status. Author and conversation identity are retained where known. |
| Submission | Request/operation ID, `save` or `refresh`, submitted URL and anchor ID, resolved source ID when known, and job/result reference. Submission history is operational state, not a new source for every request. |
| Capture | `captureId`, `sourceId`, acquisition start/end, submitted anchor, focus IDs, parent/conversation relationships, acquired post/article observations, acquisition provenance, assets, representations, coverage and warnings. |
| Post observation | Post ID, stable author ID where provided, original text, canonical URL, parent/conversation IDs, quote/article relationships, relevant timestamps, and acquisition provenance. A missing parent is an unresolved reference, not fabricated content. |
| Asset reference | Stable asset ID, private object key, media type, byte length and checksum. Never store credentials or expiring signed URLs as identity. |
| Representation | Representation ID, capture ID, kind/language, content reference and derivation information. Translation and extracted text remain traceable to the same underlying evidence. |
| Note | `noteId`, note kind, language, title, source/capture references, current path, citations and related-note IDs. Content can derive from multiple retained captures; path and title do not determine identity. |
| Citation | Note-local citation ID, source ID, capture ID, specific post/article ID and canonical URL; optional fragment locator when supported by the capture. |
| Change proposal | Proposal and operation IDs, the base library revision, changed note/document identities, source/capture/asset references, and agent/skill provenance. |
| Publication receipt | Publication and operation IDs, resulting library revision and affected note/document IDs. The publication protocol defines when this result becomes durable and visible. |

A raw provider run can supply several sources. Preserve that raw asset once if useful, but retain distinct captures/relationships for each material. Provider run IDs describe acquisition, not knowledge identity.

The initial relation vocabulary is `reply_to`, `quotes`, `links_to_article`, `derived_from`, and `related_to`. Thread membership is a resolved relationship with evidence. These relations must not imply agreement, correctness, or independent corroboration.

## Immutable evidence and visible citations

A capture is immutable after finalization. Subsequent acquisition creates another capture, even when the URL is unchanged. Revisions to extraction/translation retain derivation and version information rather than silently rewriting the evidence behind an existing note.

Coverage distinguishes the acquired main material, discussion and related assets: limits reached, missing parents, unavailable material, unprocessed media and provider stop reasons are separate facts. Provider success or an empty search cannot establish completeness. The exact numeric bounds belong to the capture/curation contract.

Inline Markdown links open the particular cited X post or article. Machine-readable citation metadata additionally pins the supporting capture. A later refresh must not redirect an old statement's provenance to a newer capture by default. A paragraph drawing on several posts retains all necessary citations.

Source/capture metadata, citations and application identities must survive catalog rebuilds. Retain the durable knowledge manifest alongside canonical documents, referencing immutable archive assets. Jobs, submissions, attempts and publication receipts also have durable operational state; they are not all reconstructible from note files.

## Save, refresh and weaker captures

For a known resolved source, `save` returns the existing note and any active refresh status; if no note exists but a job is active, return that job. Unknown anchors may require bounded resolution before deduplication. This is not a promise of zero provider requests for an unseen alias. Request idempotency remains separate from source deduplication.

A previous failed/cancelled job is not a saved note. Surface its result and an explicit retry action; do not silently launch repeated paid attempts. The execution-lifecycle contract defines retry and reconciliation behavior.

`refresh` preserves source/note identity, obtains a new capture, and proposes changes against a known base revision. An unsuccessful refresh leaves the published note usable. An unchanged capture need not create a redundant note-content revision, but its acquisition result remains recorded.

Do not equate absence in a partial refresh with a retraction or deletion. Retained claims can continue citing their older captures with clear dates; never represent them as newly observed. Explicit corrections may revise a note with attribution and version history. Preserve old captures in either case. Conflict and stale-proposal behavior must be enforced by the publication contract.

## Separate article and discussion notes

Retain post → quoted post → article relationships when present. The article note derives from the acquired article; the post/discussion note derives from its own capture. Connect their stable note IDs. If the article already has a note, reuse it and link the new referring material rather than duplicating it.

A linked article is not automatic corroboration of the referring post. Unavailable article text must not yield a fabricated article note. The capture/curation contract decides whether an otherwise useful post note can publish with a visible related-source gap.

## Moves, future merges and revisions

Moving or renaming a note preserves its ID and public link identity. Resolve internal links through note IDs; a path is a current storage location. Stable metadata enables rebuilding that mapping from canonical documents.

Automatic source/note merging is outside the first slice. Any future merge must retain old identity resolution and historical provenance; deleting an identity or rewriting old citations is not an acceptable merge implementation.

An agent proposal names its base library revision. A publication receipt names the resulting revision. Captures and sources do not use library revisions as their identities. The [atomic-publication contract](atomic-publication.md) defines stale-base handling, commit order, crash recovery, receipt persistence and latest-batch compensation. Reverting active knowledge preserves its source evidence and identity reservations.

## Acceptance scenarios for the later specification

- Two sharing URLs for the same post resolve to one source; submitted URLs remain available as input provenance.
- A known middle continuation and its material's first post resolve to the same author source; a participant reply in that conversation remains an independently selectable focus.
- Unknown or missing parent relationships are visible and never guessed into thread membership.
- An ordinary resave returns the existing note/job. Explicit refresh keeps the note ID and old capture while adding a new dated capture.
- A failed or weaker refresh preserves the published result; an omitted reply does not silently erase an older supported statement.
- Post, quoted post and article provenance remain distinct; separately saved references to the same article reuse its article identity.
- An inline comment citation points to the comment, and its metadata resolves to the actual supporting capture after refresh, move and index rebuild.
- Two concurrent submissions cannot publish duplicate source notes merely because they used different URL forms. The execution/publication specifications supply the enforcement mechanism.

The accepted [capture/curation contract](x-capture-curation.md) now defines numeric bounds, content selection, Article scope, partial outcomes and the first-slice write boundary. API transport, authorization, execution and crash recovery remain with their respective wayfinding decisions. This contract introduces no application code.
