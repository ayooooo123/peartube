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
npm run pear
npm run pear:build
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

- Pear dev command now uses `pear run --dev`.
- `npm run pear` (root) and `npm run pear:dev --prefix packages/app` both use the new CLI form.
- Desktop worker is compiled from `packages/app/pear-src/workers/core/index.ts` into `packages/app/pear/build/workers/core/index.js`.

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
npm run pear:build
npm run pear
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
