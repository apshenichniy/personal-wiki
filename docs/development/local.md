# Local development and verification

## Toolchain

Install mise **2026.9.1**, trust this checkout's `mise.toml`, and run:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run verify
```

The committed Bun lockfile is authoritative. Bun **1.3.13** is both runtime and package manager, with isolated workspace linking; moon **2.6.2** runs the verification DAG. Effect, platform-bun and the selected service-only SQLite adapter stay at **4.0.5**. TypeScript **7.0.2**, Effect diagnostics **0.53.4**, Oxlint **1.88.0**, Oxfmt **0.73.0** and oxlint-tsgolint **7.0.2004** match the successful stack spike. Ajv **8.17.1** and ajv-formats **3.0.1** are additional development-only dependencies for independent JSON Schema validation. No runtime-framework version deviations were introduced.

`verify` runs typechecking, headless Effect diagnostics, type-aware lint, formatting, generated-contract freshness, an intentionally failing diagnostic fixture, builds, and real process/HTTP tests. The checks and process tests run on macOS and GitHub-hosted Linux without credentials or paid providers. Verification tasks deliberately disable moon result caching; a successful gate represents execution on the current machine. Build caching can be introduced later with explicit input/invalidation tests.

The negative fixture is excluded from the application TypeScript project. Its separate diagnostic command must fail with `floatingEffect`; merely obtaining a nonzero exit is insufficient. Dependency declaration files use `skipLibCheck`, as in the spike; application code is strictly checked. Effect's unstable HTTP/SQL APIs are pinned and produce informational diagnostics, not silent compatibility guarantees. Selected correctness diagnostics are errors.

## Two-process synthetic path

In terminal 1:

```sh
WIKI_DATA_DIR="$HOME/.local/share/personal-wiki-dev" mise exec -- bun run service
```

In terminal 2:

```sh
mise exec -- bun run runner
```

The service binds **127.0.0.1:3000** only. `PORT=0` selects an available loopback port and prints a JSON readiness event; `WIKI_SERVICE_URL` selects the Runner's service URL. Runner performs one explicitly synthetic echo round trip, verifies correlation and exits. Stop the service with Ctrl-C (SIGINT/SIGTERM triggers Effect scoped cleanup). Nothing in this path captures X content or publishes a note. No external credentials are needed.

`GET /health` returns 204. `POST /api/v1/synthetic/echo` validates a bounded message and UUID `x-request-id`, and returns an explicitly synthetic response. Malformed input returns a schema-defined safe 400 envelope and a matching response correlation header. Invalid or missing incoming request IDs are replaced for error reporting. Private routes now require P4 machine credentials; owner browser access remains a separate required delivery task. Do not expose the intermediate server publicly.

## Contract ownership

`packages/contracts/src/index.ts` defines Effect schemas and HttpApi; `packages/client` derives the typed HTTP client. Runner depends on those boundaries, not Service implementation or SQLite. `apps/knowledge-service` owns server handlers; the SQLite adapter is used only inside the Service-owned library.

After a contract change:

```sh
mise exec -- bun run contracts
mise exec -- bun run format
mise exec -- bun run verify
```

Commit the generated OpenAPI 3.1 and JSON Schema 2020-12 files in `packages/contracts/generated`. The generator owns their formatting; Oxfmt explicitly excludes that directory. CI compares generated content rather than silently rewriting it. JSON Schema permits unknown extra fields consistently with Effect's default decoder; clients must tolerate additive fields. Tests independently validate a real response with Ajv, reject malformed inputs and server responses, and compare the served OpenAPI document with the committed artifact.

## Repository boundary

Only synthetic inputs are used in these checks. Runtime state, source captures, provider replies, credentials and knowledge documents remain outside this public repository and CI artifacts. The access-only workflow does not grant provider secrets to the verification workflow.

## Retained local publication (P2)

The Service now requires an absolute `WIKI_DATA_DIR` outside the code checkout:

```sh
WIKI_DATA_DIR="$HOME/.local/share/personal-wiki-dev" mise exec -- bun run service
```

It owns a bare `knowledge.git`, `library.sqlite` and create-once local `objects/`. The local adapter admits at most 1 MiB per synthetic upload and verifies SHA-256 against readback. Real bounded provider-page streaming and R2 are separate P6 work; do not use this JSON/base64 development transport for large provider responses.

The API reserves service-owned source/note/capture/representation/asset IDs, retains bytes, accepts a schema-validated proposal against a base revision, and returns a durable publication receipt. The original worker reservation/upload/publication protocol is now mounted only by the focused storage test harness. Production ingestion uses the P4 scoped job protocol below; operator rebuild requires its own capability.

Git stores Markdown at safe paths, a service-generated `.wiki/library.json` snapshot and append-only publication manifests. The snapshot includes exact Markdown bytes as well as metadata; reads/rebuild validate those bytes against the corresponding Git blobs. SQLite holds the separate operational journal/receipts and the rebuildable active snapshot/FTS index. Reading uses one SQLite snapshot; an optional requested revision fails explicitly when it is no longer active. The current small-library implementation loads the manifest in memory and bounds Git command output to 16 MiB; larger-library streaming/storage optimization is not established by P2.

The publication lane records received/prepared/committing/committed/applied phases and uses an expected-old-value canonical Git ref update. Active snapshot, FTS, revision, receipt and outbox change in one SQLite transaction. Matching operation retries resolve before stale-base or current asset checks, so a lost response cannot create another publication. Invalid asset/path/scope/citation proposals leave the previous reading state intact.

P2 tests use actual Git and SQLite, observe the library during a two-note publication, verify lexical Russian/English/original-only matches, concurrent replay, malformed assets and proposals, and delete/rebuild only the search projection while retaining operational rows. A move keeps note and old capture/citation IDs.

## Publication recovery and compensation (P3)

Start through `bun run service`, which invokes `tools/runtime/locked-service.py`. Python 3.12+ and Git are system prerequisites in addition to mise-managed Bun/moon. The supervisor owns a persistent `publisher.lock` inode with non-blocking `flock`, starts the scoped Bun service, and executes its bounded Git commands through a private Unix socket. It passes its lock descriptor to Git using Python's `pass_fds`; a surviving child retains exclusion even if the supervisor dies. Bun never owns or passes that descriptor. A direct Bun startup without supervisor ownership fails before opening SQLite. Socket ownership loss stops the service; normal shutdown terminates/reaps its process group. Deployment must preserve the lock inode and stop the old process group before takeover.

This helper arrangement replaces an unsuccessful local probe of direct Bun descriptor inheritance: a descriptor supplied as extra subprocess stdio was sometimes closed in the parent, producing intermittent storage errors and loss of exclusion. This observation is specific to the pinned local runtime; it is not a general claim about all Bun versions. The supervisor uses the Python standard library, no additional application framework or service credentials. Its main thread uses bounded child waits: a signal received by a socket worker must still reach Python's main-thread signal handler. A deterministic non-main-thread signal probe guards against shutdown deadlock.

Startup increments a persisted publisher epoch and adopts retained operations. It reconstructs a pre-prepare candidate with its recorded identity/time or verifies the stored candidate, manifest and parent. A durable committing intent finishes the same expected-old-value Git update; committed candidates activate the exact tree without reacquiring source material. The catalog, FTS, pointer, receipt and outbox activate together. Unexpected ref/manifest divergence fails closed and retains the journal for investigation. Interrupted deterministic genesis initialization also reconciles its recorded candidate rather than creating another history.

In the storage test harness, `POST /api/v1/worker/publications/cancel` accepts an operation ID. Production uses job cancellation under P4. Cancellation races the SQL transition into `committing`: before intent it prevents publication; afterward it returns `too_late`, and recovery must finish. `POST /api/v1/operator/compensations` accepts a new operation ID, the target publication ID and expected current revision. It restores the latest batch's previous active notes through a new commit while retaining captures/assets/identities/manifests/receipts. Replaying the original ingestion still returns its old receipt and does not resurrect undone notes.

`GET /api/v1/operator/outbox` returns undelivered events with stable IDs. `POST /api/v1/operator/outbox/ack` is idempotent. A lost delivery acknowledgement leaves the same event available; the reader's eventual polling/transport integration is separate work. These routes now require the P4 operator capability. Owner browser sessions are separate P9 work.

`bun run verify` includes actual process death at received, candidate, prepared, committing, ref-advanced, committed, activating and activated boundaries; cancellation interleavings; epoch fencing; contradictory-ref refusal; compensation/rebuild/resave; and OS exclusion with a paused owner and an orphaned Git process. Test faults are selected only through process-local `WIKI_TEST_*` environment variables, never API/source input. Production service definitions must not set these variables. Process-kill tests do not establish arbitrary disk-loss durability or live provider behavior; encrypted restore and deployment rehearsals remain P11/P12 gates.

## Durable ingestion jobs (P4)

The production entry point now exposes a private, authenticated job protocol. Its
old direct storage mutation routes are denied even for an operator token. P2/P3
storage tests mount a separate test-only service entry point; no environment flag
can enable those writes in the production entry point.

`WIKI_MACHINE_CREDENTIALS_FILE` optionally names an absolute, non-symlinked 0600
JSON file containing `credentials: [{ identityId, role, token }]`. Identity IDs are
UUIDs, roles are `runner` or `operator`, and tokens are `wk_` followed by 32 random
bytes encoded as unpadded base64url. Keep this file outside the checkout. SQL stores
only SHA-256 verifiers. Missing configuration grants no private access. Revocation
persists across restart; rotating a credential requires a new identity. Give Runner
only its token, not the operator's file, canonical SQL/Git, or future R2 credentials.

The service still binds loopback. Owner browser/OIDC sessions and excluding worker
routes from the public Tunnel are P9/P11 deployment work. Do not expose this
intermediate service publicly. Public health/echo contain only synthetic data.

- `/api/v1/submissions` and `/api/v1/jobs/*` expose submission, status and explicit
  actions. Operator credentials control submissions/actions until owner sessions
  exist. Save deduplicates against notes/active jobs; refresh is explicit.
- `/internal/v1/jobs/*` is the Runner protocol: claim, heartbeat, source resolution,
  reserve/upload/prepare, authorize/complete an attempt, publish retained output,
  and block. Every mutation carries a request ID and fenced job/instance/epoch.
- `/api/v1/operator/credentials/revoke` revokes an identity. Operator storage
  compensation/rebuild/outbox routes also require the operator capability.
- Generated `jobs-openapi.json` describes the job protocol; the original
  `openapi.json` describes reading and the focused storage protocol. Served
  metadata requires authentication. Typed clients derive from the Effect APIs.

A job and its scheduling outbox row are inserted in one SQL transaction. The
idempotent dispatcher offers `jobId/generation` to SQL PersistedQueue. A service
fiber owns delivery until a durable checkpoint/outcome permits settlement; an HTTP
request does not own the queue handler's lifetime. Blocked deliveries are settled,
not repeatedly retried. A higher generation is scheduled only for eligible retry,
explicit resume or safe ownership recovery. The reconciler inspects active jobs,
not every historical captured text.

The service persists the initial claim time, fixed 30-minute deadline, 15-minute
attempt deadlines and shared three-launch budget. One repair, transient retry and
stale rebuild each draw from that shared budget. Queue attempts are never product
attempts. A launch reservation survives ambiguous completion/restart. A valid
completed result is retained before publication; publication activation stores the
job result with its receipt, projection, revision and event in one transaction.
Cancellation/deadline and credential revocation are checked at commit intent.
After intent, recovery finishes the existing publication without another executor.

An uncertain process or provider operation blocks new execution until the relevant
trusted reconciliation proves safety. `reconciledProcess` is an internal lifecycle
boundary, not an HTTP shortcut for clearing provider ambiguity. P7 must attach real
supervisor evidence to it; P6 owns external-operation reconciliation. Synthetic
`processStopped` attestations do not establish actual CLI/process-tree exclusion.

A fake executor is built separately as `apps/runner/dist/synthetic.js`. It takes
`WIKI_SERVICE_URL` and a private `WIKI_RUNNER_TOKEN_FILE`, claims one fresh job,
creates a redistributable fixture through the scoped API and exits after its
publication receipt. It never invokes Apify or Codex. The earlier default Runner
entry point still performs the P1 echo; P7 supplies the real runtime adapter.
Do not ship the synthetic entry point or fixture helpers as a production executor.

Reproducible two-process demonstration, including temporary synthetic credentials:

```sh
mise exec -- bun run verify
mise exec -- bun test tests/job-http.test.ts
```

Focused persistence/policy checks:

```sh
mise exec -- bun test tests/job-policy.test.ts tests/job-queue.test.ts tests/jobs.test.ts tests/job-recovery.test.ts
```

These use actual Git/SQLite and separate processes. Controlled clocks and synthetic
supervisor assertions test policy; SIGKILL/response-loss boundaries test retained
state. They do not prove paid provider integration, physical Codex exclusion,
Pocket ID login, VPS deployment or owner acceptance.
