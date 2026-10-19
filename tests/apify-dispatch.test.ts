import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, chmod, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import {
  dispatchOnce,
  retainedDispatch,
  type DispatchIdentity,
} from "../apps/runner/src/apify/dispatch.ts";
import { makeApifyHttp, type StartRequest } from "../apps/runner/src/apify/http.ts";

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
const input = (): StartRequest => ({
  actorId: run.actId,
  buildId: run.buildId,
  buildNumber: "1.12.394",
  inputJson: '{"tweetIds":["100"]}',
  chargeNanos: 1_500_000,
  acquisitionDeadline: Date.now() + 60_000,
});

for (const mode of ["intent", "receipt"] as const) {
  test(`SIGKILL after durable ${mode} cannot cause a second provider start`, async () =>
    harness(async (h) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "tests/helpers/apify-dispatch-probe.ts",
          h.root,
          h.identity.operationId,
          h.origin,
          mode,
        ],
        { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
      );
      const reader = child.stdout.getReader();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Synthetic dispatch checkpoint was not reached")),
              5000,
            );
          }),
        ]);
        expect(new TextDecoder().decode(chunk.value)).toContain(
          mode === "intent" ? "INTENT_DURABLE" : "RECEIPT_DURABLE",
        );
        child.kill("SIGKILL");
        await child.exited;
        const retained = await Effect.runPromise(retainedDispatch(h.root, h.identity));
        expect(retained?.run.id ?? null).toBe(mode === "receipt" ? run.id : null);
        let permits = 0;
        const result = await Effect.runPromise(
          Effect.result(
            dispatchOnce({
              ...h,
              permit: Effect.sync(() => {
                permits++;
                return input();
              }),
              accept: () => Effect.void,
              uncertain: Effect.void,
            }),
          ),
        );
        expect(result._tag).toBe(mode === "intent" ? "Failure" : "Success");
        expect(permits).toBe(0);
        expect(h.posts()).toBe(mode === "intent" ? 0 : 1);
      } finally {
        clearTimeout(timer);
        reader.releaseLock();
        child.kill("SIGKILL");
        await child.exited;
      }
    }));
}
async function harness<A>(
  body: (value: {
    root: string;
    identity: DispatchIdentity;
    client: ReturnType<typeof makeApifyHttp>;
    origin: string;
    posts: () => number;
    respond: (response: Response) => void;
  }) => Promise<A>,
) {
  const root = await mkdtemp(join(tmpdir(), "wiki-apify-intent-"));
  let response = Response.json({ data: run });
  let posts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      posts++;
      // The write-ahead marker must be durable and visible before network dispatch.
      expect(await Bun.file(join(root, `${identity.operationId}.intent.json`)).exists()).toBe(true);
      return response;
    },
  });
  const identity: DispatchIdentity = {
    operationId: crypto.randomUUID(),
    inputDigest: "a".repeat(64),
    actorId: run.actId,
    buildId: run.buildId,
  };
  try {
    return await body({
      root,
      identity,
      client: makeApifyHttp(Redacted.make("synthetic-token"), server.url.origin),
      origin: server.url.origin,
      posts: () => posts,
      respond: (value) => {
        response = value;
      },
    });
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

test("lost Service acknowledgment replays durable run receipt without another permit or POST", async () =>
  harness(async (h) => {
    let permits = 0;
    let accepts = 0;
    let uncertain = 0;
    const options = {
      ...h,
      permit: Effect.sync(() => {
        permits++;
        return input();
      }),
      accept: () =>
        Effect.gen(function* () {
          accepts++;
          if (accepts === 1) return yield* Effect.fail("lost acknowledgment");
        }),
      uncertain: Effect.sync(() => {
        uncertain++;
      }),
    };
    expect((await Effect.runPromise(Effect.result(dispatchOnce(options))))._tag).toBe("Failure");
    const receipt = await Effect.runPromise(dispatchOnce(options));
    expect(receipt.run.id).toBe(run.id);
    expect(h.posts()).toBe(1);
    expect(permits).toBe(1);
    expect(accepts).toBe(2);
    expect(uncertain).toBe(1);
    expect((await stat(join(h.root, `${h.identity.operationId}.response.json`))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      await readFile(join(h.root, `${h.identity.operationId}.response.json`), "utf8"),
    ).not.toContain("synthetic-token");
  }));

test("lost start response leaves intent and never authorizes another POST on restart", async () =>
  harness(async (h) => {
    h.respond(new Response("lost", { status: 502 }));
    let permits = 0;
    const options = {
      ...h,
      permit: Effect.sync(() => {
        permits++;
        return input();
      }),
      accept: () => Effect.void,
      uncertain: Effect.void,
    };
    await Effect.runPromise(Effect.result(dispatchOnce(options)));
    const result = await Effect.runPromise(Effect.result(dispatchOnce(options)));
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "start_unknown" } });
    expect(permits).toBe(1);
    expect(h.posts()).toBe(1);
  }));

test("concurrent callers cannot share the one-use start permission", async () =>
  harness(async (h) => {
    let permits = 0;
    const options = {
      ...h,
      permit: Effect.sync(() => {
        permits++;
        return input();
      }),
      accept: () => Effect.void,
      uncertain: Effect.void,
    };
    const results = await Promise.all([
      Effect.runPromise(Effect.result(dispatchOnce(options))),
      Effect.runPromise(Effect.result(dispatchOnce(options))),
    ]);
    expect(results.some((r) => r._tag === "Success")).toBe(true);
    expect(permits).toBe(1);
    expect(h.posts()).toBe(1);
  }));

test("a crash after intent but before permission is unresolved, not an implicit retry", async () =>
  harness(async (h) => {
    await writeFile(
      join(h.root, `${h.identity.operationId}.intent.json`),
      JSON.stringify(h.identity),
      { mode: 0o600 },
    );
    let permits = 0;
    const result = await Effect.runPromise(
      Effect.result(
        dispatchOnce({
          ...h,
          permit: Effect.sync(() => {
            permits++;
            return input();
          }),
          accept: () => Effect.void,
          uncertain: Effect.void,
        }),
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "start_unknown" } });
    expect(permits).toBe(0);
    expect(h.posts()).toBe(0);
  }));

test("operation identity reuse with another input cannot adopt an earlier receipt", async () =>
  harness(async (h) => {
    const options = {
      ...h,
      permit: Effect.succeed(input()),
      accept: () => Effect.void,
      uncertain: Effect.void,
    };
    await Effect.runPromise(dispatchOnce(options));
    const result = await Effect.runPromise(
      Effect.result(
        dispatchOnce({ ...options, identity: { ...h.identity, inputDigest: "b".repeat(64) } }),
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "identity_conflict" } });
    expect(h.posts()).toBe(1);
  }));

test("world-readable spools and symlink intents fail before permission", async () =>
  harness(async (h) => {
    let permits = 0;
    const options = {
      ...h,
      permit: Effect.sync(() => {
        permits++;
        return input();
      }),
      accept: () => Effect.void,
      uncertain: Effect.void,
    };
    await chmod(h.root, 0o755);
    expect(await Effect.runPromise(Effect.result(dispatchOnce(options)))).toMatchObject({
      _tag: "Failure",
      failure: { code: "storage" },
    });
    await chmod(h.root, 0o700);
    const target = join(h.root, "target");
    await writeFile(target, "preserved", { mode: 0o600 });
    await symlink(target, join(h.root, `${h.identity.operationId}.intent.json`));
    expect(await Effect.runPromise(Effect.result(dispatchOnce(options)))).toMatchObject({
      _tag: "Failure",
      failure: { code: "storage" },
    });
    expect(await readFile(target, "utf8")).toBe("preserved");
    expect(permits).toBe(0);
    expect(h.posts()).toBe(0);
  }));
