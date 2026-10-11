#!/usr/bin/env bash
set -euo pipefail
BASE=$(dirname "$(readlink -f "$0")")
source "$BASE/common.sh"
if [[ ${1:-} == --help ]]; then echo 'Usage: sudo scripts/stop.sh (stops only this deployment; preserves data)'; exit 0; fi
(($# == 0)) || fail 'Unknown arguments.'
require_root; check_paths; lock_ops; managed
verify_source
verify_units
systemctl stop "$ORIGIN_UNIT" "$TUNNEL_UNIT" "$UNIT" "$BROKER_UNIT"
CONFIG_FILE="$CONFIG/config.json" /usr/bin/node "$APP/scripts/cleanup.mjs"
echo 'Stopped only cloudphone-platform units; data preserved.'
