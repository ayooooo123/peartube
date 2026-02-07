# Android PiP Playbook (Nitro VLC / React Native)

This doc is specific to the **Nitro VLC React Native library** used in PearTube (TextureView-based rendering), and the Android 12+ / 14+ Picture-in-Picture (PiP) behavior.

Related docs:
- `packages/app/docs/ANDROID_PIP_HANDOFF.md`
- `packages/app/docs/ANDROID_PIP_5050_SHIFT.md`
- `packages/app/docs/ANDROID_PIP_ZOOM_ISSUE.md`

## Scope

- Android 14+ (API 34+) primary target.
- Auto-enter PiP via `PictureInPictureParams.Builder.setAutoEnterEnabled(true)`.
- Player stack: React Native -> Nitro VLC (`HybridNitroVLCView.kt`) -> `TextureView`.

## Non-Negotiables (Hard Constraints)

1) Do not change `TextureView` LayoutParams during PiP enter/exit.
- Any Yoga/layout resize that reaches the native view can trigger `onSurfaceTextureSizeChanged` and destabilize the SurfaceTexture.

2) Avoid `updateVideoSurfaces()` during the PiP transition.
- Reconfiguring VLC while the system compositor is resizing/clipping is correlated with black frames, flashes, and the 50/50 artifact.

3) Do not rely on multiple RN styles emitting `transform`.
- RN style arrays do not deep-merge transforms. The last style with `transform` wins entirely.

## Android Seamless PiP Reality (Transition Gap)

On Android 12+, the system can begin shrinking the Activity/window before the JS PiP event arrives.

Practical impact:
- There is a period where the app is visually in a PiP-like shrunken state, but JS still thinks `isInPipMode=false`.
- Layout/cutout compensation must be robust in that gap.

## Key Failure Modes and Fixes

### A) "50/50 shift" artifact

Symptom:
- Enter PiP and the video appears vertically shifted, often showing a black/padded region as if half of the video is offset.

Root cause (in this repo):
- Fullscreen portrait cutout offset + system clipping during PiP.
- Any loss of the cutout compensation (e.g. transform override) makes the clipped region include the notch padding.

Fixes that worked:
- Early PiP layout detection (window shrink heuristic) to freeze PiP layout branches before the JS PiP event.
- Cutout compensation moved native-side:
  - Apply `textureView.translationY = -safeInsetTopPx` while in PiP.
  - Reset `translationY = 0` on PiP exit.
- Remove JS transform tricks for PiP cutout compensation to prevent RN transform override bugs.

### B) PiP appears zoomed/cropped

Symptom:
- Video looks like it is "too close" (cropped). Often only top-left is visible.

Root cause:
- Activity window shrinks to PiP, but the view hierarchy is still effectively fullscreen-sized.
- The system clips the fullscreen view into the smaller PiP window.

Fix that worked (native):
- Use `TextureView.setTransform(Matrix)` to scale/translate the rendered content into the PiP-visible region.

Implementation notes:
- Matrix must be recomputed when:
  - PiP window size changes (Configuration updates while dragging PiP), AND
  - TextureView size changes (it can jitter across frames/devices).

### C) "Drag fixes it" after a few cycles

Symptom:
- PiP is wrong until the user drags/resizes the PiP window, after which it becomes correct.

Root cause:
- Transform/matrix is only recomputed on window-size changes. Dragging emits configuration callbacks, forcing a recompute.

Fix:
- Recompute matrix on TextureView size changes (layout / surface size callbacks) even if PiP window size is unchanged.

### D) Duplicate PiP callbacks

Symptom:
- `notifyPipModeChanged(true)` appears twice (PiP mode + configuration changed).

Fix:
- Deduplicate stateful toggles (e.g. `setAllPipMode(true/false)`) so they only run when PiP state changes.
- Still apply matrix sizing on each configuration update while in PiP.

## Debugging Checklist

Log filters that were most useful:

```bash
adb logcat | grep -E "(PipBridge|NitroVLC|applyPipMatrix|updateVideoSurfaces|onSurfaceTextureSizeChanged|onLayoutChange)"
```

Signals to watch:
- If you see `updateVideoSurfaces()` firing during frequent size changes, expect flashes.
- If PiP is wrong until drag, matrix is not reapplying when the view size changes.
- If 50/50 returns intermittently, confirm no JS style returns `transform: []` wiping a needed transform.

## Implementation Map (Where the fixes live)

- PiP / MediaSession bridge:
  - `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`
- Nitro VLC player view:
  - `packages/react-native-nitro-vlc/android/src/main/java/com/margelo/nitro/com/nitrovlc/HybridNitroVLCView.kt`
- React overlay (early PiP detection + UI behavior):
  - `packages/app/components/VideoPlayerOverlay.tsx`
