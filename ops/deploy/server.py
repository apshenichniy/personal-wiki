#!/usr/bin/env python3
"""Root-owned Unix socket accepts only verified fixed-target release operations."""
import grp
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import socketserver
import struct
import subprocess
import threading
import time
from artifact import MAX_ARCHIVE
from engine import Engine, validate_request
from host import Host, ROOT, RELEASES
from state import atomic_json, operation_id, sync_directory

SOCKET = "/run/personal-wiki-deploy/control.sock"
engine = None
uploads_lock = threading.Lock()


def respond(stream, value):
    stream.write(json.dumps(value).encode() + b"\n")
    stream.flush()


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(60)
        try:
            uid = struct.unpack("3i", self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
            if uid not in (0, pwd.getpwnam("wiki-deploy").pw_uid):
                raise ValueError("unauthorized")
            line = self.rfile.readline(1024 * 1024 + 1)
            if len(line) > 1024 * 1024:
                raise ValueError("request_capacity")
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError("invalid_request")
            action = value.get("action")
            if action in ("status", "resume"):
                if set(value) != {"action", "operationId"}:
                    raise ValueError("invalid_request")
                op_id = operation_id(value["operationId"])
                respond(self.wfile, engine.resume(op_id) if action == "resume" else engine.status(op_id))
                return
            if action == "rollback":
                if set(value) != {"action", "operationId", "target"}:
                    raise ValueError("invalid_request")
                with uploads_lock:
                    result = engine.rollback(value["operationId"], value["target"])
                respond(self.wfile, result)
                return
            if action != "install" or set(value) != {"action", "request", "size", "bundle"}:
                raise ValueError("invalid_request")
            req = validate_request(value["request"])
            if req["operation"] != "install" or type(value["size"]) is not int or not 0 < value["size"] <= MAX_ARCHIVE:
                raise ValueError("invalid_upload")
            if not isinstance(value["bundle"], str) or not 0 < len(value["bundle"]) <= 512 * 1024:
                raise ValueError("invalid_attestation")
            with uploads_lock:
                if engine.records.path(req["operationId"]).exists():
                    record = engine.records.create(req)
                    respond(self.wfile, {"send": False, "status": engine.status(record["operationId"])})
                    return
                if shutil.disk_usage(ROOT).free < 5 * 1024**3 + MAX_ARCHIVE:
                    raise ValueError("insufficient_disk_headroom")
                folder = engine.uploads / req["operationId"]
                if folder.exists():
                    shutil.rmtree(folder)  # Incomplete upload; no deployment record exists.
                folder.mkdir(mode=0o700)
                respond(self.wfile, {"send": True})
                with (folder / "artifact.tar.gz").open("xb") as file:
                    remaining = value["size"]
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("incomplete_upload")
                        file.write(chunk)
                        remaining -= len(chunk)
                    file.flush()
                    os.fsync(file.fileno())
                with (folder / "attestation.jsonl").open("x") as file:
                    file.write(value["bundle"])
                    file.flush()
                    os.fsync(file.fileno())
                sync_directory(folder)
                engine.records.create(req)
            respond(self.wfile, {"accepted": True, "operationId": req["operationId"]})
        except (OSError, ValueError, KeyError, TypeError):
            try:
                respond(self.wfile, {"error": "request_rejected"})
            except OSError:
                pass


def work():
    restored = False
    last_restore_error = None
    while True:
        for record in engine.records.pending():
            try:
                print(json.dumps(engine.drive(record["operationId"])), flush=True)
            except (OSError, ValueError):
                pass  # Lock contention/restart is reconciled from the durable record.
        if not restored:
            try:
                restored = engine.restore_runtime()
            except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
                # A failed cutover, unavailable identity provider, or altered
                # release must not be bypassed by independently enabled units.
                code = str(error) if type(error) is ValueError else "runtime_prerequisite_unavailable"
                if code != last_restore_error:
                    print(json.dumps({"event": "runtime-restore-blocked", "code": code}), flush=True)
                    last_restore_error = code
        time.sleep(1)


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    request_queue_size = 4


if __name__ == "__main__":
    if os.getuid() != 0:
        raise SystemExit("Root-owned service required")
    os.umask(0o077)
    engine = Engine(ROOT, RELEASES, Host())
    Path(SOCKET).unlink(missing_ok=True)
    with Server(SOCKET, Handler) as server:
        os.chown(SOCKET, 0, grp.getgrnam("wiki-deploy").gr_gid)
        os.chmod(SOCKET, 0o660)
        threading.Thread(target=work, daemon=True).start()
        server.serve_forever()
