#!/usr/bin/env python3
"""Read-only host checks; no VMs, loop attachments, mounts or sockets created."""
import fcntl
import glob
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys


def inspect(mode='dashboard', port=8790):
    failures = []
    checks = []
    def check(name, action):
        try:
            detail = action()
            checks.append({'check': name, 'ok': True, 'detail': detail})
        except Exception as error:
            failures.append(name)
            checks.append({'check': name, 'ok': False, 'detail': str(error)})
    def need(condition, message):
        if not condition:
            raise RuntimeError(message)
        return message
    check('root', lambda: need(os.geteuid() == 0, 'Root required for actual device/cgroup access checks'))
    def ubuntu():
        values = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
        return need(values.get('ID', '').strip('"') == 'ubuntu' and values.get('VERSION_ID', '').strip('"') in ('22.04', '24.04'), 'Ubuntu 22.04/24.04 LTS required')
    check('ubuntu', ubuntu)
    check('architecture', lambda: need(os.uname().machine == 'x86_64', 'x86_64 required'))
    def systemd():
        need(Path('/proc/1/comm').read_text().strip() == 'systemd', 'PID 1 must be systemd')
        result = subprocess.run(['systemctl', 'show', '--property=Version', '--value'], capture_output=True, text=True, timeout=10)
        return need(result.returncode == 0 and result.stdout.strip(), 'System systemd manager reachable')
    check('systemd', systemd)
    def cgroups():
        base = Path('/sys/fs/cgroup')
        need({'memory', 'cpu', 'pids', 'io'}.issubset(set((base / 'cgroup.controllers').read_text().split())), 'Unified cgroup2 memory/cpu/pids/io controllers required')
        need(not (os.statvfs(base).f_flag & os.ST_RDONLY), 'cgroup2 mount must be writable')
        return need(os.access(base / 'cgroup.subtree_control', os.W_OK), 'Writable cgroup subtree control required; no probe writes performed')
    check('cgroup2', cgroups)
    def kvm():
        fd = os.open('/dev/kvm', os.O_RDWR | os.O_CLOEXEC)
        try:
            need(fcntl.ioctl(fd, 0xAE00, 0) == 12, 'KVM API 12 required')
        finally:
            os.close(fd)
        return 'KVM API 12 accessible; VM creation deliberately not probed'
    check('kvm', kvm)
    def loops():
        capabilities = next(line.split()[1] for line in Path('/proc/self/status').read_text().splitlines() if line.startswith('CapEff:'))
        need(int(capabilities, 16) & (1 << 21), 'CAP_SYS_ADMIN needed for loop/mount orchestration')
        fd = os.open('/dev/loop-control', os.O_RDWR | os.O_CLOEXEC)
        os.close(fd)
        free = []
        for name in glob.glob('/dev/loop[0-9]*'):
            if not stat.S_ISBLK(os.stat(name).st_mode):
                continue
            fd = os.open(name, os.O_RDWR | os.O_CLOEXEC)
            try:
                try:
                    fcntl.ioctl(fd, 0x4C05, bytearray(232), True)  # LOOP_GET_STATUS64 only
                except OSError as error:
                    if error.errno == 6:  # ENXIO = unbound
                        free.append(name)
                    else:
                        raise
            finally:
                os.close(fd)
        return need(bool(free), 'At least one existing accessible unbound loop device required; no device attached/created')
    check('loop', loops)
    def binaries():
        required = ['node', 'npm', 'git', 'curl', 'systemctl', 'losetup', 'mount', 'umount', 'mkfs.ext4', 'truncate', 'unshare', 'ip', 'flock', 'findmnt', 'sha256sum', 'tar', 'ss', 'fallocate', 'getent', 'systemd-run']
        missing = [name for name in required if shutil.which(name) is None]
        need(not missing, 'Missing executables: ' + ', '.join(missing))
        need(Path('/usr/bin/node').exists(), '/usr/bin/node required by systemd service')
        major = int(subprocess.check_output(['/usr/bin/node', '-p', 'process.versions.node.split(".")[0]'], text=True).strip())
        return need(major in (22, 24), 'Node.js 22 or 24 LTS required with npm')
    check('dependencies', binaries)
    def resources():
        available = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))) // 1024
        required = 8192 if mode == 'standalone' else 2048
        need(available >= required, f'Available host RAM {available} MiB; need {required} MiB including reserve')
        # Conservative full SDK/extraction + one disk + reserve; validate both filesystems.
        for location in ['/opt', '/var/lib']:
            free = shutil.disk_usage(location).free // 1024**3
            need(free >= 50, f'{location}: {free} GiB free; require 50 GiB for staging/SDK/phone/reserve')
        return 'Host RAM and disk reserve checks passed (not a reservation)'
    check('resources', resources)
    def filesystem():
        result = subprocess.check_output(['findmnt', '-n', '-o', 'FSTYPE', '--target', '/var/lib'], text=True).strip()
        return need(result in ('ext4', 'xfs'), 'State requires local ext4 or XFS, not overlay/COW/tmpfs')
    check('state-filesystem', filesystem)
    check('kvm-group', lambda: need(subprocess.run(['getent', 'group', 'kvm'], capture_output=True).returncode == 0, 'Existing kvm group required; installer does not create groups'))
    def port_check():
        need(1024 <= port <= 65535 and port != 8787, 'Use an unprivileged port other than live 8787')
        result = subprocess.run(['ss', '-H', '-ltn', 'sport = :' + str(port)], check=True, capture_output=True, text=True)
        need(not result.stdout.strip(), 'Requested TCP port already listening')
        return f'No listener observed on port {port}; availability is not reserved'
    check('web-port', port_check)
    return {'supported': not failures, 'mode': mode, 'checks': checks}

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'dashboard'
    if mode not in ('dashboard', 'standalone'):
        sys.exit('Mode must be dashboard or standalone')
    try:
        result = inspect(mode, int(sys.argv[2]) if len(sys.argv) > 2 else 8790)
    except ValueError:
        sys.exit('Port must be an integer')
    print(json.dumps(result, indent=2))
    sys.exit(0 if result['supported'] else 1)
