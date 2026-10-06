#!/bin/bash
set -euo pipefail
export DISPLAY=:99
export XDG_RUNTIME_DIR=/tmp/runtime-kamakura
export XDG_CONFIG_HOME=/work/.config
export XDG_CACHE_HOME=/work/.cache
export XDG_CURRENT_DESKTOP=XFCE
export XDG_SESSION_TYPE=x11
export XAUTHORITY=/tmp/kamakura.Xauthority
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
# Remove only stale Chromium singleton metadata, never profile contents.
python3 - <<'PY'
import os
from pathlib import Path
profile = Path('/work/.chromium')
if profile.is_symlink():
    raise SystemExit('Chromium profile must not be a symlink')
for name in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
    try:
        os.unlink(profile / name)
    except FileNotFoundError:
        pass
PY
touch "$XAUTHORITY"
xauth add "$DISPLAY" MIT-MAGIC-COOKIE-1 "$(mcookie)"
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -auth "$XAUTHORITY" &
xpid=$!
trap 'kill "$xpid" 2>/dev/null || true' EXIT
for i in {1..100}; do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$xpid" 2>/dev/null; then exit 1; fi
  sleep 0.1
done
exec dbus-run-session -- bash -c '
  xfce4-session &
  desktop=$!
  /opt/desktop-venv/bin/python /opt/kamakura/desktop-worker.py &
  worker=$!
  # Internal-only access. No host ports are published; core authenticates links.
  x11vnc -display "$DISPLAY" -auth "$XAUTHORITY" -rfbport 5900 -localhost -forever -shared -nopw -quiet >/tmp/kamakura-vnc.log 2>&1 &
  vnc=$!
  test -n "${KAMAKURA_DESKTOP_PASSWORD:-}" || exit 1
  websockify --web=/usr/share/novnc --web-auth --auth-plugin=BasicHTTPAuth --auth-source="kamakura:$KAMAKURA_DESKTOP_PASSWORD" 6080 127.0.0.1:5900 >/tmp/kamakura-websockify.log 2>&1 &
  proxy=$!
  pids="$desktop $worker $vnc $proxy"
  trap "kill $pids 2>/dev/null || true" EXIT TERM INT
  wait -n $pids
'
