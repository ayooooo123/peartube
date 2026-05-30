# PearTube Setup Guide

## Prerequisites

- **Node.js 18+**: Required for all platforms
- **Xcode 15+**: Required for iOS development
- **CocoaPods**: Required for iOS native modules
- **Bun + Electrobun toolchain**: Required for the main desktop shell
- **Pear CLI**: Required only for future Pear OTA/deployment work, not for local desktop launch

## Installation

### 1. Clone and Install

```bash
git clone <repo-url>
cd peartube
npm install
```

This installs dependencies for all packages in the monorepo.

### 2. iOS Setup

```bash
cd packages/app/ios
pod install
cd ..
```

### 3. Run the App

**iOS:**
```bash
npm run ios
```

**Electrobun Desktop:**
```bash
npm run desktop
```

## Project Structure

```
peartube/
├── packages/
│   ├── app/              # Unified app (mobile + desktop)
│   │   ├── app/          # Expo Router screens
│   │   │   ├── (tabs)/   # Tab screens
│   │   │   │   ├── index.tsx      # Mobile home
│   │   │   │   ├── index.web.tsx  # Desktop home
│   │   │   │   ├── settings.tsx
│   │   │   │   ├── studio.tsx
│   │   │   │   └── subscriptions.tsx
│   │   │   ├── video/
│   │   │   │   └── [id].tsx       # Video player
│   │   │   └── _layout.tsx        # Root layout
│   │   ├── components/   # Shared React components
│   │   ├── lib/          # App utilities
│   │   ├── backend/      # Mobile BareKit worklet source
│   │   ├── workers/      # Desktop Bare worker source
│   │   ├── src/bun/      # Electrobun/Bun desktop main process
│   │   ├── src/view/     # Electrobun renderer bridge
│   │   ├── desktop-build/# Built desktop web/worker output (generated)
│   │   ├── ios/          # iOS native project
│   │   └── Frameworks/   # iOS native addons
│   │
│   ├── backend/          # Backend business logic
│   ├── core/             # Shared types
│   ├── platform/         # Platform abstraction
│   ├── spec/             # HRPC schema
│   ├── bare-ffmpeg/      # Bare ffmpeg binding
│   ├── backend/src/cast/ # Cast integration
│   ├── bare-mpv/         # mpv integration
│   └── bare-tls/         # Bare TLS support
│
└── package.json          # Root package with scripts
```

## Available Scripts

### Root Level

| Command | Description |
|---------|-------------|
| `npm run ios` | Run iOS app |
| `npm run android` | Run Android app |
| `npm run desktop` | Build and run Electrobun desktop |
| `npm run desktop:build` | Build desktop web/worker output only |
| `npm run bundle:backend` | Bundle mobile backend worklet |
| `npm run build:android:apk` | Build Android release APKs |
| `npm start` | Start Expo dev server |

### Package Level (packages/app)

| Command | Description |
|---------|-------------|
| `npm run ios` | Run iOS app |
| `npm run desktop:dev` | Build and run Electrobun desktop |
| `npm run desktop:build` | Build desktop web/worker output only |
| `npm run desktop:export` | Export Expo web |
| `npm run desktop:worker` | Compile desktop worker |
| `npm run bundle:backend` | Bundle mobile worklet |
| `npm run build:android:apk` | Build release APKs |

## Platform Architecture

### Mobile (iOS/Android)

- **React Native** app with Expo Router
- **BareKit** native worklet for P2P backend
- **HRPC** communication between app and worklet

### Desktop (Electrobun + pear-runtime)

- **Expo web export** served in an Electrobun view
- **Bare worker** launched by embedded `pear-runtime`
- **HRPC** communication via the `window.bridge` transport in `packages/platform/src/rpc.web.ts`

Both platforms share:
- Same React components (with `.web.tsx` variants)
- Same backend logic (`@peartube/backend`)
- Same HRPC schema (`@peartube/spec`)

## Troubleshooting

### iOS Pod Install Fails

```bash
cd packages/app/ios
rm -rf Pods Podfile.lock
pod install --repo-update
```

### Xcframework Conflicts

If you see "conflicting framework names", remove duplicates:
```bash
cd packages/app/Frameworks
# Remove frameworks that are also in node_modules/react-native-bare-kit/ios/addons/
```

### Desktop Won't Launch

1. Rebuild: `npm run desktop:build`
2. Launch: `npm run desktop`
3. Check `packages/app/src/bun/index.ts` worker startup logs and `packages/app/src/view/index.ts` bridge logs.

### Backend Not Connecting

1. Check worklet exists: `ls packages/app/backend.bundle.js`
2. Rebuild: `npm run bundle:backend`

### "No handler registered for command" on Desktop

1. Rebuild desktop app + worker: `npm run desktop:build`
2. Relaunch desktop app: `npm run desktop`
3. Confirm the Electrobun bridge reaches the Bare worker through embedded `pear-runtime`.

## Environment

- Node.js 18+
- iOS deployment target: 15.1
- Desktop runtime: Electrobun + embedded `pear-runtime`
- Pear CLI deployment/runtime note: `pear run` is deprecated upstream; see `docs/pear-runtime-evolution-readiness.md` before adding desktop OTA release automation.

---

**Last Updated**: 2026-02-27
