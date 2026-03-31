# Task: Restore Android PiP entry after minimizing video in-app

## Exact reproduction
- Open video on Android
- Minimize the video in-app (mini player)
- After that, any later attempt to leave app and enter PiP fails

## Key implication
This strongly suggests the in-app mini player transition/minimize path is corrupting or disabling PiP state.
The likely bug is NOT generic PiP anymore; it is specifically an interaction between:
- `MINIMIZE` / mini-player mode
- auto-PiP enablement state
- MainActivity `onUserLeaveHint`

## Files to inspect
- `packages/app/components/VideoPlayerOverlayImpl.tsx`
  - auto-PiP effect
  - `playerMode === 'mini'` branches
  - PiP exit/re-arm logic
- `packages/app/lib/VideoPlayerContext.tsx`
  - AppState background path that maximizes mini player for PiP
  - minimize/maximize state transitions
- `packages/app/lib/playerStateMachine.ts`
  - `mini` + `APP_BACKGROUND` transitions
- `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`
  - `PipBridge.setPipEnabled`
  - `PipBridge.onUserLeaveHint`

## Current strongest hypothesis
The mini-player path leaves `setAutoPictureInPicture(false)` or `PipBridge.setPipEnabled(false)` active after a minimize/maximize cycle, or backgrounding from mini mode is not re-establishing fullscreen+pipEnabled in time.

## Goal
Find the smallest robust fix for: after minimizing the video in-app, leaving the app should still enter PiP reliably.

## Discussion
