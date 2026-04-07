# bare-native Integration Plan

## Overview

Replace interpreted Bare Runtime processes with compiled bare-native binaries across all platforms. Three phases, each independent.

## Phase 1: Compiled Desktop Sidecar (Quick Win)

**Current**: SwiftUI spawns `bare-runtime` → loads `native-host-sidecar.bundle` (9MB interpreted bundle)
**Target**: SwiftUI spawns `peartube-host-sidecar` (single standalone binary with embedded runtime)

**Benefits**:
- No bare-runtime installation required
- Faster cold start (no bundle parsing)
- Smaller distribution (single binary vs runtime + bundle)
- Native addon prebuilds linked at compile time

**Implementation**:
- `scripts/build-native-sidecar.mjs` — calls `bare-build --standalone`
- `BareRuntimeSidecarSession.swift` — change binary path from `bare-runtime` to `peartube-host-sidecar`
- Build for `darwin-arm64` + `darwin-x64` (universal)
- Output to `Resources/Generated/peartube-host-sidecar`

**Status**: Build script created. Needs `bare-build` installed and Swift session updated.

## Phase 2: Lightweight Desktop App (Replace Electron)

**Current**: Expo web export → Electron (pear-electron) → ~200MB app
**Target**: bare-native app with HTML UI over WebSocket (like Ghost Drive's cellery approach) — ~10-20MB

**Architecture**:
```
bare-build --runtime bare-app-kit/runtime
  └── app.js
       ├── P2P backend (same as current)
       ├── HTTP server for blob streaming (same as current)
       └── cellery HTML UI server
            └── WebSocket → native WebView
```

**Tradeoffs**:
- Lose: React Native component ecosystem, shared codebase with mobile
- Gain: 10-20x smaller binary, native performance, no Chromium overhead
- Middle ground: use a WebView but render from the local HTTP server (keep React/Expo web export, just replace Electron with bare-native + WebView)

**Investigation needed**:
- Can `bare-app-kit` host a WebView? Or use `bare-gtk`/`bare-win-ui`?
- Alternatively: bare-native as backend + Tauri/Wry for lightweight WebView
- Evaluate cellery vs keeping React web export in a WebView

## Phase 3: Android Native Backend

**Current**: React Native → BareKit worklet (embedded Bare Runtime framework)
**Target**: React Native → JNI → bare-native compiled backend

**Architecture**:
```
bare-build --host android-arm64 --standalone
  └── peartube-backend (ELF binary with embedded runtime)
       ├── P2P backend
       ├── Blob server
       └── HRPC over stdin/stdout (or unix socket)
```

**Benefits**:
- Smaller APK (no BareKit framework — just one .so)
- Faster startup (compiled vs interpreted)
- Same IPC as desktop sidecar (stdin/stdout HRPC)

**Tradeoffs**:
- Lose: BareKit's shared-memory IPC (faster than stdin/stdout)
- Gain: Simpler build pipeline, unified sidecar architecture across platforms
- Risk: Android JNI loading of standalone executables may need custom loader

**Investigation needed**:
- Can `bare-build --host android-arm64 --standalone` produce a .so loadable via JNI?
- Benchmark stdin/stdout IPC vs BareKit IPC for video streaming latency
- Test with actual P2P workload on device

## Dependencies

```
bare-build >= 0.5.3
bare-build-darwin-arm64  (macOS Apple Silicon)
bare-build-darwin-x64    (macOS Intel)
bare-build-android-arm64 (Android)
bare-build-android-arm   (Android 32-bit)
```

## Reference

- [bare-build](https://github.com/holepunchto/bare-build)
- [Ghost Drive](https://github.com/Drache93/ghost-drive) — proof of concept for full bare-native P2P app
- [cellery](https://github.com/nicegamer7/cellery) — reactive HTML over WebSocket
