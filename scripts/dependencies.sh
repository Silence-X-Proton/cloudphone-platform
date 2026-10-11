#!/usr/bin/env bash
# Host prerequisites only: no application, SDK, service or tunnel installation.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly NODE_VERSION=22.23.3
# Reviewed against https://nodejs.org/dist/v22.23.3/SHASUMS256.txt.
readonly NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
readonly NODE_NAME="node-v${NODE_VERSION}-linux-x64"
readonly NODE_HOME="/opt/cloudphone-node/$NODE_NAME"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: sudo bash scripts/dependencies.sh [--accept-host-changes]
Supports Ubuntu 22.04/24.04 x86_64 with systemd as PID 1 only.
Default: show apt/Node plan and require typing ACCEPT HOST CHANGES.
Noninteractive use requires --accept-host-changes. No services are created,
enabled or started by this script; apt package maintainer hooks may run.
Installs missing apt prerequisites and official Node 22.23.3 if Node is absent.
The archive must match both official HTTPS SHASUMS256.txt and a reviewed pin.
Existing root-owned Node 22/24 plus npm are preserved; unsupported/conflicting
installations fail rather than being overwritten. /usr/bin/node is required;
a missing link is created only after consent, never replaced.
Does not configure KVM/loop devices, load modules, reboot, or alter apt sources.
SDK licensing, application mode and service setup belong to install.sh.
HELP
}
ACCEPT=no
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --accept-host-changes) ACCEPT=yes; shift ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
[[ $EUID == 0 ]] || fail 'Run with sudo.'
[[ $(uname -m) == x86_64 ]] || fail 'x86_64 required.'
[[ -r /etc/os-release ]] || fail 'Cannot identify host OS.'
# /etc/os-release is trusted host configuration, not downloaded content.
. /etc/os-release
[[ ${ID:-} == ubuntu && ( ${VERSION_ID:-} == 22.04 || ${VERSION_ID:-} == 24.04 ) ]] || fail 'Ubuntu 22.04/24.04 required.'
[[ $(cat /proc/1/comm) == systemd ]] || fail 'PID 1 must be systemd; containers without it are unsupported.'
systemctl show --property=Version --value >/dev/null || fail 'System systemd manager unavailable.'
command -v apt-get >/dev/null || fail 'apt-get required.'

# Canonical ancestor checks permit Ubuntu merged-/usr while rejecting writable
# or non-root-owned code. Never execute a user-managed Node/npm as root.
secure_path() {
  local path
  path=$(readlink -e -- "$1") || fail "Missing/unresolvable path: $1"
  while :; do
    [[ $(stat -c %u -- "$path") == 0 ]] || fail "Not root-owned: $path"
    [[ -z $(find "$path" -maxdepth 0 -perm /022 -print) ]] || fail "Group/other writable: $path"
    [[ $path != / ]] || break
    path=$(dirname -- "$path")
  done
}
present() { [[ -e $1 || -L $1 ]]; }
supported_node() {
  secure_path "$1"
  local version
  version=$("$1" --version) || fail "Cannot run Node: $1"
  [[ $version =~ ^v(22|24)\.[0-9]+\.[0-9]+$ ]] || fail "Unsupported Node $version at $1; install supported Node 22/24 explicitly. Nothing will be replaced."
}
secure_path /usr/bin
secure_path /usr/local/bin
secure_path /opt
REPAIR_NPM=no
NODE=$(command -v node || true)
NPM=$(command -v npm || true)
if [[ -n $NODE ]]; then
  supported_node "$NODE"
  if present /usr/bin/node; then supported_node /usr/bin/node; fi
  if [[ -z $NPM ]]; then
    [[ $(readlink -e "$NODE") == "$NODE_HOME/bin/node" && ! -e /usr/bin/npm && ! -L /usr/bin/npm ]] || fail 'Existing unrelated Node has no npm; repair explicitly.'
    REPAIR_NPM=yes
  else
    secure_path "$NPM"
    "$NPM" --version >/dev/null || fail 'Existing npm is not functional; repair explicitly.'
  fi
  NODE_ACTION="Preserve existing $NODE ($("$NODE" --version)) and $NPM"
else
  for entry in /usr/bin/node /usr/bin/npm /usr/local/bin/node /usr/local/bin/npm; do
    ! present "$entry" || fail "Existing path will not be replaced: $entry"
  done
  [[ -z $NPM ]] || fail 'npm exists without Node; repair explicitly.'
  NODE_ACTION="Install official Node $NODE_VERSION under $NODE_HOME; create /usr/bin/node and /usr/bin/npm"
fi
# Validate a reusable interrupted installation before any apt changes. Ordinary
# reruns use the existing supported Node above and never touch the version tree.
validate_node_home() {
  [[ -d $NODE_HOME && ! -L $NODE_HOME ]] || fail "Unsafe version directory: $NODE_HOME"
  secure_path "$NODE_HOME"
  [[ -z $(find "$NODE_HOME" \( ! -user root -o \( ! -type l -perm /022 \) \) -print -quit) ]] || fail 'Node tree ownership/permissions unsafe.'
  [[ -f $NODE_HOME/.cloudphone-node-sha256 && ! -L $NODE_HOME/.cloudphone-node-sha256 ]] || fail 'Existing Node directory is unmanaged; refusing overwrite.'
  [[ $(cat "$NODE_HOME/.cloudphone-node-sha256") == "$NODE_SHA256" ]] || fail 'Existing Node directory pin mismatch.'
  [[ -f $NODE_HOME/bin/node && ! -L $NODE_HOME/bin/node && -f $NODE_HOME/lib/node_modules/npm/bin/npm-cli.js ]] || fail 'Incomplete Node directory; manual recovery required.'
  [[ $("$NODE_HOME/bin/node" --version) == "v$NODE_VERSION" ]] || fail 'Existing managed Node version differs.'
  "$NODE_HOME/bin/node" "$NODE_HOME/lib/node_modules/npm/bin/npm-cli.js" --version >/dev/null
}
if [[ $REPAIR_NPM == yes ]]; then validate_node_home; fi
if [[ -z $NODE ]]; then
  if present /opt/cloudphone-node; then
    [[ -d /opt/cloudphone-node && ! -L /opt/cloudphone-node ]] || fail 'Unsafe Node parent directory.'
    secure_path /opt/cloudphone-node
  fi
  if present "$NODE_HOME"; then validate_node_home; fi
fi
PACKAGES=(ca-certificates curl git python3 tar xz-utils unzip coreutils findutils
  util-linux e2fsprogs iproute2 procps psmisc kmod libc-bin
  qemu-system-x86 slirp4netns nftables libseccomp2 libstdc++6 libgcc-s1 zlib1g libnss3
  libx11-6 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3
  libxi6 libxrandr2 libxrender1 libxtst6 libpulse0 libgl1 libegl1 libvulkan1
  libdrm2 libgbm1 libdbus-1-3 libfontconfig1 libfreetype6 libxkbcommon0
  libxkbcommon-x11-0 libxcb-cursor0)
if [[ $VERSION_ID == 24.04 ]]; then PACKAGES+=(libasound2t64); else PACKAGES+=(libasound2); fi
MISSING=()
for package in "${PACKAGES[@]}"; do
  if [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true) != 'install ok installed' ]]; then MISSING+=("$package"); fi
done
printf '%s\n' 'Host dependency plan (apt may install transitive dependencies/run package hooks):' "$NODE_ACTION"
if ((${#MISSING[@]})); then printf 'Missing apt packages: %s\n' "${MISSING[*]}"; else echo 'All apt prerequisites already installed; no apt action needed.'; fi
if [[ $ACCEPT != yes ]]; then
  [[ -t 0 ]] || fail 'No host changes accepted. Rerun interactively or with --accept-host-changes.'
  read -r -p 'Type ACCEPT HOST CHANGES to permit this apt/Node plan: ' answer
  [[ $answer == 'ACCEPT HOST CHANGES' ]] || fail 'Host changes declined.'
fi
# From here onward host changes are explicitly authorized. No apt upgrade or
# added third-party repository; do not suppress apt signature verification.
if ((${#MISSING[@]})); then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -- "${MISSING[@]}"
fi
WORK=''
trap 'if [[ -n $WORK ]]; then rm -rf -- "$WORK"; fi' EXIT
umask 022
if [[ -z $NODE ]]; then
  if ! present /opt/cloudphone-node; then mkdir -m 0755 /opt/cloudphone-node; fi
  secure_path /opt/cloudphone-node
  if ! present "$NODE_HOME"; then
    WORK=$(mktemp -d /opt/cloudphone-node/.staging.XXXXXX)
    fetch() { curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --connect-timeout 30 --max-time 1800 "$1" -o "$2"; }
    fetch "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$WORK/SHASUMS256.txt"
    OFFICIAL=$(awk -v file="$NODE_NAME.tar.xz" '$2 == file {print $1}' "$WORK/SHASUMS256.txt")
    [[ $OFFICIAL == "$NODE_SHA256" ]] || fail 'Official Node checksum differs from reviewed pin; refusing download/install.'
    fetch "https://nodejs.org/dist/v$NODE_VERSION/$NODE_NAME.tar.xz" "$WORK/$NODE_NAME.tar.xz"
    printf '%s  %s\n' "$NODE_SHA256" "$WORK/$NODE_NAME.tar.xz" | sha256sum --check --status || fail 'Node archive SHA256 mismatch.'
    tar --extract --xz --file "$WORK/$NODE_NAME.tar.xz" --directory "$WORK" --no-same-owner
    printf '%s\n' "$NODE_SHA256" > "$WORK/$NODE_NAME/.cloudphone-node-sha256"
    chown -R root:root "$WORK/$NODE_NAME"
    chmod -R go-w "$WORK/$NODE_NAME"
    chmod 0755 "$WORK/$NODE_NAME"
    # No-clobber protects a concurrent install; do not merge/replace directories.
    mv --no-clobber --no-target-directory "$WORK/$NODE_NAME" "$NODE_HOME"
    [[ ! -e $WORK/$NODE_NAME ]] || fail 'Node destination appeared concurrently; no existing directory replaced.'
  fi
  validate_node_home
  # ln without -f/-n never removes an existing entry; -T rejects directories.
  ln -sT -- "$NODE_HOME/bin/node" /usr/bin/node
  ln -sT -- "$NODE_HOME/lib/node_modules/npm/bin/npm-cli.js" /usr/bin/npm
elif ! present /usr/bin/node; then
  ln -sT -- "$(readlink -e -- "$NODE")" /usr/bin/node
fi
if [[ $REPAIR_NPM == yes ]]; then
  validate_node_home
  ln -sT -- "$NODE_HOME/lib/node_modules/npm/bin/npm-cli.js" /usr/bin/npm
fi
supported_node /usr/bin/node
npm --version >/dev/null
printf '%s\n' 'Host dependencies ready. Existing installations were not replaced; no platform services created.' 'KVM, loop devices, cgroups, disk capacity and full runtime suitability still require installer preflight.'
