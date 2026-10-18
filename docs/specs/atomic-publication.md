# Atomic publication and recovery: first-slice contract

**Status:** owner-visible behavior approved on 2026-10-18; this protocol is the resulting engineering design. It has not been implemented or fault-tested. Delivery must establish its stated invariants on the pinned Bun/Effect stack and CX33 filesystem.

Decision: [Design atomic publication and crash recovery](https://github.com/apshenichniy/personal-wiki/issues/18). Read with [source identity](x-source-identity.md) and [capture/curation](x-capture-curation.md).

## Accepted behavior

- Readers see an entire applied revision across notes, provenance, links and search. A partial-source result may be an intentional complete batch; a storage failure cannot expose half of that batch.
- The service rejects stale-base proposals. Runner may refresh library context and rebuild the proposal once from retained captures, within the same job limits and without new automatic Apify acquisition. A second stale-base rejection is actionable failure, not forced overwrite.
- Rollback reverses the latest whole publication through a new compensating publication. Preserve captures, identities, receipts and history. Selective or older-publication rollback is outside this slice; an operator command suffices initially.

## Stores and authority

Use one service-owned SQLite database for the operation journal, receipts, job/result links, outbox, applied-revision pointer, and catalog/FTS projections. Their logical responsibilities remain distinct, but final activation must occur in one database transaction. Runner cannot write it. Splitting these across SQLite files or committing the index separately would require another protocol.

Git stores immutable versioned knowledge and a service-managed canonical ref. Use a bare repository or isolated service staging, not a reader-facing mutable checkout. R2 holds verified original assets under immutable application identities. No cross-store transaction is assumed.

Name the two relevant versions explicitly:

- `committedRevision`: the canonical Git ref's current commit, including a durable batch awaiting projection.
- `appliedRevision`: the revision fully activated in SQLite and exposed by the read/search API.

Normally they are equal. Permit at most one committed-but-unapplied publication; complete or repair it before committing another. A temporary difference is a recoverable state, not permission to serve Git HEAD with the previous search index. Future direct-Git replicas must consume an explicitly applied export revision if they require the same publication-readiness contract; unrestricted Git transport is not a first-slice read API.

## Operation identity and durable inputs

An authenticated proposal includes a library-scoped operation ID, job/proposal identity, base revision, permitted note identities, complete proposed content and metadata, captures/assets, policy version, and derivation information. Normalize and validate paths and schema before calculating a stable payload digest over all semantic inputs, including exact document bytes and the base revision.

Persist the accepted manifest and bounded proposal bytes in the service journal, or an equivalently durable verified spool referenced by that journal, before acknowledging acceptance. A Runner workspace is not that spool. Assign publication ID, commit author/time and manifest data once and retain them so recovery does not create a new identity or timestamp-dependent commit for the same operation.

Enforce unique operation identity and at most one applied ingestion result per job:

- Same operation ID and digest returns the original progress/result, including after a lost response or later rollback.
- Same operation ID with a different digest is an idempotency conflict in every state.
- A different operation cannot publish a second ingestion result for an already completed job. Return the existing receipt as context with an explicit already-published conflict.
- A rebuilt stale proposal has a new operation/proposal ID under the same job, links its superseded proposal, and consumes the one persisted rebuild allowance. A transport retry reuses the original operation ID.

Perform the existing-operation lookup before stale-base or current asset-availability checks on a matching retry. Otherwise a successful old operation could be misclassified as stale and executed again. Authorization still applies on every request. A publication receipt is retained even when its effects are later compensated.

## Asset readiness and validation

New assets use service-controlled, create-once object keys. Use a conditional create and reconcile an unknown upload outcome against the same key and expected bytes; never overwrite a different object to make a retry succeed. R2 documents strongly consistent object reads and conditional creation, while warning that a negative read does not cancel an earlier in-flight upload. Use its authenticated API, not a cache, for readiness checks. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)

The service records content checksum, byte length and private object identity. Verify completed new uploads by readback/checksum before marking ready; a caller-supplied metadata field or multipart ETag is not sufficient proof. Reused assets need a service-owned verification record and current existence/metadata checks. Missing/unverified references prevent entering the commit phase. Raw assets can remain after a rejected proposal without becoming published notes.

Validate the complete proposed tree, not only individual changed files: stable identities, permitted mutation scope, safe paths, no symlink/executable/hook entries, valid references, capture-pinned citations, duplicate-source constraints, and ready referenced assets. The service generates internal publication/identity metadata itself; agents cannot write arbitrary control files. Source text is data, not executable Git configuration or hook content.

## Single publisher and durability prerequisites

One service instance owns an exclusive OS lock on the shared local publication storage for its writable lifetime, with an in-process serialized publication lane. A second writable instance fails closed. The lock is not a TTL lease that another process may steal while the first is paused. Use the same lock inode and volume for every instance; do not replace the lock file during deployment.

The lock must remain effective for any child process that can still mutate Git. Implement verified lock-descriptor inheritance or an equivalently supervised lock-owning helper, and stop/reap the old writer's process group before takeover. A parent PID disappearing alone is insufficient. The Bun/Linux implementation must demonstrate this with an orphan-child test; if it cannot, choose the helper arrangement rather than weakening the invariant.

After acquiring exclusive ownership, increment a persisted publisher epoch and use it for conditional journal/activation writes. Adopt pending work under the new epoch during recovery. Reject stale internal callbacks. The epoch protects SQLite transitions; it does not replace the OS lock and expected-old-value Git update for filesystem writes. Direct Git pushes, manual canonical-ref changes and a second maintenance writer are unsupported while the service is active.

Deploy with verified durable settings: SQLite WAL with `synchronous=FULL`, foreign-key checks, and no read-uncommitted mode; Git object/ref hardening with a supported `core.fsync=all` and `core.fsyncMethod=fsync` configuration. Pin and validate the actual versions/settings instead of inheriting platform defaults. SQLite's documented WAL/FULL behavior and Git's fsync options support these choices; filesystem/storage failure still requires backups. [SQLite durability](https://www.sqlite.org/pragma.html#pragma_synchronous), [Git durability options](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsync)

## Publication state machine

These are publication-operation phases, separate from the ingestion job's [execution lifecycle](execution-lifecycle.md).

| Phase | Durable meaning | Read visibility |
| --- | --- | --- |
| `received` | Operation, digest and recoverable inputs accepted; no canonical Git change. | Previous applied revision. |
| `prepared` | Assets/tree validated; exact candidate commit and internal prepared ref retained. | Previous applied revision. |
| `committing` | Final authorization/ownership/base checks passed and a durable intent to finish was recorded. | Previous applied revision until activation. |
| `committed` | Canonical Git ref contains the recorded candidate; SQL activation is pending. The journal may lag this fact after a crash. | Previous applied revision. |
| `applied` | Catalog/FTS, pointer, receipt, outbox and job result activated in one transaction. | Entire new applied revision. |
| `rejected` / `cancelled` | Terminal before the commit intent, with no canonical publication. | Unchanged. |

Recovery trouble is a recorded condition on the phase, including the relevant IDs/revisions; it must not erase whether a commit occurred. A committed-but-blocked operation is not an ordinary retryable ingestion failure. Initial library creation establishes and validates a recorded genesis revision before ordinary submissions begin.

### 1. Prepare

Enter the serialized lane after any earlier committed publication is applied. Resolve matching idempotent retries first. Check the proposal's base against the current applied revision and canonical ref. An ordinary stale proposal becomes a durable rejection without changing Git.

Verify assets and tree, construct the commit with the recorded metadata, and pin it under a service-private prepared ref. Its parent is the accepted base. The commit contains an append-only publication manifest with operation/publication/job IDs, payload digest, parent/base and affected identities. Do not put the commit's own hash inside its content; store that hash in the journal/receipt. Persist the exact candidate hash before proceeding. A crash while preparing can reconstruct or verify the same candidate from durable inputs; it cannot imply publication.

### 2. Record commit intent

Under publisher ownership, recheck current base, scope, candidate readiness, epoch and cancellation. A short SQLite transaction chooses between an accepted pre-commit cancellation and `committing`. Once `committing` is durable, finish or reconcile this publication; do not accept cancellation as successfully removing its effects.

This intent is the cancellation fence, slightly earlier than the actual Git commit boundary. A later cancellation request reports publication in progress/too late and may inspect the result; it must not return a successful cancellation followed by publication. The execution contract exposes that distinction in job status and preserves recovery after an execution deadline.

### 3. Advance the canonical Git ref

Update exactly one canonical ref from the recorded expected base to the prepared candidate. This compare-and-set update is the durable knowledge-commit boundary. A lost command response is resolved by reading the ref and matching the candidate/manifest, not by generating another commit. Git supports expected-old-value ref updates; its warning that readers can observe only some updates in a multi-ref transaction is why this design does not use multiple refs as one reader-visibility boundary. [Git ref update contract](https://git-scm.com/docs/git-update-ref)

If the ref is still the expected base, a persisted `committing` intent can finish the same update after recovery. If it is the recorded candidate, the commit happened. Any other unexpected value blocks new publication for investigation; do not force-reset it. Record `committed` when possible, but recovery treats the verified canonical ref as authoritative for whether this boundary was crossed.

### 4. Activate in one SQLite transaction

Using the exact committed tree, atomically:

1. Recheck publisher epoch and expected previous applied revision.
2. Apply note bodies/metadata, source and identity projections, links/backlinks and FTS changes.
3. Set `appliedRevision` and the next publication sequence.
4. Insert the unique receipt and stable outbox event.
5. Mark the operation applied and link the job to its durable result, including partial-source warnings.

Do not perform network calls or agent work inside this transaction. A transaction failure leaves the complete prior projection. A crash after its commit leaves the complete new projection and the receipt even if no HTTP response was sent. Final publication success is returned only after activation; earlier responses report accepted/publishing progress.

### 5. Deliver notifications

Outbox dispatch happens afterward. Create one event record per publication with a stable event ID/revision, but allow network delivery to be retried. Consumers deduplicate; reconnect refreshes from the applied revision. Delivery failure does not roll back a successful publication, and a missing transport acknowledgment does not trigger recuration.

## Consistent reading and rebuilding

Each read/search response uses one SQLite read transaction and obtains its applied revision from that same snapshot. Read note content from that projection or the immutable Git tree named by that revision, never a mutable worktree or unpinned HEAD. SQLite documents that isolated readers do not see another connection's uncommitted changes. [SQLite isolation](https://www.sqlite.org/isolation.html)

Return the revision with list/search/detail results. Requests/pagination that require a particular revision must either read that coherent version or return an explicit revision-changed result; do not mix results silently across publications. Future replica activation follows the same revision rule.

A pending publication may leave the previous consistent version readable while recovery proceeds. If the service cannot verify a consistent projection/revision, report unavailable rather than mixing stores. Rebuild only derived catalog/index tables from an exact retained revision, preserving operational journal, receipts, quotas and jobs. Activate the rebuilt projection atomically; replacing the entire database with a fresh catalog would destroy operational state.

Asset availability is a separate service concern: a temporary R2 outage after commit does not erase a note or undo its history. Asset reads report the problem. Known corruption/deletion requires repair from retained bytes/backup and blocks unsafe new writes; it is not evidence that the original capture never existed.

## Recovery matrix

Startup acquires exclusive ownership, adopts pending operations, verifies Git/SQLite consistency, and reconciles the oldest unfinished publication before allowing new commits.

| Observed point/state | Recovery action |
| --- | --- |
| Asset upload response lost; no commit intent | Reconcile the same immutable object key/checksum. A negative read alone does not prove an in-flight write cannot finish. No publication until readiness is established. |
| `received`, objects/prepared ref partly created | Verify against the persisted inputs or recreate the same candidate; honor pre-intent cancellation. |
| `prepared`, canonical ref still equals base | Revalidate and continue or reject/cancel before intent; no reader saw the candidate. |
| `committing`, canonical ref still equals base | Resume the recorded intent, verify prerequisites and perform the same compare-and-set. Never restart the agent to discover what to publish. |
| `committing` or `committed`, ref equals candidate, projection still at parent | Verify identity/digest/parent and apply the exact committed tree once. |
| Activation transaction interrupted before commit | SQLite retains the old complete projection; repeat activation of the recorded commit. |
| Activation committed, response/queue acknowledgment lost | Return the stored receipt; no additional Git commit, event record or provider call. |
| Event delivered but delivery acknowledgment lost | Redeliver the same event ID; client deduplication handles it. |
| Canonical ref/projection/manifest diverge unexpectedly | Block new publication and expose a consistency incident; preserve evidence and restore/repair deliberately. |
| A second service starts or an old Git child survives its parent | No second writable owner may proceed until the original mutation capability is gone; test the actual OS/process behavior. |

A state that should be impossible under durable writes is not repaired by guessing. Disk loss, database corruption or an operator rewinding refs requires a verified restore, not normal queue retry. Process-kill tests do not prove resilience to arbitrary hardware loss.

## One stale-base rebuild

Persist the rebuild count on the job across worker restarts. The service returns a stale-base rejection and current applied revision; Runner rereads relevant library material and regenerates the allowed proposal once from retained captures. This is not a blind Git rebase, automatic semantic merge, fresh Apify scrape or relaxation of the write scope.

The replacement uses a new operation ID/digest and links the rejected proposal. A second stale rejection ends with an actionable conflict. Existing job/time/capacity ceilings still apply; acceptance does not grant another fresh execution budget. When cancellation or expiry prevents rebuilding, return that outcome without modifying the library. Publication retries caused only by a lost response do not consume the rebuild allowance.

## Rollback as a new publication

An authorized operator request names the target publication ID and expected current revision. Resolve “latest” once when making that request and bind it to the idempotency key; do not reinterpret it after a lost response. The target must still be the latest fully applied publication with no committed-but-unapplied successor.

The service computes the inverse of that batch's active knowledge changes from its parent revision. This restores both notes, their active metadata/links and catalog state together, including deactivating notes created by the reverted batch. It is a service-generated proposal with a new operation/publication ID, validated and applied through the same protocol. No agent or Apify call is required. A race with another publication is an explicit stale-target conflict; never silently undo the new latest batch instead.

Append-only evidence, source/capture/asset manifests, identity reservations, prior publication manifests and receipts remain retained. Therefore the compensating Git tree need not be byte-identical to the old parent: its active reading state matches that state while historical evidence persists. Keep tombstones/reserved IDs for deactivated notes so future index rebuilds cannot accidentally reuse their identities.

The original receipt remains a truthful record of what happened and is linked to the compensating publication. Retrying the original ingestion operation must not resurrect undone notes. A later explicit new save is a new job and can reintroduce the material under the retained identities; it is not a replay of the rolled-back job. General selective/older-publication rollback is deferred.

## Retention and restore boundary

Retain operation IDs, digests, terminal results, publication receipts, identity reservations, historical knowledge commits and captures without automatic expiry in the first slice. Retain unresolved operation inputs and prepared refs until reconciled. No automatic raw-source or orphan-asset garbage collection is part of this slice; surface storage growth instead of silently discarding recovery evidence.

Disposable workspaces can be removed after their durable inputs/result are verified. Prepared refs for an applied operation may be removed only when its commit remains reachable from retained canonical history and its receipt is durable. Never prune in-flight candidates or rewrite committed history as cleanup.

Backups must capture coherent operational SQLite state, referenced Git commits/prepared refs and archive manifests. Restore rehearsals must include pending publication states and existing external-run identities, not just a catalog rebuild. The delivery decision owns schedule and restore execution; this contract establishes that Git alone cannot restore jobs, quotas and all idempotency state.

## Required verification

- Inject termination before and after every durable transition, including the Git update before its journal acknowledgment and SQLite activation before the client response.
- Continuously read list, note, source metadata, links and FTS during publication/recovery; each response must belong entirely to its advertised applied revision.
- Submit the same operation concurrently, retry after response loss, and reuse its key with changed bytes; expect one result or the specified conflict.
- Submit a different proposal for an already published job; it cannot create a second ingestion publication.
- Exercise stale-base rejection, one regenerated proposal, a second conflict and a worker restart between them; verify the allowance is not reset and Apify is not repeated.
- Fail asset readiness, corrupt an upload, and lose a conditional-upload response; no incomplete asset is accepted through the normal publication path.
- Start two writer processes against the same volume; pause the old writer and kill its parent while a Git child can still run. Establish real lock/epoch behavior before claiming fencing.
- Interrupt projection/FTS updates and outbox delivery; verify one logical publication/event record and stable delivery identity.
- Roll back a two-note batch: active notes/links/search return together, raw evidence/history remain, duplicate rollback returns its receipt, and a stale target cannot undo a later batch.
- Rebuild the catalog after rollback and resave explicitly; stable IDs, tombstones, receipts and source evidence survive.
- Restore a coherent backup containing a pending commit; do not restart acquisition merely because publication was incomplete.

Run deterministic filesystem/SQLite and failure tests locally, then on Linux with the deployed Git/Bun/Effect versions. Real R2 checks must verify the selected conditional-write/readback path. Passing this protocol's tests is separate from note-quality acceptance and the physical one-agent execution tests.
