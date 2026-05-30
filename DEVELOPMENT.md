# PearTube Development Guide

## Current Stack

- **App package:** `packages/app` (single package for iOS, Android, and Pear desktop)
- **Backend logic:** `packages/backend`
- **Platform bridge:** `packages/platform`
- **HRPC schema/runtime:** `packages/spec`

## Daily Commands

```bash
# Root-level
npm run ios
npm run android
npm run desktop
npm run desktop:build
npm run bundle:backend
npm run build:android:apk
npm run typecheck
```

## Mobile Notes

- Mobile backend is bundled into `packages/app/backend.bundle.js`.
- Downloader worker bundle (`packages/app/downloader-worker.bundle.js`) is optional at startup.
- If backend startup regresses after dependency changes, regenerate bundle:

```bash
npm run bundle:backend --prefix packages/app
```

## Desktop Notes

- Main desktop shell is Electrobun/Bun with embedded `pear-runtime`; do not add new `pear run` or `global.Pear.run` paths.
- `npm run desktop` builds and launches the Electrobun app.
- `npm run desktop:build` exports the Expo web app and compiles `packages/app/workers/desktop/index.ts` into `packages/app/desktop-build/build/workers/core/index.mjs`.
- Pear CLI deployment/runtime guidance changed in May 2026. See `docs/pear-runtime-evolution-readiness.md` before touching desktop release or OTA flows.

## Android Release Notes

- APK/AAB scripts run Android prebuild first to ensure Gradle project + `local.properties` are valid.
- Primary release commands:

```bash
npm run build:android:apk
npm run build:android:aab
```

## Backend/RPC Reliability Notes

- Shared HRPC handlers are registered in `packages/backend/src/backend-entry.js` via `registerSharedHandlers(...)`.
- Handler registration in `packages/backend/src/hrpc-handlers.js` is capability-based (only registers methods that exist on the current HRPC instance).
- Unknown HRPC commands are ignored safely in `packages/spec/spec/hrpc/index.js`, while missing handlers for request/response commands return explicit errors.

## Troubleshooting

### Desktop shows "No handler registered for command"

```bash
npm run desktop:build
npm run desktop
```

### Mobile backend does not start

```bash
npm run bundle:backend --prefix packages/app
```

### APK build fails after cleaning Android project

```bash
npm run build:android:apk
```

This script runs the required Android prebuild + SDK path setup automatically.
