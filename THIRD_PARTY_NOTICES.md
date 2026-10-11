# Third-party notices

This project adapts the working Cloudphone H.264/scrcpy transport and input client, whose package declares ISC. Original project source is distributed under `LICENSE`.

## JavaScript dependencies

Exact versions and integrity checks are in `package-lock.json`. Installed direct packages: `@yume-chan/adb` 2.6.4, `@yume-chan/adb-scrcpy` 2.3.2, `@yume-chan/adb-server-node-tcp` 2.5.2, `@yume-chan/scrcpy` 2.3.0, `@yume-chan/scrcpy-decoder-webcodecs` 2.5.3, `esbuild` 0.28.2, and `ws` 8.22.0: MIT. The Tango/Yume-chan supporting packages, yuv-buffer and yuv-canvas are MIT. Transitive `tinyh264` 0.0.7 is Apache-2.0 and contains OpenH264-related material; preserve its upstream notices when redistributing that package. It is not the selected native WebCodecs decoder path.

License texts copied from installed packages are retained in `licenses/`. The browser bundle is built locally from the source and lockfile, not committed. Redistributors must preserve the applicable upstream notices and review licenses of their actual resulting bundle and binaries; this list does not relicense any dependency.

## Downloaded at installation, not included in this source repository

- **Android SDK emulator/platform-tools and Android 16 Google APIs image:** official Google Android SDK packages. Use is subject to the Android SDK license and applicable Google APIs/system-image terms, not the ISC license. Installation requires explicit acceptance. Upstream packages contain their own LICENSE/NOTICE files and open-source component notices. See https://developer.android.com/studio/terms . Android is a trademark of Google LLC; this project is not affiliated with or endorsed by Google.
- **scrcpy server 3.3.3:** Genymobile scrcpy, Apache License 2.0. https://github.com/Genymobile/scrcpy . Tango wrappers have their own MIT license. The server JAR is downloaded separately with checksum verification; preserve upstream notices if redistributing it.
- **cloudflared:** Cloudflare, Apache License 2.0; https://github.com/cloudflare/cloudflared . Free Quick Tunnels remain subject to the provider's terms and availability; no SLA or permanent hostname is supplied by this project.
- **Node.js, Ubuntu system packages, QEMU/KVM and systemd:** each remains under its upstream license. They are installed/used as system dependencies, not relicensed or vendored here.

H.264 implementations and distribution/use may implicate patents depending on jurisdiction and use. No patent license or certification is promised. This is a real Android emulator image, not Samsung One UI, a certified physical handset, or a promise of Play Integrity/DRM compatibility.
