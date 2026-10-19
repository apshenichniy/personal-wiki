import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Boundary {
  binary: string;
  workspace: string;
  codexHome: string;
  input: string;
  args: readonly string[];
}
// All paths are created by the trusted adapter, never selected by source text.
export async function sandboxCommand(boundary: Boundary, platform = process.platform) {
  const binary = await realpath(boundary.binary);
  const workspace = await realpath(boundary.workspace);
  const home = await realpath(boundary.codexHome);
  if (platform === "darwin") {
    const literal = (value: string) => JSON.stringify(value);
    const profile = `(version 1)
(deny default)
(allow sysctl-read)

(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.networkd") (global-name "com.apple.bsd.dirhelper"))
(allow network*)
(allow file-map-executable)
(allow mach-lookup (global-name "com.apple.dyld"))
(allow file-read-metadata)
(allow file-read* (vnode-type DIRECTORY))
(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/private/etc") (subpath "/etc") (subpath "/private/preboot") (subpath "/private/var/db/dyld") (subpath "/Library/Apple") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal ${literal(binary)}) (literal ${literal(await realpath(boundary.input))}) (subpath ${literal(workspace)}) (subpath ${literal(home)}))
(allow file-write* (subpath ${literal(workspace)}) (subpath ${literal(home)}) (literal "/dev/null"))
(allow process-exec (literal ${literal(binary)}) (subpath "/usr/lib") (subpath "/System"))
(allow signal (target self))
(deny process-fork)
`;
    const profilePath = join(workspace, "boundary.sb");
    await writeFile(profilePath, profile, { mode: 0o600 });
    return ["/usr/bin/sandbox-exec", "-f", profilePath, binary, ...boundary.args];
  }
  if (platform === "linux") {
    // Only runtime libraries, trusted binary, auth-only home and this job are
    // mounted. Private PID/user/mount namespaces hide host credentials/processes.
    return [
      "/usr/bin/bwrap",
      "--unshare-all",
      "--share-net",
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/usr",
      "/usr",
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "usr/lib",
      "/lib",
      "--symlink",
      "usr/lib64",
      "/lib64",
      "--dir",
      "/etc",
      "--ro-bind",
      "/etc/ssl",
      "/etc/ssl",
      "--ro-bind",
      "/etc/resolv.conf",
      "/etc/resolv.conf",
      "--ro-bind",
      "/etc/hosts",
      "/etc/hosts",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      binary,
      binary,
      "--bind",
      workspace,
      workspace,
      "--bind",
      home,
      home,
      "--ro-bind",
      boundary.input,
      boundary.input,
      "--chdir",
      workspace,
      "--",
      binary,
      ...boundary.args,
    ];
  }
  throw new Error("No verified Codex boundary for this platform");
}
