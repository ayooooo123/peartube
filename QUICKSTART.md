# PearTube Quick Start

Use this when you want a fresh clone running with the current development flow.

## 1. Prerequisites

- Node.js from `.nvmrc`:

```bash
nvm use
```

- Git submodules enabled.
- For iOS: Xcode and CocoaPods.
- For Android: Android SDK and JDK 17.
- For Electrobun desktop: Bun and Electrobun dependencies.

## 2. Install

```bash
git submodule update --init --recursive
npm run install:all
npm run schema:full
npm run bundle:backend
```

`install:all` is the repo install contract used by CI. `schema:full` keeps generated JS schema output in sync. `bundle:backend` creates the BareKit mobile backend bundle used by iOS/Android runs.

## 3. Run A Surface

```bash
npm run ios                 # iOS simulator
npm run android             # Android emulator/device
npm run desktop             # Electrobun desktop
```

For Expo-only iteration:

```bash
npm start
```

## 4. Relay Container

```bash
docker compose -f docker-compose.relay.yml up -d
docker compose -f docker-compose.relay.yml exec relay /peartube-relay status --json
open http://127.0.0.1:8174
```

## 5. Verify A Change

```bash
npm run lint:changed
npm run typecheck
npm test
```

Use focused package tests when possible:

```bash
npm test --prefix packages/spec
npm test --prefix packages/backend
npm test --prefix packages/host
```

## Troubleshooting

### Backend bundle missing

```bash
npm run bundle:backend
```

### Schema output drift

```bash
npm run schema:full
```

### Electrobun desktop worker stale

```bash
npm run desktop:build
npm run desktop
```

## More Detail

- [SETUP.md](./SETUP.md) for platform-specific setup.
- [DEVELOPMENT.md](./DEVELOPMENT.md) for daily commands.
- [DEV_STATUS.md](./DEV_STATUS.md) for current progress and known constraints.
- [ARCHITECTURE.md](./ARCHITECTURE.md) for the live architecture map.
