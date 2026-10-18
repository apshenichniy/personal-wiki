import { afterAll, beforeAll, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Schema, Effect, Cause } from "effect";
import { makeClient } from "@personal-wiki/client";
import { EchoResponse, ErrorEnvelope } from "@personal-wiki/contracts";

let service: Bun.Subprocess<"ignore", "pipe", "pipe">;
let baseUrl = "";
let errors: Promise<string>;
const requestId = "a87ed534-78f9-4ddf-b558-14654d232e79";
const cleanEnv = { PATH: process.env.PATH, PORT: "0" };

beforeAll(async () => {
  service = Bun.spawn([process.execPath, "apps/knowledge-service/dist/index.js"], {
    env: cleanEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  errors = new Response(service.stderr).text();
  const timeout = setTimeout(() => service.kill(), 10000);
  try {
    const reader = service.stdout.getReader();
    let text = "";
    while (!baseUrl) {
      const result = await reader.read();
      if (result.done) throw new Error(`Service exited before readiness: ${await errors}`);
      text += new TextDecoder().decode(result.value);
      for (const line of text.split("\n").slice(0, -1)) {
        if (line.startsWith('{"event":"ready"')) {
          const ready = Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
          )(line);
          baseUrl = ready.url;
        }
      }
    }
    reader.releaseLock();
  } finally {
    clearTimeout(timeout);
  }
}, 15000);

afterAll(async () => {
  service?.kill("SIGTERM");
  if (service) await service.exited;
});

const post = (body: string, id = requestId) =>
  fetch(`${baseUrl}/api/v1/synthetic/echo`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": id },
    body,
  });

test("built Runner communicates with a separate built Service through the declared client", async () => {
  const child = Bun.spawn([process.execPath, "apps/runner/dist/index.js"], {
    env: { PATH: process.env.PATH, WIKI_SERVICE_URL: baseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, err).toBe(0);
  const result = Schema.decodeSync(Schema.fromJsonString(EchoResponse))(out.trim());
  expect(result.message).toBe("synthetic-runner-probe");
  expect(result.synthetic).toBe(true);
}, 15000);

test("generated JSON Schema independently validates real HTTP response and rejects malformed data", async () => {
  const ajv = new Ajv2020();
  addFormats(ajv);
  const validate = ajv.compile(
    await Bun.file("packages/contracts/generated/EchoResponse.json").json(),
  );
  const response = await post(
    JSON.stringify({ message: "Синтетический текст — 日本語", futureField: "ignored" }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toBe(requestId);
  const result: unknown = await response.json();
  expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  expect(validate({ requestId: "not-a-uuid", message: 12, synthetic: false })).toBe(false);
});

for (const [name, body, id] of [
  ["wrong type", '{"message":42}', requestId],
  ["missing field", "{}", requestId],
  ["empty message", '{"message":""}', requestId],
  ["oversize message", JSON.stringify({ message: "a".repeat(1025) }), requestId],
  ["invalid JSON", "{broken", requestId],
  ["invalid request identity", '{"message":"valid"}', "not-a-uuid"],
] as const) {
  test(`malformed request returns a safe correlated 400: ${name}`, async () => {
    const response = await post(body, id);
    expect(response.status).toBe(400);
    const result = Schema.decodeUnknownSync(ErrorEnvelope)(await response.json());
    expect(result.code).toBe("invalid_request");
    expect(result.message).toBe("Request does not match the API contract.");
    expect(result.requestId).toBe(response.headers.get("x-request-id")!);
    if (id === requestId) expect(result.requestId).toBe(requestId);
  });
}

test("typed client rejects a successful status with an invalid response body", async () => {
  const badServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ synthetic: true, message: 42 }),
  });
  try {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* makeClient(`http://127.0.0.1:${badServer.port}`);
        return yield* client.echo({
          headers: { "x-request-id": requestId },
          payload: { message: "synthetic" },
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
  } finally {
    await badServer.stop(true);
  }
});

test("served OpenAPI matches the committed contract", async () => {
  const response = await fetch(`${baseUrl}/openapi.json`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(
    await Bun.file("packages/contracts/generated/openapi.json").json(),
  );
});

test("typed client decodes a declared HTTP error envelope", async () => {
  const envelope = { code: "invalid_request", message: "Synthetic rejection.", requestId } as const;
  const rejectingServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(envelope, { status: 400 }),
  });
  try {
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* makeClient(`http://127.0.0.1:${rejectingServer.port}`);
        return yield* client.echo({
          headers: { "x-request-id": requestId },
          payload: { message: "valid" },
        });
      }),
    );
    if (result._tag !== "Failure") throw new Error("Expected a typed failure");
    expect(Schema.decodeUnknownSync(ErrorEnvelope)(Cause.squash(result.cause))).toEqual(envelope);
  } finally {
    await rejectingServer.stop(true);
  }
});
