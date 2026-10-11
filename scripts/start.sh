#!/usr/bin/env bash
set -euo pipefail
BASE=$(dirname "$(readlink -f "$0")")
source "$BASE/common.sh"
ENABLE=no TUNNEL=no PROVISION=no INITIAL=no
while (($#)); do
  case "$1" in
    --help|-h) echo 'Usage: sudo scripts/start.sh [--enable] [--tunnel] [--provision-standalone] [--initial-setup]'; exit 0;;
    --enable) ENABLE=yes;; --tunnel) TUNNEL=yes;; --provision-standalone) PROVISION=yes;; --initial-setup) INITIAL=yes;;
    *) fail "Unknown argument: $1";;
  esac
  shift
done
require_root; check_paths; lock_ops; managed; verify_source; verify_config; verify_units
MODE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).mode)' "$CONFIG/config.json")
PORT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$CONFIG/config.json")
if [[ $INITIAL == yes && $MODE == standalone ]]; then PROVISION=yes; fi
if [[ $PROVISION == yes && $MODE != standalone ]]; then fail '--provision-standalone requires standalone mode.'; fi
CONFIG_FILE="$CONFIG/config.json" /usr/bin/node "$APP/scripts/runtime-check.mjs"
if ! systemctl is-active --quiet "$BROKER_UNIT"; then
  # Broker pre-start performs integrity checks. No VM/phone creation here.
  systemctl start "$BROKER_UNIT"
fi
ready=no
for ((i=0;i<60;i++)); do
  if [[ -S /run/cloudphone-platform/broker.sock ]]; then ready=yes; break; fi
  systemctl is-active --quiet "$BROKER_UNIT" || fail 'Broker failed before socket readiness.'
  sleep 1
done
[[ $ready == yes ]] || fail 'Broker socket readiness timed out.'
systemctl start "$UNIT"
if [[ $TUNNEL == yes ]]; then
  systemctl start "$TUNNEL_UNIT"
  # ExecStartPost schedules this on every tunnel invocation (also after reboot).
  "$APP/scripts/sync-origin.sh" --ops-lock-held
fi
ready=no
for ((i=0;i<30;i++)); do
  if curl --fail --silent --output /dev/null --max-time 3 "http://127.0.0.1:$PORT/"; then ready=yes; break; fi
  sleep 1
done
[[ $ready == yes ]] || fail 'Web did not respond successfully; setup incomplete.'
ORIGIN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).publicOrigin)' "$WEB_CONFIG/config.json")
printf 'Dashboard: %s\nUsername: admin\n' "$ORIGIN"
# Never send secrets into redirected stdout, build logs or systemd journal.
if [[ $INITIAL == yes && ! -f "$CONFIG/.setup-complete" ]]; then
  if [[ -t 0 && -t 1 && -w /dev/tty && -f "$STATE/initial-admin-password" && ! -L "$STATE/initial-admin-password" ]]; then
    printf 'Initial admin password (save privately): ' >/dev/tty
    cat "$STATE/initial-admin-password" >/dev/tty
  else
    echo "Initial password saved root-only at $STATE/initial-admin-password; not printed to noninteractive logs."
  fi
fi
if [[ $PROVISION == yes ]]; then
  CONFIG_FILE="$CONFIG/config.json" /usr/bin/node "$APP/scripts/provision.mjs" || fail 'Dashboard is available, but standalone provisioning failed/blocked. Setup NOT complete; diagnose capabilities. No automatic mutation retries.'
else
  echo 'Dashboard ready. Phone create/start remain fail-closed until broker network/stream isolation checks pass.'
fi
if [[ $ENABLE == yes ]]; then
  systemctl enable "$BROKER_UNIT" "$UNIT"
  if [[ $TUNNEL == yes ]]; then systemctl enable "$TUNNEL_UNIT"; fi
fi
systemctl is-active --quiet "$BROKER_UNIT" "$UNIT" || fail 'Managed service stopped during startup.'
