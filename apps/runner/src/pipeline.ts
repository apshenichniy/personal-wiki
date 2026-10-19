import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import type { makeJobClient } from "@personal-wiki/client";
import type { Claim, JobView } from "@personal-wiki/contracts/jobs";
import type { makeApifyHttp } from "./apify/http.ts";
import { makeProviderRecovery } from "./apify/recovery.ts";
import { ingestX } from "./apify/ingest.ts";
import { recoverExecutions } from "./codex/recovery.ts";
import type { CodexRuntime } from "./codex/execute.ts";
import { curateClaim } from "./curation.ts";

type Client = Effect.Success<ReturnType<typeof makeJobClient>>;
// Drive a single owned stage; the Service remains the only state/launch authority.
export function advanceClaim(options: {
  client: Client;
  claim: NonNullable<typeof Claim.Type>;
  acquire: () => Effect.Effect<typeof JobView.Type, unknown>;
  curate: () => Effect.Effect<typeof JobView.Type, unknown>;
}) {
  const { client, claim } = options;
  const stage = claim.job.stage;
  const work =
    stage === "acquiring"
      ? options.acquire()
      : stage === "prepared"
        ? options.curate()
        : stage === "validating"
          ? client.worker.publish({ payload: { requestId: randomUUID(), scope: claim.scope } })
          : Effect.succeed(claim.job);
  const heartbeat = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("5 seconds");
      yield* client.worker
        .heartbeat({ payload: { requestId: randomUUID(), scope: claim.scope } })
        .pipe(Effect.timeout("10 seconds"));
    }
  });
  return work.pipe(Effect.raceFirst(heartbeat));
}
export function makePipeline(options: {
  client: Client;
  http: ReturnType<typeof makeApifyHttp>;
  spool: string;
  runtime: CodexRuntime;
  skillFile: string;
  instanceId: string;
}) {
  const { client, http, runtime, instanceId } = options;
  const recoverProvider = makeProviderRecovery({ client, http, spool: options.spool });
  return Effect.fn("Runner.tick")(function* () {
    const executions = yield* recoverExecutions(client, runtime, instanceId);
    if (executions.unresolved) return { status: "blocked", reason: "execution_recovery" };
    // Complete recovered curation/publication first. Provider debt cannot turn
    // an already retained capture into a new acquisition.
    const claim = yield* client.worker.claim({ payload: { requestId: randomUUID(), instanceId } });
    if (claim) {
      const job = yield* advanceClaim({
        client,
        claim,
        acquire: () =>
          Effect.gen(function* () {
            const debt = yield* recoverProvider();
            if (debt.unresolved) return claim.job;
            return yield* ingestX({ client, http, spool: options.spool, claim });
          }),
        curate: () => curateClaim({ client, runtime, claim, skillFile: options.skillFile }),
      });
      return { status: job.stage, jobId: job.jobId };
    }
    const debt = yield* recoverProvider();
    return { status: debt.unresolved ? "blocked" : "idle", ...debt };
  });
}
