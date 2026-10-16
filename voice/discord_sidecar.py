"""Discord-only DM receive/play sidecar. Importing this module never logs in."""
import asyncio
import audioop
import base64
import ctypes.util
import json
import logging
import math
import os
import queue
import secrets
import signal
import stat
import sys
import threading
import time
import re
import traceback
import contextvars
from handshake_trace import bounded_connect, traced_voice_class, STEPS

from latency import InputPacer, mark, duration
from protocol import AudioGate, ReceiveGate, authorize, decode_pcm, LINE

# Free-form exception messages are never emitted. Only exact fixed reasons survive.
DIAGNOSTIC_REASONS = frozenset((
    "Call identity changed", "Model not ready", "DAVE state unknown",
    "Caller left during connect", "Whole connect deadline", "Connect cancellation incomplete",
    "Unknown, reordered or stale receive packet", "Oversized Opus packet",
    "codecs must include an Opus audio codec",
    "Voice connection did not finish negotiating transport encryption.",
))
RECEIVE_REASONS = ('receive_identity_unmapped', 'receive_identity_wrong_caller', 'receive_media_not_audio', 'receive_codec_not_opus', 'receive_arrival_missing_invalid', 'receive_arrival_future', 'receive_arrival_stale', 'receive_ssrc_changed', 'receive_sequence_duplicate', 'receive_sequence_reordered', 'receive_sequence_gap', 'receive_timestamp_duplicate', 'receive_timestamp_reordered', 'receive_timestamp_gap')
DIAGNOSTIC_REASONS = DIAGNOSTIC_REASONS | frozenset(RECEIVE_REASONS) | frozenset(("Expected 20ms PCM",))
STREAM_REASONS = ('pump_tick_stale', 'sink_failed', 'playback_gate_closed', 'playback_queue_full', 'playback_frame_stale', 'pump_call_invalid', 'pump_voice_disconnected', 'input_queue_stale', 'playback_end_from_core', 'playback_message_invalid', 'stream_duration_limit', 'playback_heartbeat_timeout')
DIAGNOSTIC_REASONS = DIAGNOSTIC_REASONS | frozenset(STREAM_REASONS)
diagnostic_attempt = contextvars.ContextVar("voice_call_diagnostic", default=None)

def safe_exception(error):
    if error is None:
        return {}
    message = str(error)
    result = {"reason": message if message in DIAGNOSTIC_REASONS else "redacted"}
    frames = []
    # Walk the complete exception chain, without source text or frame locals.
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        tb = error.__traceback__
        while tb is not None:
            filename = tb.tb_frame.f_code.co_filename
            # Only installed package/repo paths, never arbitrary private filenames.
            relative = None
            for prefix in ("/app/voice-venv/lib/python3.11/site-packages/", "/app/voice/", "/usr/lib/python3.11/"):
                if filename.startswith(prefix):
                    relative = filename[len(prefix):]
                    break
            if relative is None and filename.endswith("/voice/discord_sidecar.py"):
                relative = "discord_sidecar.py"
            safe_file = relative if relative and re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_./-]{0,240}\.py", relative) else "redacted"
            kind = type(error).__name__
            frames.append({"file": safe_file, "line": tb.tb_lineno,
                           "exception": kind if re.fullmatch(r"[A-Za-z_]{1,80}", kind) else "other"})
            tb = tb.tb_next
        error = error.__cause__ or (None if error.__suppress_context__ else error.__context__)
    result["stack"] = frames
    return result

def diagnostic(stage, counters=None, error=None, caller=None, gate=None, step=None, status=None, attempt=None):
    payload = {"stage": stage, "counters": counters or {},
               "errorType": type(error).__name__ if error else "none"}
    stable = attempt or diagnostic_attempt.get()
    if stable and re.fullmatch(r"[a-f0-9]{16}", stable):
        payload["attempt"] = stable
    payload["eventId"] = secrets.token_hex(8)
    if step in STEPS:
        payload["step"] = step
    if status in ("start", "done", "error", "cancelled", "observed", "handler_returned"):
        payload["status"] = status
    if caller and re.fullmatch(r"[0-9]{1,20}", caller):
        payload["callerDiscordId"] = caller
    if gate:
        payload["gate"] = gate
    payload.update(safe_exception(error))
    print(json.dumps(payload, separators=(",", ":")), flush=True)

def counted_audio_write(voice, counts, data, write):
    # The exact pinned implementation swallows socket OSError but advances
    # _audio_packet_count only after send_packet/socket.sendall returns.
    before = voice._audio_packet_count
    counts["discord_write_attempts"] = counts.get("discord_write_attempts", 0) + 1
    try:
        write()
    except Exception:
        counts["discord_write_errors"] = counts.get("discord_write_errors", 0) + 1
        raise
    if ((voice._audio_packet_count - before) & 0xffffffff) == 1:
        counts["discord_write_frames"] = counts.get("discord_write_frames", 0) + 1
        counts["discord_write_pcm_bytes"] = counts.get("discord_write_pcm_bytes", 0) + len(data)
    else:
        counts["discord_write_errors"] = counts.get("discord_write_errors", 0) + 1


async def main():
    if os.environ.get("DISCORD_VOICE_ENABLED") != "true":
        return
    owners, self_id = authorize(os.environ)
    path, secret = os.environ["DISCORD_VOICE_IPC_PATH"], os.environ["DISCORD_VOICE_IPC_TOKEN"]
    for name, mode in ((os.path.dirname(path), 0o700), (path, 0o600)):
        info = os.lstat(name)
        expected = stat.S_ISDIR(info.st_mode) if name != path else stat.S_ISSOCK(info.st_mode)
        if not expected or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != mode:
            raise ValueError("Unsafe IPC endpoint")
    if not os.path.isabs(path) or len(secret) != 64:
        raise ValueError("Invalid IPC credentials")
    reader, writer = await asyncio.open_unix_connection(path, limit=LINE + 1)
    writer.transport.set_write_buffer_limits(high=16384, low=4096)
    await send(writer, {"type": "hello", "token": secret, "self": self_id})
    hello = await asyncio.wait_for(receive(reader), 3)
    if hello.get("type") != "hello":
        raise ValueError("IPC handshake rejected")
    # Do not import a generic discord.py distribution in place of the pinned self fork.
    import discord
    from discord.ext.native_voice import MediaSink
    from audio_only import AudioOnlyVoiceClient
    from discord.ext.native_voice.dave import _looks_like_dave_protocol_frame
    from importlib.metadata import version
    if version("discord.py-self") != "2.2.0a5340+g2ba64a9a" or discord.__version__ != "2.2.0a" or version("discord-native-voice") != "0.1.1" or version("davey") != "0.1.6":
        raise RuntimeError("Unexpected discord.py-self build")
    if not discord.opus.is_loaded():
        library = ctypes.util.find_library("opus")
        if not library:
            raise RuntimeError("libopus missing")
        discord.opus.load_opus(library)

    def trace(step, status, counters=None, error=None):
        diagnostic("handshake_trace", counters, error, step=step, status=status)

    class ObservedVoiceClient(traced_voice_class(AudioOnlyVoiceClient, trace)):
        def __init__(self, client, channel):
            super().__init__(client, channel)
            self.receive_counts = client.active["counts"]
            self.user_expected = client.active["identity"]["user"]
            self.metric_origin = client.active["metric_origin"]

        def send_audio_packet(self, data, *, encode=True):
            parent = super().send_audio_packet
            started = time.perf_counter()
            before = self._audio_packet_count
            counted_audio_write(self, self.receive_counts, data,
                                lambda: parent(data, encode=encode))
            duration(self.receive_counts, "discord_send", started)
            if ((self._audio_packet_count - before) & 0xffffffff) == 1:
                mark(self.receive_counts, "discord_write", self.metric_origin)

        def _decode_media_packets(self, batch, *, received_at):
            self.receive_counts["rtp_packets"] += len(batch)
            packets = super()._decode_media_packets(batch, received_at=received_at)
            self.receive_counts["native_media"] += len(packets)
            return packets

        def _decode_decoded_media_packet(self, decoded, *, raw, received_at):
            # Native transport authentication already succeeded. Before native
            # DAVE decryption, reject unmapped/other callers, unready epochs and
            # plaintext (including SFU silence). Never buffer stale ciphertext.
            try:
                connection = self._connection
                expected = int(self.user_expected)
                user = connection.ssrc_user_ids.get(decoded.ssrc)
                session = connection.dave_session
                reason = None
                if user != expected:
                    reason = "dave_identity_dropped"
                elif not session or not session.ready or not connection.can_encrypt:
                    reason = "dave_unready_dropped"
                elif session.can_passthrough(user) or not _looks_like_dave_protocol_frame(decoded.payload):
                    reason = "dave_plaintext_dropped"
                if reason:
                    counts = self.receive_counts
                    counts[reason] = counts.get(reason, 0) + 1
                    if counts[reason] == 1:
                        diagnostic("dave_state", counts, gate="packet_dropped")
                    return None
                # The pinned parent invokes DaveSession.decrypt for this mapped user
                # and drops failures. A successful frame still passes sink identity,
                # arrival, sequence/replay, codec and PCM checks.
                return super()._decode_decoded_media_packet(decoded, raw=raw, received_at=received_at)
            except Exception as exc:
                # Do not let a packet callback exception stop native listening.
                key = "sink_drop_dave_state"
                self.receive_counts[key] = self.receive_counts.get(key, 0) + 1
                if self.receive_counts[key] == 1:
                    diagnostic("dave_state", self.receive_counts, exc, gate="packet_dropped")
                return None

        def _log_packet_decode_error(self, message, *args):
            key = "decrypt_errors" if "decrypt" in message else "transport_decode_errors"
            self.receive_counts[key] += 1
            exc = sys.exc_info()[1]
            first_code = False
            for code in ("NoValidCryptorFound", "NoDecryptorForUser", "UnencryptedWhenPassthroughDisabled"):
                if exc and code in str(exc):
                    self.receive_counts[code] += 1
                    first_code = self.receive_counts[code] == 1
            if self.receive_counts[key] == 1 or first_code:
                diagnostic(key, self.receive_counts, exc)

    class Playback(discord.AudioSource):
        def __init__(self, gate):
            self.gate = gate

        def read(self):
            pcm = self.gate.read()
            if not pcm:
                return b""
            # Exact integer-ratio conversion, PCM24k mono to PCM48k stereo.
            import array
            samples = array.array("h", pcm)
            out = array.array("h")
            for value in samples:
                out.extend((value, value, value, value))
            return out.tobytes()

        def is_opus(self):
            return False

        def cleanup(self):
            self.gate.close()

    class Sink(MediaSink):
        def __init__(self, state):
            super().__init__()
            self.state = state
            self.verify = ReceiveGate(state["identity"]["user"])
            self.decoder = discord.opus.Decoder()

        def wants_media(self, media_type, codec):
            return media_type == "audio" and codec == "opus"

        def write(self, packet):
            s = self.state
            s["counts"]["sink_packets"] += 1
            stage = "dave_state"
            if s["gate"].closed or s["failed"].is_set():
                return
            try:
                # Native receive authenticates/decrypts upstream. Readiness may
                # change at an epoch boundary, so uncertainty drops this packet.
                connection = s["voice"]._connection
                if not connection.dave_session or not connection.dave_session.ready or not connection.can_encrypt or connection.dave_session.can_passthrough(int(s["identity"]["user"])):
                    raise ValueError("DAVE state unknown")
                stage = "packet_identity_freshness"
                now = time.perf_counter()
                reason = self.verify.reject_reason(packet, now)
                if reason is not None:
                    # Fixed counters and the first stack per reason, no datagram content.
                    # Rejected packets never update ordering state or reach Opus/PCM.
                    key = "receive_" + reason
                    s["counts"]["receive_dropped"] += 1
                    s["counts"][key] = s["counts"].get(key, 0) + 1
                    if packet.received_at is not None and math.isfinite(packet.received_at):
                        s["counts"]["reject_age_ms"] = min(2147483647, max(0, int((now - packet.received_at) * 1000)))
                    if self.verify.sequence is not None:
                        s["counts"]["reject_sequence_delta"] = (packet.sequence - self.verify.sequence) & 0xffff
                    if self.verify.timestamp is not None:
                        s["counts"]["reject_timestamp_delta"] = (packet.timestamp - self.verify.timestamp) & 0xffffffff
                    if s["counts"][key] == 1:
                        try:
                            raise ValueError(key)
                        except ValueError as rejection:
                            diagnostic(stage, s["counts"], rejection, gate="packet_dropped", attempt=s.get("diagnostic_id"))
                    return
                self.verify.check(packet, now)
                s["counts"]["receive_resyncs"] = self.verify.resyncs
                stage = "opus_packet_size"
                if not 0 < len(packet.payload) <= 4096:
                    s["counts"]["invalid_opus_packets"] = s["counts"].get("invalid_opus_packets", 0) + 1
                    s["counts"]["invalid_opus_bytes"] = min(len(packet.payload), 2147483647)
                    raise ValueError("Oversized Opus packet")
                stage = "opus_decode"
                origin = s.get("metric_origin", now)
                mark(s["counts"], "recv", origin, packet.received_at)
                pcm = self.decoder.decode(packet.payload, fec=False)
                s["counts"]["opus_decoded"] += 1
                mark(s["counts"], "decode", origin)
                duration(s["counts"], "recv_decode", packet.received_at)
                resample_at = time.perf_counter()
                stage = "pcm_frame_size"
                if len(pcm) != 3840:
                    s["counts"]["invalid_pcm_frames"] = s["counts"].get("invalid_pcm_frames", 0) + 1
                    s["counts"]["invalid_pcm_bytes"] = min(len(pcm), 2147483647)
                    raise ValueError("Expected 20ms PCM")
                # Native Decoder produces little-endian 48k stereo PCM. Low-pass
                # each 2-sample pair while averaging channels to PCM24k mono.
                import array
                samples = array.array("h", pcm)
                converted = array.array("h", (sum(samples[i:i+4]) // 4 for i in range(0, 1920, 4))).tobytes()
                mark(s["counts"], "resample", origin)
                duration(s["counts"], "resample", resample_at)
                speech = audioop.rms(converted, 2) >= 180
                if s.get("was_speech", False) and not speech:
                    mark(s["counts"], "speech_end", origin)
                s["was_speech"] = speech
                stage = "barge_in"
                if s["gate"].speech(speech):
                    diagnostic(stage, s["counts"], gate="best_effort_flush")
                stage = "receive_queue"
                s["input"].put_nowait((packet.received_at, converted, speech))
                s["counts"]["pcm_queued"] += 1
                if speech:
                    s["counts"]["speech_frames"] += 1
            except Exception as exc:
                # Packet-level errors must not tear down the receiver before MLS
                # welcome/commit can complete. Drop, count and log once per stage.
                key = "sink_drop_" + stage
                s["counts"]["receive_dropped"] += 1
                s["counts"][key] = s["counts"].get(key, 0) + 1
                if s["counts"][key] == 1:
                    diagnostic(stage, s["counts"], exc, gate="packet_dropped", attempt=s.get("diagnostic_id"))

    class Client(discord.Client):
        def __init__(self):
            super().__init__(max_messages=100, enable_debug_events=True)
            self.active = None
            self.voice_blocked = False
            from text_dm import TextDM
            self.text_dm = TextDM(self, discord, owners, self_id)

        def event_entry(self, stage, call=None):
            diagnostic_attempt.set(self.active["diagnostic_id"] if self.active else secrets.token_hex(8))
            recipient = getattr(getattr(call, "channel", None), "recipient", None)
            caller = str(getattr(recipient, "id", "")) or None
            diagnostic(stage, {"active": int(self.active is not None),
                               "voice_blocked": int(self.voice_blocked),
                               "voice_clients": len(self.voice_clients)},
                       caller=caller, gate="entry")
            return caller

        async def on_ready(self):
            self.event_entry("client_ready_state")
            if not self.user or str(self.user.id) != self_id:
                diagnostic("call_gate", gate="self_identity")
                await self.close()
                return
            await send(writer, {"type": "ready", "self": self_id, "username": self.user.name})
            await self.text_dm.ready()

        async def on_message(self, message):
            try:
                await self.text_dm.message(message)
            except Exception:
                pass  # Never log message contents or signed attachment URLs.

        async def finish(self):
            s = self.active
            if not s:
                return
            s["gate"].close()
            s["failed"].set()
            voice = s.get("voice")
            if voice:
                voice.stop()
                voice.stop_listening()
                try:
                    await asyncio.wait_for(voice.disconnect(force=True), 3)
                except Exception:
                    self.voice_blocked = True
            while not s["input"].empty():
                s["input"].get_nowait()
            s["voice"] = None

        async def close(self):
            await self.text_dm.close()
            await self.finish()
            await super().close()
            writer.close()

        async def on_disconnect(self):
            # No reconnect continuity or identity/freshness assumptions.
            if self.active:
                await self.close()

        async def on_socket_event_type(self, event):
            # Exact installed gateway event hook, carrying only the event name.
            if event in ("CALL_CREATE", "CALL_UPDATE", "CALL_DELETE"):
                self.event_entry("gateway_call_entry")

        async def on_call_create(self, call):
            self.event_entry("incoming_create", call)
            await self.accept(call)

        async def on_call_update(self, before, after):
            caller = self.event_entry("incoming_update", after)
            if self.active and str(after.channel.id) == self.active["identity"]["channel"]:
                if not self.valid(after, ringing=False):
                    diagnostic("call_gate", caller=caller, gate=self.valid_reason(after, ringing=False))
                    self.active["gate"].close()
                    self.active["failed"].set()
                    self.active["departed"].set()
                else:
                    diagnostic("call_gate", caller=caller, gate="active_update_valid")
            else:
                await self.accept(after)

        async def on_call_delete(self, call):
            self.event_entry("incoming_delete", call)
            if self.active and str(call.channel.id) == self.active["identity"]["channel"]:
                self.active["gate"].close()
                self.active["failed"].set()
                self.active["departed"].set()

        async def on_voice_state_update(self, member, before, after):
            self.event_entry("voice_state_entry", self.active["call"] if self.active else None)
            if self.active and not self.valid(self.active["call"], ringing=False):
                self.active["gate"].close()
                self.active["failed"].set()
                self.active["departed"].set()

        def valid_reason(self, call, ringing=True):
            if not self.user or str(self.user.id) != self_id:
                return "self_identity"
            if not isinstance(call.channel, discord.DMChannel):
                return "not_dm"
            if call.unavailable:
                return "call_unavailable"
            recipient = call.channel.recipient
            if not recipient:
                return "missing_recipient"
            if str(recipient.id) not in owners:
                return "allowlist_miss"
            if ringing:
                if not call.initiator:
                    return "missing_initiator"
                if call.initiator.id != recipient.id:
                    return "initiator_mismatch"
                if not any(str(u.id) == self_id for u in call.ringing):
                    return "not_ringing_self"
            states = set(call.voice_states)
            if recipient.id not in states:
                return "caller_not_in_voice"
            if not states <= {recipient.id, self.user.id}:
                return "extra_participant"
            return "valid"

        def valid(self, call, ringing=True):
            return self.valid_reason(call, ringing) == "valid"

        async def accept(self, call):
            caller = self.event_entry("accept_entry", call)
            gate = "already_active" if self.active else "voice_blocked" if self.voice_blocked else self.valid_reason(call)
            diagnostic("call_gate", caller=caller, gate=gate)
            if gate != "valid":
                return
            user = str(call.channel.recipient.id)
            identity = {"call": secrets.token_hex(16), "user": user, "owner": owners[user], "self": self_id, "channel": str(call.channel.id)}
            s = self.active = {"identity": identity, "call": call, "gate": AudioGate(), "input": queue.Queue(maxsize=8), "failed": threading.Event(), "voice": None, "diagnostic_id": diagnostic_attempt.get(), "departed": asyncio.Event()}
            s["metric_origin"] = time.perf_counter()
            s["counts"] = dict.fromkeys(("rtp_packets", "native_media", "decrypt_errors", "transport_decode_errors", "NoValidCryptorFound", "NoDecryptorForUser", "UnencryptedWhenPassthroughDisabled", "sink_packets", "receive_dropped", "opus_decoded", "pcm_queued", "speech_frames", "ipc_frames", "ipc_speech_frames"), 0)
            s["gate"].counts = s["counts"]
            tasks = []
            begun = False
            stage = "discord_connect"
            diagnostic_attempt.set(s["diagnostic_id"])
            diagnostic(stage)
            observer = asyncio.create_task(self.observe(s))
            try:
                # Connect Discord before opening any paid model connection.
                trace("whole_connect", "start")
                s["voice"] = await bounded_connect(
                    lambda: call.channel.connect(cls=ObservedVoiceClient, ring=False,
                                                 reconnect=False, timeout=10),
                    s["departed"], timeout=10)
                trace("whole_connect", "done")
                if self.active is not s or not self.valid(call, ringing=False):
                    diagnostic("call_gate", caller=user, gate="active_changed" if self.active is not s else self.valid_reason(call, ringing=False))
                    await s["voice"].disconnect(force=True)
                    raise ValueError("Call identity changed")
                s["voice"].receive_counts = s["counts"]
                stage = "provider_ready"
                diagnostic(stage)
                await send(writer, {**identity, "type": "begin", "diagnosticAttempt": s["diagnostic_id"]})
                begun = True
                ready = await asyncio.wait_for(receive(reader), 10)
                check_identity(ready, identity)
                if ready.get("type") != "ready":
                    raise ValueError("Model not ready")
                stage = "listen_start"
                s["voice"].listen(Sink(s), after=lambda error: diagnostic("listen_stopped", s["counts"], error))
                s["voice"].play(Playback(s["gate"]))
                stage = "streaming"
                diagnostic(stage)
                tasks = [asyncio.create_task(self.pump(s)), asyncio.create_task(self.playback(s))]
                done, pending = await asyncio.wait(tasks, timeout=float(os.environ["DISCORD_VOICE_MAX_SECONDS"]), return_when=asyncio.FIRST_COMPLETED)
                s["gate"].close()
                for task in pending:
                    task.cancel()
                results = await asyncio.gather(*tasks, return_exceptions=True)
                if not done:
                    diagnostic("streaming_exit", s["counts"], ValueError("stream_duration_limit"))
                for result in results:
                    if isinstance(result, Exception):
                        diagnostic("streaming_exit", s["counts"], result)
            except Exception as exc:
                diagnostic(stage, s["counts"], exc, attempt=s.get("diagnostic_id"))
                if stage == "discord_connect":
                    trace("whole_connect", "error", error=exc)
                    # The library registers a partial voice client before connect returns.
                    # Never leave that object cached after timeout/caller departure.
                    if str(exc) == "Connect cancellation incomplete":
                        self.voice_blocked = True
                    partial = s["voice"] or self.voice_client
                    trace("partial_cleanup", "start")
                    if partial:
                        try:
                            await asyncio.wait_for(partial.disconnect(force=True), 3)
                        except Exception as cleanup_error:
                            self.voice_blocked = True
                            trace("partial_cleanup", "error", error=cleanup_error)
                        finally:
                            partial.cleanup()
                        if partial in self.voice_clients:
                            self.voice_blocked = True
                    trace("partial_cleanup", "done",
                          {"voice_clients": len(self.voice_clients),
                           "voice_blocked": int(self.voice_blocked)})
                s["gate"].close()
            finally:
                observer.cancel()
                await asyncio.gather(observer, return_exceptions=True)
                diagnostic("call_finished", s["counts"])
                try:
                    if begun:
                        await send(writer, {**identity, "type": "end"})
                except Exception:
                    pass
                s["gate"].close()
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                await self.finish()
                if begun:
                    try:
                        await send(writer, {**identity, "type": "clean", "ok": not self.voice_blocked})
                        async def wait_complete():
                            while True:
                                msg = await receive(reader)
                                check_identity(msg, identity)
                                if msg.get("type") == "complete":
                                    return msg.get("finalized") is True or msg.get("reusable") is True
                                if msg.get("type") not in {"audio", "health", "end"}:
                                    return False
                        confirmed = await asyncio.wait_for(wait_complete(), 4)
                        if not confirmed:
                            self.voice_blocked = True
                    except Exception:
                        self.voice_blocked = True
                if self.active is s:
                    self.active = None

        async def observe(self, s):
            while self.active is s:
                await asyncio.sleep(2)
                counts = dict(s["counts"])
                voice = s.get("voice")
                if voice:
                    connection = voice._connection
                    dave = connection.dave_session
                    counts.update(dave_present=int(bool(dave)), dave_ready=int(bool(dave and dave.ready)), dave_can_encrypt=int(bool(connection.can_encrypt)))
                diagnostic("call_counters", counts)

        async def pump(self, s):
            sequence, last = 0, time.monotonic()
            pacer = InputPacer(last)
            while self.active is s:
                await asyncio.sleep(pacer.delay(time.monotonic()))
                now = time.monotonic()
                pacer.advance(now)
                if now - last > .2:
                    raise ValueError("pump_tick_stale")
                if s["failed"].is_set():
                    raise ValueError("sink_failed")
                if s["gate"].closed:
                    raise ValueError(s["gate"].close_reason or "playback_gate_closed")
                if not self.valid(s["call"], ringing=False):
                    diagnostic("call_gate", caller=s["identity"]["user"], gate=self.valid_reason(s["call"], ringing=False))
                    raise ValueError("pump_call_invalid")
                if not s["voice"].is_connected():
                    raise ValueError("pump_voice_disconnected")
                last = now
                real_input = False
                try:
                    at, data, speech = s["input"].get_nowait()
                    real_input = True
                    if time.perf_counter() - at > .2:
                        s["counts"]["input_queue_age_ms"] = min(2147483647, max(0, int((time.perf_counter() - at) * 1000)))
                        raise ValueError("input_queue_stale")
                except queue.Empty:
                    data, speech = bytes(960), False
                send_at = time.perf_counter()
                if real_input:
                    duration(s["counts"], "input_queue", at, send_at)
                await send(writer, {**s["identity"], "type": "audio", "seq": sequence, "pcm": base64.b64encode(data).decode(), "speech": speech})
                duration(s["counts"], "ipc_send", send_at)
                if real_input:
                    mark(s["counts"], "input_send", s["metric_origin"])
                s["counts"]["ipc_frames"] += 1
                input_kind = "ipc_decoded_frames" if real_input else "ipc_synthetic_silence_frames"
                s["counts"][input_kind] = s["counts"].get(input_kind, 0) + 1
                if speech:
                    s["counts"]["ipc_speech_frames"] += 1
                sequence += 1

        async def playback(self, s):
            while self.active is s:
                try:
                    msg = await asyncio.wait_for(receive(reader), .3)
                except asyncio.TimeoutError as exc:
                    raise ValueError("playback_heartbeat_timeout") from exc
                check_identity(msg, s["identity"])
                if msg.get("type") == "flush":
                    s["gate"].flush()
                    continue
                if msg.get("type") == "health":
                    continue
                if msg.get("type") == "end":
                    raise ValueError("playback_end_from_core")
                if msg.get("type") != "audio":
                    raise ValueError("playback_message_invalid")
                data = decode_pcm(msg.get("pcm"))
                mark(s["counts"], "output_receive", s["metric_origin"])
                s["counts"]["output_received_frames"] = s["counts"].get("output_received_frames", 0) + 1
                if not s["gate"].put(data):
                    raise ValueError(s["gate"].close_reason or "playback_gate_closed")

    client = Client()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(client.close()))
    try:
        # Credential never goes to Node IPC, logs, argv or model input.
        await client.start(os.environ["DISCORD_VOICE_USER_TOKEN"], reconnect=False)
    finally:
        await client.close()

async def send(writer, event):
    data = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    if len(data) > LINE or writer.is_closing() or writer.transport.get_write_buffer_size() > 16384:
        raise ValueError("IPC backpressure")
    writer.write(data)
    await asyncio.wait_for(writer.drain(), .1)

async def receive(reader):
    data = await reader.readline()
    if not data or len(data) > LINE or not data.endswith(b"\n"):
        raise ValueError("IPC framing")
    msg = json.loads(data)
    if not isinstance(msg, dict):
        raise ValueError("IPC object required")
    return msg

def check_identity(msg, identity):
    if any(msg.get(key) != value for key, value in identity.items()):
        raise ValueError("Call identity changed")

if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    asyncio.run(main())
