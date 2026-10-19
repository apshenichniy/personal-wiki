import assert from "node:assert/strict";
import { Console, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ReaderApi } from "@personal-wiki/contracts/reader-api";
import { jobRuntime } from "../../apps/knowledge-service/src/jobs/runtime.ts";
import { Library } from "../../apps/knowledge-service/src/storage/library.ts";
import { Jobs } from "../../apps/knowledge-service/src/jobs/service.ts";
import { JobLifecycle } from "../../apps/knowledge-service/src/jobs/lifecycle.ts";
import {
  OwnerSessions,
  makeOwnerSessions,
  sessionCookie,
  loginCookie,
  cookieValue,
  localReturn,
} from "../../apps/knowledge-service/src/access/sessions.ts";
import { digest } from "../../apps/knowledge-service/src/storage/io.ts";
import { discoverOwnerProvider } from "../../apps/knowledge-service/src/access/oidc.ts";
import { validateConfiguration } from "../../apps/knowledge-service/src/access/config.ts";
import { ownerHandler } from "../../apps/knowledge-service/src/access/server.ts";
import { ownerSettings, ownerProviderFixture, type InvalidIdentity } from "./owner-provider.ts";
import { prepareSource, postSource } from "./source.ts";
const root = process.env.WIKI_DATA_DIR;
if (!root) throw new Error("Synthetic root required");
const peer = await ownerProviderFixture();
const provider = await discoverOwnerProvider(ownerSettings, peer.transport);
const rawBytes = Buffer.from('{"synthetic":"private retained provider source"}');
let rawReads = 0;
let onRead = async () => {};
const Runtime = OwnerSessions.layer(ownerSettings, provider).pipe(
  Layer.provideMerge(
    jobRuntime(root, {
      path: `${root}/synthetic-accounting.sqlite`,
      namespace: "staging",
      archive: {
        read: () =>
          Effect.promise(async () => {
            rawReads++;
            await onRead();
            return rawBytes;
          }),
        retain: () => Effect.void,
        assertPrivate: () => Effect.void,
      },
    }),
  ),
);
const program = Effect.gen(function* () {
  const sessions = yield* OwnerSessions;
  const library = yield* Library;
  const sql = yield* SqlClient.SqlClient;
  const context = yield* Effect.context<OwnerSessions | Library | Jobs | JobLifecycle>();
  const jobs = yield* Jobs;
  const app = ownerHandler(context);
  yield* Effect.addFinalizer(() => Effect.promise(app.dispose));
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.handler(request) }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  );
  const request = (path: string, init: RequestInit = {}) =>
    Effect.tryPromise(() =>
      app.handler(
        new Request(new URL(path, ownerSettings.publicOrigin), {
          ...init,
          headers: { host: "wiki.example.test", ...Object.fromEntries(new Headers(init.headers)) },
        }),
      ),
    );
  const begin = () =>
    Effect.gen(function* () {
      const result = yield* request(
        "/auth/login?returnTo=%2Fnotes%2F00000000-0000-4000-8000-000000000001",
      );
      assert.equal(result.status, 302);
      const browser = cookieValue(result.headers.get("set-cookie") ?? "", loginCookie)!;
      assert(browser);
      assert.match(result.headers.get("set-cookie")!, /Secure; HttpOnly; SameSite=Lax/);
      return { browser, authorization: result.headers.get("location")! };
    });
  const finish = (
    login: { browser: string; authorization: string },
    invalid?: InvalidIdentity,
    old?: string,
  ) =>
    request(peer.callback(login.authorization, invalid).href, {
      headers: {
        cookie: `${loginCookie}=${login.browser}${old ? `; ${sessionCookie}=${old}` : ""}`,
      },
    });
  const login = () =>
    Effect.gen(function* () {
      const response = yield* finish(yield* begin());
      assert.equal(response.status, 302, yield* Effect.promise(() => response.clone().text()));
      assert.equal(response.headers.get("location"), "/notes/00000000-0000-4000-8000-000000000001");
      const token = cookieValue(response.headers.get("set-cookie") ?? "", sessionCookie)!;
      const principal = yield* sessions.authenticate(token);
      return { token, principal, cookie: `${sessionCookie}=${token}` };
    });
  const fixture = yield* Effect.tryPromise(() =>
    prepareSource(
      {
        knowledge: {
          reserve: ({ payload }) => library.reserve(payload),
          list: () => library.list(),
          upload: ({ payload }) => library.upload(payload),
        },
      },
      [postSource("12345")],
    ),
  );
  yield* library.publish(fixture.proposal);
  const noteId = fixture.draft.slots[0]!.noteId;
  const assetId = fixture.draft.slots[0]!.assetId;
  const rawJob = yield* jobs.submit({
    requestId: crypto.randomUUID(),
    mode: "save",
    url: "https://x.com/test/status/54321",
  });
  assert(rawJob.job);
  const rawAssetId = crypto.randomUUID();
  yield* library.registerRaw(rawJob.job.jobId, {
    schemaVersion: 1,
    assetId: rawAssetId,
    objectKey: `providers/staging/${rawJob.job.jobId}/${rawAssetId}.json`,
    sha256: digest(rawBytes),
    byteLength: rawBytes.length,
    mediaType: "application/json",
  });
  for (const path of [
    `/api/v1/notes/${noteId}`,
    `/api/v1/notes/${crypto.randomUUID()}`,
    `/api/v1/assets/${assetId}`,
    `/api/v1/assets/${crypto.randomUUID()}`,
    "/api/v1/jobs/unknown",
    "/internal/v1/jobs/claim",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = yield* request(path, {
        method,
        headers: { range: "bytes=0-10", "if-none-match": "*" },
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert(!(yield* Effect.promise(() => response.text())).includes("Надёжная"));
    }
  }
  const html = yield* request(`/notes/${noteId}`, { headers: { accept: "text/html" } });
  assert.equal((yield* request(`/api/v1/assets/${rawAssetId}`)).status, 401);
  assert.equal(rawReads, 0);
  assert.equal(html.status, 401);
  assert.match(yield* Effect.promise(() => html.text()), /Sign in/);
  for (const invalid of [
    "issuer",
    "audience",
    "azp",
    "nonce",
    "expired",
    "signature",
    "pkce",
    "missing-token",
    "non-owner",
  ] as const) {
    const response = yield* finish(yield* begin(), invalid);
    assert.equal(response.status, invalid === "non-owner" ? 404 : 401, invalid);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert(!response.headers.get("set-cookie")?.includes(`${sessionCookie}=`));
  }
  const proof = yield* begin();
  const callback = peer.callback(proof.authorization);
  const missingBrowser = yield* request(callback.href);
  assert.equal(missingBrowser.status, 401);
  const before = peer.exchanges;
  callback.searchParams.set("state", "wrong");
  assert.equal(
    (yield* request(callback.href, { headers: { cookie: `${loginCookie}=${proof.browser}` } }))
      .status,
    401,
  );
  assert.equal(peer.exchanges, before);
  assert.equal((yield* finish(proof)).status, 401);
  const expiredLogin = yield* begin();
  yield* sql`UPDATE owner_logins SET expires_at=0`;
  assert.equal((yield* finish(expiredLogin)).status, 401);
  const owner = yield* login();
  const authenticated = { cookie: owner.cookie };
  const sdk = yield* HttpApiClient.make(ReaderApi, {
    baseUrl: server.url.href,
    transformClient: (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeaders({ host: "wiki.example.test", cookie: owner.cookie }),
      ),
  }).pipe(Effect.provide(FetchHttpClient.layer));
  const binary = yield* sdk.knowledge.asset({ params: { assetId } });
  assert.match(new TextDecoder().decode(binary.body), /Durable widgets/);
  assert.equal(binary.headers["content-disposition"], "attachment; filename=retained-source.bin");
  const note = yield* request(`/api/v1/notes/${noteId}`, { headers: authenticated });
  assert.equal(note.status, 200);
  assert.match(yield* Effect.promise(() => note.text()), /Надёжная публикация/);
  const asset = yield* request(`/api/v1/assets/${assetId}`, { headers: authenticated });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "application/octet-stream");
  assert.equal(
    asset.headers.get("content-disposition"),
    "attachment; filename=retained-source.bin",
  );
  assert.match(yield* Effect.promise(() => asset.text()), /Durable widgets/);
  const rawAsset = yield* request(`/api/v1/assets/${rawAssetId}`, { headers: authenticated });
  assert.equal(rawAsset.status, 200);
  assert.equal(yield* Effect.promise(() => rawAsset.text()), rawBytes.toString());
  assert.equal(rawReads, 1);
  assert.equal(rawAsset.headers.get("location"), null);
  for (const path of [
    "/internal/v1/jobs/executions",
    "/api/v1/operator/outbox",
    "/api/v1/synthetic/echo",
  ])
    assert.equal((yield* request(path, { headers: authenticated })).status, 404);
  assert.equal(
    (yield* request("/api/v1/session", {
      headers: { authorization: "Bearer wk_" + "a".repeat(43) },
    })).status,
    401,
  );
  const mutate = {
    method: "POST",
    headers: {
      ...authenticated,
      origin: ownerSettings.publicOrigin,
      "x-csrf-token": owner.principal.csrfToken,
      "content-type": "application/json",
    },
  };
  for (const overrides of [
    { origin: "https://evil.test" },
    { "x-csrf-token": "wrong" },
    { origin: "" },
  ])
    assert.equal(
      (yield* request("/api/v1/session/logout", {
        ...mutate,
        headers: { ...mutate.headers, ...overrides },
      })).status,
      403,
    );
  assert.equal((yield* request("/api/v1/submissions", { ...mutate, body: "{}" })).status, 400);
  assert.equal(
    (yield* request("/api/v1/submissions", { ...mutate, body: "{}" })).headers.get("cache-control"),
    "private, no-store",
  );
  const submission = yield* request("/api/v1/submissions", {
    ...mutate,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      mode: "save",
      url: "https://x.com/test/status/20000",
    }),
  });
  assert.equal(submission.status, 200);
  const state = yield* Effect.promise(() => submission.json());
  assert.equal(
    (yield* request("/api/v1/jobs/cancel", {
      ...mutate,
      body: JSON.stringify({ requestId: crypto.randomUUID(), jobId: state.job.jobId }),
    })).status,
    200,
  );
  assert.equal(
    (yield* request("/api/v1/session", {
      headers: { ...authenticated, "x-forwarded-host": "evil.test" },
    })).status,
    400,
  );
  const rows = yield* sql<{
    verifier: string;
    owner_key: string;
    expires_at: number;
  }>`SELECT * FROM owner_sessions`;
  assert.equal(rows.length, 1);
  assert(!JSON.stringify(rows).includes(owner.token));
  assert(rows[0]!.expires_at <= Date.now() + 30 * 24 * 60 * 60 * 1000);
  const rotated = yield* finish(yield* begin(), undefined, owner.token);
  assert.equal(rotated.status, 302);
  assert.equal((yield* request("/api/v1/session", { headers: authenticated })).status, 401);
  const currentToken = cookieValue(rotated.headers.get("set-cookie") ?? "", sessionCookie)!;
  const currentPrincipal = yield* sessions.authenticate(currentToken);
  const logout = yield* request("/api/v1/session/logout", {
    method: "POST",
    headers: {
      cookie: `${sessionCookie}=${currentToken}`,
      origin: ownerSettings.publicOrigin,
      "x-csrf-token": currentPrincipal.csrfToken,
    },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal((yield* sessions.authenticate(currentToken).pipe(Effect.result))._tag, "Failure");
  const expiredSession = yield* login();
  yield* sql`UPDATE owner_sessions SET expires_at=0`;
  assert.equal(
    (yield* request(`/api/v1/assets/${assetId}`, { headers: { cookie: expiredSession.cookie } }))
      .status,
    401,
  );
  const revoked = yield* login();
  yield* sessions.revokeAll();
  assert.equal(
    (yield* request(`/api/v1/notes/${noteId}`, { headers: { cookie: revoked.cookie } })).status,
    401,
  );
  assert.equal((yield* sql`SELECT * FROM owner_logins`).length, 0);
  const race = yield* makeOwnerSessions(ownerSettings, {
    ...provider,
    complete: async (url, proof) => {
      const identity = await provider.complete(url, proof);
      await Effect.runPromise(sessions.revokeAll());
      return identity;
    },
  });
  const inFlight = yield* race.begin("/");
  assert.equal(
    (yield* race.complete(inFlight.browser, peer.callback(inFlight.url)).pipe(Effect.result))._tag,
    "Failure",
  );
  assert.equal((yield* sql`SELECT * FROM owner_sessions`).length, 0);
  const slowReader = yield* login();
  onRead = () => Effect.runPromise(sessions.revokeAll());
  assert.equal(
    (yield* request(`/api/v1/assets/${rawAssetId}`, { headers: { cookie: slowReader.cookie } }))
      .status,
    401,
  );
  const pending = yield* sessions.begin("/");
  const operator = Bun.spawn(
    [process.execPath, "tools/revoke-owner-sessions.ts", `${root}/library.sqlite`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const operatorResult = yield* Effect.tryPromise(async () => {
    const [code, output, errors] = await Promise.all([
      operator.exited,
      new Response(operator.stdout).text(),
      new Response(operator.stderr).text(),
    ]);
    assert.equal(code, 0, output + errors);
    return output;
  });
  assert.match(operatorResult, /"status":"revoked"/);
  assert.equal(
    (yield* sessions.complete(pending.browser, peer.callback(pending.url)).pipe(Effect.result))
      ._tag,
    "Failure",
  );
  assert.equal(localReturn("//evil.test", ownerSettings.publicOrigin), "/");
  assert.equal(localReturn("/\\evil.test", ownerSettings.publicOrigin), "/");
  assert.throws(() => validateConfiguration({ ...ownerSettings, ownerSubject: "" }));
  assert.throws(() =>
    validateConfiguration({ ...ownerSettings, publicOrigin: "http://localhost" }),
  );
  assert.throws(() =>
    validateConfiguration({
      ...ownerSettings,
      issuer: `${ownerSettings.issuer}/.well-known/openid-configuration`,
    }),
  );
  peer.mismatchDiscovery();
  yield* Effect.tryPromise(() =>
    assert.rejects(discoverOwnerProvider(ownerSettings, peer.transport)),
  );
  yield* Console.log(
    JSON.stringify({
      status: "passed",
      coverage:
        "OIDC signature/claims, owner sessions, negative access, CSRF, assets and capability isolation",
    }),
  );
});
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Runtime)));
