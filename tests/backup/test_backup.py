import json
from contextlib import closing
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ops/backup'))
from core import Restic, copy_cut, manifest, verify_cut, hash_file


class Recovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def cut(self):
        cut = self.root / 'cut'; cut.mkdir(mode=0o700)
        (cut / 'originals').mkdir(mode=0o700)
        data = b'synthetic original with a correction, not only an object key'
        import hashlib
        digest = hashlib.sha256(data).hexdigest()
        (cut / 'originals' / digest).write_bytes(data)
        (cut / 'originals.json').write_text(json.dumps([{'key':'providers/staging/synthetic.json','sha256':digest,'byteLength':len(data)}]))
        manifest(cut, {'checkpointAt':1, 'kind':'daily'})
        return cut

    def store(self):
        binary = shutil.which('restic')
        self.assertIsNotNone(binary, 'Install pinned tools with mise install before verification')
        password = self.root / 'password';password.write_text('synthetic-backup-test-password');password.chmod(0o600)
        env = {**os.environ, 'RESTIC_REPOSITORY':str(self.root / 'encrypted'), 'RESTIC_PASSWORD_FILE':str(password), 'RESTIC_CACHE_DIR':str(self.root / 'cache')}
        store = Restic(binary, env);store.run('init')
        return store

    def test_encrypted_roundtrip_without_primary_and_wrong_key_denied(self):
        store = self.store();cut=self.cut()
        snapshot=store.save(cut,self.root,'daily')
        shutil.rmtree(cut)
        restored,metadata=store.restore(snapshot,self.root/'empty')
        self.assertEqual(metadata['checkpointAt'],1)
        self.assertTrue((restored/'originals.json').exists())
        wrong=self.root/'wrong';wrong.write_text('wrong-key')
        with patch.dict(store.environment, {'RESTIC_PASSWORD_FILE':str(wrong)}):
            with self.assertRaisesRegex(ValueError,'restic_operation_failed'):
                store.run('snapshots')
        # Repository pack files must not contain the original plaintext.
        for file in (self.root/'encrypted/data').rglob('*'):
            if file.is_file(): self.assertNotIn(b'synthetic original with a correction',file.read_bytes())

    def test_failed_readback_never_marks_snapshot_complete_or_runs_retention(self):
        store=self.store();cut=self.cut()
        with patch('core.verify_cut', side_effect=ValueError('checksum')), patch.object(store,'retain') as retain:
            with self.assertRaisesRegex(ValueError,'checksum'):store.save(cut,self.root,'daily')
            retain.assert_not_called()
        points=json.loads(store.run('snapshots'))
        self.assertEqual(len(points),1)
        self.assertIn('pending',points[0]['tags']);self.assertNotIn('complete',points[0]['tags'])
        with self.assertRaisesRegex(ValueError,'verified_recovery_point_required'):
            store.restore(points[0]['id'],self.root/'empty')

    def test_retention_leaves_pinned_migration_point(self):
        store=self.store();cut=self.cut()
        pinned=store.save(cut,self.root,'migration')
        daily=store.save(cut,self.root,'daily')
        store.retain()
        ids={p['id'] for p in json.loads(store.run('snapshots'))}
        self.assertIn(pinned,ids);self.assertIn(daily,ids)

    def test_corrupt_missing_extra_and_linked_files_rejected(self):
        cut=self.cut();file=next((cut/'originals').iterdir());original=file.read_bytes()
        file.write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError,'recovery_checksum_differs'):verify_cut(cut)
        file.write_bytes(original);file.unlink()
        with self.assertRaisesRegex(ValueError,'recovery_file_set_differs'):verify_cut(cut)
        file.symlink_to(self.root/'outside')
        with self.assertRaisesRegex(ValueError,'restored_symlink'):verify_cut(cut)

    def test_original_manifest_alone_is_not_backup(self):
        cut=self.cut();next((cut/'originals').iterdir()).unlink();manifest(cut,{'checkpointAt':1})
        with self.assertRaisesRegex(ValueError,'missing_original_bytes'):verify_cut(cut)

    def test_snapshot_includes_wal_and_complete_transaction_under_writer(self):
        source=self.root/'live';source.mkdir()
        file=source/'library.sqlite';db=sqlite3.connect(file)
        db.execute('PRAGMA journal_mode=WAL');db.execute('CREATE TABLE obligations (id INTEGER PRIMARY KEY,value INTEGER)');db.executemany('INSERT INTO obligations VALUES (?,0)',[(i,) for i in range(100)]);db.commit()
        stop=threading.Event()
        def write():
            with closing(sqlite3.connect(file)) as other:
                while not stop.is_set():
                    with other:other.execute('UPDATE obligations SET value=value+1')
        writer=threading.Thread(target=write);writer.start()
        try:
            copy_cut(source,self.root/'cut')
        finally:
            stop.set();writer.join();db.close()
        with closing(sqlite3.connect(self.root/'cut/library.sqlite')) as cut:
            self.assertEqual(cut.execute('SELECT count(*),count(DISTINCT value) FROM obligations').fetchone(),(100,1))
            self.assertEqual(cut.execute('PRAGMA journal_mode').fetchone(),('delete',))
        self.assertFalse((self.root/'cut/library.sqlite-wal').exists())

    def test_guardian_transport_fifo_is_excluded_but_durable_result_survives(self):
        source=self.root/'runner';attempt=source/'agent-spool'/'22222222-2222-4222-8222-222222222222'/'11111111-1111-4111-8111-111111111111'
        (attempt/'work').mkdir(parents=True);os.mkfifo(attempt/'work/result.json')
        (attempt/'output.json').write_text('{"retained":true}')
        (attempt/'exit.json').write_text('{"processStopped":true}')
        copy_cut(source,self.root/'cut',runner_spool=True)
        copied=self.root/'cut'/attempt.relative_to(source)
        self.assertFalse((copied/'work/result.json').exists())
        self.assertEqual((copied/'output.json').read_text(),'{"retained":true}')
        self.assertTrue((copied/'exit.json').is_file())
        os.mkfifo(source/'unexpected-pipe')
        with self.assertRaisesRegex(ValueError,'unsupported_state_file'):
            copy_cut(source,self.root/'other',runner_spool=True)

    def test_killed_checkpoint_recovers_recorded_units_from_durable_journal(self):
        import host_backup
        script = """
import sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import host_backup as h
h.ROOT=Path(sys.argv[2]);h.active=lambda unit: not unit.endswith('@production.service')
class Host:
 def stop_runners(self):pass
 def stop_service(self,target):pass
 def assert_fenced(self,target):pass
h.DeploymentHost=Host;h.run=lambda *args:None
with h.checkpoint('daily'):
 (h.ROOT/'stopped').touch()
 time.sleep(60)
"""
        child=subprocess.Popen([sys.executable,'-c',script,str(Path(host_backup.__file__).parent),str(self.root)])
        try:
            deadline=time.monotonic()+5
            while not (self.root/'stopped').exists() and time.monotonic()<deadline:time.sleep(.01)
            self.assertTrue((self.root/'stopped').exists())
            child.kill();child.wait(timeout=5)
            self.assertTrue((self.root/'checkpoint-owner.json').exists())
            with patch.object(host_backup,'ROOT',self.root),patch.object(host_backup,'run') as run:
                host_backup.recover_checkpoint('daily')
            self.assertEqual([call.args for call in run.call_args_list],[('systemctl','start','pocket-id.service'),('systemctl','start','personal-wiki-service@staging.service'),('systemctl','start','personal-wiki-runner@staging.service')])
            self.assertFalse((self.root/'checkpoint-owner.json').exists())
        finally:
            if child.poll() is None:child.kill();child.wait()

    def test_restore_quarantines_without_erasing_unknown_cost_evidence(self):
        from restore import prepare
        root=self.root/'recovered';(root/'accounting').mkdir(parents=True)
        ledger=root/'accounting/provider-accounting.sqlite'
        with closing(sqlite3.connect(ledger)) as db, db:
            db.execute('CREATE TABLE provider_configuration(singleton INTEGER,quarantined INTEGER,reason TEXT)')
            db.execute('INSERT INTO provider_configuration VALUES(1,0,NULL)')
            db.execute('CREATE TABLE provider_operations(record TEXT)')
            db.execute('INSERT INTO provider_operations VALUES(?)', ('{"phase":"unknown","reserved":100000000}',))
        prepare(root,self.root/'unused-tools')
        with closing(sqlite3.connect(ledger)) as db, db:
            self.assertEqual(db.execute('SELECT quarantined,reason FROM provider_configuration').fetchone(),(1,'restore_external_accounting_unknown'))
            self.assertEqual(db.execute('SELECT record FROM provider_operations').fetchone(),('{"phase":"unknown","reserved":100000000}',))
        self.assertEqual(json.loads((root/'recovery-state.json').read_text())['dispatch'],False)

    def test_cut_refuses_symlink_and_restore_refuses_existing_target(self):
        source=self.root/'live';source.mkdir();(source/'secret').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError,'state_symlink'):copy_cut(source,self.root/'cut')
        store=self.store()
        with self.assertRaisesRegex(ValueError,'empty_new_restore_target_required'):store.restore('latest',source)


if __name__=='__main__':unittest.main()
