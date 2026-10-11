# Ubuntu installation and operations

## Public one-pasted bootstrap

Public repository: https://github.com/Silence-X-Proton/cloudphone-platform . No GitHub login required. **The parent must publish these files before the command can work**; source availability was not proven during development (public HEAD initially returned HTTP 409). The command fetches bootstrap, which resolves one commit and fetches the **whole repository**, not an isolated installer.

```sh
( set -e; f=$(mktemp); trap 'rm -f -- "$f"' EXIT; curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 https://raw.githubusercontent.com/Silence-X-Proton/cloudphone-platform/HEAD/scripts/bootstrap.sh -o "$f"; sudo bash "$f" )
```

Requires curl and CA certificates to fetch bootstrap. Review downloaded source before root execution; default HEAD is mutable upstream, resolved once to a full commit. Pass `--ref FULL_REVIEWED_COMMIT_SHA` to bootstrap for reproducible source. Prompts request apt/Node host changes, dashboard vs standalone, and explicit Android SDK/Google APIs license consent. Read https://developer.android.com/studio/terms. These are separate consents; unattended use requires `--accept-host-changes --mode dashboard --accept-android-sdk-license`. No claim of success on arbitrary hosts.

Manual alternative:

```sh
git clone https://github.com/Silence-X-Proton/cloudphone-platform.git
cd cloudphone-platform
sudo bash scripts/dependencies.sh
sudo bash scripts/install.sh
```

Only clean committed source is accepted; no checkout edits, Git pushes or automatic upgrades. Existing deployments/config/credentials are not overwritten.

## Host preparation and upfront downloads

Ubuntu **22.04/24.04 LTS x86_64**, systemd PID1, writable cgroup2, working KVM, existing loop devices, CAP_SYS_ADMIN, kvm group and local ext4/XFS state are mandatory. VM host must expose nested virtualization. Preflight queries devices and host state only: no VM allocation, sockets bound, loop attachment, module loads or cgroup writes. It cannot prove Android boot or that ext4/XFS has thick underlying storage. Reserve backing capacity independently.

`dependencies.sh` explicitly installs missing apt runtime packages using signed Ubuntu repositories (no upgrade/third-party apt source); package hooks can change host state/start package services. It does not run on unsupported/container PID1 hosts. KVM/loop/cgroup configuration is not automatically repaired. Already-supported root-owned Node22/24+ npm are retained; absent Node installs official **Node22.23.3** under `/opt/cloudphone-node/node-v22.23.3-linux-x64`, with non-overwriting /usr/bin links. Official version-specific SHASUMS256.txt must equal reviewed SHA256 `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`; binary verified before extraction. Existing unrelated/incomplete Node conflicts fail for review. Owned interrupted npm-link creation can be completed after consent.

Installer preflight conservatively requires 50GiB free on /opt and /var/lib, 2GiB available RAM for dashboard / 8GiB for standalone. Actual standalone selection is resource-derived, not fixed 4GiB guest. Large sparse/thin backing is not a substitute for reserved capacity.

**During initial setup**, installer downloads all shared pinned artifacts: Android16/API36 Google APIs x86_64 revision7, platform-tools37.0.1, emulator `emulator-linux_x64-16428233.zip`, scrcpy-server3.3.3 and cloudflared2026.10.0. New phones reuse shared installed artifacts. Disk provisioning and Android boot are not instant.

Google official XML is safely parsed (UTF8, DTD/entities rejected, pinned names/digests, sizes verified); Google currently supplies SHA1 for these archives, a weaker upstream digest—not a publisher signature. Verified ZIP extraction rejects traversal/symlinks/devices. scrcpy server SHA256 `7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`; cloudflared official release-body checksum must match `d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db`. No latest binary URLs. npm direct versions must be exact; lock dependencies require npm registry HTTPS and SHA512 integrity. Uses npm ci --ignore-scripts then optional build; root trusts application build code.

## Initial startup and credentials

Installer creates dedicated nonlogin system user/group **cloudphone-web**, root-owned application, shared read-only SDK, private root state/config, separate readable nonsecret web config and four fixed service units. It starts root Unix broker, unprivileged dashboard, then a quick tunnel. Current tunnel InvocationID journal is used to discover URL; only validated HTTPS trycloudflare origin is installed in web config; only managed web is restarted. Server does not trust forwarded headers. Every tunnel restart schedules origin synchronization. No restart is sent to unrelated/live services.

On success prints dashboard URL and username **admin**. The generated password is shown only to an interactive controlling terminal; redirected/noninteractive runs print the root-only retrieval path `/var/lib/cloudphone-platform/initial-admin-password`. Credentials.json stores salted scrypt hash, not plaintext password. No automatic credential rotation or log/URL inclusion. Every phone's separate cryptographic access key and admin-only reveal/scoped login are backend/HTTP features; installer does not print phone keys.

Dashboard mode may complete with phone creation disabled: broker **fails closed** unless networkIsolation and streamingIsolation plus every other capability pass. Standalone attempts to create/start exactly one phone through broker; failure prints the reason and exits nonzero, even if dashboard is accessible. **Blocked standalone is not successful installation.** Reconcile unknown mutation outcomes before any explicit retry.

Standalone sizing uses measured `.usage()` after SDK download: backend first reserves max(2GiB,10%) RAM and max(10GiB,5%) disk; installer allocates at most 80% of remaining resources. Host phone RAM capped48GiB; guest subtracts max(2GiB,25%) overhead, capped32GiB; phone disk capped256GiB. Existing phone is not resized. Backend must revalidate admission/concurrency and charge all required processes.

## Paths and operations

- `/opt/cloudphone-platform`: root-owned, readable/traversable application snapshot; never Git-pulled in place.
- `/opt/cloudphone-sdk/api36-v1`: shared read-only SDK, exact SHA256 local manifest/provenance; all startups verify integrity. Root can override permissions; no chattr guarantee.
- `/var/lib/cloudphone-platform`, `/etc/cloudphone-platform`: root0700; credentials/config0600.
- `/etc/cloudphone-platform-web`: root0755 nonsecret config0644 and PORT-only tunnel.env.
- `/run/cloudphone-platform`: broker-managed root:cloudphone-web0750, IPC sockets0660.
- `/srv/cloudphone`: empty root0755 bind target; retained on uninstall.

```sh
sudo /opt/cloudphone-platform/scripts/start.sh --tunnel
sudo /opt/cloudphone-platform/scripts/start.sh --tunnel --provision-standalone
sudo /opt/cloudphone-platform/scripts/start.sh --tunnel --enable
sudo /opt/cloudphone-platform/scripts/stop.sh
sudo systemctl status cloudphone-platform-broker.service cloudphone-platform.service cloudphone-platform-tunnel.service cloudphone-platform-origin.service
sudo journalctl -u cloudphone-platform-broker.service -n 100 --no-pager
```

Default web **127.0.0.1:8790**; **8787 is rejected**. Quick tunnel hostname is temporary/no SLA. Use printed canonical origin for login; old hostname cookies/sessions may no longer apply. After tunnel changes origin sync restarts web and clears in-memory sessions. Broker restart can interrupt phones; web/tunnel stay up but broker-backed requests fail closed until recovery. Use stop.sh for full controlled teardown, not direct broker-only stop.

Initial setup starts but does not enable reboot startup. `--enable` enables control-plane units; **phones do not automatically resume after reboot**. Explicitly run `--provision-standalone` after reviewing backend state/capabilities to resume the one phone. No silent mutation retries. Default start does not create phones.

## Cleanup, uninstall, recovery

```sh
sudo /opt/cloudphone-platform/scripts/uninstall.sh
sudo /opt/cloudphone-platform/scripts/uninstall.sh --yes --remove-data
```

All operations use fixed owned unit/path names and operation locks. Uninstall stops origin/tunnel/web/broker, runs root backend cleanup for exact owned phone IDs, rejects active mounts/backing loops, then removes managed units/source. No pkill/global ADB stop, no access to live `/a0/usr/workdir/cloudphone`.

Default uninstall preserves state/config/credentials/web identity; automatic reinstall intentionally refuses retained paths for explicit reviewed recovery. `--remove-data` also removes phone data/root+web config and the exact marked web identity, but only if account/group properties remain unchanged, no shared group membership or identity processes remain. Shared SDK, installed Node/apt packages and /srv/cloudphone are always retained. SDK may be shared by other deployments.

Completed installer reruns validate and preserve existing deployment without restarts. Changed config/unit overrides, unknown identity, dirty source, mismatched SDK, partial staging/setup fail closed. Interrupted first setup is NOT automatically repaired or retried; inspect logs and state then explicitly run start. Installation stages content but is not cross-filesystem atomic; retain evidence/backup before manual recovery. User/group creation interruption may require reviewed account cleanup. Never discard data to make installer pass.

## Verification and limitations

Offline installer tests and Bash/Node/Python syntax checks only. Metadata pins checked; no apt, full installer, service startup, KVM/loop mutation or large download executed here. Source publication and public one-command fetch are dependent on parent push. Actual Ubuntu install, nonroot access, tunnel origin changes, reboot, namespace propagation, OOM/disk-full, cross-phone network denial and streaming accounting need disposable KVM host validation. Do not advertise production isolation until those pass; no fake capability flags. See INTEGRATION.md for exact API and security boundaries.
