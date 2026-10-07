#!/opt/desktop-venv/bin/python
"""Per-container Python globals. This executes UNTRUSTED code, not a Python sandbox.
Docker is the security boundary. Only a same-uid Unix socket is exposed.
"""
import base64
from contextlib import redirect_stdout, redirect_stderr
import io
import json
import os
import socket
import time
import traceback
import subprocess
import tempfile

CUA_SOCKET = '/tmp/runtime-kamakura/cua-driver.sock'
CUA_TOOLS = frozenset(('list_apps', 'list_windows', 'get_window_state', 'get_desktop_state',
                       'get_accessibility_tree', 'click', 'double_click', 'right_click',
                       'type_text', 'press_key', 'hotkey', 'scroll', 'drag', 'set_value',
                       'bring_to_front', 'launch_app', 'get_screen_size', 'check_permissions'))


class CuaDriver:
    """CLI connects only to this container's private Unix daemon. No shell parsing."""
    def call(self, name, args=None):
        if name not in CUA_TOOLS:
            raise ValueError('Unsupported desktop tool')
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise ValueError('Tool arguments must be an object')
        args = dict(args)
        args.setdefault('session', 'kamakura')
        payload = json.dumps(args)
        if len(payload.encode()) > MAX_REQUEST:
            raise ValueError('Desktop arguments too large')
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            result = subprocess.run(['cua-driver', 'call', name, '--socket', CUA_SOCKET],
                                    input=payload.encode(), stdout=out, stderr=err, timeout=30)
            out.seek(0)
            data = out.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise ValueError('Cua response too large')
            if result.returncode and not data:
                # stderr may include typed secrets. Never echo it back.
                raise RuntimeError('Cua Driver call failed; inspect container diagnostics')
            try:
                response = json.loads(data)
            except ValueError:
                response = {'message': data.decode('utf-8', errors='replace')[:MAX_TEXT]}
            if not isinstance(response, dict):
                response = {'result': response}
            # CLI flattens structuredContent and inserts this field (0.34.0).
            image = response.pop('screenshot_png_b64', None)
            mime = response.pop('screenshot_mime_type', 'image/png')
            blocks = []
            if image is not None:
                if not isinstance(image, str) or len(image) > 3 * 1024 * 1024:
                    raise ValueError('Cua image too large')
                blocks.append({'type': 'image', 'data': image, 'mimeType': mime})
            return {'structuredContent': response, 'content': blocks,
                    'isError': result.returncode != 0}


def screenshot():
    """Capture-only fallback. Input always goes through Cua Driver, never PyAutoGUI."""
    from PIL import ImageGrab
    return ImageGrab.grab(xdisplay=os.environ.get('DISPLAY', ':99'))

SOCKET = '/tmp/kamakura-desktop.sock'
MAX_REQUEST = 40000
MAX_TEXT = 16000
MAX_IMAGE = 2 * 1024 * 1024
MAX_RESPONSE = 6 * 1024 * 1024


class BoundedText(io.TextIOBase):
    def __init__(self):
        self.parts = []
        self.length = 0
        self.truncated = False

    def write(self, value):
        remaining = MAX_TEXT - self.length
        if remaining > 0:
            self.parts.append(value[:remaining])
        self.length += min(len(value), max(remaining, 0))
        self.truncated |= len(value) > remaining
        return len(value)

    def getvalue(self):
        return ''.join(self.parts) + ('\n[output truncated]' if self.truncated else '')


def make_session(cua, browser_factory):
    """Separate persistent namespace from runtime internals. Not a security barrier."""
    namespace = {'__name__': '__desktop__', 'cua': cua, 'time': time,
                 'screenshot': screenshot, 'get_browser': browser_factory}

    def execute(code):
        text = BoundedText()
        images = []

        def display(image):
            if len(images) >= 2:
                raise ValueError('At most two screenshots per call')
            # PIL image or PNG/JPEG bytes (e.g. Playwright page.screenshot()).
            from PIL import Image
            if isinstance(image, bytes):
                if len(image) > MAX_IMAGE:
                    raise ValueError('Image too large')
                image = Image.open(io.BytesIO(image))
            if not isinstance(image, Image.Image) or image.width * image.height > 1920 * 1200:
                raise ValueError('Expected a PIL image or screenshot bytes, at most 1920x1200')
            buffer = io.BytesIO()
            image.convert('RGB').save(buffer, format='PNG')
            if buffer.tell() > MAX_IMAGE:
                raise ValueError('Encoded screenshot too large')
            images.append(base64.b64encode(buffer.getvalue()).decode('ascii'))

        namespace.update(display=display, log=print)
        error = None
        with redirect_stdout(text), redirect_stderr(text):
            try:
                exec(compile(code, '<exec_py>', 'exec'), namespace, namespace)
            except BaseException as exc:
                error = type(exc).__name__
                traceback.print_exc(limit=5)
        return {'text': text.getvalue(), 'images': images, 'error': error}
    return execute


def serve():
    from playwright.sync_api import sync_playwright
    # These are container processes, NEVER a connection to a user's real desktop.
    playwright = sync_playwright().start()
    browser = None

    def get_browser():
        nonlocal browser
        if browser is None:
            browser = playwright.chromium.launch_persistent_context(
                '/work/.chromium', headless=False,
                viewport={'width': 1280, 'height': 800},
                # Docker is the isolation boundary. Dropped caps/no-new-privileges
                # prevent Chromium's setuid sandbox from initializing here.
                args=['--disable-dev-shm-usage', '--no-sandbox'],
            )
            browser.set_default_timeout(10000)
        return browser

    get_browser()
    execute = make_session(CuaDriver(), get_browser)
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(SOCKET)
        os.chmod(SOCKET, 0o600)
        server.listen(4)
        while True:
            connection, _ = server.accept()
            with connection:
                connection.settimeout(10)
                try:
                    with connection.makefile('rb') as request:
                        data = request.readline(MAX_REQUEST + 1)
                    if len(data) > MAX_REQUEST or not data.endswith(b'\n'):
                        raise ValueError('Request too large')
                    code = json.loads(data)['code']
                    if not isinstance(code, str) or not 1 <= len(code) <= 8000 or '\0' in code:
                        raise ValueError('Code must be 1-8000 characters without NUL')
                    response = json.dumps(execute(code)).encode()
                    if len(response) > MAX_RESPONSE:
                        raise ValueError('Response too large')
                    connection.sendall(response)
                except Exception as exc:
                    try:
                        connection.sendall(json.dumps({'text': str(exc)[:1000], 'images': [], 'error': type(exc).__name__}).encode())
                    except OSError:
                        pass


if __name__ == '__main__':
    serve()
