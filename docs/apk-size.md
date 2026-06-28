# Android APK / App Size — floor, levers, and dead ends

> Read this before re-running an APK-size investigation. The short version:
> **the big win (QuickJS) already shipped; the rest is the architectural floor.**

## TL;DR

- Installed: **~200 MB → ~144 MB** (arm64). The single big cut was the **QuickJS
  engine swap** (~50 MB), live since **v0.2.14**.
- You are at the **floor**: a React Native UI + the full Hypercore P2P stack
  (RocksDB) + an FFmpeg transcode engine + **two** JS runtimes. ~3–4 MB of the
  whole app is *our* code; the rest is dependencies you can't delete.
- **No packaging knob shrinks the real footprint** — they only move bytes
  between the APK file and `/data` at install time.

## Real composition (arm64, uncompressed ≈ on-device code)

Measured with `unzip -l` on the release APK:

| Component | Uncompressed | Owner |
|---|--:|---|
| `lib/` native libs | **43.8 MB** | RocksDB 8.5, FFmpeg ~5.5, React Native 6.5, QuickJS 3.0, Hermes 2.4, bare-* addons, … — **all load-bearing** |
| `assets/index.android.bundle` | 22.5 MB | RN/Expo framework JS + the Hypercore P2P stack (inlined) + ~3–4 MB of our code |
| `classes.dex` | 17.2 MB | RN / Expo / AndroidX framework (we write ~no Java/Kotlin) |
| `res/` + `resources.arsc` | 7.9 MB | mostly framework |
| **Total** | **~92 MB** | |

**Why <50 MB is impossible without compressing/removing libs:** native libs
(43.8) + resources (7.9) = **~52 MB before a single byte of app code or
framework dex**. The libs are load-bearing, so there is no code-trimming path
under 50 MB.

## What actually shrinks the footprint (and what we did)

- **QuickJS engine swap — THE win (~50 MB/ABI).** The BareKit backend runtime
  shipped V8 (~50 MB uncompressed). Swapped to QuickJS via Bare's `BARE_ENGINE`
  CMake knob (`github:holepunchto/libqjs`), wired into `release-android.yml`
  (builds `libbare-kit.so` with the engine + the `bare` escape-handle playback
  fix, overlays it before `assembleRelease`). **Only the release workflow applies
  this** — see gotcha below.
- **bare-ffmpeg slim (~2 MB).** Fork (`ayooooo123/bare-ffmpeg`) drops the
  `libvpx` + `libopus` external *encoder* libs; native `vp8/vp9/opus` *decoders*
  stay, `dav1d` (AV1) stays. Zero loss of decode/transcode/cast coverage.
- Baseline (pre-this-effort): R8 minify + resource shrink, Hermes, icon-font
  culling, per-ABI splits, dead-dep removal.

## Packaging gotchas (important — these cost us time)

1. **CI artifact size ≠ APK size.** GitHub Actions *re-zips* artifacts. The
   `peartube-arm64-v8a` artifact shows ~32 MB — that's the **zip of an ~88 MB
   APK**. Always check the **published release asset** size (or `unzip -l`), not
   the Actions artifact size.

2. **`useLegacyPackaging=false` (current) makes the APK *file* fat, not the
   install.** Native libs are stored **uncompressed + page-aligned** so they can
   be `mmap`'d → APK file ≈ **88 MB** (arm64) but install is lean (no
   extraction). `expo.useLegacyPackaging=true` would compress the libs → ~32 MB
   APK, **but** Android then **extracts** them to `/data` at install. That's a
   download-vs-install shuffle — **it does not shrink the real on-device
   footprint.** You can't `mmap` compressed data, so it's strictly either/or.
   Only flip it if *transfer/download* size is the pain (it isn't for footprint).

## Distribution

- `release-android.yml` builds **per-ABI split APKs** (`[arm64-v8a, x86,
  x86_64]`; armeabi-v7a intentionally skipped — see
  `ci-workflow-split-regression.test.mjs`). Sideload
  `peartube-<ver>-arm64-v8a.apk` for phones.
- **The QuickJS overlay only happens in `release-android.yml`.** EAS,
  Android Studio, and local `npm run build:android:apk` ship **stock V8** (and a
  universal APK). Don't use them for size-sensitive distribution — cut a tag.

## Ruled out — do not re-investigate

| Idea | Verdict |
|---|---|
| Dedup the two worklet bundles | No overlap — `downloader-worker.mjs` is self-contained (`bare-worker`/`bare-channel`/`bare-http1` + inline code) |
| Drop gluestack-ui / tamagui | tamagui was orphaned (deleted); **gluestack is load-bearing** on nativewind (~40 components, 63 importers) |
| Drop a JS runtime | Impossible — Hermes runs the RN UI, QuickJS runs the Bare P2P backend; different stacks, can't merge |
| Swap RocksDB | Welded into hypercore 11 via corestore (`new Corestore(path)`, RocksDB-only) — no pluggable backend |
| `vmSafeMode` / disable AOT | Trades ~15–25 MB of on-device dex2oat for slower UI; AOT is system-managed for sideloads anyway |
| `extractNativeLibs=true` | Relocates bytes (APK→`/data`); **does not reduce footprint** |

## Last untapped lever (low value, not recommended)

Fork **`rocksdb-native`** and strip its bundled compression libs
(snappy/lz4/zstd/zlib), same trick as FFmpeg. ~2–3 MB, **unverified**, and risks
the storage layer (compression affects the on-disk store and may be required by
`hypercore-storage`). Not worth ~2–3 MB against database-corruption risk.

## Bottom line

~3–4 MB of this app is our code. The rest is React Native + Expo + the Hypercore
stack + RocksDB + FFmpeg + two JS engines — a real minimum for a P2P video app.
QuickJS removed the one oversized outlier. Below ~144 MB installed requires
**re-architecting** (different storage engine, or moving the P2P backend off
Bare), not a dependency trim.
