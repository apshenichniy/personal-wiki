import { Effect } from "effect";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ArchiveError, type ObjectIdentity } from "./raw-archive.ts";
import { digest } from "./io.ts";

/** Explicit disaster-recovery mode. No primary bucket or writable archive fallback. */
export const recoveryArchive = (root: string) => {
  const read = (object: ObjectIdentity) =>
    Effect.tryPromise({
      try: async () => {
        if (
          !isAbsolute(root) ||
          !/^[a-f0-9]{64}$/.test(object.sha256) ||
          !Number.isSafeInteger(object.byteLength) ||
          object.byteLength < 1 ||
          object.byteLength > 16_777_216
        )
          throw new Error("Invalid recovery object");
        const directory = await lstat(root);
        if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077)
          throw new Error("Private recovery directory required");
        const file = await open(
          join(root, object.sha256),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size !== object.byteLength)
            throw new Error("Recovery size differs");
          const bytes = await file.readFile();
          if (digest(bytes) !== object.sha256) throw new Error("Recovery checksum differs");
          return bytes;
        } finally {
          await file.close();
        }
      },
      catch: () =>
        new ArchiveError({
          code: "unavailable",
          message: "Verified recovery bytes are unavailable.",
        }),
    });
  return {
    read,
    retain: (_object: ObjectIdentity, _bytes: Uint8Array) =>
      Effect.fail(
        new ArchiveError({ code: "unavailable", message: "Recovery archive is read-only." }),
      ),
    assertPrivate: (object: ObjectIdentity) => read(object).pipe(Effect.asVoid),
  };
};
