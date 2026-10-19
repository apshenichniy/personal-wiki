"""Exercise late inherited slot release after the original leader disappears."""
import ctypes
import fcntl
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location("guardian", Path(__file__).parents[2] / "tools/runtime/agent-guard.py")
guardian = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardian)
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
with tempfile.TemporaryDirectory(prefix="wiki-cleanup-") as root:
    for delay, timeout, expected in [(0.2, 2, True), (2, 0.1, False)]:
        path = Path(root, "lock")
        held = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(held, fcntl.LOCK_EX)
        script = """import os,sys,time
pid=os.fork()
if pid==0:
 os.setsid()
 time.sleep(float(sys.argv[1]))
 os._exit(0)
print(pid, flush=True)
os._exit(0)
"""
        leader = subprocess.Popen([sys.executable, "-c", script, str(delay)], pass_fds=(held,), start_new_session=True, stdout=subprocess.PIPE, text=True)
        descendant = int(leader.stdout.readline())
        leader.wait()
        os.close(held)
        check = os.open(path, os.O_RDWR)
        started = time.monotonic()
        try:
            assert not guardian.group_alive(leader.pid)
            actual = guardian.confirm_cleanup(leader, check, timeout)
            assert actual is expected, f"late release: expected {expected}, got {actual}"
            if expected:
                try:
                    os.waitpid(descendant, os.WNOHANG)
                    raise AssertionError("Cleanup must reap the orphan, not only acquire its released lock")
                except ChildProcessError:
                    pass
            else:
                assert time.monotonic() - started < 1
                try:
                    fcntl.flock(check, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    raise AssertionError("Live holder must retain physical exclusion")
                except BlockingIOError:
                    pass
        finally:
            os.close(check)
            try: os.kill(descendant, signal.SIGKILL)
            except ProcessLookupError: pass
            try: os.waitpid(descendant, 0)
            except ChildProcessError: pass
            leader.stdout.close()
print("Delayed descendant cleanup confirmed; persistent holder remains blocked")
