#!/bin/sh
# Optional isolated install. Never install a generic discord.py package here.
set -eu
target="${1:-/app/voice-venv}"
python3 -m venv "$target"
"$target/bin/python" -m pip install 'discord.py-self[voice] @ git+https://github.com/dolfies/discord.py-self@2ba64a9a997e151a9c259984e0a179b1fdf4aff4' 'davey==0.1.6'
# Owner-approved prerelease metadata mismatch. Binary native extension, no Rust.
"$target/bin/python" -m pip install --only-binary=:all: --no-deps 'discord-native-voice==0.1.1'
"$target/bin/python" - <<'PY'
from importlib.metadata import version
import discord
import davey
from discord.ext.native_voice import VoiceClient, MediaSink
assert version("discord.py-self") == "2.2.0a5340+g2ba64a9a"
assert version("discord-native-voice") == "0.1.1"
assert version("davey") == "0.1.6"
assert discord.__version__ == "2.2.0a"
assert callable(discord.DMChannel.connect) and callable(VoiceClient.listen)
assert callable(davey.DaveSession.decrypt)
print("Pinned imports pass; not a live receive/DAVE test.")
PY
# Do not hide unrelated dependency errors or claim a green pip check.
"$target/bin/python" - <<'PY'
import subprocess
import sys
result = subprocess.run([sys.executable, "-m", "pip", "check"], text=True, capture_output=True)
text = result.stdout.strip().lower().replace("discord.py-self", "discord-py-self")
print(result.stdout, end="")
expected = "discord-native-voice 0.1.1 has requirement discord-py-self>=2.2.0, but you have discord-py-self 2.2.0a5340+g2ba64a9a."
if result.returncode != 1 or text != expected:
    print(result.stderr, file=sys.stderr)
    raise SystemExit("Unexpected dependency check result. Review before enabling.")
print("Known owner-waived prerelease mismatch remains, pip check is NOT green.")
PY
