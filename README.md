# 🚨🚨🚨 HIGHLY EXPERIMENTAL 🚨🚨🚨
# PearTube

A decentralized P2P video streaming platform built on the Pear runtime and Hypercore Protocol.

## Features

- **Decentralized**: No central servers, pure P2P architecture
- **Self-sovereign**: Creators own their channels via cryptographic keypairs
- **Cross-platform**: iOS, Android, and Desktop (Pear) from a single codebase
- **Scalable**: Popular content automatically gets more seeders
- **Efficient**: Sparse replication - only download chunks you watch
- **Censorship-resistant**: No single point of control

## Architecture

PearTube is a monorepo with a unified app that serves both mobile and desktop:

```
peartube/
├── packages/
│   ├── app/              # Unified app (iOS, Android, Pear Desktop)
│   │   ├── app/          # Expo Router screens
│   │   ├── backend/      # Mobile BareKit worklet
│   │   ├── components/   # React Native components
│   │   └── pear-src/     # Desktop Pear worker & assets
│   ├── backend/          # Backend business logic (storage, API, P2P)
│   ├── core/             # Shared types and utilities
│   ├── platform/         # Platform abstraction layer
│   └── spec/             # HRPC schema definitions
└── package.json
```

### Tech Stack

- **React Native + Expo**: Cross-platform mobile development
- **Pear Runtime**: Desktop application framework
- **BareKit**: Native P2P runtime for mobile
- **HRPC**: Type-safe RPC over binary streams
- **Hyperswarm**: P2P networking and peer discovery
- **Hyperdrive**: Distributed file system for video storage
- **Hyperbee**: Key-value database for metadata

## Quick Start

### Prerequisites

- Node.js 18+
- For iOS: Xcode 15+, CocoaPods
- For Android: Android Studio, JDK 17
- For Desktop: Pear CLI (`npm install -g pear`)

### Setup

```bash
# Install all dependencies
npm run install:all

# Run iOS app
npm run ios

# Run Android app
npm run android

# Run Pear desktop app
npm run pear
```

## Development Commands

```bash
# Mobile
npm run ios          # Run iOS app
npm run android      # Run Android app
npm start            # Start Expo dev server

# Desktop
npm run pear         # Build and run Pear desktop app
npm run pear:build   # Build Pear desktop only

# Backend
npm run bundle:backend   # Bundle mobile backend worklet

# Quality
npm run typecheck    # Run TypeScript checks
npm run lint         # Run ESLint
npm run lint:fix     # Fix linting issues
```

## How It Works

### Platform Architecture

- **Mobile (iOS/Android)**: React Native app with BareKit worklet running P2P backend
- **Desktop (Pear)**: Expo web export served by Pear runtime with pear-run worker

Both platforms share:
- The same React components
- The same backend business logic (`@peartube/backend`)
- The same HRPC schema (`@peartube/spec`)

### Video Storage
- Each channel has a **Hyperdrive** for storing video files
- Videos are stored as MP4/WebM with thumbnail images
- Sparse replication: only download chunks you watch

### P2P Networking
- **Hyperswarm** manages peer connections
- Channels are discovered via a shared public feed
- Multiple peers can serve the same video

### Identity
- Self-sovereign keypairs
- Channels are tied to Hyperdrive keys
- Data stored locally at `~/.peartube`

## License

Apache-2.0
