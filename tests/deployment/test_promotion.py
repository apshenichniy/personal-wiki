import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ops/release'))
from promote import expected, verify_artifact, verify_run, REPOSITORY


class Promotion(unittest.TestCase):
    def test_only_successful_main_release_workflow_is_eligible(self):
        revision = 'a' * 40
        good = {'repository': {'full_name': REPOSITORY}, 'head_repository': {'full_name': REPOSITORY},
                'path': '.github/workflows/release.yml', 'event': 'workflow_dispatch',
                'head_branch': 'main', 'head_sha': revision, 'status': 'completed', 'conclusion': 'success'}
        verify_run(good, revision)
        for key, value in [('repository', {'full_name': 'other/repo'}), ('head_repository', {'full_name': 'fork/repo'}),
                           ('path', '.github/workflows/verify.yml'), ('event', 'pull_request'),
                           ('head_branch', 'feature'), ('head_sha', 'b' * 40), ('status', 'in_progress'),
                           ('conclusion', 'failure')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                verify_run({**good, key: value}, revision)

    def test_tampered_bytes_or_changed_accepted_identity_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'personal-wiki.tar.gz';archive.write_bytes(b'verified artifact fixture')
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            (root / 'identity.json').write_text(json.dumps({'revision': 'a' * 40, 'digest': digest, 'size': archive.stat().st_size}))
            verify_artifact(root, 'a' * 40, digest)
            with self.assertRaises(ValueError):verify_artifact(root, 'b' * 40, digest)
            archive.write_bytes(b'corrupted artifact fixture')
            with self.assertRaises(ValueError):verify_artifact(root, 'a' * 40, digest)

    def test_untrusted_workflow_inputs_never_become_commands_or_paths(self):
        valid = {'RELEASE_RUN_ID': '1234', 'EXPECTED_REVISION': 'a' * 40, 'EXPECTED_DIGEST': 'b' * 64}
        self.assertEqual(expected(valid), ('1234', 'a' * 40, 'b' * 64))
        for key in valid:
            for bad in ['../main', '1; echo injected', '-1', '']:
                with self.subTest(key=key, bad=bad), self.assertRaises(ValueError):expected({**valid, key: bad})
