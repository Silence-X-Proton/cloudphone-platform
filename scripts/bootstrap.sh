#!/usr/bin/env bash
# Standalone entry point: safe to download alone; never assumes local source.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly REPO=https://github.com/Silence-X-Proton/cloudphone-platform.git
readonly API=https://api.github.com/repos/Silence-X-Proton/cloudphone-platform
readonly RAW=https://raw.githubusercontent.com/Silence-X-Proton/cloudphone-platform
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: sudo bash bootstrap.sh [--ref FULL_COMMIT_SHA] [--accept-host-changes]
  [--mode dashboard|standalone] [--port 8790] [--accept-android-sdk-license]
Downloads the actual public Silence-X-Proton/cloudphone-platform source.
Default ref: public repository HEAD, resolved once to an immutable commit.
Use --ref with a reviewed 40-character SHA for reproducible source selection.
Requires curl + CA certificates already available to download this entry point
and bootstrap metadata; git and runtime prerequisites are installed with consent.
Ubuntu 22.04/24.04 x86_64 and systemd PID 1 are checked before any host changes.
Runs dependencies.sh first (explicit apt/Node consent), then install.sh against
an isolated newly fetched checkout. No existing checkout or live tree is used.
Mode and Android SDK license prompts remain in install.sh. That installer owns
application installation, service startup and tunnel behavior: review its source.
Root executes trusted public project scripts. No GitHub login/token is needed.
Temporary bootstrap/source files are removed on success or failure; apt changes
are not rolled back if later installation fails. Rerun to retry safely.
HELP
}
REF=''
DEPENDENCY_ARGS=()
INSTALL_ARGS=()
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --ref)
      (($# >= 2)) || fail 'Missing --ref value.'
      [[ $2 =~ ^[a-fA-F0-9]{40}$ ]] || fail '--ref must be a full reviewed commit SHA.'
      REF=${2,,}; shift 2 ;;
    --accept-host-changes) DEPENDENCY_ARGS+=("$1"); shift ;;
    --mode)
      (($# >= 2)) || fail 'Missing --mode value.'
      [[ $2 == dashboard || $2 == standalone ]] || fail 'Mode must be dashboard or standalone.'
      INSTALL_ARGS+=("$1" "$2"); shift 2 ;;
    --port)
      (($# >= 2)) || fail 'Missing --port value.'
      [[ $2 =~ ^[0-9]{4,5}$ ]] || fail 'Port must be 1024..65535, excluding 8787.'
      ((10#$2 >= 1024 && 10#$2 <= 65535 && 10#$2 != 8787)) || fail 'Port must be 1024..65535, excluding 8787.'
      INSTALL_ARGS+=("$1" "$2"); shift 2 ;;
    --accept-android-sdk-license) INSTALL_ARGS+=("$1"); shift ;;
    *) fail "Unknown argument: $1 (source/repository overrides are intentionally unsupported)" ;;
  esac
done
[[ $EUID == 0 ]] || fail 'Download bootstrap to a file, inspect it, then run sudo bash FILE.'
[[ $(uname -m) == x86_64 ]] || fail 'x86_64 required.'
[[ -r /etc/os-release ]] || fail 'Cannot identify host OS.'
. /etc/os-release
[[ ${ID:-} == ubuntu && ( ${VERSION_ID:-} == 22.04 || ${VERSION_ID:-} == 24.04 ) ]] || fail 'Ubuntu 22.04/24.04 required.'
[[ $(cat /proc/1/comm) == systemd ]] || fail 'PID 1 must be systemd.'
systemctl show --property=Version --value >/dev/null || fail 'System systemd manager unavailable.'
command -v curl >/dev/null || fail 'curl and CA certificates must be installed before downloading/running bootstrap.'
umask 077
WORK=$(mktemp -d /tmp/cloudphone-bootstrap.XXXXXX)
trap 'rm -rf -- "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() { curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --connect-timeout 30 --max-time 300 "$@"; }
if [[ -z $REF ]]; then
  REF=$(fetch --silent --show-error -H 'Accept: application/vnd.github.sha' "$API/commits/HEAD") || fail 'Cannot resolve public HEAD (repository must be published and GitHub reachable).'
  [[ $REF =~ ^[a-f0-9]{40}$ ]] || fail 'GitHub did not return a full commit SHA.'
fi
printf 'Trusted source: %s\nCommit: %s\n' "$REPO" "$REF"
# Download just the dependency script before git is available. It is later
# compared with the same commit in the fresh full source checkout.
fetch "$RAW/$REF/scripts/dependencies.sh" -o "$WORK/dependencies.sh"
bash -n "$WORK/dependencies.sh"
bash "$WORK/dependencies.sh" "${DEPENDENCY_ARGS[@]}"
# Ignore caller/system Git configuration, templates, credential helpers and
# environment overrides. No authenticated fetch and no execution of Git hooks.
mkdir "$WORK/home" "$WORK/empty-template"
clean_git() {
  env -i PATH="$PATH" HOME="$WORK/home" LANG=C GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    git -c core.hooksPath=/dev/null -c protocol.file.allow=never "$@"
}
clean_git init --template="$WORK/empty-template" "$WORK/source"
clean_git -C "$WORK/source" fetch --depth=1 --no-tags "$REPO" "$REF"
[[ $(clean_git -C "$WORK/source" rev-parse 'FETCH_HEAD^{commit}') == "$REF" ]] || fail 'Fetched source commit differs.'
[[ -z $(clean_git -C "$WORK/source" ls-tree -r "$REF" | awk '$1 == "120000" || $1 == "160000"') ]] || fail 'Source symlinks/submodules unsupported.'
clean_git -C "$WORK/source" checkout --detach "$REF"
[[ -z $(clean_git -C "$WORK/source" status --porcelain --untracked-files=all) ]] || fail 'Fresh source checkout is not clean.'
for script in dependencies.sh install.sh; do
  [[ -f $WORK/source/scripts/$script && ! -L $WORK/source/scripts/$script ]] || fail "Source missing scripts/$script"
done
cmp -s "$WORK/dependencies.sh" "$WORK/source/scripts/dependencies.sh" || fail 'Dependency script differs from fetched commit.'
bash -n "$WORK/source/scripts/install.sh"
# Preserve terminal stdin for installer mode/license prompts, and keep the
# temporary checkout alive until install.sh has copied/archive-staged it.
# Root never uses caller-provided Git config when the installer verifies source.
env -i PATH="$PATH" HOME="$WORK/home" LANG=C TERM="${TERM:-dumb}" \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  bash "$WORK/source/scripts/install.sh" --source "$WORK/source" "${INSTALL_ARGS[@]}"
