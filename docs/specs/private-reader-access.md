# Private web reader and access: first-slice contract

**Status:** the owner approved the three-view interface and access policy on 2026-10-18. The controls and acceptance cases below are an engineering design, not implemented authorization or a completed UI.

Decision: [Specify private web access and the minimal reader](https://github.com/apshenichniy/personal-wiki/issues/20). Read with [identity](x-source-identity.md), [capture/curation](x-capture-curation.md), [execution](execution-lifecycle.md), [publication](atomic-publication.md), and the recorded [access readiness](../operations/access-readiness.md).

## Accepted experience

Provide a responsive web interface usable on Mac and iPhone. The Knowledge Service remains the authorization and domain boundary; the web interface consumes its versioned APIs. Presentation packaging is an implementation choice, not a second library authority. Native applications and their offline storage remain deferred.

| View | Content and actions |
| --- | --- |
| Library `/` | Submit an X URL, browse recent notes and search. Show current jobs and freshness/connection state without requiring a separate dashboard. |
| Job `/jobs/{jobId}` | Show the submitted focus, stage, elapsed time, available capture counts, warnings, actionable failure reason and allowed actions. Applied results link to the source note and any separate Article note. |
| Reader `/notes/{noteId}` | Russian reading note, capture dates/limitations, inline citations, related notes and a switch to the retained source text. Preserve stable note URLs across moves and title changes. |

Submission immediately returns a durable job reference, an existing active job, or an existing saved result according to the identity contract. Retain a request ID across response loss or double-clicks. Validate supported X URL forms, including the owner's `fxtwitter.com` links, then normalize to post identity without fetching arbitrary submitted URLs. Reject unsupported hosts, credentials in URLs, unexpected ports and malformed post IDs before any provider dispatch. A safe URL parser and explicit host/path rules are required; string-prefix matching is insufficient.

`Save` does not silently refresh a known source. Offer an explicit refresh action on its saved result; explain that it obtains a new capture. The job response supplies `allowedActions`, so the UI cannot invent retry semantics: resume keeps the job limits, retry with retained capture creates the linked recovery job when permitted, and refresh authorizes new acquisition. Unknown provider starts expose a blocked reason, not a “retry anyway” action. Provider-account repair and ambiguous-run resolution can remain operator procedures.

Use meaningful stages and counts, not fabricated percentages. Distinguish queued, running, blocked, stopping, publishing, succeeded-with-warnings and terminal failure. Before publication intent, cancellation requests stopping; it is not immediately labelled complete. After intent, show that publication is finishing and let recovery resolve it. The UI must faithfully present the execution/publication contracts rather than collapsing every interruption into “failed”.

Refresh automatically while the page is visible: initial engineering defaults are five-second job polling and fifteen-second library revision polling, with bounded backoff on failure. Stop background polling on hidden pages and refresh on foreground/reconnection. SSE can replace polling later without changing correctness. Detect new notes and updated results without Git commands. Keep a reader's position and show an update notice instead of replacing an open note under the owner. Authentication failure stops private polling and clears private in-memory views.

Keep the first interface small: editing, visual graph navigation, native deep-link association, offline web storage and generalized administration are outside this slice. Latest-publication compensation remains the agreed operator action. Accessibility, keyboard navigation, readable mobile typography and explicit loading/empty/error states are part of the three views, not optional additional applications.

## Reading and retained sources

The source switch opens a saved original-language representation, with capture ID/date and coverage, not a fresh scrape. A separate “Open on X” link opens the particular external post/article. Inline citations retain the external URL and capture-pinned identity; their source affordance can navigate to the corresponding retained post. The captured text and the generated reading note must remain visibly distinguishable.

A note can use multiple captures. Show which capture supports each source reference, and retain older evidence when a partial refresh did not reacquire it. Do not label all displayed original text as newly captured or overwrite history with the latest provider response. Display unresolved parents, capped discussion, unavailable Article body and unprocessed media/external links as explicit limitations.

An Article note is linked to the post/discussion note and has its own source identity and body. The original view never substitutes a title or preview for a full body. Render source relationships and author attribution as data; popularity is not a truth or completeness score.

Default library browsing/search exposes active published knowledge. Retained evidence for failed/unpublished jobs is accessible only through authorized job inspection, not masquerading as a published note. A note deactivated by compensation disappears from active lists/search; an authorized direct link may show a retained-history/tombstone explanation instead of reactivating its content. Guests receive the same access response regardless of its existence.

## Search and revision consistency

Use SQLite FTS5 over active note titles/bodies, explicit aliases and retained original-text representations referenced by their current provenance. Historical or unpublished captures without that active association stay outside ordinary search. Return note-oriented results, with the matching representation/language labelled and a safe excerpt. Group multiple source/body hits for the same note rather than flooding the list with duplicate captures. A match in an English original can open its Russian note plus the matching source location; it is not an assertion that the Russian note contains that term.

Start with `unicode61` tokenization and case-insensitive lexical matching. Compile ordinary query terms into an escaped, parameterized all-terms query, rather than exposing raw FTS syntax; punctuation such as quotes must not become executable query operators. Rank title/alias hits above body hits, then original-text hits, with deterministic tie-breaking. Verify Russian words, English technical terms, punctuation and mixed-language fixtures against the pinned SQLite build. FTS5 documents Unicode tokenization and an English-oriented Porter stemmer; this slice promises neither Russian morphology nor arbitrary substring, semantic or cross-language matching. [SQLite FTS5](https://www.sqlite.org/fts5.html)

Search defaults are engineering configuration: at most 512 characters/32 query terms and 20 results per page, with an API maximum of 100. Empty search returns recent notes. Invalid/over-limit input gives a useful validation response. Filter and highlight text safely; no source HTML may enter a search snippet as markup.

Every list/search/note/source response identifies its `appliedRevision`. The service reads one consistent snapshot as specified in the publication contract. Pagination cursors bind query, sort and revision. If a requested old projection cannot be served, return `revision_changed` and restart the query visibly; never silently concatenate pages from different revisions. Associate responses with the current query/navigation generation so late replies cannot replace newer search results.

No offline snapshot/change-stream API is being implemented now. Keep note/capture identities, revision metadata and transport-independent representations reusable so later native replicas can be added without changing knowledge identity. Native search portability and synchronization remain their own validation work.

## Owner sign-in and session policy

Pocket ID authenticates the owner; Knowledge Service authorizes access. Provision one confidential OIDC client for the deployed web application, with the exact callback `https://wiki.alexp.sh/auth/callback`. Use distinct clients and exact callback registrations for local/staging environments. Keep client secrets outside Git and the browser. Pocket ID's app setup describes registering callback URLs and client configuration. [Pocket ID app setup](https://pocket-id.org/docs/setup/connect-an-app)

Use Authorization Code with PKCE S256, server-side code exchange, a short-lived one-use login transaction, `state` and `nonce`. Bind that transaction to the initiating browser and a validated local return destination; never redirect to a user-supplied external URL. Validate discovery against the configured issuer, signature/allowed algorithm, issuer, audience/authorized party, expiry and nonce through a maintained OIDC implementation. Do not implement a bespoke JWT/OIDC verifier. The stable owner key is the configured `(issuer, subject)` pair, not email, display name, group membership or “first person to log in”. Missing owner configuration fails closed. [OIDC validation and identity](https://openid.net/specs/openid-connect-core-1_0.html), [OAuth security guidance](https://www.rfc-editor.org/rfc/rfc9700.html)

The private owner subject is provisioned deliberately from verified Pocket ID account identity; it is not published in this repository. The provider's client-level access restriction is additional defense, not a substitute for the service's owner check. A valid identity belonging to someone else never creates an authorized wiki session.

After successful owner authorization, issue a random opaque session identifier and keep its authoritative record server-side, with only a one-way verifier stored. Use a host-only `Secure`, `HttpOnly`, `SameSite=Lax` cookie scoped to `/` (a `__Host-` name is appropriate). No bearer credentials or private content in localStorage or URLs. Rotate the login session to prevent fixation; expiry is at most 30 days from this sign-in, without silent indefinite extension on activity.

Check session existence, expiry, revocation and current owner authorization on every request before resource lookup or conditional-cache handling. Logout is a CSRF-protected mutation that revokes the current application session and clears local private views. Supply an operator command to revoke all application sessions. Application logout/revocation does not depend on successful Pocket ID logout. Do not promise that disabling a Pocket ID account automatically invalidates a previously issued wiki session without a verified back-channel/invalidation integration; emergency revocation must update the application's own session/owner state too.

Use same-origin requests, a session-bound CSRF token and strict Origin validation for cookie-authenticated mutations. Verify the OIDC callback separately through its login transaction, not by requiring a same-origin header on the cross-site redirect. CORS is closed by default. Trust forwarded scheme/host information only from the configured proxy and validate against the configured public origin. TLS failures are not solved by disabling certificate verification.

## Access responses and capabilities

| Caller / endpoint | Contract |
| --- | --- |
| Unauthenticated private HTML request | Generic HTTP 401 sign-in view; no note title, preview, existence signal or resource-specific metadata. After successful sign-in, return to the validated local destination. |
| Unauthenticated private API/source request | HTTP 401 with a stable generic error; never redirect an API call to HTML or return private fragments. |
| Verified non-owner identity | Generic HTTP 404; do not reveal whether the requested private object exists. |
| Authorized owner, missing object | HTTP 404; authorized tombstone/history information may be shown when actually retained. |
| Owner session | Read/search notes and sources; submit/save/refresh; inspect jobs and request only currently allowed job actions; logout. No arbitrary Markdown/proposal upload or public administration API. |
| Runner service identity | Read bounded library context; claim/renew owned work; record provider/capture checkpoints; transfer job-scoped assets and submit the permitted proposed changeset. Enforce job identity/epoch/scope on every mutation. |
| Operator / deployment identity | Separate local operations. Session revocation, compensation and account repair are not permissions granted to browser code, the curation agent or ordinary CI delivery. |

First-slice Runner authentication may use a separately revocable high-entropy opaque credential over a loopback/private worker endpoint, with its verifier/capabilities retained by the service. Do not reuse the owner's cookie, OIDC ID token, Pocket ID administration token or CI identity. Worker routes are excluded from the public tunnel and still authenticate callers. OIDC human login does not automatically define machine authorization. Later MCP/native clients get their own verified flows rather than receiving this Runner credential.

Reject authenticated callers lacking an endpoint capability with a non-leaking authorization error. Apply authorization to `HEAD`, range/conditional requests, search counts, job progress and source downloads as well as note bodies. Public health/static assets may expose no private state, secrets, account IDs or resource counts. Source URLs, search terms, cookies, tokens and OIDC callback queries must be redacted from ordinary logs.

## Private assets, cache and safe rendering

Use service-mediated authorized asset delivery for the first reader: `/api/v1/assets/{assetId}` resolves a retained manifest after authorization and streams from private R2. Never accept arbitrary bucket keys/URLs from the caller or expose a public R2 hostname. Do not put reusable presigned URLs into page content, notes or API metadata; bearer URLs would weaken the agreed copied-link and revocation behavior. Later large-media delivery may make a separate, explicit expiry trade-off.

Private HTML/API/source responses use `Cache-Control: private, no-store`; configure the proxy/CDN to bypass caching for them, including error and conditional responses. Static application bundles may be cached independently. No service worker/offline cache in this slice. Revalidate authorization on page restoration/foreground and clear private views on logout, including other open tabs when notified; do not treat browser history restoration as an authenticated fetch. Logout prevents new authorized retrieval; it cannot retract a document the owner already downloaded or copied. Reject new requests/stream chunks after detected revocation where practical, without promising to erase bytes already delivered.

Render a defined Markdown subset: headings, paragraphs, lists, blockquotes, tables, links and fenced code. Treat raw HTML as escaped text or remove it through a tested sanitizer; scripts, event handlers, unsafe URLs, embeds, SVG/HTML execution and arbitrary iframes are forbidden. Use a restrictive CSP with no executable source markup, and render syntax highlighting through safe text/AST output. Raw provider HTML/JSON is escaped in the source view or served as an attachment with a safe content type and `nosniff`, never as active same-origin HTML.

External links allow validated HTTP(S) destinations, open with appropriate isolation, and use a no-referrer policy so private note URLs do not leak. Do not auto-load third-party images, trackers, previews or embeds. Unprocessed media remains an explicit link, matching the first-slice capture boundary. These are also server-rendering and search-snippet rules, not just browser UI conventions.

## Versioned API boundary

Keep one authoritative Effect schema/HTTP contract and generate OpenAPI plus JSON Schema/interoperability fixtures where supported. Validate the generated form against actual requests/responses; do not hand-maintain a second divergent schema. Public application transport starts at `/api/v1`; authentication endpoints are separate. Runner operations may share contract types but use a private listener and capability boundary.

The first contract covers submissions, job state/actions, active note lists, lexical search, note detail, capture/representation detail, authorized assets, current applied revision and session/logout. Responses use opaque string IDs, decimal-string X IDs, UTC timestamps, schema version, revision where applicable and machine-readable warnings. A note read model includes source/capture references, inline citation metadata, related note IDs and representations, without exposing private storage paths or provider credentials.

Use structured errors with a stable code, safe message and request ID. Distinguish validation, unauthenticated/forbidden, not-found, idempotency conflict, revision-changed, stale proposal and temporarily unavailable. Preserve generic access responses before inspecting private object existence. A lost mutation response reuses its operation key; a changed payload under the same key is a conflict. Cookie-authenticated pages and Runner code call the same domain operations without duplicating storage rules.

Do not expose SQLite tables, mutable Git paths, internal phases as ad hoc strings, or provider datasets as the client API. Later additive fields remain compatible; breaking semantic changes require a versioned migration. Tests must show unknown optional fields do not break supported clients. A future SwiftUI client can reuse these read/job identities and schemas while implementing its own OAuth, navigation and offline replica contracts.

## Acceptance cases and readiness

- On Mac and iPhone, submit an X URL, see its durable job, navigate away/back, and reach the resulting one/two notes after automatic refresh; a lost response or double-click creates no duplicate job/publication.
- Switch between a Russian note and its retained original. Inline citations open the exact supporting post; old-capture references still display their original dates after refresh.
- Search a Russian note term and an English term present only in retained original text. Both find the appropriate active note with correctly labelled context; malformed query syntax cannot escape the query compiler.
- Change the applied revision between pages or during a note/source fetch; return one coherent revision or the explicit revision-change path, never mixed content.
- Test real Pocket ID login, safe return navigation, expiry, logout and revocation. Test wrong issuer/audience/nonce, replayed callback/state, code/PKCE failure, missing owner configuration and a non-owner identity with controlled OIDC fixtures; use real integration for the valid path.
- Request known and unknown note/job/source/asset URLs anonymously, with another identity, after revocation and through conditional/HEAD/range paths. No private title/content/count or existence-dependent response escapes. Worker and operator endpoints remain inaccessible from the public route and owner cookie alone.
- Verify malicious Markdown, HTML, links, snippets, redirects and source URLs stay inert; ordinary citations and code blocks still work. Confirm private responses are not served from proxy/browser caches after logout and no third-party assets load automatically.
- Recheck the recorded Mac HTTPS/certificate problem before browser acceptance; successful VPS requests or iPhone login alone are not proof it is fixed. Exercise the actual OIDC client, cookies, proxy configuration and asset authorization on CX33.

The recorded Pocket ID/passkey and R2 access smoke tests establish prepared infrastructure only. Application clients, sessions, access controls and the reader still need implementation. Delivery gates consolidate these cases with execution/publication fault tests and the owner-reviewed note-quality baseline.
