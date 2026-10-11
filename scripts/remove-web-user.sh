#!/usr/bin/env bash
set -euo pipefail
# Used only after services/phone cleanup during explicit --remove-data uninstall.
[[ $EUID == 0 ]] || exit 1
file=/etc/cloudphone-platform/.web-identity
[[ -f $file && ! -L $file && $(stat -c '%u:%a' "$file") == 0:600 ]] || { echo 'Missing trusted identity marker' >&2; exit 1; }
identity=$(cat "$file")
[[ $identity =~ ^[0-9]+:[0-9]+$ ]] || exit 1
uid=${identity%:*}; gid=${identity#*:}
[[ $uid != 0 && $gid != 0 ]] || exit 1
[[ $(getent passwd cloudphone-web) == "cloudphone-web:x:$uid:$gid::/nonexistent:/usr/sbin/nologin" ]] || { echo 'Account changed; refusing removal' >&2; exit 1; }
[[ $(getent group cloudphone-web) == "cloudphone-web:x:$gid:" ]] || { echo 'Group changed/shared; refusing removal' >&2; exit 1; }
[[ $(getent passwd | awk -F: -v gid="$gid" '$4==gid {print $1}') == cloudphone-web ]] || { echo 'Shared primary group; refusing removal' >&2; exit 1; }
if pgrep -u "$uid" >/dev/null || pgrep -G "$gid" >/dev/null; then echo 'Service identity still has processes' >&2; exit 1; fi
userdel cloudphone-web
# userdel may remove an empty matching user-private group on some hosts.
if getent group cloudphone-web >/dev/null; then groupdel cloudphone-web; fi
