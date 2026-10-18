# Access readiness for the first slice

**Refreshed: 2026-10-18, 20:20–20:25 UTC.** This is the P0 audit for [Prepare unattended execution access](https://github.com/apshenichniy/personal-wiki/issues/24). Existing resource access works. P0 remains open until the remaining R2 credential provisioning requiring owner consent is completed. The application has not been implemented.

## Fresh verification

| Capability | Observed result | Limit of this evidence |
| --- | --- | --- |
| Owner administration of CX33 | Tailscale SSH succeeds as the owner administrator. Pocket ID and Cloudflare Tunnel are active. Approximately 7 GiB available RAM and 61 GiB free disk. | Application capacity still needs measurement. Use Tailscale SSH: a plain SSH alias lacked a local known-host entry; verification was not bypassed. |
| GitHub and Actions | Repository administration/push and Actions access confirmed. The production environment permits main without a reviewer gate. [Fresh access smoke](https://github.com/apshenichniy/personal-wiki/actions/runs/39162481873) passed at 603846ba3ddfb7267dc23b17564b7db18589a59e. | This is an access workflow, not application CI or deployment. |
| Restricted CI identity | wiki-deploy works; root SSH, sudo, runtime-secret reads and the tested disallowed network paths are denied. Zero CI-tagged peers remain after cleanup. | No broader CI permissions were added. See [CI access](ci-access.md). |
| Apify | Existing Actor-scoped credentials read metadata on Mac and VPS. All ten retained Personal Wiki pilot runs are terminal and have reported usage. No other active Actor runs appeared in the listing. | No new capture was launched. Private creation, durable correlation and budget enforcement remain application gates. A shared Actor listing is not a project ledger. |
| Private source R2 | VPS synthetic write/read/list/delete passed; anonymous access was rejected. The retained pilot archive matches its current local archive manifest and SHA-256. Mac/VPS credential copies match and have mode 0600. | This refresh tests the VPS object path; the earlier Mac/VPS cross-read smoke is historical evidence. Staging and backup isolation remain pending. An old throwaway verifier contained an earlier archive hash; the current manifest and both current archives agree. |
| Pocket ID | One enabled administrator, one passkey, zero application clients and zero persistent admin API keys. Verified discovery returns the configured issuer. Owner administrative SSH and the official administrative CLI are available. The encryption key matches its private off-VPS copy. | No new login token was minted and no application login was claimed. Clients and exact local/staging callbacks still need provisioning. |
| Server Codex | Version 0.163.0; ChatGPT login present. A fresh ephemeral read-only headless check returned ACCESS_OK with exit 0, using a clean environment and no API-key fallback. | This verifies subscription execution, not the production profile, curation quality, containment or recovery contract. |
| Mac HTTPS | After the owner enabled VPN, verified TLS requests return 200 for discovery and the expected temporary 404 for wiki. The owner also reports Chrome opens the identity page through VPN. | The direct route had a certificate failure. Keep the working VPN route available during Mac-based execution; the underlying disruption was not independently diagnosed or repaired. |
| Cloudflare administration | The existing owner browser session reaches the correct account, source bucket and R2 token-management controls. The source token is limited to Object Read & Write on its EU bucket. | A browser session is not a durable unattended provisioning credential. No broad account token was created. |

HTTPS checks preserve certificate validation. A default Python user agent initially received HTTP 403 from the VPS; explicit access-check user agents subsequently received valid discovery and the expected wiki response. Verify the eventual HTTP/OIDC client in the real integration.

## Remaining owner-dependent preparation

Prepare these resources before a run expected to finish without credential questions. They are concrete proposals, not resources already created:

| Resource | Intended scope |
| --- | --- |
| Private EU personal-wiki-staging-sources bucket and a dedicated staging credential | Object Read & Write on this bucket only. A separate bucket gives staging an enforceable archive boundary; a prefix alone does not restrict the existing bucket-wide credential. Keep it outside Git/CI and production application access. |
| Private EU personal-wiki-backups bucket and a dedicated backup credential | Object Read & Write on this bucket only. Store separately for the backup/operator component and off-VPS recovery; never expose it to Runner or ordinary deployment. |

Cloudflare administration is available, but these credentials have not been issued. Browser-based creation of persistent credentials requires action-time owner confirmation. Provision them while the owner is available; do not substitute the source credential or a broad R2 administration token. Creating storage access does not implement the backup protocol.

The Mac VPN route is an execution prerequisite while its direct Cloudflare route is affected. No further VPS purchase, Hetzner token, Apify token, Codex account selection or Apple signing access is needed for this slice.

Pocket ID application clients, service identities and the restricted deployment helper remain implementation work under the owner administrative boundary. Use the approved production callback and separate exact local/staging callbacks from the [access contract](../specs/private-reader-access.md). A fresh administrative session may be needed; verify the provisioning path during implementation and keep temporary material private and short-lived. Do not give CI general identity administration.

The owner's first real application sign-in and iPhone/Mac-off acceptance are deferred until the application and callback exist. This audit cannot certify that future browser flow or close owner acceptance G6. Credential expiry/revocation during a later run remains a possible blocker.

## Private accounting and recovery inventory

Private references on the owner's Mac:

- `~/.config/personal-wiki/access-status.json`: refreshed access inventory and remaining actions.
- `~/.config/personal-wiki/evidence/2026-10-18-preflight/`: command results and provider reconciliation, excluded from the public repository.
- `~/.config/personal-wiki/acceptance-campaign-ledger.json`: bootstrap accounting authority until imported through the service/operator interface.
- `~/.config/personal-wiki/recovery/`: private off-VPS destination for the future backup key and credential. The backup key has not been generated.
- `~/.config/personal-wiki/secrets/pocket-id-encryption-key`: existing verified off-VPS identity recovery material.

The ledger has a root-only recovery replica at `/etc/personal-wiki/private/acceptance-campaign-ledger.json` on CX33. It is not another spending allowance or an independently writable authority.

The ten known pilot runs report **USD 0.021634755251652666** in usage, with no unknown liabilities among the recorded project runs. That actual usage counts against October's **USD 5** allowance. The separate first-slice acceptance campaign remains unstarted with its full **USD 2** ceiling and **USD 0.25/job** cap. This audit launched zero Apify runs. Provider-reported usage is not an invoice reconciliation; recheck new operations and uncertain charges before acquisition and preserve accounting through retries and resets.

The recovery location exists outside CX33. It is not a completed encrypted backup or restore rehearsal. Backup key creation, retention and recovery tests remain in the [delivery contract](../specs/delivery-verification.md).

## Scope of this check

The audit read account capabilities, checked existing credentials, ran the existing CI access smoke, executed one synthetic subscription Codex response and round-tripped disposable R2 content. It refreshed private inventory/accounting and documentation. It did not implement the application, start a paid acceptance campaign, issue new credentials, modify public routing or start unattended implementation.
