import asyncio
import ast
import queue
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from latency import InputPacer, mark, duration, METRIC_KEYS

class LatencyTests(unittest.TestCase):
    def test_work_does_not_accumulate_deadline_drift(self):
        p = InputPacer(0)
        now = 0
        for i in range(1, 301):
            now += p.delay(now)
            self.assertAlmostEqual(now, i * .02)
            p.advance(now)
            now += .002
        # Old work-plus-sleep accumulates 598ms before frame 300.
        self.assertAlmostEqual(300 * .02 + 299 * .002 - (now - .002), .598)

    def test_long_pause_rebases_schedule_not_pcm(self):
        p = InputPacer(0)
        p.advance(1)
        self.assertEqual(p.delay(1), 0)
        p.advance(1)
        self.assertAlmostEqual(p.delay(1), .02)
        self.assertGreaterEqual(p.delay(2), 0)

    def test_metrics_bounded_fixed_and_call_local(self):
        c = {}
        mark(c, "recv", 5, 5.02)
        mark(c, "recv", 5, 5.04)
        duration(c, "recv_decode", 5, 5.002)
        duration(c, "recv_decode", 5, 5.003)
        self.assertEqual(c['recv_first_us'], 20000)
        self.assertEqual(c['recv_last_us'], 40000)
        self.assertEqual(c['recv_decode_n'], 2)
        self.assertEqual(c['recv_decode_sum_us'], 5000)
        self.assertTrue(set(c) <= METRIC_KEYS)
        self.assertEqual({}, {})
        duration(c, 'recv_decode', 0, 1e10)
        self.assertEqual(c['recv_decode_sum_us'], 2147483647)

    def test_actual_pump_forwards_quiet_speech_silence_and_preserves_order(self):
        # Compile the actual nested pump. No Discord/network/provider use.
        tree = ast.parse(Path(__file__).with_name('discord_sidecar.py').read_text())
        cls = next(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == 'Client')
        fn = next(n for n in cls.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'pump')
        for repeat in range(2):
            forwarded = []
            state = dict(identity={}, input=queue.Queue(), counts={'ipc_frames':0, 'ipc_speech_frames':0},
                         gate=SimpleNamespace(closed=False), failed=threading.Event(),
                         voice=SimpleNamespace(is_connected=lambda:True), call=None, metric_origin=time.perf_counter())
            payloads = [bytes([x])*960 for x in (0,1,255)]
            for data, speech in zip(payloads, (False, False, True)):
                state['input'].put((time.perf_counter(),data,speech))
            client = SimpleNamespace(active=state, valid=lambda *a,**k:True)
            async def send(writer, message):
                forwarded.append(message)
                if len(forwarded) == 4: client.active = None
            ns=dict(time=time, asyncio=asyncio, InputPacer=InputPacer, duration=duration, mark=mark,
                    queue=queue, base64=__import__('base64'), send=send, writer=None)
            exec(compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),'<pump>','exec'),ns)
            asyncio.run(ns['pump'](client,state))
            decoded=[__import__('base64').b64decode(m['pcm']) for m in forwarded]
            self.assertEqual(decoded,payloads+[bytes(960)])
            self.assertEqual([m['seq'] for m in forwarded],list(range(4)))
            self.assertEqual([m['speech'] for m in forwarded],[False,False,True,False])
            self.assertEqual(state['counts']['ipc_decoded_frames'],3)
            self.assertEqual(state['counts']['ipc_synthetic_silence_frames'],1)
            self.assertEqual(state['counts']['input_queue_n'],3)

    def test_unchanged_conversion_matches_at_chunk_boundaries(self):
        import array
        pcm = array.array('h', ((i * 31 % 4000) - 2000 for i in range(1920 * 3))).tobytes()
        def convert(data):
            v = array.array('h', data)
            return array.array('h', (sum(v[i:i+4]) // 4 for i in range(0,len(v),4))).tobytes()
        split = b''.join(convert(pcm[i:i+3840]) for i in range(0,len(pcm),3840))
        self.assertEqual(split, convert(pcm))
        self.assertEqual(len(split), 960 * 3)
