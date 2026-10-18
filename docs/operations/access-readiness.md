# Access readiness for the first slice

**P0 completed: 2026-10-18, 20:28 UTC.** This records [Prepare unattended execution access](https://github.com/apshenichniy/personal-wiki/issues/24). Existing access and the new isolated R2 credentials are verified. No owner-dependent access-preparation step remains. The application, its authentication/deployment integrations and owner acceptance are still to be implemented and verified.

## Fresh verification

| Capability | Observed result | Limit of this evidence |
| --- | --- | --- |
| Owner administration of CX33 | Tailscale SSH succeeds as the owner administrator. Pocket ID and Cloudflare Tunnel are active. Approximately 7 GiB available RAM and 61 GiB free disk. | Application capacity still needs measurement. Use Tailscale SSH: a plain SSH alias lacked a local known-host entry; verification was not bypassed. |
| GitHub and Actions | Repository administration/push and Actions access confirmed. The production environment permits main without a reviewer gate. [Fresh access smoke](https://github.com/apshenichniy/personal-wiki/actions/runs/39162481873) passed at 603846ba3ddfb7267dc23b17564b7db18589a59e. | This is an access workflow, not application CI or deployment. |
| Restricted CI identity | wiki-deploy works; root SSH, sudo, runtime-secret reads and the tested disallowed network paths are denied. Zero CI-tagged peers remain after cleanup. | No broader CI permissions were added. See [CI access](ci-access.md). |
| Apify | Existing Actor-scoped credentials read metadata on Mac and VPS. All ten retained Personal Wiki pilot runs are terminal and have reported usage. No other active Actor runs appeared in the listing. | No new capture was launched. Private creation, durable correlation and budget enforcement remain application gates. A shared Actor listing is not a project ledger. |
| Private R2 storage | Fresh Mac/VPS cross-read, write/list/delete and anonymous-denial checks pass for source, staging and backup buckets. All 18 directed cross-bucket read/write/list probes return 403 AccessDenied. The retained source archive matches its current local manifest. | Credential isolation is verified; service credential injection, encrypted backups and restore remain implementation work. |
| Pocket ID | One enabled administrator, one passkey, zero application clients and zero persistent admin API keys. Verified discovery returns the configured issuer. Owner administrative SSH and the official administrative CLI are available. The encryption key matches its private off-VPS copy. | No new login token was minted and no application login was claimed. Clients and exact local/staging callbacks still need provisioning. |
| Server Codex | Version 0.163.0; ChatGPT login present. A fresh ephemeral read-only headless check returned ACCESS_OK with exit 0, using a clean environment and no API-key fallback. | This verifies subscription execution, not the production profile, curation quality, containment or recovery contract. |
| Mac HTTPS | After the owner enabled VPN, verified TLS requests return 200 for discovery and the expected temporary 404 for wiki. The owner also reports Chrome opens the identity page through VPN. | The direct route had a certificate failure. Keep the working VPN route available during Mac-based execution; the underlying disruption was not independently diagnosed or repaired. |
| Cloudflare administration | Owner-confirmed staging and backup account tokens are active, each limited to Object Read & Write on its specified EU bucket. The existing source token remains separate. | Object credentials do not administer buckets or DNS. No broad account credential was added; future account-level changes may need owner involvement. |

HTTPS checks preserve certificate validation. A default Python user agent initially received HTTP 403 from the VPS; explicit access-check user agents subsequently received valid discovery and the expected wiki response. Verify the eventual HTTP/OIDC client in the real integration.

## Completed staging and backup access

Both buckets use EU jurisdiction and Standard storage. Public access is disabled. The owner confirmed the exact permissions, indefinite validity and private Mac/VPS storage immediately before token creation.

| Resource | Verified scope |
| --- | --- |
| `personal-wiki-staging-sources` / `personal-wiki-staging-storage` | Object Read & Write on this bucket only, including deletion of its objects. Source and backup buckets reject this credential. |
| `personal-wiki-backups` / `personal-wiki-backup-storage` | Object Read & Write on this bucket only, including deletion of its objects. Source and staging buckets reject this credential. |

The source credential also receives access denial for both new buckets. Checks used unique synthetic objects under one disposable `_provision-check/` prefix in each bucket: Mac wrote, VPS read and wrote, Mac read and deleted. All three test prefixes were verified empty afterward. Anonymous object requests were rejected. No captured material or paid Apify acquisition was used.

| Credential | Private Mac location | Private VPS location |
| --- | --- | --- |
| Staging | `~/.config/personal-wiki/secrets/r2-staging.json` | `/etc/personal-wiki/staging/r2.json` |
| Backup / recovery | `~/.config/personal-wiki/recovery/r2-backups.json` | `/etc/personal-wiki/backup/r2.json` |

Files have mode `0600`; VPS parent directories are `0700`, owned by root. Byte checks confirm matching off-VPS copies. Both `wiki-deploy` and `wiki-runner` were explicitly denied reads of both new credentials. Implementation must inject staging credentials only into the appropriate isolated service and reserve backup access for the backup/operator component. Credentials are not in Git, GitHub secrets or public CI artifacts. These prepared buckets are not an implemented backup protocol or an immutable/WORM backup.

## Execution conditions and deferred application work

The Mac VPN route is an execution prerequisite while its direct Cloudflare route is affected. No further VPS purchase, Hetzner token, Apify token, Codex account selection or Apple signing access is needed for this slice.

Pocket ID application clients, service identities and the restricted deployment helper remain implementation work under the owner administrative boundary. Use the approved production callback and separate exact local/staging callbacks from the [access contract](../specs/private-reader-access.md). A fresh administrative session may be needed; verify the provisioning path during implementation and keep temporary material private and short-lived. Do not give CI general identity administration.

The owner's first real application sign-in and iPhone/Mac-off acceptance are deferred until the application and callback exist. This audit cannot certify that future browser flow or close owner acceptance G6. Credential expiry/revocation during a later run remains a possible blocker.

## Private accounting and recovery inventory

Private references on the owner's Mac:

- `~/.config/personal-wiki/access-status.json`: refreshed access inventory and remaining actions.
- `~/.config/personal-wiki/evidence/2026-10-18-preflight/`: command results and provider reconciliation, excluded from the public repository.
- `~/.config/personal-wiki/evidence/2026-10-18-r2-isolation/`: three cross-platform check results, 18 denial probes, file-protection checks and exact private command arguments/helper checksum.
- `~/.config/personal-wiki/acceptance-campaign-ledger.json`: bootstrap accounting authority until imported through the service/operator interface.
- `~/.config/personal-wiki/recovery/`: private off-VPS recovery inventory, now containing the verified backup-bucket credential. The backup encryption key has not been generated.
- `~/.config/personal-wiki/secrets/pocket-id-encryption-key`: existing verified off-VPS identity recovery material.

The ledger has a root-only recovery replica at `/etc/personal-wiki/private/acceptance-campaign-ledger.json` on CX33. It is not another spending allowance or an independently writable authority.

The ten known pilot runs report **USD 0.021634755251652666** in usage, with no unknown liabilities among the recorded project runs. That actual usage counts against October's **USD 5** allowance. The separate first-slice acceptance campaign remains unstarted with its full **USD 2** ceiling and **USD 0.25/job** cap. This audit launched zero Apify runs. Provider-reported usage is not an invoice reconciliation; recheck new operations and uncertain charges before acquisition and preserve accounting through retries and resets.

The recovery location exists outside CX33. It is not a completed encrypted backup or restore rehearsal. Backup key creation, retention and recovery tests remain in the [delivery contract](../specs/delivery-verification.md).

## Scope of this check

The audit checked account capabilities and existing credentials, ran the CI access smoke and one synthetic subscription Codex response, then provisioned the two owner-confirmed R2 buckets/credentials and verified their isolation. It refreshed private inventory/accounting and documentation. Application implementation, paid acquisition, public routing changes and an unattended implementation run were not started.
