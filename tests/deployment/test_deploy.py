import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ops/deploy"))
from artifact import BASE_FILES, unpack, verify_provenance
from engine import Engine, validate_request
from state import atomic_json


class Crash(BaseException):
    pass


class FakeHost:
    def __init__(self):
        self.events = []
        self.cut = "state-with-accepted-job-and-git-history"
        self.version = 7
        self.crash = None
        self.fenced = True
        self.valid = True

    def verify(self, *args):
        if not self.valid:
            raise ValueError("invalid_provenance")
        self.events.append("verified")

    def preflight(self, *args):
        self.events.append("preflight")

    def stop_runners(self):
        self.events.append("stop-runners")

    def stop_service(self, target):
        self.events.append("stop-service")

    def assert_fenced(self, target):
        if not self.fenced:
            raise ValueError("old_processes_remain")

    def schema(self, target):
        return self.version

    def checkpoint_identity(self, target):
        return self.cut

    def checkpoint(self, phase):
        if self.crash == phase:
            self.crash = None
            raise Crash()

    def start_service(self, target):
        self.events.append("start-service")

    def readiness(self, target, release):
        self.events.append("ready")

    def resume_dispatch(self, target):
        self.events.append("dispatch")


def archive(path, revision, extra=None):
    files = {name: b"synthetic packaged bytes" for name in BASE_FILES if name != "release.json"}
    files["web/main-123.js"] = b"synthetic browser bytes"
    files["web/main-123.css"] = b"synthetic CSS"
    manifest = {"format": 1, "revision": revision, "platform": "linux-amd64", "bun": "1.3.13",
                "schema": {"target": 7, "readableMin": 7, "readableMax": 7},
                "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    files["release.json"] = json.dumps(manifest).encode()
    with tarfile.open(path, "w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        if extra:
            tar.addfile(extra, io.BytesIO(b""))
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Deployment(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.host = FakeHost()
        self.engine = Engine(self.root / "controller", self.root / "app/releases", self.host)
        self.disk = patch("engine.shutil.disk_usage", return_value=type("Disk", (), {"free": 10 * 1024**3})())
        self.disk.start()

    def tearDown(self):
        self.disk.stop()
        self.tmp.cleanup()

    def upload(self, revision="a" * 40, target="staging", operation="install"):
        op_id = str(uuid.uuid4())
        folder = self.engine.uploads / op_id
        folder.mkdir()
        digest = archive(folder / "artifact.tar.gz", revision)
        (folder / "attestation.jsonl").write_text("synthetic signature fixture")
        req = {"operationId": op_id, "operation": operation, "target": target, "revision": revision, "digest": digest}
        self.engine.records.create(validate_request(req))
        return req

    def test_interrupted_deploy_reconciles_same_operation_without_resetting_state(self):
        for phase in ("checkpointed", "activated"):
            with self.subTest(phase=phase):
                req = self.upload(revision=uuid.uuid4().hex + "a" * 8)
                self.host.crash = phase
                with self.assertRaises(Crash):
                    self.engine.drive(req["operationId"])
                restarted = Engine(self.engine.root, self.engine.releases, self.host)
                result = restarted.drive(req["operationId"])
                self.assertEqual(result["phase"], "complete")
                self.assertEqual(restarted.active("staging")["digest"], req["digest"])
                self.assertEqual(self.host.cut, "state-with-accepted-job-and-git-history")
                count = len(self.host.events)
                restarted.drive(req["operationId"])
                self.assertEqual(count, len(self.host.events))

    def test_reused_operation_cannot_change_target_or_artifact(self):
        req = self.upload()
        with self.assertRaisesRegex(ValueError, "operation_conflict"):
            self.engine.records.create({**req, "target": "production"})

    def test_wrong_signature_and_unfenced_process_never_activate(self):
        for failure in ("signature", "process"):
            req = self.upload(revision=uuid.uuid4().hex + "a" * 8)
            self.host.valid = failure != "signature"
            self.host.fenced = failure != "process"
            result = self.engine.drive(req["operationId"])
            self.assertEqual(result["phase"], "failed")
            self.assertNotIn("start-service", self.host.events)
            self.assertIsNone(self.engine.active("staging"))

    def test_production_requires_verified_checkpoint_before_activation(self):
        req = self.upload(target="production")
        result = self.engine.drive(req["operationId"])
        self.assertEqual(result["error"], "verified_backup_required")
        self.assertNotIn("start-service", self.host.events)
        self.assertFalse((self.engine.releases.parent / "current-production").exists())

    def test_changed_checkpoint_blocks_resume(self):
        req = self.upload()
        self.host.crash = "checkpointed"
        with self.assertRaises(Crash):
            self.engine.drive(req["operationId"])
        self.host.cut = "an-unexpected-writer-changed-state"
        self.assertEqual(self.engine.drive(req["operationId"])["error"], "checkpoint_changed")
        self.assertNotIn("start-service", self.host.events)

    def test_compatible_rollback_keeps_current_database_and_git(self):
        first = self.upload()
        second = self.upload("b" * 40)
        self.assertEqual(self.engine.drive(first["operationId"])["phase"], "complete")
        self.assertEqual(self.engine.drive(second["operationId"])["phase"], "complete")
        rollback = self.upload(operation="rollback")
        # Test archive bytes include gzip timestamps: the verified predecessor
        # identity must be exact, so reuse its retained archive and bundle.
        import shutil
        for name in ("artifact.tar.gz", "attestation.jsonl"):
            shutil.copyfile(self.engine.uploads / first["operationId"] / name, self.engine.uploads / rollback["operationId"] / name)
        record = self.engine.records.get(rollback["operationId"])
        record["request"]["digest"] = first["digest"]
        self.engine.records.put(record)
        self.assertEqual(self.engine.drive(rollback["operationId"])["phase"], "complete")
        self.assertEqual(self.engine.active("staging")["digest"], first["digest"])
        self.assertEqual(self.host.cut, "state-with-accepted-job-and-git-history")

    def test_incompatible_schema_never_starts_replacement(self):
        req = self.upload()
        self.host.version = 8
        self.assertEqual(self.engine.drive(req["operationId"])["error"], "incompatible_schema")
        self.assertNotIn("start-service", self.host.events)

    def test_arbitrary_target_path_command_and_identity_are_rejected(self):
        req = self.upload()
        for change in ({"target": "../../root"}, {"operation": "shell"}, {"path": "/root"}, {"revision": "main;id"}, {"digest": "x"}, {"operationId": "../other"}):
            with self.assertRaises(ValueError):
                validate_request({**req, **change})

    def test_archive_refuses_traversal_links_and_duplicate_entries(self):
        for name, kind in (("../../escape", tarfile.REGTYPE), ("bun", tarfile.SYMTYPE), ("runner.js", tarfile.REGTYPE)):
            file = self.root / "bad.tar.gz"
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.linkname = "/etc/passwd"
            archive(file, "a" * 40, entry)
            with self.assertRaises(ValueError):
                unpack(file, self.root / "unpacked", "a" * 40)
        self.assertFalse((self.root / "unpacked").exists())

    def test_installed_directories_are_traversable_under_controller_umask(self):
        req = self.upload()
        mask = os.umask(0o077)
        try:
            self.assertEqual(self.engine.drive(req["operationId"])["phase"], "complete")
        finally:
            os.umask(mask)
        release = self.engine.releases / req["digest"]
        for directory in (release, release / "web"):
            self.assertEqual(directory.stat().st_mode & 0o777, 0o755)
        self.assertEqual((release / "bun").stat().st_mode & 0o777, 0o755)

    def test_failed_critical_operation_blocks_later_deploy_until_resumed(self):
        first = self.upload()
        with patch.object(self.host, "resume_dispatch", side_effect=ValueError("dispatch_unavailable")):
            self.assertEqual(self.engine.drive(first["operationId"])["phase"], "failed")
        second = self.upload("b" * 40)
        restarted = Engine(self.engine.root, self.engine.releases, self.host)
        with self.assertRaisesRegex(ValueError, "unfinished_deployment_requires_resume"):
            restarted.drive(second["operationId"])
        self.assertEqual(restarted.active("staging")["digest"], first["digest"])
        self.assertEqual(restarted.drive(first["operationId"])["phase"], "complete")
        self.assertEqual(restarted.drive(second["operationId"])["phase"], "complete")
        self.assertEqual(restarted.drive(first["operationId"])["phase"], "complete")
        self.assertEqual(restarted.active("staging")["digest"], second["digest"])
        self.assertEqual((restarted.releases.parent / "current-staging").resolve(), (restarted.releases / second["digest"]).resolve())

    def test_rollback_retry_preserves_original_predecessor_and_rejects_identity_reuse(self):
        first = self.upload()
        second = self.upload("b" * 40)
        self.engine.drive(first["operationId"])
        self.engine.drive(second["operationId"])
        op_id = str(uuid.uuid4())
        pending = self.engine.rollback(op_id, "staging")
        self.assertEqual(pending["request"]["digest"], first["digest"])
        completed = self.engine.drive(op_id)
        self.assertEqual(completed["phase"], "complete")
        self.assertEqual(self.engine.previous("staging")["digest"], second["digest"])
        self.assertEqual(self.engine.rollback(op_id, "staging"), completed)
        with self.assertRaisesRegex(ValueError, "operation_conflict"):
            self.engine.rollback(op_id, "production")
        with self.assertRaisesRegex(ValueError, "operation_conflict"):
            self.engine.rollback(first["operationId"], "staging")

    def test_provenance_enforces_all_identity_dimensions(self):
        req = self.upload()
        folder = self.engine.uploads / req["operationId"]
        with patch("artifact.subprocess.run") as verify:
            verify_provenance(folder / "artifact.tar.gz", folder / "attestation.jsonl", req["revision"], req["digest"], Path("/pinned/gh"))
            args = verify.call_args.args[0]
            for option, value in (("--repo", "apshenichniy/personal-wiki"), ("--source-ref", "refs/heads/main"), ("--source-digest", req["revision"]), ("--signer-digest", req["revision"]), ("--signer-workflow", "apshenichniy/personal-wiki/.github/workflows/release.yml")):
                self.assertEqual(args[args.index(option) + 1], value)
            self.assertIn("--deny-self-hosted-runners", args)
            with self.assertRaisesRegex(ValueError, "digest_mismatch"):
                verify_provenance(folder / "artifact.tar.gz", folder / "attestation.jsonl", req["revision"], "0" * 64, Path("/pinned/gh"))


if __name__ == "__main__":
    unittest.main()
