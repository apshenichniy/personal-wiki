"""Signature policy and a bounded regular-file-only release format."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile

REPOSITORY = "apshenichniy/personal-wiki"
WORKFLOW = f"{REPOSITORY}/.github/workflows/release.yml"
MAX_ARCHIVE = 160 * 1024 * 1024
MAX_EXPANDED = 384 * 1024 * 1024
BASE_FILES = {"bun", "service.js", "runner.js", "provision-provider.js", "revoke-owner-sessions.js",
              "locked-service.py", "locked-runner.py", "agent-guard.py", "inspect-agent.py", "curate-x.md", "web/manifest.json", "release.json", "check-archive.js"}


def sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def identity(revision, digest):
    if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("invalid_revision")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("invalid_digest")


def verify_provenance(archive, bundle, revision, digest, gh):
    identity(revision, digest)
    if archive.stat().st_size > MAX_ARCHIVE or sha256(archive) != digest:
        raise ValueError("digest_mismatch")
    # Both certificate identity and revision/ref are constrained. A valid
    # signature from a different repo, PR, workflow or commit is insufficient.
    subprocess.run([str(gh), "attestation", "verify", str(archive), "--bundle", str(bundle),
                    "--repo", REPOSITORY, "--signer-workflow", WORKFLOW,
                    "--source-ref", "refs/heads/main", "--source-digest", revision,
                    "--signer-digest", revision, "--deny-self-hosted-runners"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90,
                   env={"PATH": "/usr/bin:/bin", "HOME": "/var/lib/personal-wiki-deploy"})


def unpack(archive, destination, revision):
    """Only called after signature verification, but still refuse links and paths."""
    files = {}
    total = 0
    with tarfile.open(archive, "r:gz") as tar:
        for entry in tar:
            name = entry.name
            if (name not in BASE_FILES and not re.fullmatch(r"web/main-[A-Za-z0-9_-]+\.(?:js|css)", name)) or name in files:
                raise ValueError("unexpected_release_path")
            if not entry.isfile() or entry.size < 0:
                raise ValueError("release_links_forbidden")
            total += entry.size
            if total > MAX_EXPANDED or len(files) >= 20:
                raise ValueError("release_capacity")
            files[name] = tar.extractfile(entry).read()
    if not BASE_FILES.issubset(files):
        raise ValueError("incomplete_release")
    manifest = json.loads(files["release.json"])
    if (manifest.get("format") != 1 or manifest.get("revision") != revision or
        manifest.get("platform") != "linux-amd64" or manifest.get("bun") != "1.3.13" or
        manifest.get("schema") != {"target": 7, "readableMin": 7, "readableMax": 7}):
        raise ValueError("unsupported_release")
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items() if name != "release.json"}
    if manifest.get("files") != hashes:
        raise ValueError("release_file_mismatch")
    destination.mkdir(mode=0o755)
    for name, data in files.items():
        path = destination / name
        path.parent.mkdir(mode=0o755, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o755 if name == "bun" else 0o644)
    return manifest
