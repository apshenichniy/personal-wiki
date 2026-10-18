import { Effect, Layer, Schedule } from "effect";
import { join } from "node:path";
import { ProviderLedger } from "../providers/ledger.ts";
import { JobProviders } from "../providers/jobs.ts";
import { Library } from "../storage/library.ts";
import { JobStore } from "./store.ts";
import { JobScheduler } from "./scheduler.ts";
import { Jobs } from "./service.ts";
import { JobExecution } from "./execution.ts";
import { JobLifecycle } from "./lifecycle.ts";
import { JobPublication } from "./publication.ts";
import { SourceResolution } from "./resolution.ts";
import { MachineCredentials } from "./credentials.ts";
export const jobRuntime = (
  root: string,
  provider?: { path: string; namespace: "staging" | "production" },
) => {
  const storage = JobStore.layer.pipe(Layer.provideMerge(Library.layer(root)));
  const scheduled = JobScheduler.layer(root).pipe(Layer.provideMerge(storage));
  const jobs = Jobs.layer(root).pipe(Layer.provideMerge(scheduled));
  const runtime = Layer.mergeAll(
    SourceResolution.layer,
    JobExecution.layer,
    JobLifecycle.layer,
    JobPublication.layer,
    MachineCredentials.layer,
    JobProviders.layer(provider?.namespace ?? "staging", provider !== undefined),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        jobs,
        ProviderLedger.layer(provider?.path ?? join(root, "disabled-provider-accounting.sqlite")),
      ),
    ),
  );
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const lifecycle = yield* JobLifecycle;
      // Finish startup revocation before listening. A surviving Runner never
      // inherits an old execution epoch merely because its lease has time left.
      yield* lifecycle.sweep(true);
      yield* lifecycle
        .sweep()
        .pipe(Effect.repeat({ schedule: Schedule.spaced("250 millis") }), Effect.forkScoped);
    }),
  ).pipe(Layer.provideMerge(runtime));
};
