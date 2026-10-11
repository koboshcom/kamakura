"""Discord-only DM receive/play sidecar. Importing this module never logs in."""
import asyncio
import audioop
import base64
import ctypes.util
import json
import logging
import os
import queue
import secrets
import signal
import stat
import threading
import time

from protocol import AudioGate, ReceiveGate, authorize, decode_pcm, LINE

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
    from discord.ext.native_voice import VoiceClient, MediaSink
    if not str(discord.__version__).startswith("2.2.0a5340"):
        raise RuntimeError("Unexpected discord.py-self build")
    if not discord.opus.is_loaded():
        library = ctypes.util.find_library("opus")
        if not library:
            raise RuntimeError("libopus missing")
        discord.opus.load_opus(library)

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
            try:
                # Native receive decrypts upstream. Refuse unready/missing DAVE state.
                connection = s["voice"]._connection
                if not connection.dave_session or not connection.dave_session.ready or not connection.can_encrypt or connection.dave_session.can_passthrough(int(s["identity"]["user"])):
                    raise ValueError("DAVE state unknown")
                if not self.verify.check(packet, time.monotonic()):
                    raise ValueError("Unknown, reordered or stale receive packet")
                if not 0 < len(packet.payload) <= 4096:
                    raise ValueError("Oversized Opus packet")
                pcm = self.decoder.decode(packet.payload, fec=False)
                if len(pcm) != 3840:
                    raise ValueError("Expected 20ms PCM")
                # Native Decoder produces little-endian 48k stereo PCM. Low-pass
                # each 2-sample pair while averaging channels to PCM24k mono.
                import array
                samples = array.array("h", pcm)
                converted = array.array("h", (sum(samples[i:i+4]) // 4 for i in range(0, 1920, 4))).tobytes()
                speech = audioop.rms(converted, 2) >= 180
                if s["gate"].output_seen and speech:
                    raise ValueError("Barge-in freshness unknown")
                s["input"].put_nowait((packet.received_at, converted, speech))
            except Exception:
                s["gate"].close()
                s["failed"].set()

    class Client(discord.Client):
        def __init__(self):
            super().__init__(max_messages=100)
            self.active = None
            self.seen = set()
            self.handled = False
            self.lock = asyncio.Lock()

        async def on_ready(self):
            if not self.user or str(self.user.id) != self_id:
                await self.close()

        async def finish(self):
            s = self.active
            if not s:
                return
            self.active = None
            s["gate"].close()
            s["failed"].set()
            voice = s.get("voice")
            if voice:
                voice.stop()
                try:
                    await asyncio.wait_for(voice.disconnect(force=True), 3)
                except Exception:
                    pass

        async def close(self):
            await self.finish()
            await super().close()
            writer.close()

        async def on_disconnect(self):
            # No reconnect continuity or identity/freshness assumptions.
            if self.active:
                await self.close()

        async def on_call_create(self, call):
            await self.accept(call)

        async def on_call_update(self, before, after):
            if self.active and str(after.channel.id) == self.active["identity"]["channel"]:
                if not self.valid(after, ringing=False):
                    await self.close()
            else:
                await self.accept(after)

        async def on_call_delete(self, call):
            if self.active and str(call.channel.id) == self.active["identity"]["channel"]:
                await self.close()

        async def on_voice_state_update(self, member, before, after):
            if self.active and not self.valid(self.active["call"], ringing=False):
                await self.close()

        def valid(self, call, ringing=True):
            if not self.user or str(self.user.id) != self_id or not isinstance(call.channel, discord.DMChannel) or call.unavailable:
                return False
            recipient = call.channel.recipient
            if not recipient or str(recipient.id) not in owners:
                return False
            if ringing and (not call.initiator or call.initiator.id != recipient.id or not any(str(u.id) == self_id for u in call.ringing)):
                return False
            states = set(call.voice_states)
            return recipient.id in states and states <= {recipient.id, self.user.id}

        async def accept(self, call):
            async with self.lock:
                if self.active or self.handled or not self.valid(call):
                    return
                self.handled = True
                user = str(call.channel.recipient.id)
                identity = {"call": secrets.token_hex(16), "user": user, "owner": owners[user], "self": self_id, "channel": str(call.channel.id)}
                s = self.active = {"identity": identity, "call": call, "gate": AudioGate(), "input": queue.Queue(maxsize=8), "failed": threading.Event(), "voice": None}
                try:
                    # Connect Discord before opening any paid model connection.
                    s["voice"] = await call.channel.connect(cls=VoiceClient, ring=False, reconnect=False, timeout=10)
                    if not self.valid(call, ringing=False):
                        raise ValueError("Call identity changed")
                    await send(writer, {**identity, "type": "begin"})
                    ready = await asyncio.wait_for(receive(reader), 10)
                    check_identity(ready, identity)
                    if ready.get("type") != "ready":
                        raise ValueError("Model not ready")
                    s["voice"].listen(Sink(s))
                    s["voice"].play(Playback(s["gate"]))
                    tasks = [asyncio.create_task(self.pump(s)), asyncio.create_task(self.playback(s))]
                    done, pending = await asyncio.wait(tasks, timeout=float(os.environ["DISCORD_VOICE_MAX_SECONDS"]), return_when=asyncio.FIRST_COMPLETED)
                    s["gate"].close()
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                except Exception:
                    s["gate"].close()
                finally:
                    try:
                        await send(writer, {**identity, "type": "end"})
                    except Exception:
                        pass
                    await self.close()

        async def pump(self, s):
            sequence, last = 0, time.monotonic()
            while self.active is s:
                await asyncio.sleep(.02)
                now = time.monotonic()
                if now - last > .2 or s["failed"].is_set() or s["gate"].closed or not self.valid(s["call"], ringing=False) or not s["voice"].is_connected():
                    return
                last = now
                try:
                    at, data, speech = s["input"].get_nowait()
                    if now - at > .2:
                        return
                except queue.Empty:
                    data, speech = bytes(960), False
                if s["gate"].output_seen and speech:
                    return
                await send(writer, {**s["identity"], "type": "audio", "seq": sequence, "pcm": base64.b64encode(data).decode(), "speech": speech})
                sequence += 1

        async def playback(self, s):
            while self.active is s:
                msg = await asyncio.wait_for(receive(reader), .3)
                check_identity(msg, s["identity"])
                if msg.get("type") == "health":
                    continue
                if msg.get("type") == "end":
                    return
                if msg.get("type") != "audio" or not s["gate"].put(decode_pcm(msg.get("pcm"))):
                    return

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
