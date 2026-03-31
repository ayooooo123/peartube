# Task: Make Android mini player PiP-safe by preserving a stable native video surface baseline

## Current understanding
- Fullscreen PiP is stable and repeatable
- PiP from in-app mini mode is not
- Native logs show on mini-mode app exit:
  - `onUserLeaveHint: pipEnabled=true`
  - `enterPictureInPictureMode(...)` is called
  - but NO `notifyPipModeChanged(true)` ever arrives
- So native PiP entry is attempted but silently rejected

## Strongest architectural clue
`packages/react-native-nitro-vlc/android/src/main/java/com/margelo/nitro/com/nitrovlc/HybridNitroVLCView.kt`
contains PiP logic that assumes a stable fullscreen-sized TextureView baseline.
Comments explicitly mention:
- stable fullscreen baseline
- scaling fullscreen-sized view into PiP window with a matrix
- avoiding expensive reconfiguration during PiP transitions

This strongly suggests the physically shrunken/moved mini-player surface is violating the native assumptions for PiP entry.

## Goal
For Android only, adjust mini-player rendering so the native video surface remains PiP-safe when the app is in mini mode.

## Candidate implementation direction
- Keep the native video surface / wrapper at fullscreen-sized dimensions on Android even when in mini mode
- Render the visible mini player using clipping/container transforms around that stable surface
- Or otherwise avoid physically shrinking the underlying native video surface that PiP entry depends on

## Files to inspect
- `packages/app/components/VideoPlayerOverlayImpl.tsx`
  - `containerStyle`
  - `videoStyle`
  - `videoPlayerStyle`
  - render tree around `renderVideoPlayer()`
- `packages/react-native-nitro-vlc/android/src/main/java/com/margelo/nitro/com/nitrovlc/HybridNitroVLCView.kt`
- `packages/app/components/video-player/VideoContainer.tsx`
- `packages/app/components/video-player/PearInlineVideoView.tsx`

## Requirement
Keep changes as simple and localized as possible. Prefer reliability over perfect transition animation.

## Discussion

## Claude Proposal

### Root cause

The render tree for the video surface is:

```
containerStyle (Animated.View)        ← position + outer size
  └─ videoStyle (Animated.View)       ← clip region / video area size
       └─ videoPlayerStyle (Animated.View)  ← position offset (cutout, etc.)
            └─ PearInlineVideoView    ← container style = absoluteFillObject
                 └─ <Video>           ← style = absoluteFill
```

In mini mode, `containerStyle` and `videoStyle` both interpolate down to the
mini-player dimensions (~160×90 dp). Because `PearInlineVideoView` and `<Video>`
use `absoluteFill`, the native `TextureView` inside `react-native-video`
physically shrinks to those same mini dimensions.

When the user then backgrounds the app:
1. `onUserLeaveHint()` fires, `enterPictureInPictureMode()` is called.
2. Android inspects the activity window to capture a PiP surface.
3. The only video surface it finds is a tiny ~160×90 TextureView positioned in
   a corner of the window. Android silently rejects PiP entry (no
   `notifyPipModeChanged(true)` callback).

Even with commit `43fc66a` (maximize-before-PiP fallback), the race is tight:
`onUserLeaveHint` fires synchronously before the JS MAXIMIZE dispatch can
complete a layout pass, so the TextureView may still be at mini dimensions when
`enterPictureInPictureMode` runs.

### Proposed fix — "hidden fullscreen surface" on Android

**One change, one file: `videoPlayerStyle` in `VideoPlayerOverlayImpl.tsx`.**

On Android, keep `videoPlayerStyle` at fullscreen dimensions *always* — even
during mini mode. The visible mini-player appearance is already controlled by
`containerStyle` (which sets `overflow: 'hidden'`, `borderRadius`, position,
and clipping). The `videoPlayerStyle` child just needs to fill a large enough
area that the native TextureView never shrinks.

#### Concrete change (in `videoPlayerStyle` worklet, ~line 1730):

```ts
const videoPlayerStyle = useAnimatedStyle(() => {
  'worklet'

  // Android PiP: freeze at fullscreen dimensions (existing PiP branch)
  if (isPipLayoutActiveShared.value && Platform.OS === 'android') {
    return { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
  }

  // iOS PiP branch (unchanged)
  if (isPipLayoutActiveShared.value) {
    return {
      position: 'absolute', top: 0, left: 0,
      width: screenWidthShared.value,
      height: videoHeightShared.value,
    }
  }

  // ── NEW: Android mini-mode PiP-safety ──
  // Keep the native video surface at fullscreen size on Android even in mini
  // mode. The outer containerStyle already clips to mini dimensions with
  // overflow:'hidden'. This ensures the TextureView stays fullscreen-sized
  // so Android PiP entry always finds a viable surface.
  if (Platform.OS === 'android') {
    const cutoutFactor = interpolate(animProgress.value, [0.8, 1], [0, 1], Extrapolation.CLAMP)
    return {
      position: 'absolute',
      top: 0,
      left: 0,
      width: screenWidthShared.value,
      height: videoHeightShared.value,
    }
  }

  // iOS / web: interpolate normally (existing code, unchanged)
  const cutoutFactor = interpolate(animProgress.value, [0.8, 1], [0, 1], Extrapolation.CLAMP)
  // ... rest of existing iOS logic ...
})
```

#### Why this works

1. **containerStyle already clips**: In mini mode, `containerStyle` sets
   `width: miniW, height: miniH, overflow: 'hidden', borderRadius: 12`. The
   user sees a small rounded mini-player window. Inside, the `videoPlayerStyle`
   child can be larger — it's just clipped.

2. **TextureView stays fullscreen**: The `<Video>` component's TextureView
   occupies the full `videoPlayerStyle` dimensions (via `absoluteFill`). It
   never shrinks below `screenWidth × videoHeight`, so Android always finds a
   full-size video surface for PiP capture.

3. **VLC Kotlin code not involved**: The current player is `react-native-video`
   (ExoPlayer), not Nitro VLC. The `HybridNitroVLCView.kt` PiP guards are
   irrelevant to this path. But the same principle applies: don't shrink the
   native surface.

4. **Minimal blast radius**: Only `videoPlayerStyle` changes, only on Android.
   `containerStyle` and `videoStyle` remain untouched. iOS is unaffected.

#### What to verify

- **Overflow clipping**: ✅ Confirmed — `containerStyle` already sets
  `overflow: 'hidden'` in the interpolated branch (line 1574). No change needed.

- **Touch hit area**: The oversized `videoPlayerStyle` won't receive touches
  outside the clipped `containerStyle` bounds because the gesture detector is
  on the `containerStyle` level.

- **Mini-player aspect ratio**: The visible video content in the mini window
  will show the center-top portion of the fullscreen layout. VLC/ExoPlayer's
  `resizeMode="contain"` letterboxes within the full surface, so the mini clip
  will show the video centered horizontally. This should look correct for 16:9
  content.

### Alternatives considered

1. **maximize-before-PiP (current approach, commit 43fc66a)**: Race condition —
   `onUserLeaveHint` is synchronous, layout pass is async. The TextureView is
   still mini-sized when `enterPictureInPictureMode` runs.

2. **Native pre-PiP maximize in `onUserLeaveHint`**: Would require the Kotlin
   side to somehow force a layout pass before calling `enterPictureInPictureMode`.
   Fragile and platform-version-dependent.

3. **Scale transform instead of clipping**: Apply `transform: [{ scale: ratio }]`
   on the container to visually shrink while keeping layout dimensions. More
   complex and affects touch handling.

The proposed approach (option 0: never shrink the native surface) is the
simplest and most aligned with the existing PiP architecture in
`HybridNitroVLCView.kt`, which already uses the same "fullscreen surface +
visual transform" strategy for PiP mode itself.
