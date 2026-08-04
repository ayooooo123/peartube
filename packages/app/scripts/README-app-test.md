# app-test — local visual UI testing (all apps)

Local-only visual verification for the three PearTube client shells (iOS simulator, Android
emulator, Electrobun desktop). Captures the running app, samples frames with ffmpeg, and hands
them to cheap vision "eyes" that return text; the reasoning agent fixes UI code without ever
ingesting pixels. Maestro drives + gates mobile deterministically. **No CI is involved.**

Spec: `docs/superpowers/specs/2026-08-04-app-visual-testing-cheap-eyes-design.md`
Plan: `docs/superpowers/plans/2026-08-04-app-visual-testing-cheap-eyes.md`

## Prerequisites

| Need | For | Install |
|---|---|---|
| Node ≥18 | the orchestrator + helpers | already in repo toolchain |
| ffmpeg / ffprobe | frame sampling, fixture | `brew install ffmpeg` |
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

Override the AVD/sim names with `PEARTUBE_AVD` / `PEARTUBE_SIM`.

### Desktop capture permission

macOS prompts for **Screen Recording** permission the first time `screencapture -v` runs. Grant it
(System Settings → Privacy & Security → Screen Recording). Desktop capture is **whole-screen** in v1
(macOS has no scriptable single-window video capture); window targeting is deferred.

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
| `--attach <serial\|udid>` | use an already-booted device instead of booting one |
| `--seed` | bring up the local relay seeded with the fixture video |
| `--no-build` | skip build/launch (device/app already running) |
| `--record-only` | capture the current screen without driving a flow |
| `--require-content` | fail (not skip) if the feed has no content |
| `--eyes omp\|look` | `omp` (default): prepare frames for the agent's OMP vision; `look`: autonomous `look.py` |
| `--flow <name>` | Maestro flow under `.maestro/<name>.yaml` (default `smoke`) |

### Eyes backends

- **`omp`** (default, agent-driven): the CLI samples frames and writes `eyes-manifest.json` +
  `EYES_TODO.txt`, then stops. The agent (see the `app-review` skill) describes the frames via OMP
  vision in a subagent and writes `capture.eyes.txt`. No API key. A Node CLI cannot call an OMP
  subagent itself — that step is the agent's.
- **`look`** (bare shell, no agent): shells out to `scripts/look.py` (native-video path). Needs
  `GEMINI_API_KEY` or `~/.config/gemini/key`. Optional `--opus` second opinion needs `ANTHROPIC_API_KEY`.

### Content seeding

The relay (`docker-compose.local-relay.yml`) mirrors a **host directory** into the swarm. `--seed`
copies the fixture (`tests/fixtures/smoke-320x568-3s.mp4`) into `PEARTUBE_MIRROR_DIR`
(default `~/peartube-local-videos`) and brings the relay up; the compose volume is interpolated from
that variable. Readiness = the archive UI at `http://localhost:8174` (override `PEARTUBE_ARCHIVE_UI`).

## Artifacts

`packages/app/.artifacts/app-test/<timestamp>/<platform>/`: `capture.mp4`, `result.junit.xml`
(mobile), `capture.eyes.txt`, and the `omp` manifest.

## Perf note

Record cold-boot + `smoke.yaml` wall time here for arm64-v8a vs x86_64 AVDs:

| AVD | ABI | cold boot + smoke |
|---|---|---|
| peartube-arm64 | arm64-v8a | _measure_ |
| peartube-pixel | x86_64 | _measure_ |
