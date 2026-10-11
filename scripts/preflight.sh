#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == --help ]]; then
  echo 'Usage: sudo scripts/preflight.sh [dashboard|standalone] [port=8790] (read-only host checks)'
  exit 0
fi
exec python3 "$(dirname "$(readlink -f "$0")")/preflight.py" "${1:-dashboard}" "${2:-8790}"
