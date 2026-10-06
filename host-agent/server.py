#!/usr/bin/env python3
"""Opt-in macOS GUI control. No shell or arbitrary-code API."""
import base64
import hmac
import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MAX_BODY = 16384
MAX_OUTPUT = 6 * 1024 * 1024
KEY = re.compile(r'^(?:[a-z0-9]|enter|tab|space|backspace|delete|escape|esc|up|down|left|right|home|end|pageup|pagedown|shift|ctrl|alt|option|command|win|f(?:[1-9]|1[0-2]))$')


def validate(data):
    if not isinstance(data, dict):
        raise ValueError()
    action = data.get('action')
    fields = {'screenshot': {'action'}, 'click': {'action', 'x', 'y', 'button'},
              'move': {'action', 'x', 'y'}, 'type': {'action', 'text'}, 'press': {'action', 'keys'}}
    if action not in fields or set(data) != fields[action]:
        raise ValueError()
    if action in ('click', 'move'):
        if any(type(data[k]) is not int or not 0 <= data[k] <= 16383 for k in ('x', 'y')):
            raise ValueError()
    if action == 'click' and data['button'] not in ('left', 'right', 'middle'):
        raise ValueError()
    if action == 'type' and (not isinstance(data['text'], str) or not 1 <= len(data['text']) <= 2000 or not re.fullmatch(r'[\x20-\x7e]+', data['text'])):
        raise ValueError()
    if action == 'press' and (not isinstance(data['keys'], list) or not 1 <= len(data['keys']) <= 4 or any(not isinstance(k, str) or not KEY.fullmatch(k) for k in data['keys'])):
        raise ValueError()
    return data


def worker():
    data = validate(json.loads(sys.stdin.buffer.read(MAX_BODY + 1)))
    import pyautogui as gui
    gui.FAILSAFE = True
    gui.PAUSE = 0.1
    action = data['action']
    images = []
    if action == 'screenshot':
        # Native capture avoids PyAutoGUI screenshot backend differences on macOS.
        with tempfile.TemporaryDirectory(prefix='kamakura-screen-') as directory:
            path = Path(directory) / 'screen.png'
            subprocess.run(['/usr/sbin/screencapture', '-x', '-m', '-t', 'png', str(path)], check=True,
                           timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if path.stat().st_size > 32 * 1024 * 1024:
                raise ValueError()
            from PIL import Image
            with Image.open(path) as image:
                # Match primary-display logical coordinates used by PyAutoGUI.
                image = image.resize(tuple(gui.size()))
                image.save(path, format='PNG')
            if path.stat().st_size > 4 * 1024 * 1024:
                raise ValueError()
            images = [base64.b64encode(path.read_bytes()).decode('ascii')]
    elif action in ('move', 'click'):
        if not gui.onScreen(data['x'], data['y']):
            raise ValueError()
        if action == 'move':
            gui.moveTo(data['x'], data['y'])
        else:
            gui.click(x=data['x'], y=data['y'], button=data['button'])
    elif action == 'type':
        gui.write(data['text'], interval=0)
    elif action == 'press':
        if any(k not in gui.KEYBOARD_KEYS for k in data['keys']):
            raise ValueError()
        gui.hotkey(*data['keys'])
    result = json.dumps({'text': 'Host action completed.', 'images': images}).encode()
    if len(result) > MAX_OUTPUT:
        raise ValueError()
    sys.stdout.buffer.write(result)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *args):
        pass  # Never log headers, bodies, screens or secrets.

    def reply(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/v1/action':
            return self.reply(404, {'error': 'Not found'})
        auth = self.headers.get_all('Authorization', [])
        ids = self.headers.get_all('X-Telegram-User-Id', [])
        if len(auth) != 1 or len(ids) != 1 or not hmac.compare_digest(auth[0].encode(), ('Bearer ' + self.server.secret).encode()) or not hmac.compare_digest(ids[0].encode(), self.server.user_id.encode()):
            return self.reply(403, {'error': 'Forbidden'})
        lengths = self.headers.get_all('Content-Length', [])
        if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= MAX_BODY:
            return self.reply(413, {'error': 'Invalid body length'})
        try:
            raw = self.rfile.read(int(lengths[0]))
            if len(raw) != int(lengths[0]):
                raise ValueError()
            data = validate(json.loads(raw))
        except (ValueError, OSError, TypeError):
            return self.reply(400, {'error': 'Invalid input'})
        try:
            # Fixed subprocess with validated data only, no shell. Kill after 8s.
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--worker'],
                                    input=json.dumps(data).encode(), stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, timeout=8, check=True)
            if len(result.stdout) > MAX_OUTPUT:
                raise ValueError()
            self.reply(200, json.loads(result.stdout))
        except (subprocess.SubprocessError, ValueError, OSError):
            self.reply(500, {'error': 'Action failed; inspect before retrying'})


def main():
    if sys.platform != 'darwin':
        raise SystemExit('This agent requires macOS.')
    bind = os.environ.get('HOST_AGENT_BIND', '')
    try:
        ip = ipaddress.IPv4Address(bind)
        if str(ip) != bind or ip not in ipaddress.IPv4Network('100.64.0.0/10'):
            raise ValueError()
    except ValueError:
        raise SystemExit('HOST_AGENT_BIND must be an explicit Tailscale IPv4 address.')
    secret = os.environ.get('HOST_AGENT_SECRET', '')
    user_id = os.environ.get('HOST_AGENT_TELEGRAM_USER_ID', '')
    if not re.fullmatch(r'[\x21-\x7e]{32,256}', secret) or not re.fullmatch(r'[1-9]\d{0,15}', user_id):
        raise SystemExit('Provide a strong secret and exact numeric Telegram user ID.')
    server = HTTPServer((bind, 8765), Handler)
    server.secret, server.user_id = secret, user_id
    server.serve_forever()


if __name__ == '__main__':
    if sys.argv[1:] == ['--worker']:
        try:
            worker()
        except Exception:
            sys.exit(1)
    elif sys.argv[1:]:
        raise SystemExit('Unsupported arguments')
    else:
        main()
