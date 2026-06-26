# PearTube Setup Guide

This guide documents the current reproducible local setup. Start with [QUICKSTART.md](./QUICKSTART.md) if you only need the shortest path.

## Supported Toolchain

| Area | Requirement |
| --- | --- |
| Node.js | `.nvmrc` (`20.18.0`) or `package.json` engine range (`>=18 <23`) |
| Package manager | npm, using `npm run install:all` |
| Submodules | `packages/bare-ffmpeg` |
| iOS | Xcode, iOS simulator, CocoaPods |
| Android | Android Studio/SDK, JDK 17 |
| Electrobun desktop | Bun and Electrobun dependencies |
| Native macOS | Xcode and `xcodegen` |
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

`schema:full` regenerates:

- JS HRPC/schema output under `packages/spec/spec/`.
- Swift support files copied into `packages/desktop-native/Sources/Support/`.

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

Do not use `pear run` for local desktop work. Pear OTA/release automation is not wired; see [docs/pear-runtime-evolution-readiness.md](./docs/pear-runtime-evolution-readiness.md).

## Native macOS Setup

Install `xcodegen` if it is not already available:

```bash
brew install xcodegen
```

Generate, build, and run the SwiftUI app:

```bash
npm run desktop:native
```

Build without running:

```bash
npm run desktop:native:build
```

Run tests:

```bash
npm run desktop:native:test
```

Package-level commands are available under `packages/desktop-native`:

```bash
npm run generate --prefix packages/desktop-native
npm run build --prefix packages/desktop-native
npm run test --prefix packages/desktop-native
```

`generate` rebuilds the BareKit smoke bundles, Bare runtime, native host sidecar/worklet bundles, supporting frameworks, and the Xcode project.

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

Archive a source URL:

```bash
docker compose -f docker-compose.relay.yml exec relay \
  /peartube-relay archive --url https://youtu.be/... --run-now
```

Use `docker-compose.local-relay.yml` for the local directory mirror workflow. Adjust the host-side `/home/user/peartube-local-videos` volume before running it.

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

### Native macOS Project Missing Or Stale

```bash
npm run schema:full
npm run generate --prefix packages/desktop-native
```

## CI Reference

- `.github/workflows/ci-fast.yml`: lint changed files, backend tests, platform typecheck, workflow regressions.
- `.github/workflows/build-mobile.yml`: Android debug/release artifacts and iOS simulator build.
- `.github/workflows/build-desktop.yml`: Electrobun desktop build/smoke and native desktop tests/archive.
- `.github/workflows/build-relay.yml`: relay build coverage.
- `.github/workflows/release-*.yml`: manually triggered or tag-based release artifact workflows.

Last updated: 2026-06-26.
