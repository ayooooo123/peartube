# Android PiP "50/50 Shifted Down" Issue

## What The User Sees

When entering Picture-in-Picture mode on Android, the video **briefly shows correctly** (full video fills the PiP window), then **shifts down** so approximately the top half of the PiP window is black and the bottom half shows the top portion of the video. It looks like VLC is rendering the video at a ~50dp offset within its TextureView.

The user confirmed: "sees the correct fill briefly, then the 50/50 shift happens."

## System Architecture

### How Android PiP Works (Single-Activity)

PearTube uses a single-activity React Native app. Android system PiP works by:
1. Shrinking the **Activity window** to a small floating rectangle
2. The **system compositor** clips whatever is visible in that window
3. The app's layout engine (Yoga/React Native) sees the smaller window dimensions and re-layouts

This means the app's **entire React tree** re-renders with PiP-sized dimensions unless we freeze the layout.

### View Hierarchy

```
<Animated.View style={containerStyle}>         ← outer wrapper (width/height)
  <Animated.View style={videoStyle}>           ← video area (width/height = videoHeight + cutoutInset)
    <Animated.View style={videoPlayerStyle}>   ← position: absolute, top: cutoutOffset
      <VlcVideoView style={absoluteFill}>      ← fills parent
        <NitroVLCView style={absoluteFill}>    ← native FrameLayout
          <TextureView MATCH_PARENT>           ← VLC renders here
```

### The Fullscreen Portrait Layout (pre-PiP)

On a device with a camera cutout (e.g. `insets.top = 50dp`):
- `videoStyle.height` = `videoHeight + cutoutInset` = `231 + 50` = **281dp**
- `videoPlayerStyle.top` = `cutoutOffset` = **50dp**
- TextureView height = `281 - 50` = **231dp**
- Video renders in this 231dp area, starting 50dp below the top of the video wrapper

### The TextureView Constraint (CRITICAL)

**Changing TextureView LayoutParams during active rendering kills the SurfaceTexture → BLACK SCREEN.** This is documented in `ANDROID_PIP_ZOOM_ISSUE.md` (7 failed approaches). Therefore:
- The TextureView MUST stay at exactly its pre-PiP fullscreen dimensions
- The Reanimated animated styles must produce IDENTICAL layout dimensions during PiP
- Any Yoga relayout that changes the TextureView's parent dimensions = potential black screen or rendering artifact

### The VLC Rendering Artifact

VLC renders via OpenGL/EGL into the SurfaceTexture. When `setWindowSize()` or `updateVideoSurfaces()` is called with new dimensions, VLC reconfigures its rendering pipeline. During this reconfiguration (which takes multiple frames), VLC can show the video "split" — the bottom portion of the video in the top half, or similar offset artifacts. This is the "50/50 shifted" look.

## The PiP Timeline (The Race)

Here's what happens frame-by-frame when the user swipes to home:

```
T0: onUserLeaveHint() fires
    → pipModeActive = true (via reflection to HybridNitroVLCView.setAllPipMode)
    → Native VLC guards activated (applySurfaceSize, onNewVideoLayout blocked)

T1: Activity enters PiP mode (system)
    → Window shrinks from fullscreen to PiP dimensions
    → System bars disappear
    → insets.top changes from 50 → 0 ← KEY PROBLEM

T2: React Native re-renders (useWindowDimensions update)
    → windowWidth/windowHeight = PiP-sized
    → insets.top = 0
    → isInPipMode = false ← JS event hasn't arrived yet!
    → useScreenFallback may or may not activate (timing-dependent)

T3: Shared value updates (synchronous in render body)
    → insetTopShared.value = 0 (or stable ref catches this — see current fix attempt)
    → Non-PiP fullscreen branch of useAnimatedStyle runs:
      cutoutInset = insetTopShared.value * cutoutFactor = 0 * 1.0 = 0
      height = videoHeight + 0 = 231 (was 281)
    → Video wrapper shrinks from 281dp → 231dp
    → videoPlayerStyle.top = 0 (was 50)
    → TextureView parent changes size → onSurfaceTextureSizeChanged fires?
    → OR: layout change triggers onLayoutChangeListener

T4: JS PiP event arrives
    → isInPipMode = true
    → PiP branches of animated styles activate (frozen values)
    → But VLC already reconfigured during T2-T4 gap
```

## What's Been Tried (Current Session)

### 1. Native `pipModeActive` Flag (PARTIAL SUCCESS)
Set a volatile `pipModeActive` flag on `HybridNitroVLCView` via reflection from `MediaSessionModule.onUserLeaveHint()` BEFORE PiP entry. Guards on `applySurfaceSize`, `onNewVideoLayout`, `attachSurface`, `scheduleDeferredSurfaceSync` all check `isEffectivelyInPip()`.

**Result**: Blocks VLC reconfiguration, but doesn't prevent the React layout change that causes the issue.

### 2. Frozen Shared Values (SOLVED BLACK SCREEN)
Added `frozenVideoHeightShared`, `frozenInsetTopShared`, `frozenInsetBottomShared` that only update when `!isInPipMode`. PiP branches of animated styles use frozen values to produce exactly the same dimensions as fullscreen.

**Result**: Eliminated black screen. PiP branches now freeze layout correctly. But the 50/50 shift persists because the NON-PiP branches run during the transition gap (T2-T4 above).

### 3. Stable Inset Refs (LATEST ATTEMPT — DID NOT FIX)
Added `stableInsetTopRef` / `stableInsetBottomRef` that resist dropping to 0 during Android PiP transitions. Logic: if `Platform.OS === 'android' && playerMode === 'fullscreen' && insets.top === 0 && stableInsetTopRef.current > 0`, keep the previous value.

Also changed non-PiP fullscreen branches to use `frozenInsetTopShared` instead of `insetTopShared`.

**Result**: User says "50/50 shift still happens after seeing the correct fill briefly." This means the initial PiP frame is correct (frozen layout works), but something LATER causes the shift.

## Key Clue: "Correct Fill Briefly, Then Shifts"

This is critical. It means:
1. The initial frozen layout IS being applied correctly
2. Something happens AFTER the initial PiP entry that causes a VLC reconfiguration
3. The reconfiguration produces the 50/50 artifact

### Possible Causes

#### A. `scheduleDeferredSurfaceSync` Fires After Delay
`scheduleDeferredSurfaceSync` posts a `Runnable` with a 120ms delay (`mainHandler.postDelayed(runnable, 120)`). During the transition gap, `applySurfaceSize` may be called with small incremental changes (the "else" branch at line 691-703). Each call schedules a deferred sync. The deferred sync checks `isEffectivelyInPip()` at execution time (120ms later), but:
- At T2 (transition gap): `applySurfaceSize` is called, `isEffectivelyInPip()` may return false if `pipModeActive` isn't set yet, so it schedules a deferred sync
- 120ms later: the deferred sync fires and calls `player.updateVideoSurfaces()` with stale dimensions

**To investigate**: Add logging to `scheduleDeferredSurfaceSync` and the deferred `Runnable` to see if it fires during/after PiP entry.

#### B. `onNewVideoLayout` Fires on VLC's Internal Thread
VLC fires `onNewVideoLayout` on its own native thread when the video layout changes. Even though the guard checks `isEffectivelyInPip()`, the callback posts to UI thread via `runOnUiThread`. If the layout callback is already queued on the UI thread before `pipModeActive` is set, it runs AFTER with stale state.

**To investigate**: Check log output for `onNewVideoLayout applied windowSize=` entries during PiP transition.

#### C. `isEffectivelyInPip()` Has a Timing Gap
`isEffectivelyInPip()` checks `pipModeActive || activity.isInPictureInPictureMode`. If both are false during T1-T2, VLC reconfiguration proceeds. The `isPipLikeShrink` area-ratio heuristic in `applySurfaceSize` (line 649-650) is a last resort, but it only activates if `prevArea > 0 && newArea < prevArea / 4`.

**To investigate**: Are there frames where the TextureView dimensions change but all PiP detection fails?

#### D. The TextureView Size Actually DOES Change
The Reanimated animated style changes the dimensions of the video wrapper. If `videoStyle.height` changes from 281→231 (due to cutoutInset going from 50→0), the parent chain resizes, and the TextureView's MATCH_PARENT causes it to resize too. Even if `stableInsetTopRef` holds the value, maybe something else is causing the height change.

**To investigate**: Add `console.log` to the `useAnimatedStyle` worklets to trace what values they compute during PiP transition. Or check `logSurface` native logs for `onSurfaceTextureSizeChanged` or `onLayoutChange` events with changed dimensions.

#### E. JS Re-render With New Values Overwrites Shared Values
Shared values are set synchronously in the render body (lines 906-925). If React re-renders multiple times during PiP transition with different values, the shared values change on each render. The Reanimated worklets see these changes and recompute styles. Even with `stableInsetTopRef`, if `videoHeight` or `screenHeight` changes, the layout changes.

**To investigate**: Are `videoHeightShared.value` or `screenHeightShared.value` changing during the transition?

## Files Involved

| File | Lines | Purpose |
|------|-------|---------|
| `packages/app/components/VideoPlayerOverlay.tsx` | 858-925 | Stable refs, frozen values, shared value updates |
| `packages/app/components/VideoPlayerOverlay.tsx` | 1270-1290 | containerStyle PiP branch (frozen fullscreen dims) |
| `packages/app/components/VideoPlayerOverlay.tsx` | 1397-1448 | videoStyle (PiP + non-PiP fullscreen branches) |
| `packages/app/components/VideoPlayerOverlay.tsx` | 1539-1584 | videoPlayerStyle (PiP + non-PiP branches) |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 30-40 | `setAllPipMode()` + companion registry |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 89-94 | `pipModeActive` volatile flag |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 127-149 | TextureView layout listener + `onSurfaceTextureSizeChanged` |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 467-504 | `onNewVideoLayout` (VLC callback, has PiP guard) |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 621-703 | `applySurfaceSize` (PiP guard + dedup + deferred sync) |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 706-728 | `scheduleDeferredSurfaceSync` (120ms delayed reconfigure) |
| `ayooooo123/react-native-nitro-vlc:android/.../HybridNitroVLCView.kt` | 789-802 | `isEffectivelyInPip()` helper |
| `ayooooo123/react-native-nitro-vlc:android/.../NitroVLCViewManager.kt` | 1-59 | Plain ViewManager (FrameLayout + TextureView MATCH_PARENT) |
| `packages/app/modules/expo-media-session/.../MediaSessionModule.kt` | 122-172 | `onUserLeaveHint` (sets `pipModeActive` early) |
| `packages/app/modules/expo-media-session/.../MediaSessionModule.kt` | 178+ | `notifyPipModeChanged` (sends JS event) |

## Recommended Next Steps

### Step 1: Add Diagnostic Logging
Add `adb logcat | grep NitroVLC` logging to trace EXACTLY what happens during PiP entry:
- Log every `applySurfaceSize` call with reason, dimensions, and `isEffectivelyInPip()` result
- Log every `onNewVideoLayout` call with the same
- Log when `scheduleDeferredSurfaceSync` fires its delayed Runnable
- Log shared value changes in JS (temporarily add `console.log` to the synchronous render section)
- Compare timestamps to see what fires during the T2-T4 gap

### Step 2: Verify `pipModeActive` Timing
Check that `setAllPipMode(true)` is being called and taking effect BEFORE any `applySurfaceSize` or `onNewVideoLayout` fires. The reflection call in `onUserLeaveHint` may fail silently or may race with VLC callbacks on other threads.

### Step 3: Consider `setSeamlessResizeEnabled(false)`
Android 12+ has `PictureInPictureParams.Builder().setSeamlessResizeEnabled(false)` which tells the system to use a cross-fade animation instead of a seamless resize. This might avoid the intermediate layout states entirely. Not yet tried.

### Step 4: Consider Blocking ALL VLC Reconfig During Transition
Instead of trying to keep the layout stable (which has proven extremely difficult due to multiple timing races), consider a native-only approach:
- In `onUserLeaveHint`, set `pipModeActive = true` AND store a snapshot of `lastAppliedSurfaceWidth/Height`
- In `applySurfaceSize`, when `pipModeActive` is true, forcefully restore the snapshot dimensions if VLC was reconfigured
- In `onNewVideoLayout`, completely skip even the `emitLoadIfNeeded()` call during PiP

### Step 5: Cancel Deferred Syncs on PiP Entry
The deferred sync (120ms delayed `Runnable`) is a prime suspect. When `pipModeActive` is set in `setAllPipMode()`, immediately cancel any pending deferred sync:
- In `setAllPipMode()`, iterate registry and call `view.cancelDeferredSync()`
- Add a `cancelDeferredSync()` method that removes the pending `Runnable` from `mainHandler`
- Do NOT use delays/timeouts as a workaround — use synchronous cancellation

## What IS Working

- **Black screen is fixed**: Frozen shared values prevent TextureView resize during PiP
- **VLC guards are in place**: `isEffectivelyInPip()` blocks most reconfiguration paths
- **Initial PiP frame is correct**: The user sees the correct video briefly before the shift
- **PiP exit works**: Video returns to fullscreen correctly
- **Play/pause/seek controls work in PiP**: Via media session actions

## Constraints

- **TextureView LayoutParams must NOT change during PiP** (→ black screen)
- **VLC's `updateVideoSurfaces()` during transition causes the 50/50 artifact**
- **React Native suspends/batches prop updates when backgrounded** (can't rely on JS-side timing)
- **Multiple threads involved**: VLC native thread, JS thread, UI thread, Reanimated UI thread
- **`onUserLeaveHint` is the earliest hook** but auto-enter on Android 12+ may bypass it for the first frame
