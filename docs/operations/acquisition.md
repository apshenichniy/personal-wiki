# Bounded X acquisition

The acquisition executable stops at a durable prepared capture. It does not launch Codex or publish notes. Curation and physical agent supervision are separate delivery tasks. Ordinary verification uses synthetic providers and never consumes an Apify allowance.

## Service configuration

Run the built Knowledge Service through `tools/runtime/locked-service.py`, as described in the local development guide. In addition to its private machine credentials, configure:

- `WIKI_DATA_DIR`: private library directory.
- `WIKI_NAMESPACE`: `staging` or `production`.
- `WIKI_PROVIDER_LEDGER_FILE`: absolute shared accounting SQLite path outside the library directory. Both namespaces must use the same accounting authority; a fresh database is not a fresh allowance.
- `WIKI_R2_CREDENTIALS_FILE`: absolute private JSON file with `endpoint`, `bucket`, `region`, `accessKeyId`, and `secretAccessKey`. Staging uses its own private source bucket. Never pass backup credentials to this process or Runner.

Paid dispatch remains disabled without the provisioned accounting profile. The trusted operator provisions it with:

```sh
mise exec -- bun run tools/provision-provider.ts /absolute/private/provision.json
```

The input is a regular 0600 file containing `ledgerFile`, `profile` (the shared `Profile` contract), and `baselines` (`baselineId`, UTC `month`, nullable `campaignId`, integer `nanos`, evidence SHA-256). Import reconciled previous usage and unresolved liabilities before enabling dispatch. The profile pins the Actor/build, input-schema digest, pricing/privacy evidence digests, campaign, event price and conservative platform/retrieval reserves. Provisioning is immutable and idempotent; conflicting replacement values are rejected. One dollar is one billion accounting nanos.

An Actor event ceiling is not a total invoice ceiling. Platform/retrieval reserves remain distinct, delayed or missing usage keeps conservative liability, and terminal execution does not mean archived or cost-settled. Never remove the ledger to resolve a blocked budget.

## Runner configuration and command

Set `WIKI_RUNNER_CONFIG_FILE` to a private 0600 JSON file:

```json
{
  "serviceUrl": "https://private-service.example",
  "runnerTokenFile": "/absolute/private/runner-token",
  "apifyTokenFile": "/absolute/private/apify-token",
  "spool": "/absolute/private/acquisition-spool"
}
```

Token files must be regular private files. The spool directory must be private. Loopback `http://127.0.0.1` is supported for local verification; remote transport requires HTTPS. Runner receives no library database, Git, or R2 credential path.

```sh
mise exec -- moon run runner:build
mise exec -- bun apps/runner/dist/acquire.js
```

The command reconciles known remote obligations, claims one eligible job, renews ownership while acquiring, and leaves the job prepared or with an actionable failure. It emits status and counts, not source bytes or credentials. Repeated invocation adopts the same provider operations and retained bytes; a missing start receipt blocks replacement. After an interrupted run, preserve the accounting database, Service state, and Runner spool together. Acquisition recovery does not authorize a model launch.

## Private creation gate

Before enabling unattended dispatch, perform one controlled, budgeted start through the same Service permit and Runner journal. Immediately verify its exact run ID and default stores:

```sh
mise exec -- bun tools/verify-provider-privacy.ts /absolute/private/privacy-input.json
```

The private input contains `tokenFile`, `runId`, `actorId`, `buildId`, numeric `startedAfter` in epoch milliseconds, and a new absolute `evidenceFile`. The checker accepts only a fresh run (within five minutes), restricted metadata and anonymous denial for the run, dataset, key-value store and request queue. It does not change privacy. Failure leaves this gate open: stop/reconcile the exact known run, retain evidence and liability, and investigate before any following paid operation. Account settings or a previously hardened pilot do not prove privacy at creation.

Retain the private evidence with the provisioned profile and campaign ledger. Also verify R2 conditional writes, checksum readback and anonymous denial. Public CI/issue evidence contains only redacted results and artifact identity; source URLs, run/store IDs, captures and model transcripts remain private.
