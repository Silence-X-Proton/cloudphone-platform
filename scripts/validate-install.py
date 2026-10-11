#!/usr/bin/env python3
"""Read-only trust/integrity checks used by start and idempotent reinstall."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


def private_file(path):
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077 or st.st_nlink != 1:
        raise ValueError('Unsafe private file: ' + str(path))
    return path.read_text()


def source(root):
    root = Path(root)
    for current, dirs, files in os.walk(root, followlinks=False):
        for name in [Path(current), *(Path(current) / n for n in dirs + files)]:
            st = name.lstat()
            if st.st_uid != 0:
                raise ValueError('Source not root-owned: ' + str(name))
            if name.is_symlink():
                dependencies = root / 'node_modules'
                if not name.is_relative_to(dependencies) or not name.resolve(strict=True).is_relative_to(dependencies):
                    raise ValueError('Escaping/unexpected source symlink: ' + str(name))
            elif st.st_mode & 0o022 or not (name.is_file() or name.is_dir()):
                raise ValueError('Unsafe source entry: ' + str(name))


def sdk(root):
    root = Path(root)
    files = set()
    for current, dirs, names in os.walk(root, followlinks=False):
        for name in [Path(current), *(Path(current) / n for n in dirs + names)]:
            st = name.lstat()
            if st.st_uid != 0 or st.st_mode & 0o222 or name.is_symlink() or not (name.is_file() or name.is_dir()):
                raise ValueError('SDK not immutable/root-owned: ' + str(name))
            if name.is_file():
                files.add('./' + str(name.relative_to(root)))
    if (root / '.cloudphone-sdk').read_text() != 'cloudphone-sdk-api36-v1\n':
        raise ValueError('Wrong SDK ownership marker')
    expected = set()
    for line in (root / 'SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  (\./[^\r\n]+)', line)
        if not match:
            raise ValueError('Unsafe manifest line')
        digest, relative = match.groups()
        target = root / relative
        if '..' in Path(relative).parts or not target.resolve().is_relative_to(root.resolve()) or relative in expected:
            raise ValueError('Unsafe/duplicate SDK manifest path')
        expected.add(relative)
        h = hashlib.sha256()
        with target.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(block)
        if h.hexdigest() != digest:
            raise ValueError('SDK integrity mismatch: ' + relative)
    if expected != files - {'./SHA256SUMS'}:
        raise ValueError('SDK manifest does not match exact installed file set')


def config():
    root = Path('/etc/cloudphone-platform')
    value = json.loads(private_file(root / 'config.json'))
    if value.get('networkMode') not in ('public', 'none') or value.get('schemaVersion') != 1 or value.get('mode') not in ('dashboard', 'standalone') or value.get('stateDir') != '/var/lib/cloudphone-platform' or value.get('sdkDir') != '/opt/cloudphone-sdk/api36-v1' or value.get('credentialsFile') != '/var/lib/cloudphone-platform/credentials.json' or value.get('host') != '127.0.0.1' or not isinstance(value.get('port'), int) or not 1024 <= value['port'] <= 65535 or value['port'] == 8787:
        raise ValueError('Unsafe root configuration')
    web_path = Path('/etc/cloudphone-platform-web/config.json')
    st = web_path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        raise ValueError('Unsafe web configuration')
    web = json.loads(web_path.read_text())
    allowed = {'schemaVersion', 'mode', 'host', 'port', 'sdkDir', 'scrcpyServer', 'brokerSocket', 'publicOrigin', 'tunnelInvocationId'}
    if set(web) - allowed or any(web.get(k) != value.get(k) for k in ('schemaVersion', 'mode', 'host', 'port', 'sdkDir', 'scrcpyServer')) or web.get('brokerSocket') != '/run/cloudphone-platform/broker.sock':
        raise ValueError('Web configuration mismatch or secret field')
    origin = web.get('publicOrigin', '')
    if origin != 'http://127.0.0.1:' + str(value['port']) and not re.fullmatch(r'https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com', origin):
        raise ValueError('Unsafe web publicOrigin')
    tunnel = Path('/etc/cloudphone-platform-web/tunnel.env')
    st = tunnel.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022 or tunnel.read_text() != 'PORT=' + str(value['port']) + '\n':
        raise ValueError('Unsafe tunnel environment')
    credentials = json.loads(private_file(Path('/var/lib/cloudphone-platform/credentials.json')))
    if credentials.get('schemaVersion') != 1 or credentials.get('username') != 'admin' or not re.fullmatch('[a-f0-9]{32}', credentials.get('salt', '')) or not re.fullmatch('[a-f0-9]{128}', credentials.get('passwordHash', '')):
        raise ValueError('Invalid credential schema')


if __name__ == '__main__':
    try:
        action = sys.argv[1]
        if action == 'source': source(sys.argv[2])
        elif action == 'sdk': sdk(sys.argv[2])
        elif action == 'config': config()
        else: raise ValueError('Unknown validation action')
    except (ValueError, OSError, KeyError) as error:
        sys.exit(str(error))
