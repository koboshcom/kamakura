#!/bin/sh
# Run as root before core starts. Never starts or restarts Docker.
set -eu
export SANDBOX_ROOT=/var/lib/kamakura-work
export SANDBOX_INSTANCE=remapped
export SANDBOX_ALLOWED_USERS=6612253937,7853500388
export SANDBOX_DISK=35G
export SANDBOX_HOST_UID=201000 SANDBOX_HOST_GID=201000 SANDBOX_ROOT_MODE=755
PYTHON=${KAMAKURA_HOST_PYTHON:-/opt/hako/bin/python3}
exec "$PYTHON" "$(dirname "$0")/provision-sandbox-volumes.py"
