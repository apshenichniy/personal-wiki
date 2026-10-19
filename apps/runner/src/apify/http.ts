import { createHash } from "node:crypto";
import { Effect, Redacted, Schema } from "effect";

/** An HTTP failure never proves that an Actor start did not happen. Error text
 * deliberately excludes response bodies, URLs, inputs and authentication. */
export class ApifyTransportError extends Schema.TaggedError<ApifyTransportError>()(
  "ApifyTransportError",
  {
    code: Schema.Literals([
      "invalid_request",
      "deadline",
      "network",
      "http",
      "capacity",
      "protocol",
    ]),
    status: Schema.NullOr(Schema.Int),
    startMayExist: Schema.Boolean,
    message: Schema.String,
  },
) {}
const error = (
  code: ApifyTransportError["code"],
  startMayExist = false,
  status: number | null = null,
) =>
  new ApifyTransportError({ code, status, startMayExist, message: `Provider transport: ${code}.` });
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/));
const Run = Schema.Struct({
  id: Identifier,
  actId: Identifier,
  buildId: Identifier,
  defaultDatasetId: Identifier,
  defaultKeyValueStoreId: Identifier,
  startedAt: Timestamp,
  finishedAt: Schema.NullOr(Timestamp),
  status: Schema.Literals([
    "READY",
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
    "TIMING-OUT",
    "TIMED-OUT",
    "ABORTING",
    "ABORTED",
  ]),
  usageTotalUsd: Schema.optional(
    Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
});
export type ApifyRun = typeof Run.Type;
export type RawResponse = {
  bytes: Uint8Array;
  sha256: string;
  json: unknown;
  headers: Headers;
};
export type StartRequest = {
  actorId: string;
  buildNumber: string;
  buildId: string;
  inputJson: string;
  chargeNanos: number;
  acquisitionDeadline: number;
};
const pageBytes = 16_777_216;
const controlBytes = 1_048_576;
const requestMillis = 10_000;

function id(value: string) {
  if (!Schema.is(Identifier)(value)) throw error("invalid_request");
  return value;
}
function integer(value: number, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw error("invalid_request");
  return value;
}
function parseJson(bytes: Uint8Array, start: boolean): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw error("protocol", start);
  }
}

/** fetch exposes decoded bytes. Count before concatenating or parsing, including
 * responses with missing/false Content-Length and compressed response bombs. */
async function readBounded(response: Response, maximum: number, start: boolean) {
  if (!response.body) throw error("protocol", start);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) throw error("capacity", start);
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    json: parseJson(bytes, start),
    headers: response.headers,
  } satisfies RawResponse;
}

export function decodeRun(raw: RawResponse, start: boolean): ApifyRun {
  let run: ApifyRun;
  try {
    run = Schema.decodeUnknownSync(Schema.Struct({ data: Run }))(raw.json).data;
  } catch {
    throw error("protocol", start);
  }
  if (
    !Number.isFinite(Date.parse(run.startedAt)) ||
    (run.finishedAt !== null && !Number.isFinite(Date.parse(run.finishedAt))) ||
    (run.usageTotalUsd != null && !Number.isFinite(run.usageTotalUsd))
  )
    throw error("protocol", start);
  return run;
}

/** No SDK retries, redirects, last-run lookups or provider-side idempotency
 * assumptions. The caller must durably consume its start permit first. This
 * module intentionally cannot decide that a failed start is safe to repeat. */
export function makeApifyHttp(token: Redacted.Redacted<string>, testOrigin?: string) {
  const origin = new URL(testOrigin ?? "https://api.apify.com");
  if (testOrigin && !(origin.protocol === "http:" && origin.hostname === "127.0.0.1"))
    throw error("invalid_request");
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/")
    throw error("invalid_request");

  const request = (
    path: string,
    method: "GET" | "POST",
    deadline: number,
    maximum: number,
    start: boolean,
    body?: string,
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw error("deadline");
        const timeout = AbortSignal.timeout(Math.min(requestMillis, deadline - Date.now()));
        const response = await fetch(new URL(path, origin), {
          method,
          headers: {
            Authorization: `Bearer ${Redacted.value(token)}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body }),
          redirect: "error",
          signal: AbortSignal.any([signal, timeout]),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw error("http", start, response.status);
        }
        return await readBounded(response, maximum, start);
      },
      catch: (cause) => (cause instanceof ApifyTransportError ? cause : error("network", start)),
    });

  const start = Effect.fn("Apify.start")(function* (input: StartRequest) {
    // Reserve enough wall time for the start exchange itself. A timeout of zero
    // means unbounded on Apify and must never be sent.
    const options = yield* Effect.try({
      try: () => {
        id(input.actorId);
        id(input.buildId);
        if (
          !/^\d+\.\d+\.\d+$/.test(input.buildNumber) ||
          Buffer.byteLength(input.inputJson) > 65_536
        )
          throw error("invalid_request");
        const parsed: unknown = JSON.parse(input.inputJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw error("invalid_request");
        const seconds = Math.floor((input.acquisitionDeadline - Date.now() - requestMillis) / 1000);
        if (seconds < 1) throw error("deadline");
        integer(input.chargeNanos, 1, 250_000_000);
        return new URLSearchParams({
          build: input.buildNumber,
          memory: "256",
          timeout: String(Math.min(300, seconds)),
          restartOnError: "false",
          maxTotalChargeUsd: (input.chargeNanos / 1e9).toFixed(9),
          waitForFinish: "0",
        });
      },
      catch: (cause) => (cause instanceof ApifyTransportError ? cause : error("invalid_request")),
    });
    const raw = yield* request(
      `/v2/acts/${input.actorId}/runs?${options}`,
      "POST",
      input.acquisitionDeadline,
      controlBytes,
      true,
      input.inputJson,
    );
    const run = yield* Effect.try({
      try: () => decodeRun(raw, true),
      catch: () => error("protocol", true),
    });
    if (run.actId !== input.actorId || run.buildId !== input.buildId)
      return yield* error("protocol", true);
    return { raw, run };
  });
  const runRequest = Effect.fn("Apify.runRequest")(function* (
    runId: string,
    deadline: number,
    abort: boolean,
  ) {
    yield* Effect.try({ try: () => id(runId), catch: () => error("invalid_request") });
    const raw = yield* request(
      `/v2/actor-runs/${runId}${abort ? "/abort?gracefully=true" : ""}`,
      abort ? "POST" : "GET",
      deadline,
      controlBytes,
      false,
    );
    const run = yield* Effect.try({
      try: () => decodeRun(raw, false),
      catch: () => error("protocol"),
    });
    if (run.id !== runId) return yield* error("protocol");
    return { raw, run }; // ABORTING is not terminal confirmation.
  });
  const page = Effect.fn("Apify.page")(function* (
    datasetId: string,
    offset: number,
    limit: number,
    remainingBytes: number,
    deadline: number,
  ) {
    yield* Effect.try({
      try: () => {
        id(datasetId);
        integer(offset, 0, 100_000);
        integer(limit, 1, 100);
        integer(remainingBytes, 1, 67_108_864);
      },
      catch: () => error("invalid_request"),
    });
    const query = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
      format: "json",
      clean: "false",
      desc: "false",
    });
    const raw = yield* request(
      `/v2/datasets/${datasetId}/items?${query}`,
      "GET",
      deadline,
      Math.min(pageBytes, remainingBytes),
      false,
    );
    const json = raw.json;
    if (!Array.isArray(json) || json.length > limit) return yield* error("protocol");
    const pagination = yield* Effect.try({
      try: () => {
        const value = (key: string) => {
          const text = raw.headers.get(`x-apify-pagination-${key}`);
          if (text === null || !/^\d+$/.test(text)) throw error("protocol");
          return integer(Number(text), 0, Number.MAX_SAFE_INTEGER);
        };
        const total = value("total");
        if (
          value("offset") !== offset ||
          value("count") !== json.length ||
          value("limit") !== limit ||
          offset + json.length > total ||
          (json.length === 0 && offset < total)
        )
          throw error("protocol");
        return { total, nextOffset: offset + json.length };
      },
      catch: () => error("protocol"),
    });
    return { raw, rows: json as unknown[], ...pagination };
  });
  return {
    start,
    status: (runId: string, deadline: number) => runRequest(runId, deadline, false),
    abort: (runId: string, deadline: number) => runRequest(runId, deadline, true),
    page,
    report: (keyValueStoreId: string, remainingBytes: number, deadline: number) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            id(keyValueStoreId);
            integer(remainingBytes, 1, 67_108_864);
          },
          catch: () => error("invalid_request"),
        });
        return yield* request(
          `/v2/key-value-stores/${keyValueStoreId}/records/run-report`,
          "GET",
          deadline,
          Math.min(pageBytes, remainingBytes),
          false,
        );
      }),
  };
}
