# Verified releases and CX33 installation

P11 implementation runbook. Live deployment evidence is recorded in issue #35; code and fixture checks alone do not establish G3/G5.

## Boundaries

`release.yml` runs only on trusted `main`, repeats the canonical checks, packages pinned Bun plus fully bundled Service/Runner and the web bundle, tests that package without `node_modules`, and attests the archive. There is no VPS build or package install. A root-owned controller verifies the archive with pinned GitHub CLI 2.101.0 before extraction: expected repository, `release.yml`, `refs/heads/main`, exact source and signer revision, and GitHub-hosted builder. An archive digest by itself is not authorization. See [GitHub CLI verification](https://cli.github.com/manual/gh_attestation_verify) and [offline verification](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline).

The `production` GitHub environment and existing main/repository Tailscale OIDC claims also apply to the logical staging deployment. `wiki-deploy` only connects to a local Unix socket through `wiki-deployctl`; it receives no sudo, Docker group, credential reads, arbitrary shell execution through the controller, or user-selected installation paths. Ordinary PR CI has no deployment identity or paid provider access.

Releases are root-owned under `/opt/personal-wiki/releases/{sha256}`. Fixed `current-staging` and `current-production` links select bytes. Knowledge/operational state stays under `/var/lib/personal-wiki-{namespace}`. Private settings and separate machine/OIDC/R2 credentials are provisioned by an owner-admin outside Git. The service owns both namespaces' shared accounting authority at `/var/lib/personal-wiki-accounting/provider-accounting.sqlite`; namespace unit mount restrictions hide the other's library/configuration. This is one trusted publisher authority, not independent untrusted tenants. Runner cannot read this ledger or Service state.

Both Runners use the existing canonical supervisor/execution lock inodes and `/var/lib/personal-wiki-runner/agent-slot`. Deployment stops both Runner units, checks their cgroups and lock availability, then checkpoints the target publisher. Only the selected environment resumes dispatch. The existing campaign/month ledger must be transferred coherently and reconciled before enabling acquisition; a new namespace cannot provision a new allowance. Provisioning defaults both dispatch flags to false.

## Commands

Owner-admin host provisioning, after installing the pinned GitHub CLI and deliberately handing over any existing stopped probe namespace:

```sh
sudo python3 ops/deploy/install-host.py
```

This is not a CI operation. It preserves existing identities/lock files, refuses a live namespace ownership mismatch, and starts only the deployment controller. It does not recreate the VPS, Pocket ID, Telegram or Tunnel.

Build and install into staging through trusted CI:

```sh
gh workflow run release.yml --ref main
```

The workflow prints a deterministic operation UUID. Read status after an SSH interruption:

```sh
tailscale ssh wiki-deploy@dock-cx33.tail4b6e77.ts.net 'wiki-deployctl status OPERATION_UUID'
```

After resolving the recorded cause, resume the same operation:

```sh
tailscale ssh wiki-deploy@dock-cx33.tail4b6e77.ts.net 'wiki-deployctl resume OPERATION_UUID'
```

Rollback uses the retained verified predecessor, not a supplied URL/path/command:

```sh
tailscale ssh wiki-deploy@dock-cx33.tail4b6e77.ts.net 'wiki-deployctl rollback NEW_OPERATION_UUID staging'
```

A request ID cannot be reused for another target or artifact. Transport loss never creates an untracked second deploy. Failed operations require explicit resume; process death at an incomplete checkpoint is reconciled after controller restart. Private reads must pass, anonymous reads must return no-store 401, and a synthetic R2 object must round-trip and deny anonymous access before completion.

## Compatibility and recovery gate

The first artifact declares schema 7 and readable range 7–7; a disposable empty staging namespace may initialize it. Unknown/newer schema and incompatible rollback fail before replacement starts. Rollback switches application bytes while keeping current Git history, job records, costs, deadlines and retained originals. It never restores an older database or runs a destructive down migration.

Production activation also requires a root-only P12 recovery proof at `/var/lib/personal-wiki-deploy/recovery/{operationId}.json`: the operation and target, current schema, exact stopped-state checkpoint digest, a verified backup flag and completion time within one hour. CI cannot write this proof. Missing/changed/stale evidence fails closed; production promotion remains unavailable until P12 supplies the verified backup integration and P13 completes live gates.

The controller remains in the last durable phase if killed; it rechecks stopped cgroups, preserved locks and checkpoint identity before activation. An unexpectedly changed checkpoint fails closed. Ready means the Service recovered its durable publication state and authenticated reads are coherent; it does not imply that paid execution was enabled or that an owner accepted the product.

## Finite resource policy

Service: 1280 MiB RAM, no swap, two CPU equivalents, 96 tasks, 4096 descriptors. Runner: 3072 MiB RAM, no swap, 2.5 CPU equivalents, 192 tasks, 4096 descriptors. Controller: 1024 MiB RAM, one CPU equivalent, 32 tasks, 256 descriptors. One physical Runner runs at a time. Archive upload is bounded to 160 MiB, expansion to 384 MiB and at most 20 regular allowlisted files; links/traversal/duplicates are rejected. Installation requires at least 5 GiB free disk. Retained releases are deliberately not garbage-collected automatically.

These are admission limits, not measured peak usage. Record baseline/representative RSS, CPU, free disk and latency with existing services in the P11/P13 evidence. An unhealthy or missing required integration keeps the gate open.

## Deterministic checks

```sh
python3 -m unittest discover -s tests/deployment -v
mise exec -- bun run verify
```

The Python suite verifies interrupted state transitions, idempotent replay, unchanged knowledge during rollback, unknown schema/fencing/backup failures, archive confinement and verifier policy. Actual cryptographic provenance and real unit/SSH interruption evidence require the trusted staging release. Keep synthetic fixtures and public metadata separate from private originals and authentication evidence.

### Controller recovery and credential authority

A deployment owns a durable critical-operation marker before stopping dispatch.
A failure after that boundary blocks later installs and rollbacks, including after
controller restart; resume that operation after correcting its cause. If an activated
release cannot start, an explicit rollback takes over the failed operation and
selects its last healthy predecessor (not the predecessor of that predecessor).
The failed operation becomes permanently superseded; recovery still fences the
workers and checks the current schema. An initial bootstrap with no predecessor
requires owner-administrative repair and cannot claim a rollback target. Completion
releases the marker. Repeating a completed operation never rewrites the active
release, and rollback retries keep the originally selected predecessor.

Runtime credentials, preflight and readiness all use
`/etc/personal-wiki/deploy/{staging,production}` as their authoritative configuration.
Initial provisioning imports owner-access and R2 files from the prepared secret
inventory; it does not keep those import files synchronized. Rotate the canonical
files through owner administration with dispatch stopped, update the corresponding
runner token when rotating machine credentials, and restart both affected units so
systemd reloads credentials. The installer preserves existing identities.
