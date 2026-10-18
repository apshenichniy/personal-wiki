# Codex and Apify execution: first-slice contract

**Status:** owner-approved execution policy, 2026-10-18. The supervision, recovery and capacity rules below are the resulting engineering design, not implemented capabilities or new test results.

Decision: [Define Codex and Apify execution lifecycle](https://github.com/apshenichniy/personal-wiki/issues/19). Read with [capture/curation](x-capture-curation.md), [publication](atomic-publication.md), [identity](x-source-identity.md), and the [stack](../research/2026-10-18-stack-spike.md) and [capture pilot](../research/2026-10-18-apify-x-pilot.md) evidence.

## Accepted execution policy

| Bound | Default | Accounting rule |
| --- | --- | --- |
| One Codex launch | 15 minutes | From launch authorization; startup and execution count. A quiet process is not proof of failure, but cannot run past this deadline. |
| One active ingestion job | 30 minutes | Persist `startedAt` and an absolute deadline when first claimed for execution. Initial queue wait is excluded; retries, backoff, restart downtime and later blocked time do not reset or extend the deadline. |
| Codex launches per job | Three total | The original plus at most two additional launches, shared across all reasons. Reserve each launch durably before spawning. |
| Output repair | At most one | Consumes a launch; includes schema, citation and actionable quality-feedback repair. No independent repair loop per document. |
| Transient execution retry | At most one | Consumes a launch; only after the old process tree is confirmed stopped. |
| Stale-base rebuild | At most one | Already agreed in the publication contract; consumes a launch and uses retained captures. |

These allowances do not multiply: original + repair + transient retry exhausts all three launches, leaving no stale rebuild. Original + stale rebuild + repair also exhausts them. Category allowances, total launches, acquisition limits and the job deadline must all permit a next action. A consumed launch is not refunded after an ambiguous spawn or a crash. A failure proven to precede launch authorization consumes no launch.

Retain the five-minute acquisition window and shared USD 0.25/job and USD 5/month Apify limits. New deadlines or queue messages cannot create a fresh quota. Configuration is versioned on the job; agents cannot raise limits. These are initial policy defaults, not measured latency or throughput claims.

Known transient failures may recover automatically within the bounds. Authentication expiry and subscription exhaustion pause the affected stage with an actionable reason. Never switch automatically to a paid API, another account, model or provider. An unknown Apify start outcome prevents a replacement dispatch until resolved; retain its budget reservation.

Deadline expiry stops new acquisition, curation and pre-intent publication. Termination, provider reconciliation, durable-result retrieval and an already recorded publication intent may require additional time. Status must expose that recovery is still pending rather than pretending all effects stopped at the deadline.

## Authority, records and scheduling

Knowledge Service owns durable jobs, attempts, launch reservations, provider operations, budgets, queue scheduling and publication. Runner performs execution through authenticated APIs. Its local supervisor records process identity and a recoverable output spool, but neither owns the library nor replaces service state.

Distinguish four identities:

- **Job:** one accepted save/refresh or explicit recovery request, with a fixed policy and deadline once started.
- **Execution attempt:** a bounded Codex launch under that job, with a reason, input digest, ownership epoch, launch deadline and outcome. It is not a queue delivery count.
- **Provider operation:** one planned Apify start with its input/options digest, reservation and eventual external run/storage IDs.
- **Publication operation:** a proposed changeset and its retained receipt under the separate publication protocol.

Persist checkpoints for prepared-source manifests, validated output, publication operation IDs, external-run IDs, stop requests and reason codes. Mutating Runner requests carry a job ownership epoch and request identity. Reject stale callbacks; retry the same request identity after response loss. Progress text alone cannot advance durable state.

First-slice scheduling is FIFO among eligible jobs, one ingestion pipeline at a time, including acquisition and curation. Blocked jobs do not spin in the queue. Pure status/accounting reconciliation may continue without an agent slot. No second host, parallel Actor fan-out, per-provider agent slot, priority maintenance lane or hidden subagent delegation is part of this slice. Later providers must use the same global execution boundary.

Creation of a durable job and its queue intent must be atomic in service SQL. If the selected queue API cannot participate in that transaction, use a transactional scheduling outbox and an idempotent dispatcher. A crash between job creation and enqueue cannot lose accepted work. Queue acknowledgment follows a durable job outcome/checkpoint; redelivery reads existing state before doing work. An applied publication returns its existing receipt even if acknowledgment was lost.

Effect interruption refunded an attempt in the recorded spike. Therefore product launch/repair/rebuild counters must be independent of queue attempts, and a lost worker is not an intentional cancellation. Queue retries must not resurrect cancelled/expired jobs or acquire additional launch allowance. A periodic service reconciliation finds stranded eligible jobs and pending queue intents without overwriting their counters.

Persist a blocked/retry checkpoint before settling its current queue delivery. Re-enqueue only when an explicit resume or recorded eligible retry is due; do not burn queue attempts in a polling loop. A scheduling generation distinguishes a later authorized delivery from a duplicate old one while preserving the same product job counters.

## Job state and owner-visible outcomes

| State | Meaning and permitted continuation |
| --- | --- |
| `queued` | Durably accepted; initial execution clock has not started. |
| `acquiring` | Bounded provider work and source retention; known run IDs are recoverable. |
| `prepared` | Capture and context manifests are retained and validated for curation. |
| `curating` | One reserved, supervised Codex attempt is active. |
| `validating` | The agent has exited; validate its retained proposal before publication. |
| `publishing` | Service publication operation accepted; inspect its phase/receipt before any retry. |
| `blocked` | Record stage and reason, such as auth, quota, unknown provider start or ownership uncertainty; no automatic fresh allowance. |
| `stopping` | Cancellation/deadline requested; local or remote termination remains unresolved. |
| `succeeded` | An applied publication receipt exists, with any partial-source/processing warnings. |
| `failed` / `expired` / `cancelled` | No further curation/publication is authorized for this job. Keep its evidence, counters and reason. |

Store outcome and cleanup status separately: a publication can succeed while harmless log cleanup remains; unresolved process ownership or remote execution is never harmless cleanup. A terminal job does not erase a provider reservation or stop obligation. Do not use a generic failed state for a publication whose commit intent must still be reconciled.

An authentication/subscription gate prevents new launches for that adapter. Do not open a login UI from headless execution or repeatedly run Codex to test whether the quota reset. An operator can restore access and resume eligible work. A job resumed before its original deadline retains its counters. After expiry/exhaustion, an explicit “retry using retained capture” creates a linked new job and execution budget, with no automatic reacquisition. A fresh capture requires an explicit refresh. The original job/result remains immutable; unresolved provider starts and active source jobs still prevent unsafe duplication.

## Physical one-agent supervision

Use one Runner supervisor on the VPS. It holds an exclusive, non-expiring host lock for its writable/executable lifetime; the service separately grants one fenced job owner. These are complementary: a queue lease does not prove a process died, and a local lock does not authorize publication.

Run production Runner and its descendants in a managed process boundary that cannot escape its cleanup scope. The Linux deployment must kill and reap the old process tree before replacement; use systemd control-group supervision or an equivalent tested arrangement. Any child that can outlive the supervisor must keep the execution lock effective, through verified descriptor inheritance or a lock-owning helper. Another Runner cannot assume ownership merely because a heartbeat, PID or TTL disappeared. The local development supervisor must demonstrate the same no-overlap invariant with its platform-specific process controls.

Before launch, persist the attempt reservation in the service and a local launch intent. Record host/boot identity, supervisor generation, process-group/cgroup identity and process start identity; a numeric PID alone is insufficient. Launch with an explicit argument vector, no shell interpolation of source data. If the spawn/result acknowledgment is lost, inspect the existing process/spool before deciding whether another launch is eligible. Never attach to an unrelated reused PID or use broad process-name killing.

Initial configurable liveness settings: heartbeat every 5 seconds, service lease 30 seconds, begin local fail-closed termination after 15 seconds without an acknowledged renewal. Graceful termination gets 10 seconds, then force termination and 5 seconds to verify cleanup. These timers bound an attempted stop; they do not authorize takeover if the process remains alive. A paused Runner, failed stop, permission error or unkillable descendant leaves the slot blocked. Test actual behavior on macOS and Linux; mathematical timer ordering alone is not fencing.

At attempt completion, persist output and exit evidence, then confirm the process tree is gone before releasing the physical slot. Unexpected death permits at most the one transient retry. Intentional owner cancellation never becomes an automatic retry. Never resume an abandoned interactive CLI session as a hidden fourth launch.

Startup order is: acquire/verify exclusive supervisor ownership; inspect owned surviving processes and stop or reconcile them; register a new service epoch; reconcile publication receipts and known external runs; recover validated outputs/captures; only then claim eligible work. After a service restart, the old token is invalid. A live Runner stops its old attempt on lost ownership and registers anew; the service does not launch a replacement process by itself.

## Apify dispatch and result recovery

Use the Actor adapter in Runner, not a tool available to the curation model. Pin the tested Actor build/options and check the supported price ceiling before paid dispatch. The asynchronous start endpoint returns a run and dataset identity; `timeout`, `restartOnError` and `maxTotalChargeUsd` are documented controls. Set a timeout within the remaining acquisition window, disable automatic restarts, and reserve the run ceiling plus bounded retrieval overhead before dispatch. [Apify Run Actor](https://docs.apify.com/api/v2/actors-runs-post)

The adapter follows these persisted phases:

1. **Reserved:** service records normalized input/options, hash, operation ID, budget reservation and deadline before any POST. A write-ahead local intent closes the gap between service permission and dispatch; a start permit authorizes one outbound POST only, not replay of it.
2. **Dispatching:** record that the request may have been sent. Disable generic SDK/HTTP automatic retries for Actor start. Once delivery is uncertain, use reconciliation, not another POST.
3. **Known run:** persist run ID, actual build, dataset/KV IDs and start time immediately. Poll and retrieve by those exact IDs. Never use an Actor's “last run” as the job identity.
4. **Terminal / retrieving:** retain terminal metadata and stream results/diagnostics in bounded pages. Persist page identity/checksum and resume retrieval without rerunning the Actor. Non-success provider status may still yield usable, explicitly partial data; validate it independently.
5. **Archived / settling:** archive verified bytes through the service and record source completeness. Reconcile final cost separately; early terminal usage can be preliminary. The authenticated run endpoint documents delayed stable cost figures. [Apify Get run](https://docs.apify.com/api/v2/actor-run-get)

The current inspected start contract does not establish a provider-side idempotency guarantee for our request key. Do not infer one from a client operation ID. For a lost start response, query accessible runs around the persisted dispatch interval and compare exact Actor/build/input/options evidence; use a unique correlation value only if its round trip through the selected Actor is verified. Matching URL/time alone, an empty listing, HTTP timeout or a lone similar run is insufficient to prove a unique match or that no run started.

Adopt a run only when ownership/correlation is unambiguous. Otherwise retain `blocked: provider_start_unknown`, reservation and diagnostics for operator resolution. Block further Apify dispatch while an unknown run could still violate the sequential execution/budget policy; unrelated retained-capture work may proceed only after local process safety is established. Do not abort another user's/account job just because it looks similar. The operator may attach verified IDs or record authoritative absence/termination evidence; “retry anyway” must not silently clear liability.

Read-only status/page requests may retry with bounded backoff within their stage deadline. A definitive failed run may receive at most one replacement acquisition run per job, only for a classified transient failure, after termination is confirmed and new shared budget is reserved. No automatic resurrect/reboot or replay of successful runs; empty results are not by themselves transient errors. Additional modes selected by the capture policy are distinct, budgeted operations, not an excuse for unlimited retries.

On acquisition expiry or cancellation, stop launching work and request termination of known runs. An abort response is not proof of terminal state: poll until termination is confirmed; keep accounting/stop obligations if inaccessible. Apify exposes an explicit abort operation, including a graceful option; do not treat it as a refund. [Apify Abort run](https://docs.apify.com/api/v2/actor-run-abort-post)

After the acquisition deadline, recover already completed evidence for retention/accounting without restarting paid work. Curation may use eligible retained partial material while the overall job clock permits, but not while unresolved remote execution threatens the sequential policy. Terminal results that arrive after the overall job deadline cannot trigger automatic new curation.

The pilot hardened run/storage privacy after creation; it did not prove private creation. Production readiness must establish private source/run delivery from creation, or an equivalent approved containment arrangement, before enabling unattended acquisition. Do not expose provider run/storage IDs, tokens or raw diagnostics in public logs or links.

## Codex input, output and capacity

Use a dedicated runtime profile with subscription access, pinned CLI/model/reasoning configuration, trusted skill version and schema version. Record their identities per attempt. Do not inherit an interactive user's MCP servers, hooks, plugins, unrelated skills or fallback credentials. The earlier pilot establishes one successful headless execution, not a verified final model/profile; the real-agent acceptance run must record and validate that deployment manifest.

Runner supplies a retained, revision-pinned context package: complete admitted main material and selected Article body, bounded discussion with relationships, coverage limitations, allowed source/note identities, and relevant existing-note excerpts. Existing-library retrieval is read-only, bounded and attributable. First-slice curation does not need independent browsing or provider access. No recursive agent or hidden additional LLM call may bypass the launch ledger.

The agent receives source text as data, has no canonical Git/SQL write authority, and returns a versioned structured proposed changeset. Storage, publication, Apify and deployment credentials are absent from its environment and inaccessible through the execution boundary; environment filtering alone is insufficient if same-user filesystem/process access would expose them. Establish and test OS/sandbox isolation while retaining only the Codex authentication access needed for that adapter. The service revalidates every proposal regardless of sandboxing.

Initial engineering capacity defaults, configurable and recorded with the job:

| Resource | Ceiling / behavior |
| --- | --- |
| Decoded provider response | 16 MiB per bounded page/record; 64 MiB total per job across runs. Enforce while streaming, after decompression, before parsing. |
| Workspace | 256 MiB per active job, including spools/logs; 8 MiB diagnostic output per attempt. Stream and bound stdout/stderr; retain truncation markers for diagnostics, never silently truncate source/proposal content. |
| Prepared source text | 1 MiB UTF-8 before model context admission; fail with a capacity reason if required main text cannot fit. |
| Model input | 64,000 tokens total including instructions, schema, sources and library context, and within the chosen model's verified window. Reserve 16,000 visible output tokens plus at least 8,000 tokens of additional context headroom; increase the reserve if the model's reasoning/context accounting requires more. |
| Related library context | At most 12 note excerpts and 8,000 tokens, inside the overall input ceiling; record note IDs/revisions and excerpt boundaries. |
| Structured output | 1 MiB UTF-8 and the configured 16,000-token output allowance, within the verified model limits. Overflow/incomplete JSON is not a publishable proposal. |

Token admission must use a verified counter or conservative bound for the configured model; an unvalidated character heuristic is insufficient. Enforce byte limits while streaming and reject a final proposal exceeding its visible-token limit; stop earlier if the adapter can count streamed output reliably. Use a provider output limit only if the pinned CLI actually exposes and honors it. These are input/output acceptance and local resource bounds, not a guarantee about hidden reasoning tokens or provider-side subscription consumption. If safe context admission cannot be established, readiness fails. Admission/capacity failure is distinct from provider truncation or missing source coverage.

Do not silently shorten acquired main material, omit article sections or discard known substantive corrections to fit. Remove duplicate observations and non-content transport fields deterministically; if the required prepared context still exceeds the first-slice single-context capacity, fail with retained evidence. Multi-pass/chunked LLM processing is deferred rather than hiding additional launches. A later explicitly designed partial-discussion path must disclose acquired versus analyzed coverage under the capture contract.

Persist the final output in a bounded, fsynced spool with checksum/exit manifest, transfer it to service-owned durable storage, and record that checkpoint before publication. The spool permits adoption after a lost acknowledgment; it is not a reason to publish an unfinished streamed answer. A zero exit status or valid JSON alone does not establish note quality.

Validation includes schema, permitted mutations, stable identities, complete required sections, capture-pinned inline references, safe URLs, source/claim attribution, and explicit coverage gaps. Deterministic checks establish structure; representative real-agent review establishes semantic fidelity. Repair receives concrete failed checks and retained inputs, uses a new attempt and the shared allowance, then passes the same validation again. Do not weaken checks or fabricate evidence to make repair succeed. Unclassified adapter errors fail with diagnostics rather than being labelled transient indefinitely.

## Cancellation, expiry and recovery precedence

The service serializes cancellation/deadline checks with publication intent. Before intent, set the durable stop flag and fence old Runner writes; stop local/remote work, retain evidence, and finish with a truthful outcome once execution is reconciled. A concurrent late proposal cannot win after that accepted cancellation. After intent, report publication in progress/too late, recover the same operation, and offer the separately authorized latest-batch compensation if desired. Never return “cancelled” followed by a successful publication.

Recovery checks in order: existing publication intent/receipt; cancellation/deadline; physical process ownership; external operation state; retained valid output; prepared capture; only then eligibility for another launch or acquisition. Completion of known publication, retrieval and accounting does not consume another Codex launch. A timed-out/failed process with no complete validated result cannot publish partial output merely because some text was available.

| Failure point | Required result |
| --- | --- |
| Job saved before enqueue acknowledgment | Scheduling outbox/reconciliation delivers the same job. |
| Queue redelivery or service restart | Inspect durable state; counters and deadlines survive. |
| Launch intent persisted, spawn acknowledgment missing | Reconcile process/spool; reservation remains consumed; never assume no child exists. |
| Runner paused, killed or disconnected | Revoke stale ownership; establish old process death before another launch. |
| Codex exits; output upload/ack lost | Recover verified spool/output and resume validation, not curation. |
| Output invalid, attempt crashes, or base becomes stale | Apply the appropriate category allowance and shared three-launch ceiling. |
| Apify POST response lost | Reconcile or block; no blind second start. |
| Provider completed; page download/archiving failed | Resume the same retained run/storage identities within bounded recovery policy. |
| Cancel/deadline races with commit intent | Exactly one pre-intent stop or publication-recovery path; never contradictory terminal claims. |
| Publication applied; queue ack/event lost | Return the stored receipt; no agent/acquisition restart. |

Status/accounting reconciliation uses bounded requests with backoff, at most one sweep per minute initially and a maximum 15-minute interval during prolonged outages; surface the unresolved obligation after the first failed reconciliation window. It may continue beyond a job deadline because it performs no new acquisition/curation. Do not hold an agent process open while waiting for an operator or provider status.

## Required verification and handoff

- Exercise every shared launch-budget combination, duplicate request, cancellation and restart. Verify that queue interruption cannot refund product allowances, and queued waiting does not spend the initial active deadline.
- Test durable enqueue gaps, retained spool adoption, timeouts, output/capacity overflow, malformed structured output, one repair, auth/subscription blocks and no fallback provider call.
- Run two supervisors; pause one past its lease; kill its parent with a TERM-resistant descendant; disconnect service/Runner; restart the host. Observe actual process trees and reject stale writes. No physical overlap is permitted, including during cleanup and failover.
- With a controlled fake provider, drop start responses before/after acceptance, return ambiguous listings, delay cost reporting, interrupt multiple result pages, lose abort responses and cross monthly boundaries. Check reservations, exact IDs, bounded retries and no duplicate start.
- Verify provider request options and actual private-resource behavior with a bounded authorized live acceptance case; the pilot did not prove these recovery paths.
- Run real Codex using the pinned deployment manifest on representative captures, including a long main source and structured repair fixture. Measure time/memory and judge fidelity/citations against the accepted examples. Synthetic tests do not prove semantic quality.
- Integrate cancellation and late/duplicate completion with the publication crash matrix. Verify restart from a pending intent finishes publication without new Codex or Apify work.

Keep private captures, runtime credentials and agent transcripts outside public CI artifacts. These gates feed the first-slice delivery decision. The next access/reader decision defines how the owner submits, sees these states, resumes eligible work and reads the resulting notes; it does not change execution limits implicitly.
