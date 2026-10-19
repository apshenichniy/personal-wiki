#!/usr/bin/env python3
"""Read physical evidence under the attempt lock; never guess from a lease or PID."""
import fcntl
import importlib.util
import json
import os
import pathlib
import sys

spec = importlib.util.spec_from_file_location("guardian", pathlib.Path(__file__).with_name("agent-guard.py"))
guardian = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardian)


def inspect():
    slot, attempt = map(pathlib.Path, sys.argv[1:3])
    if not slot.is_absolute() or not attempt.is_absolute() or slot.is_symlink() or attempt.is_symlink():
        return "unknown"
    lock = os.open(slot / "execution.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return "running"
    active = slot / "active.json"
    boot = guardian.boot_identity()
    if active.exists():
        record = guardian.private_json(active)
        other_boot = record["boot"] != boot
        certificate = pathlib.Path(record["attemptDirectory"], "exit.json")
        complete = guardian.private_json(certificate) if certificate.exists() else None
        safe = other_boot or (complete and complete.get("generation") == record["generation"] and complete.get("processStopped") is True and (complete.get("spawned") is False or (isinstance(record.get("group"), int) and not guardian.group_alive(record["group"]))))
        if not safe:
            return "unknown"
        active.unlink()
        guardian.sync_directory(slot)
    intent = attempt / "intent.json"
    if not intent.exists():
        return "not_started"
    record = guardian.private_json(intent)
    if record["boot"] != boot:
        return "stopped"  # No process survives a host reboot.
    certificate = attempt / "exit.json"
    if certificate.exists():
        complete = guardian.private_json(certificate)
        if complete.get("generation") != record["generation"] or complete.get("processStopped") is not True:
            return "unknown"
        process_file = attempt / "process.json"
        if complete.get("spawned") is False:
            return "stopped"
        if process_file.exists():
            process = guardian.private_json(process_file)
            if process.get("generation") == record["generation"] and not guardian.group_alive(process["group"]):
                return "stopped"
    return "unknown"


try:
    print(json.dumps({"status": inspect()}))
except Exception:
    print('{"status":"unknown"}')
