import { expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { makeApifyHttp, type StartRequest } from "../apps/runner/src/apify/http.ts";

const token = Redacted.make("synthetic-private-token");
const deadline = () => Date.now() + 60_000;
const run = {
  id: "syntheticRun",
  actId: "syntheticActor",
  buildId: "syntheticBuild",
  defaultDatasetId: "syntheticDataset",
  defaultKeyValueStoreId: "syntheticKv",
  startedAt: "2026-10-19T12:00:00.000Z",
  finishedAt: null,
  status: "RUNNING",
};
const start = (): StartRequest => ({
  actorId: run.actId,
  buildId: run.buildId,
  buildNumber: "1.12.394",
  inputJson: '{"tweetIds":["100"]}',
  chargeNanos: 1_500_000,
  acquisitionDeadline: deadline(),
});
async function withServer<A>(
  handler: (request: Request) => Response | Promise<Response>,
  body: (client: ReturnType<typeof makeApifyHttp>) => Promise<A>,
) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  try {
    return await body(makeApifyHttp(token, server.url.origin));
  } finally {
    await server.stop(true);
  }
}
const failed = async <A, E>(effect: Effect.Effect<A, E>, code: string, startMayExist = false) => {
  const result = await Effect.runPromise(Effect.result(effect));
  expect(result).toMatchObject({ _tag: "Failure", failure: { code, startMayExist } });
  return result;
};
const pageResponse = (body: string | Uint8Array, patch: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : new Uint8Array(body), {
    headers: {
      "content-type": "application/json",
      "x-apify-pagination-offset": "0",
      "x-apify-pagination-count": "1",
      "x-apify-pagination-limit": "2",
      "x-apify-pagination-total": "3",
      ...patch,
    },
  });

test("start makes one bounded pinned POST and keeps exact raw response identities", async () => {
  let posts = 0;
  await withServer(
    async (request) => {
      posts++;
      const url = new URL(request.url);
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-private-token");
      expect(url.pathname).toBe("/v2/acts/syntheticActor/runs");
      expect(url.searchParams.get("build")).toBe("1.12.394");
      expect(url.searchParams.get("memory")).toBe("256");
      expect(url.searchParams.get("restartOnError")).toBe("false");
      expect(url.searchParams.get("maxTotalChargeUsd")).toBe("0.001500000");
      expect(Number(url.searchParams.get("timeout"))).toBeGreaterThan(0);
      expect(Number(url.searchParams.get("timeout"))).toBeLessThanOrEqual(50);
      expect(url.searchParams.has("token")).toBe(false);
      expect(await request.json()).toEqual({ tweetIds: ["100"] });
      return Response.json({ data: run });
    },
    async (client) => {
      const result = await Effect.runPromise(client.start(start()));
      expect(result.run).toMatchObject(run);
      expect(result.raw.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(new TextDecoder().decode(result.raw.bytes))).toEqual({ data: run });
    },
  );
  expect(posts).toBe(1);
});

test("503, malformed success and mismatched build never auto-retry or expose provider text", async () => {
  for (const response of [
    new Response("synthetic-private-token secret input", { status: 503 }),
    new Response("malformed"),
    Response.json({ data: { ...run, buildId: "otherBuild" } }),
  ]) {
    let posts = 0;
    await withServer(
      () => {
        posts++;
        return response;
      },
      async (client) => {
        const result = await failed(
          client.start(start()),
          response.status === 503 ? "http" : "protocol",
          true,
        );
        expect(JSON.stringify(result)).not.toContain("synthetic-private-token");
        expect(JSON.stringify(result)).not.toContain("secret input");
      },
    );
    expect(posts).toBe(1);
  }
});

test("pending null usage retains exact run identities without inventing zero cost", async () => {
  await withServer(
    () => Response.json({ data: { ...run, usageTotalUsd: null } }),
    async (client) => {
      const started = await Effect.runPromise(client.start(start()));
      expect(started.run.id).toBe(run.id);
      expect(started.run.usageTotalUsd).toBeNull();
      const status = await Effect.runPromise(client.status(run.id, deadline()));
      expect(status.run.defaultDatasetId).toBe(run.defaultDatasetId);
      expect(status.run.usageTotalUsd).toBeNull();
    },
  );
});

test("redirects cannot forward authentication or replay an Actor POST", async () => {
  let requests = 0;
  await withServer(
    () => {
      requests++;
      return new Response(null, { status: 307, headers: { location: "/leak" } });
    },
    async (client) => {
      await failed(client.start(start()), "network", true);
    },
  );
  expect(requests).toBe(1);
});

test("expired or malformed starts are rejected without dispatch", async () => {
  let requests = 0;
  await withServer(
    () => {
      requests++;
      return Response.json({ data: run });
    },
    async (client) => {
      await failed(
        client.start({ ...start(), acquisitionDeadline: Date.now() + 5000 }),
        "deadline",
      );
      await failed(client.start({ ...start(), chargeNanos: 0 }), "invalid_request");
      await failed(client.start({ ...start(), buildNumber: "latest" }), "invalid_request");
      await failed(client.start({ ...start(), actorId: "../last" }), "invalid_request");
      await failed(client.start({ ...start(), inputJson: "[]" }), "invalid_request");
    },
  );
  expect(requests).toBe(0);
});

test("status and abort target only exact known identity; ABORTING stays nonterminal", async () => {
  const paths: string[] = [];
  await withServer(
    (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return Response.json({
        data: { ...run, status: path.endsWith("abort") ? "ABORTING" : "RUNNING" },
      });
    },
    async (client) => {
      expect((await Effect.runPromise(client.status(run.id, deadline()))).run.status).toBe(
        "RUNNING",
      );
      expect((await Effect.runPromise(client.abort(run.id, deadline()))).run.status).toBe(
        "ABORTING",
      );
    },
  );
  expect(paths).toEqual(["/v2/actor-runs/syntheticRun", "/v2/actor-runs/syntheticRun/abort"]);
  await withServer(
    () => Response.json({ data: { ...run, id: "someoneElse" } }),
    async (client) => {
      await failed(client.status(run.id, deadline()), "protocol");
    },
  );
});

test("partial pagination preserves the exact offset and raw bytes for checkpoint resume", async () => {
  const offsets: string[] = [];
  await withServer(
    (request) => {
      const url = new URL(request.url);
      offsets.push(url.searchParams.get("offset")!);
      expect(url.pathname).toBe("/v2/datasets/syntheticDataset/items");
      expect(url.searchParams.get("clean")).toBe("false");
      return pageResponse('[{"id":"100"}]', {
        "x-apify-pagination-offset": url.searchParams.get("offset")!,
      });
    },
    async (client) => {
      const first = await Effect.runPromise(
        client.page(run.defaultDatasetId, 0, 2, 64_000_000, deadline()),
      );
      expect(first.nextOffset).toBe(1);
      expect(first.total).toBe(3);
      expect(first.rows).toEqual([{ id: "100" }]);
      await Effect.runPromise(
        client.page(run.defaultDatasetId, first.nextOffset, 2, 64_000_000, deadline()),
      );
    },
  );
  expect(offsets).toEqual(["0", "1"]);
});

test("decoded compressed bytes, rather than Content-Length, enforce the page ceiling", async () => {
  const oversized = JSON.stringify([{ text: "x".repeat(16_777_216) }]);
  const compressed = Bun.gzipSync(oversized);
  expect(compressed.length).toBeLessThan(100_000);
  await withServer(
    () =>
      pageResponse(compressed, {
        "content-encoding": "gzip",
        "content-length": String(compressed.length),
      }),
    async (client) => {
      await failed(client.page(run.defaultDatasetId, 0, 2, 67_108_864, deadline()), "capacity");
    },
  );
});

test("remaining job bytes and streaming truncation fail before JSON admission", async () => {
  await withServer(
    () => pageResponse('[{"text":"' + "x".repeat(500) + '"}]'),
    async (client) => {
      await failed(client.page(run.defaultDatasetId, 0, 2, 128, deadline()), "capacity");
    },
  );
  await withServer(
    () => pageResponse('[{"text":"truncated'),
    async (client) => {
      await failed(client.page(run.defaultDatasetId, 0, 2, 1024, deadline()), "protocol");
    },
  );
});

test("inconsistent or absent pagination cannot silently declare acquisition complete", async () => {
  for (const response of [
    new Response("[]"),
    pageResponse("[]"),
    pageResponse('[{"id":"100"}]', { "x-apify-pagination-offset": "9" }),
    pageResponse('[{"id":"100"}]', { "x-apify-pagination-total": "0" }),
  ]) {
    await withServer(
      () => response,
      async (client) => {
        await failed(client.page(run.defaultDatasetId, 0, 2, 1024, deadline()), "protocol");
      },
    );
  }
});

test("lost abort response preserves uncertainty; successful later polling is independent", async () => {
  let aborts = 0;
  await withServer(
    (request) => {
      if (new URL(request.url).pathname.endsWith("abort")) {
        aborts++;
        return new Response("lost", { status: 502 });
      }
      return Response.json({
        data: {
          ...run,
          status: "ABORTED",
          finishedAt: "2026-10-19T12:01:00.000Z",
          usageTotalUsd: 0.001,
        },
      });
    },
    async (client) => {
      await failed(client.abort(run.id, deadline()), "http");
      expect((await Effect.runPromise(client.status(run.id, deadline()))).run.status).toBe(
        "ABORTED",
      );
    },
  );
  expect(aborts).toBe(1);
});
