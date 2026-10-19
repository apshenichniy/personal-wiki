"""Encrypted recovery points. Plaintext cuts never leave the private backup workspace."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import uuid
import sys
sys.path.insert(0, str(Path('/opt/personal-wiki-deploy') if Path('/opt/personal-wiki-deploy').is_dir() else Path(__file__).resolve().parents[1] / 'deploy'))
from state import atomic_json, sync_directory

VERSION = '0.19.1'


def hash_file(path):
    with Path(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def copy_cut(source, destination):
    """Caller fences writers; SQLite backup includes a surviving WAL after a crash."""
    source, destination = Path(source), Path(destination)
    if source.is_symlink() or not source.is_dir():
        raise ValueError('invalid_cut_source')
    destination.mkdir(parents=True, mode=0o700)
    for entry in source.iterdir():
        if entry.name == '.bun':
            continue  # Runtime compilation cache is not durable application state.
        if entry.is_symlink():
            raise ValueError('state_symlink')
        target = destination / entry.name
        if entry.is_dir():
            copy_cut(entry, target)
        elif entry.is_file():
            if any(entry.name.endswith(suffix) and entry.with_name(entry.name[:-len(suffix)]).is_file()
                   for suffix in ('-wal', '-shm', '-journal')):
                continue
            with entry.open('rb') as file:
                sqlite = file.read(16) == b'SQLite format 3\0'
            if sqlite:
                with sqlite3.connect(f'file:{entry}?mode=ro', uri=True) as live, sqlite3.connect(target) as cut:
                    live.backup(cut)
                    cut.execute('PRAGMA journal_mode=DELETE')
                    if cut.execute('PRAGMA integrity_check').fetchone() != ('ok',):
                        raise ValueError('sqlite_cut_integrity')
            else:
                shutil.copyfile(entry, target)
            target.chmod(0o600)
            with target.open('rb') as file:
                os.fsync(file.fileno())
        else:
            raise ValueError('unsupported_state_file')
    sync_directory(destination)


def manifest(root, metadata):
    files = {}
    for file in sorted(root.rglob('*')):
        if file.is_symlink():
            raise ValueError('cut_symlink')
        if file.is_file() and file != root / 'recovery.json':
            files[str(file.relative_to(root))] = {'sha256': hash_file(file), 'bytes': file.stat().st_size}
    value = {'format': 1, 'restic': VERSION, **metadata, 'files': files}
    atomic_json(root / 'recovery.json', value)
    return value


def verify_cut(root):
    value = json.loads((root / 'recovery.json').read_text())
    if value.get('format') != 1 or value.get('restic') != VERSION:
        raise ValueError('unsupported_recovery_format')
    actual = set()
    for file in root.rglob('*'):
        if file.is_symlink():
            raise ValueError('restored_symlink')
        if file.is_file() and file != root / 'recovery.json':
            actual.add(str(file.relative_to(root)))
    if actual != set(value['files']):
        raise ValueError('recovery_file_set_differs')
    for name, expected in value['files'].items():
        file = root / name
        if file.stat().st_size != expected['bytes'] or hash_file(file) != expected['sha256']:
            raise ValueError('recovery_checksum_differs')
        with file.open('rb') as stream:
            sqlite = stream.read(16) == b'SQLite format 3\0'
        if sqlite:
            with sqlite3.connect(f'file:{file}?mode=ro', uri=True) as db:
                if db.execute('PRAGMA integrity_check').fetchone() != ('ok',):
                    raise ValueError('restored_sqlite_invalid')
    for repo in (root / 'libraries').glob('*/knowledge.git'):
        subprocess.run(['git', '--git-dir', str(repo), 'fsck', '--full'], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for original in json.loads((root / 'originals.json').read_text()):
        file = root / 'originals' / original['sha256']
        if not file.is_file() or file.stat().st_size != original['byteLength'] or hash_file(file) != original['sha256']:
            raise ValueError('missing_original_bytes')
    return value


class Restic:
    def __init__(self, binary, environment):
        self.binary, self.environment = str(binary), environment
        result = subprocess.check_output([self.binary, 'version'], text=True)
        if not result.startswith(f'restic {VERSION} '):
            raise ValueError('pinned_restic_required')

    def run(self, *args, cwd=None, json_output=True):
        command = [self.binary, '--json', *args] if json_output else [self.binary, *args]
        result = subprocess.run(command, cwd=cwd, env=self.environment, capture_output=True, text=True, timeout=3600)
        if result.returncode:
            raise ValueError('restic_operation_failed')
        return result.stdout

    def save(self, cut, workspace, kind):
        if kind not in ('daily', 'migration'):
            raise ValueError('invalid_backup_kind')
        output = self.run('backup', '--host', 'personal-wiki', '--tag', 'pending', str(cut))
        summary = next(json.loads(line) for line in output.splitlines() if json.loads(line).get('message_type') == 'summary')
        snapshot = summary['snapshot_id']
        verification = workspace / ('verify-' + uuid.uuid4().hex)
        verification.mkdir(mode=0o700)
        try:
            self.run('restore', snapshot, '--target', str(verification), '--verify')
            restored = verification / str(cut).lstrip('/')
            verify_cut(restored)
            # Read-back verified snapshots alone become eligible for retention/RPO.
            self.run('tag', '--remove', 'pending', '--add', 'complete', '--add', kind, snapshot)
            candidates = json.loads(self.run('snapshots', '--tag', 'complete', '--path', str(cut)))
            complete = next(item for item in candidates if kind in item['tags'])
            return complete['id']
        finally:
            shutil.rmtree(verification)

    def retain(self):
        # Migration pins are deliberately outside this selection. Failed/pending
        # backups never invoke retention and cannot evict a verified point.
        self.run('forget', '--tag', 'complete,daily', '--group-by', 'host', '--keep-daily', '7', '--keep-weekly', '4')

    def restore(self, snapshot, destination):
        if destination.exists():
            raise ValueError('empty_new_restore_target_required')
        points = json.loads(self.run('snapshots', snapshot))
        if len(points) != 1 or 'complete' not in points[0].get('tags', []):
            raise ValueError('verified_recovery_point_required')
        paths = points[0]['paths']
        if len(paths) != 1 or not Path(paths[0]).is_absolute():
            raise ValueError('invalid_recovery_root')
        destination.mkdir(parents=True, mode=0o700)
        self.run('restore', points[0]['id'], '--target', str(destination), '--verify')
        root = destination / paths[0].lstrip('/')
        return root, verify_cut(root)
