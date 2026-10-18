# personal-wiki

A personal knowledge base maintained by agents, with a private Markdown library, retained sources, and offline native readers.

**Status:** autonomous first-slice implementation is in progress. The initial Service/Runner path is synthetic; production ingestion and delivery gates are not yet complete. A separate compatibility spike informed the selected server stack.

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

An infrastructure-only [CI access check](docs/operations/ci-access.md) is configured. The application verification workflow runs synthetic checks without provider credentials. Production deployment remains separate implementation work. The project license remains to be chosen.
