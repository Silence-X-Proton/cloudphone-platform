# Verification status and acceptance gates

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

## Intentional release blockers

1. **Internet egress is not implemented.** Phones use a private network namespace. Separate host-loopback ADB ports are not accepted as a tenant boundary. Only explicitly selected offline mode has a network implementation; default online provisioning fails closed. Do not disable private networking as a workaround.
2. **Installed stream/resource boundary has not been validated.** The Unix proxy and confined worker are implemented and protocol-tested, but runtime ancestry/socket identity, actual systemd namespace layout and process membership need a disposable Ubuntu host. `streamingIsolation` remains false; create/start remain disabled rather than advertise a production guarantee. This gate has no supported bypass flag.
3. **Clean Ubuntu one-command deployment is not run.** Shell/parser/unit checks do not prove download availability, service permissions, runtime library coverage, boot success or HTTPS tunnel readiness. Bootstrap/source URLs depend on the owner publishing this revision.
4. **No new real phone was booted.** Android 16 transport history belongs to the inherited live implementation; it is not proof of the new isolated deployment. The original user's phone was deliberately left untouched.

## Required clean-host acceptance matrix before enabling deployment

Use a disposable supported Ubuntu x86_64 KVM VM with known thick-backed storage. Retain command output and exact tested revisions; do not use the actively used live phone.

- Fresh install and rerun: explicit dependency/license consent, pinned checksums, service user/source/SDK traversal, private credentials, no credential rotation, unknown/partial install refusal and cleanup behavior.
- Two genuine API36 phones: boot completion/version evidence, independent userdata/keys/ADB, browser H.264 stream and touch/keyboard/Unicode input, quality reconnect without guest restart.
- Verify actual namespace mounts from each phone process: fixed image device and filesystem identity, read-only SDK/system, writable HOME/log/temp/shm entirely inside the assigned image. Missing/wrong mount must stop launch; no underlying-directory fallthrough.
- Read `memory.max`, `memory.swap.max`, `memory.current`, cgroup membership and OOM events for emulator, ADB, supervisor and stream worker. Induce controlled allocation beyond the limit; verify kernel enforcement and peer/host survival. Shared frontend/broker/tunnel buffers remain explicitly shared overhead.
- Fill guest userdata, host-side temp/log paths, filesystem blocks and inodes. Confirm ENOSPC inside the phone budget, no mutable data escape, host reserve preserved and cleanup still works. Test another workload consuming host free resources during admission.
- Deny cross-phone ADB/console/gRPC, host loopback/LAN/metadata endpoints and raw browser ADB access. Future egress helper must be charged to the phone cgroup, block host/private destinations and fail closed on helper death.
- Verify worker socket ancestry/ownership cannot be substituted to another phone or broker target by a compromised phone UID. Verify unprivileged web cannot read phone keys/state directly or select arbitrary broker commands/paths/unit properties.
- Stop/delete while streaming; worker/ADB/QEMU crash, broker restart, abrupt host reboot, stale records/locks/sockets/loop devices and failed detach. Prove process quiescence before storage release; never delete foreign units or mounts.
- Hosted HTTPS: exact canonical Origin, Secure/HttpOnly/SameSite cookies, CSRF rejection, session expiry/logout/takeover, rate/queue limits, scoped phone-key access, tunnel hostname rotation and secure config refresh.
- Dashboard versus standalone route/assets/API isolation; standalone retains a host reserve and never creates a second phone. Uninstall default preserves images/credentials; explicit data removal deletes only validated managed data.

No claim is made for full-disk encryption, physical-device Safari, Play Integrity/DRM/banking apps, hardware GPU throughput, guaranteed FPS, zero latency, stable Quick Tunnel hostnames or production availability.
