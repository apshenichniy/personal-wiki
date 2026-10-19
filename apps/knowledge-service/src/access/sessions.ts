import { randomBytes, timingSafeEqual } from "node:crypto";
import { Clock, Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { digest } from "../storage/io.ts";
import { JobError } from "../jobs/policy.ts";
import type { AccessConfiguration } from "./config.ts";
import type { LoginProof, OwnerProvider } from "./oidc.ts";

export const sessionCookie = "__Host-wiki-session";
export const loginCookie = "__Host-wiki-login";
const lifetime = 30 * 24 * 60 * 60 * 1000;
const loginLifetime = 10 * 60 * 1000;
const token = () => randomBytes(32).toString("base64url");
const validToken = (value: string | undefined): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const denied = () => new JobError({ code: "unauthenticated", message: "Authentication required." });

export const revokeOwnerSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`UPDATE owner_auth_state SET epoch=epoch+1 WHERE singleton=1`;
      yield* sql`DELETE FROM owner_sessions`;
      yield* sql`DELETE FROM owner_logins`;
    }),
  );
});

export function cookieValue(header: string | undefined, name: string) {
  const values = (header ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`))
    .map((item) => item.slice(name.length + 1));
  return values.length === 1 && validToken(values[0]) ? values[0] : undefined;
}
export function localReturn(value: string | null, origin: string) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return "/";
  const parsed = new URL(value, origin);
  if (
    parsed.origin !== origin ||
    parsed.pathname.startsWith("/auth/") ||
    !(parsed.pathname === "/" || /^\/(notes|jobs)\/[a-f0-9-]{36}$/.test(parsed.pathname))
  )
    return "/";
  return parsed.pathname;
}

export const makeOwnerSessions = (settings: AccessConfiguration, provider: OwnerProvider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ownerKey = digest(`${settings.issuer}\0${settings.ownerSubject}`);
    const begin = (returnTo: string | null) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const browser = token();
        const proof: LoginProof = { state: token(), nonce: token(), verifier: token() };
        const target = localReturn(returnTo, settings.publicOrigin);
        const url = yield* Effect.tryPromise({ try: () => provider.begin(proof), catch: denied });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM owner_logins WHERE expires_at<=${now}`;
            // Bound unauthenticated pending transactions without affecting active sessions.
            yield* sql`DELETE FROM owner_logins WHERE verifier IN (SELECT verifier FROM owner_logins ORDER BY expires_at DESC LIMIT -1 OFFSET 127)`;
            yield* sql`INSERT INTO owner_logins SELECT ${digest(browser)},${proof.state},${proof.nonce},${proof.verifier},${target},${now + loginLifetime},epoch FROM owner_auth_state WHERE singleton=1`;
          }),
        );
        return { browser, url };
      });
    const complete = (browser: string | undefined, url: URL, oldSession?: string) =>
      Effect.gen(function* () {
        if (!validToken(browser)) return yield* denied();
        const now = yield* Clock.currentTimeMillis;
        // Consume before network exchange: two concurrent callbacks cannot both win.
        const row = (yield* sql<{
          state: string;
          nonce: string;
          pkce: string;
          return_to: string;
          epoch: number;
        }>`DELETE FROM owner_logins WHERE verifier=${digest(browser)} AND expires_at>${now} RETURNING state,nonce,pkce,return_to,epoch`)[0];
        if (!row) return yield* denied();
        const identity = yield* Effect.tryPromise({
          try: () =>
            provider.complete(url, { state: row.state, nonce: row.nonce, verifier: row.pkce }),
          catch: denied,
        });
        if (identity.issuer !== settings.issuer || identity.subject !== settings.ownerSubject)
          return yield* new JobError({ code: "not_found", message: "Not found." });
        const session = token();
        const expires = (yield* Clock.currentTimeMillis) + lifetime;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (
              !(yield* sql`SELECT epoch FROM owner_auth_state WHERE singleton=1 AND epoch=${row.epoch}`)
                .length
            )
              return yield* denied();
            if (validToken(oldSession))
              yield* sql`DELETE FROM owner_sessions WHERE verifier=${digest(oldSession)}`;
            yield* sql`DELETE FROM owner_sessions WHERE expires_at<=${now}`;
            yield* sql`INSERT INTO owner_sessions VALUES(${digest(session)},${ownerKey},${expires})`;
          }),
        );
        return { session, expiresAt: new Date(expires).toISOString(), returnTo: row.return_to };
      });
    const authenticate = (session: string | undefined) =>
      Effect.gen(function* () {
        if (!validToken(session)) return yield* denied();
        const now = yield* Clock.currentTimeMillis;
        const row = (yield* sql<{
          expires_at: number;
        }>`SELECT expires_at FROM owner_sessions WHERE verifier=${digest(session)} AND owner_key=${ownerKey} AND expires_at>${now}`)[0];
        if (!row) return yield* denied();
        return {
          identityId: `owner:${ownerKey}`,
          expiresAt: new Date(row.expires_at).toISOString(),
          csrfToken: digest(`csrf:${session}`),
        };
      });
    const csrf = (
      session: string | undefined,
      origin: string | undefined,
      supplied: string | undefined,
    ) =>
      Effect.gen(function* () {
        const principal = yield* authenticate(session);
        if (
          origin !== settings.publicOrigin ||
          !supplied ||
          !/^[a-f0-9]{64}$/.test(supplied) ||
          !timingSafeEqual(Buffer.from(principal.csrfToken), Buffer.from(supplied))
        )
          return yield* new JobError({
            code: "forbidden",
            message: "Request verification failed.",
          });
        return principal;
      });
    const logout = (session: string | undefined) =>
      Effect.gen(function* () {
        yield* authenticate(session);
        yield* sql`DELETE FROM owner_sessions WHERE verifier=${digest(session!)}`;
      });
    const revokeAll = () =>
      revokeOwnerSessions.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return { settings, begin, complete, authenticate, csrf, logout, revokeAll };
  });
export class OwnerSessions extends Context.Service<
  OwnerSessions,
  Effect.Success<ReturnType<typeof makeOwnerSessions>>
>()("personal-wiki/OwnerSessions") {
  static layer = (settings: AccessConfiguration, provider: OwnerProvider) =>
    Layer.effect(OwnerSessions, makeOwnerSessions(settings, provider));
}
