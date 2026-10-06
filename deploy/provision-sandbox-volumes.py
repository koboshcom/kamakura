#!/usr/bin/env python3
"""Root-only Linux host provisioning. No Docker volumes or privileged bot helpers.
Mount fixed ext4 images at SANDBOX_ROOT/<Telegram ID> before starting core.
Re-run after reboot. Never format existing images, resize, or delete user data.
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


def safe_directory(path, private=False):
    if path.resolve() != path:
        raise SystemExit(f'Symlink path rejected at {path}')
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & (0o077 if private else 0o022):
        raise SystemExit(f'{path} must be a root-owned directory without unsafe permissions')
    # No ancestor may be writable by non-root, preventing path substitution.
    for ancestor in path.parents:
        info = ancestor.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit(f'Unsafe ancestor {ancestor}; use a root-owned deployment location')


def mounted(path):
    data = json.loads(run('findmnt', '--json', '--mountpoint', str(path), '--output', 'TARGET,SOURCE,FSTYPE')) if os.path.ismount(path) else {}
    return (data.get('filesystems') or [None])[0]


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root on the Linux Docker host')
    instance = os.environ.get('SANDBOX_INSTANCE', 'default')
    if not re.fullmatch(r'[a-z0-9-]{1,32}', instance):
        raise SystemExit('Invalid SANDBOX_INSTANCE')
    users = sorted(set(u.strip() for u in os.environ.get('SANDBOX_ALLOWED_USERS', '').split(',') if u.strip()))
    if not users or any(not re.fullmatch(r'[1-9][0-9]{0,19}', u) for u in users):
        raise SystemExit('Export SANDBOX_ALLOWED_USERS as exact numeric IDs')
    host_uid = int(os.environ.get('SANDBOX_HOST_UID', '1000'))
    host_gid = int(os.environ.get('SANDBOX_HOST_GID', '1000'))
    root_mode = int(os.environ.get('SANDBOX_ROOT_MODE', '700'), 8)
    if host_uid < 0 or host_gid < 0 or root_mode not in (0o700, 0o755):
        raise SystemExit('Invalid host ownership or root mode')
    size = size_bytes(os.environ.get('SANDBOX_DISK', '35G'))
    if size < 64 * 1024 ** 2:
        raise SystemExit('Filesystem must be at least 64MiB')
    workspace_root = Path(os.path.abspath(os.path.expanduser(os.environ.get('SANDBOX_ROOT', './sandboxes'))))
    workspace_root.mkdir(mode=0o755, parents=True, exist_ok=True)
    safe_directory(workspace_root)
    images = Path('/var/lib/kamakura-loopback')
    images.mkdir(mode=0o700, exist_ok=True)
    safe_directory(images, private=True)
    lock_path = images / '.lock'
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for user in users:
            name = f'kamakura-{instance}-data-u{user}'
            image = images / f'{name}.ext4'
            target = workspace_root / user
            # Keep path ownership/quota metadata outside the user-controlled filesystem.
            metadata = images / f'{name}.json'
            expected = {'workspace': str(target), 'size': size, 'user': user, 'instance': instance}
            if metadata.exists() or metadata.is_symlink():
                info = metadata.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
                    raise SystemExit(f'Unsafe metadata at {metadata}')
                if json.loads(metadata.read_text()) != expected:
                    raise SystemExit(f'{name} path or size changed. Migrate offline, refusing to alter data.')
            target.mkdir(mode=0o700, exist_ok=True)
            if target.is_symlink() or target.resolve() != target:
                raise SystemExit(f'Unsafe workspace path {target}')
            mount = mounted(target)
            if not mount:
                safe_directory(target)
                if any(target.iterdir()):
                    raise SystemExit(f'{target} is not empty. Refusing to hide existing files with a mount.')
            new_image = not (image.exists() or image.is_symlink())
            if new_image:
                if metadata.exists() or mount:
                    raise SystemExit(f'Image missing for {target}. Restore backup, refusing to create empty data.')
                fd, temporary = tempfile.mkstemp(prefix=f'.{name}-', dir=images)
                try:
                    os.ftruncate(fd, size)
                    os.close(fd)
                    run('mkfs.ext4', '-q', '-F', '-m', '0', temporary)
                    os.rename(temporary, image)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
            else:
                info = image.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_size != size or info.st_nlink != 1 or info.st_mode & 0o077:
                    raise SystemExit(f'Unsafe image or size mismatch at {image}, refusing to modify it.')
                if run('blkid', '-p', '-s', 'TYPE', '-o', 'value', str(image)) != 'ext4':
                    raise SystemExit(f'{image} is not ext4, refusing to format existing data.')
            attached = json.loads(run('losetup', '--json', '--list', '--output', 'NAME,BACK-FILE'))['loopdevices'] or []
            devices = [d['name'] for d in attached if d['back-file'] == str(image)]
            if len(devices) > 1:
                raise SystemExit(f'{image} has multiple loop attachments, resolve offline')
            device = devices[0] if devices else None
            if mount:
                if mount['fstype'] != 'ext4' or mount['source'] != device:
                    raise SystemExit(f'{target} is mounted from an unexpected device, refusing to replace it')
            else:
                if not device:
                    device = run('losetup', '--find', '--show', str(image))
                if run('findmnt', '--noheadings', '--raw', '--output', 'SOURCE').splitlines().count(device):
                    raise SystemExit(f'{device} is already mounted elsewhere. Stop old containers and migrate offline.')
                run('mount', '-t', 'ext4', '-o', 'rw,nosuid,nodev', device, str(target))
                # Only filesystem root, never recursively change user files.
                os.chown(target, host_uid, host_gid)
                os.chmod(target, root_mode)
            if not metadata.exists():
                fd = os.open(metadata, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'w') as output:
                    json.dump(expected, output)
            print(f'{target} ready on {device}, filesystem at most {size} bytes')
    print('Reattach mounts after reboot BEFORE core starts. Sparse images do not reserve host disk space.')


if __name__ == '__main__':
    main()
