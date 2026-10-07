#!/bin/sh
set -eu
# Operator-only image transfer to the dedicated remapped owner-box daemon.
# This does not run an agent on the shared host or modify owner workspaces.
cd "$(dirname "$0")/.."
IMAGE=${SANDBOX_IMAGE:-kamakura-sandbox:local}
docker image inspect "$IMAGE" >/dev/null
docker -H unix:///var/run/kamakura-root-docker.sock info --format '{{json .SecurityOptions}}' | grep -q name=userns
docker save "$IMAGE" | docker -H unix:///var/run/kamakura-root-docker.sock load
