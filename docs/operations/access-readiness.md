# Access readiness for the first slice

**Checked: 2026-10-18.** This records infrastructure preparation. The application, deployment/rollback mechanism, and final client authentication contracts are not implemented.

| Resource | Prepared and checked | Remaining application work |
| --- | --- | --- |
| Existing CX33 | Owner administration over Tailscale; existing Telegram MCP and Cloudflare Tunnel preserved. | Service packaging, resource limits, backups and restore tests. |
| Apify | Dedicated Actor-scoped token stored privately on Mac and VPS; authenticated metadata/run listing works. Live capture evidence belongs to the capture pilot. | Durable external-run reconciliation and enforcement of the [accepted capture policy and budgets](../specs/x-capture-curation.md). |
| Private R2 | EU bucket, bucket-scoped object read/write credential. Mac/VPS cross-read, checksum, list and cleanup smoke passed. Anonymous object access returns an authorization error. | Asset manifests, retention, backup policy and application permissions. |
| HTTPS routes | Identity provider reachable through the existing tunnel; wiki endpoint returns a temporary 404. Existing Telegram endpoint remains protected. | Connect the validated application upstream after deployment. |
| Pocket ID | Pinned 2.18.0 binary, loopback-only listener, hardened systemd service; one owner and one registered passkey verified. Initial setup closed. Encryption key backed up privately. | Implement and verify the agreed [OIDC client, callback, session and authorization contract](../specs/private-reader-access.md). No application client has been provisioned by this planning decision. |
| Server Codex | Pinned 0.163.0 official package; isolated `wiki-runner` account; subscription login and an actual headless, read-only execution succeeded. | Supervision, cancellation, sandbox policy, structured proposals and credential isolation. |
| GitHub Actions | OIDC federation, main/production restrictions, ephemeral CI node and unprivileged SSH verified. See [CI access](ci-access.md). | Narrow artifact installation/restart helper, deployment gates and rollback. |

Runtime secrets are outside Git, in owner-only local configuration and root-only VPS configuration. Codex authentication is owned by `wiki-runner`; `wiki-deploy` cannot read it. Do not give CI the runtime credentials to work around this separation.

The owner-side access inventory is under `~/.config/personal-wiki/`; it records private paths and verification results. It is not part of this public repository. Subsequent provisioning must inspect that inventory without printing credential values.

Pocket ID clients were intentionally deferred until the callback and authorization design was agreed. That design is now recorded in the access contract; provisioning and end-to-end verification still remain. Existing owner administrative access can provision clients later; no permanent Pocket ID administration token was created for convenience.

A Mac-specific HTTPS path issue was observed: the identity URL received an unrelated certificate locally while HTTPS validation from the VPS and owner sign-in on the iPhone succeeded. No TLS verification was disabled. Local browser access needs rechecking before browser acceptance tests; successful server checks do not resolve that network issue.

Native Apple signing/TestFlight access and browser capture are outside this first access-preparation batch. Application implementation starts only after the specification and implementation scope are agreed.
