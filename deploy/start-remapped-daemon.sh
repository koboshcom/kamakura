#!/bin/sh
# Operator-managed dedicated daemon. Primary Docker is never reconfigured.
set -eu
[ "$(id -u)" = 0 ] || exit 1
CONFIG=${KAMAKURA_REMAPPED_CONFIG:-/etc/kamakura/remapped-daemon.json}
SOCKET=${KAMAKURA_REMAPPED_SOCKET:-/var/run/kamakura-root-docker.sock}
PYTHON=${KAMAKURA_HOST_PYTHON:-/opt/hako/bin/python3}
# Mandatory even when daemon already runs. Never fall back to an unmounted host directory.
"$PYTHON" "$(dirname "$0")/remapped-storage.py" validate --socket "$SOCKET" --config "$CONFIG" --manifest "${KAMAKURA_REMAPPED_STORAGE_MANIFEST:-/etc/kamakura/remapped-storage.json}"
if docker -H "unix://$SOCKET" info >/dev/null 2>&1; then
  docker -H "unix://$SOCKET" info --format '{{json .SecurityOptions}}' | grep -q 'name=userns' || exit 1
  exit 0
fi
[ -f "$CONFIG" ] || { echo 'Provision operator remapped daemon config first' >&2; exit 1; }
ip link show kroot0 >/dev/null 2>&1 || ip link add kroot0 type bridge
ip address show dev kroot0 | grep -q '172.29.0.1/24' || ip address add 172.29.0.1/24 dev kroot0
ip link set kroot0 up
# This startup script runs in the background from the host boot hook.
exec dockerd --config-file "$CONFIG"
