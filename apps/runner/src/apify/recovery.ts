import { Effect, Schema } from "effect";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { makeJobClient } from "@personal-wiki/client";
import * as P from "@personal-wiki/contracts/provider";
import { makeServiceAcquisition } from "./service.ts";
import { makeRetention, recoverProviderDebt } from "./retention.ts";
import type { makeApifyHttp } from "./http.ts";
class AccountingUnsettled extends Schema.TaggedError<AccountingUnsettled>()(
  "AccountingUnsettled",
  {},
) {}

export function makeProviderRecovery(options: {
  client: Effect.Success<ReturnType<typeof makeJobClient>>;
  http: ReturnType<typeof makeApifyHttp>;
  spool: string;
}) {
  const { client, http } = options;
  return Effect.fn("Runner.recoverProviderObligations")(function* () {
    let unresolved = 0;
    let retentionPending = 0;
    let accountingPending = 0;
    for (let operation of yield* client.providers.pending()) {
      const spool = join(options.spool, operation.job.jobId);
      yield* Effect.tryPromise(() => mkdir(spool, { recursive: true, mode: 0o700 }));
      const service = makeServiceAcquisition({ client, http, spool });
      operation = yield* service.recover(operation);
      const inspection = yield* client.providers.inspect({
        payload: { jobId: operation.job.jobId },
      });
      operation = inspection.operations.find(
        (value) => value.operationId === operation.operationId,
      )!;
      // A reservation has not issued a dispatch permit. It can be resumed by a
      // new owner or closed by inspection; neither case is an unknown POST.
      if (operation.phase === "reserved" || operation.phase === "closed") continue;
      if (!operation.run) {
        unresolved++;
        continue;
      }
      if (!P.terminal(operation.status) && !inspection.shouldStop) {
        unresolved++;
        continue;
      }
      if (!P.terminal(operation.status))
        operation = (yield* service.stop(operation, Date.now() + 15_000)).operation;
      for (let poll = 0; !P.terminal(operation.status) && poll < 30; poll++) {
        yield* Effect.sleep("1 second");
        operation = (yield* service.refresh(operation, Date.now() + 15_000)).operation;
      }
      if (!P.terminal(operation.status)) {
        unresolved++;
        continue;
      }
      if (!operation.archived) {
        const recovered = yield* recoverProviderDebt(
          spool,
          operation,
          "retention",
          makeRetention({ client, http, spool: join(spool, "raw") })(
            operation,
            Date.now() + 120_000,
          ),
          Date.now(),
        );
        operation = recovered.operation;
        if (recovered.deferred) retentionPending++;
      }
      if (!operation.costStable) {
        const accounting = yield* recoverProviderDebt(
          spool,
          operation,
          "accounting",
          Effect.gen(function* () {
            let current = (yield* service.refresh(operation, Date.now() + 15_000)).operation;
            if (!current.costStable) {
              yield* Effect.sleep("11 seconds");
              current = (yield* service.refresh(current, Date.now() + 15_000)).operation;
            }
            if (!current.costStable) return yield* new AccountingUnsettled();
            return current;
          }),
          Date.now(),
        );
        if (accounting.deferred) accountingPending++;
      }
    }
    return { unresolved, retentionPending, accountingPending };
  });
}
