import { Effect, Layer } from "effect";
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ReaderApi } from "@personal-wiki/contracts/reader-api";
import { withErrorBoundary } from "../http.ts";
import { Library } from "../storage/library.ts";
import { Jobs } from "../jobs/service.ts";
import { JobLifecycle } from "../jobs/lifecycle.ts";
import { OwnerSessions, cookieValue, sessionCookie, loginCookie, localReturn } from "./sessions.ts";

const privateHeaders = {
  "cache-control": "private, no-store",
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const errorResponse = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ code, message, requestId: crypto.randomUUID() }, { status });
const current = Effect.gen(function* () {
  const sessions = yield* OwnerSessions;
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* sessions.authenticate(cookieValue(request.headers.cookie, sessionCookie));
});

const knowledge = HttpApiBuilder.group(
  ReaderApi,
  "knowledge",
  Effect.fn(function* (handlers) {
    const library = yield* Library;
    return handlers.handleAll({
      list: ({ query }) => library.list(query.revision).pipe(Effect.orDie),
      note: ({ params, query }) => library.note(params.noteId, query.revision).pipe(Effect.orDie),
      capture: ({ params, query }) =>
        library.capture(params.captureId, query.revision).pipe(Effect.orDie),
      search: ({ payload }) => library.search(payload.query, payload.revision).pipe(Effect.orDie),
      asset: ({ params }) =>
        Effect.gen(function* () {
          const bytes = yield* library.asset(params.assetId);
          // Recheck after archive I/O: revocation during a download denies delivery.
          yield* current;
          return HttpApiSchema.withHeaders({
            body: new Uint8Array(bytes),
            headers: {
              "content-disposition": "attachment; filename=retained-source.bin" as const,
              "accept-ranges": "none" as const,
            },
          });
        }).pipe(Effect.orDie),
    });
  }),
);
const jobs = HttpApiBuilder.group(
  ReaderApi,
  "jobs",
  Effect.fn(function* (handlers) {
    const jobs = yield* Jobs;
    const lifecycle = yield* JobLifecycle;
    return handlers.handleAll({
      submit: ({ payload }) => jobs.submit(payload).pipe(Effect.orDie),
      get: ({ params }) => jobs.get(params.jobId).pipe(Effect.orDie),
      cancel: ({ payload }) =>
        current.pipe(
          Effect.flatMap((owner) => lifecycle.cancel(owner.identityId, payload)),
          Effect.orDie,
        ),
      resume: ({ payload }) =>
        current.pipe(
          Effect.flatMap((owner) => lifecycle.resume(owner.identityId, payload)),
          Effect.orDie,
        ),
      retryRetained: ({ payload }) =>
        current.pipe(
          Effect.flatMap((owner) => lifecycle.retryRetained(owner.identityId, payload)),
          Effect.orDie,
        ),
    });
  }),
);
const session = HttpApiBuilder.group(
  ReaderApi,
  "session",
  Effect.fn(function* (handlers) {
    const sessions = yield* OwnerSessions;
    return handlers.handleAll({
      get: () =>
        current.pipe(
          Effect.map((owner) => ({
            schemaVersion: 1 as const,
            expiresAt: owner.expiresAt,
            csrfToken: owner.csrfToken,
          })),
          Effect.orDie,
        ),
      logout: () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* sessions.logout(cookieValue(request.headers.cookie, sessionCookie));
        }).pipe(Effect.orDie),
    });
  }),
);

const login = HttpRouter.add(
  "GET",
  "/auth/login",
  Effect.gen(function* () {
    const sessions = yield* OwnerSessions;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, sessions.settings.publicOrigin);
    const begun = yield* sessions.begin(url.searchParams.get("returnTo"));
    return HttpServerResponse.redirect(begun.url, {
      headers: { "set-cookie": cookie(loginCookie, begun.browser, 600) },
    });
  }).pipe(Effect.orDie),
);
const callback = HttpRouter.add(
  "GET",
  "/auth/callback",
  Effect.gen(function* () {
    const sessions = yield* OwnerSessions;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const response = yield* sessions
      .complete(
        cookieValue(request.headers.cookie, loginCookie),
        new URL(request.url, sessions.settings.publicOrigin),
        cookieValue(request.headers.cookie, sessionCookie),
      )
      .pipe(Effect.result);
    if (response._tag === "Failure") {
      const other = "code" in response.failure && response.failure.code === "not_found";
      return HttpServerResponse.setHeader(
        errorResponse(
          other ? 404 : 401,
          other ? "not_found" : "unauthenticated",
          other ? "Not found." : "Authentication required.",
        ),
        "set-cookie",
        cookie(loginCookie, "", 0),
      );
    }
    return HttpServerResponse.redirect(response.success.returnTo, {
      headers: { "set-cookie": cookie(sessionCookie, response.success.session, 30 * 24 * 60 * 60) },
    });
  }),
);

const OwnerBoundary = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const sessions = yield* OwnerSessions;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const origin = new URL(sessions.settings.publicOrigin);
      const path = new URL(request.url, origin).pathname;
      const guarded = Effect.gen(function* () {
        // This listener binds loopback only. The configured tunnel must send its
        // exact public Host; forwarded metadata can never select another origin.
        if (
          request.headers.host !== origin.host ||
          (request.headers["x-forwarded-host"] !== undefined &&
            request.headers["x-forwarded-host"] !== origin.host) ||
          (request.headers["x-forwarded-proto"] !== undefined &&
            request.headers["x-forwarded-proto"] !== "https")
        )
          return errorResponse(400, "invalid_request", "Invalid request origin.");
        if (path === "/health") return HttpServerResponse.empty({ status: 204 });
        if ((path === "/auth/login" || path === "/auth/callback") && request.method === "GET")
          return yield* httpEffect;
        const raw = cookieValue(request.headers.cookie, sessionCookie);
        const authenticated = yield* sessions.authenticate(raw).pipe(Effect.result);
        if (authenticated._tag === "Failure") {
          if (!path.startsWith("/api/") && request.headers.accept?.includes("text/html"))
            return HttpServerResponse.text(
              `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign in</title><p>Authentication required.</p><a href="/auth/login?returnTo=${encodeURIComponent(localReturn(path, origin.origin))}">Sign in</a></html>`,
              { status: 401, contentType: "text/html; charset=utf-8" },
            );
          return errorResponse(401, "unauthenticated", "Authentication required.");
        }
        if (!["GET", "HEAD"].includes(request.method)) {
          const permitted = yield* sessions
            .csrf(raw, request.headers.origin, request.headers["x-csrf-token"])
            .pipe(Effect.result);
          if (permitted._tag === "Failure")
            return errorResponse(403, "forbidden", "Request verification failed.");
        }
        const response = yield* httpEffect;
        return path === "/api/v1/session/logout" && response.status === 204
          ? HttpServerResponse.setHeader(response, "set-cookie", cookie(sessionCookie, "", 0))
          : response;
      });
      return HttpServerResponse.setHeaders(yield* withErrorBoundary(guarded), privateHeaders);
    }),
  { global: true },
);

export const OwnerRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(ReaderApi).pipe(Layer.provide([knowledge, jobs, session])),
  login,
  callback,
  OwnerBoundary,
);
