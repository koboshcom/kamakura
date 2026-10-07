import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage', Path(__file__).with_name('remapped-storage.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)

class StorageTests(unittest.TestCase):
    def setUp(self):
        self.image = Path('/var/lib/kamakura-loopback/root.xfs')
        self.mount = dict(target='/var/lib/kamakura-root-docker', source='/dev/loop9', fstype='xfs', options='rw,relatime,prjquota')
        self.loops = {'loopdevices': [dict(name='/dev/loop9', **{'back-file': str(self.image)}, sizelimit=0, offset=0, ro=0)]}
        self.config = {'data-root': self.mount['target'], 'storage-driver': 'overlay2', 'features': {'containerd-snapshotter': False}, 'userns-remap': 'kamakura-remap', 'hosts': ['unix:///var/run/kamakura-root-docker.sock']}
    def check_mount(self):
        s.mount_check(self.mount, self.image, 16 * 1024**3, self.loops, 'projid32bit=1 ftype=1')
    def test_good(self):
        self.check_mount()
        s.policy(self.config, Path(self.mount['target']), '/var/run/kamakura-root-docker.sock')
    def test_bad_mounts(self):
        for field, value in [('fstype', 'ext4'), ('source', '/dev/sda'), ('options', 'rw'), ('options', 'ro,pquota')]:
            original = self.mount[field]
            self.mount[field] = value
            with self.assertRaises(ValueError): self.check_mount()
            self.mount[field] = original
    def test_bad_loops(self):
        for field, value in [('back-file', '/tmp/other'), ('offset', 4096), ('sizelimit', 4096), ('ro', 1)]:
            original = self.loops['loopdevices'][0][field]
            self.loops['loopdevices'][0][field] = value
            with self.assertRaises(ValueError): self.check_mount()
            self.loops['loopdevices'][0][field] = original
    def test_ftype(self):
        with self.assertRaises(ValueError): s.mount_check(self.mount, self.image, 100, self.loops, 'ftype=0')
    def test_config_failclosed(self):
        for field, value in [('data-root', '/var/lib/docker'), ('storage-driver', 'overlayfs'), ('features', {}), ('userns-remap', 'default'), ('hosts', ['unix:///var/run/docker.sock'])]:
            original = self.config[field]
            self.config[field] = value
            with self.assertRaises(ValueError): s.policy(self.config, Path(self.mount['target']), '/var/run/kamakura-root-docker.sock')
            self.config[field] = original
    def test_paths(self):
        for p in ('relative', '/', '/var/lib/kamakura-work/image', '/var/lib/docker/image', '/var/lib/../bad', '/var//lib/image'):
            with self.assertRaises(ValueError): s.safe_path(p)
    def test_apply_guard(self):
        class A:
            apply = False
            confirm_data_root = '/var/lib/kamakura-root-docker'
            data_root = confirm_data_root
        with patch.object(s, 'run', side_effect=AssertionError('must not run command')):
            with self.assertRaises(ValueError): s.provision(A())
            with self.assertRaises(ValueError): s.mount_existing(A())
    def test_preallocation(self):
        class Image:
            def stat(self):
                class Stat:
                    st_mode = 0o100600
                    st_nlink = 1
                    st_size = 4096
                    st_blocks = 0
                return Stat()
        with self.assertRaises(ValueError): s.backing_check(Image(), 4096)
    def test_validate_missing_mount(self):
        from unittest.mock import MagicMock
        path = MagicMock()
        path.read_text.side_effect = ['{"data_root":"/var/lib/kamakura-root-docker","image":"/var/lib/kamakura-loopback/root.xfs","size_bytes":17179869184,"socket":"/var/run/kamakura-root-docker.sock"}', __import__('json').dumps(self.config)]
        with patch.object(s, 'safe_path', side_effect=[path, path, Path(self.mount['target']), self.image]), patch.object(s, 'backing_check'), patch.object(s, 'run', return_value='{"filesystems":[]}'):
            with self.assertRaises(ValueError): s.validate('manifest', 'config')

if __name__ == '__main__': unittest.main()
