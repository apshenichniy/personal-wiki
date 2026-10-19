#!/usr/bin/env python3
"""Disposable HTTPS browser fixture; never packaged or used by production."""
import os
import pathlib
import signal
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix="wiki-browser-") as directory:
    root = pathlib.Path(directory)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"), "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    child = subprocess.Popen(["python3", "tools/runtime/locked-service.py", "bun", "tests/helpers/browser-service.ts"], env={**os.environ, "WIKI_DATA_DIR": str(root / "library"), "WIKI_BROWSER_FIXTURE_DIR": directory})
    def stop(signum, frame):
        child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    raise SystemExit(child.wait())
