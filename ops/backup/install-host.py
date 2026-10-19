#!/usr/bin/env python3
"""Owner-admin provisioning. Credentials/key are supplied privately, never generated only on VPS."""
import os
from pathlib import Path
import shutil
import subprocess

if os.geteuid() != 0:
    raise SystemExit('Owner administrator required')
os.umask(0o077)
source = Path(__file__).resolve().parent
for path in (Path('/etc/personal-wiki/backup/r2.json'), Path('/etc/personal-wiki/backup/restic-password')):
    if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077:
        raise SystemExit('Private backup credentials and externally retained recovery key required')
root = Path('/var/lib/personal-wiki-backup');root.mkdir(exist_ok=True,mode=0o700)
target = Path('/opt/personal-wiki-backup');target.mkdir(exist_ok=True,mode=0o700)
for name in ('core.py','host_backup.py','restore.py','status.py'):
    shutil.copyfile(source/name,target/name);(target/name).chmod(0o600)
for name in ('personal-wiki-backup@.service','personal-wiki-backup.timer'):
    shutil.copyfile(source/name,Path('/etc/systemd/system')/name)
subprocess.run(['systemctl','daemon-reload'],check=True)
# The operator initializes restic and verifies a first point before enabling the timer.
print('Backup component installed; timer activation follows a verified recovery point.')
