# PearTube Quick Start

## Prerequisites

- Node.js 18+
- For iOS: Xcode 15+, CocoaPods
- For Desktop: Bun + Electrobun toolchain; Pear CLI is only needed for future OTA/deployment work

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

#### Electrobun Desktop

```bash
npm run desktop
```

This will:
1. Export Expo web build
2. Compile the worker
3. Launch the Electrobun shell with embedded `pear-runtime`
4. Display the desktop UI

## Project Structure

```
peartube/
├── packages/
│   ├── app/              # Unified app (mobile + desktop)
│   │   ├── app/          # Expo Router screens
│   │   ├── components/   # React components
│   │   ├── backend/      # Mobile BareKit worklet
│   │   ├── workers/      # Desktop Bare worker
│   │   └── src/          # Electrobun Bun/view bridge
│   ├── backend/          # Backend business logic
│   ├── core/             # Shared types + UI helpers
│   ├── platform/         # Platform abstraction
│   ├── spec/             # HRPC schema
│   ├── bare-ffmpeg/      # Bare native ffmpeg binding
│   ├── backend/src/cast/ # Chromecast sender implementation
│   ├── bare-mpv/         # mpv binding for desktop playback
│   └── bare-tls/         # TLS support for Bare runtime
└── package.json
```

## Available Commands

### From Root

```bash
npm run ios            # Run iOS app
npm run android        # Run Android app
npm run desktop        # Run Electrobun desktop app
npm run desktop:build  # Build desktop web/worker output only
npm run bundle:backend # Bundle mobile backend
npm run build:android:apk  # Build Android release APKs
npm start              # Start Expo dev server
```

### From packages/app

```bash
npm run ios            # Run iOS
npm run desktop:dev    # Build and run Electrobun desktop
npm run desktop:build  # Build desktop web/worker output only
npm run bundle:backend # Bundle backend worklet
npm run build:android:apk # Build release APKs
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

### Desktop Won't Start

Rebuild and launch the Electrobun app:
```bash
npm run desktop:build
npm run desktop
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

### Create Channel Hangs / "No handler registered"

If desktop logs include `No handler registered for command`, rebuild and relaunch Pear so worker and backend handler wiring are in sync:

```bash
npm run desktop:build
npm run desktop
```

## What's Next?

- See [README.md](./README.md) for project overview
- See [ARCHITECTURE.md](./ARCHITECTURE.md) for technical details
