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

## Testing unpublished reviewed source

`sudo bash scripts/bootstrap-local.sh --source-archive /absolute/reviewed-source.tgz --source-sha256 SHA256 --accept-host-changes --mode dashboard --accept-android-sdk-license` runs the same dependencies/installer using an explicitly trusted checksum-pinned source archive. Review the archive first. No Git commit or token is required; archive SHA is recorded separately from a commit. Source must exclude Git metadata, dependencies, credentials and runtime data. This path does not bypass host/resource/runtime checks. The published command above remains the old revision until the owner pushes.
