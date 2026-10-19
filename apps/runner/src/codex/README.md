# Subscription Codex execution

The adapter consumes a trusted prepared context and returns a private, untrusted
proposal. It never fetches source material or publishes knowledge. `curatePrepared`
reserves an attempt through the Knowledge Service before calling `executeCodex`;
`recoverExecutions` transfers retained output after a service restart without
spending a new launch. P8 supplies the curation instructions/context and runtime
pipeline. P11 packages the process boundary and deployment.

## Runtime profile

- Codex CLI **0.163.0**, model **gpt-5.6-sol**, reasoning **medium**, 272,000-token
  context. Deployment supplies and checks the trusted executable SHA-256.
- A static model catalog removes `apply_patch`, shell, and model-advertised tools.
  Explicit features disable web/image/browser tools, subagents, plugins, hooks,
  memories, inherited skills and MCP. The output schema and instruction file are
  trusted inputs; their digests and the full profile are retained per attempt.
- `forced_login_method=chatgpt`; only the dedicated subscription `auth.json`
  reaches the CLI. The environment excludes API keys and provider/storage/deploy
  credentials. Missing credentials block the adapter before reservation; a
  structured CLI authentication/quota error gates further execution. Unknown
  errors fail rather than becoming unlimited retries. Transport reconnection is
  not a paid API fallback.
- `js-tiktoken@1.0.21`, `o200k_base`; 64,000 admitted tokens including instructions,
  schema and an 8,192-token protocol reserve. Related excerpts must occur inside
  the prompt and fit both their own and the total ceiling. Output is limited to
  1 MiB/16,000 visible tokens. Source text is never shortened to fit.

Pinned implementation references: [model catalog and tool metadata](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/protocol/src/openai_models.rs),
[tool construction](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tools/spec_plan.rs),
[static catalog](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/models-manager/src/manager.rs),
[tokenizer mapping](https://github.com/openai/tiktoken/blob/4e71bbe0c078468e00fefbf94b39849389f346e5/tiktoken/model.py).

## Physical ownership and recovery

The runtime must start through `tools/runtime/locked-runner.py` with an absolute
private `WIKI_AGENT_SLOT` shared by staging/production and all agent adapters.
Its non-expiring supervisor flock survives exec into Bun. Before claiming work,
inspect/reconcile pending executions; a live Service lease or unknown physical
state prevents replacement. Do not use direct `executeCodex` calls as a production
entry point outside this lifecycle.

The Python guardian holds a second attempt lock and persists boot/start/generation
identities before spawn. It requires a fresh acknowledged heartbeat, stops after
15 seconds without renewal, and enforces the persisted launch deadline. Cleanup
uses TERM, a ten-second grace and then KILL with five-second verification. A
successful leader exit does not establish process-tree death. Children inherit
its lock descriptor: a surviving detached lock holder prevents a death certificate
and keeps the slot blocked. Linux additionally uses a private PID namespace.

A complete bounded result is fsynced with a checksum and exit certificate after
cleanup. An inspector must establish physical safety before restart adoption. A
host reboot establishes prior-process death; on the same boot an ambiguous spawn
without a matching death certificate remains blocked. Never delete its marker
because a TTL elapsed, kill an arbitrary reused PID, or restart the CLI to recover
an already retained answer. Cancellation/expiry take precedence over adoption.

## OS boundary and limits

Actual subscription execution is **Linux-only**. Bubblewrap exposes runtime
libraries, the admitted workspace and the dedicated auth home, with separate
mount/user/PID namespaces. No host private home, deployment configuration or
service database is mounted. The model has no browsing or file/command tool.
The outer CLI retains network access for subscription transport. The adapter
rejects other platforms before execution.

macOS runs deterministic real-process fault probes and the Seatbelt file-access
probe. Actual Codex 0.163.0 needs macOS preferences IPC that the current narrow
profile denies; this is not enabled by broadening access to the user's preferences.
The initial supported execution host is the agreed Linux VPS.

Diagnostics are streamed up to 8 MiB; the final response travels through a FIFO
and is stopped at 1 MiB without a truncated proposal checkpoint. Workspace size
is checked every 100 ms against 256 MiB, with a 16 MiB per-file OS ceiling. This is
an observed stop threshold, not an atomic filesystem quota; deployment also needs
memory/process/disk resource limits. Corrupt checksums or unconfirmed death fail
closed. Malformed bounded JSON reaches Service validation/repair; overflowing
output cannot publish.

## Verification

```sh
mise exec -- bun test tests/agent-guard.test.ts tests/codex-sandbox.test.ts tests/codex-profile.test.ts tests/codex-spool.test.ts tests/codex-recovery.test.ts
mise exec -- bun run verify
```

These commands use synthetic child processes, actual OS isolation and separate
Service processes. They test inherited locks, paused/killed guardian, orphan and
TERM-resistant descendants, stale initial renewal, parent disconnection, deadline,
workspace/log/output overflow, retained spool adoption, cancellation and auth
gating. CI installs bubblewrap and grants user-namespace permission to its binary
through a narrow AppArmor profile; it does not disable host AppArmor or skip probes.

A separate live CX33 probe exercised the pinned subscription profile with synthetic
input: 57-byte JSON in approximately 3.1 seconds, with confirmed process death.
An invalid synthetic subscription token returned explicit 401 errors with no API
key or provider fallback. Intermediate failures exposed invalid config keys and a
required catalog instruction field; both were fixed before the successful probe.
The final issue completion report records exact revision and verification runs.
Private auth files, transcripts and launch evidence stay outside public Git/CI.
This probe does not establish Russian note quality or G1–G5 acceptance.
