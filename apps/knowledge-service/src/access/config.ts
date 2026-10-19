import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Effect, Schema } from "effect";
import { JobError } from "../jobs/policy.ts";

export const AccessConfiguration = Schema.Struct({
  publicOrigin: Schema.String,
  issuer: Schema.String,
  ownerSubject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  clientId: Schema.String.check(Schema.isMinLength(1)),
  clientSecret: Schema.String.check(Schema.isMinLength(1)),
  signingAlgorithm: Schema.Literals(["RS256", "ES256"]),
});
export type AccessConfiguration = typeof AccessConfiguration.Type;

export function validateConfiguration(input: unknown): AccessConfiguration {
  const config = Schema.decodeUnknownSync(AccessConfiguration)(input);
  for (const [name, value] of [
    ["publicOrigin", config.publicOrigin],
    ["issuer", config.issuer],
  ]) {
    const url = new URL(value!);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (name === "publicOrigin" && value !== url.origin) ||
      (name === "issuer" && url.pathname.includes(".well-known"))
    )
      throw new Error("An exact HTTPS origin and OIDC issuer are required.");
  }
  return config;
}

export const loadAccessConfiguration = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(path))
        throw new JobError({ code: "unavailable", message: "Absolute path required." });
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16_384)
          throw new JobError({ code: "unavailable", message: "Private configuration required." });
        return validateConfiguration(JSON.parse(await file.readFile("utf8")));
      } finally {
        await file.close();
      }
    },
    catch: () =>
      new JobError({
        code: "unavailable",
        message: "Private owner access configuration is invalid.",
      }),
  });
