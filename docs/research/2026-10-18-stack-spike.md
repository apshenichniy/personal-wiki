# Server stack compatibility findings

**Experiment date:** 2026-10-18. **Conclusion:** compatibility GO for the tested stack. The owner subsequently selected it for the product.

This is a summary of a separate throwaway prototype, not a product test report. The original prototype source and logs have not been imported into this repository. Its recorded final local commit was `19c7581`; that commit belongs to the separate experiment repository and is not expected to resolve in this checkout.

## Question and topology

Can Bun run and install a small moon/mise workspace using Effect SQL and PersistedQueue while only the Knowledge Service opens SQLite and Runner works through HTTP?

The prototype contained two applications, a shared contracts package, a minimal HTTP lease adapter, and process-level failure probes. It did not implement the knowledge product or its complete HTTP/OpenAPI contract.

## Tested versions

| Component | Version |
| --- | --- |
| Bun runtime and package manager | 1.3.13, isolated linker |
| moon | 2.6.2 |
| mise | 2026.9.1 |
| Effect / platform-bun / sql-sqlite-bun | 4.0.5 |
| TypeScript | 7.0.2 |
| @effect/tsgo | 0.53.4 |
| Oxlint / Oxfmt | 1.88.0 / 0.73.0 |
| oxlint-tsgolint | 7.0.2004 |

Pin versions when implementing and rerun relevant checks for upgrades. This table records the experiment rather than claiming these are the newest releases.

## Environments and results

Both macOS arm64 and a Linux amd64 container passed **10 runtime checks and 6 workspace checks each**. The Linux container ran through OrbStack architecture translation on a Mac. This establishes compatibility evidence; it is neither a native CX33 run nor a VPS capacity benchmark.

Types, Effect diagnostics, type-aware Oxlint, Oxfmt, and a negative diagnostic fixture also passed their expected outcomes. Effect diagnostics reported 0 errors, 0 warnings, and 27 informational/recommendation messages: 20 unstable-API notices and 7 other recommendations. `skipLibCheck` was enabled; dependency declaration files were not fully typechecked.

### Runtime checks

| Check | Observed result |
| --- | --- |
| Shared Effect dependency | Root, applications, and shared package resolved one Effect package instance. |
| Migrations | Ordered and repeatable; failed DDL left neither its table nor its migration record. |
| SQL and FTS transactions | Error and cancellation rolled back partial changes; a constraint failure was a typed SQL error. |
| SQLite snapshot | A `VACUUM INTO` snapshot reopened with text and FTS available. |
| Queue claims | Duplicate ID, competing consumers, and a lock held beyond its initial duration preserved a single claim with renewal. |
| Worker death | Killing a consumer allowed redelivery with an incremented attempt. |
| Retry exhaustion | Attempts persisted across consumers and reached failed state after the configured limit. |
| HTTP lease lifetime | Scope survived between requests; empty claim timeout released the slot; heartbeat, completion, cancellation, and stale-token rejection behaved as expected. |
| Lost HTTP Runner | The second Runner could not acquire the busy slot; missing heartbeat consumed an attempt. |
| Service death after SQL commit | Redelivery after commit-before-ack did not create a second SQL note or event. This was SQL-only publication. |

### Workspace checks

- A clean frozen Bun installation left the lockfile unchanged.
- Manifest/lockfile drift failed installation rather than silently rewriting the lockfile.
- Repeated builds restored all three project tasks from cache.
- Changing the shared contracts rebuilt both applications.
- Changing only Runner did not rebuild the Knowledge Service.
- A production-only dependency install ran the built applications without compiler/diagnostic packages.

## Consequences for product design

1. **Effect SQL can be used without Drizzle.** Earlier Drizzle compatibility work does not make the ORM part of the selected baseline.
2. **The HTTP lease adapter is application code.** The queue's scoped consumer must retain its scope across claim/heartbeat/complete requests; a request-scoped consumer is insufficient.
3. **At-least-once delivery requires publication idempotency.** The successful SQL duplicate-publication test says nothing about atomic Git/R2 publication.
4. **Interruption and failure differ.** Intentional Effect interruption refunded an attempt. A lost remote Runner must be recorded as failure if repeated crashes are to exhaust a retry budget.
5. **Migration failure is a startup gate.** The tested Migrator surfaced migration failure through a defect/full Exit; startup must not continue after it.
6. **Queue completion records are not an eternal ledger.** Cleanup and retention must be considered separately from durable product operation receipts.

## Not established

- A real Codex or Claude execution, provider authentication, output quality, or cancellation.
- One physical CLI process after arbitrary host failures, orphaning, SIGSTOP, or loss of communication.
- Safety of two simultaneous Knowledge Service publishers.
- A Git/SQLite/R2 publication journal and recovery protocol.
- Correct rejection of different payloads under the same product idempotency key.
- Pocket ID/OIDC, real R2, Knowledge MCP, native Apple clients, or portable custom tokenizers.
- A complete HttpApi/OpenAPI surface, administrative job lifecycle, fairness, or production data volume.
- Native VPS performance, memory headroom, restore procedures, or release automation.

The product acceptance suite must establish these separately. Do not report this prototype as a running implementation of Personal Wiki.

## References used in the experiment

- [Bun workspaces](https://bun.com/docs/pm/workspaces) and [isolated installations](https://bun.com/docs/pm/isolated-installs).
- [moon Bun integration](https://moonrepo.dev/docs/guides/javascript/bun-handbook) and [affected-project selection](https://moonrepo.dev/docs/concepts/affected).
- [mise configuration](https://mise.jdx.dev/configuration.html).
- [Effect PersistedQueue](https://effect.website/docs/v4/api/effect/persistence/PersistedQueue), plus the installed Effect 4.0.5 package's SQL examples, agent instructions, and source code.
