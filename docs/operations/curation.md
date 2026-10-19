# Retained X curation

The Runner composes acquisition, bounded Codex execution and publication through the Knowledge Service API. `bun run runner` starts the Linux worker under `locked-runner.py`; set `WIKI_AGENT_SLOT` to the shared host slot and `WIKI_RUNNER_CONFIG_FILE` to an absolute private JSON file. The production entry point verifies the inherited flock before claiming work. The older `acquire.ts` entry point is an acquisition-only operator probe; `index.ts` remains the synthetic P1 transport probe.

The private configuration contains `serviceUrl`, `runnerTokenFile`, `apifyTokenFile`, `spool`, `skillFile`, and `codex` (`binary`, `binarySha256`, `python`, `guardian`, `slotDirectory`, `spool`, `authFile`). Paths are absolute. Credentials and mutable directories are private and outside the checkout. `skillFile` points to the release's `skills/knowledge/curate-x/SKILL.md`. Deploy all namespaces with the same host slot. P11 supplies the systemd lifecycle and release packaging.

## Model boundary

The Service persists a context identity, library revision, exact admitted captures, at most twelve bounded library excerpts, previous dated notes and repair feedback. Full admitted main/Article text is supplied through observations, including available author/bot/relationship metadata. Excerpts explicitly retain their revision and character range. Main text is never cut to fit: token admission fails the job before a launch. The original normalized capture remains immutable.

`x-curation-v1` asks Codex for a small `CurationResult`: Russian passages, exact supporting post IDs, selection decisions and relevant retrieved note IDs. It does not ask the model to copy the captured originals or choose file paths, storage keys or publication identities. The Service validates the two-note scope, complete main-ID coverage, discussion audit, known citations, language presence and related IDs, then creates Markdown and a `Proposal`. The renderer creates all navigational links from retained identities and treats model prose as text. Main/discussion/limitations are separate; Article and referring-post notes link to each other.

These checks enforce structure and attribution boundaries. They cannot establish semantic fidelity from a successful schema match: representative real-model review remains required. Selection decisions remain in the durable attempt output for debugging, outside the ordinary reader.

## Refresh and recovery

A weaker refresh cannot silently erase a previously cited observation. If a prior citation is missing, changed or no longer included, the renderer retains the previous note and its captures as dated evidence. Growth that exceeds publication capacity fails rather than silently discarding old content. This first slice prioritizes preservation over compact editorial merging of historical versions.

Malformed/editorially invalid output records concrete repair checks for the allowed repair attempt. A stale publication generates a fresh context/revision and publication identity while reusing captures. Both use the existing persisted launch/category limits. A configuration/capacity failure before launch is actionable and consumes no agent launch. Process recovery precedes new work; a recovered completion lease can be read without a new queue delivery. A lost publication response uses the retained receipt rather than running Codex again.

## Verification

`mise exec -- bun run verify` covers deterministic checks. Focused checks are `bun test tests/curation.test.ts tests/curation-workflow.test.ts tests/xquik.test.ts` after building the Service. They cover exact citations and safe rendering, Article scope, selection consistency, weaker refresh, context capacity, retained context across an actual Service restart, one repair plus stale rebuild without acquisition, receipt replay and pre-launch failure. Real retained-source fidelity evidence is recorded separately in issue #32; private captures and generated notes are not committed or uploaded to public CI.
