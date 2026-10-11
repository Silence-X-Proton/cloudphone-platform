#!/usr/bin/env python3
"""Extract an explicitly trusted checksum-pinned source snapshot, never runtime data."""
import hashlib
import io
import os
import stat
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile


def extract(archive, expected, destination):
    if not re.fullmatch(r'[a-f0-9]{64}', expected):
        raise ValueError('Expected lowercase SHA256 required')
    archive, destination = Path(archive), Path(destination)
    limit = 64 * 1024**2
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as handle:
        opened = os.fstat(handle.fileno())
        if not stat.S_ISREG(opened.st_mode) or opened.st_size > limit:
            raise ValueError('Unsafe or oversized source archive')
        # Immutable snapshot: concurrent inode writes cannot change bytes after
        # the digest succeeds. The extra byte detects growth past the cap.
        snapshot = handle.read(limit + 1)
        if len(snapshot) > limit:
            raise ValueError('Source archive read exceeds limit')
    if hashlib.sha256(snapshot).hexdigest() != expected:
        raise ValueError('Source archive checksum mismatch')
    with io.BytesIO(snapshot) as verified:
        with tarfile.open(fileobj=verified, mode='r:gz') as tar:
            members = tar.getmembers()
            names, total = set(), 0
            for member in members:
                name = member.name.removeprefix('./').rstrip('/')
                parts = PurePosixPath(name).parts
                if (not name or name.startswith('/') or '\\' in name or
                    any(p in ('.', '..', '.git', 'node_modules') for p in parts) or
                    not re.fullmatch(r'[A-Za-z0-9_./-]+', name) or name in names or
                    not (member.isfile() or member.isdir())):
                    raise ValueError('Unsafe source archive entry')
                names.add(name)
                total += member.size
                if total > 64 * 1024**2 or len(names) > 10000:
                    raise ValueError('Source archive expanded size limit')
                member.name = name
                member.uid = member.gid = 0
                member.uname = member.gname = ''
                member.mode = 0o755 if member.isdir() or member.mode & 0o111 else 0o644
            if not {'server.mjs', 'package.json', 'package-lock.json', 'scripts/install.sh'}.issubset(names):
                raise ValueError('Incomplete source archive')
            if not destination.is_dir() or any(destination.iterdir()):
                raise ValueError('Fresh empty source destination required')
            for member in members:
                target = destination / member.name
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as source, target.open('xb') as output:
                        shutil.copyfileobj(source, output)
                target.chmod(member.mode)
    return expected


if __name__ == '__main__':
    try:
        print(extract(*sys.argv[1:]))
    except Exception as error:
        sys.exit(str(error))
