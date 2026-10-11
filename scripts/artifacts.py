#!/usr/bin/env python3
"""Strict official metadata parser and archive extractor; never executes metadata."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import xml.etree.ElementTree as ET
import zipfile

PINS = {
    'platform-tools': ('platform-tools_r37.0.1-linux.zip', '477254aa5f903c15cf51001717bdf347fb6b53e0'),
    'emulator': ('emulator-linux_x64-16428233.zip', 'cd7362ea55dfb86a418958138dc396e74165dd01'),
    'system-images;android-36;google_apis;x86_64': ('x86_64-36_r07.zip', 'c6bf44bdcd885bb902b4ba752d111a073ad7a817'),
}
BASES = {'repo': 'https://dl.google.com/android/repository/',
         'image': 'https://dl.google.com/android/repository/sys-img/google_apis/'}

def parse_metadata(data, kind):
    if b'\x00' in data:
        raise ValueError('Only UTF-8 XML metadata is supported')
    data.decode('utf-8', errors='strict')
    if len(data) > 16 * 1024 * 1024 or b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('DTD/entities or oversized metadata rejected')
    root = ET.fromstring(data)
    for element in root.iter():
        element.tag = element.tag.rsplit('}', 1)[-1]
    wanted = list(PINS)[:2] if kind == 'repo' else list(PINS)[2:]
    result = []
    for package in wanted:
        filename, pinned_sha1 = PINS[package]
        matches = []
        for remote in root.findall('remotePackage'):
            if remote.get('path') != package:
                continue
            for archive in remote.findall('./archives/archive'):
                if archive.findtext('host-os') not in (None, 'linux'):
                    continue
                complete = archive.find('complete')
                if complete is None or complete.findtext('url') != filename:
                    continue
                checksum = complete.find('checksum')
                if checksum is None:
                    raise ValueError('Missing official checksum')
                algorithm = checksum.get('type', 'sha1')
                digest = (checksum.text or '').strip().lower()
                if algorithm != 'sha1' or not re.fullmatch('[a-f0-9]{40}', digest) or digest != pinned_sha1:
                    raise ValueError('Official checksum differs from reviewed pin')
                size = int(complete.findtext('size', '0'))
                if not 0 < size < 8 * 1024**3:
                    raise ValueError('Invalid archive size')
                matches.append({'package': package, 'url': BASES[kind] + filename,
                                'filename': filename, 'algorithm': algorithm, 'checksum': digest, 'size': size})
        if len(matches) != 1:
            raise ValueError('Pinned official archive missing or ambiguous: ' + filename)
        result.extend(matches)
    return result

def verify(path, algorithm, digest, size=None):
    lengths = {'sha1': 40, 'sha256': 64}
    if algorithm not in lengths or not re.fullmatch('[a-f0-9]{%d}' % lengths[algorithm], digest):
        raise ValueError('Invalid checksum')
    if size is not None and os.stat(path).st_size != int(size):
        raise ValueError('Archive size mismatch')
    h = hashlib.new(algorithm)
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    if h.hexdigest() != digest:
        raise ValueError('Checksum mismatch: ' + str(path))

def extract(source, destination):
    base = Path(destination).resolve()
    seen = set()
    with zipfile.ZipFile(source) as archive:
        if sum(i.file_size for i in archive.infolist()) > 20 * 1024**3:
            raise ValueError('Oversized extracted archive')
        # Validate every member before writing any member. Reject symlinks and devices.
        for info in archive.infolist():
            name = PurePosixPath(info.filename)
            mode = info.external_attr >> 16
            if ('\\' in info.filename or name.is_absolute() or '..' in name.parts or
                    not name.parts or str(name) in seen or
                    stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError('Unsafe ZIP member: ' + info.filename)
            seen.add(str(name))
            target = base.joinpath(*name.parts)
            if not target.resolve().is_relative_to(base):
                raise ValueError('ZIP path escapes destination')
        for info in archive.infolist():
            target = base.joinpath(*PurePosixPath(info.filename).parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as src, target.open('xb') as dst:
                    import shutil
                    shutil.copyfileobj(src, dst)
                target.chmod(0o755 if (info.external_attr >> 16) & 0o111 else 0o644)

def cloudflare_checksum(data):
    release = json.loads(data)
    if release.get('tag_name') != '2026.10.0' or release.get('draft') or release.get('prerelease'):
        raise ValueError('Wrong cloudflared release')
    matches = re.findall(r'^cloudflared-linux-amd64: ([a-f0-9]{64})\s*$', release.get('body', ''), re.M)
    pin = 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db'
    if matches != [pin]:
        raise ValueError('Missing/ambiguous/changed release checksum')
    return pin

if __name__ == '__main__':
    try:
        command, *args = sys.argv[1:]
        if command == 'metadata':
            print(json.dumps(parse_metadata(Path(args[0]).read_bytes(), args[1])))
        elif command == 'verify':
            verify(*args)
        elif command == 'extract':
            extract(*args)
        elif command == 'cloudflare':
            print(cloudflare_checksum(Path(args[0]).read_text()))
        else:
            raise ValueError('Unknown action')
    except (ValueError, OSError, ET.ParseError, zipfile.BadZipFile) as error:
        sys.exit(str(error))
