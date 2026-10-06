#!/bin/bash
set -euo pipefail
export DISPLAY=:99
export XDG_RUNTIME_DIR=/tmp/runtime-kamakura
export XDG_CONFIG_HOME=/workspace/.config
export XDG_CACHE_HOME=/workspace/.cache
export XDG_CURRENT_DESKTOP=XFCE
export XDG_SESSION_TYPE=x11
export XAUTHORITY=/tmp/kamakura.Xauthority
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
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
# Keep the one-time auth key out of desktop process environments and command lines.
if [ -n "${KAMAKURA_TAILSCALE_AUTH_KEY:-}" ]; then
  umask 077
  printf '%s' "$KAMAKURA_TAILSCALE_AUTH_KEY" >/tmp/kamakura-tail-auth
  unset KAMAKURA_TAILSCALE_AUTH_KEY
fi
# Keep D-Bus, desktop and worker under this shell. Docker init reaps subprocesses.
exec dbus-run-session -- bash -c '
  xfce4-session &
  desktop=$!
  /opt/desktop-venv/bin/python /opt/kamakura/desktop-worker.py &
  worker=$!
  pids="$desktop $worker"
  if [ "${KAMAKURA_TAILSCALE:-false}" = true ]; then
    mkdir -p /workspace/.tailscale
    chmod 700 /workspace/.tailscale
    tailscaled --tun=userspace-networking \
      --socket=/tmp/kamakura-tailscale.sock \
      --state=/workspace/.tailscale/tailscaled.state \
      --statedir=/workspace/.tailscale \
      --socks5-server=127.0.0.1:1055 >/tmp/kamakura-tailscaled.log 2>&1 &
    pids="$pids $!"
    # Enroll on first boot only; persisted node state avoids reusing one-time keys.
    (
      for i in {1..100}; do
        if [ -S /tmp/kamakura-tailscale.sock ]; then break; fi
        sleep 0.1
      done
      if [ -f /tmp/kamakura-tail-auth ]; then
        if ! tailscale --socket=/tmp/kamakura-tailscale.sock status --json 2>/dev/null | python3 -c '\''import json,sys; sys.exit(json.load(sys.stdin).get("BackendState") != "Running")'\''; then
          timeout 30s tailscale --socket=/tmp/kamakura-tailscale.sock up --auth-key=file:/tmp/kamakura-tail-auth >/tmp/kamakura-tail-enroll.log 2>&1 || true
        fi
        rm -f /tmp/kamakura-tail-auth
      fi
    ) &
  fi
  trap "kill $pids 2>/dev/null || true" EXIT TERM INT
  wait -n $pids
'
