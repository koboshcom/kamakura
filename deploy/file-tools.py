"""Bounded structured sandbox file operations. No user shell interpolation."""
import base64
import fnmatch
import http.client
import ipaddress
import json
import os
import signal
import secrets
import socket
import ssl
import stat
import sys
from urllib.parse import urlsplit, urljoin

ROOT = '/workspace'
MAX_FILE = 262144
MAX_OUTPUT = 2000
PAGE = 2000  # Worst-case ASCII JSON escaping stays below default sandbox output cap.


def parts(path):
    if not isinstance(path, str) or '\x00' in path or len(path) > 1024:
        raise ValueError('Invalid path')
    if path.startswith('/workspace/'):
        path = path[len('/workspace/'):]
    elif path == '/workspace':
        path = ''
    elif path.startswith('/'):
        raise ValueError('Path must be inside /workspace')
    result = [p for p in path.split('/') if p not in ('', '.')]
    if '..' in result:
        raise ValueError('Traversal forbidden')
    return result


def parent(path):
    names = parts(path)
    if not names:
        raise ValueError('Expected file path')
    fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in names[:-1]:
            nxt = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd, names[-1]
    except BaseException:
        os.close(fd)
        raise


def open_file(path, write=False, edit=False):
    fd, name = parent(path)
    try:
        flags = os.O_RDWR | os.O_CREAT if write else (os.O_RDWR if edit else os.O_RDONLY)
        f = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
        info = os.fstat(f)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_FILE:
            os.close(f)
            raise ValueError('Expected bounded regular file with one link')
        return f
    finally:
        os.close(fd)


def read(path):
    fd = open_file(path)
    with os.fdopen(fd, 'rb') as f:
        data = f.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise ValueError('File too large')
    return data.decode('utf-8')


def save(path, text, edit=False, old=None):
    data = text.encode('utf-8')
    if len(data) > MAX_FILE:
        raise ValueError('File too large')
    fd = open_file(path, write=not edit, edit=edit)
    with os.fdopen(fd, 'r+b' if not edit else 'r+b') as f:
        if edit:
            current = f.read(MAX_FILE + 1).decode('utf-8')
            if not old or current.count(old) != 1:
                raise ValueError('Replacement must match exactly once')
            data = current.replace(old, text, 1).encode('utf-8')
            if len(data) > MAX_FILE:
                raise ValueError('File too large')
        # Recheck links immediately before mutation, never truncate through open().
        if os.fstat(f.fileno()).st_nlink != 1:
            raise ValueError('Hardlinked file forbidden')
        mode = stat.S_IMODE(os.fstat(f.fileno()).st_mode) & 0o777
    # Replace with a fresh inode, never mutate an inode that another process
    # might hardlink after the checks. Directory fds prevent symlink races.
    directory, name = parent(path)
    temporary = '.kamakura-' + secrets.token_hex(16)
    try:
        newfd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory)
        with os.fdopen(newfd, 'wb') as newfile:
            newfile.write(data)
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)
    return {'bytes': len(data)}


def paths(pattern):
    parts(pattern)
    if pattern.startswith('/workspace/'):
        pattern = pattern[len('/workspace/'):]
    root = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    visited = 0
    def walk(fd, prefix='', depth=0):
        nonlocal visited
        if depth > 32:
            return
        for entry in os.scandir(fd):
            name = entry.name
            visited += 1
            if visited > 4000:
                raise ValueError('Directory scan limit exceeded')
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            rel = prefix + name
            if stat.S_ISDIR(info.st_mode):
                try:
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except OSError:
                    continue
                try:
                    yield from walk(child, rel + '/', depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                if fnmatch.fnmatchcase(rel, pattern) or (pattern.startswith('**/') and fnmatch.fnmatchcase(rel, pattern[3:])):
                    yield rel
    try:
        yield from walk(root)
    finally:
        os.close(root)


def public_target(url):
    p = urlsplit(url)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username is not None or p.password is not None or '\\' in url or any(ord(c) < 32 for c in url):
        raise ValueError('Public HTTP(S) URL without credentials required')
    port = p.port or (443 if p.scheme == 'https' else 80)
    if port not in (80, 443):
        raise ValueError('Only public web ports permitted')
    addresses = socket.getaddrinfo(p.hostname, port, type=socket.SOCK_STREAM)
    if not addresses:
        raise ValueError('No DNS addresses')
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global or (getattr(ip, 'ipv4_mapped', None) and not ip.ipv4_mapped.is_global):
            raise ValueError('Non-public network address forbidden')
    return p, port, addresses[0]


def fetch(url):
    for _ in range(5):
        p, port, address = public_target(url)
        conn = http.client.HTTPConnection(p.hostname, port, timeout=5)
        sock = socket.socket(address[0], socket.SOCK_STREAM)
        sock.settimeout(5)
        try:
            sock.connect(address[4])  # Pin the validated IP, no second DNS lookup.
            if p.scheme == 'https':
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=p.hostname)
            conn.sock = sock
            conn.request('GET', (p.path or '/') + ('?' + p.query if p.query else ''), headers={'User-Agent': 'kamakura-fetch/1', 'Accept-Encoding': 'identity'})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location:
                    raise ValueError('Redirect missing location')
                url = urljoin(url, location)
                continue
            data = response.read(MAX_OUTPUT + 1)
            return {'url': url, 'status': response.status, 'text': data[:MAX_OUTPUT].decode('utf-8', errors='replace'), 'truncated': len(data) > MAX_OUTPUT}
        finally:
            conn.close()
            sock.close()
    raise ValueError('Too many redirects')


def execute(req):
    op = req['op']
    if op == 'read_file':
        text = read(req['path'])
        offset = req.get('offset', 0)
        if not isinstance(offset, int) or offset < 0:
            raise ValueError('Invalid offset')
        return {'text': text[offset:offset + PAGE], 'nextOffset': offset + PAGE if len(text) > offset + PAGE else None}
    if op in ('write_file', 'edit_file'):
        return save(req['path'], req.get('content', req.get('newText', '')), op == 'edit_file', req.get('oldText'))
    if op in ('list_files', 'grep'):
        matches = []
        size = 0
        for path in paths(req.get('glob', '**/*')):
            if op == 'list_files':
                entries = [path]
            else:
                try:
                    text = read(path)
                except (ValueError, UnicodeError, OSError):
                    continue
                needle = req['query']
                if not needle:
                    raise ValueError('Nonempty literal query required')
                entries = [{'path': path, 'line': n, 'text': line[:500]} for n, line in enumerate(text.splitlines(), 1) if needle in line]
            for entry in entries:
                size += len(json.dumps(entry))
                if len(matches) >= 200 or size > 12000:
                    return {'matches': matches, 'truncated': True}
                matches.append(entry)
        return {'matches': matches, 'truncated': False}
    if op == 'web_fetch':
        return fetch(req['url'])
    raise ValueError('Unknown operation')


if __name__ == '__main__':
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('Operation timeout')))
    signal.alarm(15)
    try:
        if len(sys.argv) != 2 or len(sys.argv[1]) > 7800:
            raise ValueError('Invalid payload')
        request = json.loads(base64.b64decode(sys.argv[1], validate=True))
        output = json.dumps({'ok': True, 'result': execute(request)}, ensure_ascii=True)
        if len(output) > 14500:
            raise ValueError('Encoded output exceeds safe limit; narrow the query')
        print(output)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)[:500]}))
        sys.exit(1)
