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


def make_session(pyautogui, browser_factory):
    """Separate persistent namespace from runtime internals. Not a security barrier."""
    namespace = {'__name__': '__desktop__', 'pyautogui': pyautogui, 'time': time,
                 'get_browser': browser_factory}

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
        pyautogui.FAILSAFE = True
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
    import pyautogui
    from playwright.sync_api import sync_playwright
    pyautogui.PAUSE = 0.15
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
    execute = make_session(pyautogui, get_browser)
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
