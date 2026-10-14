#!/bin/sh
set -eu
# Resolve the checkout independently of the caller's working directory.
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec python3 -I "$root/deploy/update.py" "$@"
