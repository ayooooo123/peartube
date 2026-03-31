# Task: Playback state is not tracked properly in PiP / background / lockscreen

## Symptom
When in PiP, play/pause do not seem to work correctly. User suspects playback state tracking is wrong across:
- PiP
- background mode
- lock screen / media controls

## Goal
Do NOT patch blindly yet. First inspect the current playback-state architecture and research better approaches.

## Need to inspect
- `packages/app/lib/VideoPlayerContext.tsx`
  - `isPlaying`, `onPlaying`, `onPaused`, `onPlaybackStateChanged`, remote command listener
  - PiP transition guards that suppress pause/stop
- `packages/app/components/video-player/PearInlineVideoView.tsx`
  - `onPlaybackStateChanged`
  - `paused={!isPlaying}` and adapter play/pause methods
- `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`
  - `updatePipPlayState(...)`
  - media session callback play/pause/stop
  - `handlePipPlay/Pause/Stop`

## Hypothesis candidates
1. JS `isPlaying` is being treated as source-of-truth, but native ExoPlayer state changes during PiP/background are not reflected reliably
2. Remote commands update MediaSession state optimistically before the underlying player really changes
3. PiP-transition guards suppress pause/stop in ways that accidentally swallow real commands
4. Lock-screen/PiP transport should be driven by a dedicated transport-state model instead of ad hoc booleans/guards

## Discussion
