# Cloudphone Platform

Android 16 cloud phone console with authenticated H.264/scrcpy control, a dashboard, and a single-phone standalone mode. No VNC.

## VPS pe online (ek command)

Ubuntu 22.04/24.04 VPS pe root shell mein ye chalego:

```bash
bash -c 'set -euo pipefail; f=$(mktemp); trap '\''rm -f "$f"'\'' EXIT; curl --fail --show-error --silent --location --proto "=https" --tlsv1.2 https://raw.githubusercontent.com/Silence-X-Proton/cloudphone-platform/main/scripts/bootstrap.sh -o "$f"; sudo bash "$f"'
```

Dashboard mode (multi phone + login):

```bash
sudo bash scripts/bootstrap.sh --mode dashboard --accept-android-sdk-license
```

Cloudphone standalone mode (ek hi phone, no dashboard):

```bash
sudo bash scripts/bootstrap.sh --mode standalone --accept-android-sdk-license
```

Setup ke baad terminal pe khud aayega:

- **Cloudflare tunnel URL** (temporary, `*.trycloudflare.com`)
- **Admin username / password** (root-only file: `/var/lib/cloudphone-platform/initial-admin-password`)
- **Phone access key** — dashboard se admin login karke us phone ka key reveal/copy karo (per-phone 43-char secret, root-only record mein rehta hai, public record mein kabhi nahi)

Config: `/etc/cloudphone-platform-web/config.json`. State: `/var/lib/cloudphone-platform`. SDK: `/opt/cloudphone-sdk/api36-v1`.

## YAML — dashboard + cloudphone

Do workflows. Block copy karke file mein paste karo, commit karo, bas.

### `.github/workflows/ci.yml` — test (hosted runner)

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-and-test:
    name: Build and test (Node ${{ matrix.node }})
    runs-on: ubuntu-24.04
    strategy:
      fail-fast: false
      matrix:
        node: ['22', '24']
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node ${{ matrix.node }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm

      - name: Install locked dependencies
        run: npm ci --ignore-scripts --no-audit --no-fund

      - name: Verify dependency pins and lockfile integrity
        run: node scripts/config.mjs lock package.json package-lock.json

      - name: Build browser bundle
        run: npm run build

      - name: Run test suite
        run: npm test

      - name: Bash syntax check
        run: |
          set -euo pipefail
          fail=0
          while IFS= read -r -d '' file; do
            bash -n "$file" || { echo "syntax error: $file"; fail=1; }
          done < <(find scripts tests -name '*.sh' -type f -print0)
          exit "$fail"

      - name: Python syntax check
        run: |
          python3 -m compileall -q scripts tests && echo 'python syntax ok'

      - name: Confirm generated bundle is committed unchanged
        run: |
          set -euo pipefail
          npm run build
          if ! git diff --quiet -- public/client.js; then
            echo 'public/client.js differs from the committed bundle; run npm run build and commit.'
            git --no-pager diff --stat -- public/client.js
            exit 1
          fi
          echo 'public/client.js matches the committed bundle'

  runtime-capability-report:
    name: Runner capability report (preflight, read-only)
    runs-on: ubuntu-24.04
    needs: build-and-test
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run real preflight and record the result
        run: |
          set -uo pipefail
          mkdir -p preflight
          rc=0
          sudo python3 scripts/preflight.py dashboard 8790 > preflight/dashboard.json 2>&1 || rc=$?
          cat preflight/dashboard.json
          echo "preflight exit code: $rc"
          if [ "$rc" -eq 0 ]; then
            echo '::notice::Hosted runner unexpectedly reports full preflight support.'
          else
            echo '::notice::Hosted runner cannot host the privileged install (expected). See preflight/dashboard.json.'
          fi
          exit 0

      - name: Summarize which host capabilities are missing
        run: |
          python3 - <<'PY' >> "$GITHUB_STEP_SUMMARY"
          import json, pathlib
          text = pathlib.Path('preflight/dashboard.json').read_text()
          start = text.find('{')
          data = json.loads(text[start:]) if start != -1 else {'supported': False, 'checks': []}
          print('## Preflight capability report')
          print()
          print(f"Supported on this runner: **{data.get('supported')}**")
          print()
          print('| Check | OK | Detail |')
          print('|---|---|---|')
          for entry in data.get('checks', []):
            ok = 'yes' if entry.get('ok') else 'no'
            detail = str(entry.get('detail', '')).replace('|', '\\|')
            print(f"| {entry.get('check')} | {ok} | {detail} |")
          print()
          if not data.get('supported'):
            print('The privileged installer is intentionally refused here.')
            print('Use the `Privileged deploy` workflow on a self-hosted KVM runner.')
          PY

      - name: Upload preflight report
        uses: actions/upload-artifact@v4
        with:
          name: preflight-dashboard
          path: preflight/dashboard.json
          if-no-files-found: error
```

### `.github/workflows/privileged-deploy.yml` — real install (self-hosted KVM)

```yaml
name: Privileged deploy

on:
  workflow_dispatch:
    inputs:
      mode:
        description: 'Installation mode'
        required: true
        default: 'dashboard'
        type: choice
        options: [dashboard, standalone]
      port:
        description: 'Loopback web port'
        required: true
        default: '8790'
      ref:
        description: 'Reviewed 40-char commit SHA to install (empty = this workflow SHA)'
        required: false
        default: ''
      remove_data:
        description: 'Uninstall and remove phone data afterwards'
        required: true
        default: false
        type: boolean

permissions:
  contents: read

concurrency:
  group: privileged-deploy
  cancel-in-progress: false

jobs:
  verify-host:
    name: Verify host qualifies
    runs-on: self-hosted
    outputs:
      supported: ${{ steps.preflight.outputs.supported }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run real preflight
        id: preflight
        run: |
          set -uo pipefail
          mkdir -p preflight
          rc=0
          sudo python3 scripts/preflight.py "${{ inputs.mode }}" "${{ inputs.port }}" > preflight/report.json 2>&1 || rc=$?
          cat preflight/report.json
          echo "preflight exit code: $rc"
          if [ "$rc" -eq 0 ]; then
            echo 'supported=true' >> "$GITHUB_OUTPUT"
          else
            echo 'supported=false' >> "$GITHUB_OUTPUT"
          fi

      - name: Summarize host capabilities
        run: |
          python3 - <<'PY' >> "$GITHUB_STEP_SUMMARY"
          import json, pathlib
          text = pathlib.Path('preflight/report.json').read_text()
          start = text.find('{')
          data = json.loads(text[start:]) if start != -1 else {'supported': False, 'checks': []}
          print('## Host preflight')
          print()
          print(f"Supported: **{data.get('supported')}**  \\nMode: `{data.get('mode')}`")
          print()
          print('| Check | OK | Detail |')
          print('|---|---|---|')
          for entry in data.get('checks', []):
            ok = 'yes' if entry.get('ok') else 'no'
            detail = str(entry.get('detail', '')).replace('|', '\\|')
            print(f"| {entry.get('check')} | {ok} | {detail} |")
          PY

      - name: Upload preflight report
        uses: actions/upload-artifact@v4
        with:
          name: preflight-${{ github.run_id }}
          path: preflight/report.json
          if-no-files-found: error

      - name: Refuse on an unqualified host
        if: steps.preflight.outputs.supported != 'true'
        run: |
          echo '::error::This runner does not satisfy the privileged installer preflight.'
          echo 'See the preflight artifact and job summary for the exact missing capabilities.'
          exit 1

  deploy:
    name: Install and verify
    needs: verify-host
    if: needs.verify-host.outputs.supported == 'true'
    runs-on: self-hosted
    timeout-minutes: 180
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Resolve the commit to install
        id: source
        run: |
          set -euo pipefail
          ref='${{ inputs.ref }}'
          if [ -z "$ref" ]; then ref='${{ github.sha }}'; fi
          case "$ref" in
            *[!0-9a-fA-F]*|'') echo '::error::ref must be a full 40-character commit SHA'; exit 1 ;;
          esac
          if [ "${#ref}" -ne 40 ]; then echo '::error::ref must be exactly 40 characters'; exit 1; fi
          echo "sha=$(printf '%s' "$ref" | tr 'A-F' 'a-f')" >> "$GITHUB_OUTPUT"

      - name: Install host prerequisites (explicit consent)
        run: sudo bash scripts/dependencies.sh --accept-host-changes

      - name: Run installer
        run: |
          set -euo pipefail
          sudo bash scripts/install.sh \\
            --mode '${{ inputs.mode }}' \\
            --port '${{ inputs.port }}' \\
            --repo-url https://github.com/${{ github.repository }}.git \\
            --ref '${{ steps.source.outputs.sha }}' \\
            --accept-android-sdk-license

      - name: Collect managed-unit status
        if: always()
        run: |
          set -uo pipefail
          mkdir -p diagnostics
          {
            echo '### Managed unit status'
            echo '```'
            systemctl status \\
              cloudphone-platform-broker.service \\
              cloudphone-platform.service \\
              cloudphone-platform-tunnel.service \\
              cloudphone-platform-origin.service \\
              --no-pager -l 2>&1 || true
            echo '```'
          } > diagnostics/units.txt
          cat diagnostics/units.txt

      - name: Publish tunnel URL and access key instructions
        if: always()
        run: |
          set -uo pipefail
          {
            echo '## Deployment summary'
            echo ''
            echo '| Item | Value |'
            echo '|---|---|'
            mode='${{ inputs.mode }}'
            port='${{ inputs.port }}'
            echo "| Mode | \\`$mode\\` |"
            echo "| Loopback origin | \\`http://127.0.0.1:$port\\` |"
            origin=''
            if [ -f /etc/cloudphone-platform-web/config.json ]; then
              origin=$(python3 -c "import json;print(json.load(open('/etc/cloudphone-platform-web/config.json')).get('publicOrigin',''))" 2>/dev/null || true)
            fi
            if [ -n "$origin" ]; then
              echo "| Public HTTPS origin | $origin |"
            else
              echo '| Public HTTPS origin | not configured (tunnel did not reach readiness) |'
            fi
            echo ''
            echo '### Cloudflare tunnel URL'
            echo ''
            url=''
            if command -v journalctl >/dev/null 2>&1; then
              url=$(journalctl --quiet --no-pager -o cat -u cloudphone-platform-tunnel.service -n 400 2>/dev/null \\
                | grep -Eo 'https://[a-z0-9]+(-[a-z0-9]+)*\\.trycloudflare\\.com' | sort -u | tail -n1 || true)
            fi
            if [ -n "$url" ]; then
              echo "**Tunnel URL:** $url"
            else
              echo 'Tunnel URL: unavailable in this run (see tunnel unit status above).'
            fi
            echo ''
            echo 'Temporary hostname, no SLA, can change after restart. Use only the printed origin for login.'
            echo ''
            echo '### Admin password'
            echo ''
            echo 'Root-only file (not printed here):'
            echo ''
            echo '```'
            echo '/var/lib/cloudphone-platform/initial-admin-password'
            echo '```'
            echo ''
            echo '### Phone access key'
            echo ''
            echo 'Har phone ka apna 43-char access key hota hai (dashboard mode mein).'
            echo 'Key public record mein kabhi nahi aata, root-only state mein rehta hai.'
            echo ''
            echo 'Dashboard mein admin login karo, phone row pe **Reveal / Copy** dabao -> wahi key milegi.'
            echo 'Standalone mode mein key install ke waqt root-only file mein likhi jaati hai:'
            echo ''
            echo '```'
            echo '/var/lib/cloudphone-platform/<phone-id>/record.json  (root-only, 0600)'
            echo '```
            echo ''
            echo 'Key ko URL mein na daalo; login form mein submit karo.'
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Verify running services
        run: |
          set -euo pipefail
          sudo systemctl is-active --quiet cloudphone-platform-broker.service
          sudo systemctl is-active --quiet cloudphone-platform.service
          echo 'Broker and dashboard are active.'

      - name: Upload diagnostics
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: diagnostics-${{ github.run_id }}
          path: diagnostics/
          if-no-files-found: warn

      - name: Uninstall and clean up
        if: always()
        run: |
          set -uo pipefail
          if [ -x /opt/cloudphone-platform/scripts/uninstall.sh ]; then
            if [ '${{ inputs.remove_data }}' = 'true' ]; then
              sudo /opt/cloudphone-platform/scripts/uninstall.sh --yes --remove-data || true
            else
              sudo /opt/cloudphone-platform/scripts/uninstall.sh || true
            fi
          else
            echo 'No managed installation present; nothing to uninstall.'
          fi
          if [ ! -d node_modules ]; then
            npm ci --ignore-scripts --no-audit --no-fund || true
          fi
```

## YAML run ke baad output

Job summary mein aisa dikhega:

```text
## Deployment summary
| Mode | `dashboard` |
| Loopback origin | `http://127.0.0.1:8790` |
| Public HTTPS origin | https://random-words.trycloudflare.com |

### Cloudflare tunnel URL
**Tunnel URL:** https://random-words.trycloudflare.com

### Admin password
/var/lib/cloudphone-platform/initial-admin-password

### Phone access key
Dashboard -> admin login -> phone row pe Reveal/Copy
```

Pehla run mein tunnel URL na aaye to tunnel unit status dekho — readiness fail ka matlab tunnel ready nahi hua, fake URL nahi dikhaya jayega.

## Notes

- Access key, admin password aur tunnel token kabhi print ya commit nahi hote.
- GitHub hosted runner pe real install nahi hoti (KVM/loop/systemd nahi) — wo sirf test karta hai, honest report deta hai.
- Real deploy ke liye self-hosted runner ya apna VPS chahiye jisme `/dev/kvm` ho.
- License: ISC. Dependency/Android terms: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
