// Read-only verification immediately after a controlled, budgeted Actor start.
// This tool cannot harden an already-public run and call that private creation.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Schema } from "effect";
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));
const Input = Schema.Struct({
  tokenFile: Schema.String,
  runId: Identifier,
  actorId: Identifier,
  buildId: Identifier,
  startedAfter: Schema.Number,
  evidenceFile: Schema.String,
});
async function privateText(path: string) {
  if (!isAbsolute(path)) throw new Error("Private absolute path required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16_384)
      throw new Error("Private regular input required");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
async function read(path: string, token?: string) {
  const response = await fetch(`https://api.apify.com/v2/${path}`, {
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!token) {
    await response.body?.cancel();
    return { status: response.status, data: null };
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Authenticated metadata unavailable");
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1_048_576) throw new Error("Metadata capacity exceeded");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  const data = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) }),
  )(value).data;
  return { status: response.status, data };
}
try {
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(
    await privateText(process.argv[2] ?? ""),
  );
  const token = (await privateText(input.tokenFile)).trim();
  const response = await read(`actor-runs/${input.runId}`, token);
  const run = response.data!;
  if (
    run.id !== input.runId ||
    run.actId !== input.actorId ||
    run.buildId !== input.buildId ||
    run.generalAccess !== "RESTRICTED" ||
    typeof run.startedAt !== "string" ||
    !Number.isFinite(Date.parse(run.startedAt)) ||
    Date.parse(run.startedAt) < input.startedAfter - 10_000 ||
    Date.now() - Date.parse(run.startedAt) > 300_000
  )
    throw new Error("Fresh restricted run identity was not verified");
  const checks: Array<{ resource: string; anonymousStatus: number; restrictedMetadata: boolean }> =
    [];
  const resources = [
    ["actor-runs", input.runId],
    ["datasets", run.defaultDatasetId],
    ["key-value-stores", run.defaultKeyValueStoreId],
    ["request-queues", run.defaultRequestQueueId],
  ] as const;
  for (const [kind, rawId] of resources) {
    const id = Schema.decodeUnknownSync(Identifier)(rawId);
    const path = `${kind}/${id}`;
    const authenticated = kind === "actor-runs" ? response : await read(path, token);
    if (authenticated.data?.generalAccess !== "RESTRICTED")
      throw new Error("Storage privacy metadata was not verified");
    const anonymous = await read(path);
    if (![401, 403, 404].includes(anonymous.status))
      throw new Error("Anonymous denial was not verified");
    checks.push({ resource: kind, anonymousStatus: anonymous.status, restrictedMetadata: true });
  }
  if (!isAbsolute(input.evidenceFile)) throw new Error("Private evidence path required");
  const file = await open(
    input.evidenceFile,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          runId: input.runId,
          actorId: input.actorId,
          buildId: input.buildId,
          startedAt: run.startedAt,
          checkedWithinSeconds: (Date.now() - Date.parse(run.startedAt as string)) / 1000,
          noPrivacyMutations: true,
          checks,
        },
        null,
        2,
      ),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  console.log(
    JSON.stringify({
      status: "passed",
      resources: checks.length,
      freshRestrictedRun: true,
      noPrivacyMutations: true,
    }),
  );
} catch {
  console.log(JSON.stringify({ status: "failed", code: "private_creation_not_verified" }));
  process.exitCode = 1;
}
