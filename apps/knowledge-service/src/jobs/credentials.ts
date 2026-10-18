import { Config, Context, Effect, Layer, Schema } from "effect";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Id } from "@personal-wiki/contracts/knowledge";
import { digest } from "../storage/io.ts";
import { JobStore } from "./store.ts";
import { JobError } from "./policy.ts";
const CredentialsFile = Schema.Struct({
  credentials: Schema.Array(
    Schema.Struct({
      identityId: Id,
      role: Schema.Literals(["runner", "operator"]),
      token: Schema.String.check(Schema.isPattern(/^wk_[A-Za-z0-9_-]{43}$/)),
    }),
  ).check(Schema.isMaxLength(16)),
});
export const makeCredentials = Effect.gen(function* () {
  const store = yield* JobStore;
  const sql = store.sql;
  const path = yield* Config.String("WIKI_MACHINE_CREDENTIALS_FILE").pipe(Config.withDefault(""));
  if (path) {
    const configured = yield* Effect.tryPromise({
      try: async () => {
        if (!isAbsolute(path)) throw new Error("Absolute private path required");
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16384)
            throw new Error("Private credential file required");
          return Schema.decodeUnknownSync(Schema.fromJsonString(CredentialsFile))(
            await file.readFile("utf8"),
          );
        } finally {
          await file.close();
        }
      },
      catch: () =>
        new JobError({
          code: "unavailable",
          message: "Machine credential configuration is invalid.",
        }),
    });
    yield* store.transaction(
      Effect.gen(function* () {
        yield* store.assertOwner();
        for (const credential of configured.credentials) {
          const existing = (yield* sql<{
            verifier: string;
            role: string;
          }>`SELECT verifier,role FROM machine_credentials WHERE identity_id=${credential.identityId}`)[0];
          const verifier = digest(credential.token);
          if (existing && (existing.verifier !== verifier || existing.role !== credential.role))
            return yield* new JobError({
              code: "unavailable",
              message: "Credential identity was reused with different authorization.",
            });
          // Restart must never restore a revoked identity. Rotation uses a new ID.
          yield* sql`INSERT INTO machine_credentials(identity_id,verifier,role) VALUES(${credential.identityId},${verifier},${credential.role}) ON CONFLICT(identity_id) DO NOTHING`;
        }
      }),
    );
  }
  const authenticate = Effect.fn("Credentials.authenticate")(function* (
    authorization: string | undefined,
  ) {
    if (!authorization || !/^Bearer wk_[A-Za-z0-9_-]{43}$/.test(authorization))
      return yield* new JobError({ code: "unauthenticated", message: "Authentication required." });
    const credential = (yield* sql<{
      identity_id: string;
      role: string;
    }>`SELECT identity_id,role FROM machine_credentials WHERE verifier=${digest(authorization.slice(7))} AND revoked=0`)[0];
    if (!credential || !["runner", "operator"].includes(credential.role))
      return yield* new JobError({ code: "unauthenticated", message: "Authentication required." });
    return { identityId: credential.identity_id, role: credential.role };
  });
  const revoke = (identityId: string) =>
    store.transaction(
      Effect.gen(function* () {
        yield* store.assertOwner();
        yield* sql`UPDATE machine_credentials SET revoked=1 WHERE identity_id=${identityId}`;
      }),
    );
  return { authenticate, revoke };
});
export class MachineCredentials extends Context.Service<
  MachineCredentials,
  Effect.Success<typeof makeCredentials>
>()("personal-wiki/MachineCredentials") {
  static layer = Layer.effect(MachineCredentials, makeCredentials);
}
