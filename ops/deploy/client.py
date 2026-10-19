#!/usr/bin/env python3
"""Unprivileged CLI; uploads stdin and never accepts a remote command or path."""
import json
import socket
import sys


def main():
    action, op_id, *args = sys.argv[1:]
    if action == "install":
        target, revision, digest, size = args
        # Attestation is the first stdin line; the remaining bytes are the archive.
        bundle = sys.stdin.buffer.readline(512 * 1024 + 1).decode()
        header = {"action": action, "request": {"operationId": op_id, "operation": action,
                  "target": target, "revision": revision, "digest": digest}, "size": int(size), "bundle": bundle}
    elif action == "rollback":
        header = {"action": action, "operationId": op_id, "target": args[0]}
    elif action in ("status", "resume") and not args:
        header = {"action": action, "operationId": op_id}
    else:
        raise ValueError("Unsupported operation")
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(90)
        connection.connect("/run/personal-wiki-deploy/control.sock")
        file = connection.makefile("rwb")
        file.write(json.dumps(header).encode() + b"\n")
        file.flush()
        result = json.loads(file.readline())
        if result.get("send"):
            remaining = int(size)
            while remaining:
                chunk = sys.stdin.buffer.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError("Incomplete archive")
                file.write(chunk)
                remaining -= len(chunk)
            file.flush()
            result = json.loads(file.readline())
        print(json.dumps(result))
        if "error" in result or result.get("phase") == "failed":
            return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, IndexError):
        sys.exit("Deployment request failed; reconcile using its operation ID.")
