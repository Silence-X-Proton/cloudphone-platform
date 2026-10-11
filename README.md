# Cloudphone Platform

A responsive Android 16 phone console with authenticated H.264/scrcpy control, a mobile-first dashboard, and a dashboard-free single-phone mode. No VNC. Based on the working Cloudphone transport, with a separate reusable deployment architecture.

> **Release candidate — not a production-ready hosted phone service yet.** UI, authentication, broker and worker protocol tests run locally. Real Ubuntu installation, Android boot inside the new sandbox, cgroup OOM/disk exhaustion, reboot recovery and cross-phone isolation have **not** been verified. Online network egress is **not implemented**. Production create/start intentionally fails closed while required isolation integration/validation is incomplete. The installer must report this blocker rather than claim a working standalone phone. Do not remove gates or enable host networking to make the demo look functional.

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
- H.264 over authenticated WSS with native WebCodecs. Touch, keyboard, wheel, Android navigation and Unicode paste are retained. Audio is disabled. Current Chromium over HTTPS is the primary target; physical mobile devices/Safari are not certified.
- Economy, balanced and sharp profiles trade quality for responsiveness. Queue limits trigger a fresh decoder/keyframe sequence rather than discard arbitrary delta frames; automatic retries/downshifts are bounded. Software GPU, host load, Android workload and network latency still matter. **No zero-lag or guaranteed FPS claim.**

## Resource contract

| Resource | Meaning |
|---|---|
| Guest RAM | Android emulator `-memory` setting, not the whole host footprint. |
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

The privileged broker has mount/systemd authority but no public HTTP listener; a compromised authorized web service can invoke its deliberately narrow administrative operations. Unix filesystem permissions are the broker authentication boundary. The root broker must share PID1's mount namespace so systemd phone units see verified mounted volumes. Each phone runs non-root with a read-only system/SDK, private networking, no capabilities and limited devices. **Private networking currently has no Internet egress implementation.** Merely assigning separate host-loopback ports was rejected as insufficient tenant isolation.

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
