#!/usr/bin/env python3
"""Restore to a fresh private directory; never replace live paths or enable routing."""
import json
from contextlib import closing
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import time
import uuid
from core import hash_file
from host_backup import restic
from state import atomic_json
from artifact import verify_provenance


def prepare(root, tools):
    originals = root / 'originals'
    originals.mkdir(exist_ok=True, mode=0o700)
    for namespace in ('staging', 'production'):
        library = root / 'libraries' / namespace
        if not (library / 'library.sqlite').exists():
            continue
        # Recovery adopts persisted candidates under an exclusive local publisher
        # lock before quarantining old jobs. No network listener or agent runs.
        env = {'PATH': os.environ['PATH'], 'WIKI_DATA_DIR': str(library)}
        subprocess.run(['python3', str(tools / 'locked-service.py'), str(tools / 'bun'),
                        str(tools / 'prepare-restore.js'), str(library), str(originals)],
                       env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
        credentials = {'credentials': [{'identityId': str(uuid.uuid4()), 'role': role,
                         'token': 'wk_' + secrets.token_urlsafe(32)} for role in ('operator', 'runner')]}
        atomic_json(root / 'configuration/deploy' / namespace / 'machine-credentials.json', credentials)
        # Do not reuse copied Runner tokens/configuration accidentally.
        (root / 'configuration/deploy' / namespace / 'runner-token').unlink(missing_ok=True)
    ledger = root / 'accounting/provider-accounting.sqlite'
    with closing(sqlite3.connect(ledger)) as db, db:
        db.execute("UPDATE provider_configuration SET quarantined=1,reason='restore_external_accounting_unknown'")
    atomic_json(root / 'recovery-state.json', {'state': 'isolated', 'routing': False, 'dispatch': False,
                'paidExecution': 'quarantined', 'oldJobs': 'blocked-until-independent-accounting', 'preparedAt': int(time.time())})


def main():
    if os.geteuid() != 0:
        raise SystemExit('Owner recovery administrator required')
    os.umask(0o077)
    snapshot, destination = sys.argv[1:]
    destination = Path(destination)
    if not destination.is_absolute() or destination.exists():
        raise ValueError('new_absolute_recovery_directory_required')
    start = time.monotonic()
    root, metadata = restic().restore(snapshot, destination)
    tools = root / 'releases' / metadata['recoveryToolsDigest']
    if metadata['schema']['staging'] not in (0, 7) or metadata['schema']['production'] not in (0, 7):
        raise ValueError('restore_schema_unsupported')
    release_manifest = json.loads((tools / 'release.json').read_text())
    attestation = root / 'attestations' / metadata['recoveryToolsDigest']
    verify_provenance(attestation / 'artifact.tar.gz', attestation / 'attestation.jsonl',
                      release_manifest['revision'], metadata['recoveryToolsDigest'],
                      Path('/opt/personal-wiki-tools/gh/2.101.0/bin/gh'))
    for name, digest in release_manifest['files'].items():
        if hash_file(tools / name) != digest:
            raise ValueError('restore_tool_checksum_differs')
    (tools / 'bun').chmod(0o700)
    prepare(root, tools)
    print(json.dumps({'status': 'isolated-restore-prepared', 'root': str(root), 'snapshotId': snapshot,
                      'seconds': round(time.monotonic()-start, 2), 'checkpointAt': metadata['checkpointAt'],
                      'paidExecution': 'quarantined', 'routing': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Restore failed; target remains isolated. No runtime or route was started.')
