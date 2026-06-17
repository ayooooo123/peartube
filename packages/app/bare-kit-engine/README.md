# Custom BareKit engine overrides (Android)

The default `react-native-bare-kit` ships `libbare-kit.so` built on **V8**
(`BARE_ENGINE=github:holepunchto/libjs`). On Android that lib is ~60 MB per ABI
and dominates the APK. Bare's engine is swappable via the `BARE_ENGINE` CMake
var to an ABI-compatible alternative (all implement the same `js.h`):

| `BARE_ENGINE` | Engine | Notes |
|---|---|---|
| `github:holepunchto/libjs`   | V8           | default, biggest, JIT |
| `github:holepunchto/libqjs`  | QuickJS      | ~3 MB, no JIT, modern ES — **recommended for Android** |
| `github:holepunchto/libmqjs` | Micro QuickJS| smaller still, reduced feature set |
| `github:holepunchto/libjsc`  | JavaScriptCore | embeds on Android (no system JSC); use the official build on iOS |
| `github:holepunchto/libjerry`| JerryScript  | smallest, ES5.1+partial — highest compat risk |

> iOS does **not** need any of this: Holepunch publishes an official
> JavaScriptCore BareKit (`ios-javascriptcore` xcframework) — point the iOS
> integration at it instead of forking.

## How the override is applied

`scripts/apply-bare-kit-engine.mjs` copies `<abi>/libbare-kit.so` from an engine
dir over the installed `react-native-bare-kit` JNI libs, **after** `npm install`
and **before** `gradlew assembleRelease`. With no override present it is a no-op,
so default V8 builds are untouched.

## Build a custom engine (reproducible — no committed binaries)

1. Run **`.github/workflows/build-bare-kit-engine.yml`** (Actions → Run workflow),
   pick `engine: libqjs`. It checks out `holepunchto/bare-kit` at the pinned tag,
   builds the Android AAR with `-DBARE_ENGINE=github:holepunchto/libqjs`, and
   uploads the four per-ABI `libbare-kit.so` as an artifact.
2. Download the artifact and place it here as `libqjs/<abi>/libbare-kit.so`.

These `.so` are **git-ignored on purpose** — they are reproducible build outputs,
not source. Do not commit them (that was the flaw in the original blob approach).

## Build APKs to compare

- **Locally:** `npm --prefix packages/app run build:android:apk:arm64:engine`
  (applies the override, then assembles the arm64 release APK).
  Compare against a stock build: `npm --prefix packages/app run build:android:apk:arm64`.
- **In CI (easiest):** run **`.github/workflows/android-engine-ab.yml`** — it
  builds the arm64 APK both stock (V8) and with QuickJS, uploads both, and prints
  the size delta in the job summary so you can install both and test
  functionality + speed yourself.
