#!/usr/bin/env python3
"""Explicit operator-only storage migration. Boot validation never mounts or formats."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess

DEFAULT_MANIFEST = '/etc/kamakura/remapped-storage.json'

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def safe_path(value):
    p = Path(value)
    if not p.is_absolute() or str(p) != value or '..' in p.parts or len(p.parts) < 4:
        raise ValueError('unsafe absolute path')
    if str(p).startswith(('/var/lib/kamakura-work', '/var/lib/docker')):
        raise ValueError('protected workspace/primary Docker path')
    for item in [p, *p.parents]:
        if item.is_symlink():
            raise ValueError('symlink path refused')
        if item.exists() and (item.stat().st_uid != 0 or item.stat().st_mode & 0o022):
            raise ValueError('path must be root-owned and not group/world writable')
    return p

def backing_check(image, size):
    s = image.stat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size != size or s.st_blocks * 512 < size:
        raise ValueError('backing must be exact-size, fully allocated single-link regular file')

def policy(config, root, socket):
    if config.get('data-root') != str(root) or config.get('storage-driver') != 'overlay2':
        raise ValueError('wrong data-root or nonclassic overlay2')
    if config.get('features', {}).get('containerd-snapshotter') is not False:
        raise ValueError('containerd snapshotter must be explicitly disabled')
    if config.get('userns-remap') != 'kamakura-remap' or config.get('hosts') != ['unix://' + socket]:
        raise ValueError('unexpected userns/socket configuration')

def mount_check(mount, image, size, loop_json, xfs):
    if mount.get('fstype') != 'xfs':
        raise ValueError('not XFS')
    options = set(mount.get('options', '').split(','))
    if not options.intersection({'pquota', 'prjquota'}) or 'rw' not in options:
        raise ValueError('writable project-quota mount required')
    loops = loop_json.get('loopdevices', [])
    if len(loops) != 1 or loops[0].get('back-file') != str(image) or int(loops[0].get('sizelimit') or 0) != 0 or int(loops[0].get('offset') or 0) != 0:
        raise ValueError('unexpected loop device mapping')
    if loops[0].get('name') != mount['source'] or int(loops[0].get('ro') or 0) != 0:
        raise ValueError('wrong/read-only loop source')
    if not re.search(r'\bftype=1\b', xfs):
        raise ValueError('XFS ftype=1 required')
    if not re.search(r'\bprojid32bit=1\b', xfs):
        raise ValueError('XFS project IDs required')

def validate(manifest_path, config_path):
    manifest = safe_path(manifest_path)
    cfg = safe_path(config_path)
    data = json.loads(manifest.read_text())
    root = safe_path(data['data_root'])
    image = safe_path(data['image'])
    size = int(data['size_bytes'])
    if size < 1024**3 or image == root or root in image.parents or image in root.parents:
        raise ValueError('unsafe size/path relationship')
    backing_check(image, size)
    policy(json.loads(cfg.read_text()), root, data['socket'])
    mounts = json.loads(run('findmnt', '--json', '--mountpoint', str(root), '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS'))['filesystems']
    if len(mounts) != 1 or mounts[0]['target'] != str(root):
        raise ValueError('exact data-root mount missing')
    mount = mounts[0]
    loops = json.loads(run('losetup', '--json', '--list', '--associated', str(image), '--output', 'NAME,BACK-FILE,SIZELIMIT,OFFSET,RO'))
    mount_check(mount, image, size, loops, run('xfs_info', str(root)))
    if int(run('blockdev', '--getsize64', mount['source'])) != size:
        raise ValueError('loop capacity mismatch')
    # Statvfs may exclude XFS metadata, but cannot exceed the fixed block device.
    v = os.statvfs(root)
    if v.f_blocks * v.f_frsize > size:
        raise ValueError('filesystem larger than reserved device')
    return data

def stopped(config, socket):
    if Path(socket).exists():
        raise ValueError('daemon socket still present, stop daemon and remove only its stale socket explicitly')
    cfg = json.loads(config.read_text())
    pidfile = cfg.get('pidfile')
    if not pidfile or Path(pidfile).exists():
        raise ValueError('daemon pidfile still present or unspecified')
    for proc in Path('/proc').glob('[0-9]*/cmdline'):
        try:
            args = proc.read_bytes().split(b'\0')
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if args and Path(os.fsdecode(args[0])).name == 'dockerd':
            command = b' '.join(args).decode(errors='replace')
            if str(config) in command or str(cfg['data-root']) in command or socket in command:
                raise ValueError('dedicated dockerd is still running')

def provision(a):
    if not a.apply or a.confirm_data_root != a.data_root:
        raise ValueError('requires --apply and --confirm-data-root matching --data-root')
    root, image, rollback, manifest, config = map(safe_path, (a.data_root, a.image, a.rollback, a.manifest, a.config))
    if root.parent != rollback.parent or root == rollback:
        raise ValueError('unsafe rollback path')
    paths = (root, image, rollback, manifest, config)
    for i, left in enumerate(paths):
        for right in paths[i + 1:]:
            if left == right or left in right.parents or right in left.parents:
                raise ValueError('migration/config/manifest paths must not overlap')
    if any(p.exists() for p in (image, rollback, manifest)) or not root.is_dir():
        raise ValueError('new image/rollback/manifest must not exist; source directory must exist')
    if os.path.ismount(root) or os.path.ismount(rollback):
        raise ValueError('source/rollback is already mounted')
    targets = run('findmnt', '-rn', '-o', 'TARGET').splitlines()
    if any(t == str(root) or t.startswith(str(root) + '/') for t in targets):
        raise ValueError('source has child mounts; operator must explicitly detach those after shutdown')
    old = json.loads(config.read_text())
    if old.get('data-root') != str(root) or old.get('userns-remap') != 'kamakura-remap' or old.get('hosts') != ['unix://' + a.socket]:
        raise ValueError('existing daemon config does not match migration')
    stopped(config, a.socket)
    size = a.size_gib * 1024**3
    used = int(run('du', '-sx', '--block-size=1', str(root)).split()[0])
    if size < used + max(2 * 1024**3, used // 4):
        raise ValueError('capacity lacks conservative data/metadata headroom')
    if not image.parent.is_dir() or not manifest.parent.is_dir():
        raise ValueError('create root-owned backing/manifest parent directories explicitly first')
    v = os.statvfs(image.parent)
    if v.f_bavail * v.f_frsize < size + 2 * 1024**3:
        raise ValueError('insufficient physical reservation plus 2GiB host headroom; no cache is pruned automatically')
    for tool in ('fallocate', 'mkfs.xfs', 'mount', 'rsync', 'losetup', 'xfs_info', 'blockdev'):
        run('which', tool)
    # All destructive operations are below the explicit approval and stopped checks.
    fd = os.open(image, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    run('fallocate', '-l', str(size), str(image))
    backing_check(image, size)
    run('mkfs.xfs', '-n', 'ftype=1', str(image))
    stopped(config, a.socket)
    root.rename(rollback)
    root.mkdir(mode=0o700)
    run('mount', '-o', 'loop,pquota', str(image), str(root))
    # Never deletes source or rollback. Failure leaves daemon stopped for operator recovery.
    run('rsync', '-aHAXS', '--numeric-ids', str(rollback) + '/', str(root) + '/')
    differences = run('rsync', '-aHAXScni', '--numeric-ids', str(rollback) + '/', str(root) + '/')
    if differences:
        raise ValueError('post-copy comparison failed; preserve both stores and investigate')
    new = dict(old)
    new['storage-driver'] = 'overlay2'
    new['features'] = dict(old.get('features', {}), **{'containerd-snapshotter': False})
    proposal = config.with_name(config.name + '.xfs-proposed')
    if proposal.exists():
        raise ValueError('proposed config already exists')
    with proposal.open('x') as f:
        os.chmod(proposal, 0o600)
        json.dump(new, f, indent=2)
    data = dict(data_root=str(root), image=str(image), size_bytes=size, socket=a.socket, rollback=str(rollback))
    with manifest.open('x') as f:
        os.chmod(manifest, 0o600)
        json.dump(data, f, indent=2)
    validate(str(manifest), str(proposal))
    print('Copy verified. Old store retained. Review and install proposed config explicitly before startup.')

def mount_existing(a):
    if not a.apply:
        raise ValueError('mount-existing requires explicit --apply')
    manifest = safe_path(a.manifest)
    data = json.loads(manifest.read_text())
    root, image, config = map(safe_path, (data['data_root'], data['image'], a.config))
    size = int(data['size_bytes'])
    if size < 1024**3 or root == image or root in image.parents or image in root.parents:
        raise ValueError('unsafe size/path relationship')
    backing_check(image, size)
    policy(json.loads(config.read_text()), root, data['socket'])
    if os.path.ismount(root):
        validate(a.manifest, a.config)
        return
    stopped(config, data['socket'])
    if not root.is_dir() or any(root.iterdir()):
        raise ValueError('unmounted data-root must be existing empty directory')
    if run('losetup', '--associated', str(image)):
        raise ValueError('backing already attached to a loop; investigate before mounting')
    run('mount', '-o', 'loop,pquota', str(image), str(root))
    validate(a.manifest, a.config)

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['validate', 'provision', 'mount-existing'])
    p.add_argument('--manifest', default=DEFAULT_MANIFEST)
    p.add_argument('--config', default='/etc/kamakura/remapped-daemon.json')
    p.add_argument('--data-root', default='/var/lib/kamakura-root-docker')
    p.add_argument('--image', default='/var/lib/kamakura-loopback/remapped-root.xfs')
    p.add_argument('--rollback', default='/var/lib/kamakura-root-docker.pre-xfs')
    p.add_argument('--socket', default='/var/run/kamakura-root-docker.sock')
    p.add_argument('--size-gib', type=int, default=16)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--confirm-data-root')
    a = p.parse_args()
    if os.geteuid() != 0:
        p.error('root required')
    if a.action == 'validate':
        data = validate(a.manifest, a.config)
        if data['socket'] != a.socket:
            raise ValueError('startup socket differs from attested daemon socket')
    elif a.action == 'mount-existing':
        mount_existing(a)
    else:
        provision(a)

if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as e:
        raise SystemExit('Storage guard refused operation: ' + str(e))
