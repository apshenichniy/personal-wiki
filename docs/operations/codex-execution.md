# Bounded Codex execution (P7 in progress)

The product executor is a pinned Linux subscription CLI. Local macOS checks exercise the same guardian's process faults and a real filesystem sandbox probe; direct macOS Codex execution is currently disabled. Codex 0.163.0 requires managed-preferences synchronization on macOS, which has not passed the restricted execution profile. Do not broaden access to the owner's preferences to bypass that gate. Linux execution on CX33 has passed a small synthetic real-model check. This is not semantic note-quality or full delivery acceptance.

## Isolation and ownership

`tools/runtime/agent-guard.py` owns the host-wide flock and a durable active marker. All namespaces/providers must use the same slot directory. It persists intent before spawn and process/boot identity after spawn; an ambiguous spawn or guardian death leaves the marker blocking replacement. A complete exit certificate permits recovery after an interrupted marker deletion; a host reboot also proves that the prior local tree cannot survive. Unresolved same-boot markers need explicit physical reconciliation, never a TTL-based deletion.

The guardian receives explicit argv, a small environment allowlist, bounded stdin, an absolute execution deadline and acknowledged-lease heartbeats over a private pipe. Parent disconnection or missing heartbeats starts termination. TERM receives ten seconds, KILL another five; a nonempty process boundary remains blocked. Successful leader exit also triggers descendant cleanup. Linux subreaping verifies orphan cleanup, and the deployed bubblewrap PID namespace prevents descendants escaping through another session/process group. A paused guardian retains both flock and durable exclusion.

On Linux, bubblewrap exposes runtime libraries, one trusted executable, this attempt's workspace and an auth-only Codex home. Host process namespaces and the Service's filesystem are absent. Runner still needs systemd cgroup lifecycle supervision in deployment. The macOS probe denies out-of-root file contents and process forking, while permitting directory traversal needed by dyld; it is not evidence that the actual CLI works there.

## Capacity and results

The pinned profile in `apps/runner/src/codex/profile.ts` uses Codex 0.163.0, `gpt-5.6-sol`, medium reasoning and `o200k_base` via `js-tiktoken@1.0.21`. The official pinned tiktoken mapping assigns the `gpt-5` prefix to that encoding. The authenticated model catalog reported a 272,000-token window. These are tested deployment choices, not an assertion about a newer model's tokenizer.

Admission counts all supplied prompt/instructions/schema text and an 8,192-token reserve for CLI protocol context, within 64,000 total input tokens, with 16,000 visible output tokens and 8,000 additional headroom. Related excerpts have their separate 12-note/8,000-token limit. Special-token-looking source strings are encoded as ordinary text. Complete output is independently counted; malformed or oversized JSON is rejected. Hidden reasoning is not presented as locally enforceable.

The dedicated profile disables user configuration, rules, shell tools, multi-agent execution, goals, browsing, apps, plugins, hooks and skill discovery. Trusted instructions and schema are explicit files and hashes. Authentication is restricted to ChatGPT subscription credentials; API-key fallback is rejected. The binary digest, CLI/model/reasoning, skill/instruction hash, schema hash and input admission are retained per attempt.

A FIFO transfers the final response to the guardian, which bounds bytes while reading and fsyncs an immutable output plus exit/checksum manifest after process death. Diagnostics are separately limited to 8 MiB; exceeding them terminates execution with a marker. Workspace usage is checked while the process runs, with a 256 MiB job limit and a 16 MiB per-file limit for CLI caches. The latter is not the response limit: the response FIFO remains capped at 1 MiB. A 1 MiB limit on every file was rejected by a real preflight because Codex's internal SQLite WAL needs more space.

Only completed, matching output may be adopted. Missing/corrupt evidence does not authorize another launch. Service epoch/restart adoption integration and the full P7 fault matrix remain in progress.

## Current verification

- `mise exec -- bun test tests/agent-guard.test.ts tests/codex-sandbox.test.ts tests/codex-profile.test.ts` uses synthetic data and no paid/model provider.
- macOS initial canonical check: 157 tests, 998 assertions, ten tasks passed. Linux CX33 focused checks: seven tests, 46 assertions passed as `wiki-runner`, including actual bubblewrap denial of a same-user file outside mounted roots.
- Separate Linux live check: a Service-authorized synthetic attempt returned 57 bytes in approximately 3.7 seconds, with process death and durable output confirmed. Reported model usage: 5,432 input tokens, 26 visible output tokens, below the admitted input bound of 8,280. The synthetic job was settled without publishing a note. Credentials and full evidence remain in the private operator inventory.
- Earlier macOS startup failures are retained separately and are not represented as successful model execution. No Apify call was made by these checks.

Before completing P7, implement/test Service restart adoption, paused supervisor and output/timeout boundaries, no-auth/no-fallback execution, and full two-axis review. P8 owns attributable Russian curation and semantic quality.
