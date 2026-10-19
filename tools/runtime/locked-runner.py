#!/usr/bin/env python3
"""Hold the host Runner lock across exec; the guardian separately fences attempts."""
import fcntl
import os
import pathlib
import sys

slot = pathlib.Path(os.environ.get("WIKI_AGENT_SLOT", ""))
if not slot.is_absolute() or slot.is_symlink() or len(sys.argv) < 3:
    sys.exit("An absolute WIKI_AGENT_SLOT and explicit Runner command are required.")
slot.mkdir(parents=True, exist_ok=True, mode=0o700)
if slot.stat().st_mode & 0o077:
    sys.exit("Runner slot must be private.")
fd = os.open(slot / "supervisor.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit("Another Runner still owns the host slot.")
os.set_inheritable(fd, True)
os.environ["WIKI_SUPERVISOR_LOCK_FD"] = str(fd)
os.execvp(sys.argv[1], sys.argv[1:])
