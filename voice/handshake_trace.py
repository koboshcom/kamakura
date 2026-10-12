"""Content-free wrappers around the exact pinned library's existing await methods."""
import asyncio
import time
import contextvars

STEPS = frozenset((
    "voice_state_update", "voice_server_update", "voice_ws_connect",
    "hello", "identify", "ready", "udp_connect", "udp_discovery",
    "select_protocol", "session_description", "video_receive",
    "dave_prepare_transition", "dave_execute_transition", "dave_prepare_epoch",
    "mls_external_sender", "mls_proposals", "mls_commit", "mls_welcome",
    "mls_key_package", "mls_commit_welcome", "dave_transition_ready",
    "voice_state_request", "wait_voice_updates", "handshake_poll",
    "whole_connect", "partial_cleanup", "dave_reinit", "dave_execute", "mls_recovery",
))


async def bounded_connect(connect, departed, timeout=10):
    """A single deadline covers the whole library call and its extra awaits."""
    task = asyncio.create_task(connect())
    left = asyncio.create_task(departed.wait())
    try:
        done, _ = await asyncio.wait((task, left), timeout=timeout,
                                     return_when=asyncio.FIRST_COMPLETED)
        if left in done:
            raise ValueError("Caller left during connect")
        if task not in done:
            raise TimeoutError("Whole connect deadline")
        return await task
    finally:
        for pending in (task, left):
            if not pending.done():
                pending.cancel()
        # Cancellation itself may invoke library disconnect awaits. Bound it too.
        pending = [t for t in (task, left) if not t.done()]
        if pending:
            _, unfinished = await asyncio.wait(pending, timeout=3)
            if unfinished:
                for unfinished_task in unfinished:
                    unfinished_task.add_done_callback(lambda t: None if t.cancelled() else t.exception())
                raise RuntimeError("Connect cancellation incomplete")
        for finished in (task, left):
            if finished.done() and not finished.cancelled():
                finished.exception()


def traced_voice_class(base, emit):
    from discord.ext.native_voice.client import _VoiceWebSocket
    from discord.voice_state import ConnectionFlowState
    from discord.utils import MISSING

    async def run(step, action, counters=None):
        emit(step, "start", counters or {})
        start = time.monotonic()
        try:
            result = await action()
        except BaseException as error:
            emit(step, "cancelled" if isinstance(error, asyncio.CancelledError) else "error",
                 {"elapsed_ms": int((time.monotonic()-start)*1000)}, error)
            raise
        emit(step, "done", {"elapsed_ms": int((time.monotonic()-start)*1000)})
        return result

    class WS(_VoiceWebSocket):
        async def identify(self):
            return await run("identify", lambda: super(WS, self).identify())

        async def _connect_udp_socket(self):
            return await run("udp_connect", lambda: super(WS, self)._connect_udp_socket())

        async def discover_ip(self):
            # No actual IP or port emitted, just whether discovery returns values.
            result = await run("udp_discovery", lambda: super(WS, self).discover_ip())
            emit("udp_discovery", "observed",
                 {"ip_present": int(bool(result[0])), "port_present": int(bool(result[1]))})
            return result

        async def select_protocol(self, ip, port, mode):
            return await run("select_protocol",
                             lambda: super(WS, self).select_protocol(ip, port, mode),
                             mode_counts(mode))

        async def received_message(self, message):
            op = message.get("op")
            data = message.get("d")
            data = data if isinstance(data, dict) else {}
            names = {self.HELLO: "hello", self.READY: "ready",
                     self.SESSION_DESCRIPTION: "session_description",
                     self.DAVE_PREPARE_TRANSITION: "dave_prepare_transition",
                     self.DAVE_EXECUTE_TRANSITION: "dave_execute_transition",
                     self.DAVE_PREPARE_EPOCH: "dave_prepare_epoch"}
            step = names.get(op)
            counters = {}
            if step == "ready":
                modes = data.get("modes", ())
                counters = {"ip_present": int(bool(data.get("ip"))),
                            "port_present": int(bool(data.get("port"))),
                            "aes_offered": int("aead_aes256_gcm_rtpsize" in modes),
                            "xchacha_offered": int("aead_xchacha20_poly1305_rtpsize" in modes)}
            if step in ("session_description", "dave_prepare_transition", "dave_prepare_epoch"):
                version = data.get("dave_protocol_version", data.get("protocol_version"))
                if isinstance(version, int) and 0 <= version <= 65535:
                    counters["dave_version"] = version
            if step == "session_description":
                counters.update(mode_counts(data.get("mode")))
            action = lambda: super(WS, self).received_message(message)
            return await run(step, action, counters) if step else await action()

        async def received_binary_message(self, message):
            op = message[2] if len(message) >= 3 else None
            names = {self.MLS_EXTERNAL_SENDER: "mls_external_sender",
                     self.MLS_PROPOSALS: "mls_proposals",
                     self.MLS_ANNOUNCE_COMMIT_TRANSITION: "mls_commit",
                     self.MLS_WELCOME: "mls_welcome"}
            step = names.get(op)
            action = lambda: super(WS, self).received_binary_message(message)
            # 'done' means the library handler returned; swallowed MLS recovery
            # is not falsely reported as successful cryptographic validation.
            result = await run(step, action, {"bytes": len(message)}) if step else await action()
            if step:
                session = self._connection.dave_session
                emit(step, "handler_returned", {"dave_present": int(session is not None),
                                               "dave_ready": int(bool(session and session.ready))})
            return result

        async def send_binary(self, opcode, data):
            names = {self.MLS_KEY_PACKAGE: "mls_key_package",
                     self.MLS_COMMIT_WELCOME: "mls_commit_welcome"}
            action = lambda: super(WS, self).send_binary(opcode, data)
            step = names.get(opcode)
            return await run(step, action, {"bytes": len(data)}) if step else await action()

        async def send_transition_ready(self, transition_id):
            # Do not emit transition IDs.
            return await run("dave_transition_ready",
                             lambda: super(WS, self).send_transition_ready(transition_id))

    class Traced(base):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            state = self._connection
            call_context = contextvars.copy_context()
            # Same exact native factory; only its websocket subclass adds wrappers.
            async def websocket(resume):
                async def create():
                    seq_ack = -1 if state.ws is MISSING else state.ws.seq_ack
                    ws = await WS.from_connection_state(state, resume=resume,
                                                       hook=state.hook, seq_ack=seq_ack)
                    state.state = ConnectionFlowState.websocket_connected
                    return ws
                return await run("voice_ws_connect", create,
                                 {"endpoint_present": int(bool(state.endpoint))})
            state._connect_websocket = websocket
            for method, step in (
                ("voice_state_update", "voice_state_update"),
                ("voice_server_update", "voice_server_update"),
                ("_voice_connect", "voice_state_request"),
                ("_wait_for_state", "wait_voice_updates"),
                ("_handshake_websocket", "handshake_poll"),
                ("reinit_dave_session", "dave_reinit"),
                ("_execute_transition", "dave_execute"),
                ("_recover_from_invalid_commit", "mls_recovery"),
            ):
                original = getattr(state, method)
                async def wrapped(*args, _original=original, _step=step, **kwargs):
                    counts = {}
                    if _step == "voice_server_update" and args:
                        counts["endpoint_present"] = int(bool(args[0].get("endpoint")))
                    return await asyncio.create_task(
                        run(_step, lambda: _original(*args, **kwargs), counts),
                        context=call_context.copy())
                setattr(state, method, wrapped)

        async def enable_video_receive(self):
            return await run("video_receive", lambda: super(Traced, self).enable_video_receive())

    return Traced


def mode_counts(mode):
    return {"aes_chosen": int(mode == "aead_aes256_gcm_rtpsize"),
            "xchacha_chosen": int(mode == "aead_xchacha20_poly1305_rtpsize")}
