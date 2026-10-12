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
    def __init__(self, counts=None):
        self.counts = counts if counts is not None else {}
        self.lock = threading.Lock()
        self.frames = queue.Queue(maxsize=8)
        self.closed = False
        self.close_reason = None
        self.output_seen = False
        self.last_speech = float("-inf")
        self.resume_at = 0

    def speech(self, active, now=None):
        """Best-effort interruption, not a provider-generation boundary."""
        now = time.monotonic() if now is None else now
        with self.lock:
            if self.closed or not active:
                return False
            onset = now - self.last_speech > .2
            self.last_speech = now
            self.resume_at = now + .3
            if onset:
                self.flush_locked()
            return onset

    def flush_locked(self):
        self.output_seen = False
        while not self.frames.empty():
            self.frames.get_nowait()
            self.counts["output_flushed_frames"] = self.counts.get("output_flushed_frames", 0) + 1

    def flush(self, now=None):
        with self.lock:
            self.flush_locked()
            self.resume_at = max(self.resume_at, (time.monotonic() if now is None else now) + .3)


    def put(self, frame, now=None):
        if len(frame) != FRAME:
            raise ValueError("Invalid PCM size")
        with self.lock:
            if self.closed:
                return False
            if (time.monotonic() if now is None else now) < self.resume_at:
                self.counts["output_flushed_frames"] = self.counts.get("output_flushed_frames", 0) + 1
                return True
            self.output_seen = True
            try:
                self.frames.put_nowait((time.monotonic() if now is None else now, frame))
                self.counts["output_enqueued_frames"] = self.counts.get("output_enqueued_frames", 0) + 1
            except queue.Full:
                self.close_locked('playback_queue_full')
                return False
            return True

    def read(self, now=None):
        with self.lock:
            if self.closed:
                return b""
            if (time.monotonic() if now is None else now) < self.resume_at:
                return bytes(FRAME)
            try:
                at, data = self.frames.get_nowait()
            except queue.Empty:
                return bytes(FRAME)
            if (time.monotonic() if now is None else now) - at > .2:
                self.close_locked('playback_frame_stale')
                return b""
            self.counts["output_dequeued_frames"] = self.counts.get("output_dequeued_frames", 0) + 1
            return data

    def close_locked(self, reason='playback_gate_closed'):
        if not self.closed:
            self.close_reason = reason
        self.closed = True
        while not self.frames.empty():
            self.frames.get_nowait()
            self.counts["output_flushed_frames"] = self.counts.get("output_flushed_frames", 0) + 1

    def close(self):
        with self.lock:
            self.close_locked()

class ReceiveGate:
    def __init__(self, owner):
        self.owner = int(owner)
        self.sequence = None
        self.timestamp = None
        self.arrival = None
        self.resyncs = 0
        self.ssrc = None

    def reject_reason(self, packet, now):
        # Fixed enums only. Never return sender IDs, codec strings or payloads.
        if packet.user_id is None:
            return "identity_unmapped"
        if packet.user_id != self.owner:
            return "identity_wrong_caller"
        if packet.media_type != "audio":
            return "media_not_audio"
        if packet.codec != "opus":
            return "codec_not_opus"
        if packet.received_at is None or not math.isfinite(packet.received_at):
            return "arrival_missing_invalid"
        age = now - packet.received_at
        if age < 0:
            return "arrival_future"
        if age > .2:
            return "arrival_stale"
        if self.ssrc is not None and self.ssrc != packet.ssrc:
            return "ssrc_changed"
        if self.sequence is not None:
            delta = (packet.sequence - self.sequence) & 0xffff
            if delta == 0:
                return "sequence_duplicate"
            if delta >= 32768:
                return "sequence_reordered"
            sequence_delta = delta
        if self.timestamp is not None:
            delta = (packet.timestamp - self.timestamp) & 0xffffffff
            if delta == 0:
                return "timestamp_duplicate"
            if delta >= 2147483648:
                return "timestamp_reordered"
            if sequence_delta >= 64 or delta > 48000:
                # DTX advances RTP timestamps without advancing packet sequence.
                # Trusted arrival clock, unchanged caller/SSRC, and forward
                # half-range ordering are mandatory before accepting a rebase.
                wall = packet.received_at - self.arrival
                elapsed = delta / 48000
                if not (.75 <= wall <= 30 and elapsed <= 30
                        and abs(elapsed - wall) <= .25
                        and sequence_delta <= min(32767, math.ceil(wall / .02) + 64)):
                    return "sequence_gap" if sequence_delta >= 64 else "timestamp_gap"
        return None

    def check(self, packet, now):
        if self.reject_reason(packet, now) is not None:
            return False
        if self.sequence is not None:
            if ((packet.sequence - self.sequence) & 0xffff) >= 64 or ((packet.timestamp - self.timestamp) & 0xffffffff) > 48000:
                self.resyncs += 1
        self.ssrc, self.sequence, self.timestamp = packet.ssrc, packet.sequence, packet.timestamp
        self.arrival = packet.received_at
        return True
