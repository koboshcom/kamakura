#!/usr/bin/env python3
"""Pure provisioning checks. Does not create images or mount filesystems."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import stat
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('provision', Path(__file__).with_name('provision-sandbox-volumes.py'))
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class ProvisionTest(unittest.TestCase):
    def test_sizes(self):
        self.assertEqual(provision.size_bytes('35G'), 35 * 1024 ** 3)
        self.assertEqual(provision.size_bytes('64MiB'), 64 * 1024 ** 2)
        for value in ('-1', '35G;rm', '35.5G', '/tmp'):
            with self.assertRaises(ValueError):
                provision.size_bytes(value)

    def test_requires_root(self):
        with patch.object(provision.os, 'geteuid', return_value=1000):
            with self.assertRaisesRegex(SystemExit, 'root'):
                provision.main()

    def test_directory_permissions(self):
        safe = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
        unsafe = SimpleNamespace(st_mode=stat.S_IFDIR | 0o777, st_uid=0)
        path = Path('/opt/kamakura/sandboxes')
        with patch.object(Path, 'resolve', return_value=path), patch.object(Path, 'lstat', return_value=safe), patch.object(Path, 'stat', return_value=safe):
            provision.safe_directory(path)
        with patch.object(Path, 'resolve', return_value=path), patch.object(Path, 'lstat', return_value=unsafe):
            with self.assertRaisesRegex(SystemExit, 'unsafe permissions'):
                provision.safe_directory(path)
        with patch.object(Path, 'resolve', return_value=path), patch.object(Path, 'lstat', return_value=safe), patch.object(Path, 'stat', return_value=unsafe):
            with self.assertRaisesRegex(SystemExit, 'Unsafe ancestor'):
                provision.safe_directory(path)

    def test_no_mount_means_no_findmnt_call(self):
        with patch.object(provision.os.path, 'ismount', return_value=False), patch.object(provision, 'run') as run:
            self.assertIsNone(provision.mounted(Path('/opt/sandboxes/42')))
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
