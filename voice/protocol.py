"""Offline-testable bounded audio and authorization primitives."""
import base64
import binascii
import json
import math
import queue
import re
import threading
import time

FRAME = 960
LINE = 8192

def snowflake(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[1-9][0-9]{16,19}", value)) and int(value) <= 18446744073709551615

def authorize(env):
    owners = json.loads(env.get("DISCORD_VOICE_OWNER_IDS", "{}"))
    allowed = set(filter(None, env.get("DISCORD_VOICE_ALLOWED_USERS", "").split(",")))
    canonical = set(env.get("SANDBOX_ALLOWED_USERS", "").split(","))
    self_id = env.get("DISCORD_VOICE_SELF_ID", "")
    if not snowflake(self_id) or not allowed or "*" in canonical or not isinstance(owners, dict) or set(owners) != allowed:
        raise ValueError("Invalid owner authorization")
    for user, owner in owners.items():
        if not snowflake(user) or user == self_id or not isinstance(owner, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", owner) or owner not in canonical:
            raise ValueError("Invalid owner mapping")
    return owners, self_id

def decode_pcm(value):
    if not isinstance(value, str) or len(value) != 1280:
        raise ValueError("Invalid frame")
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Invalid frame") from exc
    if len(data) != FRAME or base64.b64encode(data).decode() != value:
        raise ValueError("Invalid frame")
    return data

class AudioGate:
    """Thread-safe, fixed-size playback queue. Closing is irreversible."""
    def __init__(self):
        self.lock = threading.Lock()
        self.frames = queue.Queue(maxsize=8)
        self.closed = False
        self.output_seen = False

    def put(self, frame, now=None):
        if len(frame) != FRAME:
            raise ValueError("Invalid PCM size")
        with self.lock:
            if self.closed:
                return False
            self.output_seen = True
            try:
                self.frames.put_nowait((time.monotonic() if now is None else now, frame))
            except queue.Full:
                self.close_locked()
                return False
            return True

    def read(self, now=None):
        with self.lock:
            if self.closed:
                return b""
            try:
                at, data = self.frames.get_nowait()
            except queue.Empty:
                return bytes(FRAME)
            if (time.monotonic() if now is None else now) - at > .2:
                self.close_locked()
                return b""
            return data

    def close_locked(self):
        self.closed = True
        while not self.frames.empty():
            self.frames.get_nowait()

    def close(self):
        with self.lock:
            self.close_locked()

class ReceiveGate:
    def __init__(self, owner):
        self.owner = int(owner)
        self.sequence = None
        self.timestamp = None
        self.ssrc = None

    def check(self, packet, now):
        if packet.user_id != self.owner or packet.media_type != "audio" or packet.codec != "opus" or packet.received_at is None or not math.isfinite(packet.received_at) or not 0 <= now - packet.received_at <= .2:
            return False
        if self.ssrc is not None and self.ssrc != packet.ssrc:
            return False
        if self.sequence is not None and not 0 < ((packet.sequence - self.sequence) & 0xffff) < 64:
            return False
        if self.timestamp is not None and not 0 < ((packet.timestamp - self.timestamp) & 0xffffffff) <= 48000:
            return False
        self.ssrc, self.sequence, self.timestamp = packet.ssrc, packet.sequence, packet.timestamp
        return True
