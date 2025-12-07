# PearTube Setup Guide

## Prerequisites

- **Node.js 18+**: Required for all platforms
- **Xcode 15+**: Required for iOS development
- **CocoaPods**: Required for iOS native modules
- **Pear CLI**: Required for desktop (`npm install -g pear`)

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

**Pear Desktop:**
```bash
npm run pear
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
│   │   ├── pear-src/     # Desktop Pear source files
│   │   ├── pear/         # Built Pear output (generated)
│   │   ├── ios/          # iOS native project
│   │   └── Frameworks/   # iOS native addons
│   │
│   ├── backend/          # Backend business logic
│   ├── backend-core/     # P2P primitives
│   ├── core/             # Shared types
│   ├── platform/         # Platform abstraction
│   ├── rpc/              # RPC layer
│   ├── spec/             # HRPC schema
│   └── ui/               # Shared UI
│
└── package.json          # Root package with scripts
```

## Available Scripts

### Root Level

| Command | Description |
|---------|-------------|
| `npm run ios` | Run iOS app |
| `npm run android` | Run Android app |
| `npm run pear` | Build and run Pear desktop |
| `npm run pear:build` | Build Pear desktop only |
| `npm run bundle:backend` | Bundle mobile backend worklet |
| `npm start` | Start Expo dev server |

### Package Level (packages/app)

| Command | Description |
|---------|-------------|
| `npm run ios` | Run iOS app |
| `npm run pear:dev` | Build and run Pear |
| `npm run pear:build` | Build Pear only |
| `npm run pear:export` | Export Expo web |
| `npm run pear:worker` | Compile desktop worker |
| `npm run bundle:backend` | Bundle mobile worklet |

## Platform Architecture

### Mobile (iOS/Android)

- **React Native** app with Expo Router
- **BareKit** native worklet for P2P backend
- **HRPC** communication between app and worklet

### Desktop (Pear)

- **Expo web export** served by pear-electron
- **pear-run** worker for P2P backend
- **HRPC** communication via worker-client.js

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

### Pear Won't Launch

1. Check Pear is installed: `pear --version`
2. Rebuild: `npm run pear:build`
3. Check logs: `cd packages/app/pear && pear run --dev .`

### Backend Not Connecting

1. Check worklet exists: `ls packages/app/backend.bundle.js`
2. Rebuild: `npm run bundle:backend`

## Environment

- Node.js 18+
- iOS deployment target: 15.1
- Pear runtime: v2

---

**Last Updated**: 2025-12-07
