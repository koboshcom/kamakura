#!/bin/sh
# This Hako deployment only. Root hook, fail closed before allowing the bot to recreate boxes.
set -eu
cd /home/kit/kamakura
if ! docker info >/dev/null 2>&1; then
  dockerd >/tmp/kamakura-primary-dockerd.log 2>&1 &
  for attempt in $(seq 1 100); do docker info >/dev/null 2>&1 && break; sleep .2; done
  docker info >/dev/null
fi
sh deploy/reattach-remapped-work.sh
for owner in 6612253937 7853500388; do
  test -s "/var/lib/kamakura-loopback/migration-$owner.json"
done
if ! docker -H unix:///var/run/kamakura-root-docker.sock info >/dev/null 2>&1; then
  sh deploy/start-remapped-daemon.sh >/tmp/kamakura-root-dockerd-managed.log 2>&1 &
  for attempt in $(seq 1 100); do docker -H unix:///var/run/kamakura-root-docker.sock info >/dev/null 2>&1 && break; sleep .2; done
fi
docker -H unix:///var/run/kamakura-root-docker.sock info --format '{{json .SecurityOptions}}' | grep -q name=userns
# The sidecar config never writes global Docker chains. Create explicit rules after the primary bridge exists.
docker compose up -d --no-build core
sh deploy/remapped-network.sh
