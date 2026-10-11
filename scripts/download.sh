#!/usr/bin/env bash
set -euo pipefail
BASE=$(dirname "$(readlink -f "$0")")
# Only called by installer with a fresh private staging directory, after acceptance.
[[ $# == 2 && $2 == --android-sdk-license-accepted ]] || { echo 'Usage: download.sh EMPTY_DIRECTORY --android-sdk-license-accepted' >&2; exit 1; }
DEST=$(readlink -f "$1")
[[ -d "$DEST" && ! -L "$1" && -z $(find "$DEST" -mindepth 1 -print -quit) ]] || { echo 'Fresh empty staging directory required' >&2; exit 1; }
WORK=$(mktemp -d "$DEST/.downloads.XXXXXX")
trap 'rm -rf -- "$WORK"' EXIT
fetch() { curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --connect-timeout 30 --max-time 3600 "$1" -o "$2"; }
fetch https://dl.google.com/android/repository/repository2-3.xml "$WORK/repo.xml"
fetch https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-4.xml "$WORK/image.xml"
python3 "$BASE/artifacts.py" metadata "$WORK/repo.xml" repo > "$WORK/repo.json"
python3 "$BASE/artifacts.py" metadata "$WORK/image.xml" image > "$WORK/image.json"
node -e 'for(const f of process.argv.slice(1))for(const a of JSON.parse(require("fs").readFileSync(f))) console.log([a.filename,a.url,a.algorithm,a.checksum,a.size].join("\t"))' "$WORK/repo.json" "$WORK/image.json" > "$WORK/archives.tsv"
while IFS=$'\t' read -r filename url algorithm checksum size; do
  fetch "$url" "$WORK/$filename"
  python3 "$BASE/artifacts.py" verify "$WORK/$filename" "$algorithm" "$checksum" "$size"
  output="$DEST"
  if [[ $filename == x86_64-36_r07.zip ]]; then output="$DEST/system-images/android-36/google_apis"; fi
  mkdir -p "$output"
  python3 "$BASE/artifacts.py" extract "$WORK/$filename" "$output"
done < "$WORK/archives.tsv"
fetch https://github.com/Genymobile/scrcpy/releases/download/v3.3.3/scrcpy-server-v3.3.3 "$DEST/scrcpy-server.jar"
python3 "$BASE/artifacts.py" verify "$DEST/scrcpy-server.jar" sha256 7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0
fetch https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.10.0 "$WORK/cloudflared-release.json"
CLOUDFLARED_SHA=$(python3 "$BASE/artifacts.py" cloudflare "$WORK/cloudflared-release.json")
fetch https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64 "$DEST/cloudflared"
python3 "$BASE/artifacts.py" verify "$DEST/cloudflared" sha256 "$CLOUDFLARED_SHA"
chmod 0755 "$DEST/cloudflared"
mkdir "$DEST/provenance"
cp "$WORK/repo.json" "$WORK/image.json" "$WORK/cloudflared-release.json" "$DEST/provenance/"
printf '%s\n' 'cloudphone-sdk-api36-v1' > "$DEST/.cloudphone-sdk"
# Locally recorded SHA256 integrity manifest protects subsequent reuse against accidental modification.
(cd "$DEST"; find . -type f ! -path './.downloads.*/*' ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
