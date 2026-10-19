# Encrypted backup and isolated recovery

P12 implements this procedure; issue #36 records the actual restore evidence. A successful archive upload alone is not a verified recovery point. Production promotion remains subject to P13 and owner acceptance remains G6.

## Tools and trust

Use **restic 0.19.1**, pinned in mise for development/CI and at `/opt/personal-wiki-tools/restic/0.19.1/restic` on CX33. Official Linux archive SHA-256: `f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c`. Source: [official release](https://github.com/restic/restic/releases/tag/v0.19.1). Restic supplies authenticated encryption and incremental deduplication; the application does not implement cryptography.

Root-only `/etc/personal-wiki/backup/r2.json` selects `personal-wiki-backups`, separate from both primary buckets. `/etc/personal-wiki/backup/restic-password` holds the unattended recovery key; retain that key and backup credentials in the owner's **outside-VPS** private recovery inventory before initialization. Do not copy them into Runner, CI, application configuration or public artifacts. The backup operator can delete backups, so this is encrypted disaster recovery, not protection against a fully compromised root with backup credentials.

`tools-release` in the same private directory contains one verified artifact digest with `backup-assets.js` and `prepare-restore.js`. It pins recovery tools independently of application rollback. Retain its signed archive/manifest. Change it deliberately when adopting a new schema; restoring with incompatible tools fails closed.

Owner-admin installs `ops/backup/install-host.py` after the key, scoped R2 credentials and pinned restic binary exist. The installer does not initialize/reset a repository or enable a timer. Initialize restic once with the private S3 configuration; never generate a replacement password to fix an access failure. [S3 configuration](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html#s3-compatible-storage).

## Coherent cut and completion

The daily unit holds the same deployment lock as the release controller. It stops both Runners, confirms empty cgroups and canonical physical locks, then stops/fences both publishers. Pocket ID stops only for its snapshot. The cut preserves:

- Both library directories: full Git history/prepared refs, projection and operational SQLite, publication intents, proposals, assets and receipt/outbox state.
- Both durable Runner spools (excluding only the known reaped guardian transport FIFO, while retaining input/output/exit evidence), the shared cost ledger and original bootstrap-accounting evidence.
- Private configuration/owner binding, Pocket ID database and encryption material, exact active release artifacts and pinned recovery tools. Codex login can require reauthentication after a disaster; recovery does not silently select another account or billing method.
- Original object identities from library assets and shared provider page/intent records, followed by independently checksum-verified copies of the original bytes.

SQLite uses its backup API, including committed WAL data; the cut normalizes standalone database files. Other files and Git refs are copied while their writers are fenced. The prior running-unit set is journaled before stopping anything. The units that were running resume after the local cut; systemd cleanup and a boot recovery unit replay that journal if the backup process is killed. Deployment preflight rejects an unresolved backup checkpoint. Immutable original bytes may then transfer while normal reads resume. A missing object, failed checksum or incomplete provider intent prevents completion; it is never omitted merely to obtain a green backup.

The root-owned workspace is `/var/lib/personal-wiki-backup`. A minimum 5 GiB disk reserve is checked before each cut. Failed cuts remain private for diagnosis/retry; monitor and remove them only after preserving needed recovery inputs. No automatic source/history garbage collection runs. Restic writes a `pending` snapshot, restores it into another empty directory, checks every file, SQLite integrity, Git objects and originals, and only then tags it `complete`. Only complete points advance `last-success.json` and qualify for retention. Successful local cuts/verification copies are removed.

## Daily operation and migration pins

```sh
systemctl start personal-wiki-backup@daily.service
python3 /opt/personal-wiki-backup/status.py
systemctl enable --now personal-wiki-backup.timer
systemctl list-timers personal-wiki-backup.timer
```

The timer runs daily at 04:15 UTC with up to five minutes jitter and catches missed runs. `status.py` exits nonzero when no verified point exists, its checkpoint is older than 24 hours, or a later backup failed. Inspect the failed unit and private retained cut; an old successful upload does not establish current RPO. The first slice exposes operational status through this operator command and systemd; it does not send external alerts.

Daily retention keeps seven daily and four weekly points, grouped by fixed backup host. Migration points are separately tagged and excluded from daily forgetting. Forgetting removes snapshot references; pruning unused packs is a later explicit maintenance operation, not automatic original-asset deletion. [Restic retention semantics](https://restic.readthedocs.io/en/stable/060_forget.html).

For production install/rollback, the release controller owns the deployment lock and calls `personal-wiki-backup@<operation-uuid>.service` after stopping the target. The backup unit verifies that exact in-flight production operation and creates a pinned point. Its root-only proof binds operation, schema and checkpoint fingerprint; absent, stale or mismatched proof blocks activation. A controller restart reconciles the operation ID. Do not manually fabricate recovery proof files. Release a migration pin only after its rollback window has explicitly closed and another verified recovery point exists.

## Empty-target rehearsal

```sh
python3 /opt/personal-wiki-backup/restore.py SNAPSHOT_ID /var/lib/personal-wiki-rehearsal-NEW_ID
```

The destination must not exist. This command starts no service, listener, route or Runner. It accepts only a complete snapshot, verifies decryption, file hashes, SQLite/Git integrity and original bytes, then uses the bundled exact recovery tool to reconcile pending publication from retained candidates. It invalidates restored owner sessions/pending logins, revokes all old machine identities, advances epochs and writes new machine credentials. Active old jobs retain their deadlines, counters, inputs and results but become `restore_accounting_unknown`; normal resume/retry cannot replenish them. Their prior execution evidence remains available for operator reconciliation.

The restored shared cost ledger is quarantined. A previous snapshot cannot establish that later paid activity never occurred. Reconcile against independent current ledger/provider evidence, preserving unknown liabilities, before authorizing paid dispatch. Do not clear the quarantine by deleting a database or provisioning an empty allowance. Unresolved old-job launch accounting similarly prevents continuation. New controlled synthetic work can be tested with fresh credentials without enabling paid providers.

For an isolated reader, select the restored library, fresh machine credentials and current verified owner/OIDC configuration. Set `WIKI_PROVIDER_LEDGER_FILE` to the restored quarantined ledger and **only** `WIKI_RECOVERY_ARCHIVE_DIR` to the restored `originals/`; omit `WIKI_R2_CREDENTIALS_FILE`. This explicitly read-only archive serves checksum-verified original bytes without primary R2 credentials or fallback. Bind only loopback/unrouted ports and keep public routing/dispatch disabled until owner binding and authorization have been checked. Never attach the old live source bucket as a way to make the rehearsal pass.

A rehearsal must record: snapshot/cut time, exact artifact/schema, elapsed restore time, recovered revision, original delivery while primary archive access is absent, denied old session/worker credentials, fresh owner login, read/search, pending-publication replay and controlled new work. Target RPO is 24 hours; RTO is four hours after operator and recovery credentials are available. Report read-only or quarantined recovery honestly until the required operational capabilities are reconciled.

A real authority transfer additionally requires fencing the old VPS/writer, reconciling current external liabilities and Codex account access, binding the selected verified release, restoring Pocket ID with its saved encryption material where needed, and deliberately switching the protected route. The rehearsal command cannot perform that authority transfer accidentally.
