#!/usr/bin/env python3
"""Own the publisher flock and every Git process outside the Bun runtime."""
import base64
import fcntl
import json
import os
import pathlib
import secrets
import signal
import socketserver
import subprocess
import sys
import threading
import time

# The crash probe uses the same inherited descriptor and exec boundary as Git.
if len(sys.argv) > 1 and sys.argv[1] == "--git-exec":
    descriptor, marker, *command = sys.argv[2:]
    os.fstat(int(descriptor))
    pathlib.Path(marker).write_text(json.dumps({"pid": os.getpid()}))
    time.sleep(2)
    os.execvpe(command[0], command, os.environ)

root = os.environ.get("WIKI_DATA_DIR", "")
if not root or not os.path.isabs(root) or len(sys.argv) < 3:
    sys.exit("An absolute WIKI_DATA_DIR and a Bun service command are required.")
pathlib.Path(root).mkdir(mode=0o700, parents=True, exist_ok=True)
lock_fd = os.open(os.path.join(root, "publisher.lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit("Another publisher or its Git child still owns the storage lock.")
os.set_inheritable(lock_fd, True)
# A short private pathname also works with macOS's 104-byte Unix socket limit.
socket_dir = pathlib.Path("/tmp", "wiki-publisher-" + secrets.token_hex(12))
socket_dir.mkdir(mode=0o700)
socket_path = str(socket_dir / "control")
token = secrets.token_hex(32)
lane = threading.Lock()
children = set()
children_lock = threading.Lock()
allowed_env = {"GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"}

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            raw = self.rfile.readline(65537)
            if len(raw) > 65536:
                return
            request = json.loads(raw)
            if request.get("token") != token:
                return
            if request.get("method") == "hold":
                self.wfile.write(b'{"ok":true}\n')
                self.wfile.flush()
                self.rfile.read(1)
                return
            if request.get("method") == "test-stop" and os.environ.get("WIKI_TEST_THREAD_SIGNAL") == "1":
                self.wfile.write(b'{"ok":true}\n')
                self.wfile.flush()
                signal.pthread_kill(threading.get_ident(), signal.SIGTERM)
                return
            if request.get("method") != "git":
                return
            args = request["args"]
            overrides = request.get("env", {})
            if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
                return
            if not isinstance(overrides, dict) or not set(overrides).issubset(allowed_env):
                return
            env = {"PATH": os.environ.get("PATH", ""), "HOME": root, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", **overrides}
            command = ["git", "--git-dir", str(pathlib.Path(root, "knowledge.git")), *args]
            marker = os.environ.get("WIKI_TEST_ORPHAN_MARKER")
            if marker and args[:2] == ["update-ref", "refs/test/orphan"]:
                command = [sys.executable, __file__, "--git-exec", str(lock_fd), marker, *command]
            with lane:
                # No runtime-owned descriptor crosses this boundary. Python retains its
                # copy; a child holds the same open-file description until it exits.
                child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, pass_fds=(lock_fd,), start_new_session=True)
                with children_lock:
                    children.add(child)
                try:
                    output = bytearray()
                    oversized = threading.Event()
                    def collect():
                        while chunk := child.stdout.read(65536):
                            if len(output) + len(chunk) > 16 * 1024 * 1024:
                                oversized.set()
                                child.kill()
                                return
                            output.extend(chunk)
                    collector = threading.Thread(target=collect, daemon=True)
                    collector.start()
                    try:
                        code = child.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        code = child.wait()
                    collector.join()
                    result = {"ok": code == 0 and not oversized.is_set(), "output": base64.b64encode(output).decode() if code == 0 and not oversized.is_set() else ""}
                finally:
                    with children_lock:
                        children.discard(child)
                    child.stdout.close()
            self.wfile.write(json.dumps(result).encode() + b"\n")
        except (OSError, ValueError, KeyError, TypeError):
            return

class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

server = Server(socket_path, Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
service = subprocess.Popen(sys.argv[1:], env={**os.environ, "WIKI_PUBLISHER_SOCKET": socket_path, "WIKI_PUBLISHER_TOKEN": token}, start_new_session=True)
def stop(signum, frame):
    try:
        os.killpg(service.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    # Python executes signal handlers in the main thread. A signal delivered to
    # a socket worker cannot interrupt the main thread's indefinite waitpid.
    # Bounded waits return to Python so stop intent is always processed.
    while True:
        try:
            code = service.wait(timeout=0.2)
            break
        except subprocess.TimeoutExpired:
            pass
finally:
    stop(signal.SIGTERM, None)
    with children_lock:
        pending = list(children)
    for child in pending:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        except ProcessLookupError:
            pass
    server.shutdown()
    server.server_close()
    pathlib.Path(socket_path).unlink(missing_ok=True)
    socket_dir.rmdir()
sys.exit(code if code >= 0 else 128 - code)
