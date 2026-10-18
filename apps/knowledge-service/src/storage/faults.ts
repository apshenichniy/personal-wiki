import { access, open } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { io } from "./io.ts";

/** Process-local test configuration; never accepted from a request or source text. */
export const publicationFault = (root: string, point: string) =>
  Effect.gen(function* () {
    if (process.env.WIKI_TEST_FAULT !== point) return;
    const first = yield* io(async () => {
      try {
        const marker = await open(join(root, `fault-${point}`), "wx", 0o600);
        await marker.writeFile(String(process.pid));
        await marker.sync();
        await marker.close();
        return true;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        )
          return false;
        throw error;
      }
    });
    if (!first) return;
    if (process.env.WIKI_TEST_PAUSE === "1") {
      while (
        !(yield* io(() =>
          access(join(root, `release-${point}`)).then(
            () => true,
            () => false,
          ),
        ))
      )
        yield* Effect.sleep("10 millis");
    } else {
      yield* Effect.sync(() => process.kill(process.pid, "SIGKILL"));
      return yield* Effect.never;
    }
  });
