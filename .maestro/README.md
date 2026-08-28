# Mobile E2E (Maestro)

Automated UI QA for the PearTube mobile app, used to validate behavior-level
regressions that CI's JS/lint/typecheck jobs can't catch — especially the
`VideoPlayerOverlayImpl` decomposition (gestures, fullscreen/landscape, PiP,
scrubber, cast).

## Flows

| Flow | Needs content? | Purpose |
| --- | --- | --- |
| `smoke.yaml` | No | App boots + tab shell renders + tab navigation. The **hard gate** — catches crashes/render regressions on a bare emulator. |
| `player.yaml` | **Yes** | Opens a video and exercises the player (fullscreen, rotate, scrubber, mini-player). Non-blocking until content is seeded. |
| `android-launch-only.yaml` | No | Cold launch only. Used as the first leg of the PiP repro harness. |
| `android-pip-*.yaml` | **Yes** | Five Android PiP paths: fullscreen-to-home, mini-to-home, deeplink-mini-to-home, open-from-feed-then-home, and wait-then-home. They catch PiP failing to enter, failing on repeated cycles, and losing state on return. |

Every flow lives here, so this is the one maestro root; the `android-pip-*` and
`android-launch-only` flows used to sit under `packages/app`. The driver still
belongs to that package: `npm run test:android:pip:repro --prefix packages/app`
runs `packages/app/scripts/maestro-android-pip-repro.sh`, which reads the flows
from here.

## Run locally

```bash
# Install Maestro: https://maestro.mobile.dev
curl -fsSL "https://get.maestro.mobile.dev" | bash

# Build + install a debug APK on a running emulator/device:
cd packages/app && npm run android   # or install android/app/build/outputs/apk/debug/app-debug.apk

# Run a flow:
maestro test .maestro/smoke.yaml
maestro test .maestro/player.yaml
```

`maestro studio` opens an interactive inspector for authoring new flows and
finding the right selectors.

## CI

`.github/workflows/e2e-mobile.yml` builds the debug APK (same recipe as
`build-mobile.yml`), boots an Android emulator (`reactivecircus/android-emulator-runner`),
installs the APK, and runs the flows. It is **opt-in** (heavy: ~20–40 min):

- triggers on `workflow_dispatch`, or
- on PRs labeled **`e2e-mobile`**.

Screenshots + JUnit results upload as the `maestro-results` artifact.

## Seeding content for `player.yaml`

A fresh CI emulator has no P2P peers, so the feed is empty and `player.yaml`
no-ops. To make it meaningful, do one of:

1. **Upload a local test video** through Studio at the start of the flow (add an
   `upload.yaml` flow that drives the Studio upload UI against a bundled asset), or
2. **Point at a known test channel** by deep-linking the app to a seeded
   `peartube://` route for a channel/video that a CI relay serves, or
3. **Run a local relay** seeded with one fixture video and join it from the
   emulator (mirrors `docker-compose.local-relay.yml`).

Once content is reliably present, remove the `|| true` guard on the `player.yaml`
step in `e2e-mobile.yml` so player regressions fail the build.

## testIDs to add (player.yaml depends on these)

As you decompose the player, add stable testIDs so flows survive refactors:
`video-card`, `player-overlay`, `player-fullscreen-button`, `player-scrubber`,
`mini-player`. Adding them per-extraction also makes each extracted piece
independently testable.
