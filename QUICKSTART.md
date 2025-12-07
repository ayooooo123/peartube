# PearTube Quick Start

## Prerequisites

- Node.js 18+
- For iOS: Xcode 15+, CocoaPods
- For Desktop: Pear CLI (`npm install -g pear`)

## Setup

### 1. Install Dependencies

```bash
cd /Users/jd/projects/peartube
npm install
```

### 2. Run the App

#### iOS (Simulator)

```bash
npm run ios
```

This will:
1. Build the React Native app
2. Bundle the BareKit worklet
3. Launch in iOS Simulator
4. Start the P2P backend

#### Pear Desktop

```bash
npm run pear
```

This will:
1. Export Expo web build
2. Compile the worker
3. Launch Pear runtime
4. Display the desktop UI

## Project Structure

```
peartube/
├── packages/
│   ├── app/              # Unified app (mobile + desktop)
│   │   ├── app/          # Expo Router screens
│   │   ├── components/   # React components
│   │   ├── backend/      # Mobile BareKit worklet
│   │   └── pear-src/     # Desktop Pear assets
│   ├── backend/          # Backend business logic
│   ├── backend-core/     # P2P primitives
│   ├── core/             # Shared types
│   ├── platform/         # Platform abstraction
│   ├── rpc/              # RPC layer
│   ├── spec/             # HRPC schema
│   └── ui/               # Shared UI
└── package.json
```

## Available Commands

### From Root

```bash
npm run ios            # Run iOS app
npm run android        # Run Android app
npm run pear           # Run Pear desktop app
npm run pear:build     # Build Pear desktop only
npm run bundle:backend # Bundle mobile backend
npm start              # Start Expo dev server
```

### From packages/app

```bash
npm run ios            # Run iOS
npm run pear:dev       # Build and run Pear
npm run pear:build     # Build Pear only
npm run bundle:backend # Bundle backend worklet
```

## Troubleshooting

### iOS Build Fails

```bash
cd packages/app/ios
rm -rf Pods Podfile.lock
pod install
cd ..
npm run ios
```

### Pear Won't Start

Make sure Pear CLI is installed:
```bash
npm install -g pear
pear --version
```

### Backend Not Connecting

Check that the worklet bundle exists:
```bash
ls packages/app/backend.bundle.js
```

If missing, rebuild:
```bash
npm run bundle:backend
```

## What's Next?

- See [README.md](./README.md) for project overview
- See [ARCHITECTURE.md](./ARCHITECTURE.md) for technical details
