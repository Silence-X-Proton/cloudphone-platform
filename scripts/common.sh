#!/usr/bin/env bash
# Fixed paths intentionally cannot target the independent live deployment.
set -euo pipefail
readonly APP=/opt/cloudphone-platform
readonly SDK=/opt/cloudphone-sdk/api36-v1
readonly STATE=/var/lib/cloudphone-platform
readonly CONFIG=/etc/cloudphone-platform
readonly UNIT=cloudphone-platform.service
readonly WEB_CONFIG=/etc/cloudphone-platform-web
readonly BROKER_UNIT=cloudphone-platform-broker.service
readonly ORIGIN_UNIT=cloudphone-platform-origin.service
readonly TUNNEL_UNIT=cloudphone-platform-tunnel.service
readonly UNIT_DIR=/etc/systemd/system
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require_root() { [[ $EUID == 0 ]] || fail 'Run this operation with sudo.'; }
check_paths() {
  local path parent
  for path in "$APP" "$SDK" "$STATE" "$CONFIG" "$WEB_CONFIG" "$UNIT_DIR" /srv/cloudphone; do
    parent="$path"
    while [[ "$parent" != / ]]; do
      [[ ! -L "$parent" ]] || fail "Refusing symlink path: $parent"
      if [[ -e "$parent" ]]; then
        [[ $(stat -c %u "$parent") == 0 ]] || fail "Path must be root-owned: $parent"
        [[ -z $(find "$parent" -maxdepth 0 -perm /022 -print) ]] || fail "Path writable by other users: $parent"
      fi
      parent=$(dirname "$parent")
    done
  done
}
managed() {
  [[ -f "$APP/.cloudphone-install.json" && ! -L "$APP/.cloudphone-install.json" ]] || fail 'Not an installer-owned deployment.'
  [[ $(stat -c %u "$APP/.cloudphone-install.json") == 0 ]] || fail 'Untrusted deployment marker.'
}
lock_ops() {
  [[ ! -L /run/lock/cloudphone-platform.lock ]] || fail 'Unsafe lock path.'
  exec 9>/run/lock/cloudphone-platform.lock
  flock -n 9 || fail 'Another cloudphone deployment operation is running.'
}
verify_source() { python3 "$BASE/validate-install.py" source "$APP"; }
verify_sdk() { python3 "$BASE/validate-install.py" sdk "$SDK"; }
verify_config() { python3 "$BASE/validate-install.py" config; }
verify_units() {
  local unit
  for unit in "$UNIT" "$BROKER_UNIT" "$TUNNEL_UNIT" "$ORIGIN_UNIT"; do
    [[ -f "$UNIT_DIR/$unit" && ! -L "$UNIT_DIR/$unit" ]] || fail "Unsafe/missing unit: $unit"
    cmp -s "$APP/deploy/$unit" "$UNIT_DIR/$unit" || fail "Locally changed unit: $unit"
    [[ $(systemctl show "$unit" -p FragmentPath --value) == "$UNIT_DIR/$unit" ]] || fail "Unexpected loaded unit path: $unit"
    [[ -z $(systemctl show "$unit" -p DropInPaths --value) ]] || fail "Unreviewed unit overrides: $unit"
  done
}
