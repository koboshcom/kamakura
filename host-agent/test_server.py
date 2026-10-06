import importlib.util
import http.client
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from http.server import HTTPServer

spec = importlib.util.spec_from_file_location('agent', Path(__file__).with_name('server.py'))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class Validation(unittest.TestCase):
    def test_invalid_inputs(self):
        for data in [None, {'action': 'exec'}, {'action': 'screenshot', 'confirm': True},
                     {'action': 'click', 'x': True, 'y': 1, 'button': 'left'},
                     {'action': 'move', 'x': 16384, 'y': 1},
                     {'action': 'type', 'text': '\n'}, {'action': 'type', 'text': 'x' * 2001},
                     {'action': 'press', 'keys': ['madeup']}, {'action': 'press', 'keys': ['a'] * 5}]:
            with self.assertRaises((ValueError, TypeError)):
                agent.validate(data)

    def test_bind_fail_closed(self):
        for bind in ['', '0.0.0.0', '127.0.0.1', '100.63.0.1', '100.128.0.1', 'example.com']:
            with patch.object(agent.sys, 'platform', 'darwin'), patch.dict(agent.os.environ, {'HOST_AGENT_BIND': bind}):
                with self.assertRaises(SystemExit):
                    agent.main()


class HTTP(unittest.TestCase):
    def setUp(self):
        self.server = HTTPServer(('127.0.0.1', 0), agent.Handler)
        self.server.secret = 'a' * 40
        self.server.user_id = '123'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path='/v1/action', body=None, headers=None):
        client = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        auth = {'Authorization': 'Bearer ' + self.server.secret, 'X-Telegram-User-Id': '123'}
        auth.update(headers or {})
        client.request('POST', path, body if body is not None else json.dumps({'action': 'screenshot'}), auth)
        result = client.getresponse()
        status, raw = result.status, result.read()
        client.close()
        return status, raw

    def test_auth_owner_route_and_body(self):
        with patch.object(agent.subprocess, 'run') as run:
            self.assertEqual(self.request(headers={'Authorization': 'Bearer incorrect'})[0], 403)
            self.assertEqual(self.request(headers={'X-Telegram-User-Id': '456'})[0], 403)
            self.assertEqual(self.request(headers={'X-Telegram-User-Id': '0123'})[0], 403)
            self.assertEqual(self.request(path='/exec')[0], 404)
            self.assertEqual(self.request(body='x' * 16385)[0], 413)
            self.assertEqual(self.request(body=json.dumps({'action': 'exec'}))[0], 400)
            run.assert_not_called()

    def test_fixed_worker_and_timeout(self):
        with patch.object(agent.subprocess, 'run') as run:
            run.return_value.stdout = b'{"text":"done","images":[]}'
            self.assertEqual(self.request()[0], 200)
            args, kwargs = run.call_args
            self.assertEqual(args[0][-1], '--worker')
            self.assertNotIn('shell', kwargs)
            self.assertEqual(kwargs['timeout'], 8)
            run.side_effect = agent.subprocess.TimeoutExpired('worker', 8)
            status, raw = self.request()
            self.assertEqual(status, 500)
            self.assertNotIn(self.server.secret.encode(), raw)


if __name__ == '__main__':
    unittest.main()
