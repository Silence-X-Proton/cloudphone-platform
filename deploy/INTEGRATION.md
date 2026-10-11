# Installer / broker / HTTP integration

Scope: scripts/, deploy/, tests/installer.test.mjs. No live deployment edits.

## Service topology

- `cloudphone-platform-broker.service`: root, primary group cloudphone-web; `/usr/bin/node /opt/cloudphone-platform/lib/broker.mjs`; `CONFIG_FILE=/etc/cloudphone-platform/config.json` root-only 0600. RuntimeDirectory `cloudphone-platform` root:cloudphone-web 0750; broker/stream sockets 0660. RuntimeDirectory cleanup occurs only when broker stops. No stale socket unlink by installer.
- `cloudphone-platform.service`: User/Group cloudphone-web; `/usr/bin/node /opt/cloudphone-platform/server.mjs`; CONFIG_FILE `/etc/cloudphone-platform-web/config.json`. No stateDir/credentialsFile/password fields in this nonsecret 0644 config. Root config/state are also InaccessiblePaths in web's namespace. Empty capabilities, read-only filesystem, protected kernel/devices, no namespace creation. HTTP refuses root and authenticates through BrokerClient.
- `cloudphone-platform-tunnel.service`: DynamicUser, verified shared cloudflared, loopback web only. Every process start asynchronously schedules `cloudphone-platform-origin.service`.
- `cloudphone-platform-origin.service`: root oneshot reads only the current tunnel InvocationID's journal, validates a unique HTTPS `*.trycloudflare.com` URL, atomically updates the separate web config and restarts ONLY the verified managed web unit when config changed. Uses the same operations lock as start/stop/uninstall. No forwarded-header trust.

Web/tunnel use Wants+After (not Requires) so restarting web does not stop its tunnel and restarting broker does not strand dependants. During broker outage HTTP fails broker-backed requests rather than gaining privileges. Normal teardown is through stop.sh; direct systemctl stop of broker alone intentionally does not stop web/tunnel.

**No mount namespace on broker.** Its ownership-checked loop mounts must be visible to host systemd transient phone units. HTTP and per-phone workers have their own namespaces. Root broker remains trusted; socket membership is privileged authority to the fixed validated API, not an end-user authentication boundary.

## Root and web configs

`makeConfig(mode,port)` schemaVersion 1: mode dashboard|standalone; host 127.0.0.1; port 8790 default (8787 rejected); stateDir `/var/lib/cloudphone-platform`; sdkDir `/opt/cloudphone-sdk/api36-v1`; scrcpyServer `<sdk>/scrcpy-server.jar`; credentialsFile `<state>/credentials.json`; standalone `{name:"My phone",sizing:"available-resources-v1"}`; minimum reserve `{hostMemoryMiB:2048,diskGiB:10}`. Backend usage actually uses max(2GiB,10% RAM), max(10GiB,5% disk).

Web config contains only schemaVersion, mode, host, port, sdkDir, scrcpyServer, fixed brokerSocket, publicOrigin and optional tunnelInvocationId. It never reads root environment/config or credentials. Local initial origin is `http://127.0.0.1:PORT`; HTTPS tunnel origin is set before setup reports ready. Root broker config never changes when tunnel URL changes. Cookie security derives from explicit publicOrigin; browser login must use the printed origin.

## Credentials and keys

`scripts/credentials.mjs init`: exclusive creation, no rotation. STATE_DIR/credentials.json 0600: `{schemaVersion:1,username:"admin",salt:<32 hex chars>,passwordHash:<128 hex chars>}`; scrypt(password, Buffer.from(salt,"hex"),64,{N:16384,r:8,p:1}). Random 32-byte base64url password saved once to private initial-admin-password. Initial start prints it ONLY to interactive /dev/tty, never redirected stdout/journal; noninteractive runs print only its private path. Admin-only unique per-phone key generation/protection/reveal/routing is owned by broker/backend/HTTP, not installer; installer does not substitute the admin password for a phone key.

## Provisioning / cleanup

`provision.mjs` imports BrokerClient, not PhoneManager. Requires supported===true, every check ok===true, and explicit networkIsolation/streamingIsolation checks true before list/create/start. No override. Uses `.usage()` for sizing: 80% of already-reserve-deducted allocatable RAM rounded down to 256MiB, capped 48GiB host; guest subtracts max(2GiB,25% host) overhead and caps 32GiB; disk 80% allocatable capped 256GiB, minimum 8GiB. Requires guest >=1GiB. Existing sole phone is reused without resizing; >1 phones refused. `.create({name,guestRamMiB,hostMemoryMiB,diskGiB})` returns `{id}`, `.start(id)` must reconcile safely/idempotently. New-phone disk allocation/boot still takes time despite upfront SDK downloads.

Initial install starts dashboard/broker/tunnel. Standalone then attempts one-phone provisioning; missing enforcement or any error exits nonzero and leaves dashboard diagnostics accessible. No fake successful phone. Installer rerun after incomplete setup refuses automatic mutation retry. Operator must reconcile list/metrics and explicitly invoke start.sh --tunnel --provision-standalone. Enabling units starts control plane on reboot, NOT automatic phone resume; explicitly resume after capability/state checks. No persistent provisioning authorization or automatic retries are promised.

`scripts/cleanup.mjs` alone imports PhoneManager for root offline cleanup: list and stop each exact managed ID, verify loop/mount ownership in backend. Broker ExecStopPost invokes it; stop/uninstall also invoke it after broker stops. Unknown mounts/loops block uninstall. Full --remove-data uninstall removes the owned web identity only after marker/account/group/process validation; default uninstall retains identity and all data/config for manual recovery.

## Installation trust and tests

Public bootstrap fetches complete committed source, host dependency setup requires explicit consent, SDK requires separate explicit license acceptance. Exact npm versions plus registry/integrity lock validation, npm ci --ignore-scripts, optional application build. Root executes trusted source/build scripts; no claim to sandbox malicious source. Source and shared SDK are root-owned/readable to service UIDs; no per-phone SDK download. SDK write bits removed and exact manifest checked; trusted root can override permissions.

No real installation, services, apt, KVM/loop mutations or huge downloads were performed during development. Unit/static checks do not prove Ubuntu namespace/OOM/disk exhaustion/network/stream isolation. Release readiness needs disposable supported-host testing. Broker/backend remain responsible for honestly failing absent isolation checks.
