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

The command reconciles known remote obligations, claims one eligible job, renews ownership while acquiring, and leaves the job prepared or with an actionable failure. It emits status and counts, not source bytes or credentials. Repeated invocation adopts the same provider operations and retained bytes; a missing start receipt blocks replacement after a permit was issued. A reservation with a provably unissued permit may resume through the same one-use Service API. Losing a lease stops that execution, while a new lease can continue the same acquisition inside its original deadline. After an interrupted run, preserve the accounting database, Service state, and Runner spool together. Acquisition recovery does not authorize a model launch.

`retentionPending` reports terminal evidence still awaiting archive completion; `accountingPending` reports unsettled cost reconciliation. This debt retains its full conservative accounting liability, but does not block unrelated jobs merely because no remote process is running. Failed retrievals use a persisted one-minute backoff in the private spool; a capacity failure requires operator intervention and is not repeatedly downloaded. Billing reconciliation runs independently and has its own persisted backoff; a terminal provider accounting outage keeps the conservative liability without monopolizing the queue. Backoff starts after a failed attempt finishes. An operator may remove a retry journal only after diagnosing/remediating its specific failure; never enlarge the accepted source limits or mark missing evidence archived just to clear the warning.

Before abandoning an optional acquisition mode for budget, Runner can wait for two bounded billing refreshes of already terminal, archived operations within the original acquisition window. It never increases a cap or replays a dispatched POST. Inconsistent terminal dataset pagination is retried on the same GET page with bounded exponential delay; persistent inconsistency remains a failure.

## Private creation gate

Before enabling unattended dispatch, perform one controlled, budgeted start through the same Service permit and Runner journal. Immediately verify its exact run ID and default stores:

```sh
mise exec -- bun tools/verify-provider-privacy.ts /absolute/private/privacy-input.json
```

The private input contains `tokenFile`, `runId`, `actorId`, `buildId`, numeric `startedAfter` in epoch milliseconds, and a new absolute `evidenceFile`. The checker accepts only a fresh run (within five minutes), restricted access metadata and anonymous denial for the run, dataset, key-value store and request queue, plus denial on log/dataset/input content paths. Apify's documented `FOLLOW_USER_SETTING` mode requires an additional `accountEvidenceFile`: a prior confirmed Restricted account setting (`observedAt`, `generalResourceAccess`, `savedAndConfirmedAfterReload`). Inheritance alone does not pass; fresh denial must also pass. See [Apify resource access inheritance](https://docs.apify.com/api/v2/actor-run-put). The checker does not change privacy. Failure leaves this gate open: stop/reconcile the exact known run, retain evidence and liability, and investigate before any following paid operation. Account settings or a previously hardened pilot alone do not prove privacy at creation. Preserve the account restriction for inherited resources throughout retention.

Retain the private evidence with the provisioned profile and campaign ledger. Also verify R2 conditional writes, checksum readback and anonymous denial. Public CI/issue evidence contains only redacted results and artifact identity; source URLs, run/store IDs, captures and model transcripts remain private.
