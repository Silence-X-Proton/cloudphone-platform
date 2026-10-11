#!/usr/bin/env bash
set -euo pipefail
BASE=$(dirname "$(readlink -f "$0")")
source "$BASE/common.sh"
[[ ${1:-} == --check-broker && $# == 1 ]] || fail 'Internal broker pre-start validation only.'
require_root; check_paths; managed; verify_source; verify_config; verify_sdk
[[ ${CONFIG_FILE:-} == "$CONFIG/config.json" ]] || fail 'Unsafe broker config path.'
