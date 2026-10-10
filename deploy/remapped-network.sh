#!/bin/sh
# Parameterized root-only policy installer, never invoked by the bot itself.
set -eu
exec "${KAMAKURA_HOST_PYTHON:-python3}" "$(dirname "$0")/remapped-network.py" "$@"
