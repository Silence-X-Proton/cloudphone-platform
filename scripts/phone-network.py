#!/usr/bin/python3
"""Trusted root-only foreground launcher. No daemon, shell, host-network fallback.
start ID MAINPID MEMORY_BYTES; stop ID (only after cgroup is empty).
Caller must keep supervisor waiting until the JSON readiness line and stop the
phone if this process exits. stdout is a private broker pipe, never tenant input.
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys

ID = re.compile(r'[a-f0-9]{16}')
DENIED = ('0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, '
          '169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, '
          '192.31.196.0/24, 192.52.193.0/24, 192.88.99.0/24, 192.168.0.0/16, '
          '192.175.48.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, '
          '224.0.0.0/4, 240.0.0.0/4, 168.63.129.16/32')

def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=10, **kwargs).stdout

def policy(identifier):
    if not ID.fullmatch(identifier):
        raise ValueError('Invalid ID')
    return f'''create table inet cpnet_{identifier} {{ comment "cloudphone-network-v1:{identifier}"; }}
 table inet cpnet_{identifier} {{
 chain public_only {{
  meta nfproto != ipv4 counter drop
  fib daddr type local counter drop
  ip daddr {{ {DENIED} }} counter drop
  udp dport 53 ip daddr {{ 1.1.1.1, 9.9.9.9 }} counter accept
  tcp dport {{ 80, 443 }} counter accept
  counter drop
 }}
 chain output {{
  type filter hook output priority 0; policy accept;
  socket cgroupv2 level 2 "system.slice/cloudphone-{identifier}.service" jump public_only
 }}
}}
'''

def starttime(pid):
    return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]

def firewall_digest(identifier):
    data = json.loads(run(['/usr/sbin/nft', '-j', 'list', 'table', 'inet', 'cpnet_' + identifier]))
    def normalized(value):
        if isinstance(value, dict):
            return {k: normalized(v) for k, v in value.items() if k not in ['handle', 'metainfo', 'counter']}
        if isinstance(value, list):
            return [normalized(v) for v in value if not isinstance(v, dict) or 'metainfo' not in v]
        return value
    return hashlib.sha256(json.dumps(normalized(data), sort_keys=True).encode()).hexdigest()


def verify(identifier, mainpid, memory, evidence):
    group = '/system.slice/cloudphone-' + identifier + '.service'
    if evidence.get('id') != identifier or evidence.get('cgroup') != group or evidence.get('mainPid') != int(mainpid) or evidence.get('mainStarttime') != starttime(mainpid):
        raise RuntimeError('Network evidence identity mismatch')
    base = Path('/sys/fs/cgroup' + group)
    if (base / 'memory.max').read_text().strip() != memory or (base / 'memory.swap.max').read_text().strip() != '0':
        raise RuntimeError('Network memory limits changed')
    hostnet = os.readlink('/proc/self/ns/net')
    if os.readlink(f'/proc/{mainpid}/ns/net') == hostnet:
        raise RuntimeError('Phone entered host network')
    for role, exe in [('monitor', '/usr/bin/python3'), ('launcher', '/usr/bin/unshare'), ('helper', '/usr/bin/slirp4netns')]:
        pid = evidence.get(role + 'Pid')
        if not isinstance(pid, int) or pid < 1 or starttime(pid) != evidence.get(role + 'Starttime'):
            raise RuntimeError('Helper PID identity changed')
        if os.readlink(f'/proc/{pid}/exe') != os.path.realpath(exe) or Path(f'/proc/{pid}/cgroup').read_text().strip() != '0::' + group:
            raise RuntimeError('Helper executable/cgroup mismatch')
        status = dict(line.split(':', 1) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
        if status.get('Uid', '').split() != ['0'] * 4 or os.readlink(f'/proc/{pid}/ns/net') != hostnet:
            raise RuntimeError('Helper UID/network mismatch')
        if role != 'monitor' and int(status['PPid']) != evidence['monitorPid' if role == 'launcher' else 'launcherPid']:
            raise RuntimeError('Helper ancestry mismatch')
        if role == 'monitor':
            command = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            if str(Path(__file__).resolve()).encode() not in command or b'start' not in command:
                raise RuntimeError('Monitor command mismatch')
        if role == 'helper':
            if status.get('Seccomp', '').strip() != '2' or int(status.get('Seccomp_filters', '0')) < 2 or status.get('CapEff', '').strip() != '0000000000000400' or status.get('NoNewPrivs', '').strip() != '1':
                raise RuntimeError('Helper confinement changed')
            if os.readlink(f'/proc/{pid}/ns/pid') == os.readlink('/proc/self/ns/pid'):
                raise RuntimeError('Helper PID namespace mismatch')
            for directory in ['etc', 'run']:
                if list(Path(f'/proc/{pid}/root/{directory}').iterdir()):
                    raise RuntimeError('Helper exposes host files')
    if firewall_digest(identifier) != evidence.get('firewallDigest'):
        raise RuntimeError('Network firewall changed')
    return evidence


def restrict_sockets():
    # slirp uses socketpair(AF_UNIX) for its own short-lived TAP setup child;
    # socket(AF_UNIX) is never needed. Deny access to host abstract Unix sockets
    # and packet sockets even after a libslirp compromise. Inherited over exec.
    lib = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    class Arg(ctypes.Structure):
        _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_uint), ('a', ctypes.c_uint64), ('b', ctypes.c_uint64)]
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Arg)]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    context = lib.seccomp_init(0x7fff0000)
    if not context:
        raise RuntimeError('Cannot create seccomp filter')
    try:
        syscall = lib.seccomp_syscall_resolve_name(b'socket')
        if syscall < 0:
            raise RuntimeError('Cannot resolve socket syscall')
        for family in [1, 17]:  # AF_UNIX, AF_PACKET; mask kernel's 32-bit int domain
            comparison = Arg(0, 7, 0xffffffff, family)  # SCMP_CMP_MASKED_EQ
            if lib.seccomp_rule_add_array(context, 0x50000 | errno.EPERM, syscall, 1, ctypes.byref(comparison)) != 0:
                raise RuntimeError('Cannot restrict socket family')
        for name in [b'listen', b'accept', b'accept4']:
            syscall = lib.seccomp_syscall_resolve_name(name)
            if syscall < 0 or lib.seccomp_rule_add_array(context, 0x50000 | errno.EPERM, syscall, 0, None) != 0:
                raise RuntimeError('Cannot deny host listeners')
        if lib.seccomp_load(context) != 0:
            raise RuntimeError('Cannot load seccomp filter')
    finally:
        lib.seccomp_release(context)


def inner(netfd, readyfd, exitfd):
    # Called only by root unshare in the private PID/mount namespace. Remove
    # host sockets/secrets before slirp's own pivot_root and seccomp filter.
    if os.getpid() != 1 or os.geteuid() != 0:
        raise RuntimeError('Private PID namespace required')
    run(['/usr/bin/mount', '--make-rprivate', '/'])
    for target in ['/etc', '/run']:
        run(['/usr/bin/mount', '-t', 'tmpfs', '-o', 'ro,nosuid,nodev,noexec,size=4096', 'tmpfs', target])
    restrict_sockets()
    os.execv('/usr/bin/slirp4netns', ['slirp4netns', '--configure', '--disable-host-loopback',
        '--disable-dns', '--enable-sandbox', '--enable-seccomp', '--netns-type=path',
        f'--ready-fd={readyfd}', f'--exit-fd={exitfd}', f'/proc/self/fd/{netfd}', 'tap0'])

def main():
    if os.geteuid() != 0:
        raise RuntimeError('Root required')
    if len(sys.argv) == 5 and sys.argv[1] == '_inner':
        return inner(*map(int, sys.argv[2:]))
    if len(sys.argv) < 3 or not ID.fullmatch(sys.argv[2]):
        raise ValueError('Usage: start ID MAINPID MEMORY_BYTES | stop ID')
    action, identifier = sys.argv[1:3]
    unit = f'cloudphone-{identifier}.service'
    group = f'/system.slice/{unit}'
    base = Path('/sys/fs/cgroup' + group)
    table = f'cpnet_{identifier}'
    if action == 'stop' and len(sys.argv) == 3:
        # Only ENOENT on the cgroup directory proves absence. Permission/read
        # errors, including a missing events file in an existing group, fail.
        try:
            base.stat()
        except FileNotFoundError:
            pass
        else:
            events = (base / 'cgroup.events').read_text().splitlines()
            if [line for line in events if line.startswith('populated ')] != ['populated 0']:
                raise RuntimeError('Refusing firewall removal while cgroup populated or unknown')
        inventory = json.loads(run(['/usr/sbin/nft', '-j', 'list', 'tables']))
        if not isinstance(inventory, dict) or not isinstance(inventory.get('nftables'), list):
            raise RuntimeError('Invalid firewall inventory')
        matches = []
        for entry in inventory['nftables']:
            if not isinstance(entry, dict) or len(entry) != 1:
                raise RuntimeError('Invalid firewall inventory entry')
            if 'metainfo' in entry and isinstance(entry['metainfo'], dict):
                continue
            item = entry.get('table')
            if not isinstance(item, dict) or not isinstance(item.get('family'), str) or not isinstance(item.get('name'), str):
                raise RuntimeError('Invalid firewall table identity')
            if item['family'] == 'inet' and item['name'] == table:
                matches.append(item)
        if not matches:
            return  # Successful, parsed inventory positively established absence.
        if len(matches) != 1:
            raise RuntimeError('Ambiguous firewall table identity')
        existing = json.loads(run(['/usr/sbin/nft', '-j', 'list', 'table', 'inet', table]))
        tables = [entry['table'] for entry in existing['nftables'] if 'table' in entry]
        if len(tables) != 1 or tables[0].get('family') != 'inet' or tables[0].get('name') != table or tables[0].get('comment') != 'cloudphone-network-v1:' + identifier:
            raise RuntimeError('Foreign firewall table')
        run(['/usr/sbin/nft', 'delete', 'table', 'inet', table])
        return
    if action == 'verify' and len(sys.argv) == 6:
        if len(sys.argv[5]) > 4096 or not all(re.fullmatch(r'[1-9][0-9]*', v) for v in sys.argv[3:5]):
            raise ValueError('Invalid verification arguments')
        print(json.dumps(verify(identifier, sys.argv[3], sys.argv[4], json.loads(sys.argv[5]))))
        return
    if action != 'start' or len(sys.argv) != 5:
        raise ValueError('Invalid operation')
    pid, memory = sys.argv[3:]
    if not re.fullmatch(r'[1-9][0-9]*', pid) or not re.fullmatch(r'[1-9][0-9]*', memory):
        raise ValueError('Invalid PID/memory')
    fields = dict(line.split('=', 1) for line in run(['/usr/bin/systemctl', 'show', unit,
        '-p', 'MainPID,Transient,Description,PrivateNetwork,ControlGroup,ActiveState']).splitlines())
    expected = {'MainPID': pid, 'Transient': 'yes', 'Description': f'Cloudphone {identifier}',
                'PrivateNetwork': 'yes', 'ControlGroup': group, 'ActiveState': 'active'}
    if fields != expected:
        raise RuntimeError('Foreign unit or inactive private namespace')
    if (base / 'memory.max').read_text().strip() != memory or (base / 'memory.swap.max').read_text().strip() != '0':
        raise RuntimeError('Memory boundary mismatch')
    if Path(f'/proc/{pid}/cgroup').read_text().strip() != '0::' + group:
        raise RuntimeError('Main PID membership mismatch')
    if os.readlink(f'/proc/{pid}/ns/net') == os.readlink('/proc/self/ns/net'):
        raise RuntimeError('Host networking forbidden for phone')
    identity = starttime(pid)
    pidfd = os.pidfd_open(int(pid))
    netfd = os.open(f'/proc/{pid}/ns/net', os.O_RDONLY)
    if starttime(pid) != identity:
        raise RuntimeError('Phone PID changed')
    # Charge monitor AND every setup/packet-loop descendant before execution.
    (base / 'cgroup.procs').write_text(str(os.getpid()))
    if Path('/proc/self/cgroup').read_text().strip() != '0::' + group:
        raise RuntimeError('Helper not charged')
    run(['/usr/sbin/nft', '-f', '-'], input=policy(identifier))
    # Duplicate launch refuses an existing table (nft add is otherwise a merge).
    ready_r, ready_w = os.pipe()
    exit_r, exit_w = os.pipe()
    child = None
    def terminate(_sig=None, _frame=None):
        raise InterruptedError('Network monitor terminated')
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        child = subprocess.Popen(['/usr/bin/unshare', '--mount', '--pid', '--fork', '--mount-proc',
            '/usr/bin/python3', str(Path(__file__).resolve()), '_inner', str(netfd), str(ready_w), str(exit_r)],
            pass_fds=(netfd, ready_w, exit_r), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=None)
        os.close(ready_w); os.close(exit_r); os.close(netfd)
        readable, _, _ = select.select([ready_r, pidfd], [], [], 10)
        if pidfd in readable or ready_r not in readable or os.read(ready_r, 1) != b'1':
            raise RuntimeError('Slirp failed readiness')
        # slirp configures before its sandbox; wait until kernel confirms final
        # seccomp and capabilities, not merely its early ready byte.
        slirp = None
        import time
        for _ in range(100):
            children = Path(f'/proc/{child.pid}/task/{child.pid}/children').read_text().split()
            if len(children) == 1:
                candidate = children[0]
                status = dict(line.split(':', 1) for line in Path(f'/proc/{candidate}/status').read_text().splitlines() if ':' in line)
                if status.get('Name', '').strip() == 'slirp4netns' and status.get('Seccomp', '').strip() == '2' and status.get('CapEff', '').strip() == '0000000000000400' and status.get('NoNewPrivs', '').strip() == '1':
                    slirp = candidate; break
            time.sleep(.02)
        if slirp is None or Path(f'/proc/{slirp}/cgroup').read_text().strip() != '0::' + group:
            raise RuntimeError('Slirp final confinement not verified')
        if os.readlink(f'/proc/{slirp}/ns/pid') == os.readlink('/proc/self/ns/pid'):
            raise RuntimeError('Slirp host PID visibility')
        for directory in ['etc', 'run']:
            if list(Path(f'/proc/{slirp}/root/{directory}').iterdir()):
                raise RuntimeError('Host files exposed to slirp')
        evidence = {'ready': True, 'id': identifier, 'monitorPid': os.getpid(), 'helperPid': int(slirp),
            'helperStarttime': starttime(slirp), 'launcherPid': child.pid, 'launcherStarttime': starttime(child.pid),
            'monitorStarttime': starttime(os.getpid()), 'cgroup': group, 'dns': ['1.1.1.1', '9.9.9.9'],
            'mainPid': int(pid), 'mainStarttime': identity, 'firewallDigest': firewall_digest(identifier)}
        verify(identifier, pid, memory, evidence)
        print(json.dumps(evidence), flush=True)
        while child.poll() is None:
            if select.select([pidfd], [], [], 1)[0]:
                break
            verify(identifier, pid, memory, evidence)
        raise RuntimeError('Phone or helper exited')
    finally:
        # pidfd prevents PID reuse from directing failure shutdown at a stranger.
        try: signal.pidfd_send_signal(pidfd, signal.SIGTERM)
        except ProcessLookupError: pass
        os.close(exit_w)  # slirp exit-fd closes even when monitor is killed
        if child:
            try: child.wait(timeout=3)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        # Never remove filtering while any phone/helper process may survive.

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('phone-network: ' + str(error), file=sys.stderr)
        sys.exit(1)
