# Bounded Codex execution

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

Only completed, matching output may be adopted. Missing/corrupt evidence does not authorize another launch. Service epoch/restart adoption validates output identity and checksum, completion time and the current epoch before granting a completion lease. It does not authorize a replacement model launch.

## Verified P7 baseline

P7 was completed in [PR #45](https://github.com/apshenichniy/personal-wiki/pull/45), reviewed at `19acdd7f65aa3690190de665ab3c8e78ff18ebfb`. Canonical verification passed 170 tests / 1,079 assertions; focused CX33 process/recovery checks passed 16 tests / 98 assertions. The final real CLI probe returned 57 bytes in approximately 3.6 seconds with reported 924 input / 26 output tokens. A separate invalid-auth probe returned 401 and was classified as `auth`; it did not trigger API fallback. No Apify call was made.

See the [adapter guide](../../apps/runner/src/codex/README.md) and [completion evidence](https://github.com/apshenichniy/personal-wiki/issues/31#issuecomment-6257818455) for boundaries, test commands and private evidence routing. These checks establish process supervision and recovery, not semantic curation quality or full deployment acceptance. P8 owns attributable Russian curation; P11 owns systemd/deployment containment.
