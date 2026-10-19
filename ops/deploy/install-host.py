#!/usr/bin/env python3
"""Owner-admin provisioning. This script is never callable by wiki-deploy."""
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import uuid
import secrets


def command(*args):
    subprocess.run(args, check=True)


def directory(path, owner="root", mode=0o700):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=mode)
    account = pwd.getpwnam(owner)
    os.chown(path, account.pw_uid, account.pw_gid)
    path.chmod(mode)
    return path


def private_json(path, value):
    # Refuse accidental re-provisioning/rotation of an existing identity.
    if path.exists():
        return json.loads(path.read_text())
    with path.open("x") as file:
        json.dump(value, file)
        file.write("\n")
    path.chmod(0o600)
    return value


def main():
    if os.geteuid() != 0:
        raise SystemExit("Owner administrative access required")
    os.umask(0o077)
    try:
        pwd.getpwnam("wiki-service")
    except KeyError:
        command("useradd", "--system", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", "wiki-service")
    source = Path(__file__).resolve().parent
    controller = directory("/opt/personal-wiki-deploy", mode=0o755)
    for name in ("server.py", "engine.py", "artifact.py", "state.py", "host.py", "check-sandbox.py"):
        shutil.copyfile(source / name, controller / name)
        (controller / name).chmod(0o644)
    shutil.copyfile(source / "client.py", "/usr/local/bin/wiki-deployctl")
    Path("/usr/local/bin/wiki-deployctl").chmod(0o755)
    directory("/opt/personal-wiki", mode=0o755)
    directory("/opt/personal-wiki/releases", mode=0o755)
    directory("/var/lib/personal-wiki-deploy")
    directory("/var/lib/personal-wiki-accounting", "wiki-service")
    directory("/etc/personal-wiki/deploy")
    slot = directory("/var/lib/personal-wiki-runner/agent-slot", "wiki-runner")
    for name in ("supervisor.lock", "execution.lock"):
        file = slot / name
        if not file.exists():
            file.touch(mode=0o600)
            account = pwd.getpwnam("wiki-runner")
            os.chown(file, account.pw_uid, account.pw_gid)
    # Existing lock inodes, provider accounting and knowledge state are preserved.
    codex = Path("/usr/local/bin/codex").resolve()
    codex_digest = hashlib.sha256(codex.read_bytes()).hexdigest()
    for target, worker, public, origin in (("staging", 3002, 3003, "https://wiki-staging.alexp.sh"),
                                            ("production", 3000, 3001, "https://wiki.alexp.sh")):
        data = directory(f"/var/lib/personal-wiki-{target}", "wiki-service")
        # An existing probe namespace must be deliberately transferred with its
        # old service stopped; do not recursively chown a live library here.
        for file in data.iterdir():
            if file.stat().st_uid != pwd.getpwnam("wiki-service").pw_uid:
                raise SystemExit("Existing namespace ownership requires an explicit quiescent handover")
        publisher_lock = data / "publisher.lock"
        if not publisher_lock.exists():
            publisher_lock.touch(mode=0o600)
            account = pwd.getpwnam("wiki-service")
            os.chown(publisher_lock, account.pw_uid, account.pw_gid)
        runner = directory(f"/var/lib/personal-wiki-runner/{target}", "wiki-runner")
        for name in ("provider-spool", "agent-spool"):
            directory(runner / name, "wiki-runner")
        config = directory(f"/etc/personal-wiki/deploy/{target}")
        original = Path("/etc/personal-wiki/staging" if target == "staging" else "/etc/personal-wiki/secrets")
        for name in ("owner-access.json", "r2.json"):
            if not (config / name).exists():
                shutil.copyfile(original / name, config / name)
                (config / name).chmod(0o600)
        credentials = private_json(config / "machine-credentials.json", {"credentials": [
            {"identityId": str(uuid.uuid4()), "role": role, "token": "wk_" + secrets.token_urlsafe(32)}
            for role in ("runner", "operator")]})
        for name, content in (("runner-token", next(c["token"] for c in credentials["credentials"] if c["role"] == "runner")),
                              ("apify-token", Path("/etc/personal-wiki/secrets/apify-token").read_text().strip())):
            if not (config / name).exists():
                (config / name).write_text(content + "\n")
                (config / name).chmod(0o600)
        current = f"/opt/personal-wiki/current-{target}"
        runtime = f"/run/personal-wiki-runner-{target}"
        private_json(config / "runner.json", {
            "serviceUrl": f"http://127.0.0.1:{worker}", "runnerTokenFile": runtime + "/runner-token",
            "apifyTokenFile": runtime + "/apify-token", "spool": str(runner / "provider-spool"),
            "skillFile": current + "/curate-x.md",
            "codex": {"binary": str(codex), "binarySha256": codex_digest, "python": "/usr/bin/python3",
                      "guardian": current + "/agent-guard.py", "slotDirectory": str(slot),
                      "spool": str(runner / "agent-spool"), "authFile": "/var/lib/personal-wiki-runner/.codex/auth.json"}})
        env = Path(f"/etc/personal-wiki/deploy/{target}.env")
        env.write_text(f"WIKI_DATA_DIR={data}\nWIKI_NAMESPACE={target}\nPORT={worker}\nWIKI_PUBLIC_PORT={public}\n")
        env.chmod(0o600)
        other = "production" if target == "staging" else "staging"
        for kind in ("service", "runner"):
            dropin = directory(f"/etc/systemd/system/personal-wiki-{kind}@{target}.service.d", mode=0o755)
            (dropin / "namespace.conf").write_text("[Service]\n" +
                f"InaccessiblePaths=-/var/lib/personal-wiki-{other} -/var/lib/personal-wiki-runner/{other} -/run/personal-wiki-service-{other} -/run/personal-wiki-runner-{other}\n")
    private_json(Path("/etc/personal-wiki/deploy/settings.json"), {
        "dispatchEnabled": {"staging": False, "production": False},
        "targets": {"staging": {"workerPort": 3002, "ownerPort": 3003, "publicOrigin": "https://wiki-staging.alexp.sh"},
                    "production": {"workerPort": 3000, "ownerPort": 3001, "publicOrigin": "https://wiki.alexp.sh"}}})
    for name in ("personal-wiki-deploy.service", "personal-wiki-service@.service", "personal-wiki-runner@.service"):
        shutil.copyfile(source / name, Path("/etc/systemd/system") / name)
    command("systemctl", "daemon-reload")
    command("python3", str(controller / "check-sandbox.py"), "/etc/systemd/system/personal-wiki-runner@.service")
    command("systemctl", "enable", "--now", "personal-wiki-deploy.service")
    print("Controller installed. Runtime dispatch remains governed by private settings; no knowledge service was started.")


if __name__ == "__main__":
    main()
