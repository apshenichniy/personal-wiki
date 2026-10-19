"""Select previously checked bytes; promotion never installs dependencies or rebuilds."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REPOSITORY = 'apshenichniy/personal-wiki'


def expected(environment):
    run = environment['RELEASE_RUN_ID']
    revision = environment['EXPECTED_REVISION']
    digest = environment['EXPECTED_DIGEST']
    if not re.fullmatch(r'[1-9][0-9]{0,19}', run):
        raise ValueError('invalid_release_run')
    if not re.fullmatch(r'[a-f0-9]{40}', revision) or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('invalid_accepted_identity')
    return run, revision, digest


def verify_run(run, revision):
    if (run.get('repository', {}).get('full_name') != REPOSITORY or
        run.get('head_repository', {}).get('full_name') != REPOSITORY or
        run.get('path') != '.github/workflows/release.yml' or
        run.get('event') != 'workflow_dispatch' or run.get('head_branch') != 'main' or
        run.get('head_sha') != revision or run.get('status') != 'completed' or
        run.get('conclusion') != 'success'):
        raise ValueError('successful_trusted_staging_run_required')


def verify_artifact(directory, revision, digest):
    value = json.loads((directory / 'identity.json').read_text())
    archive = directory / 'personal-wiki.tar.gz'
    if value.get('revision') != revision or value.get('digest') != digest:
        raise ValueError('accepted_artifact_identity_differs')
    if type(value.get('size')) is not int or value['size'] != archive.stat().st_size:
        raise ValueError('accepted_artifact_size_differs')
    with archive.open('rb') as file:
        if hashlib.file_digest(file, 'sha256').hexdigest() != digest:
            raise ValueError('accepted_artifact_bytes_differ')
    # The privileged host independently verifies the signed provenance and its
    # exact repository/workflow/commit policy before granting installation.


def main():
    run, revision, digest = expected(os.environ)
    if sys.argv[1] == 'run':
        metadata = json.loads(subprocess.check_output(
            ['gh', 'api', f'repos/{REPOSITORY}/actions/runs/{run}'], text=True))
        verify_run(metadata, revision)
    elif sys.argv[1] == 'artifact':
        verify_artifact(Path(sys.argv[2]), revision, digest)
        subprocess.run(['git', 'merge-base', '--is-ancestor', revision, 'origin/main'], check=True)
    else:
        raise ValueError('unknown_promotion_check')
    print(json.dumps({'verified': sys.argv[1], 'releaseRunId': run, 'revision': revision, 'digest': digest}))


if __name__ == '__main__':
    main()
