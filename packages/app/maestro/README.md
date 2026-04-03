PearTube Maestro Android PiP harness

Files
- maestro/android-launch-only.yaml
- maestro/android-pip-open-from-feed-and-home.yaml
- scripts/maestro-android-pip-repro.sh

What it does
- launches the app and waits for a backend-ready log signal from app/_layout.tsx
- opens the first Discover feed video via a stable in-app test hook
- waits for the fullscreen player overlay
- presses Home
- captures filtered logcat, dumpsys output, and a screenshot

Usage
- from packages/app:
  npm run test:android:pip:repro

Optional env vars
- PEARTUBE_VIDEO_ID
- PEARTUBE_CHANNEL_KEY
- PEARTUBE_PUBLIC_BEE_KEY
- PEARTUBE_VIDEO_TITLE
- PEARTUBE_VIDEO_DEEPLINK
- OUT_DIR
- APP_ID
- MAESTRO_BIN
- ADB_BIN

Default deep link fixture
- video id: 280881bcdf6cef11e60d22e19da9a111
- channel key: cd29fcc6aaeee3613b5febf64316ce0fb61f86e5e0a668de6c61b333525d0130

Artifacts
- .artifacts/maestro-pip/<timestamp>/backend-ready-wait.txt
- .artifacts/maestro-pip/<timestamp>/maestro-output.txt
- .artifacts/maestro-pip/<timestamp>/pip-filtered.txt
- .artifacts/maestro-pip/<timestamp>/app-logcat.txt
- .artifacts/maestro-pip/<timestamp>/full-logcat.txt
- .artifacts/maestro-pip/<timestamp>/dumpsys-activity.txt
- .artifacts/maestro-pip/<timestamp>/dumpsys-containers.txt
- .artifacts/maestro-pip/<timestamp>/after-home.png

Notes
- This harness is hybrid by design: Maestro drives the UI path, adb verifies PiP through logs/system state.
- The most important signals today are:
  - onUserLeaveHint: pipEnabled=true
  - notifyPipModeChanged: isInPip=true
  - presence/absence of the reconnect overlay symptoms in logs
