#!/usr/bin/env bash
set -euo pipefail
# Called only on a fresh installation, never adopts an existing account/group.
[[ $EUID == 0 ]] || exit 1
if getent passwd cloudphone-web >/dev/null || getent group cloudphone-web >/dev/null; then
  echo 'Existing cloudphone-web identity requires manual review; refusing account reuse.' >&2; exit 1
fi
groupadd --system cloudphone-web
useradd --system --gid cloudphone-web --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin cloudphone-web
