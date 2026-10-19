#!/usr/bin/env python3
"""systemd cleanup/boot hook; only restart the durably recorded fixed service set."""
import json
import os
import sys
import time
from contextlib import nullcontext, contextmanager
from host_backup import ROOT, DEPLOY, recover_checkpoint
from state import exclusive, operation_id

@contextmanager
def deployment_lock():
    deadline = time.monotonic() + 30
    while True:
        guard = exclusive(DEPLOY / 'deployment.lock')
        try:
            guard.__enter__()
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.2)
    try:
        yield
    finally:
        guard.__exit__(None, None, None)


if os.geteuid() != 0:
    raise SystemExit('Backup administrator required')
owner = sys.argv[1]
if owner not in ('daily', 'boot'):
    operation_id(owner)
path = ROOT / 'checkpoint-owner.json'
if path.exists():
    # A migration parent still owns deployment.lock while waiting for ExecStopPost.
    # Daily cleanup/boot serialize with deploy; preflight refuses this journal.
    lock = deployment_lock() if owner in ('daily', 'boot') else nullcontext()
    with lock, exclusive(ROOT / 'backup.lock'):
        recover_checkpoint(None if owner == 'boot' else owner)
