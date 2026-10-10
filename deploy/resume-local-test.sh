#!/bin/sh
# This Hako deployment only. Root hook, fail closed before allowing the bot to recreate boxes.
set -eu
cd /home/kit/kamakura
export SANDBOX_ROOT=/var/lib/kamakura-work SANDBOX_INSTANCE=remapped
export SANDBOX_USERNS_ROOT=true SANDBOX_ROOTFS_MODE=writable
export SANDBOX_ROOTFS_SIZE=${SANDBOX_ROOTFS_SIZE:-8G}
export SANDBOX_NETWORK_NAME=${SANDBOX_NETWORK_NAME:-kamakura-remapped-sandboxes}
export SANDBOX_NETWORK_BRIDGE=${SANDBOX_NETWORK_BRIDGE:-$("${KAMAKURA_HOST_PYTHON:-/opt/hako/bin/python3}" -c 'import hashlib,sys; print("ks"+hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$SANDBOX_NETWORK_NAME")}
export DOCKER_SOCKET_PATH=${KAMAKURA_REMAPPED_SOCKET:-/var/run/kamakura-root-docker.sock}
export SANDBOX_DOCKER_SOCKET=$DOCKER_SOCKET_PATH
# Block IPv4/IPv6 on the dedicated bridge BEFORE any daemon/core restore.
sh deploy/remapped-network.sh --guard-only
# Storage must already be mounted by the operator's boot mount unit. Refuse unsafe fallback.
"${KAMAKURA_HOST_PYTHON:-/opt/hako/bin/python3}" deploy/remapped-storage.py validate --socket "$DOCKER_SOCKET_PATH" --config "${KAMAKURA_REMAPPED_CONFIG:-/etc/kamakura/remapped-daemon.json}" --manifest "${KAMAKURA_REMAPPED_STORAGE_MANIFEST:-/etc/kamakura/remapped-storage.json}"
if ! docker info >/dev/null 2>&1; then
  dockerd >/tmp/kamakura-primary-dockerd.log 2>&1 &
  for attempt in $(seq 1 100); do docker info >/dev/null 2>&1 && break; sleep .2; done
  docker info >/dev/null
fi
sh deploy/reattach-remapped-work.sh
for owner in 6612253937 7853500388; do
  test -s "/var/lib/kamakura-loopback/migration-$owner.json"
done
if ! docker -H "unix://$DOCKER_SOCKET_PATH" info >/dev/null 2>&1; then
  sh deploy/start-remapped-daemon.sh >/tmp/kamakura-root-dockerd-managed.log 2>&1 &
  for attempt in $(seq 1 100); do docker -H "unix://$DOCKER_SOCKET_PATH" info >/dev/null 2>&1 && break; sleep .2; done
fi
docker -H "unix://$DOCKER_SOCKET_PATH" info --format '{{json .SecurityOptions}}' | grep -q name=userns
# The sidecar config never writes global Docker chains. Create explicit rules after the primary bridge exists.
docker compose up -d --no-build core
sh deploy/remapped-network.sh
