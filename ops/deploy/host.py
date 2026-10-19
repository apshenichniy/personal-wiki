"""Host operations have fixed paths/units; no request supplies a command."""
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from artifact import verify_provenance
from state import exclusive, schema_version

ROOT = Path("/var/lib/personal-wiki-deploy")
RELEASES = Path("/opt/personal-wiki/releases")
SLOT = Path("/var/lib/personal-wiki-runner/agent-slot")
GH = Path("/opt/personal-wiki-tools/gh/2.101.0/bin/gh")


def run(*command, timeout=120):
    return subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)


def target_data(target):
    return Path(f"/var/lib/personal-wiki-{target}")


class Host:
    def __init__(self):
        self.settings = json.loads(Path("/etc/personal-wiki/deploy/settings.json").read_text())

    def verify(self, archive, bundle, revision, digest):
        verify_provenance(archive, bundle, revision, digest, GH)

    def preflight(self, target, manifest):
        if Path("/var/lib/personal-wiki-backup/checkpoint-owner.json").exists():
            raise ValueError("backup_checkpoint_requires_recovery")
        config = Path(f"/etc/personal-wiki/deploy/{target}")
        for name in ("owner-access.json", "machine-credentials.json", "r2.json"):
            file = config / name
            if not file.is_file() or file.is_symlink() or file.stat().st_mode & 0o077:
                raise ValueError("private_configuration_required")
        if not SLOT.is_dir() or not GH.is_file():
            raise ValueError("host_prerequisite_missing")
        if self.settings["dispatchEnabled"][target]:
            for name in ("runner.json", "runner-token", "apify-token"):
                if not (config / name).is_file():
                    raise ValueError("runner_configuration_required")

    def stop_runners(self):
        for target in ("staging", "production"):
            run("systemctl", "stop", f"personal-wiki-runner@{target}.service")
        for target in ("staging", "production"):
            self.assert_unit_stopped(f"personal-wiki-runner@{target}.service")
        for name in ("supervisor.lock", "execution.lock"):
            with exclusive(SLOT / name, create=False):
                pass

    @staticmethod
    def assert_unit_stopped(unit):
        output = subprocess.check_output(["systemctl", "show", unit, "-p", "ActiveState", "-p", "ControlGroup"], text=True, timeout=10)
        values = dict(line.split("=", 1) for line in output.splitlines())
        if values.get("ActiveState") not in ("inactive", "failed"):
            raise ValueError("old_unit_not_stopped")
        group = values.get("ControlGroup")
        if group:
            path = Path("/sys/fs/cgroup") / group.lstrip("/")
            if path.exists():
                for processes in path.rglob("cgroup.procs"):
                    if processes.read_text().strip():
                        raise ValueError("old_processes_remain")

    def stop_service(self, target):
        run("systemctl", "stop", f"personal-wiki-service@{target}.service")
        self.assert_unit_stopped(f"personal-wiki-service@{target}.service")

    def assert_fenced(self, target):
        data = target_data(target)
        data.mkdir(exist_ok=True, mode=0o700)
        with exclusive(data / "publisher.lock", create=False):
            pass
        for name in ("supervisor.lock", "execution.lock"):
            with exclusive(SLOT / name, create=False):
                pass

    def schema(self, target):
        return schema_version(target_data(target))

    def checkpoint_identity(self, target):
        data = target_data(target)
        digest = hashlib.sha256()
        # After all unit cgroups and publisher children are stopped, include WAL
        # and operational spools. A database main file alone is not a cut.
        for file in sorted(data.rglob("*")):
            if file.is_symlink():
                raise ValueError("unexpected_state_symlink")
            if file.is_file() and file.name != "publisher.lock":
                digest.update(str(file.relative_to(data)).encode())
                with file.open("rb") as stream:
                    digest.update(hashlib.file_digest(stream, "sha256").digest())
        return digest.hexdigest()

    def prepare_recovery(self, op_id):
        run("systemctl", "start", f"personal-wiki-backup@{op_id}.service", timeout=3600)

    def checkpoint(self, phase):
        # Test doubles inject crashes here; production has no fault-injection flag.
        pass

    def start_service(self, target):
        run("systemctl", "start", f"personal-wiki-service@{target}.service")

    def readiness(self, target, release):
        settings = self.settings["targets"][target]
        config = Path(f"/etc/personal-wiki/deploy/{target}")
        credentials = json.loads((config / "machine-credentials.json").read_text())
        operator = next(c["token"] for c in credentials["credentials"] if c["role"] == "operator")
        worker = f'http://127.0.0.1:{settings["workerPort"]}'
        owner = f'http://127.0.0.1:{settings["ownerPort"]}'
        host = urllib.parse.urlparse(settings["publicOrigin"]).netloc
        for _ in range(40):
            try:
                request = urllib.request.Request(worker + "/api/v1/notes", headers={"authorization": "Bearer " + operator})
                with urllib.request.urlopen(request, timeout=3) as response:
                    result = json.load(response)
                    if not isinstance(result.get("appliedRevision"), str):
                        raise ValueError("private_read_not_ready")
                request = urllib.request.Request(owner + "/api/v1/notes", headers={"Host": host, "X-Forwarded-Proto": "https"})
                try:
                    urllib.request.urlopen(request, timeout=3).close()
                    raise ValueError("anonymous_access_allowed")
                except urllib.error.HTTPError as error:
                    if error.code != 401 or error.headers.get("Cache-Control") != "private, no-store":
                        raise ValueError("anonymous_denial_not_ready")
                run("runuser", "-u", "wiki-service", "--", str(release / "bun"), str(release / "check-archive.js"),
                    f"/run/personal-wiki-service-{target}/r2.json", target, timeout=120)
                return
            except (OSError, ValueError):
                time.sleep(1)
        raise ValueError("private_readiness_failed")

    def resume_dispatch(self, target):
        if self.settings["dispatchEnabled"][target]:
            run("systemctl", "start", f"personal-wiki-runner@{target}.service")
