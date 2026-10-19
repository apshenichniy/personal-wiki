#!/usr/bin/env python3
"""Exercise the inner agent boundary under the real Runner's outer systemd policy."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def main():
    if os.geteuid() != 0:
        raise SystemExit('Host administrator required for systemd sandbox verification')
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name('personal-wiki-runner@.service')
    # Replace only application wiring and retry behavior; keep every hardening,
    # privilege, resource and filesystem property from the deployed template.
    wiring = {'Type', 'WorkingDirectory', 'Environment', 'EnvironmentFile', 'RuntimeDirectory',
              'RuntimeDirectoryMode', 'LoadCredential', 'ExecStartPre', 'ExecStart',
              'Restart', 'RestartSec', 'SuccessExitStatus'}
    properties = []
    section = ''
    for line in source.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):continue
        if line.startswith('['):section = line;continue
        if section == '[Service]' and line.split('=', 1)[0] not in wiring:
            properties.extend(['--property', line])
    script = '''import os,pathlib
assert os.getpid()<64, "host PID namespace exposed"
assert not pathlib.Path("/etc/personal-wiki").exists(), "host secrets visible"
assert not pathlib.Path("/var/lib/personal-wiki-staging").exists(), "library visible"
assert not pathlib.Path("/var/lib/personal-wiki-runner").exists(), "runner credentials visible"
assert not os.access("/proc/sys/kernel/hostname",os.W_OK), "host tunables writable"
pathlib.Path("/tmp/probe").write_text("temporary workspace works")
print("private PID/mount boundary and denied host data verified")
'''
    unit = 'personal-wiki-sandbox-check-' + uuid.uuid4().hex[:12]
    command = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit', unit, *properties,
               '/usr/bin/bwrap', '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
               '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
               '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
               '--chdir', '/tmp', '--', '/usr/bin/python3', '-c', script]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        if result.returncode:
            raise SystemExit('Runner systemd/bubblewrap boundary failed: ' + result.stderr.strip()[:1000])
        if 'denied host data verified' not in result.stdout:
            raise SystemExit('Sandbox verification evidence missing')
        print(json.dumps({'systemdRunnerBoundary': 'verified', 'hostDataDenied': True,
                          'privatePidNamespace': True, 'kernelTunablesWritable': False}))
    finally:
        subprocess.run(['systemctl', 'stop', unit + '.service'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':main()
