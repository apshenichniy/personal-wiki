"""Durable deployment records, independent of application releases and state."""
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex)
    with open(temporary, "x", opener=lambda p, f: os.open(p, f, 0o600)) as file:
        json.dump(value, file, sort_keys=True)
        file.write("\n")
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def operation_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value):
        raise ValueError("invalid_operation_id")
    return value


def schema_version(root):
    path = root / "library.sqlite"
    if not path.exists():
        return 0
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        return db.execute("SELECT coalesce(max(migration_id),0) FROM effect_sql_migrations").fetchone()[0]


@contextmanager
def exclusive(path, create=True):
    fd = os.open(path, os.O_RDWR | (os.O_CREAT if create else 0) | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


class Records:
    def __init__(self, root):
        self.root = root
        root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def path(self, op_id):
        return self.root / f"{operation_id(op_id)}.json"

    def get(self, op_id):
        return json.loads(self.path(op_id).read_text())

    def put(self, record, phase=None):
        if phase:
            record["phase"] = phase
        record["updatedAt"] = int(time.time())
        atomic_json(self.path(record["operationId"]), record)
        return record

    def create(self, request):
        path = self.path(request["operationId"])
        if path.exists():
            old = self.get(request["operationId"])
            if old["request"] != request:
                raise ValueError("operation_conflict")
            return old
        return self.put({"operationId": request["operationId"], "request": request, "phase": "uploaded", "error": None})

    def pending(self):
        return [json.loads(p.read_text()) for p in sorted(self.root.glob("*.json"))
                if json.loads(p.read_text())["phase"] not in ("complete", "failed")]
