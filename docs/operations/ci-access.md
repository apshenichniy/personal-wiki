# Production CI access

The original access-smoke workflow verifies infrastructure access. The separate verified-release workflow now adds narrowly scoped application deployment; see [the release runbook](releases.md).

GitHub Actions joins the existing tailnet through Tailscale workload identity federation. No permanent Tailscale API secret or SSH private key is stored in GitHub.

## Trust boundary

- Issuer: `https://token.actions.githubusercontent.com`.
- Subject: `repo:apshenichniy@34074932/personal-wiki@1424641109:environment:production`.
- Required claims: repository ID `1424641109`, ref `refs/heads/main`.
- GitHub environment: `production`, with only the `main` branch allowed.
- OIDC scopes: writable `auth_keys` and `devices:core`, limited to `tag:personal-wiki-ci`.
- Ephemeral CI nodes receive only `tag:personal-wiki-ci`. Their network grant permits TCP 22 to `tag:dock-cx33`; their Tailscale SSH rule accepts only `wiki-deploy`.
- `wiki-deploy` has no sudo, Docker-group membership, or access to runtime credentials. Application install/status/resume/rollback operations use the root-owned, fixed-target Unix-socket controller; there is no general privileged command interface.

Environment variables: `TS_OIDC_CLIENT_ID`, `TS_OIDC_AUDIENCE`, `CI_VPS_HOST`, and `CI_DENIED_PEER`. These are connection metadata, not bearer credentials. The last variable identifies an owner device used for one negative reachability probe.

The owner retains separate administrative access. The existing Telegram MCP and Cloudflare Tunnel are outside this workflow's control. The trust applies to qualifying workflows in this repository/environment, not to a single workflow filename; protect review and write access to `main` accordingly.

## Access check

Run the manual **Verify production access** workflow on `main`:

```sh
gh workflow run access-smoke.yml --ref main
```

The workflow checks the remote UID/groups, denies sudo and runtime-secret reads, requires an explicit root SSH denial, and checks that selected disallowed network endpoints are unreachable. Reachability failures alone are not proof of ACL enforcement: the Tailscale policy additionally contains accept/deny tests for these targets. The action logs out and removes its ephemeral node during cleanup; verify removal in the tailnet after the first run or after an interrupted run.

It does not check out project code, deploy an artifact, alter services, invoke Codex, or run Apify. The action is pinned by commit and the Tailscale client by version. The separate `release.yml` workflow preserves this authentication boundary and invokes the scoped controller for verified artifact installation. This smoke workflow remains independent of application deployment.

Reference: [official Tailscale GitHub Action](https://github.com/tailscale/github-action).

## Verification record

The P0 refresh on 2026-10-18 reran the existing workflow: [run 39162481873](https://github.com/apshenichniy/personal-wiki/actions/runs/39162481873) passed at `603846ba3ddfb7267dc23b17564b7db18589a59e`. All positive and negative checks passed; a subsequent server-side inspection found zero CI-tagged peers. This rerun made no application or access-policy changes.

On 2026-10-18, [run 39156005912](https://github.com/apshenichniy/personal-wiki/actions/runs/39156005912) passed all checks at commit `0d6a7aebbaee1a0983ae651a7bc92b41a972acfa`. A subsequent server-side tailnet inspection found zero remaining `wiki-ci-*` peers. The owner's administrative SSH access and existing services remained operational.

The first attempt exposed GitHub's subject format containing numeric owner and repository IDs. The trust now matches the observed subject above; no wildcard or broader claim was introduced. A second check adjustment added recognition of Tailscale's SSH denial wording.
