#!/usr/bin/env bash
# Installer-owned static identities: no login/home and no persistent supplementary groups.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
fail() { echo "phone-identities: $*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Root required'
MODE=${1:-}; SLOT=${2:-all}
[[ $# -le 2 && ( $MODE == --install || $MODE == --verify ) ]] || fail 'Usage: phone-identities.sh --install | --verify [0..30]'
[[ $SLOT == all || $SLOT =~ ^([0-9]|[12][0-9]|30)$ ]] || fail 'Invalid slot'
[[ $MODE != --install || $SLOT == all ]] || fail 'Install all identities together'
BASE=/etc/cloudphone-phone-identities
for p in /etc "$BASE"; do
  [[ ! -L $p ]] || fail "Symlink: $p"
  if [[ -e $p ]]; then
    [[ -d $p && $(stat -c %u "$p") == 0 && -z $(find "$p" -maxdepth 0 -perm /022 -print) ]] || fail "Unsafe directory: $p"
  fi
done
verify_marker() {
  [[ -f $BASE/complete && ! -L $BASE/complete ]] || fail 'Identity installation incomplete/unmanaged; inspect manually'
  [[ $(stat -c '%u:%a:%h' "$BASE/complete") == 0:600:1 && $(cat "$BASE/complete") == cloudphone-identities-v1-200000-200030 ]] || fail 'Invalid identity marker'
}
verify_slot() {
  local slot=$1 uid name pw shadow groups
  uid=$((200000+slot)); name=cloudphone-phone-$slot
  pw="$name:x:$uid:$uid:Cloudphone managed phone $slot:/nonexistent:/usr/sbin/nologin"
  [[ $(getent passwd "$name") == "$pw" && $(getent passwd "$uid") == "$pw" ]] || fail "Foreign/missing passwd identity $name"
  [[ $(getent group "$name") == "$name:x:$uid:" && $(getent group "$uid") == "$name:x:$uid:" ]] || fail "Foreign/missing group identity $name"
  shadow=$(getent shadow "$name" | cut -d: -f2)
  [[ $shadow == '!' || $shadow == '!!' ]] || fail "Password not locked: $name"
  groups=$(id -G "$name")
  [[ $groups == "$uid" ]] || fail "Unexpected supplementary groups: $name"
}
if [[ $MODE == --install && ! -e $BASE ]]; then
  # Validate every name/number before changing any account; never adopt preexisting identities.
  for slot in $(seq 0 30); do
    for db in passwd group; do
      for key in "cloudphone-phone-$slot" "$((200000+slot))"; do
        if getent "$db" "$key" >/dev/null; then fail "Preexisting $db $key"; else [[ $? == 2 ]] || fail 'NSS lookup failed'; fi
      done
    done
  done
  umask 077
  mkdir -m 0700 "$BASE"
  # Interrupted creation intentionally leaves an incomplete marker directory: no adoption on retry.
  for slot in $(seq 0 30); do
    uid=$((200000+slot)); name=cloudphone-phone-$slot
    groupadd --gid "$uid" "$name"
    useradd --uid "$uid" --gid "$uid" --comment "Cloudphone managed phone $slot" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin --password '!' "$name"
    verify_slot "$slot"
  done
  printf '%s\n' cloudphone-identities-v1-200000-200030 > "$BASE/complete"
fi
verify_marker
if [[ $SLOT == all ]]; then for slot in $(seq 0 30); do verify_slot "$slot"; done; else verify_slot "$SLOT"; fi
printf 'Managed phone identities verified (%s)\n' "$SLOT"
