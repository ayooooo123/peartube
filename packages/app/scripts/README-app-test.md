# app-test — local visual UI testing (all apps)

Local-only visual verification for the three PearTube client shells (iOS simulator, Android
emulator, Electrobun desktop). Captures the running app as periodic screenshots, and hands
them to cheap vision "eyes" that return text; the reasoning agent fixes UI code without ever
ingesting pixels. Maestro drives + gates mobile deterministically. **No CI is involved.**

Design notes live on the PearTube page in the Obsidian vault.

## Prerequisites

| Need | For | Install |
|---|---|---|
| Node ≥18 | the orchestrator + helpers | already in repo toolchain |
| ffmpeg / ffprobe | fixture video + `look.py` fallback only (not capture) | `brew install ffmpeg` |
| Maestro | mobile drive + gate | `curl -fsSL "https://get.maestro.mobile.dev" \| bash` |
| Android SDK (`adb`, `emulator`, `avdmanager`) | Android emulator | Android Studio |
| Xcode (`xcrun simctl`) | iOS simulator | App Store |
| Docker + Compose | relay content seeding (`--seed`) | Docker Desktop |
| Python 3 | `--eyes look` fallback only | system |

### One-time: create the fast Android AVD (Apple Silicon → arm64-v8a, native)

```bash
sdkmanager "system-images;android-34;google_apis;arm64-v8a"
avdmanager create avd -n peartube-arm64 -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_6
```

Override the AVD/sim names with `PEARTUBE_AVD` / `PEARTUBE_SIM`. If the named iOS sim doesn't exist,
the runner falls back to any available iPhone.

### Desktop capture permission

The invoking process needs **Screen Recording** permission (System Settings → Privacy & Security →
Screen Recording) — grant it to your terminal/runner. Without it `screencapture` fails with
`could not create image from display` (e.g. from a headless/unattended shell). Desktop capture is
**whole-screen** in v1 (macOS has no scriptable single-window video capture); window targeting is deferred.

## Usage

```bash
# from packages/app
npm run app:test:unit                              # helper unit tests

node scripts/app-test.mjs --platform android --seed --flow smoke   # drive + gate + eyes
node scripts/app-test.mjs --platform ios --flow smoke
node scripts/app-test.mjs --platform desktop                       # record-only (no gate)
node scripts/app-test.mjs --platform all --record-only             # capture current screens
```

### Flags

| Flag | Meaning |
|---|---|
| `--platform android\|ios\|desktop\|all` | required target(s) |
| `--attach <serial\|udid>` | use an already-booted device instead of booting one (Android: must be an `emulator-*` serial) |
| `--seed` | bring up the local relay seeded with the fixture video |
| `--record-only` | capture the current screen without driving a flow |
| `--eyes omp\|look` | `omp` (default): prepare frames for the agent's OMP vision; `look`: autonomous `look.py` |
| `--flow <name>` | Maestro flow under `.maestro/<name>.yaml` (default `smoke`) |

### Device selection — emulator-only (Android)

This flow **never touches a physical/wireless device**. Android auto-selection considers only
`emulator-*` serials; a connected phone is ignored. An explicit `--attach` to a non-emulator serial
is refused unless you set `PEARTUBE_ALLOW_DEVICE=1`. With no emulator running, it boots the
configured AVD (`PEARTUBE_AVD`, default `peartube-arm64`).

### Capture

All platforms capture **periodic screenshots** (~1/sec), not video: `adb exec-out screencap` (Android),
`xcrun simctl io screenshot` (iOS), `screencapture` (desktop). Emulator `screenrecord` is unreliable
(stops early, malformed mp4), and the eyes are frame-based anyway. Frames land in `<outDir>/frames/NNN.png`.
Desktop capture is **whole-screen** in v1 (macOS has no scriptable single-window video capture).

### Eyes backends

- **`omp`** (default, agent-driven): the CLI captures frames and writes `capture.eyes-manifest.json` +
  `EYES_TODO.txt`, then stops. The agent (see the `app-review` skill) describes the frames via OMP
  vision in a subagent and writes `capture.eyes.txt`. No API key. A Node CLI cannot call an OMP
  subagent itself — that step is the agent's.
- **`look`** (bare shell, no agent): runs `scripts/look.py` on each captured frame and joins the output.
  Needs `GEMINI_API_KEY` or `~/.config/gemini/key`.

### Content seeding

The relay (`docker-compose.local-relay.yml`) mirrors a **host directory** into the swarm. `--seed`
copies the fixture (`tests/fixtures/smoke-320x568-3s.mp4`) into `PEARTUBE_MIRROR_DIR`
(default `~/peartube-local-videos`) and brings the relay up; the compose volume is interpolated from
that variable. Readiness = the archive UI at `http://localhost:8174` (override `PEARTUBE_ARCHIVE_UI`).

## Artifacts

`packages/app/.artifacts/app-test/<timestamp>/<platform>/`: `frames/NNN.png`, `result.junit.xml`
(mobile), `capture.eyes.txt`, and the `omp` manifest (`capture.eyes-manifest.json`).

## Perf note

Record cold-boot + `smoke.yaml` wall time here for arm64-v8a vs x86_64 AVDs:

| AVD | ABI | cold boot + smoke |
|---|---|---|
| peartube-arm64 | arm64-v8a | _measure_ |
| peartube-pixel | x86_64 | _measure_ |
