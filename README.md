# personal-wiki

A personal knowledge base maintained by agents, with a private Markdown library, retained sources, and offline native readers.

**Status:** the first X-to-wiki slice is deployed privately on CX33. Real Apify/Codex acceptance, same-artifact production promotion and G1–G5 verification are complete; actual iPhone/Mac-off acceptance remains with the owner. Native and offline clients are later slices. See the [delivery report and owner acceptance checklist](docs/operations/first-slice-delivery-report.md) for exact evidence and current gates.

- [Local development and verification](docs/development/local.md) — pinned setup, two-process synthetic path and canonical verification command.
- [Knowledge base brief](docs/knowledge-base-brief.md) — the primary input to wayfinder: requirements, owner decisions, architecture proposals, and open questions.
- [First-slice specification](docs/specs/first-slice.md) — owner-approved scope, behavior contracts, delivery gates and implementation task boundaries.
- [Native Inbox + Share](docs/plans/native-inbox-share.md) — next product direction, recommended macOS-first sequence, shared Apple foundations, and decisions required before implementation.
- [Implementation backlog and autonomous-run handoff](docs/plans/first-slice-delivery.md) — fourteen executable GitHub issues, dependencies, verification ownership and a future goal instruction.
- [Stack spike findings](docs/research/2026-10-18-stack-spike.md) — what the chosen stack has and has not demonstrated.
- [Agent instructions](AGENTS.md) — repository conventions and Matt Pocock skills configuration.
- [GitHub Issues](https://github.com/apshenichniy/personal-wiki/issues) — specifications, decision maps, and subsequent implementation work.

Delivery and decision history:

- [Personal Wiki product scope](https://github.com/apshenichniy/personal-wiki/issues/1) — the product-wide scope bags.
- [Specify the X-to-wiki first vertical slice](https://github.com/apshenichniy/personal-wiki/issues/13) — completed decision map for bounded Apify capture, real Codex curation, and private CX33 delivery.
- [Deliver the first X-to-wiki slice](https://github.com/apshenichniy/personal-wiki/issues/23) — implementation and owner acceptance; the decision map is complete.
- [Apify X capture pilot](docs/research/2026-10-18-apify-x-pilot.md) — representative live evidence, accepted note-quality direction and remaining verification requirements.

Repository documentation and tickets are written in English. Conversation with the owner is in Russian.

This public repository contains the product's code and planning documents. The owner's actual knowledge library, source archive, credentials, and runtime data belong in separate private storage.

GitHub Actions runs synthetic application verification without provider credentials and promotes signed release artifacts through the [restricted deployment boundary](docs/operations/ci-access.md). [Release/rollback](docs/operations/releases.md) and [encrypted recovery](docs/operations/recovery.md) have operator runbooks. The project license remains to be chosen.
