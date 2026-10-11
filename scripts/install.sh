#!/usr/bin/env bash
set -euo pipefail
export GIT_OPTIONAL_LOCKS=0
BASE=$(dirname "$(readlink -f "$0")")
source "$BASE/common.sh"
usage() {
  cat <<'HELP'
Usage: sudo scripts/install.sh [--mode dashboard|standalone] [--port 8790]
  [--source /path/to/clean/checkout | --repo-url https://HOST/OWNER/REPO.git --ref FULL_COMMIT_SHA]
  [--accept-android-sdk-license]
Prompts for mode and explicit Android SDK license consent when omitted.
Requires already-provisioned Ubuntu 22.04/24.04 x86_64, Node 22/24, KVM, loop and systemd.
Use bootstrap.sh for explicit-consent apt/Node setup. This installer starts the managed web/broker/tunnel after installing all shared artifacts.
Only install trusted source; root executes your application build scripts.
HELP
}
MODE='' PORT=8790 SOURCE=$(dirname "$BASE") REPO='' REF='' ACCEPT=no
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --mode|--port|--source|--repo-url|--ref)
      (($# >= 2)) || fail "Missing value: $1"
      case "$1" in --mode) MODE=$2;; --port) PORT=$2;; --source) SOURCE=$2;; --repo-url) REPO=$2;; --ref) REF=$2;; esac
      shift 2 ;;
    --accept-android-sdk-license) ACCEPT=yes; shift ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
require_root
check_paths
lock_ops
if [[ -z $MODE ]]; then
  [[ -t 0 ]] || fail 'Specify --mode dashboard|standalone in noninteractive mode.'
  read -r -p 'Installation mode [dashboard/standalone]: ' MODE
fi
node "$BASE/config.mjs" "$MODE" "$PORT" >/dev/null
if [[ -e $APP ]]; then
  managed
  verify_source
  [[ -f "$CONFIG/config.json" && ! -L "$CONFIG/config.json" ]] || fail 'Incomplete installation: config missing/unsafe; manual recovery required.'
  node "$BASE/config.mjs" "$MODE" "$PORT" | cmp -s - "$CONFIG/config.json" || fail 'Existing config differs; refusing automatic migration/overwrite.'
  [[ -f "$STATE/credentials.json" && -f "$SDK/SHA256SUMS" ]] || fail 'Incomplete installation; manual recovery required.'
  for unit in "$UNIT" "$BROKER_UNIT" "$TUNNEL_UNIT" "$ORIGIN_UNIT"; do cmp -s "$APP/deploy/$unit" "$UNIT_DIR/$unit" || fail "Existing unit differs: $unit"; done
  verify_sdk
  verify_config
  verify_units
  if [[ ! -f "$CONFIG/.setup-complete" ]]; then
    fail 'Initial setup previously failed. Data/credentials preserved. Inspect diagnostics, then explicitly run start.sh --tunnel (add --provision-standalone only after reconciling any unknown mutation). No automatic mutation retry.'
  else
    echo 'Existing completed installation preserved; no credentials/data/source edits or service restarts. Use start.sh for operations.'
  fi
  exit 0
fi
[[ ! -e $CONFIG ]] || fail 'Configuration already exists without managed app; refusing overwrite.'
[[ ! -e $WEB_CONFIG ]] || fail 'Web configuration exists without managed app; refusing overwrite.'
[[ ! -e $STATE ]] || fail 'State already exists without managed app; refusing overwrite. Explicit recovery required.'
for unit in "$UNIT" "$BROKER_UNIT" "$TUNNEL_UNIT" "$ORIGIN_UNIT"; do
  [[ ! -e "$UNIT_DIR/$unit" && ! -L "$UNIT_DIR/$unit" ]] || fail "Existing service unit: $unit"
  [[ $(systemctl show "$unit" -p LoadState --value) == not-found ]] || fail "Service name already in use: $unit"
done
if getent passwd cloudphone-web >/dev/null || getent group cloudphone-web >/dev/null; then fail 'Preexisting cloudphone-web identity; manual review required.'; fi
"$BASE/preflight.sh" "$MODE" "$PORT"
if [[ $ACCEPT != yes ]]; then
  [[ -t 0 ]] || fail 'Android SDK license requires --accept-android-sdk-license (explicit informed consent).'
  printf '%s\n' 'Review Android SDK terms: https://developer.android.com/studio/terms' 'Google APIs image terms are included in official SDK repository metadata.'
  read -r -p 'Type ACCEPT ANDROID SDK LICENSE to accept these terms: ' answer
  [[ $answer == 'ACCEPT ANDROID SDK LICENSE' ]] || fail 'License not accepted; no downloads/install performed.'
fi
# No target-tree edits occur before host/license checks. Staging is on target filesystem.
umask 077
STAGE=$(mktemp -d /opt/.cloudphone-install.XXXXXX)
trap 'rm -rf -- "$STAGE"' EXIT
mkdir "$STAGE/app" "$STAGE/sdk"
if [[ -n $REPO ]]; then
  [[ $REPO =~ ^https://[A-Za-z0-9.-]+/[A-Za-z0-9._/-]+(\.git)?$ && ! $REPO == *..* ]] || fail 'Use an HTTPS repository URL without credentials/query/fragment.'
  [[ $REF =~ ^[a-fA-F0-9]{40}$ ]] || fail '--repo-url requires --ref full reviewed 40-character commit SHA.'
  GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null clone --no-checkout -- "$REPO" "$STAGE/repo"
  SOURCE="$STAGE/repo"
else
  SOURCE=$(readlink -f "$SOURCE")
  [[ $SOURCE != /a0/usr/workdir/cloudphone && $SOURCE != /a0/usr/workdir/cloudphone/* ]] || fail 'Live deployment cannot be used as source.'
  [[ $(git -c safe.directory="$SOURCE" -C "$SOURCE" rev-parse --show-toplevel) == "$SOURCE" ]] || fail 'Source must be repository root.'
  [[ -z $(git -c safe.directory="$SOURCE" -C "$SOURCE" status --porcelain --untracked-files=normal) ]] || fail 'Source checkout has edits/untracked files; commit/review them first (installer never edits source).'
fi
COMMIT=$(git -c safe.directory="$SOURCE" -C "$SOURCE" rev-parse --verify "${REF:-HEAD}^{commit}")
# Reject source symlinks/submodules before archive extraction and any application execution.
[[ -z $(git -c safe.directory="$SOURCE" -C "$SOURCE" ls-tree -r "$COMMIT" | awk '$1 == "120000" || $1 == "160000"') ]] || fail 'Source symlinks/submodules are unsupported.'
git -c safe.directory="$SOURCE" -C "$SOURCE" archive "$COMMIT" | tar -x --no-same-owner -C "$STAGE/app"
for required in server.mjs lib/isolation.mjs lib/broker.mjs lib/broker-client.mjs scripts/credentials.mjs scripts/provision.mjs scripts/cleanup.mjs scripts/run-service.sh package.json package-lock.json deploy/cloudphone-platform.service deploy/cloudphone-platform-broker.service deploy/cloudphone-platform-tunnel.service deploy/cloudphone-platform-origin.service; do
  [[ -f "$STAGE/app/$required" ]] || fail "Application interface incomplete: $required"
done
node "$BASE/config.mjs" lock "$STAGE/app/package.json" "$STAGE/app/package-lock.json"
(cd "$STAGE/app"; npm ci --ignore-scripts --no-audit --no-fund --cache "$STAGE/npm-cache"; npm run build --if-present)
chown -R root:root "$STAGE/app"
chmod -R go-w "$STAGE/app"
chmod -R a+rX "$STAGE/app"
if [[ -e $SDK ]]; then
  verify_sdk
else
  "$BASE/download.sh" "$STAGE/sdk" --android-sdk-license-accepted
  chown -R root:root "$STAGE/sdk"
  chmod -R a-w "$STAGE/sdk"
  chmod -R a+rX "$STAGE/sdk"
  if [[ ! -d $(dirname "$SDK") ]]; then mkdir -m 0755 "$(dirname "$SDK")"; fi
  [[ $(stat -c %a "$(dirname "$SDK")") == 755 ]] || fail 'SDK parent must already be mode 0755 for per-phone/tunnel traversal.'
  mv -T "$STAGE/sdk" "$SDK"
fi
# The backend uses this empty host bind target; never replace unrelated contents.
if [[ -e /srv/cloudphone ]]; then
  [[ -d /srv/cloudphone && -z $(find /srv/cloudphone -mindepth 1 -print -quit) ]] || fail '/srv/cloudphone must be an empty root-owned bind target.'
else
  mkdir -m 0755 /srv/cloudphone
fi
"$BASE/web-user.sh"
mkdir -m 0700 "$STATE" "$CONFIG"
mkdir -m 0755 "$WEB_CONFIG"
printf '%s:%s\n' "$(id -u cloudphone-web)" "$(id -g cloudphone-web)" > "$CONFIG/.web-identity"
node "$BASE/config.mjs" "$MODE" "$PORT" > "$CONFIG/config.json"
printf 'PORT=%s\n' "$PORT" > "$WEB_CONFIG/tunnel.env"
chmod 0644 "$WEB_CONFIG/tunnel.env"
node "$BASE/web-config.mjs" >/dev/null
printf 'ANDROID_SDK_LICENSE_ACCEPTED=yes\naccepted_at=%s\n' "$(date -u +%FT%TZ)" > "$CONFIG/license-acceptance"
printf '{"schemaVersion":2,"commit":"%s","mode":"%s","port":%s}\n' "$COMMIT" "$MODE" "$PORT" > "$STAGE/app/.cloudphone-install.json"
STATE_DIR="$STATE" node "$STAGE/app/scripts/credentials.mjs" init
mv -T "$STAGE/app" "$APP"
for unit in "$UNIT" "$BROKER_UNIT" "$TUNNEL_UNIT" "$ORIGIN_UNIT"; do install -m 0644 "$APP/deploy/$unit" "$UNIT_DIR/$unit"; done
systemctl daemon-reload
# Release operations lock before invoking independently locked start.
flock -u 9; exec 9>&-
"$APP/scripts/start.sh" --tunnel --initial-setup
(umask 077; set -o noclobber; printf '%s\n' complete > "$CONFIG/.setup-complete")
echo 'Initial setup completed. Services started, not enabled for reboot; use start.sh --enable --tunnel after review.'
