# First-slice verification and CX33 delivery

**Status:** accepted delivery policy and engineering contract, 2026-10-18. Required evidence is still to be produced during implementation. Decision: [Agree first-slice verification and CX33 delivery gates](https://github.com/apshenichniy/personal-wiki/issues/21).

The owner approved autonomous progression, during the later authorized implementation effort, from local verification through GitHub Actions and isolated staging on the existing CX33 to the private production application. Passing these gates establishes **ready for owner acceptance**. Actual iPhone use with the Mac switched off, and the owner's assessment of the resulting notes, establish **owner acceptance**. These are separate outcomes.

This contract complements [publication](atomic-publication.md), [execution](execution-lifecycle.md), [capture/curation](x-capture-curation.md), and [reader/access](private-reader-access.md). It does not authorize implementation or provider calls during specification work.

## 1. Evidence and release gates

Every gate records the exact code revision, artifact digest where applicable, tool/provider versions, environment, commands, result, and references to evidence. Distinguish deterministic fixture tests, real integrations, and owner observations. Public CI reports may contain synthetic data and redacted results; original captures, notes, authentication data and sensitive logs remain private.

| Gate | Required evidence |
| --- | --- |
| G0: access and execution readiness | Refresh the [access inventory](../operations/access-readiness.md). Resolve human-dependent login/passkey actions before an unattended implementation run. Test the real capabilities required by each later stage; an SSH smoke test does not prove deployment authority. |
| G1: reproducible local development | A clean checkout installs pinned tools and dependencies with mise and the frozen Bun lockfile; moon runs typechecking, Effect diagnostics, Oxlint/Oxfmt and meaningful contract/integration tests through documented repository commands. No global unpublished dependency or private fixture is needed for ordinary checks. |
| G2: deterministic integrated behavior | Exercise the entire save-to-read path with synthetic provider/executor adapters, including the failure matrices in the four contracts above and source-identity cases. Run Linux process/durability tests as well as local tests. Successful queue tests alone do not prove publication or process isolation. |
| G3: verified release artifact | Trusted GitHub Actions builds a Linux/amd64 release from the checked commit and records its digest, dependency/tool versions, migration compatibility and required runtime configuration. Staging and production use the same verified artifact; the VPS does not rebuild it. |
| G4: isolated live staging | On CX33, verify real R2 retention and private access, real Pocket ID owner login, pinned real Codex execution, and bounded Apify capture. Cover the pilot's three representative conversations plus a genuine author continuation/chain case; cases may overlap. Verify denied access and browser behavior at desktop and mobile sizes. |
| G5: operational delivery | Demonstrate restart/recovery, a deployment interrupted at a checkpoint, compatible application rollback, encrypted backup and clean restore, finite resource use, and a server-only ingestion/read cycle with no service dependency on the owner's computer. Promote the exact artifact after these checks pass. |
| G6: owner acceptance | The owner opens the deployed private wiki on a real iPhone while the Mac is off, submits/reads/searches a saved source, follows inline citations, opens retained source text, and evaluates detailed note quality and visible coverage gaps. Record this separately from automated viewport tests. |

G1–G5 are the autonomous delivery gates. A passing synthetic test is not a substitute for G4, and G5 is not a claim that G6 happened. An untested mandatory property remains incomplete, even if the happy path appears usable.

### Required verification categories

- **Capture and identity:** normalization of supported X URL forms, root and middle/selected-reply inputs, stable identities on repeated save, explicit refresh, separate article identity, deduplication across acquisition modes, useful partial results and honest coverage. Test main-source absence, capacity exhaustion and unavailable articles without fabrication.
- **Quality:** retained main points, examples, qualifications and attribution; meaningful corrections and disagreement; separate curated discussion; per-post inline citations validated against captured evidence. Use the accepted pilot reading style as a rubric, not as a byte-for-byte expected output. A schema-valid response is not automatically a quality pass.
- **Execution:** durable external-run correlation and accounting, lost start response, blocked authentication, time/launch limits, queue redelivery, cancellation, retained-result adoption, old-child cleanup and no overlap across process restarts. Unknown provider outcomes remain reserved and blocked where required.
- **Publication:** wrong asset checksum, duplicate operation, key reuse with different input, stale proposal, crashes around Git and SQLite boundaries, lost acknowledgement, double startup and compensation. A reader sees one applied revision across list/search/read, and recovery does not rerun acquisition or curation unnecessarily.
- **Access and presentation:** owner/non-owner/anonymous cases, session expiry/revocation, CSRF, safe source rendering, protected assets, correct source/citation targets, revision-bound search, polling/foreground reconciliation and actionable job controls. Recheck the recorded Mac HTTPS issue without bypassing TLS.
- **Recovery:** interrupted deploy, missing archive object, backup failure, restored pending publication, restored old sessions and uncertain external charges. Test restore with the primary source bucket unavailable to prove that the backup includes original bytes.

Use deterministic injection for expensive or dangerous failure paths. Live checks establish actual integration properties and representative quality; they do not need to reproduce every fault through paid provider calls. The required Linux durability, sandbox, lock inheritance and orphan-process tests must exercise real operating-system behavior.

## 2. Live acceptance budget and staging isolation

The future first-slice acceptance campaign may spend **at most USD 2 on Apify**, within the accepted **USD 0.25 per job** and **USD 5 per UTC calendar month**. This campaign authorization is distinct from the completed pilot's USD 2 ceiling. Actual settled pilot usage, rather than its unused allowance, counts in the applicable month. Preserve known charges and uncertain liabilities across campaign retries, workflow reruns and environment resets.

Reuse retained captures for repeated Codex quality checks. Ordinary PR CI uses synthetic or redistributable fixtures and no paid providers. Codex uses the owner's subscription, with no API billing fallback. If the remaining budget cannot complete a gate, retain evidence and report that gate incomplete; do not increase a cap or label it passed.

Staging uses separate Git/state/workspace namespaces, archive prefixes and OIDC client configuration. Staging credentials are restricted to the operations and namespace it needs. Do not copy production sessions into staging or expose staging data through the production reader.

Both environments share the **one physical product-agent slot**. The simplest first-slice procedure is a bounded live-campaign maintenance window: pause production dispatch, reconcile its active worker, then run staging. A host-wide supervisor prevents overlap even with separate service databases. Development agents working on code are outside this product slot.

Separate databases must not each invent a fresh monthly allowance. Before staging, reserve its spending envelope against the authoritative Personal Wiki accounting record; production cannot spend that reservation. Reconcile staging charges and unresolved operations before releasing the envelope. During initial bootstrap, keep a durable private campaign ledger and import its known/uncertain usage before enabling production acquisition. Exercise this handover through a service/operator operation, not a Runner SQL edit.

## 3. GitHub Actions and artifacts

Start with GitHub-hosted Linux jobs. Apple/macOS lanes follow when Apple code exists. Cache only appropriate inputs keyed by lockfile, toolchain and platform; run affected-project checks where dependency tracking is trustworthy. Cancel superseded ordinary checks, but serialize deployment and do not cancel its state-changing critical section in favor of a newer run.

Untrusted pull requests receive no production identity, runtime secrets or provider access. Build release artifacts from trusted `main` after its checks, not from arbitrary PR artifacts. Pin third-party actions by full commit SHA and scope permissions per job. Do not combine privileged event handling with execution of untrusted checkout code; see GitHub's [secure use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

Produce a release manifest and signed provenance/attestation. Verify the artifact digest and expected repository, trusted workflow and source revision before installation; signature validity by itself is insufficient. GitHub documents [offline attestation verification](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline). Verification failures block promotion.

Preserve the existing [Tailscale workload identity boundary](../operations/ci-access.md): trusted repository, `main`, GitHub `production` environment, ephemeral node, SSH as `wiki-deploy`. Logical staging on this VPS does not require broadening those claims. Use allowlisted deployment targets behind this boundary; do not give `wiki-deploy` sudo, Docker-group membership or access to runtime credentials.

## 4. Installation, migrations and rollback

An owner-administrative provisioning step installs a narrowly scoped deployment helper. Its interface accepts a verified release identity and fixed target/operation; it does not accept arbitrary commands, paths, units or container arguments. CI can upload/install the allowed artifact, request the allowed migration/start/rollback operation, and read redacted status. The helper runs with only the privileges needed for those operations.

Keep application releases, durable state and runtime secrets separate. The release manifest declares supported database schema versions and the rollback-compatible predecessor. Prefer additive migrations during the first-slice rollback window. A failed migration blocks readiness; automatic destructive down-migrations are excluded.

The deployment protocol is itself restartable and has a durable operation ID:

1. Verify artifact identity, configuration presence, free capacity and schema compatibility. Create and verify a recovery point before a state-changing migration.
2. Stop accepting new dispatch, keep coherent reads available where possible, and drain or deliberately checkpoint the active job. Reconcile any durable publication intent. If the old worker cannot be confirmed stopped, leave the old release in place or enter maintenance; never start a replacement speculatively.
3. Preserve the canonical storage paths and lock inode/volume across releases. Fence and reap old workers, apply the allowed migration, then start the new service/Runner in the required order.
4. Reconcile recovery state and check readiness, denied anonymous access, authorized retrieval, archive access and process ownership. Route the wiki endpoint from its temporary 404 to the application only when private access is enforced.
5. Record the active artifact/revision and outcome durably, then resume dispatch. A lost SSH response or CI interruption queries this operation rather than applying an untracked second deployment.

Retain the previous verified artifact and its compatibility metadata. Application rollback restores the previous compatible binary/configuration; it does **not** reset knowledge Git, undo accepted jobs or replace current state with an older backup. Reversing a knowledge batch uses the compensating-publication contract. If the old artifact cannot read the migrated schema, report a blocked rollback and use a reviewed recovery path rather than silently losing data.

Observe baseline and representative peak RSS, CPU, free disk, temporary storage, job duration and reader responsiveness alongside existing Telegram MCP, Pocket ID and Tunnel services. Configure finite limits and storage admission checks, recording the chosen headroom and measured evidence in the runbook. No OOM, unbounded temporary growth or unexplained degradation of existing services is acceptable. A small pilot does not establish capacity for a future 1 GB corpus; a failed capacity gate calls for diagnosis, not an automatic VPS upgrade.

## 5. Encrypted backup contract

Use a maintained encrypted incremental backup tool, with its version and restore commands pinned in the implementation runbook. Store backups in a **separate private R2 backup bucket**. The backup component's credentials are isolated from Runner and ordinary deployment access. Keep the recovery key and necessary recovery credentials outside the VPS in the owner's private recovery inventory; a key stored only in the failed server is insufficient. Do not implement custom cryptography.

Schedule a verified backup daily, retain **seven daily and four weekly recovery points**, and pin a pre-migration point until that migration's rollback window is closed. Failed or incomplete backups do not count toward retention and must not cause deletion of the only usable recovery point. Retention operates on complete recovery points, not on arbitrary original assets still referenced by retained knowledge/history. First-slice automatic source/orphan garbage collection remains excluded.

A recovery point contains:

- A coherent SQLite backup including operational tables, publication journal, attempts, provider-run IDs, cost reservations, scheduling/outbox state and applied revision. Use the SQLite backup mechanism or an equivalently verified quiescent snapshot; copying only the live database file while ignoring WAL is not a backup protocol.
- Knowledge Git history and required refs, including prepared/committed candidates needed by pending operations; durable proposal inputs and retained output spools required for crash recovery.
- A manifest of retained original assets and encrypted protected copies of their bytes, with verified checksums. Merely retaining object keys pointing at the primary source bucket does not protect against loss of that bucket.
- Release/schema/tool metadata and private restoration configuration. Document recovery of Pocket ID state/encryption material and owner binding; keep secrets out of public manifests. Provider sessions may require explicit reauthentication after disaster recovery.

Coordinate a short checkpoint across the publisher, dispatch and asset registration so the manifest and state belong to one recoverable cut. Preserve pending intent rather than deleting inconvenient unfinished work. Once pinned, immutable assets can transfer after normal service resumes; mark the backup complete only when all required bytes and state are independently recoverable. Retain required local inputs until backup completion. Test the consistency protocol under concurrent job completion.

The normal-operation target is **RPO at most 24 hours** with successful daily backups. The recovery target is **RTO at most four hours once an operator and required credentials are available**. These are engineering targets to measure, not guarantees from this document. Detect and surface stale/failed backups; do not report RPO compliance when no timely complete recovery point exists.

## 6. Restore rehearsal and release readiness

Restore into an empty, isolated target with public routing and new job dispatch disabled. Fence the old writer before any restored writer becomes authoritative. Verify decryption, checksums, schema/tool compatibility, Git objects/refs, SQLite integrity and availability of originals from the backup itself. Recover the complete operational database; rebuilding only its search projection cannot recover jobs or spending state.

An older backup can resurrect old credentials or omit already incurred external costs. Therefore:

- Invalidate all restored application sessions and pending login flows; revoke/rotate execution credentials and advance fencing epochs before opening access. Verify a previously valid session and worker capability are rejected. Do not automatically re-enable a restored owner/identity configuration without reconciling the current private owner inventory.
- Reconcile recorded publication intents using their retained candidate identities before exposing the recovered applied revision. Resume durable receipts/outbox state idempotently; do not rerun acquisition or curation merely to recover a committed batch.
- Quarantine paid execution until post-backup external operations and charges are reconciled against retained independent/provider evidence. Preserve unresolved reservations and block when correlation is ambiguous. Absence from an old database is not evidence that a paid run never happened.
- Preserve elapsed deadlines and consumed allowances. If post-backup launch accounting cannot be established, block the affected restored job rather than resuming from a stale counter. Explicit retry follows the execution contract; restoring a backup cannot replenish launch or cost limits automatically.

Measure restoration time and the recovered revision/data window. Verify note search/read, original delivery, current owner login, denied old sessions, pending-operation recovery and a controlled new job. Report read-only recovery separately if paid execution remains quarantined; do not claim full recovery while a required capability is still blocked.

Delivery is **ready for owner acceptance** when G1–G5 pass for the deployed artifact, required operational runbooks and evidence are available, and known limitations are recorded. Apify privacy at creation, exact Codex profile, process isolation, durability and application authorization must be verified rather than inherited from old access smokes. A missing mandatory gate stays open; an exhausted budget or unavailable login does not justify weakening it.

Accepted first-slice limitations include bounded/non-exhaustive X capture, lexical rather than semantic search, no offline web mode, and no native clients or additional ingestion channels. G6 remains a distinct owner check after autonomous delivery; record its outcome without rewriting earlier evidence.
