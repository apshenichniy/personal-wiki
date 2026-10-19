import { Clock, Console, Effect } from "effect";
import { ProviderLedger } from "../../apps/knowledge-service/src/providers/ledger.ts";
const path = process.env.WIKI_TEST_LEDGER;
const jobId = process.env.WIKI_TEST_JOB;
const key = process.env.WIKI_TEST_PLAN;
const startedAt = Number(process.env.WIKI_TEST_STARTED);
if (!path || !jobId || !key || !Number.isSafeInteger(startedAt))
  throw new Error("Synthetic probe configuration required");
const program = Effect.gen(function* () {
  const ledger = yield* ProviderLedger;
  const result = yield* ledger
    .reserve({
      job: {
        jobId,
        namespace: key === "production" ? "production" : "staging",
        startedAt,
        deadline: startedAt + 300_000,
      },
      planKey: key,
      inputJson: "{}",
      chargeNanos: 149_500_000,
      platformNanos: 0,
      retrievalNanos: 500_000,
      replacementOf: null,
    })
    .pipe(Effect.result);
  if (result._tag === "Failure") {
    yield* Console.log(
      JSON.stringify({
        outcome: "rejected",
        code: "code" in result.failure ? result.failure.code : "unexpected",
      }),
    );
    return;
  }
  if (process.env.WIKI_TEST_MODE === "crash") {
    const permit = yield* ledger.beginDispatch(result.success.operationId);
    yield* Console.log(
      JSON.stringify({
        outcome: "dispatching",
        operationId: permit.operationId,
        at: yield* Clock.currentTimeMillis,
      }),
    );
    return yield* Effect.never;
  } else
    yield* Console.log(
      JSON.stringify({ outcome: "reserved", operationId: result.success.operationId }),
    );
});
await Effect.runPromise(program.pipe(Effect.provide(ProviderLedger.layer(path))));
