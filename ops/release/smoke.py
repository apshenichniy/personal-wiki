#!/usr/bin/env python3
"""Exercise the packaged runtime without node_modules, network providers or secrets."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def smoke(release):
    with tempfile.TemporaryDirectory(prefix="wiki-release-smoke-") as temporary:
        root = Path(temporary)
        token = "wk_" + secrets.token_urlsafe(32)
        config = root / "credentials.json"
        config.write_text(json.dumps({"credentials": [{"identityId": str(uuid.uuid4()), "role": "operator", "token": token}]}))
        config.chmod(0o600)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = {"PATH": "/usr/bin:/bin", "HOME": temporary, "WIKI_DATA_DIR": str(root / "library"),
               "WIKI_MACHINE_CREDENTIALS_FILE": str(config), "PORT": str(port)}
        child = subprocess.Popen(["python3", str(release / "locked-service.py"), str(release / "bun"), str(release / "service.js")],
                                 env=env, cwd=temporary, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for _ in range(100):
                if child.poll() is not None:
                    raise RuntimeError("Packaged service failed to start")
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                        assert response.status == 204
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("Packaged service did not become ready")
            url = f"http://127.0.0.1:{port}/api/v1/notes"
            try:
                urllib.request.urlopen(url, timeout=5).close()
                raise AssertionError("Anonymous worker access allowed")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            request = urllib.request.Request(url, headers={"authorization": "Bearer " + token})
            with urllib.request.urlopen(request, timeout=5) as response:
                value = json.load(response)
                assert value["notes"] == [] and len(value["appliedRevision"]) == 40
            print("Packaged Bun, SQLite, Git, authenticated read and anonymous denial passed.")
        finally:
            child.terminate()
            child.wait(timeout=40)


if __name__ == "__main__":
    smoke(Path(sys.argv[1]).resolve())
