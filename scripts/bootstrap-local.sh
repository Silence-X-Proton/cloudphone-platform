#!/usr/bin/env bash
# Reviewed unpublished source only. Public bootstrap.sh remains commit-pinned.
set -euo pipefail
BASE=$(dirname "$(readlink -f "$0")")
usage() {
  echo 'Usage: sudo scripts/bootstrap-local.sh --source-archive /absolute/reviewed.tgz --source-sha256 SHA256 [--accept-host-changes] [--mode dashboard|standalone] [--port 8790] [--accept-android-sdk-license]'
}
ARCHIVE='' SHA='' DEPS=() INSTALL=()
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0;;
    --source-archive|--source-sha256|--mode|--port)
      (($# >= 2)) || { usage >&2; exit 1; }
      case "$1" in --source-archive) ARCHIVE=$2;; --source-sha256) SHA=$2;; *) INSTALL+=("$1" "$2");; esac
      shift 2;;
    --accept-host-changes) DEPS+=("$1"); shift;;
    --accept-android-sdk-license) INSTALL+=("$1"); shift;;
    *) usage >&2; exit 1;;
  esac
done
[[ $EUID == 0 && $ARCHIVE == /* && $SHA =~ ^[a-f0-9]{64}$ ]] || { usage >&2; exit 1; }
umask 077
WORK=$(mktemp -d /tmp/cloudphone-local.XXXXXX)
trap 'rm -rf -- "$WORK"' EXIT
mkdir "$WORK/source"
# Validate before host changes, then execute only this exact reviewed snapshot.
python3 "$BASE/staged-source.py" "$ARCHIVE" "$SHA" "$WORK/source" >/dev/null
printf 'Unpublished reviewed snapshot SHA256: %s\n' "$SHA"
bash "$WORK/source/scripts/dependencies.sh" "${DEPS[@]}"
bash "$WORK/source/scripts/install.sh" --source-archive "$ARCHIVE" --source-sha256 "$SHA" "${INSTALL[@]}"
