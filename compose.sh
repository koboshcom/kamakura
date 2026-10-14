#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$root"
# Advanced service injection and host interpolation are different Compose stages.
# Optional earlier file supplies defaults; normal .env and shell take precedence.
if [ -f .env.advanced ]; then
 exec docker compose --env-file .env.advanced --env-file .env "$@"
fi
exec docker compose --env-file .env "$@"
