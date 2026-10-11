#!/usr/bin/python3
"""Explicit disposable Ubuntu test. Never part of npm test, never on live host.
Usage: python3 tests/egress-runtime.py /absolute/path/phone-network.py
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

IDENTIFIER = 'dddddddddddddddd'
UNIT = 'cloudphone-' + IDENTIFIER + '.service'
GROUP = '/sys/fs/cgroup/system.slice/' + UNIT
ALIAS = '11.255.255.254'

def run(args, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=15)
    if check and result.returncode:
        raise RuntimeError(str(args) + ': ' + result.stderr)
    return result

def check(value, message):
    if not value:
        raise RuntimeError(message)
    print('PASS ' + message, flush=True)

def main():
    check(os.geteuid() == 0 and socket.gethostname() == 'cloudphone-runtime' and Path('/proc/1/comm').read_text().strip() == 'systemd', 'disposable VM guard')
    launcher = str(Path(sys.argv[1]).resolve())
    check(run(['systemctl', 'show', UNIT, '-p', 'LoadState', '--value']).stdout.strip() == 'not-found', 'reserved test unit absent')
    check('cpnet_' + IDENTIFIER not in run(['nft', 'list', 'tables']).stdout, 'reserved firewall absent')
    check(ALIAS not in run(['ip', '-j', 'address']).stdout, 'test host alias absent')
    # Actual filter load proves AF_UNIX/AF_PACKET denial; this process is not a
    # phone and will exit immediately after this standalone subprocess check.
    code = "import importlib.util,socket; s=importlib.util.spec_from_file_location('network'," + repr(launcher) + "); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.restrict_sockets();\nfor family in [socket.AF_UNIX,socket.AF_PACKET]:\n try: socket.socket(family,socket.SOCK_STREAM); raise RuntimeError('socket allowed')\n except PermissionError: pass\nprint('seccomp-denials-ok')"
    check(run(['/usr/bin/python3', '-c', code]).stdout.strip() == 'seccomp-denials-ok', 'actual inherited seccomp rejects host Unix/packet sockets')
    raw = "import importlib.util,ctypes; s=importlib.util.spec_from_file_location('network'," + repr(launcher) + "); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.restrict_sockets(); c=ctypes.CDLL(None,use_errno=True); r=c.syscall(ctypes.c_long(41),ctypes.c_ulonglong(0x100000001),ctypes.c_int(1),ctypes.c_int(0)); assert r == -1 and ctypes.get_errno()==1; print('masked-ok')"
    check(run(['/usr/bin/python3', '-B', '-c', raw]).stdout.strip() == 'masked-ok', 'high-bit raw syscall cannot bypass Unix socket denial')
    monitor = None
    listener = socket.socket()
    try:
        run(['ip', 'address', 'add', ALIAS + '/32', 'dev', 'lo'])
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('0.0.0.0', 80)); listener.listen(16)
        control = socket.create_connection((ALIAS, 80), timeout=2); control.close()
        check(True, 'host public-alias listener reachable as negative control')
        run(['systemd-run', '--quiet', '--unit', UNIT, '--property=Description=Cloudphone ' + IDENTIFIER,
             '--property=PrivateNetwork=yes', '--property=MemoryMax=134217728', '--property=MemorySwapMax=0',
             '--property=OOMPolicy=kill', '/usr/bin/sleep', '180'])
        pid = run(['systemctl', 'show', UNIT, '-p', 'MainPID', '--value']).stdout.strip()
        monitor = subprocess.Popen(['/usr/bin/python3', launcher, 'start', IDENTIFIER, pid, '134217728'], stdout=subprocess.PIPE, text=True)
        import select
        check(bool(select.select([monitor.stdout], [], [], 15)[0]), 'bounded helper readiness')
        ready = json.loads(monitor.stdout.readline())
        print(json.dumps(ready), flush=True)
        check(ready['ready'] is True, 'actual helper ready')
        live = run(['/usr/bin/python3', launcher, 'verify', IDENTIFIER, pid, '134217728', json.dumps(ready)])
        check(json.loads(live.stdout) == ready, 'read-only live helper/firewall verification')
        forged = dict(ready); forged['helperStarttime'] = '0'
        check(run(['/usr/bin/python3', launcher, 'verify', IDENTIFIER, pid, '134217728', json.dumps(forged)], check=False).returncode != 0, 'forged helper identity rejected')
        for key in ['monitorPid', 'launcherPid', 'helperPid']:
            check(Path(f"/proc/{ready[key]}/cgroup").read_text().strip() == '0::/system.slice/' + UNIT, key + ' charged in phone cgroup')
        helper = ready['helperPid']
        status = Path(f'/proc/{helper}/status').read_text()
        print(status, flush=True)
        check(os.readlink(f'/proc/{helper}/ns/pid') != os.readlink('/proc/self/ns/pid'), 'helper isolated PID namespace')
        check(not list(Path(f'/proc/{helper}/root/etc').iterdir()) and not list(Path(f'/proc/{helper}/root/run').iterdir()), 'helper has no host files/Unix paths')
        prefix = ['nsenter', '-t', pid, '-n']
        public = run(prefix + ['curl', '--noproxy', '*', '--max-time', '10', '-sS', '-o', '/dev/null', '-w', '%{http_code}', 'https://1.1.1.1'])
        check(public.stdout in ['200', '301', '302'], 'real HTTPS public egress ' + public.stdout)
        dns = "import socket,struct; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(4); q=struct.pack('!HHHHHH',1234,256,1,0,0,0)+b'\\x07example\\x03com\\x00'+struct.pack('!HH',1,1); s.sendto(q,('1.1.1.1',53)); r=s.recv(4096); assert r[:2]==q[:2] and len(r)>len(q); print('dns-ok')"
        check(run(prefix + ['python3', '-c', dns]).stdout.strip() == 'dns-ok', 'real public DNS reply through slirp')
        for address in [ALIAS, '10.0.2.15', '169.254.169.254', '168.63.129.16', '192.168.1.1', '10.0.2.2']:
            result = run(prefix + ['curl', '--noproxy', '*', '--connect-timeout', '1', '--max-time', '2', '-sS', '-o', '/dev/null', 'http://' + address], check=False)
            check(result.returncode != 0, 'denied host/private/metadata ' + address)
        rules = run(['nft', '-j', 'list', 'table', 'inet', 'cpnet_' + IDENTIFIER]).stdout
        print(rules, flush=True)
        expressions = [entry['rule']['expr'] for entry in json.loads(rules)['nftables'] if 'rule' in entry and entry['rule']['chain'] == 'public_only']
        local = next(expr for expr in expressions if any('match' in item and 'fib' in item['match']['left'] for item in expr))
        check(any(item.get('counter', {}).get('packets', 0) > 0 for item in local), 'kernel fib local rule dropped reachable host public address')
        check(run(['/usr/bin/python3', launcher, 'stop', IDENTIFIER], check=False).returncode != 0, 'firewall removal refused while populated')
        duplicate = run(['/usr/bin/python3', launcher, 'start', IDENTIFIER, pid, '134217728'], check=False)
        check(duplicate.returncode != 0, 'duplicate helper/table refused')
        if os.environ.get('EGRESS_TEST_FAILURE') == 'policy':
            # Add a deny (not an allow) to alter policy without creating an escape.
            run(['nft', 'add', 'rule', 'inet', 'cpnet_' + IDENTIFIER, 'public_only', 'counter', 'drop'])
            monitor.wait(timeout=15)
            check(monitor.returncode != 0, 'firewall change terminates monitor')
            for _ in range(30):
                if not Path('/proc/' + pid).exists(): break
                time.sleep(.1)
            check(not Path('/proc/' + pid).exists(), 'firewall change terminates phone through pinned PID')
            return
        os.kill(ready['monitorPid'], signal.SIGKILL)
        monitor.wait(timeout=5)
        for _ in range(30):
            if not Path(f'/proc/{helper}').exists(): break
            time.sleep(.1)
        check(not Path(f'/proc/{helper}').exists(), 'monitor death closes exit FD and kills packet helper')
        dead = run(prefix + ['curl', '--noproxy', '*', '--max-time', '2', '-sS', '-o', '/dev/null', 'https://1.1.1.1'], check=False)
        check(dead.returncode != 0, 'helper death fails closed, no host network fallback')
    finally:
        run(['systemctl', 'stop', UNIT], check=False)
        if monitor and monitor.poll() is None:
            monitor.kill(); monitor.wait(timeout=5)
        listener.close()
        run(['ip', 'address', 'del', ALIAS + '/32', 'dev', 'lo'], check=False)
        if 'cpnet_' + IDENTIFIER in run(['nft', 'list', 'tables']).stdout:
            run(['/usr/bin/python3', launcher, 'stop', IDENTIFIER])
        check('cpnet_' + IDENTIFIER not in run(['nft', 'list', 'tables']).stdout, 'owned firewall cleaned after process quiescence')

if __name__ == '__main__': main()
