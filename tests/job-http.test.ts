import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { makeJobClient } from "@personal-wiki/client";
import { launch } from "./helpers/service.ts";

test("built synthetic Runner uses authenticated job HTTP without canonical storage access", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-job-http-"));
  const operator = `wk_${randomBytes(32).toString("base64url")}`;
  const runner = `wk_${randomBytes(32).toString("base64url")}`;
  const credentialsPath = join(root, "credentials.json");
  const runnerId = randomUUID();
  const runnerPath = join(root, "runner-token");
  await writeFile(
    credentialsPath,
    JSON.stringify({
      credentials: [
        { identityId: randomUUID(), role: "operator", token: operator },
        { identityId: runnerId, role: "runner", token: runner },
      ],
    }),
    { mode: 0o600 },
  );
  await writeFile(runnerPath, runner, { mode: 0o600 });
  const service = await launch(
    join(root, "service"),
    { WIKI_MACHINE_CREDENTIALS_FILE: credentialsPath },
    true,
  );
  try {
    for (const path of [
      "/api/v1/notes",
      "/api/v1/submissions",
      "/internal/v1/jobs/claim",
      "/openapi.json",
    ]) {
      const response = await fetch(service.url + path, {
        method: path === "/api/v1/notes" || path === "/openapi.json" ? "GET" : "POST",
      });
      expect(response.status, path).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(
      (
        await fetch(service.url + "/api/v1/worker/reservations", {
          method: "POST",
          headers: { authorization: `Bearer ${operator}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(service.url + "/internal/v1/jobs/claim", {
          method: "POST",
          headers: { authorization: `Bearer ${operator}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(service.url + "/api/v1/submissions", {
          method: "POST",
          headers: { authorization: `Bearer ${runner}` },
        })
      ).status,
    ).toBe(403);
    expect(
      await (
        await fetch(service.url + "/openapi.json", {
          headers: { authorization: `Bearer ${operator}` },
        })
      ).json(),
    ).toEqual(await Bun.file("packages/contracts/generated/openapi.json").json());
    const client = await Effect.runPromise(makeJobClient(service.url, operator));
    const accepted = await Effect.runPromise(
      client.jobs.submit({
        payload: {
          requestId: randomUUID(),
          mode: "save",
          url: "https://x.com/example/status/9001",
        },
      }),
    );
    expect(accepted.outcome).toBe("accepted");
    expect(accepted.job?.stage).toBe("queued");
    const child = Bun.spawn([process.execPath, "apps/runner/dist/synthetic.js"], {
      env: {
        PATH: process.env.PATH,
        WIKI_SERVICE_URL: service.url,
        WIKI_RUNNER_TOKEN_FILE: runnerPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 35000);
    try {
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, output + errors).toBe(0);
      expect(output).toContain('"stage":"succeeded"');
    } finally {
      clearTimeout(timer);
    }
    const result = await Effect.runPromise(
      client.jobs.get({ params: { jobId: accepted.job!.jobId } }),
    );
    expect(result.stage).toBe("succeeded");
    expect(result.counters.launches).toBe(1);
    expect(result.receipt?.noteIds.length).toBe(1);
    expect(result.warnings).toContain("Synthetic evidence; no live provider.");
    await Effect.runPromise(client.jobs.revokeCredential({ payload: { identityId: runnerId } }));
    expect(
      (
        await fetch(service.url + "/internal/v1/jobs/claim", {
          method: "POST",
          headers: { authorization: `Bearer ${runner}`, "content-type": "application/json" },
          body: JSON.stringify({ requestId: randomUUID(), instanceId: randomUUID() }),
        })
      ).status,
    ).toBe(401);
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 45000);

for (const scenario of [
  "cancel-before-intent",
  "cancel-after-intent",
  "revoke-before-intent",
] as const) {
  test(`job HTTP publication fence: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-job-fence-"));
    const operator = `wk_${randomBytes(32).toString("base64url")}`;
    const runner = `wk_${randomBytes(32).toString("base64url")}`;
    const runnerId = randomUUID();
    const credentialsPath = join(root, "credentials.json");
    const runnerPath = join(root, "runner-token");
    const data = join(root, "service");
    await writeFile(
      credentialsPath,
      JSON.stringify({
        credentials: [
          { identityId: randomUUID(), role: "operator", token: operator },
          { identityId: runnerId, role: "runner", token: runner },
        ],
      }),
      { mode: 0o600 },
    );
    await writeFile(runnerPath, runner, { mode: 0o600 });
    const fault = scenario === "cancel-after-intent" ? "committing" : "prepared";
    const service = await launch(
      data,
      {
        WIKI_MACHINE_CREDENTIALS_FILE: credentialsPath,
        WIKI_TEST_FAULT: fault,
        WIKI_TEST_PAUSE: "1",
      },
      true,
    );
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      const client = await Effect.runPromise(makeJobClient(service.url, operator));
      const accepted = await Effect.runPromise(
        client.jobs.submit({
          payload: {
            requestId: randomUUID(),
            mode: "save",
            url: "https://x.com/example/status/9501",
          },
        }),
      );
      child = Bun.spawn([process.execPath, "apps/runner/dist/synthetic.js"], {
        env: {
          PATH: process.env.PATH,
          WIKI_SERVICE_URL: service.url,
          WIKI_RUNNER_TOKEN_FILE: runnerPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      const marker = () => Bun.file(join(data, `fault-${fault}`)).exists();
      for (let i = 0; i < 500 && !(await marker()); i++) await Bun.sleep(20);
      expect(
        await marker(),
        child.exitCode === null
          ? JSON.stringify(
              await Effect.runPromise(client.jobs.get({ params: { jobId: accepted.job!.jobId } })),
            )
          : await errors,
      ).toBe(true);
      if (scenario === "revoke-before-intent")
        await Effect.runPromise(
          client.jobs.revokeCredential({ payload: { identityId: runnerId } }),
        );
      else {
        const cancelled = await Effect.runPromise(
          client.jobs.cancel({ payload: { requestId: randomUUID(), jobId: accepted.job!.jobId } }),
        );
        expect(cancelled.stage).toBe(
          scenario === "cancel-after-intent" ? "publishing" : "cancelled",
        );
      }
      await writeFile(join(data, `release-${fault}`), "continue");
      const code = await child.exited;
      const after = await Effect.runPromise(
        client.jobs.get({ params: { jobId: accepted.job!.jobId } }),
      );
      if (scenario === "cancel-after-intent") {
        expect(code, await errors).toBe(0);
        expect(after.stage).toBe("succeeded");
        expect(after.receipt?.noteIds.length).toBe(1);
      } else {
        expect(code, await output).not.toBe(0);
        expect(after.stage).toBe("cancelled");
        expect(after.receipt).toBeNull();
      }
      expect(after.counters.launches).toBe(1);
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      if (child) await child.exited;
      await service.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);
}
