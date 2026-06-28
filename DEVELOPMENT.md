# PearTube Development Guide

PearTube development centers on the universal backend contract:

```text
client shell -> @peartube/platform -> @peartube/host -> @peartube/backend
```

Keep backend-facing changes in that shared path unless a limitation is truly runtime-specific.

## Daily Setup

```bash
nvm use
git submodule update --init --recursive
npm run install:all
npm run schema:full
```

Run `npm run bundle:backend` after backend, schema, or mobile runtime changes that affect the BareKit bundle.

## Root Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start Expo dev server |
| `npm run ios` | Prepare backend bundle/frameworks/pods and run iOS |
| `npm run android` | Prepare backend bundle, Android prebuild, and run Android |
| `npm run desktop` | Build and launch Electrobun desktop |
| `npm run desktop:build` | Build Electrobun web and worker assets |
| `npm run desktop:start` | Launch the built Electrobun app |
| `npm run desktop:native` | Schema, build, and run native macOS |
| `npm run desktop:native:build` | Schema and build native macOS |
| `npm run desktop:native:test` | Run native desktop tests |
| `npm run schema:full` | Regenerate JS schema output and copy Swift support |
| `npm run typecheck` | Typecheck `packages/platform` |
| `npm test` | Run spec, backend, and host tests |
| `npm run lint:changed` | Lint changed files |

## Package Focus

| Package | Common commands |
| --- | --- |
| `packages/spec` | `npm test --prefix packages/spec`, `npm run gen:schema --prefix packages/spec` |
| `packages/backend` | `npm test --prefix packages/backend`, `npm run test:watch --prefix packages/backend` |
| `packages/host` | `npm test --prefix packages/host` |
| `packages/platform` | `npm run typecheck --prefix packages/platform` |
| `packages/app` | `npm run bundle:backend --prefix packages/app`, `npm run desktop:build --prefix packages/app`, `npm run desktop:smoke --prefix packages/app` |
| `packages/desktop-native` | `npm run generate --prefix packages/desktop-native`, `npm run test --prefix packages/desktop-native` |
| `packages/cli` | `npm test --prefix packages/cli`, `npm run build:standalone --prefix packages/cli` |

## Schema Workflow

The schema source of truth is `packages/spec/schema.cjs`.

```bash
npm run schema:full
npm test --prefix packages/spec
```

`schema:full` does two things:

1. Regenerates JS HRPC/schema output under `packages/spec/spec/`.
2. Copies generated Swift schema/HRPC files into `packages/desktop-native/Sources/Support/`.

After adding or changing an RPC method:

- Update `packages/spec/schema.cjs`.
- Run `npm run schema:full`.
- Expose the behavior through `@peartube/backend`, `@peartube/host`, and `@peartube/platform` as needed.
- Rebuild mobile and desktop generated bundles if the runtime entrypoints depend on the change.

## Backend And RPC Notes

- `packages/host/src/contracts.js` owns `PROTOCOL_VERSION`.
- `packages/host/src/start-host.js` owns host lifecycle startup.
- `packages/backend/src/backend-entry.js` creates the universal backend, registers shared handlers, starts the core, and emits readiness.
- `packages/backend/src/hrpc-handlers.js` is the central shared HRPC handler registry.
- `packages/host/src/create-client.js` validates readiness and groups app-facing methods into namespaces such as `system`, `feed`, `channel`, `video`, `watch`, `transfer`, `search`, and `shell`.
- `packages/platform/src/rpc.shared.ts` is the common app-facing bridge used by platform-specific runners.

Network empty states should use `system.getSwarmStatus()` diagnostics instead of generic "no content" copy.

## Mobile Notes

- Mobile uses Expo + React Native UI with a BareKit worklet backend.
- The mobile backend entrypoint is `packages/app/backend/index.mjs`.
- The generated bundle is `packages/app/backend.bundle.js`.
- The downloader worker bundle is generated alongside the backend bundle.

```bash
npm run bundle:backend
```

## Electrobun Desktop Notes

- Main desktop uses an Expo web export hosted in Electrobun.
- The desktop worker source is `packages/app/workers/desktop/index.ts`.
- The packed worker artifact is `packages/app/desktop-build/build/workers/core/index.bundle`.
- `packages/app/scripts/build-desktop-bundle.mjs` verifies that packed `@peartube/*` source matches the live workspace.
- `npm run desktop:smoke --prefix packages/app` boots the packed worker through `pear-runtime` to catch native addon load regressions.

Do not restore `pear run` or `global.Pear.run` paths. The local desktop shell embeds `pear-runtime`; Pear OTA deployment is not wired.

## Native macOS Notes

- Native macOS is a SwiftUI client in `packages/desktop-native`.
- It talks to the same host/protocol/backend contract as mobile and Electrobun.
- It rejects unsupported protocol versions before applying backend data.
- The bridge lives in `packages/desktop-native/Bridge/` and `packages/desktop-native/Sources/Services/HostBridgeService.swift`.

```bash
npm run desktop:native:test
```

## Relay Notes

- Relay code lives in `packages/cli`.
- The root `docker-compose.relay.yml` runs the published relay image with archive UI enabled.
- `docker-compose.local-relay.yml` adds a local filesystem mirror volume.

```bash
npm test --prefix packages/cli
docker compose -f docker-compose.relay.yml up -d
```

## Verification Guidance

Use focused checks while iterating, then run the broader command before handing off a cross-package change:

```bash
npm run lint:changed
npm run typecheck
npm test
```

For platform work, add the matching build/smoke command:

```bash
npm run desktop:build
npm run desktop:smoke --prefix packages/app
npm run desktop:native:test
npm run build:android:apk
```

Last updated: 2026-06-26.
