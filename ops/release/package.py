#!/usr/bin/env python3
"""Build a self-contained, deterministic release. No dependencies install on CX33."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def package(root, output):
    policy = json.loads((root / "ops/release/policy.json").read_text())
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ValueError("Releases must be built on Linux/amd64")
    revision = run("git", "rev-parse", "HEAD")
    if run("git", "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Release checkout must be clean")
    bun = Path(shutil.which("bun")).resolve()
    if run(str(bun), "--version") != policy["bun"]:
        raise ValueError("Pinned Bun is required")
    build = output / "payload"
    if build.exists():
        shutil.rmtree(build)
    build.mkdir(parents=True)
    # Bundle dependencies into each process. There is no node_modules resolver,
    # package-manager bootstrap, synthetic Runner, or test source on the server.
    for entry, name in [("apps/knowledge-service/src/index.ts", "service.js"),
                        ("apps/runner/src/run.ts", "runner.js"),
                        ("tools/provision-provider.ts", "provision-provider.js"),
                        ("tools/revoke-owner-sessions.ts", "revoke-owner-sessions.js"),
                        ("tools/check-archive.ts", "check-archive.js")]:
        subprocess.run([str(bun), "build", entry, "--target=bun", f"--outfile={build / name}"], check=True)
    shutil.copyfile(bun, build / "bun")
    (build / "bun").chmod(0o755)
    for name in ["locked-service.py", "locked-runner.py", "agent-guard.py", "inspect-agent.py"]:
        shutil.copyfile(root / "tools/runtime" / name, build / name)
    shutil.copyfile(root / "skills/knowledge/curate-x/SKILL.md", build / "curate-x.md")
    shutil.copytree(root / "apps/web/dist", build / "web")
    files = {}
    for file in sorted(build.rglob("*")):
        if file.is_file():
            files[str(file.relative_to(build))] = hashlib.sha256(file.read_bytes()).hexdigest()
    manifest = {**policy, "revision": revision, "lockDigest": hashlib.sha256((root / "bun.lock").read_bytes()).hexdigest(),
                "files": files, "builtAt": run("git", "show", "-s", "--format=%cI", "HEAD")}
    (build / "release.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    archive = output / "personal-wiki.tar.gz"
    with archive.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as compressed, tarfile.open(fileobj=compressed, mode="w|") as tar:
        for file in sorted(build.rglob("*")):
            if not file.is_file():
                continue
            data = file.read_bytes()
            info = tarfile.TarInfo(str(file.relative_to(build)))
            info.size = len(data)
            info.mode = 0o755 if file.name == "bun" else 0o644
            tar.addfile(info, io.BytesIO(data))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / "identity.json").write_text(json.dumps({"revision": revision, "digest": digest, "size": archive.stat().st_size}) + "\n")
    print(json.dumps({"revision": revision, "digest": digest, "bytes": archive.stat().st_size}))


if __name__ == "__main__":
    package(Path.cwd(), Path(sys.argv[1]).resolve())
