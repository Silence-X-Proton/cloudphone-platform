# Verification status and acceptance gates

## Current unpublished integration evidence

The sections below originally described the published release candidate. Current work has now exercised a disposable Ubuntu 24.04.5/systemd255 VM using nested KVM; the original active phone was not restarted or used for stress tests. Exact external evidence is under `cloudphone-platform-evidence/runtime/`.

- Real 64 MiB cgroup OOM: `memory.swap.max=0`, `memory.oom.group=1`, `oom_kill=2`, `oom_group_kill=1`; peer survival. Real 128 MiB fully allocated ext4 block and inode exhaustion (32747 files), writable-path device identity, missing-bind failure, and cleanup: `kernel-final.log`.
- Found and fixed real launch defects: unsupported `MemoryOOMGroup`, missing passwd identities, `/run` namespace masking, ADB37 listening-host syntax, API36 empty-data archive layout, and asynchronous loop detach. Production-property worker and supervisor/connected-peer checks were exercised, not merely mocked.
- Explicit `runtimeSelfCheck()` uses a separate bounded volume and real supervisor/worker, with boot/source/kernel/systemd fingerprint; capabilities only accept a private result produced after successful checks and cleanup. The self-check does **not** claim Android boot completion or physical disk provisioning.
- Public network helper: actual HTTPS301 and DNS, reachable host-public-address negative control with kernel drop counter, private/metadata denial, exact cgroup helpers, seccomp socket restrictions, monitor-death and firewall-tamper failure behavior. `network-actual.log`, `network-policy-failure.log`. Restricted to public IPv4 TCP80/443 and approved UDP DNS; not unrestricted gaming UDP/QUIC.
- Integrated public-network supervisor/worker self-check passed: `online-selfcheck3.log`. Final broker-context verification also passed with production capability bounding and umask0077: `broker-context-final.log`.
- Checksum-staged Ubuntu dashboard installation completed: `staged-install3.log`, source archive `d8cc4da1812fea2464a0aff28bda138d176b3c29db8d0e9e2e71757af2222320`. Rerun preserved credentials and services (`installed-rerun.log`). This snapshot predates final online integration; public GitHub source has not been updated.
- Browser audio/settings: actual production audio pipeline through worker -> Unix broker -> HTTP/WSS -> Chromium decoded nonzero Opus and PCM samples, with mute/reconnect/teardown and responsive modal settings. Sources are explicitly **synthetic ffmpeg sine/video**, not Android capture. `media/results.json`, `media-browser.log`, `media/settings-*.png`.

Remaining Android boot/audio, genuine admitted create/start, final revised installation and cleanup results must be read from the final integration report; do not infer them from the successful prerequisite or synthetic tests. The VM backing is qcow2/thin; it does not certify thick physical storage. No physical handset/gaming or zero-lag claim.

## Locally exercised

- `npm ci --ignore-scripts` using pinned lockfile: successful; no Android/SDK downloads or system packages installed during development.
- `npm run build`: successful browser bundle.
- `npm test`: application/auth/API validation, resource parsing, mocked strict isolation, installer syntax/metadata/archive checks, Unix broker RPC/proxy and worker protocol tests. Final counts are recorded in external run evidence, not a claim of privileged integration.
- `node tests/render-smoke.mjs`: actual application HTTP/WebSocket server on an ephemeral loopback port, **in-memory mock manager and synthetic H.264 fixture**, headless Chromium. Authentication, scoped phone keys, admin-only key reveal/copy, CSRF, dismissal/error races, touch, reconnect/quality, CSP and responsive layout assertions passed. Browser/server closed afterward.
- Desktop dark/light, mobile dashboard, phone-key login and mobile synthetic-video screenshots were visually inspected. No horizontal clipping; viewer fits mobile height. Card labels distinguish guest RAM, host limit and disk allocation.
- `bash -n scripts/*.sh` (each file separately) and README bootstrap command syntax checked. Unit tests cover checksum mismatch, archive path traversal, invalid settings and fail-closed provisioning.
- Read-only `PhoneManager.capabilities()` returned `supported:false` on the development host. PID1 is supervisord, not systemd. cgroup v2 was **writable at inspection time**, but this does not supply the missing system manager or authorize changing the live host hierarchy. Missing new SDK/state paths and unimplemented/unvalidated isolation prerequisites are reported. No mounts, loop attachments, cgroups or live emulator settings were changed.
- Existing Cloudphone public HTML returned HTTP 200 during preservation checks. No authenticated connection, Android input, ADB command, emulator retune, tunnel restart or live service control was performed. HTML availability alone is not a fresh live-video/session validation.

Evidence lives outside the source repository at `/a0/usr/workdir/cloudphone-platform-evidence/` in the development environment (not a portable runtime requirement). `unit-tests.txt`, `render-smoke.txt`, `render-run.log`, screenshots and `capabilities.json` identify their mocked/real scope. The browser script accepts `PLAYWRIGHT_MODULE`, `CHROMIUM_PATH` and `EVIDENCE_DIR` for another host; install Playwright/Chromium and ffmpeg separately for that optional manual test.

## Remaining acceptance gaps

1. Genuine production create/start **passed** at6272MiB disposable VM memory with2560MiB Android guest,3584MiB aggregate budget and8GiB disk; unchanged2GiB host reserve. Isolated ADB returned Android16/API36. However, sys.boot_completed was never1: nested AMD WRMSR initially stalled the kernel; an explicitly documented guest-only ignore_msrs diagnostic allowed userspace progress, then Android framework watchdog killed system_server while blocked in RoleService default-role initialization. No cgroup OOM kill occurred. Actual Android audio/video/browser acceptance remains unverified. See runtime/genuine-attempt1.log, android-watchdog.log and continuation-stop.log.
2. Final security-fixed source was checksum-staged at the actual installed /opt/cloudphone-platform path, built and passed real service startup/selfcheck, broker capabilities and HTTP200. Archive SHA256:13ce95e0ee513cda5f69a3252f1540518da19aa16a8edb9c6bb11db047deb2de. This was a stopped-source update, not a fresh installer rerun. Fresh standalone sizing refused in the bounded guest; no reserve/sizing rule was lowered. Independent-review H1 archive mutation and H2 readiness-read races were fixed with deterministic/real-file regressions; final173 tests passed.
3. Two-phone adversarial socket substitution/control isolation, abrupt reboot recovery, full physical-handset/gaming and real Android A/V synchronization remain unverified.
4. Test phone processes, loop attachments and firewall tables were cleaned. The disposable VM was shut down after the final retry; its historical tunnel URL is no longer a running deployment. The user's original phone was untouched.

## Required clean-host acceptance matrix before enabling deployment

Use a disposable supported Ubuntu x86_64 KVM VM with known thick-backed storage. Retain command output and exact tested revisions; do not use the actively used live phone.

- Fresh install and rerun: explicit dependency/license consent, pinned checksums, service user/source/SDK traversal, private credentials, no credential rotation, unknown/partial install refusal and cleanup behavior.
- Two genuine API36 phones: boot completion/version evidence, independent userdata/keys/ADB, browser H.264 stream and touch/keyboard/Unicode input, quality reconnect without guest restart.
- Verify actual namespace mounts from each phone process: fixed image device and filesystem identity, read-only SDK/system, writable HOME/log/temp/shm entirely inside the assigned image. Missing/wrong mount must stop launch; no underlying-directory fallthrough.
- Read `memory.max`, `memory.swap.max`, `memory.current`, cgroup membership and OOM events for emulator, ADB, supervisor and stream worker. Induce controlled allocation beyond the limit; verify kernel enforcement and peer/host survival. Shared frontend/broker/tunnel buffers remain explicitly shared overhead.
- Fill guest userdata, host-side temp/log paths, filesystem blocks and inodes. Confirm ENOSPC inside the phone budget, no mutable data escape, host reserve preserved and cleanup still works. Test another workload consuming host free resources during admission.
- Deny cross-phone ADB/console/gRPC, host loopback/LAN/metadata endpoints and raw browser ADB access. The egress helper must remain charged to the phone cgroup, block host/private destinations and fail closed on helper death.
- Verify worker socket ancestry/ownership cannot be substituted to another phone or broker target by a compromised phone UID. Verify unprivileged web cannot read phone keys/state directly or select arbitrary broker commands/paths/unit properties.
- Stop/delete while streaming; worker/ADB/QEMU crash, broker restart, abrupt host reboot, stale records/locks/sockets/loop devices and failed detach. Prove process quiescence before storage release; never delete foreign units or mounts.
- Hosted HTTPS: exact canonical Origin, Secure/HttpOnly/SameSite cookies, CSRF rejection, session expiry/logout/takeover, rate/queue limits, scoped phone-key access, tunnel hostname rotation and secure config refresh.
- Dashboard versus standalone route/assets/API isolation; standalone retains a host reserve and never creates a second phone. Uninstall default preserves images/credentials; explicit data removal deletes only validated managed data.

No claim is made for full-disk encryption, physical-device Safari, Play Integrity/DRM/banking apps, hardware GPU throughput, guaranteed FPS, zero latency, stable Quick Tunnel hostnames or production availability.
