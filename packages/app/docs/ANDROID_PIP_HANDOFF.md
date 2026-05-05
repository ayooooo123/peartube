# Android PiP Handoff — Remaining Issues (Feb 2026)

## Target: Android 14+ only (API 34+). Uses `setAutoEnterEnabled(true)`.

## What's Working

- **50/50 shift on FIRST PiP entry is FIXED** — early PiP detection (`isPipLayoutActiveShared`) freezes layout before JS `isInPipMode` event arrives
- **Black screen during PiP is FIXED** — frozen shared values prevent TextureView resize
- **Native VLC reconfig is BLOCKED** — `pipModeActive` flag + `isEffectivelyInPip()` guard on `applySurfaceSize`, `onNewVideoLayout`, `applyAspectRatio`, `scheduleDeferredSurfaceSync`
- **PiP exit works** — video returns to fullscreen correctly
- **Media session controls work** — play/pause/seek via PiP action buttons

## Three Remaining Issues

### Issue 1: Initial PiP is "zoomed in" (doesn't fill PiP window properly)

**What the user sees:** Video fills PiP correctly in terms of no black space / no shift, but the video appears zoomed/cropped — only a portion of the video is visible, as if the camera is too close.

**Root cause:** The `containerStyle` PiP branch freezes the container at full-screen dimensions (`realScreenWidthShared` x `realScreenHeightShared` = e.g. 412x892dp). But Android 12+ seamless PiP actually SHRINKS the Activity window to PiP size (e.g. ~250x140dp). The frozen full-screen container overflows the PiP-sized window. Android clips the overflow — only the top-left portion of the 412x892 container is visible in the 250x140 PiP window. This makes the video appear "zoomed in" because you're seeing a cropped section.

**The core tension:**
- TextureView LayoutParams MUST NOT change during PiP (→ SurfaceTexture destroyed → black screen)
- But freezing the container at full-screen dimensions causes cropping in the PiP-sized window
- Need a way to VISUALLY scale the container to fit the PiP window WITHOUT changing layout dimensions

**Potential solutions:**

**A. Reanimated `transform: [{scaleX}, {scaleY}]` on the container**
Add scale transforms to the containerStyle PiP branch to visually shrink the full-screen-sized container to fit the PiP window. Transform-based scaling doesn't trigger Yoga relayout, so TextureView LayoutParams stay unchanged.

```typescript
// In containerStyle PiP branch:
// Need raw window dimensions (not screen-fallback) for PiP size
const pipScaleX = windowWidthShared.value / realScreenWidthShared.value
const pipScaleY = windowHeightShared.value / realScreenHeightShared.value
const scale = Math.min(pipScaleX, pipScaleY)
return {
  ...frozenFullscreenDims,
  transform: [
    { translateX: -(realScreenWidthShared.value * (1 - scale) / 2) },
    { translateY: -(realScreenHeightShared.value * (1 - scale) / 2) - cutoutShift },
    { scale: scale },
  ],
}
```

**Challenge:** `screenWidthShared`/`screenHeightShared` are set to `screenMetrics.width/height` (full screen) because `isAndroidFullscreen` → `useScreenFallback = true`. Need a SEPARATE pair of shared values for raw `windowWidth`/`windowHeight` (from `useWindowDimensions()`). These are the actual PiP window dimensions.

**B. Native-side View transform (bypass React entirely)**
In `HybridNitroVLCView.kt`, when `pipModeActive = true`, apply `View.setScaleX/Y` with `pivotX=0, pivotY=0` directly on the FrameLayout container. This scales the TextureView's visual output without changing LayoutParams. The old SurfaceView VLC player used this approach successfully.

```kotlin
// In HybridNitroVLCView or NitroVLCViewManager
fun applyPipTransform(pipWidth: Int, pipHeight: Int) {
  val parent = textureView.parent as? FrameLayout ?: return
  val scaleX = pipWidth.toFloat() / parent.width
  val scaleY = pipHeight.toFloat() / parent.height
  parent.pivotX = 0f
  parent.pivotY = 0f
  parent.scaleX = scaleX
  parent.scaleY = scaleY
}
```

**Challenge:** Need PiP window dimensions at the native level. Available from `Configuration.screenWidthDp/screenHeightDp` in `onPictureInPictureModeChanged`, or from the Activity window metrics.

**C. Don't freeze — let container resize, but freeze TextureView LayoutParams natively**
Instead of freezing the Reanimated layout, let the container resize naturally to PiP dimensions. But override the TextureView's LayoutParams in `NitroVLCViewManager` to fixed pixel dimensions when `pipModeActive = true`. The TextureView stays at full-screen resolution, Android scales its visual output to fit the smaller parent (TextureView natively handles this).

**Risk:** Changing the TextureView's PARENT dimensions may still trigger `onSurfaceTextureSizeChanged`. Need to test whether the SurfaceTexture survives parent resize when LayoutParams are fixed.

---

### Issue 2: Dragging PiP window triggers fullscreen controls + wrong zoom

**What the user sees:** When touching/dragging the PiP window, fullscreen playback controls (play/pause, seek buttons, minimize chevron) appear inside the tiny PiP window. The video also shows a "different zoomed in fit" — the layout transitions between fullscreen and mini states.

**Root cause (gestures):** The `GestureDetector` with `panGesture` wraps the video content (line 3022-3046). In PiP, `animProgress.value = 1` (fullscreen), so `gestureStartedInFullscreen = 1`. The `onUpdate` fullscreen branch (line 1155-1160) interprets vertical drag as "drag to minimize" and changes `animProgress` from 1→0. This makes the container animate between fullscreen and mini-player sizes, causing the "different zoomed in fit."

```typescript
// Line 1087-1111: panGesture.onStart — NO PiP guard!
.onStart(() => {
  'worklet'
  if (isLandscapeFullscreenShared.value) return  // only checks landscape
  isGestureActive.value = true  // activates in PiP!
  gestureStartedInFullscreen.value = animProgress.value >= 0.5 ? 1 : 0  // = 1 in PiP
})
```

**Root cause (controls):** `handleVideoTap` (line 802-816) checks `playerMode === 'fullscreen'` to toggle controls. During PiP, `playerMode` IS `'fullscreen'`, so taps show controls. Additionally, the overlay content (line 2776) uses `(showControls || isInPipMode)` — controls are ALWAYS rendered when `isInPipMode` is true.

**Fix:** Add PiP guards to both the gesture handler and the tap handler:

```typescript
// panGesture.onStart — add PiP guard
.onStart(() => {
  'worklet'
  if (isLandscapeFullscreenShared.value) return
  if (isPipLayoutActiveShared.value) return  // <-- ADD THIS
  isGestureActive.value = true
  // ...
})

// handleVideoTap — add PiP guard
const handleVideoTap = useCallback(() => {
  if (isInPipMode) return  // <-- ADD THIS
  if (playerMode === 'fullscreen' || isLandscapeFullscreen) {
    // toggle controls...
  }
}, [playerMode, isLandscapeFullscreen, isInPipMode, showControls, ...])

// overlayContent line 2776 — remove isInPipMode from condition
{(playerMode === 'fullscreen' || isLandscapeFullscreen) && showControls && !isInPipMode && (
  <Animated.View style={[styles.controlsOverlayBase, controlsOverlayStyle]}>
```

---

### Issue 3: 2nd PiP entry — 50/50 shift returns

**What the user sees:** First PiP entry looks correct (except the zoom issue). After exiting PiP and re-entering, the 50/50 shift reappears.

**Root cause hypothesis A — Frozen values are stale:**
After PiP exit, `isPipLayoutActive` becomes `false` (window dimensions match screen again), so frozen values start updating. But there may be a brief window where:
1. PiP exit: `isInPipMode` goes `false`, `windowWidth/Height` are still PiP-sized (one more render)
2. `isPipLayoutActive` is computed as `true` (PiP-sized dims still < 0.9 * screen)
3. Frozen values DON'T update (still holding first-entry values)
4. Next render: window goes back to fullscreen, `isPipLayoutActive = false`, frozen values update to correct fullscreen values
5. But by this point, something may be wrong — e.g. `frozenInsetTopShared` updated with a stale `stableInsetTopRef.current` that was 0 from PiP

**Root cause hypothesis B — `lastAppliedSurfaceWidth/Height` tracking is off:**
During PiP exit, `setAllPipMode(false)` unblocks VLC reconfig. The deferred surface sync (120ms delayed `Runnable`) may fire with stale PiP-exit dimensions. `lastAppliedSurfaceWidth/Height` gets set to an intermediate value. On 2nd PiP entry, the `isPipLikeShrink` heuristic (`newArea < prevArea / 4`) may fail because `prevArea` is already small.

**Root cause hypothesis C — `stableInsetTopRef` stuck at 0:**
On PiP exit, `insets.top` might briefly be `0` before the status bar reappears. The `isPipInsetArtifact` guard checks `playerMode === 'fullscreen' && insets.top === 0 && stableInsetTopRef.current > 0`. If `stableInsetTopRef.current` was already reset to `0` during PiP (because at some point the guard condition wasn't met), it stays 0. Then `frozenInsetTopShared = 0` → no cutout compensation → 50/50 shift on re-entry.

**Debugging approach:**
Add `console.log` in the render body to trace on each render:
```typescript
console.log('[PiP Debug]', {
  isInPipMode, isPipLayoutActive,
  windowWidth, windowHeight,
  screenMetrics: `${screenMetrics.width}x${screenMetrics.height}`,
  stableInsetTop: stableInsetTopRef.current,
  stableInsetBottom: stableInsetBottomRef.current,
  frozenVideoHeight: frozenVideoHeightShared.value,
  frozenInsetTop: frozenInsetTopShared.value,
  videoHeight,
})
```
Run through PiP entry → exit → re-entry and watch the log to see where values go wrong.

---

## Architecture Overview

### View Hierarchy (Fullscreen Portrait)

```
<Animated.View style={[styles.container, containerStyle, containerDragStyle]}>
  <GestureDetector gesture={panGesture}>
    <Animated.View style={[styles.videoWrapper, videoStyle]}>
      <Pressable onPress={handleVideoTap}>
        <Animated.View style={videoPlayerStyle}>
          <VlcVideoView style={absoluteFill}>
            <NitroVLCView (FrameLayout)>
              <TextureView MATCH_PARENT>   ← VLC renders here
```

### How Android 12+ Seamless PiP Works

1. `setAutoEnterEnabled(true)` set via `updateActivityPipParams()`
2. User swipes home → `onUserLeaveHint()` fires
3. `notifyNitroVlcViews(true)` → sets `pipModeActive = true` on all VLC views
4. System GRADUALLY SHRINKS the Activity window dimensions
5. `useWindowDimensions()` fires React re-renders with intermediate sizes
6. `isInPipMode` is still `false` (JS event hasn't arrived)
7. **This is the "transition gap"** — layout code sees small window, no PiP flag
8. `onPictureInPictureModeChanged(true)` fires → JS event → `isInPipMode = true`

### Early PiP Detection (`isPipLayoutActiveShared`)

Bridges the transition gap. Detects PiP from window dimension shrinkage:
```typescript
const isPipLayoutActive = isInPipMode || (
  Platform.OS === 'android'
  && playerMode === 'fullscreen'
  && windowWidth < screenMetrics.width * 0.9   // both must shrink
  && windowHeight < screenMetrics.height * 0.9  // avoids split-screen false positive
)
```

### Frozen Shared Values

Hold pre-PiP fullscreen values. Updated only when `!isPipLayoutActive`:
- `frozenVideoHeightShared` — video height at fullscreen
- `frozenInsetTopShared` — camera cutout inset at fullscreen
- `frozenInsetBottomShared` — bottom inset at fullscreen

### Stable Inset Refs

`stableInsetTopRef` / `stableInsetBottomRef` resist dropping to 0 during PiP transition. Android changes `insets.top` to 0 before `isInPipMode` is true. Guard: if Android + fullscreen + insets.top = 0 + previous > 0, keep previous value.

### Native PiP Guards (HybridNitroVLCView.kt)

- `pipModeActive` volatile flag — set via `setAllPipMode()` from `MediaSessionModule`
- `isEffectivelyInPip()` — checks `pipModeActive || activity.isInPictureInPictureMode`
- Guards on: `applySurfaceSize`, `onNewVideoLayout`, `applyAspectRatio`, `scheduleDeferredSurfaceSync`
- `cancelDeferredSync()` — cancels pending 120ms delayed `updateVideoSurfaces()` on PiP entry

### Style Override Pitfall

React Native style arrays DON'T deep-merge `transform`. In `style={[a, b, c]}`, if `c` has `transform`, it replaces `b`'s `transform` entirely. This is why `containerDragStyle` must include the PiP cutout shift when returning any transform.

### `applySurfaceViewTransforms` (MediaSessionModule.kt)

Legacy code that finds SurfaceViews and applies scale transforms. **Only finds SurfaceView, NOT TextureView.** This does NOT affect the NitroVLC TextureView-based player. Can likely be removed (it's from the old VLC vendor player).

---

## Key Files

| File | Lines | What |
|------|-------|------|
| `VideoPlayerOverlay.tsx` | 190-204 | `useScreenFallback` — forces screen dims on Android fullscreen |
| `VideoPlayerOverlay.tsx` | 847-852 | `isPipLayoutActiveShared` — early PiP detection shared value |
| `VideoPlayerOverlay.tsx` | 866-883 | Stable inset refs — resist 0 during PiP transition |
| `VideoPlayerOverlay.tsx` | 884-951 | Frozen shared values — hold pre-PiP fullscreen dims |
| `VideoPlayerOverlay.tsx` | 928-934 | `isPipLayoutActive` computation (0.9 threshold) |
| `VideoPlayerOverlay.tsx` | 1087-1112 | `panGesture.onStart` — **MISSING PiP guard** |
| `VideoPlayerOverlay.tsx` | 1113-1160 | `panGesture.onUpdate` — fullscreen drag-to-minimize (runs in PiP!) |
| `VideoPlayerOverlay.tsx` | 802-816 | `handleVideoTap` — **MISSING PiP guard** |
| `VideoPlayerOverlay.tsx` | 1281-1410 | `containerStyle` — PiP branch freezes at fullscreen dims |
| `VideoPlayerOverlay.tsx` | 1423-1439 | `containerDragStyle` — includes PiP cutout shift |
| `VideoPlayerOverlay.tsx` | 1441-1468 | `videoStyle` — PiP branch freezes video wrapper dims |
| `VideoPlayerOverlay.tsx` | 1592-1636 | `videoPlayerStyle` — PiP branch freezes video position |
| `VideoPlayerOverlay.tsx` | 2776 | Overlay controls condition — **includes `isInPipMode`** |
| `VideoPlayerOverlay.tsx` | 3021 | View hierarchy: `style={[container, containerStyle, containerDragStyle]}` |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 30-46 | `setAllPipMode()` + `cancelDeferredSync()` |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 95-100 | `pipModeActive` volatile flag |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 627-710 | `applySurfaceSize` — PiP guard + dedup + deferred sync |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 471-510 | `onNewVideoLayout` — PiP guard |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 742-744 | `applyAspectRatio` — PiP guard |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 802-815 | `isEffectivelyInPip()` helper |
| `MediaSessionModule.kt` | 122-172 | `onUserLeaveHint` — sets pipModeActive early |
| `MediaSessionModule.kt` | 178-203 | `notifyPipModeChanged` — PiP enter/exit notification |
| `MediaSessionModule.kt` | 244-291 | `applySurfaceViewTransforms` — legacy SurfaceView scaling (NOT TextureView) |
| `ayooooo123/react-native-nitro-vlc:android/.../NitroVLCViewManager.kt` | 22-59 | Plain ViewManager — FrameLayout + TextureView MATCH_PARENT |

## Constraints

- **TextureView LayoutParams must NOT change during PiP** → black screen (SurfaceTexture destroyed)
- **VLC `updateVideoSurfaces()` during transition** → 50/50 shifted artifact
- **No delays or timeouts** — all synchronous
- **Multiple threads**: VLC native, JS, UI, Reanimated UI — races are the norm
- **`onUserLeaveHint` is the earliest native hook** — but Android 12+ auto-enter may start shrinking before it fires
- **Target Android 14+ only** — can use all modern PiP APIs

## Debug Commands

```bash
# Watch VLC surface logs
adb logcat | grep NitroVLC

# Watch PiP lifecycle
adb logcat | grep -E "(PipBridge|NitroVLC|pipMode)"

# Clear and watch
adb logcat -c && adb logcat | grep -E "(NitroVLC|PipBridge)"
```

## Previous Approaches That Failed

See `ANDROID_PIP_ZOOM_ISSUE.md` for 7 failed TextureView resize approaches.
See `ANDROID_PIP_5050_SHIFT.md` for the timeline analysis of the 50/50 shift race condition.

| Approach | Result |
|----------|--------|
| Native view reparenting | Too complex, React state out of sync |
| SurfaceView transforms | SurfaceView is a separate window, doesn't work with TextureView |
| `flex: 1` in PiP branches | Yoga relayout → TextureView resize → black screen |
| `setSeamlessResizeEnabled(false)` | Not tried yet — could help with Issue 1 |
| Explicit pixel dims from computed sizes | Layout change during transition → size mismatch |

## Recommended Priority

1. **Issue 2 (gesture/controls in PiP)** — easiest fix, pure JS, no native changes
2. **Issue 1 (zoomed/cropped PiP)** — requires architectural decision on scaling approach
3. **Issue 3 (2nd entry 50/50)** — needs diagnostic logging to identify which value is stale
