# Owner access and revocation

The Knowledge Service has two loopback listeners sharing the same library and job runtime. `PORT` (default 3000) retains machine authentication and the fenced worker/operator protocol. `WIKI_PUBLIC_PORT` (default 3001) serves only the owner reader API and OIDC endpoints. The public listener is absent unless `WIKI_OWNER_ACCESS_FILE` names a valid private configuration file. Missing owner identity never enables registration or a test login.

The Cloudflare Tunnel must target **only the owner listener**, with its exact configured public `Host` header. It must never forward to the machine listener. Forwarded host/protocol headers, when present, must match the configured HTTPS origin; callbacks and redirects are constructed from configuration rather than those headers. Both listeners bind `127.0.0.1`. The production routing rehearsal belongs to P11/P13.

## Provisioning

Create distinct confidential Pocket ID clients for production and staging/local integration. Restrict each client to the owner's verified Pocket ID account and register its exact HTTPS callback, without wildcards. Production uses `https://wiki.alexp.sh/auth/callback`; staging/local hosts and client registrations must be separately recorded in private operator configuration. Local integration needs real HTTPS (for example an isolated tunnel); the implementation does not disable TLS or secure cookies for development.

The configuration file must be an absolute, regular file with no group/other permissions or final symlink. It contains:

```json
{
  "publicOrigin": "https://wiki.example.test",
  "issuer": "https://id.example.test",
  "ownerSubject": "deliberately-verified-stable-subject",
  "clientId": "environment-specific-client",
  "clientSecret": "private-client-secret",
  "signingAlgorithm": "RS256"
}
```

Use the exact issuer from verified discovery and the exact stable owner `sub`; neither email nor the first successful login grants access. Select the signing algorithm actually registered by the provider (`RS256` or `ES256`). Keep the configuration outside Git, CI artifacts and Runner mounts. No environment flag enables arbitrary test identities or insecure provider transport.

`openid-client@6.8.8` handles discovery, code exchange, PKCE S256, state, nonce and ID-token validation. Signature verification is explicitly enabled with `enableNonRepudiationChecks`; relying only on TLS token delivery would not satisfy this contract. The adapter requests only `openid`, discards provider tokens after identity verification and grants an independent application session. See the [maintainer's OIDC example](https://github.com/panva/openid-client/blob/v6.8.8/examples/oidc.ts).

## Sessions and requests

- `/auth/login` creates a ten-minute, one-use login transaction bound to a secure browser cookie. The return destination is limited to the local library, note and job views. The transaction is consumed atomically before token exchange. Pending transactions are bounded at 128.
- `/auth/callback` exchanges the code and verifies the configured owner. Invalid responses return generic 401; a correctly verified non-owner returns generic 404 and receives no owner session.
- The owner session cookie is `__Host-wiki-session`, `Secure`, `HttpOnly`, `SameSite=Lax`, host-only and scoped to `/`. SQLite stores its SHA-256 verifier, owner binding and absolute expiry, never the raw cookie. Expiry is 30 days from sign-in and does not extend with use. A fresh login replaces the browser's previous session.
- `/api/v1/session` returns expiry and a session-bound CSRF token, without owner account identifiers. Cookie-authenticated POSTs require both the exact `Origin` and `X-CSRF-Token`. Browser bearer credentials are not supported.
- `/api/v1/session/logout` requires that same verification, deletes the session and expires its cookie. Reader code must clear private views across tabs and on foreground/authentication failure (P10).

All owner responses, including validation errors, redirects, denied requests and missing objects, have `Cache-Control: private, no-store`, `nosniff`, no-referrer and a restrictive CSP. Configure the tunnel/CDN to bypass private caching too. Ordinary request logging is disabled so callback queries, source URLs, search terms and cookies are not logged.

Reader API contracts reuse the existing library and job endpoint schemas but exclude worker/operator routes from the public router. `packages/contracts/generated/reader-openapi.json` is generated from this subset. A valid owner session does not authorize arbitrary publication, credential revocation, compensation or provider configuration. Known and unknown private resources are checked for authentication before lookup, including HEAD, conditional and range requests.

## Retained assets

`GET /api/v1/assets/{assetId}` resolves only a retained manifest belonging to a published capture or retained job evidence. The library reads the pinned local normalized object or private R2 provider object and verifies its size/checksum. Callers supply an opaque ID, never an object key or URL. Downloads are inert `application/octet-stream` attachments; storage paths, signed URLs and provider HTML are not exposed as executable same-origin content.

The first slice's maximum retained raw page is 16 MiB. Asset responses buffer and verify those bounded bytes before sending them and recheck the session after the archive read, so a revocation during that fetch prevents delivery. Ranges are not supported. Revocation cannot retract bytes already delivered to an authorized client. Larger streaming-media policy is deferred with those processors.

## Emergency revocation

Run as the trusted library operator on the host, using the service's existing private database:

```sh
mise exec -- bun tools/revoke-owner-sessions.ts /absolute/private/library/library.sqlite
```

This operation deletes all owner sessions and pending login transactions and advances an authentication epoch. A callback already exchanging its code before revocation cannot create a session afterward. It does not need Pocket ID availability or its client secret, run migrations, claim the publisher lock, or restart the service. It is deliberately absent from public and Runner APIs. The database directory must be private and the database may not be a symlink or writable by other users.

Disabling a Pocket ID account alone does **not** invalidate existing application sessions: use this command and update/remove the configured owner identity as needed. Signing in again is permitted if the configured owner remains enabled; revocation is not an account ban. Backups restored with session tables require revocation before exposure (P12).

## Verification boundary

`mise exec -- bun test tests/owner-access.test.ts` exercises the real OIDC client against a controlled signing provider, the actual owner router/domain runtime and SQLite/Git. It covers wrong discovery issuer, issuer/audience/authorized-party/nonce/signature/expiry, failed PKCE, missing ID token, non-owner rejection, consumed/expired login transactions, secure cookies, session rotation/expiry, CSRF/origin checks, unknown routes, private asset retrieval, worker isolation, callback/download revocation races and the separate operator command. The fixture's in-process transport is test code, not a deployed login bypass.

Real Pocket ID client provisioning, browser HTTPS/cookie evidence and private R2 retrieval through the deployed owner route remain separate integration requirements. A passing controlled-provider test does not close P9 or establish the deployed G4/G5 gates.
