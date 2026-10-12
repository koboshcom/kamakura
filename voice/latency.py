"""Bounded content-free per-call monotonic metrics and drift-free input pacing."""
import time

STAGES = ("recv", "decode", "resample", "input_send", "output_receive", "discord_write", "speech_end")
DURATIONS = ("recv_decode", "resample", "input_queue", "ipc_send", "output_queue", "discord_send")
METRIC_KEYS = frozenset(
    [f"{stage}_{edge}_us" for stage in STAGES for edge in ("first", "last")]
    + [f"{stage}_{suffix}" for stage in DURATIONS for suffix in ("n", "sum_us", "max_us")]
)

def mark(counts, stage, origin, now=None):
    now = time.perf_counter() if now is None else now
    value = min(2147483647, max(0, round((now - origin) * 1_000_000)))
    counts.setdefault(stage + "_first_us", value)
    counts[stage + "_last_us"] = value

def duration(counts, stage, start, end=None):
    end = time.perf_counter() if end is None else end
    value = min(2147483647, max(0, round((end - start) * 1_000_000)))
    for suffix, number in (("n", counts.get(stage + "_n", 0) + 1),
                           ("sum_us", counts.get(stage + "_sum_us", 0) + value),
                           ("max_us", max(counts.get(stage + "_max_us", 0), value))):
        counts[stage + "_" + suffix] = min(2147483647, number)

class InputPacer:
    """One frame per deadline, not per work-plus-sleep interval. No PCM skipping."""
    def __init__(self, now):
        self.next = now + .02

    def delay(self, now):
        return max(0, self.next - now)

    def advance(self, now):
        # Only the schedule rebases after a long pause; queued PCM is never skipped.
        self.next = max(self.next + .02, now)
