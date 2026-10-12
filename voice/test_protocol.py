import base64
import importlib.util
import os
import sys
import unittest
from types import SimpleNamespace
from latency import InputPacer, mark, duration
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

    def test_native_owner_authorization(self):
        import json
        owner = "discord-" + USER
        env = {"DISCORD_VOICE_SELF_ID": SELF, "DISCORD_VOICE_ALLOWED_USERS": USER, "DISCORD_VOICE_OWNER_IDS": json.dumps({USER: owner}), "SANDBOX_ALLOWED_USERS": owner}
        self.assertEqual(authorize(env), ({USER: owner}, SELF))
        for patch in [{"SANDBOX_ALLOWED_USERS": USER}, {"DISCORD_VOICE_OWNER_IDS": json.dumps({USER: "discord-" + SELF})}, {"DISCORD_VOICE_OWNER_IDS": json.dumps({USER: "../" + USER})}]:
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

class SidecarClientCompatibility(unittest.TestCase):
    def test_voice_state_does_not_assign_discord_readonly_blocked(self):
        from pathlib import Path
        source = Path(__file__).with_name("discord_sidecar.py").read_text()
        self.assertNotIn("self.blocked", source)
        self.assertIn("self.voice_blocked = False", source)


class DiagnosticPrivacy(unittest.TestCase):
    def test_stack_and_fixed_reason_without_private_content(self):
        import discord_sidecar
        try:
            raise ValueError("Call identity changed")
        except ValueError as error:
            result = discord_sidecar.safe_exception(error)
        self.assertEqual(result["reason"], "Call identity changed")
        self.assertTrue(result["stack"])
        self.assertNotIn("locals", str(result))
        for message in ("sk-secret https://user:password@private/", "token=SECRET", "private transcript"):
            self.assertEqual(discord_sidecar.safe_exception(ValueError(message))["reason"], "redacted")

class EventGateEntry(unittest.TestCase):
    def test_entry_precedes_accept_early_return_and_ready_guard(self):
        from pathlib import Path
        source = Path(__file__).with_name("discord_sidecar.py").read_text()
        accept = source.split("async def accept(self, call):", 1)[1].split("async def", 1)[0]
        self.assertLess(accept.index('self.event_entry("accept_entry"'), accept.index('if gate != "valid"'))
        for name, stage in (("on_call_create", "incoming_create"), ("on_call_update", "incoming_update"), ("on_call_delete", "incoming_delete")):
            body = source.split("async def "+name, 1)[1]
            self.assertIn('self.event_entry("'+stage+'"', body.split("\n\n",1)[0])

class WholeConnectDeadline(unittest.IsolatedAsyncioTestCase):
    async def test_whole_call_deadline_and_cancellation(self):
        import asyncio
        from handshake_trace import bounded_connect
        cancelled = asyncio.Event()
        async def connect():
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        with self.assertRaisesRegex(TimeoutError, "Whole connect deadline"):
            await bounded_connect(connect, asyncio.Event(), timeout=.01)
        self.assertTrue(cancelled.is_set())

    async def test_departure_cancels_connect(self):
        import asyncio
        from handshake_trace import bounded_connect
        departed = asyncio.Event()
        async def connect():
            departed.set()
            await asyncio.Event().wait()
        with self.assertRaisesRegex(ValueError, "Caller left during connect"):
            await bounded_connect(connect, departed, timeout=1)

    async def test_successful_connect_returns_result(self):
        import asyncio
        from handshake_trace import bounded_connect
        async def connect():
            return "connected"
        self.assertEqual(await bounded_connect(connect, asyncio.Event(), 1), "connected")

class BestEffortBargeIn(unittest.TestCase):
    def test_flush_debounce_resume_repeat_and_teardown(self):
        gate = AudioGate()
        gate.put(b"x" * 960, now=1)
        self.assertTrue(gate.speech(True, now=1.01))
        self.assertFalse(gate.output_seen)
        self.assertEqual(gate.read(now=1.02), bytes(960))
        self.assertTrue(gate.put(b"o" * 960, now=1.03))
        self.assertFalse(gate.speech(True, now=1.1))
        self.assertEqual(gate.read(now=1.4), bytes(960))
        self.assertTrue(gate.put(b"n" * 960, now=1.41))
        self.assertEqual(gate.read(now=1.42), b"n" * 960)
        self.assertTrue(gate.speech(True, now=1.5))
        gate.flush(now=1.51)
        self.assertFalse(gate.closed)
        gate.put(b"z" * 960, now=1.82)
        self.assertEqual(gate.read(now=1.83), b"z" * 960)
        gate.close()
        self.assertEqual(gate.read(now=2), b"")

    def test_sidecar_microphone_has_no_output_hangup_guard(self):
        from pathlib import Path
        source = Path(__file__).with_name("discord_sidecar.py").read_text()
        self.assertNotIn('output_seen and speech', source)
        self.assertNotIn('Barge-in freshness unknown', source)
        self.assertIn('stage = "barge_in"', source)
        self.assertIn('s["gate"].speech(speech)', source)

class RejectedPacketDoesNotHangUp(unittest.TestCase):
    def test_actual_sink_write_drops_rejected_packets_and_keeps_valid_speech(self):
        import ast
        import audioop
        import queue
        import threading
        import time
        from pathlib import Path
        from unittest.mock import Mock
        tree = ast.parse(Path(__file__).with_name("discord_sidecar.py").read_text())
        sink = next(x for x in ast.walk(tree) if isinstance(x, ast.ClassDef) and x.name == "Sink")
        write = next(x for x in sink.body if isinstance(x, ast.FunctionDef) and x.name == "write")
        calls = []
        ns = {"mark": mark, "duration": duration, "time": time, "math": __import__("math"), "audioop": audioop, "diagnostic": lambda *a, **k: calls.append((a,k))}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[write], type_ignores=[])), "<actual-sink-write>", "exec"), ns)
        connection = SimpleNamespace(dave_session=SimpleNamespace(ready=True, can_passthrough=lambda user: False), can_encrypt=True)
        counts = dict.fromkeys(("sink_packets", "receive_dropped", "opus_decoded", "pcm_queued", "speech_frames"), 0)
        state = {"counts": counts, "gate": AudioGate(), "failed": threading.Event(), "voice": SimpleNamespace(_connection=connection), "identity": {"user": USER}, "input": queue.Queue(maxsize=8)}
        instance = SimpleNamespace(state=state, verify=ReceiveGate(USER), decoder=Mock())
        instance.decoder.decode.return_value = (1000).to_bytes(2, "little", signed=True) * 1920
        def packet(**kw):
            return SimpleNamespace(**dict(user_id=int(USER), media_type="audio", codec="opus", received_at=time.perf_counter(), ssrc=10, sequence=1, timestamp=960, payload=b"x", **kw))
        # Unknown identity and stale datagrams never reach Opus or PCM.
        for patch in ({"user_id":None}, {"received_at":time.perf_counter()-1}):
            p = packet()
            for k,v in patch.items(): setattr(p,k,v)
            ns["write"](instance,p)
        instance.decoder.decode.assert_not_called()
        self.assertFalse(state["failed"].is_set())
        self.assertFalse(state["gate"].closed)
        self.assertTrue(state["input"].empty())
        p = packet()
        ns["write"](instance,p)
        # A replay is dropped without poisoning ordering state.
        ns["write"](instance,p)
        p = packet(); p.sequence=2; p.timestamp=1920
        ns["write"](instance,p)
        self.assertEqual(instance.decoder.decode.call_count,2)
        self.assertEqual(counts["receive_dropped"],3)
        self.assertEqual(counts["receive_identity_unmapped"],1)
        self.assertEqual(counts["receive_arrival_stale"],1)
        self.assertEqual(counts["receive_sequence_duplicate"],1)
        # Each rejected reason logs once; cumulative counts remain visible.
        for _ in range(20):
            ns["write"](instance,p)
        self.assertEqual(counts["receive_sequence_duplicate"],21)
        self.assertEqual(len([c for c in calls if c[1].get("gate") == "packet_dropped"]),3)
        self.assertEqual(state["input"].qsize(),2)
        self.assertFalse(state["gate"].closed)
        self.assertFalse(state["failed"].is_set())
        # Persistent malformed Opus/PCM is still fail-closed, not a dropped
        # freshness packet disguised as successful receive.
        for bad_pcm in (False, True):
            fresh = dict(state, counts=dict.fromkeys(counts, 0), gate=AudioGate(), failed=threading.Event(), input=queue.Queue(maxsize=8))
            instance.state = fresh
            instance.verify = ReceiveGate(USER)
            instance.decoder.reset_mock()
            q = packet()
            if bad_pcm:
                instance.decoder.decode.return_value = bytes(1920)
            else:
                q.payload = bytes(4097)
            ns["write"](instance,q)
            self.assertFalse(fresh["failed"].is_set())
            self.assertFalse(fresh["gate"].closed)
            self.assertTrue(fresh["input"].empty())
            self.assertEqual(fresh["counts"]["invalid_pcm_bytes" if bad_pcm else "invalid_opus_bytes"],1920 if bad_pcm else 4097)
            if not bad_pcm:
                instance.decoder.decode.assert_not_called()
        instance.state = state
        # DAVE uncertainty drops without decoding or closing; recovery on the
        # next authenticated epoch uses the same receiver.
        connection.dave_session.ready = False
        ns["write"](instance,packet())
        self.assertFalse(state["gate"].closed)
        self.assertFalse(state["failed"].is_set())
        prior = instance.decoder.decode.call_count
        connection.dave_session.ready = True
        instance.decoder.decode.return_value = (1000).to_bytes(2, "little", signed=True) * 1920
        q = packet(); q.sequence=3; q.timestamp=2880
        ns["write"](instance,q)
        self.assertEqual(instance.decoder.decode.call_count,prior+1)
        self.assertEqual(state["input"].qsize(),3)


class ReceiveRejectDiagnostics(unittest.TestCase):
    def test_exact_predicates_and_unchanged_boundary(self):
        def packet(**changes):
            d = dict(user_id=int(USER), media_type="audio", codec="opus", received_at=1.0, ssrc=1, sequence=100, timestamp=96000)
            d.update(changes)
            return SimpleNamespace(**d)
        gate = ReceiveGate(USER)
        self.assertTrue(gate.check(packet(),1.1))
        cases = [
            ({"user_id":None}, "identity_unmapped"),
            ({"user_id":int(USER)+1}, "identity_wrong_caller"),
            ({"media_type":"video"}, "media_not_audio"),
            ({"codec":"pcm"}, "codec_not_opus"),
            ({"received_at":None}, "arrival_missing_invalid"),
            ({"received_at":float("nan")}, "arrival_missing_invalid"),
            ({"received_at":1.2}, "arrival_future"),
            ({"received_at":.8}, "arrival_stale"),
            ({"ssrc":2}, "ssrc_changed"),
            ({}, "sequence_duplicate"),
            ({"sequence":99}, "sequence_reordered"),
            ({"sequence":164,"timestamp":96960}, "sequence_gap"),
            ({"sequence":101}, "timestamp_duplicate"),
            ({"sequence":101,"timestamp":95999}, "timestamp_reordered"),
            ({"sequence":101,"timestamp":144001}, "timestamp_gap"),
        ]
        for patch,expected in cases:
            p=packet(**patch)
            self.assertEqual(gate.reject_reason(p,1.1), expected)
            self.assertFalse(gate.check(p,1.1))
            self.assertEqual((gate.sequence,gate.timestamp),(100,96000))
        self.assertTrue(gate.check(packet(sequence=163,timestamp=144000),1.1))


class StreamingExitReasons(unittest.IsolatedAsyncioTestCase):
    async def test_actual_pump_identifies_stale_queue_without_forwarding(self):
        import ast, asyncio, queue, threading, time
        from pathlib import Path
        from unittest.mock import AsyncMock, patch
        source=Path(__file__).with_name("discord_sidecar.py").read_text()
        tree=ast.parse(source)
        pump=next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name=="pump")
        calls=[]
        async def send(*args):
            calls.append(args)
        ns={"InputPacer":InputPacer,"asyncio":asyncio,"time":time,"queue":queue,"base64":base64,"send":send,"diagnostic":lambda *a,**k: None}
        exec(compile(ast.Module(body=[pump],type_ignores=[]),"discord_sidecar.py","exec"),ns)
        s={"input":queue.Queue(),"failed":threading.Event(),"gate":AudioGate(),"call":None,"voice":SimpleNamespace(is_connected=lambda:True),"identity":{"user":USER},"counts":{}}
        s["input"].put((time.perf_counter()-1,bytes(960),False))
        client=SimpleNamespace(active=s,valid=lambda *a,**k:True)
        with patch("asyncio.sleep",new=AsyncMock()):
            with self.assertRaisesRegex(ValueError,"input_queue_stale"):
                await ns["pump"](client,s)
        self.assertEqual(calls,[])
        self.assertGreaterEqual(s["counts"]["input_queue_age_ms"],200)

    async def test_actual_playback_reports_core_end_without_changing_gate(self):
        import ast, asyncio
        from pathlib import Path
        source=Path(__file__).with_name("discord_sidecar.py").read_text()
        node=next(n for n in ast.walk(ast.parse(source)) if isinstance(n,ast.AsyncFunctionDef) and n.name=="playback")
        async def receive(reader):
            return {"type":"end"}
        ns={"InputPacer":InputPacer,"asyncio":asyncio,"receive":receive,"reader":None,"check_identity":lambda *a:None,"decode_pcm":decode_pcm}
        exec(compile(ast.Module(body=[node],type_ignores=[]),"discord_sidecar.py","exec"),ns)
        s={"identity":{},"gate":AudioGate()}
        client=SimpleNamespace(active=s)
        with self.assertRaisesRegex(ValueError,"playback_end_from_core"):
            await ns["playback"](client,s)
        self.assertFalse(s["gate"].closed)

class SilenceResync(unittest.TestCase):
    def packet(self, **kw):
        fields=dict(user_id=int(USER), media_type="audio", codec="opus", received_at=1., ssrc=10, sequence=100, timestamp=96000)
        fields.update(kw)
        return SimpleNamespace(**fields)

    def test_gap_rebases_then_normal_progression_and_replay_denied(self):
        gate=ReceiveGate(USER)
        first=self.packet()
        self.assertTrue(gate.check(first,1.))
        gap=self.packet(received_at=4.6,sequence=101,timestamp=268800)
        self.assertTrue(gate.check(gap,4.6))
        self.assertEqual(gate.resyncs,1)
        self.assertFalse(gate.check(gap,4.6))
        self.assertFalse(gate.check(first,4.6))
        self.assertTrue(gate.check(self.packet(received_at=4.62,sequence=102,timestamp=269760),4.62))
        self.assertEqual(gate.resyncs,1)

    def test_gap_identity_clock_bounds_and_rejected_cursor_unchanged(self):
        for patch in (dict(user_id=None),dict(user_id=1),dict(ssrc=11),
                      dict(sequence=99),dict(sequence=100),dict(sequence=4000),
                      dict(timestamp=95000),dict(timestamp=96000),
                      dict(received_at=1.02),dict(received_at=40),
                      dict(received_at=4.1),dict(received_at=5.1)):
            gate=ReceiveGate(USER)
            self.assertTrue(gate.check(self.packet(),1.))
            fields=dict(received_at=4.6,sequence=101,timestamp=268800)
            fields.update(patch)
            packet=self.packet(**fields)
            self.assertFalse(gate.check(packet,packet.received_at))
            self.assertEqual((gate.sequence,gate.timestamp,gate.arrival,gate.resyncs),(100,96000,1.,0))
        gate=ReceiveGate(USER);gate.check(self.packet(),1.)
        self.assertFalse(gate.check(self.packet(received_at=4.6,sequence=101,timestamp=268800),5.))
        self.assertEqual(gate.sequence,100)

    def test_bounded_loss_and_wrap(self):
        gate=ReceiveGate(USER)
        self.assertTrue(gate.check(self.packet(sequence=65535,timestamp=0xffff0000),1.))
        self.assertTrue(gate.check(self.packet(received_at=3,sequence=99,timestamp=(0xffff0000+96000)&0xffffffff),3))
        self.assertEqual(gate.resyncs,1)


class PlaybackWriteCounters(unittest.TestCase):
    def test_success_swallowed_socket_failure_exception_and_wrap(self):
        from discord_sidecar import counted_audio_write
        voice=SimpleNamespace(_audio_packet_count=0xffffffff)
        counts={}
        def success(): voice._audio_packet_count=0
        counted_audio_write(voice,counts,bytes(3840),success)
        counted_audio_write(voice,counts,bytes(3840),lambda:None)
        def fail(): raise RuntimeError("private")
        with self.assertRaises(RuntimeError):
            counted_audio_write(voice,counts,bytes(3840),fail)
        self.assertEqual(counts,dict(discord_write_attempts=3,discord_write_frames=1,discord_write_pcm_bytes=3840,discord_write_errors=2))

    def test_queue_received_enqueued_flush_and_read_counts(self):
        counts={}
        gate=AudioGate(counts)
        gate.put(bytes(960),now=1)
        gate.put(bytes(960),now=1)
        self.assertEqual(gate.read(now=1),bytes(960))
        gate.flush(now=1)
        self.assertEqual(counts,dict(output_enqueued_frames=2,output_dequeued_frames=1,output_flushed_frames=1,output_queue_n=1,output_queue_sum_us=0,output_queue_max_us=0))

class PinnedSocketWriteEvidence(unittest.TestCase):
    def test_actual_native_write_counter_only_after_successful_socket_write(self):
        from discord.ext.native_voice import VoiceClient
        from discord_sidecar import counted_audio_write
        from unittest.mock import Mock
        # Exercise exact pinned native send method, offline crypto/UDP fixtures.
        voice=SimpleNamespace(sequence=0,timestamp=0,ssrc=1,_audio_packet_count=0,_audio_octet_count=0,
            _get_voice_packet=lambda *a, **k: b"encrypted-fixture",
            _maybe_send_audio_rtcp_sender_report=lambda *a:None,
            _record_rtp_send_stats=lambda **k:None,
            _connection=SimpleNamespace(send_packet=Mock()))
        def checked_add(name,step,limit):
            setattr(voice,name,(getattr(voice,name)+step) % (limit+1))
        voice.checked_add=checked_add
        counts={}
        def native_write(): VoiceClient.send_audio_packet(voice,b"opus-fixture",encode=False)
        counted_audio_write(voice,counts,b"opus-fixture",native_write)
        voice._connection.send_packet.side_effect=OSError("not logged")
        counted_audio_write(voice,counts,b"opus-fixture",native_write)
        self.assertEqual(counts["discord_write_frames"],1)
        self.assertEqual(counts["discord_write_errors"],1)
        self.assertEqual(voice._audio_packet_count,1)
        self.assertEqual(voice._connection.send_packet.call_count,2)

class DaveReceiveStartup(unittest.TestCase):
    def wrapper(self):
        import ast
        from pathlib import Path
        from discord.ext.native_voice.dave import _looks_like_dave_protocol_frame
        node = next(n for n in ast.walk(ast.parse(Path(__file__).with_name("discord_sidecar.py").read_text()))
                    if isinstance(n, ast.ClassDef) and n.name == "ObservedVoiceClient")
        method = next(n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == "_decode_decoded_media_packet")
        node.bases = [ast.Name(id="Parent", ctx=ast.Load())]
        node.body = [method]
        class Parent:
            def _decode_decoded_media_packet(self, decoded, **kw):
                self.decrypt_attempts += 1
                return "authenticated-native-result"
        events = []
        ns = {"Parent": Parent, "_looks_like_dave_protocol_frame": _looks_like_dave_protocol_frame,
              "diagnostic": lambda *a, **kw: events.append((a,kw))}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])), "<actual-native-wrapper>", "exec"),ns)
        voice = ns["ObservedVoiceClient"]()
        voice.user_expected = USER
        voice.receive_counts = {}
        voice.decrypt_attempts = 0
        voice._connection = SimpleNamespace(dave_session=None,can_encrypt=False,ssrc_user_ids={10:int(USER)})
        return voice, events

    def encrypted_shape(self):
        # Valid framing, deliberately not real ciphertext. Only tests whether
        # the wrapper delegates to native crypto, never authentication itself.
        return bytes(8)+b"\x00\x0c\xfa\xfa"

    def test_no_decryptor_then_ready_keeps_receiver_alive(self):
        voice, events = self.wrapper()
        packet = SimpleNamespace(ssrc=10,payload=self.encrypted_shape())
        for _ in range(20):
            self.assertIsNone(voice._decode_decoded_media_packet(packet,raw=b"",received_at=1))
        self.assertEqual(voice.decrypt_attempts,0)
        self.assertEqual(len(events),1)
        voice._connection.dave_session = SimpleNamespace(ready=True,can_passthrough=lambda user:False)
        voice._connection.can_encrypt = True
        self.assertEqual(voice._decode_decoded_media_packet(packet,raw=b"",received_at=1),"authenticated-native-result")
        self.assertEqual(voice.decrypt_attempts,1)

    def test_outsider_unmapped_plaintext_passthrough_and_invalid_frames_denied(self):
        voice, events = self.wrapper()
        connection = voice._connection
        connection.dave_session = SimpleNamespace(ready=True,can_passthrough=lambda user:False)
        connection.can_encrypt = True
        for user in (None,int(USER)+1):
            connection.ssrc_user_ids = {10:user}
            self.assertIsNone(voice._decode_decoded_media_packet(SimpleNamespace(ssrc=10,payload=self.encrypted_shape()),raw=b"",received_at=1))
        connection.ssrc_user_ids = {10:int(USER)}
        for payload in (b"plaintext",b"\xf8\xff\xfe",bytes(8)+b"\x00\xff\xfa\xfa"):
            self.assertIsNone(voice._decode_decoded_media_packet(SimpleNamespace(ssrc=10,payload=payload),raw=b"",received_at=1))
        connection.dave_session.can_passthrough = lambda user:True
        self.assertIsNone(voice._decode_decoded_media_packet(SimpleNamespace(ssrc=10,payload=self.encrypted_shape()),raw=b"",received_at=1))
        self.assertEqual(voice.decrypt_attempts,0)

    def test_repeat_call_mappings_and_counters_are_independent(self):
        first,_ = self.wrapper()
        second,_ = self.wrapper()
        first._connection.ssrc_user_ids.clear()
        self.assertEqual(second._connection.ssrc_user_ids,{10:int(USER)})
        self.assertIsNot(first.receive_counts,second.receive_counts)


    def test_native_packet_callback_exception_is_bounded_and_recovers(self):
        voice, events = self.wrapper()
        voice._connection.ssrc_user_ids = None
        p = SimpleNamespace(ssrc=10,payload=self.encrypted_shape())
        for _ in range(20):
            self.assertIsNone(voice._decode_decoded_media_packet(p,raw=b"",received_at=1))
        self.assertEqual(len(events),1)
        voice._connection.ssrc_user_ids = {10:int(USER)}
        voice._connection.dave_session = SimpleNamespace(ready=True,can_passthrough=lambda user:False)
        voice._connection.can_encrypt = True
        self.assertEqual(voice._decode_decoded_media_packet(p,raw=b"",received_at=1),"authenticated-native-result")
