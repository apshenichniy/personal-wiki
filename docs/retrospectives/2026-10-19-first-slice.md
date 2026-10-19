# First-slice autonomous delivery retrospective

**Outcome:** P1–P13 delivered to CX33, G1–G5 verified, and G6 accepted by the owner on 2026-10-19. The owner explicitly requested closure of the [delivery epic](https://github.com/apshenichniy/personal-wiki/issues/23). Acceptance is owner-reported; this record does not add unobserved device-test details.

The delivered path is **X → bounded Apify capture → retained originals → subscription Codex → Russian notes with citations → private web reading/search**. See the [delivery report](../operations/first-slice-delivery-report.md) for release identities, test evidence and limitations. Native apps, offline reading and the other deferred components remain separate slices.

## What worked

- An approved specification, dependency-ordered tasks and prepared access gave autonomous execution a concrete stopping condition. Human input remained necessary for renewed Tailscale access, passkey confirmations and final acceptance.
- Retaining capture and agent evidence made recovery practical: curation retries reused paid captures instead of reacquiring them. Conservative acceptance-campaign liability stayed below $0.90 against the $2 ceiling; this is a ledger bound, not a settled invoice or total development cost.
- Deterministic failure tests, code review and real staging observations complemented each other. The exact verified application archive was promoted to production; rollback, reboot and empty-target restore were exercised.
- The measured single-user workload fit the existing CX33 comfortably. This is evidence for the first slice, not a general capacity benchmark.

## What was harder than expected

The goal recorded approximately **10 hours 19 minutes** of execution time. This is not a pure coding-time metric, and no reliable phase-by-phase time breakdown was collected.

The late delivery work concentrated on integration and recovery. Real operation exposed systemd/bubblewrap incompatibility, missing source grants during retained retry, and citation-repair feedback that lacked per-material scope. Operational checks then found missing cold-boot startup, SQLite WAL bookkeeping blocked by backup mounts, and temporary Codex executable aliases rejected by backup validation. These received targeted fixes and regression coverage without relaxing the citation or recovery contracts.

A production model-capacity refusal also showed why the saved-capture retry matters: the next attempt succeeded without another Apify acquisition. Autonomous implementation still depends on external capacity and human authentication boundaries.

## Changes for the next run

1. Bring up one real Linux path earlier, including **failed CLI launch → retained retry → backup → empty restore → reboot**, before expanding feature coverage.
2. Include failed-execution workspaces and real retained-state shapes in operational fixtures. A successful synthetic job alone is insufficient evidence for backup and restart behavior.
3. Keep fast focused checks during iteration and full verification at integration/release boundaries. Separate application artifacts from host-administration changes and preserve exact release provenance.
4. Prepare human checkpoints and session-expiry recovery before unattended work. Keep paid-operation accounting and resumable evidence explicit.
5. End with a concise acceptance record, tracker reconciliation and tab cleanup. Keep subsequent product scope separate from completion of the accepted slice.

**Assessment:** autonomous delivery worked for this bounded slice. Its strongest support was explicit behavior and recovery contracts plus verifiable evidence. The main process improvement is to move operational failure scenarios earlier, rather than discovering them after the happy path is already complete.
