import { Effect, Layer, Schedule } from "effect";
import { Library } from "../storage/library.ts";
import { JobStore } from "./store.ts";
import { JobScheduler } from "./scheduler.ts";
import { Jobs } from "./service.ts";
import { JobExecution } from "./execution.ts";
import { JobLifecycle } from "./lifecycle.ts";
import { JobPublication } from "./publication.ts";
import { SourceResolution } from "./resolution.ts";
import { MachineCredentials } from "./credentials.ts";
export const jobRuntime = (root: string) => {
  const storage = JobStore.layer.pipe(Layer.provideMerge(Library.layer(root)));
  const scheduled = JobScheduler.layer(root).pipe(Layer.provideMerge(storage));
  const jobs = Jobs.layer(root).pipe(Layer.provideMerge(scheduled));
  const runtime = Layer.mergeAll(
    SourceResolution.layer,
    JobExecution.layer,
    JobLifecycle.layer,
    JobPublication.layer,
    MachineCredentials.layer,
  ).pipe(Layer.provideMerge(jobs));
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
