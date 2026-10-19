#!/usr/bin/env python3
"""CI-side transport only. The host verifies policy again before installation."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def ssh(host, args, **options):
    # Every argument is a validated enum, UUID, hex digest, integer or fixed word.
    return subprocess.run(["tailscale", "ssh", f"wiki-deploy@{host}", "wiki-deployctl " + " ".join(args)], **options)


def main():
    directory = Path(sys.argv[1])
    target = sys.argv[2]
    if target not in ("staging", "production"):
        raise ValueError("Unknown target")
    metadata = json.loads((directory / "identity.json").read_text())
    host = os.environ["CI_VPS_HOST"]
    # Rerunning a job for the same artifact/target uses the same durable operation.
    op_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'personal-wiki:{target}:{metadata["digest"]}:{os.environ["GITHUB_RUN_ID"]}'))
    print(f"Deployment operation: {op_id}", flush=True)
    bundle = json.dumps(json.loads((directory / "attestation.json").read_text()), separators=(",", ":")).encode() + b"\n"
    upload = directory / "upload.stream"
    with upload.open("wb") as file:
        file.write(bundle)
        with (directory / "personal-wiki.tar.gz").open("rb") as source:
            import shutil
            shutil.copyfileobj(source, file)
    with upload.open("rb") as file:
        sent = ssh(host, ["install", op_id, target, metadata["revision"], metadata["digest"], str(metadata["size"])], stdin=file, capture_output=True, timeout=180)
    upload.unlink()
    # Lost transport acknowledgement is not another installation. Query the ID.
    for _ in range(120):
        result = ssh(host, ["status", op_id], capture_output=True, text=True, timeout=30)
        try:
            value = json.loads(result.stdout)
        except ValueError:
            time.sleep(3)
            continue
        if value.get("phase") == "complete":
            print(json.dumps(value), flush=True)
            return
        if value.get("phase") == "failed":
            print(json.dumps(value), flush=True)
            raise SystemExit("Deployment blocked; resume this operation after resolving its reported cause")
        time.sleep(3)
    raise SystemExit(f"Deployment acknowledgement unavailable; reconcile operation {op_id}")


if __name__ == "__main__":
    main()
