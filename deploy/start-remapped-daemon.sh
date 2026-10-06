#!/bin/sh
# Operator-managed dedicated daemon. Primary Docker is never reconfigured.
set -eu
[ "$(id -u)" = 0 ] || exit 1
CONFIG=${KAMAKURA_REMAPPED_CONFIG:-/etc/kamakura/remapped-daemon.json}
SOCKET=/var/run/kamakura-root-docker.sock
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
