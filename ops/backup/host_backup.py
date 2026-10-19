"""Fixed host inventory; administrative backup identity is separate from CI/Runner."""
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from core import Restic, VERSION, copy_cut, manifest
sys.path.insert(0, str(Path('/opt/personal-wiki-deploy') if Path('/opt/personal-wiki-deploy').is_dir() else Path(__file__).resolve().parents[1] / 'deploy'))
from state import atomic_json, exclusive, operation_id, schema_version
from host import Host as DeploymentHost

ROOT = Path('/var/lib/personal-wiki-backup')
BINARY = Path('/opt/personal-wiki-tools/restic/0.19.1/restic')
CONFIG = Path('/etc/personal-wiki/backup')
DEPLOY = Path('/var/lib/personal-wiki-deploy')


def run(*args, timeout=120):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)


def restic():
    for path in (CONFIG / 'r2.json', CONFIG / 'restic-password'):
        if path.is_symlink() or not path.is_file() or path.stat().st_uid != 0 or path.stat().st_mode & 0o077:
            raise ValueError('private_backup_configuration_required')
    value = json.loads((CONFIG / 'r2.json').read_text())
    if value['bucket'] != 'personal-wiki-backups':
        raise ValueError('separate_backup_bucket_required')
    env = {**os.environ, 'AWS_ACCESS_KEY_ID': value['accessKeyId'], 'AWS_SECRET_ACCESS_KEY': value['secretAccessKey'],
           'AWS_DEFAULT_REGION': value['region'], 'RESTIC_REPOSITORY': 's3:' + value['endpoint'].rstrip('/') + '/' + value['bucket'] + '/restic',
           'RESTIC_PASSWORD_FILE': str(CONFIG / 'restic-password'), 'RESTIC_CACHE_DIR': str(ROOT / 'cache')}
    return Restic(BINARY, env)


def tools_release():
    digest = (CONFIG / 'tools-release').read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('invalid_backup_tool_release')
    release = Path('/opt/personal-wiki/releases') / digest
    if not (release / 'backup-assets.js').is_file() or not (release / 'prepare-restore.js').is_file() or not (DEPLOY / 'artifacts' / digest / 'attestation.jsonl').is_file():
        raise ValueError('verified_backup_tool_release_required')
    return digest, release


def active(unit):
    return subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0


@contextmanager
def checkpoint():
    host = DeploymentHost()
    services = [f'personal-wiki-service@{t}.service' for t in ('staging', 'production')]
    runners = [f'personal-wiki-runner@{t}.service' for t in ('staging', 'production')]
    previous = [unit for unit in [*services, *runners] if active(unit)]
    identity_active = active('pocket-id.service')
    try:
        host.stop_runners()
        for target in ('staging', 'production'):
            host.stop_service(target)
            host.assert_fenced(target)
        if identity_active:
            run('systemctl', 'stop', 'pocket-id.service')
        yield host
    finally:
        if identity_active:
            run('systemctl', 'start', 'pocket-id.service')
        for unit in previous:
            run('systemctl', 'start', unit)


def snapshot_cut(cut, host):
    for namespace in ('staging', 'production'):
        copy_cut(Path(f'/var/lib/personal-wiki-{namespace}'), cut / 'libraries' / namespace)
        copy_cut(Path(f'/var/lib/personal-wiki-runner/{namespace}'), cut / 'runners' / namespace)
    copy_cut(Path('/var/lib/personal-wiki-accounting'), cut / 'accounting')
    copy_cut(Path('/etc/personal-wiki/deploy'), cut / 'configuration/deploy')
    copy_cut(Path('/etc/pocket-id'), cut / 'configuration/pocket-id')
    copy_cut(Path('/var/lib/pocket-id'), cut / 'identity')
    copy_cut(Path('/etc/personal-wiki/private'), cut / 'configuration/bootstrap')
    releases = {}
    for namespace in ('staging', 'production'):
        record = DEPLOY / f'active-{namespace}.json'
        if record.exists():
            value = json.loads(record.read_text())
            releases[namespace] = value
            destination = cut / 'releases' / value['digest']
            if not destination.exists():
                copy_cut(Path('/opt/personal-wiki/releases') / value['digest'], destination)
                copy_cut(DEPLOY / 'artifacts' / value['digest'], cut / 'attestations' / value['digest'])
    tool_digest, tool_release = tools_release()
    if not (cut / 'releases' / tool_digest).exists():
        copy_cut(tool_release, cut / 'releases' / tool_digest)
        copy_cut(DEPLOY / 'artifacts' / tool_digest, cut / 'attestations' / tool_digest)
    return {'checkpointAt': int(time.time()), 'releases': releases, 'recoveryToolsDigest': tool_digest, 'schema': {t: schema_version(cut / 'libraries' / t) for t in ('staging', 'production')},
            'checkpoints': {t: host.checkpoint_identity(t) for t in ('staging', 'production')}, 'pocketId': '2.18.0'}


def backup(kind, op_id=None):
    ROOT.mkdir(exist_ok=True, mode=0o700)
    if shutil.disk_usage(ROOT).free < 5 * 1024**3:
        raise ValueError('backup_disk_headroom')
    point = op_id or str(__import__('uuid').uuid4())
    cut = ROOT / ('cut-' + point)
    if cut.exists():
        # Interrupted attempts remain forensic inputs; never reuse a mutable cut.
        cut = ROOT / ('cut-' + point + '-' + __import__('uuid').uuid4().hex)
    cut.mkdir(mode=0o700)
    with checkpoint() as host:
        metadata = snapshot_cut(cut, host)
    if not metadata['releases']:
        raise ValueError('verified_release_required')
    _, release = tools_release()
    run(str(release / 'bun'), str(release / 'backup-assets.js'), str(cut), timeout=3600)
    manifest(cut, {**metadata, 'pointId': point, 'kind': kind})
    store = restic()
    snapshot = store.save(cut, ROOT, kind)
    complete = {'pointId': point, 'snapshotId': snapshot, 'completedAt': int(time.time()), 'checkpointAt': metadata['checkpointAt'], 'kind': kind}
    atomic_json(ROOT / 'last-success.json', complete)
    if op_id:
        # Deployment still owns its lock and target remains stopped. Bind the
        # proof to this exact checkpoint, never to a merely recent snapshot.
        atomic_json(DEPLOY / 'recovery' / (op_id + '.json'), {
            'operationId': op_id, 'target': 'production', 'schema': metadata['schema']['production'],
            'checkpoint': metadata['checkpoints']['production'], 'verified': True,
            'completedAt': complete['completedAt'], 'snapshotId': snapshot})
    if kind == 'daily':
        store.retain()
    shutil.rmtree(cut)
    return complete


def main():
    if os.geteuid() != 0:
        raise SystemExit('Owner backup administrator required')
    os.umask(0o077)
    value = sys.argv[1]
    try:
        if value == 'daily':
            with exclusive(DEPLOY / 'deployment.lock'), exclusive(ROOT / 'backup.lock'):
                result = backup('daily')
        else:
            operation_id(value)
            record = json.loads((DEPLOY / 'operations' / (value + '.json')).read_text())
            inflight = json.loads((DEPLOY / 'inflight.json').read_text())
            if record['phase'] != 'checkpointing' or record['request']['target'] != 'production' or inflight['operationId'] != value:
                raise ValueError('migration_operation_not_fenced')
            # Parent controller owns deployment.lock and waits for this unit.
            with exclusive(ROOT / 'backup.lock'):
                result = backup('migration', value)
        print(json.dumps(result))
    except Exception:
        atomic_json(ROOT / 'last-failure.json', {'failedAt': int(time.time()), 'code': 'backup_failed'})
        raise SystemExit('Backup failed; recovery point not granted. Inspect private local cut.')


if __name__ == '__main__':
    main()
