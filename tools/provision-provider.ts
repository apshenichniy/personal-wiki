// Trusted operator command. Never a Runner API or a new allowance per namespace.
import { Console, Effect, Schema } from "effect";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ProviderLedger, Baseline } from "../apps/knowledge-service/src/providers/ledger.ts";
import { Profile } from "@personal-wiki/contracts/provider";
const Input = Schema.Struct({
  ledgerFile: Schema.String,
  profile: Profile,
  baselines: Schema.Array(Baseline),
});
const program = Effect.gen(function* () {
  const path = process.argv[2];
  if (!path || !isAbsolute(path))
    return yield* Effect.die("Absolute private provisioning input required");
  const bytes = yield* Effect.tryPromise(async () => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65_536)
        throw new Error("Private input required");
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  });
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Input))(bytes);
  if (!isAbsolute(input.ledgerFile)) return yield* Effect.die("Absolute accounting path required");
  yield* Effect.gen(function* () {
    yield* (yield* ProviderLedger).provision(input.profile, input.baselines);
  }).pipe(Effect.provide(ProviderLedger.layer(input.ledgerFile)));
  yield* Console.log(JSON.stringify({ status: "provisioned", baselines: input.baselines.length }));
}).pipe(
  Effect.catchCause(() =>
    Console.log(JSON.stringify({ status: "failed", code: "provisioning_failed" })).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
);
await Effect.runPromise(program);
