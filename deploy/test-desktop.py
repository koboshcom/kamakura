#!/usr/bin/env python3
"""Unit tests need Pillow, not a running desktop. Docker integration still required."""
import importlib.util
from pathlib import Path
import unittest
from PIL import Image

path = Path(__file__).with_name('desktop-worker.py')
spec = importlib.util.spec_from_file_location('worker', path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class DesktopTest(unittest.TestCase):
    def setUp(self):
        class FakeCua:
            def call(self, name, args=None):
                return {'structuredContent': {'name': name}}
        self.cua = FakeCua()
        self.execute = worker.make_session(self.cua, lambda: None)

    def test_globals_persist_and_text_is_bounded(self):
        self.execute('x = 41')
        self.assertEqual(self.execute('log(x + 1)')['text'], '42\n')
        result = self.execute('print("a" * 50000)')
        self.assertLess(len(result['text']), 16100)
        self.assertIn('truncated', result['text'])
        self.assertEqual(self.execute('log(cua.call("list_windows"))')['text'], "{'structuredContent': {'name': 'list_windows'}}\n")
        self.assertEqual(self.execute('log(pyautogui)')['error'], 'NameError')

    def test_cua_cli_uses_private_socket_and_stdin(self):
        from unittest.mock import patch
        import json
        def fake_run(argv, **kwargs):
            self.assertEqual(argv, ['cua-driver', 'call', 'get_window_state', '--socket', worker.CUA_SOCKET])
            payload = json.loads(kwargs['input'])
            self.assertEqual(payload['session'], 'kamakura')
            self.assertEqual(payload['pid'], 123)
            kwargs['stdout'].write(json.dumps({'elements': [], 'screenshot_png_b64': 'YWJj', 'screenshot_mime_type': 'image/jpeg'}).encode())
            class Result:
                returncode = 0
            return Result()
        with patch.object(worker.subprocess, 'run', fake_run):
            result = worker.CuaDriver().call('get_window_state', {'pid': 123})
        self.assertEqual(result['structuredContent'], {'elements': []})
        self.assertEqual(result['content'][0]['data'], 'YWJj')
        self.assertFalse(result['isError'])

    def test_cua_rejects_admin_and_shell_tools(self):
        for name in ('set_config', 'install_extension', 'stop', 'click; touch /tmp/x'):
            with self.assertRaises(ValueError):
                worker.CuaDriver().call(name)

    def test_text_sink_does_not_grow_after_cap(self):
        sink = worker.BoundedText()
        sink.write('a' * worker.MAX_TEXT)
        for _ in range(10000):
            sink.write('overflow')
        self.assertEqual(len(sink.parts), 1)
        self.assertTrue(sink.truncated)

    def test_images_are_returned(self):
        result = self.execute('from PIL import Image\ndisplay(Image.new("RGB", (10, 10)))')
        self.assertEqual(len(result['images']), 1)
        self.assertTrue(result['images'][0].startswith('iVBOR'))

    def test_image_count_is_bounded(self):
        result = self.execute('from PIL import Image\nfor i in range(3): display(Image.new("RGB", (10, 10)))')
        self.assertEqual(len(result['images']), 2)
        self.assertEqual(result['error'], 'ValueError')

    def test_session_survives_exceptions(self):
        self.assertEqual(self.execute('raise SystemExit(1)')['error'], 'SystemExit')
        self.assertEqual(self.execute('print("awake")')['text'], 'awake\n')


if __name__ == '__main__':
    unittest.main()
