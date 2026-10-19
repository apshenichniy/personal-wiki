#!/usr/bin/env python3
"""Redacted backup health; exit nonzero for stale, absent or subsequently failed backup."""
import json
from pathlib import Path
import sys
import time
root = Path('/var/lib/personal-wiki-backup')
try:
    success = json.loads((root / 'last-success.json').read_text())
    failure = json.loads((root / 'last-failure.json').read_text()) if (root / 'last-failure.json').exists() else {}
    age = int(time.time()) - success['checkpointAt']
    healthy = 0 <= age <= 86400 and failure.get('failedAt', 0) <= success['completedAt']
    print(json.dumps({'healthy': healthy, 'ageSeconds': age, 'snapshotId': success['snapshotId'], 'completedAt': success['completedAt']}))
    sys.exit(0 if healthy else 1)
except (OSError, ValueError, KeyError):
    print(json.dumps({'healthy': False, 'code': 'no_verified_recovery_point'}))
    sys.exit(1)
