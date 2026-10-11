#!/usr/bin/env bash
# Destructive tests are confined to the explicitly named disposable Ubuntu guest.
set -euo pipefail
[[ $(hostname) == cloudphone-runtime && $(cat /proc/1/comm) == systemd ]] || exit 77
BASE=/var/lib/runtime-tests
mkdir -p "$BASE" /opt/runtime-tests
exec > >(tee "$BASE/kernel.log") 2>&1
cleanup() {
  systemctl stop runtime-oom.service runtime-peer.service runtime-sandbox.service 2>/dev/null || true
  mountpoint -q "$BASE/volume" && umount "$BASE/volume"
  [[ -z ${LOOP:-} ]] || losetup -d "$LOOP"
}
trap cleanup EXIT
systemctl reset-failed runtime-oom runtime-sandbox runtime-missing-mount 2>/dev/null || true
rm -f "$BASE/oom.events"
getent group runtime-test >/dev/null || groupadd -g 200100 runtime-test
getent passwd runtime-test >/dev/null || useradd -M -u 200100 -g 200100 -s /usr/sbin/nologin runtime-test
cat > /opt/runtime-tests/oom.py <<'PY'
import time
blocks=[]
time.sleep(2)
while True:
    blocks.append(bytearray(8*1024*1024))
    time.sleep(.05)
PY
cat > /opt/runtime-tests/oom-post.sh <<'SH'
#!/bin/sh
cat /sys/fs/cgroup/system.slice/runtime-oom.service/memory.events > /var/lib/runtime-tests/oom.events
SH
chmod 755 /opt/runtime-tests/oom-post.sh
systemd-run --unit runtime-peer --property MemoryMax=32M --property MemorySwapMax=0 /bin/sleep 120
systemd-run --unit runtime-oom --property MemoryMax=64M --property MemorySwapMax=0 --property OOMPolicy=kill --property KillMode=control-group --property ExecStopPost=/opt/runtime-tests/oom-post.sh /usr/bin/python3 /opt/runtime-tests/oom.py
CG=/sys/fs/cgroup/system.slice/runtime-oom.service
cat "$CG/memory.max" "$CG/memory.swap.max" "$CG/memory.oom.group" "$CG/memory.current"
[[ $(cat "$CG/memory.max") == 67108864 && $(cat "$CG/memory.swap.max") == 0 && $(cat "$CG/memory.oom.group") == 1 ]]
for n in $(seq 1 100); do [[ -f "$BASE/oom.events" ]] && break; sleep .1; done
cat "$BASE/oom.events"
awk '$1=="oom_kill" && $2>0 {found=1} END {exit !found}' "$BASE/oom.events"
[[ $(systemctl show runtime-oom -p Result --value) == oom-kill ]]
systemctl is-active runtime-peer
printf 'PASS actual group OOM, zero swap, peer survival\n'
mkdir -p "$BASE/volume"
fallocate -l 128M "$BASE/disk.ext4"
mkfs.ext4 -q -F -m 0 -E nodiscard,lazy_itable_init=0,lazy_journal_init=0 "$BASE/disk.ext4"
[[ $(stat -c %s "$BASE/disk.ext4") == 134217728 ]]
[[ $(( $(stat -c %b "$BASE/disk.ext4") * 512 )) -ge 134217728 ]]
LOOP=$(losetup --find --show "$BASE/disk.ext4")
mount -t ext4 -o rw,nosuid,nodev,noexec,nodiscard "$LOOP" "$BASE/volume"
mkdir -p "$BASE/volume"/{home,tmp,vartmp,shm,run}
chmod 777 "$BASE/volume" "$BASE/volume"/*
mkdir -p /srv/runtime-phone
cat > /opt/runtime-tests/sandbox.py <<'PY'
import os,errno,socket,json
paths=['/srv/runtime-phone','/tmp','/var/tmp','/dev/shm']
assert len(set(os.stat(p).st_dev for p in paths))==1
for p in paths:
    with open(p+'/probe','w') as f:f.write('bounded')
for p in ['/etc/runtime-escape','/opt/runtime-escape']:
    try: open(p,'w'); raise AssertionError('writable system path')
    except OSError as e: assert e.errno in (errno.EROFS,errno.EACCES)
s=socket.socket();s.settimeout(1)
assert s.connect_ex(('10.0.2.2',22)) != 0
print(json.dumps({'uid':os.getuid(),'net':os.readlink('/proc/self/ns/net'),'mount':os.readlink('/proc/self/ns/mnt'),'device':os.stat('/tmp').st_dev}),flush=True)
try:
    with open('/tmp/fill','wb',buffering=0) as f:
        while True:f.write(b'x'*1048576)
except OSError as e:
    assert e.errno==errno.ENOSPC
    print('PASS actual fixed-volume ENOSPC',flush=True)
os.unlink('/tmp/fill')
os.mkdir('/tmp/inodes')
count=0
try:
    while True:
        fd=os.open('/tmp/inodes/'+str(count),os.O_CREAT|os.O_WRONLY,0o600)
        os.close(fd);count+=1
except OSError as e:
    assert e.errno==errno.ENOSPC
    assert os.statvfs('/tmp').f_favail==0
    print('PASS actual inode ENOSPC count='+str(count),flush=True)
assert os.statvfs('/').f_bavail*os.statvfs('/').f_frsize > 10*1024**3
PY
systemd-run --wait --pipe --unit runtime-sandbox --property User=200100 --property Group=200100 --property PrivateNetwork=yes --property ProtectSystem=strict --property ProtectHome=yes --property NoNewPrivileges=yes --property CapabilityBoundingSet= --property MemoryMax=128M --property MemorySwapMax=0 --property "BindPaths=$BASE/volume:/srv/runtime-phone $BASE/volume/tmp:/tmp $BASE/volume/vartmp:/var/tmp $BASE/volume/shm:/dev/shm" --property 'ReadWritePaths=/srv/runtime-phone /tmp /var/tmp /dev/shm' /usr/bin/python3 /opt/runtime-tests/sandbox.py
findmnt --mountpoint "$BASE/volume"; df -h "$BASE/volume" /; stat -c 'image size=%s blocks=%b' "$BASE/disk.ext4"
set +e
systemd-run --wait --pipe --unit runtime-missing-mount --property 'BindPaths=/var/lib/runtime-tests/does-not-exist:/srv/runtime-phone' /bin/touch /var/lib/runtime-tests/SHOULD_NOT_EXIST
rc=$?
set -e
[[ $rc -ne 0 && ! -e "$BASE/SHOULD_NOT_EXIST" ]]
printf 'PASS missing bind source fails closed rc=%s\n' "$rc"
systemctl show runtime-oom -p Result -p ExecMainCode -p ExecMainStatus
printf 'PASS kernel-boundary suite; Android and production manager lifecycle NOT covered\n'
