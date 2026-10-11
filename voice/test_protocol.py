import base64
import importlib.util
import os
import sys
import unittest
from types import SimpleNamespace
from protocol import AudioGate, ReceiveGate, authorize, decode_pcm

SELF = "222222222222222222"
USER = "111111111111111111"

class ProtocolTests(unittest.TestCase):
    def test_authorize(self):
        env = {"DISCORD_VOICE_SELF_ID": SELF, "DISCORD_VOICE_ALLOWED_USERS": USER, "DISCORD_VOICE_OWNER_IDS": '{"' + USER + '":"1"}', "SANDBOX_ALLOWED_USERS": "1"}
        self.assertEqual(authorize(env), ({USER: "1"}, SELF))
        for patch in [{"SANDBOX_ALLOWED_USERS": "*"}, {"SANDBOX_ALLOWED_USERS": "2"}, {"DISCORD_VOICE_SELF_ID": USER}, {"DISCORD_VOICE_OWNER_IDS": "{}"}]:
            with self.assertRaises(ValueError):
                authorize({**env, **patch})

    def test_pcm(self):
        self.assertEqual(decode_pcm(base64.b64encode(bytes(960)).decode()), bytes(960))
        for value in [None, "", "!" * 1280, base64.b64encode(bytes(959)).decode()]:
            with self.assertRaises(ValueError):
                decode_pcm(value)

    def test_playback_overflow_is_irreversible(self):
        gate = AudioGate()
        for _ in range(8):
            self.assertTrue(gate.put(bytes(960), now=1))
        self.assertFalse(gate.put(bytes(960), now=1))
        self.assertEqual(gate.read(now=1), b"")
        self.assertFalse(gate.put(bytes(960)))

    def test_playback_stale_mutes(self):
        gate = AudioGate()
        gate.put(bytes(960), now=1)
        self.assertEqual(gate.read(now=1.3), b"")
        self.assertTrue(gate.closed)

    def test_silence_then_frame_then_close(self):
        gate = AudioGate()
        self.assertEqual(gate.read(), bytes(960))
        gate.put(b"x" * 960, now=1)
        self.assertEqual(gate.read(now=1.1), b"x" * 960)
        gate.close()
        self.assertEqual(gate.read(), b"")

    def test_receive_identity_freshness_order(self):
        def packet(**kw):
            return SimpleNamespace(**{"user_id": int(USER), "media_type": "audio", "codec": "opus", "received_at": 1.0, "ssrc": 10, "sequence": 1, "timestamp": 960, **kw})
        for patch in [{"user_id": None}, {"user_id": 1}, {"received_at": None}, {"received_at": float("nan")}, {"received_at": .7}, {"codec": "pcm"}, {"media_type": "video"}]:
            self.assertFalse(ReceiveGate(USER).check(packet(**patch), 1.1))
        gate = ReceiveGate(USER)
        self.assertTrue(gate.check(packet(), 1.1))
        self.assertFalse(gate.check(packet(), 1.1))
        self.assertTrue(gate.check(packet(sequence=2, timestamp=1920), 1.1))
        self.assertFalse(gate.check(packet(sequence=3, timestamp=2880, ssrc=11), 1.1))

    def test_rtp_wraparound(self):
        gate = ReceiveGate(USER)
        p = SimpleNamespace(user_id=int(USER), media_type="audio", codec="opus", received_at=1, ssrc=1, sequence=65535, timestamp=4294967040)
        self.assertTrue(gate.check(p, 1.1))
        p.sequence, p.timestamp = 0, 704
        self.assertTrue(gate.check(p, 1.1))

    def test_two_call_gates_do_not_share_audio_or_receive_state(self):
        first_audio, second_audio = AudioGate(), AudioGate()
        first_audio.put(b"x" * 960, now=1)
        first_audio.close()
        self.assertEqual(first_audio.read(), b"")
        self.assertFalse(second_audio.output_seen)
        self.assertEqual(second_audio.read(), bytes(960))
        first_receive, second_receive = ReceiveGate(USER), ReceiveGate(USER)
        packet = SimpleNamespace(user_id=int(USER), media_type="audio", codec="opus", received_at=1, ssrc=1, sequence=1, timestamp=960)
        self.assertTrue(first_receive.check(packet, 1.1))
        self.assertFalse(first_receive.check(packet, 1.1))
        self.assertTrue(second_receive.check(packet, 1.1))

    def test_sidecar_import_does_not_import_discord_or_login(self):
        sys.modules.pop("discord", None)
        spec = importlib.util.spec_from_file_location("sidecar_test", os.path.join(os.path.dirname(__file__), "discord_sidecar.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertNotIn("discord", sys.modules)

    def test_disabled_main_never_opens_ipc(self):
        import asyncio
        from unittest.mock import patch
        import discord_sidecar
        with patch.dict(os.environ, {"DISCORD_VOICE_ENABLED": "false"}, clear=True), patch("asyncio.open_unix_connection", side_effect=AssertionError("must not connect")):
            asyncio.run(discord_sidecar.main())

if __name__ == "__main__":
    unittest.main()
