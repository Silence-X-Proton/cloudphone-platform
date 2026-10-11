#!/usr/bin/env bash
set -euo pipefail
BASE=$(dirname "$(readlink -f "$0")")
source "$BASE/common.sh"
if [[ ${1:-} == --help ]]; then echo 'Usage: sudo scripts/sync-origin.sh (current managed tunnel only)'; exit 0; fi
require_root
if [[ ${1:-} == --ops-lock-held && $# == 1 ]]; then
  [[ $(readlink /proc/self/fd/9) == /run/lock/cloudphone-platform.lock ]] || fail 'Missing inherited operations lock.'
  flock -n 9 || fail 'Operations lock not held.'
else
  (($# == 0)) || fail 'Unknown arguments.'
  [[ ! -L /run/lock/cloudphone-platform.lock ]] || fail 'Unsafe operations lock.'
  exec 9>/run/lock/cloudphone-platform.lock
  flock -w 120 9 || fail 'Operations lock timed out.'
fi
check_paths; managed; verify_units; verify_config
[[ ! -L /run/lock/cloudphone-platform-origin.lock ]] || fail 'Unsafe origin lock.'
exec 8>/run/lock/cloudphone-platform-origin.lock
flock -w 120 8 || fail 'Another origin update is running.'
invocation=$(systemctl show "$TUNNEL_UNIT" -p InvocationID --value)
[[ $invocation =~ ^[a-f0-9]{32}$ ]] || fail 'No current tunnel invocation.'
URL=''
for ((attempt=0; attempt<60; attempt++)); do
  systemctl is-active --quiet "$TUNNEL_UNIT" || fail 'Tunnel stopped before origin discovery.'
  [[ $(systemctl show "$TUNNEL_UNIT" -p InvocationID --value) == "$invocation" ]] || fail 'Tunnel changed during discovery; new origin job must retry.'
  logs=$(journalctl --quiet --no-pager -o cat "_SYSTEMD_INVOCATION_ID=$invocation" -u "$TUNNEL_UNIT" -n 250)
  URL=$(printf '%s\n' "$logs" | grep -Eo 'https://[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com' | sort -u || true)
  if [[ -n $URL ]]; then break; fi
  sleep 2
done
[[ $URL =~ ^https://[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com$ ]] || fail 'Missing or ambiguous quick tunnel URL; no origin changed.'
changed=$(/usr/bin/node "$APP/scripts/web-config.mjs" "$URL" "$invocation")
if [[ $changed == changed ]]; then
  # Only this install's verified unprivileged web unit; never broker/live services.
  systemctl restart "$UNIT"
fi
systemctl is-active --quiet "$UNIT" || fail 'Web service did not start after origin update.'
[[ $(systemctl show "$TUNNEL_UNIT" -p InvocationID --value) == "$invocation" ]] || fail 'Tunnel changed; origin not current.'
echo "Current quick-tunnel origin configured: $URL"
