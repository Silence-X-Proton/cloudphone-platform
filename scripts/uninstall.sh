#!/usr/bin/env bash
set -euo pipefail
BASE=$(dirname "$(readlink -f "$0")")
source "$BASE/common.sh"
REMOVE=no YES=no
while (($#)); do
  case "$1" in
    --help|-h) echo 'Usage: sudo scripts/uninstall.sh [--yes] [--remove-data]'; echo 'SDK always retained. Credentials/config/phone data preserved unless --remove-data.'; exit 0;;
    --yes) YES=yes;; --remove-data) REMOVE=yes;; *) fail "Unknown argument: $1";;
  esac
  shift
done
require_root; check_paths; lock_ops; managed
verify_source
verify_units
# Never remove units that another operator has replaced.
for unit in "$UNIT" "$BROKER_UNIT" "$TUNNEL_UNIT" "$ORIGIN_UNIT"; do
  [[ ! -L "$UNIT_DIR/$unit" ]] || fail "Refusing symlink unit: $unit"
  if [[ -e "$UNIT_DIR/$unit" ]]; then cmp -s "$APP/deploy/$unit" "$UNIT_DIR/$unit" || fail "Unit has local edits; review manually: $unit"; fi
done
if [[ $YES != yes ]]; then
  [[ -t 0 ]] || fail 'Use --yes after reviewing fixed removal paths.'
  printf 'Remove application/units at %s? Data removal=%s; shared SDK retained.\n' "$APP" "$REMOVE"
  read -r -p 'Type UNINSTALL: ' answer
  [[ $answer == UNINSTALL ]] || fail 'Cancelled.'
fi
systemctl stop "$ORIGIN_UNIT" "$TUNNEL_UNIT" "$UNIT" "$BROKER_UNIT"
CONFIG_FILE="$CONFIG/config.json" /usr/bin/node "$APP/scripts/cleanup.mjs"
systemctl disable "$TUNNEL_UNIT" "$UNIT" "$BROKER_UNIT"
for unit in "$ORIGIN_UNIT" "$TUNNEL_UNIT" "$UNIT" "$BROKER_UNIT"; do
  state=$(systemctl show "$unit" --property=ActiveState --value)
  [[ $state == inactive || $state == failed ]] || fail "Unit not stopped: $unit"
done
# Refuse mounted descendants, bind mounts, or active loop-backed phone disks. Never detach an unknown device.
python3 - "$APP" "$STATE" "$CONFIG" "$WEB_CONFIG" <<'PY'
import json, subprocess, sys
from pathlib import Path
roots = [Path(p) for p in sys.argv[1:]]
for line in Path('/proc/self/mountinfo').read_text().splitlines():
    raw = line.split()[4]
    mount = Path(raw.replace('\\040', ' ').replace('\\011', '\t').replace('\\134', '\\'))
    if any(mount == root or root in mount.parents for root in roots):
        sys.exit('Mounted deployment path remains; backend cleanup required: ' + str(mount))
result = subprocess.run(['losetup', '--json', '--list', '--output', 'BACK-FILE'], check=True, capture_output=True, text=True)
for loop in json.loads(result.stdout).get('loopdevices', []):
    backing = Path(loop.get('back-file') or '/')
    if any(backing == root or root in backing.parents for root in roots):
        sys.exit('Loop device still attached to deployment data; backend cleanup required')
PY
for unit in "$UNIT" "$BROKER_UNIT" "$TUNNEL_UNIT" "$ORIGIN_UNIT"; do rm -f -- "$UNIT_DIR/$unit"; done
systemctl daemon-reload
if [[ $REMOVE == yes ]]; then "$APP/scripts/remove-web-user.sh"; fi
rm -rf --one-file-system -- "$APP"
if [[ $REMOVE == yes ]]; then
  rm -rf --one-file-system -- "$STATE" "$CONFIG" "$WEB_CONFIG"
  echo 'Explicitly removed this deployment data/config/credentials.'
else
  echo 'Data/config/credentials retained. Reinstall intentionally refuses retained state until explicit operator recovery.'
fi
echo 'Shared SDK retained at /opt/cloudphone-sdk/api36-v1. Independent /a0/usr/workdir/cloudphone was not touched.'
