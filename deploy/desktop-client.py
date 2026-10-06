#!/opt/desktop-venv/bin/python
"""Called via Docker exec. Base64 is only shell-safe encoding, never authentication."""
import base64
import json
import socket
import sys
import time

request = base64.b64decode(sys.argv[1], validate=True)
if len(request) > 40000:
    raise SystemExit('Request too large')
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
    for attempt in range(100):
        try:
            client.connect('/tmp/kamakura-desktop.sock')
            break
        except (FileNotFoundError, ConnectionRefusedError):
            if attempt == 99:
                raise SystemExit('Desktop worker not ready; inspect sandbox container logs')
            time.sleep(0.1)
    client.sendall(request + b'\n')
    client.shutdown(socket.SHUT_WR)
    chunks = []
    size = 0
    while True:
        chunk = client.recv(65536)
        if not chunk:
            break
        size += len(chunk)
        if size > 6 * 1024 * 1024:
            raise SystemExit('Desktop response too large')
        chunks.append(chunk)
    response = b''.join(chunks)
    json.loads(response)  # Refuse incomplete/malformed worker output.
    sys.stdout.buffer.write(response)
