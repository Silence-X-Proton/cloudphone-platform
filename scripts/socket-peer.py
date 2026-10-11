#!/usr/bin/env python3
"""Read Linux SO_PEERCRED from broker-inherited connected fd3. No paths/commands."""
import json
import socket
import struct
with socket.socket(fileno=3) as peer:
    if peer.family != socket.AF_UNIX:
        raise ValueError('Unix socket required')
    pid, uid, gid = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    print(json.dumps({'pid': pid, 'uid': uid, 'gid': gid}))
