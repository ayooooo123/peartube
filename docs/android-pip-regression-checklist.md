# Android PiP regression checklist

Use this checklist after any Android playback, mini-player, or PiP changes.

## Important
- Native changes under `packages/app/android/app/src/main/` (`PlayerActivity.kt`, `AndroidManifest.xml`) require a full Android rebuild/reinstall. The `expo-media-session` module this line used to name was removed in `5b7673098`.
- Android playback uses `react-native-video` / Media3.
- Do not reintroduce old-player-specific PiP bridge assumptions.

## Core scenarios

1. Fullscreen -> leave app -> PiP enters
- Start video in fullscreen
- Leave app once
- Confirm PiP enters

2. Repeated fullscreen PiP cycles
- Start video in fullscreen
- Leave app and return to app repeatedly
- Confirm PiP still enters on later cycles (at least 5-10 times)

3. Mini player active -> leave app -> PiP enters
- Start video in fullscreen
- Minimize to in-app mini player
- Leave app
- Confirm PiP enters

4. PiP exit -> immediate retry
- Enter PiP
- Return to app
- Leave app again immediately
- Confirm PiP enters again without needing a fresh video load

5. Mini player survives PiP path
- Start video
- Minimize to mini
- Leave app to PiP
- Return to app
- Confirm player state is sensible and playback continues

6. No runaway lifecycle churn
- While testing PiP cycles, watch logs for repeated background/foreground loops
- Confirm no `Maximum update depth exceeded`
- Confirm device does not get unusually hot from render/update loops

## Useful log lines
Capture app logs with PID when possible.

Look for:
- `PipBridge: onUserLeaveHint: pipEnabled=true`
- `PipBridge: onUserLeaveHint: entered PiP mode directly`
- `PipBridge: notifyPipModeChanged: isInPip=true`
- `PipBridge: notifyPipModeChanged: isInPip=false`
- `[VideoPlayerContext] Going to background`
- `[VideoPlayerContext] Coming to foreground`

## Notes for future changes
- Keep Android PiP entry native and simple.
- Prefer reliability over fancy transition behavior.
- Be cautious with mini-player rendering changes on Android; PiP is sensitive to native surface/layout assumptions.
- Avoid adding duplicate PiP re-arm paths in both JS and native without a very clear reason.
