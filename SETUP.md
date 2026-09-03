# PearTube Setup Guide

This guide gets a machine from nothing to a running surface. For daily commands
once you are set up, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Supported Toolchain

| Area | Requirement |
| --- | --- |
| Node.js | `.nvmrc` (`20.18.0`) or `package.json` engine range (`>=18 <23`) |
| Package manager | npm, using `npm run install:all` |
| Submodules | `packages/bare-ffmpeg` |
| iOS | Xcode, iOS simulator, CocoaPods |
| Android | Android Studio/SDK, JDK 17 |
| Electrobun desktop | Bun and Electrobun dependencies |
| Relay | Docker with Compose |

CI runs `npm run install:all`; it does not use `npm ci`. The root `package-lock.json` is ignored/local, while `packages/app/package-lock.json` is tracked. If the project decides to require fully locked installs later, update this guide with the new install contract.

## Clone And Install

```bash
git clone <repo-url>
cd peartube
nvm use
git submodule update --init --recursive
npm run install:all
npm run schema:full
```

`schema:full` regenerates JS HRPC/schema output under `packages/spec/spec/`. See
DEVELOPMENT.md for the full schema workflow and when to rerun it.

## Mobile Setup

Prepare the BareKit backend bundle:

```bash
npm run bundle:backend
```

Run iOS:

```bash
npm run ios
```

Run Android:

```bash
npm run android
```

Build Android release artifacts locally:

```bash
npm run build:android:apk
npm run build:android:aab
```

The Android scripts run Expo prebuild and restore/write `android/local.properties` before Gradle runs.

## Electrobun Desktop Setup

Build and launch:

```bash
npm run desktop
```

Build assets only:

```bash
npm run desktop:build
```

Launch a previously built app:

```bash
npm run desktop:start
```

The desktop worker source is `packages/app/workers/desktop/index.ts`. `npm run desktop:build` compiles it, then packs it into `packages/app/desktop-build/build/workers/core/index.bundle` with native Bare addons offloaded beside the bundle. `npm run desktop:smoke --prefix packages/app` boots that packed worker through `pear-runtime` long enough to catch native addon load regressions.

Do not use `pear run` for local desktop work. Pear OTA/release automation is not wired.

## Relay Setup

Start the packaged relay:

```bash
docker compose -f docker-compose.relay.yml up -d
docker compose -f docker-compose.relay.yml exec relay /peartube-relay status --json
```

Open the archive UI:

```bash
open http://127.0.0.1:8174
```

The compose file exposes the archive UI on that port and persists relay storage
in the `peartube-relay-data` volume.

Archive a source URL:

```bash
docker compose -f docker-compose.relay.yml exec relay \
  /peartube-relay archive --url https://youtu.be/... --run-now
```

Use `docker-compose.local-relay.yml` for the local directory mirror workflow. Adjust the host-side `/home/user/peartube-local-videos` volume before running it.

The relay also provides a machine API (`/api/v2`) over HTTP on the same port (8174) as the Web UI. It is open by default (Nostr relay style) with no shared secret required. Standard Docker port publishing (`8174:8174`) exposes both the Web UI and the machine API.

Cloud offload is optional and S3-compatible only. Configure the bucket, endpoint, region, access key, and secret key through the relay environment shown in `docker-compose.relay.yml`. Offload stores verified asset blocks; it is not an HTTP playback origin.

## Troubleshooting

### Backend Not Starting On Mobile

```bash
npm run bundle:backend
```

### Schema Drift

```bash
npm run schema:full
npm test --prefix packages/spec
```

### Electrobun Desktop Shows Missing Handler Or Stale Export

```bash
npm run desktop:build
npm run desktop:smoke --prefix packages/app
npm run desktop
```

If the packed bundle reports stale `@peartube/*` source, remove stale physical workspace copies and reinstall:

```bash
rm -rf packages/app/node_modules/@peartube
npm run install:all
```

### iOS Pods Fail

```bash
cd packages/app/ios
rm -rf Pods Podfile.lock
npx pod-install
```

### Android SDK Path Missing

The app prebuild writes `android/local.properties` automatically. If you need to run Gradle manually, make sure `ANDROID_HOME` points at your SDK before invoking Gradle.

## CI Reference

- `.github/workflows/ci-fast.yml`: lint changed files, backend tests, platform typecheck, workflow regressions.
- `.github/workflows/build-mobile.yml`: Android debug/release artifacts and iOS simulator build.
- `.github/workflows/build-desktop.yml`: Electrobun desktop build/smoke.
- `.github/workflows/build-relay.yml`: relay build coverage.
- `.github/workflows/release-*.yml`: manually triggered or tag-based release artifact workflows.

Verify a change with `npm run lint:changed`, `npm run typecheck`, and `npm test`.
