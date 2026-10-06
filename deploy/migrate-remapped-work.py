#!/usr/bin/env python3
"""Offline one-time copy. Originals stay intact. Refuse live owners or changed data."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile

USERS = ('6612253937', '7853500388')
SOURCE = Path('/home/kit/kamakura/sandboxes')
TARGET = Path('/var/lib/kamakura-work')
OFFSET = 200000


def manifest(root, remapped=False):
    records = {}
    for folder, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(folder) / name
            relative = str(path.relative_to(root))
            if relative == 'lost+found' and remapped:
                continue
            s = path.lstat()
            uid, gid = s.st_uid, s.st_gid
            if remapped:
                uid -= OFFSET
                gid -= OFFSET
            if not (0 <= uid < 65536 and 0 <= gid < 65536):
                raise SystemExit(f'Ownership outside mapped range at {path}')
            digest = None
            if stat.S_ISREG(s.st_mode):
                with path.open('rb') as f:
                    h = hashlib.sha256()
                    for block in iter(lambda: f.read(1048576), b''):
                        h.update(block)
                    digest = h.hexdigest()
            elif stat.S_ISLNK(s.st_mode):
                digest = os.readlink(path)
            elif not stat.S_ISDIR(s.st_mode):
                raise SystemExit(f'Unsupported special file at {path}')
            records[relative] = [s.st_mode, uid, gid, digest]
    return records


def main():
    if os.geteuid() != 0:
        raise SystemExit('Root required')
    for user in USERS:
        name = 'kamakura-default-u' + user
        result = subprocess.run(['docker', 'inspect', '-f', '{{.State.Running}}', name], capture_output=True, text=True, check=True)
        if result.stdout.strip() != 'false':
            raise SystemExit(f'{name} still running; pause core and stop owners first')
    for user in USERS:
        source, target = SOURCE / user, TARGET / user
        if source.is_symlink() or target.is_symlink() or not os.path.ismount(target):
            raise SystemExit('Unsafe source or unmounted target')
        if any(p.name != 'lost+found' for p in target.iterdir()):
            raise SystemExit(f'{target} is not empty; refusing overwrite')
        before = manifest(source)
        with tempfile.TemporaryFile() as archive:
            subprocess.run(['tar', '--acls', '--xattrs', '-cpf', '-', '-C', str(source), '.'], stdout=archive, check=True)
            archive.seek(0)
            subprocess.run(['tar', '--acls', '--xattrs', '-xpf', '-', '-C', str(target)], stdin=archive, check=True)
        # lchown never follows user symlinks. Preserve each original UID/GID.
        for folder, dirs, files in os.walk(target, followlinks=False):
            for name in dirs + files:
                path = Path(folder) / name
                if path == target / 'lost+found':
                    continue
                s = path.lstat()
                os.chown(path, OFFSET + s.st_uid, OFFSET + s.st_gid, follow_symlinks=False)
                if not stat.S_ISLNK(s.st_mode):
                    os.chmod(path, stat.S_IMODE(s.st_mode))
        os.chown(target, OFFSET + 1000, OFFSET + 1000)
        os.chmod(target, 0o755)
        # ext4 administration directory is not user data.
        os.chown(target / 'lost+found', OFFSET, OFFSET)
        after = manifest(target, remapped=True)
        if before != after or before != manifest(source):
            raise SystemExit(f'Copy verification failed for {user}; originals are untouched')
        proof = Path('/var/lib/kamakura-loopback') / f'migration-{user}.json'
        proof.write_text(json.dumps({'source': str(source), 'target': str(target), 'entries': len(before), 'verified': True, 'manifest': before}, sort_keys=True))
        os.chmod(proof, 0o600)
        print(f'{user} verified {len(before)} entries, SHA256 contents, links, modes and mapped ownership; source retained')


if __name__ == '__main__':
    main()
