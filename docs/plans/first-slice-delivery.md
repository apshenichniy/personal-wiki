# First-slice implementation backlog and autonomous-run handoff

**Status:** specification and task breakdown approved on 2026-10-18; implementation issues created. Application implementation and goal execution have not started. This is a portable handoff for a later explicitly authorized run.

Repository: [personal-wiki](https://github.com/apshenichniy/personal-wiki). Delivery parent: [Deliver the first X-to-wiki slice](https://github.com/apshenichniy/personal-wiki/issues/23). The completed [wayfinding map](https://github.com/apshenichniy/personal-wiki/issues/13) records decisions, not implementation progress.

## Start here

Read the repository [agent instructions](../../AGENTS.md), [approved first-slice specification](../specs/first-slice.md), and the selected issue with its comments. The specification links six authoritative contracts; each issue names the sections relevant to its work. Use the [brief](../knowledge-base-brief.md) for product context and the [glossary](../../GLOSSARY.md) for vocabulary. This handoff adds execution order and evidence routing, not a competing product design.

The objective is a real, private **X → Apify → retained capture → Codex → coherent publication → web reading/search** workflow on the existing CX33. The autonomous endpoint is **ready for owner acceptance** with evidence for G1–G5. The owner later performs G6 on a real iPhone with the Mac off. Keep the delivery parent open until that observation is recorded.

## Published tasks and dependencies

The P-labels trace the approved specification. GitHub owns live status, assignments and blocking relationships; this table is the initial approved graph. `ready-for-agent` means specified for AFK work once blockers are complete, not that the issue is immediately executable. P0 requires owner participation where authentication cannot be automated.

| Spec ref | Implementation issue | Mode | Native prerequisites |
| --- | --- | --- | --- |
| P0 | [Prepare unattended execution access](https://github.com/apshenichniy/personal-wiki/issues/24) | HITL | None |
| P1 | [Establish a reproducible service-to-runner path](https://github.com/apshenichniy/personal-wiki/issues/25) | AFK | None |
| P2 | [Publish and read a retained synthetic source](https://github.com/apshenichniy/personal-wiki/issues/26) | AFK | P1 |
| P3 | [Recover and compensate interrupted publications](https://github.com/apshenichniy/personal-wiki/issues/27) | AFK | P2 |
| P4 | [Run a durable synthetic ingestion job](https://github.com/apshenichniy/personal-wiki/issues/28) | AFK | P3 |
| P5 | [Prepare faithful X captures from fixture data](https://github.com/apshenichniy/personal-wiki/issues/29) | AFK | P1 |
| P6 | [Acquire and retain X material through Apify](https://github.com/apshenichniy/personal-wiki/issues/30) | AFK | P0, P4, P5 |
| P7 | [Supervise bounded real Codex execution](https://github.com/apshenichniy/personal-wiki/issues/31) | AFK | P0, P4 |
| P8 | [Curate and publish attributable Russian notes](https://github.com/apshenichniy/personal-wiki/issues/32) | AFK | P5, P7 |
| P9 | [Enforce owner-only application access](https://github.com/apshenichniy/personal-wiki/issues/33) | AFK | P0, P4 |
| P10 | [Deliver the responsive collection and reader flow](https://github.com/apshenichniy/personal-wiki/issues/34) | AFK | P4, P5, P9 |
| P11 | [Promote verified artifacts on CX33](https://github.com/apshenichniy/personal-wiki/issues/35) | AFK | P0, P3, P4, P9 |
| P12 | [Back up and restore a coherent private library](https://github.com/apshenichniy/personal-wiki/issues/36) | AFK | P3, P4, P9, P11 |
| P13 | [Complete bounded live acceptance and production handoff](https://github.com/apshenichniy/personal-wiki/issues/37) | AFK | P6, P8, P10, P11, P12 |

All tasks are native children of the delivery parent. Each identifies its primary product scope bag; bags stay open for later capabilities. This avoids making a cross-component delivery task appear completed merely because one package or one bag is finished.

## Execution sequence

1. **Prepare access with the owner.** Work [Prepare unattended execution access](https://github.com/apshenichniy/personal-wiki/issues/24) before the unattended run. Refresh the private inventory and verify human-dependent prerequisites; historical access smokes are context, not current proof. Record any later app-login dependency precisely. This step is complete only when its issue criteria pass, not when credentials merely exist.
2. **Build the local path.** Start with the reproducible service/Runner round trip, then retained synthetic publication, recovery and the durable synthetic ingestion job. The fixture-based X processor can progress once contracts exist. Each task ends in a working, testable path; speculative scaffolding does not close a ticket.
3. **Integrate bounded real behavior.** Use the native frontier for acquisition, physical Codex supervision, curation, owner access and reader work. Reuse retained captures for repeated curation. Test process fencing and provider ambiguity with controlled faults before treating live success as durable behavior.
4. **Prepare and rehearse delivery.** Prove exact-artifact installation in isolated staging, compatible rollback and shared slot/accounting. Complete the encrypted-backup and clean-restore task before production migration/promotion. Staging does not create an additional product-agent slot or monthly budget.
5. **Converge on one artifact.** Run integrated acceptance for the exact revision/digest, reconcile costs and operational evidence, promote those verified bytes, and provide the owner report. A skipped mandatory gate leaves delivery incomplete.

A sequential agent is sufficient. Task lanes permit independent work when the owner authorizes parallel agents, but shared schema/storage boundaries need explicit ownership and integration. The one runtime product-agent slot does not constrain development-agent concurrency.

## Per-task delivery loop

1. Read current issue body/comments, native blockers, repository state and relevant contracts. Preserve unrelated changes. Claim only an unassigned task whose prerequisites are actually complete; use a scoped branch/worktree when needed.
2. Implement the smallest complete behavior in that issue. Work against the selected Effect/Bun stack and version pins. For changing or unfamiliar APIs, verify the installed version's official documentation/examples before adopting an assumption.
3. Add meaningful deterministic success/failure verification, including negative cases where required. P1 introduces `mise exec -- bun run verify`; it is a command to implement, not a claim that the current planning checkout can run it. Later tasks extend that entrypoint or document separate OS/live commands where necessary.
4. Run the applicable checks, review the change and resolve defects. Use Linux evidence for Linux process/durability claims and real integration evidence for provider/auth claims. Record exact commands, revision, results and limitations.
5. Integrate verified changes through the repository's applicable review/branch protections under the authorized run scope. Keep required checks and protections intact. If a human-required repository rule blocks integration, report it rather than bypassing it. Resolve merge/rebase conflicts under AGENTS.md.
6. Close the implementation issue only after its acceptance evidence and integrated commit are available. Link the commit/PR, checks and private evidence references in its completion comment, then select the next native frontier task. A green unit suite alone does not close a live-integration task.

No task should modify the source specification silently to make a test pass. A routine library/packaging choice within the contracts is an engineering decision; an invariant that cannot be satisfied is a focused decision to surface. Continue independent authorized work while a specific external dependency is unresolved.

## Verification coverage ownership

This is a routing matrix, not test results. The release task expands each linked contract's required scenarios into an evidence checklist and accounts for every item; synthetic/real/owner-only evidence stay distinguishable.

| Contract or gate | Primary task references | Required evidence kind |
| --- | --- | --- |
| Stable identity, selected focus, provenance, immutable captures | P2, P4, P5; live composition P6/P8 | Synthetic relationships and actual retained-capture/receipt checks. |
| Capture limits, multi-mode membership, Article scope, costs and partial outcomes | P5, P6; integrated P13 | Controlled provider and capacity tests; bounded live capture including an author-chain case. |
| Detailed Russian notes, corrections, related notes and exact citations | P8; integrated P13 | Structural/citation validation plus semantic review of real Codex results. |
| Atomic publication, replay, single writer, crash matrix and compensation | P2, P3; job integration P4 | Real Git/SQLite, OS locks, injected failures and coherent read/search observations. |
| Queue handoff, deadlines, launch accounting and cancellation fences | P4, P6, P7, P8 | Deterministic state/time/provider faults and actual process restart/cleanup evidence. |
| Input/output admission, credential isolation and physical CLI exclusion | P7; integrated P13 | Real macOS/Linux process/sandbox probes plus pinned subscription Codex invocation. |
| Owner sessions, capabilities, denied access, private assets and safe rendering | P9, P10; integrated P13 | Negative security tests, real Pocket ID sign-in, browser/cache/rendering checks. |
| Lexical search, source switching, polling and responsive reading | P2, P10; integrated P13 | Revision-consistent query cases and desktop/mobile browser flow. |
| G0: execution access | P0 | Fresh scoped access evidence and owner authentication where needed. |
| G1–G3: local checks, integration checks and verified artifact | P1–P10 as applicable, P11 | Clean reproducible install/checks, CI results and verified artifact provenance. |
| G4: isolated real staging | P6–P11; assembled P13 | Real R2/Apify/Codex/Pocket ID and private browser flow under the shared limits. |
| G5: operational delivery | P11, P12, P13 | Interrupted deploy/rollback, resource observations, clean restore and server-only operation. |
| G6: owner acceptance | Owner, after P13 | Actual iPhone use with the Mac off and owner assessment of note quality. |

## Runtime and external boundaries

Apply the [capture](../specs/x-capture-curation.md), [execution](../specs/execution-lifecycle.md) and [delivery](../specs/delivery-verification.md) contracts directly. In particular, live acceptance has a **USD 2 total Apify envelope**, within the shared **USD 0.25/job and USD 5/UTC month** limits. Reconcile actual prior usage and unresolved liabilities before dispatch. Workflow reruns, staging and new job IDs do not create another campaign allowance.

Codex uses the owner's subscription through the pinned runtime profile. Runtime source text cannot authorize extra tools, external browsing, hidden agent launches, broader credentials or paid API fallback. The service remains the only canonical publisher. Preserve the existing Telegram MCP, Pocket ID and Tunnel while adding the approved application components.

Secrets and private captures/results belong in the owner's private inventory and evidence store. Public code, issues, logs and CI artifacts contain synthetic data or redacted references. Automated PR checks use no paid provider. If a login, spending ceiling, resource constraint or required invariant blocks a task, retain state/evidence, leave its gate open and explain the concrete prerequisite; a fallback that changes the policy needs a new owner decision.

## Completion report

The delivery task produces one report identifying:

- The integrated commit, deployed artifact digest and private application URL.
- Each G1–G5 result with exact commands/CI runs and private evidence references; known limitations and any incomplete gate.
- Representative capture/curation quality, observed Apify charges/reservations, resource use and recovery/restore measurements.
- Operator commands/runbooks for status, deployment rollback, backup/restore and revoking sessions.
- A short G6 checklist for the owner: real iPhone login with the Mac off, save a source, watch progress, read/search, inspect original, follow citations and assess fidelity.

P13 may close after verified delivery and this handoff. The delivery parent remains open for owner acceptance. Never infer physical-device success, semantic approval or goal completion from an automated mobile viewport or the number of closed issues.

## Suggested future goal instruction

Use this only when the owner explicitly starts implementation and P0 is complete. It is not an active goal created by this document:

> Implement the approved first X-to-wiki slice in personal-wiki using docs/plans/first-slice-delivery.md. Execute the delivery epic's P1–P13 implementation issues in native dependency order after verifying P0 is complete. Work autonomously through implementation, meaningful tests, review and integration under repository protections, then isolated CX33 staging and verified private production deployment. Follow the approved contracts and spending/concurrency limits; keep private evidence and credentials out of public artifacts. Continue without intermediate confirmation for routine decisions within that scope. Report genuine external or policy blockers precisely. Finish when G1–G5 pass for the deployed artifact and the owner acceptance report is ready; leave actual G6 acceptance to me. Keep the tracker current with evidence for every completed task.

The goal instruction deliberately contains no invented token budget. An execution budget, if desired, is supplied by the owner when starting the run.
