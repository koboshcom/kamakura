#!/usr/bin/env python3
"""Run as root on the Linux Docker HOST, never inside the core container.
Read settings from the exported environment. Provision only explicitly allowed IDs.
Re-run before the bot starts after every reboot to reattach loop devices.
Never format existing images, resize volumes, or delete user data.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def size_bytes(value):
    match = re.fullmatch(r'(\d+)([kmgt]?)(?:i?b)?', value.lower())
    if not match:
        raise ValueError('SANDBOX_DISK must be an integer size like 35G')
    return int(match[1]) * 1024 ** {'': 0, 'k': 1, 'm': 2, 'g': 3, 't': 4}[match[2]]


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root on the Docker host')
    instance = os.environ.get('SANDBOX_INSTANCE', 'default')
    if not re.fullmatch(r'[a-z0-9-]{1,32}', instance):
        raise SystemExit('Invalid SANDBOX_INSTANCE')
    users = os.environ.get('SANDBOX_ALLOWED_USERS', '').split(',')
    users = sorted(set(u.strip() for u in users if u.strip()))
    if not users or any(not re.fullmatch(r'[0-9]{1,20}', u) for u in users):
        raise SystemExit('Export SANDBOX_ALLOWED_USERS as exact numeric IDs')
    size = size_bytes(os.environ.get('SANDBOX_DISK', '35G'))
    if size < 64 * 1024 ** 2:
        raise SystemExit('Filesystem must be at least 64MiB')
    # Fixed root-owned host location. No model-controlled path or device input.
    root = Path('/var/lib/kamakura-loopback')
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise SystemExit('Loopback directory must be a root-owned directory with mode 0700')
    with open(root / '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for user in users:
            name = f'kamakura-{instance}-data-u{user}'
            image = root / f'{name}.ext4'
            volume_list = run('docker', 'volume', 'ls', '--format', '{{.Name}}').splitlines()
            volume = json.loads(run('docker', 'volume', 'inspect', name))[0] if name in volume_list else None
            if volume:
                labels = volume.get('Labels') or {}
                if any(labels.get(k) != v for k, v in {
                    'kamakura.owner': user, 'kamakura.sandbox': instance,
                    'kamakura.disk': str(size), 'kamakura.quota': 'loopback-ext4',
                }.items()):
                    raise SystemExit(f'{name} already exists with different ownership/quota. Use a new instance to migrate.')
            if image.exists() or image.is_symlink():
                info = image.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_size != size or info.st_nlink != 1:
                    raise SystemExit(f'Unsafe image or size mismatch at {image}. Refusing to modify it.')
                if run('blkid', '-p', '-s', 'TYPE', '-o', 'value', str(image)) != 'ext4':
                    raise SystemExit(f'{image} is not ext4. Refusing to format existing data.')
            else:
                if volume:
                    raise SystemExit(f'{image} missing for existing volume. Restore backup; refusing to create empty data.')
                # Atomic provisioning. Sparse file limits logical capacity, NOT reserved host space.
                fd, temporary = tempfile.mkstemp(prefix=f'.{name}-', dir=root)
                try:
                    os.ftruncate(fd, size)
                    os.close(fd)
                    run('mkfs.ext4', '-q', '-F', '-m', '0', temporary)
                    os.rename(temporary, image)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
            attached = json.loads(run('losetup', '--json', '--list', '--output', 'NAME,BACK-FILE'))['loopdevices'] or []
            device = next((d['name'] for d in attached if d['back-file'] == str(image)), None)
            if volume:
                expected = volume['Options']['device']
                if not re.fullmatch(r'/dev/loop[0-9]+', expected):
                    raise SystemExit('Invalid existing loop device')
                if device and device != expected:
                    raise SystemExit(f'{image} attached at {device}, expected {expected}. Stop containers and resolve manually.')
                if not device:
                    if any(d['name'] == expected for d in attached):
                        raise SystemExit(f'{expected} is occupied. Refusing to replace another device.')
                    run('losetup', expected, str(image))
                    device = expected
            elif not device:
                device = run('losetup', '--find', '--show', str(image))
            # Initialize ownership once before creating the named volume. Never recursively chown existing data.
            if not volume:
                with tempfile.TemporaryDirectory(prefix='kamakura-volume-') as mount:
                    run('mount', '-t', 'ext4', '-o', 'nosuid,nodev', device, mount)
                    try:
                        os.chown(mount, 1000, 1000)
                        os.chmod(mount, 0o700)
                    finally:
                        run('umount', mount)
                run('docker', 'volume', 'create', '--driver', 'local',
                    '--opt', 'type=ext4', '--opt', f'device={device}', '--opt', 'o=rw,nosuid,nodev',
                    '--label', f'kamakura.owner={user}', '--label', f'kamakura.sandbox={instance}',
                    '--label', f'kamakura.disk={size}', '--label', 'kamakura.quota=loopback-ext4', name)
            print(f'{name} ready at {device}, filesystem capacity at most {size} bytes')
    print('Sparse images do not reserve host capacity. Monitor host disk. Reattach before starting Docker sandboxes after reboot.')


if __name__ == '__main__':
    main()
