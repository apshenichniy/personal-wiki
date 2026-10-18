# Bounded X capture pilot

**Status:** live acquisition completed on 2026-10-18; owner review pending. This is evidence for [the capture pilot](https://github.com/apshenichniy/personal-wiki/issues/16), not an implemented ingestion service or an approved specification.

## Verdict

Keep `xquik/x-tweet-scraper` as the first-slice provider, behind an adapter that combines acquisition modes and independently validates coverage. No single tested mode is sufficient. Treat every conversation as a bounded snapshot, including when the provider reports `complete` or `source_exhausted`.

The owner's three sources and all raw captures remain private. Cases A, B, and C below refer to those inputs in submission order.

## Executed experiment

Pinned Actor build `1.12.394`; 10 sequential runs, 256 MB each, 120-second timeout, explicit input item limits, restricted Actor permissions, and no automatic run restart. Every start response and run/storage identity was retained before polling. Results were downloaded separately and retained before filtering.

| Run | Input limit | Acquired rows | Actor runtime |
| --- | --- | --- | --- |
| Three anchor lookups | 3 | 3 | 4.825 s |
| Author-only conversation searches | 120 total / 40 per target | 2 | 3.412 s |
| Conversation search A | 80 | 17 | 5.025 s |
| Conversation search B | 80 | 8 | 3.712 s |
| Conversation search C | 80 | 2 | 3.278 s |
| Quoted X Article | 1 | 1 | 1.528 s |
| Missing-parent lookups | 3 | 3 | 1.138 s |
| Direct replies, three roots | 90 total / 30 per target | 51 | 5.630 s |
| Thread mode: two roots and one middle reply | 120 total / 40 per target | 43 | 2.330 s |
| Deliberately small direct-reply cap | 2 | 2 | 2.088 s |

These are provider-reported Actor runtimes, not complete ingestion latency. A run returning 51 direct replies is not the same as 51 complete conversations.

The sum of the API's refreshed `usageTotalUsd` values was **USD 0.021635**, with 132 accounted result events. This total already includes the result charges; do not add the nominal USD 0.0198 event price again. Immediately after completion the API initially reported zero events and only about USD 0.00133 in usage. Accounting settled on a subsequent metadata read. Preserve this distinction in future cost reporting. The sum of all configured per-run ceilings was USD 1.20, within the owner's USD 2 total pilot budget. No ongoing production budget was authorized.

## Coverage findings

| Case | Unique posts in the validated union | Direct / nested replies | Root's reported reply counter | Important finding |
| --- | --- | --- | --- | --- |
| A | 20, including root | 13 / 6 | 14 | Search retained low-engagement attribution disputes but omitted the author's intervening source response. An explicit parent lookup recovered it. |
| B | 11, including root | 8 / 2 | 9 | The related article belongs to a quoted post. A normal lookup only provided a preview; Article mode supplied a substantial body. |
| C | 43, including root | 42 / 0 | 69 | Conversation search returned only two records. Direct replies supplied 30; thread mode supplied additional records. Coverage remains partial. |

Counters are observed metadata, not authoritative denominators: visibility, changing counters, nested replies, and provider filtering differ. Do not display these figures as exact percentage completeness.

- **Author search is not authoritative.** It returned no records for A despite the root and an author reply being retrievable by ID. A zero-result author query must not mean that the author wrote nothing.
- **Parent repair matters.** The initial search union had three missing parent IDs. All three were recovered by direct lookup. After merging all tested modes, the retained three conversation graphs had no unresolved parent references. This says nothing about branches never discovered.
- **Middle input is not the root.** Thread mode against the author's middle reply returned five records around that branch, without the conversation root in that target's records. Resolve `conversationId` and fetch the root explicitly.
- **Thread mode can mix conversations.** Four of its 43 records had different conversation IDs. They were retained in the raw archive but excluded from the normalized source. `sourceTarget` records acquisition provenance; it does not prove conversation membership.
- **Direct replies behaved as direct replies.** Every returned reply's parent matched one of the requested roots. Nested discussion requires additional acquisition.
- **Provider completion can mislead.** The direct-reply run returned exactly 30 records for C, reaching its per-target cap, while its report said `complete` and `source_exhausted`. The standalone two-item probe correctly announced a result-limit stop. The service must derive its own `limitReached` and `coverageUncertain` signals from input bounds and observed output.
- **Text fidelity within the provider output passed.** All three normalized anchor texts exactly matched their returned Note Tweet text, including the 4,281-character long post. This is internal field consistency, not a browser-by-browser comparison with X.
- **Article expansion is required.** The separately acquired X Article contains 20,155 text characters, 21,282 Markdown characters, and 181 structured content entries. It has body content rather than just a preview; visual completeness and exact rendering against X were not verified. Preserve submitted post → quoted post → article as distinct relationships.
- **Keep bot responses attributable.** One nested reply was itself an AI-generated synthesis. It can be retained as discussion, but cannot independently corroborate the source claims.

## Proposed acquisition contract

1. Fetch the submitted anchor by ID, identify its root, and retain both identities. Obtain root and relevant quoted-post metadata explicitly.
2. Collect bounded direct replies **and** a bounded `Latest` conversation search. They are complementary in this sample. Give author material its own bounded pass, but never trust an empty author search as absence.
3. Repair missing parent links with a bounded batch of direct lookups. A remaining missing parent is an explicit gap, not an invented placeholder statement.
4. Expand a detected X Article through Article mode. External articles require a separate processor; this pilot did not demonstrate that path.
5. Validate root/conversation/parent relationships, merge by stable post ID, retain acquisition provenance, and exclude unrelated records only from the normalized representation.
6. Archive raw output and diagnostics before curation. Track limits, missing branches, unavailable targets, unprocessed media, and provider stop reasons independently.
7. Preserve substantive corrections, source disputes and concrete proposals regardless of engagement. Keep summary claims separate from commenters' claims and from independent verification.

Numeric production budgets, the exact use of Thread mode, and presentation of selection decisions remain specification choices. A reasonable default from this evidence is direct replies + search + bounded parent repair, with Thread mode reserved for explicitly tested recovery or context needs.

## Privacy and verification limits

Each newly created run and its default dataset, key-value store and request queue were set to `RESTRICTED`; anonymous reads of each resource returned HTTP 403. The account-wide default was not changed. Because restriction is a separate request after creation, this experiment does not establish that newly created resources are private from their first instant. Resolve the creation-time default before production private ingestion.

No run was automatically repeated after an ambiguous start. The pilot utility's local reservation prevents accidental restart by the same experiment name; it is not a production idempotency design. Crash reconciliation, external cancellation, inaccessible anchors, large multi-post author chains, full browser fidelity, and multi-page dataset retrieval were not demonstrated. The provided sources were long posts with discussion, not a verified numbered author series.

The next gate is the owner's reaction to the private reading examples. Keep issue #16 open until that review, then carry the validated constraints into the first-slice specification.

## Curation and archive evidence

A real headless Codex execution under `wiki-runner` on CX33 produced three structured Russian prototype notes from the retained data. Its event log contains only an agent message and turn lifecycle events, with no tool calls. The output selected the source-attribution dispute in A, treated generated bot replies in B as attributed discussion, and kept low-engagement operational objections in C. Selected and omitted post IDs were checked against the actual case datasets. This is one successful preview, not a repeatability benchmark or a settled curation policy.

The private review HTML contains the notes, short source excerpts, retained/omitted examples, and coverage limits. It was statically checked for matching tabs/panels, unique IDs, valid JavaScript syntax, escaped source strings and X-only source links. Automated visual inspection was blocked by the browser tool's local-file URL policy; no rendering verification is claimed.

Raw responses, input parameters, run metadata, checksums and original Codex output were archived in the private R2 bucket. Mac readback and an independent VPS read verified the archive checksum. Public documentation contains measurements and contracts; the private source corpus and provider run/storage identifiers are not committed here.
