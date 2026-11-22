# Cloudphone Platform

A responsive Android 16 phone console with authenticated H.264/scrcpy control, a mobile-first dashboard, and a dashboard-free single-phone mode. No VNC. Based on the working Cloudphone transport, with a separate reusable deployment architecture.

> **Integration candidate—not yet production-certified.** Real Ubuntu installation, kernel OOM/disk exhaustion, installed supervisor/worker boundaries and restricted Internet egress have now been exercised in a disposable nested-KVM VM. Create/start is guarded by a real boot/source-bound installed self-check, not an unconditional feature flag. Actual Android boot/audio, complete multi-phone attack testing and reboot recovery remain separately tracked in [VERIFICATION.md](VERIFICATION.md). Do not equate a working dashboard or synthetic browser media test with a completed phone deployment.

## Session settings and reconnect stability

Settings group instant playback/display controls separately from encoding changes. Fit, zoom, fullscreen, volume, mute and latency policy apply locally without restarting the stream. Quality, encoded scale and audio transport are staged until **Apply encoding**; one changed Apply performs one controlled stream restart. Unchanged values do nothing. Retry callbacks are generation-guarded and automatic overload recovery is bounded.

The latest platform suite passed 183 tests. The separately deployed single-phone implementation passed 30 tests and a 91-second production-stream check with zero automatic reconnects; actual Android Opus/PCM audio decoded across Apply. These live-phone results do not establish boot completion for the new isolated platform. See [VERIFICATION.md](VERIFICATION.md) for its remaining acceptance gaps.

## One-command Ubuntu setup

Once this revision is published to the public repository, this command downloads the complete checkout through the bootstrap, installs prerequisites/shared artifacts, and runs the prompted setup (review the script before executing root code):

```bash
bash -c 'set -euo pipefail; f=$(mktemp); trap '\''rm -f "$f"'\'' EXIT; curl --fail --show-error --silent --location --proto "=https" --tlsv1.2 https://raw.githubusercontent.com/Silence-X-Proton/cloudphone-platform/main/scripts/bootstrap.sh -o "$f"; sudo bash "$f"'
```

The bootstrap supports an explicit `--ref` commit for reviewed deployments; see `scripts/bootstrap.sh --help`. A moving `main` is convenient, not immutable supply-chain pinning. No GitHub account/token is required for this public repository. Publication is a separate owner action; a URL here does not establish that this revision has already been published.

Manual alternative:

```bash
git clone https://github.com/Silence-X-Proton/cloudphone-platform.git
cd cloudphone-platform
bash scripts/bootstrap.sh --help
sudo bash scripts/bootstrap.sh
# Or pin reviewed source: sudo bash scripts/bootstrap.sh --ref FULL_COMMIT_SHA
```

Choose **dashboard** or **standalone** when prompted and explicitly accept the Android SDK/system-image terms. Artifacts are downloaded once during initial setup, not on each phone creation: pinned official Android 16/API 36 Google APIs x86_64 image, emulator/platform-tools, scrcpy server, cloudflared and locked npm dependencies. Google archives are checked against pinned official metadata checksums; scrcpy/cloudflared and Node downloads use their documented checksums. Changed/unavailable pins fail, rather than silently downloading a different image.

The completed setup path prints generated admin username/password and a temporary HTTPS Quick Tunnel URL only after its checks succeed. Credentials are also retained in root-only files for recovery. Dashboard setup may expose the console while phone creation remains unavailable with explicit capability reasons; standalone provisioning must fail when enforcement prerequisites are not met. Quick Tunnels are temporary, can change after restart, and carry no SLA.

## Modes and controls

- **Dashboard:** username/password login, host capacity and reserves, shared SDK overhead, per-phone charged RAM and filesystem usage, create/start/stop/delete, and explicit admin-only reveal/copy of each phone's unique access key.
- **Standalone:** one phone only; `/` serves the phone viewer, dashboard assets and create/delete APIs are unavailable. It still has authenticated phone control, not an unauthenticated public emulator. Sizing is derived conservatively from available resources and host reserves—not literally every byte.
- A phone key grants only that phone's control session. Submit it through the login form; never put secrets in URLs. Admin credentials use salted scrypt. Random phone keys are protected by root-owned 0700 state directories/0600 records; this is access control at rest, **not full-disk encryption**. Root and disk-backup operators remain trusted.
- H.264 over authenticated WSS with native WebCodecs. Touch, keyboard, wheel, Android navigation and Unicode paste are retained. Optional scrcpy Opus or PCM audio uses browser WebCodecs/Web Audio with explicit **Enable audio** gesture, mute and volume. Unsupported capture/decoder states are reported rather than silently claiming playback. Audio capture from the new Android deployment is a separate acceptance check from the verified synthetic Opus/PCM transport tests.
- Session settings are available after login without a dashboard: an accessible responsive modal offers gaming/low-latency profile, encoded-resolution scale, viewer zoom/fit, fullscreen and reset. Only allowlisted nonsecret preferences persist in this browser. Encoded scaling changes the encoder cap; viewer zoom changes presentation only—neither increases Android guest resolution. Touch coordinates follow the actual encoded dimensions through zoom/scroll.
- Economy, balanced, sharp and gaming profiles trade quality for responsiveness. Gaming requests up to 60 FPS, **not measured or guaranteed 60 FPS**. Browser video queue caps are six frames (three gaming); audio scheduling is bounded to 200 ms (120 ms gaming), with six queued Opus decodes and 16 scheduled sources. These are local queue limits, not end-to-end latency claims. Transport queues are capped at 1 MiB per hop; stale input terminates the session instead of replaying delayed gestures. Video pressure triggers a fresh decoder/keyframe sequence rather than arbitrary delta-frame dropping. Software GPU, host load, Android workload and network latency still matter. **No zero-lag or guaranteed FPS claim.**
- Current Chromium over HTTPS is the primary target; physical mobile devices/Safari are not certified.

## Resource contract

| Resource | Meaning |
|---|---|
| Guest RAM | Android emulator `-memory` setting, not the whole host footprint. Minimum2560MiB: the pinned API36 emulator silently raises smaller requests. |
| Host memory budget | Aggregate cgroup v2 `MemoryMax` for supervisor, QEMU/emulator, dedicated ADB and the in-phone scrcpy transport worker; `MemorySwapMax=0`. At least 1024 MiB additional budget above guest RAM is required, not guaranteed sufficient for every workload. Hitting the ceiling can terminate the phone. |
| Shared host overhead | OS, dashboard, root broker, bounded proxy buffers, tunnel, SDK caches and storage metadata are outside individual phone ceilings and must fit the host reserve. Cgroup charging is not exact attribution of every physical host byte. |
| Allocated disk | Fully allocated fixed-size ext4 image. Instance AVD, mutable home, logs, crash/temp/runtime files and `/dev/shm` live inside it. Metadata and reserved blocks reduce usable capacity. |
| Guest usable disk | Smaller Android userdata capacity (currently approximately half the image budget) leaves space for emulator images, overlays and overhead; filesystem free space can still run out earlier. It is not equal to `diskGiB`. |
| Host reserve | At least 2 GiB or 10% of total RAM, and 10 GiB or 5% of the backing filesystem, whichever is larger. Admission also considers current availability and existing allocations. Other host software can still consume reserve later. |

Live memory reads use kernel `memory.current`; mounted disk usage uses `statfs`. Unknown/unmounted/stopped measurements are shown as unavailable, never invented zero usage. Allocated commitments remain visible separately. Shared SDK disk usage is counted separately and may be briefly cached. Physical capacity behind thin-provisioned LVM/cloud storage cannot be established merely from ext4/XFS or `fallocate`: use thick-provisioned capacity and monitor the backing provider.

## Architecture and requirements

```text
HTTPS Cloudflare Quick Tunnel
          │ loopback HTTP (8790)
 unprivileged web: auth / dashboard / bounded WS proxy
          │ root-owned Unix sockets; fixed operations only
 privileged broker: lifecycle / measurements / bounded stream relay
          │ systemd transient unit + private network/mount namespace
 phone: supervisor + dedicated ADB + Android emulator + scrcpy worker
          └── one aggregate memory cgroup / fixed ext4 writable volume
 shared immutable Android SDK ── read-only mounts
```

Target: Ubuntu 22.04/24.04 x86_64, systemd as PID 1, writable cgroup v2 memory controller, KVM available to the service, loop/ext4 support, root installation, adequate thick-backed storage and Node 22/24. Nested containers/read-only cgroups and hosts without these capabilities are rejected. Do not rearrange host cgroups or weaken enforcement silently. Reserved numeric phone UID/GIDs and dedicated emulator/ADB ports are checked for conflicts. All public application listeners are loopback; raw ADB/console/gRPC are not tunnelled.

The privileged broker has mount/systemd authority but no public HTTP listener; a compromised authorized web service can invoke its deliberately narrow administrative operations. Unix filesystem permissions are the broker authentication boundary. The root broker must share PID1's mount namespace so systemd phone units see verified mounted volumes. Each phone runs non-root with a read-only system/SDK, private networking, no capabilities and limited devices. Public mode uses a cgroup-charged slirp helper with per-phone nftables destination policy and verified helper identity. Only public IPv4 TCP80/443 and UDP DNS to1.1.1.1/9.9.9.9 are allowed; IPv6, QUIC and general gaming UDP are not supported. Assigned host addresses, private ranges and metadata endpoints are denied. Cloud NAT public aliases not assigned locally require deployment-specific restrictions. Offline mode remains explicit; no host-network fallback exists.

## Operations

See [deploy/OPERATIONS.md](deploy/OPERATIONS.md) for exact installed paths and cautious lifecycle commands. Installation is idempotent only for an unchanged managed installation; mismatched/partial configuration fails with recovery guidance instead of overwriting user data. Uninstall preserves data and shared SDK unless its explicit data-removal option is selected. Back up stopped phone images and root-only records together, encrypt backups, and retain enough independent disk space. Never copy a running image as a consistent backup.

For source development (no SDK or privileged operations needed):

```bash
npm ci --ignore-scripts
npm run build
npm test
# Optional browser test: see tests/render-smoke.mjs for Playwright setup.
```

Mock tests explicitly inject managers/runners/workers; their success does not prove actual systemd, KVM, memory or filesystem enforcement. See [VERIFICATION.md](VERIFICATION.md) for run evidence and the acceptance checklist. Do not expose a new real deployment publicly until the clean-host enforcement tests pass.

## Source and licensing

SDK images, userdata, tokens, credentials, logs, runtime artifacts, node_modules and generated bundles are excluded from Git. ISC project license; distinct dependency and Android license terms in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Real Android 16 emulator, not Samsung One UI, a certified handset, or a Play Integrity/DRM guarantee.

## Continuous integration and automated deployment

Two GitHub Actions workflows ship with the repository. They are deliberately split because the privileged installer has hard host requirements that a standard GitHub-hosted runner cannot satisfy.

### `.github/workflows/ci.yml` — unprivileged verification

Runs on `ubuntu-24.04` hosted runners for every push, pull request and manual dispatch.

- Builds and tests on Node 22 and Node 24.
- Verifies exact dependency pins and lockfile registry integrity with `scripts/config.mjs lock`.
- Runs the full suite (`npm test`).
- Checks Bash and Python syntax across `scripts/` and `tests/`.
- Rebuilds the browser bundle and fails if `public/client.js` is not the committed output.
- Runs the **real** `scripts/preflight.py` and publishes the resulting capability JSON as a job summary and artifact.

The preflight job is expected to report `supported: false` on a hosted runner. That is recorded openly, not hidden, because the installer genuinely cannot run there.

### `.github/workflows/privileged-deploy.yml` — real installation

Manual dispatch only, and it targets `self-hosted` runners. It requires a runner that truly qualifies: Ubuntu 22.04/24.04, systemd as PID 1, nested KVM exposed as `/dev/kvm`, an unbound loop device, a writable unified cgroup2 subtree, an existing `kvm` group, and non-overlay `/opt` and `/var/lib` with 50 GiB free each.

1. `verify-host` runs the real preflight and refuses to continue on an unqualified host, publishing the exact missing capabilities.
2. `deploy` runs `scripts/dependencies.sh --accept-host-changes`, then `scripts/install.sh` against a resolved 40-character commit SHA fetched from this repository.
3. Managed unit status is captured, the quick-tunnel origin and dashboard summary are published to the job summary, and the generated admin password path is shown **without** printing the secret.
4. Diagnostics are uploaded, and the workflow uninstalls at the end unless you opt into retaining data.

The workflow never prints the admin password, phone access keys or tunnel tokens. Retrieve the password on the host from `/var/lib/cloudphone-platform/initial-admin-password`.

### Copy-paste workflow YAML

Both workflows are reproduced here verbatim. Copy a block into the file path shown above it, then commit. No secret or token is needed for either file.

` .github/workflows/ci.yml`

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

` .github/workflows/privileged-deploy.yml`

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

      - name: Publish tunnel and dashboard summary
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
              origin=$(python3 -c "import json,sys;print(json.load(open('/etc/cloudphone-platform-web/config.json')).get('publicOrigin',''))" 2>/dev/null || true)
            fi
            if [ -n "$origin" ]; then
              echo "| Public HTTPS origin | $origin |"
            else
              echo '| Public HTTPS origin | not configured (tunnel did not reach readiness) |'
            fi
            echo "| Admin username | admin |"
            echo ''
            echo '### Cloudflare quick tunnel'
            echo ''
            url=''
            if command -v journalctl >/dev/null 2>&1; then
              url=$(journalctl --quiet --no-pager -o cat -u cloudphone-platform-tunnel.service -n 400 2>/dev/null \\
                | grep -Eo 'https://[a-z0-9]+(-[a-z0-9]+)*\\.trycloudflare\\.com' | sort -u | tail -n1 || true)
            fi
            if [ -n "$url" ]; then
              echo "Tunnel URL: $url"
            else
              echo 'Tunnel URL: unavailable in this run (see tunnel unit status above).'
            fi
            echo ''
            echo 'The quick tunnel hostname is temporary, carries no SLA, and can change after a restart.'
            echo 'Use only the printed canonical origin for login; older hostnames may no longer apply.'
            echo ''
            echo '### Credentials'
            echo ''
            echo 'The generated admin password is written root-only and is deliberately not printed here:'
            echo ''
            echo '```'
            echo '/var/lib/cloudphone-platform/initial-admin-password'
            echo '```'
            echo ''
            echo 'Retrieve it only on the host, share it out of band, and store it in a secret manager you trust.'
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

### How to use these workflows

1. Copy the first block into `.github/workflows/ci.yml` and the second into `.github/workflows/privileged-deploy.yml`.
2. Commit and push. The CI workflow starts automatically on `main`.
3. For a real install, add a **self-hosted** runner with KVM and loop support, then run **Privileged deploy** from the Actions tab.
4. Read the tunnel URL and dashboard summary from the job summary. Fetch the admin password on the host from `/var/lib/cloudphone-platform/initial-admin-password`.

### Why the split is not a limitation to hide

Hosted runners are containers or VMs without `/dev/kvm`, without a writable cgroup subtree, and with `/var/lib` on an overlay filesystem. `scripts/preflight.py` rejects all three, so any workflow that claimed to install the platform on a hosted runner would be misreporting its own result. The CI workflow therefore proves the source builds, tests and reports its own capability honestly, while the deploy workflow performs the actual installation only where it can legitimately succeed.

## Testing unpublished reviewed source

`sudo bash scripts/bootstrap-local.sh --source-archive /absolute/reviewed-source.tgz --source-sha256 SHA256 --accept-host-changes --mode dashboard --accept-android-sdk-license` runs the same dependencies/installer using an explicitly trusted checksum-pinned source archive. Review the archive first. No Git commit or token is required; archive SHA is recorded separately from a commit. Source must exclude Git metadata, dependencies, credentials and runtime data. This path does not bypass host/resource/runtime checks. The published command above remains the old revision until the owner pushes.
