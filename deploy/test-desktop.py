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

    def test_expired_session_recovers_and_retries_same_request_once(self):
        from unittest.mock import patch
        import json
        calls = []
        def fake_run(argv, **kwargs):
            calls.append((argv[2], json.loads(kwargs['input'])))
            class Result:
                returncode = 0
            if len(calls) == 1:
                Result.returncode = 1
                kwargs['stderr'].write(b"session has ended; tool call 'press_key' was rejected. Call start_session with session 'private' to start it again.")
            elif len(calls) == 2:
                kwargs['stdout'].write(b'{"active":true,"revived":true}')
            else:
                kwargs['stdout'].write(b'{"ok":true}')
            return Result()
        cua = worker.CuaDriver()
        request = {'session': 'private', 'key': 'ESC'}
        with patch.object(worker.subprocess, 'run', fake_run):
            result = cua.call('press_key', request)
        self.assertEqual(calls, [('press_key', request), ('start_session', {'session': 'private'}), ('press_key', request)])
        self.assertTrue(result['sessionRecovery']['recovered'])
        self.assertEqual(cua.health()['recoveries'], 1)
        self.assertEqual(cua.health()['last_status'], 'healthy')
        self.assertNotIn('private', str(cua.health()))
        self.assertFalse(result['isError'])

    def test_only_explicit_ended_rejection_is_replay_safe(self):
        rejected = b"session has ended; tool call was rejected. Call start_session to restart."
        self.assertTrue(worker.CuaDriver._ended(1, rejected, ''))
        self.assertFalse(worker.CuaDriver._ended(0, rejected, ''))
        for text in ('session expired', 'session revoked', 'permission denied', 'timeout', 'session has ended; permission denied. was rejected. Call start_session'):
            self.assertFalse(worker.CuaDriver._ended(1, b'', text))

    def test_recovery_failure_and_repeat_expiry_are_bounded_and_redacted(self):
        from unittest.mock import patch
        import json
        for restart_fails in (True, False):
            calls = []
            def fake_run(argv, **kwargs):
                calls.append(argv[2])
                class Result:
                    returncode = 1
                if argv[2] == 'start_session' and not restart_fails:
                    Result.returncode = 0
                    kwargs['stdout'].write(b'{"active":true}')
                else:
                    kwargs['stderr'].write(b'session has ended; tool call was rejected. Call start_session. secret-typed-password')
                return Result()
            cua = worker.CuaDriver()
            with patch.object(worker.subprocess, 'run', fake_run):
                with self.assertRaises(RuntimeError) as error:
                    cua.call('list_windows')
            self.assertNotIn('secret-typed-password', str(error.exception))
            self.assertEqual(len(calls), 2 if restart_fails else 3)
            self.assertEqual(cua.health()['recovery_failures'], 1)
            self.assertEqual(cua.health()['recoveries'], 0)

    def test_regular_failure_never_restarts_or_replays(self):
        from unittest.mock import patch
        calls = []
        def fake_run(argv, **kwargs):
            calls.append(argv[2])
            kwargs['stderr'].write(b'permission denied secret-password')
            class Result:
                returncode = 1
            return Result()
        cua = worker.CuaDriver()
        with patch.object(worker.subprocess, 'run', fake_run):
            with self.assertRaises(RuntimeError) as error:
                cua.call('click', {'session':'private'})
        self.assertEqual(calls, ['click'])
        self.assertNotIn('secret-password', str(error.exception))
        self.assertEqual(cua.health()['recoveries'], 0)

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
