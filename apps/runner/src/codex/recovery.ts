import { Effect } from "effect";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeJobClient } from "@personal-wiki/client";
import { savedResult, type CodexRuntime } from "./execute.ts";
import { failure } from "./profile.ts";

export function inspectExecution(runtime: CodexRuntime, directory: string) {
  return Effect.tryPromise({
    try: () =>
      new Promise<"stopped" | "not_started" | "running" | "unknown">((resolve) => {
        const child = spawn(
          runtime.python,
          [join(dirname(runtime.guardian), "inspect-agent.py"), runtime.slotDirectory, directory],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        let output = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve("unknown");
        }, 5000);
        child.stdout.on("data", (part) => {
          if (output.length < 1024) output += part.toString();
          else child.kill("SIGKILL");
        });
        child.once("error", () => {
          clearTimeout(timer);
          resolve("unknown");
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          try {
            const status = JSON.parse(output).status;
            resolve(
              code === 0 && ["stopped", "not_started", "running"].includes(status)
                ? status
                : "unknown",
            );
          } catch {
            resolve("unknown");
          }
        });
      }),
    catch: () => failure("ownership"),
  });
}

// Run before claiming work, under the lifetime host supervisor lock. A live
// lease or an unconfirmed process tree blocks replacement across all providers.
export function recoverExecutions(
  client: Effect.Success<ReturnType<typeof makeJobClient>>,
  runtime: CodexRuntime,
  instanceId: string,
) {
  return Effect.gen(function* () {
    const recovered = [];
    let unresolved = 0;
    for (const pending of yield* client.worker.pendingExecutions()) {
      if (pending.leaseActive) {
        unresolved++;
        continue;
      }
      const directory = join(runtime.spool, pending.job.jobId, pending.attempt.attemptId);
      const status = yield* inspectExecution(runtime, directory);
      if (status === "unknown" || status === "running") {
        unresolved++;
        continue;
      }
      // Cancellation and expiry take precedence over retained model output.
      const stoppedByOwner =
        pending.stopRequested ||
        (pending.job.deadline !== null && Date.parse(pending.job.deadline) <= Date.now());
      const result = stoppedByOwner
        ? null
        : yield* Effect.tryPromise({
            try: () => savedResult(directory, pending.attempt, pending.attempt.inputDigest),
            catch: () => failure("storage"),
          });
      if (
        result &&
        pending.job.stage === "blocked" &&
        pending.job.reason === "process_ownership_unknown"
      ) {
        const scope = { jobId: pending.job.jobId, epoch: pending.epoch, instanceId };
        const job = yield* client.worker.recoverAttempt({
          payload: {
            requestId: randomUUID(),
            scope,
            attemptId: pending.attempt.attemptId,
            processStopped: true,
            outcome: result.outcome,
            output: result.output,
            completedAt: new Date(result.manifest.completedAt).toISOString(),
          },
        });
        recovered.push({ job, scope });
      } else {
        yield* client.worker.settleExecution({
          payload: { jobId: pending.job.jobId, epoch: pending.epoch, processStopped: true },
        });
      }
    }
    return { recovered, unresolved };
  });
}
