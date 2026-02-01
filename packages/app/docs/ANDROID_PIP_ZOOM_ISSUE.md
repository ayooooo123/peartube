# Android PiP Zoom/Crop Issue - Investigation Log

## Problem Statement

When in Picture-in-Picture (PiP) mode on Android, the video appears **zoomed in and cropped** - only a portion of the video is visible, not the entire frame scaled to fit.

## Root Cause (Confirmed via Logs)

```
Fullscreen layout: TextureView = 960x2202 (portrait fullscreen)
PiP window: Activity = 527x297 (landscape-ish)
TextureView in PiP: Still 960x2202 (UNCHANGED!)
```

**React Native's layout system does NOT update the TextureView dimensions when entering PiP.** The TextureView stays at fullscreen size (960x2202), Android clips the visible area to the PiP window (527x297), and we only see the top-left corner of the video.

## Log Evidence

```
setPipContainerSize: 527x297
setPipContainerSize: saved fullscreen=960x540     ← WRONG! This is pre-PiP size
applyPipTransform: scale=0.55x0.55                ← Based on wrong dimensions
onSurfaceTextureSizeChanged: 960x2202             ← React Native updates AFTER our fix
applyResizeMode: container=960x2202               ← VLC gets the wrong size
```

The critical sequence:
1. JS sends `pipContainerSize={width: 527, height: 297}`
2. We capture "fullscreen" as current dimensions (960x540 at that moment)
3. React Native THEN updates layout to actual fullscreen (960x2202)
4. Our calculations are based on stale dimensions

---

## Approaches Tried

### 1. `setWindowSize()` Only
**Idea:** Tell VLC the container is PiP-sized so it renders video to fit.

**Result:** FAILED - VLC's `setWindowSize()` only affects internal aspect ratio calculations for letterboxing. It does NOT change where/how video is rendered within the TextureView. The video is still rendered at a position assuming 960x2202 container, and we only see a clipped corner.

### 2. `setLayoutParams()` to Resize TextureView
**Idea:** Force the TextureView to PiP dimensions.

**Result:** FAILED - BLACK SCREEN. Changing LayoutParams on an actively-rendering TextureView breaks the SurfaceTexture lifecycle. VLC's reference to the surface becomes stale; it continues rendering to a destroyed surface.

### 3. Matrix Transform on TextureView
**Idea:** Use `TextureView.setTransform(Matrix)` to scale the visual output without affecting the surface.

**Implementation:**
```java
float scaleX = (float) pipWidth / fullscreenWidth;  // 527/960 = 0.55
float scaleY = (float) pipHeight / fullscreenHeight; // 297/2202 = 0.135
mPipMatrix.setScale(scaleX, scaleY);
setTransform(mPipMatrix);
```

**Result:** FAILED - Multiple issues:
- Non-uniform scaling (0.55 x 0.135) distorts the video
- Uniform scaling (0.135 x 0.135) makes video tiny (130px wide in 527px window)
- Captured "fullscreen" dimensions are stale (pre-PiP values)
- Surface size changes AFTER we apply transform, invalidating our calculations

### 4. Ignore Layout Changes in PiP Mode + setWindowSize
**Idea:** When in PiP mode, ignore `onLayoutChange`/`onSurfaceTextureSizeChanged` and keep VLC using PiP dimensions.

**Implementation:**
```java
if (mPipWidth > 0 && mPipHeight > 0) {
    vlcOut.setWindowSize(mPipWidth, mPipHeight);
    return; // Don't update container dimensions
}
```

**Result:** FAILED - Same as approach #1. `setWindowSize()` doesn't control rendering position, just aspect ratio math.

---

## Why These Approaches Fail: The Core Problem

VLC renders video into a SurfaceTexture. The SurfaceTexture is attached to a TextureView. The TextureView has layout dimensions.

```
┌─────────────────────────────────────┐
│ TextureView (960x2202 layout)       │
│ ┌─────────────────────────────────┐ │
│ │ SurfaceTexture (960x2202)       │ │
│ │                                 │ │
│ │   ┌───────────────────────┐     │ │
│ │   │ Video (960x540)       │     │ │  ← VLC renders here based on
│ │   │ (letterboxed)         │     │ │    setWindowSize aspect ratio
│ │   └───────────────────────┘     │ │
│ │                                 │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘

PiP window sees: ┌────────┐
                 │        │ ← Top-left 527x297 pixels
                 └────────┘   (letterbox area, not video)
```

The video is rendered somewhere within the 960x2202 surface, and we're only seeing a 527x297 clip of it.

---

### 5. View Reparenting (TESTED - FAILED)
**Concept:** Remove TextureView from React Native hierarchy, add to Activity root with MATCH_PARENT.

**Implementation:** `VlcPlayerBridge` in `MediaSessionModule.kt` - finds TextureView, saves original parent, reparents to Activity root.

**Result:** FAILED - `IllegalStateException: can't get VLCObject instance`

Reparenting the TextureView breaks VLC's surface connection, same as setLayoutParams(). When the view is removed from its parent, VLC loses its SurfaceTexture reference and crashes.

**Additional issue on Android 12+/16:** `onUserLeaveHint` is NOT called when auto-PiP is enabled. The system enters PiP directly during the swipe gesture, bypassing this callback entirely.

---

## Current Approach: setScale() with Native Video Dimensions

### 6. setScale() with Native Video Dimensions (CURRENT)
**Concept:** Use VLC's `setScale()` to shrink video rendering to fit PiP window, using the **native video dimensions** (from `onNewVideoLayoutListener`), NOT the TextureView layout dimensions.

**Implementation:**
```java
// Store native video dimensions separately from layout dimensions
private int mNativeVideoWidth = 0;
private int mNativeVideoHeight = 0;

// In onNewVideoLayoutListener:
mNativeVideoWidth = width;  // e.g., 1920
mNativeVideoHeight = height; // e.g., 1080

// In setPipContainerSize:
float scaleX = (float) pipWidth / mNativeVideoWidth;   // 527/1920 = 0.27
float scaleY = (float) pipHeight / mNativeVideoHeight; // 297/1080 = 0.27
float scale = Math.min(scaleX, scaleY);                // 0.27
mMediaPlayer.setScale(scale);
```

**Key insight:** VLC's `setScale()` scales relative to the **video's native resolution**, not the TextureView layout. Previous attempt used layout dimensions (960x2202) instead of video dimensions (1920x1080), resulting in scale=0.13 (tiny video) instead of scale=0.27 (correct fit).

**Video render position:** Top-left corner of TextureView. Since PiP clips to top-left anyway, this works.

**Result:** FAILED - While `setScale()` does reduce the video size, it renders the scaled video in the CENTER of the TextureView (960x2202), not at the top-left corner. The PiP window clips the top-left, so we see empty black space instead of the video.

---

### 7. React Native Style with dp Values (CURRENT - PARTIAL SUCCESS)
**Concept:** Let React Native handle view sizing through the style prop, but ensure dimensions are in dp (density-independent pixels) so RN can properly convert to physical pixels.

**Key Discovery:** MediaSession was sending **pixel values** (527x297) to JS, but React Native styles expect **dp values**. When JS used pixel values as dp, RN scaled them by density (2.5x), resulting in 1318x743 pixel surface - way too large!

**Implementation:**

**Native side (MediaSessionModule.kt) - Send dp values:**
```kotlin
internal fun sendPipEvent(activity: Activity, isInPip: Boolean, newConfig: Configuration? = null) {
    // Send dp values to JS - React Native styles use dp, not pixels
    val density = activity.resources.displayMetrics.density
    val (width, height) = if (newConfig != null && isInPip) {
        // Configuration gives us dp values directly
        Pair(newConfig.screenWidthDp, newConfig.screenHeightDp)
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // Window metrics are in pixels, convert to dp
        val bounds = activity.windowManager.currentWindowMetrics.bounds
        Pair((bounds.width() / density).toInt(), (bounds.height() / density).toInt())
    } else {
        val decorView = activity.window?.decorView
        Pair(((decorView?.width ?: 0) / density).toInt(), ((decorView?.height ?: 0) / density).toInt())
    }
    // Now width/height are dp values (e.g., 211x119 instead of 527x297)
    sendEvent("onPictureInPictureChanged", mapOf(
        "isInPictureInPicture" to isInPip,
        "width" to width,
        "height" to height
    ))
}
```

**JS side (VideoPlayerOverlay.tsx) - Use dp values in style:**
```tsx
<VLCPlayer
  style={
    isInPipMode && Platform.OS === 'android' && pipWindowSize
      ? { width: pipWindowSize.width, height: pipWindowSize.height, position: 'absolute', top: 0, left: 0 }
      : StyleSheet.absoluteFill
  }
  pipContainerSize={
    isInPipMode && Platform.OS === 'android' && pipWindowSize
      ? pipWindowSize
      : null
  }
/>
```

**Native VLCPlayer (ReactVlcPlayerView.java) - Simplified:**
```java
// Just store for logging - React Native handles actual sizing via style prop
public void setPipContainerSize(int width, int height) {
    Log.d("VLC_PIP", "setPipContainerSize: " + width + "x" + height + " dp");
    mPipWidth = width;
    mPipHeight = height;
}
```

**Result:** PARTIAL SUCCESS - Works correctly when dragging PiP window, but initial entry still shows zoom.

**Current Issue - React Native Background Batching:**
When entering PiP, the app goes to background. React Native appears to suspend or batch prop updates for backgrounded apps. The style/prop changes set in JS don't reach native until the app returns to foreground (either by exiting PiP or interacting with PiP window).

Evidence from logs:
```
22:20:49.425 - JS receives PiP event with dimensions 211x119dp
22:20:49.426 - JS state updated (isInPipMode=true, pipWindowSize set)
... 10 seconds pass, app is backgrounded in PiP ...
22:20:59.997 - Native finally receives setPipContainerSize: 211x119 dp
```

The 10-second gap shows React Native deferring the native prop update until the app becomes active again.

**Workarounds to explore:**
1. Trigger native resize directly from MediaSessionModule when entering PiP, bypassing React
2. Use native bridge to force immediate prop update
3. Listen to Configuration changes natively and resize without React involvement

When exiting PiP:
1. JS sends `pipContainerSize: null`
2. Native `clearPipContainerSize()` resets to 0x0
3. `onMeasure()` uses default behavior (respects parent constraints)
4. View returns to fullscreen size correctly

**Result:** TESTING

---

## Approaches NOT Yet Tried

### B. Create Separate Native PiP Surface
**Concept:** When entering PiP, create a new TextureView sized to PiP dimensions, copy VLC's rendering to it.

### C. Use SurfaceView Instead of TextureView
**Concept:** SurfaceView has different compositing behavior and might handle resize differently.

---

## Key Insights

1. **Timing is critical:** React Native updates layout AFTER our PiP props are set
2. **setWindowSize is misleading:** It's for aspect ratio, not view size
3. **setLayoutParams breaks surfaces:** Can't resize TextureView while VLC renders
4. **Matrix transform scales wrong thing:** Scales entire view including letterbox
5. **The view hierarchy is the problem:** TextureView stays at fullscreen size

---

## Debug Commands

```bash
# Watch all VLC_PIP logs
adb logcat | grep VLC_PIP

# Clear logs and watch fresh
adb logcat -c && adb logcat | grep VLC_PIP

# Check specific device
adb -s <device-id> logcat | grep VLC_PIP
```

## Files Involved

| File | Purpose |
|------|---------|
| `ReactVlcPlayerView.java` | TextureView that renders VLC video |
| `ReactVlcPlayerViewManager.java` | React Native bridge, handles props |
| `VideoPlayerOverlay.tsx` | Passes `pipContainerSize` prop |
| `MainActivity.kt` | PiP mode handling |
| `plugins/withMainActivityPiPCallback.js` | Expo plugin that modifies MainActivity |
| `MediaSessionModule.kt` | Contains PipBridge for native PiP logic |

---

## IMPORTANT: Expo Plugin Overwrites MainActivity

**Problem:** Any manual changes to `MainActivity.kt` get OVERWRITTEN when running `npx expo prebuild`.

The Expo config plugin `withMainActivityPiPCallback.js` injects:
- `onUserLeaveHint()` - calls `PipBridge.onUserLeaveHint(this)`
- `onPictureInPictureModeChanged()` - calls `PipBridge.notifyPipModeChanged()`

**If you need to add more complex MainActivity logic:**

1. **Option A:** Modify the Expo plugin to inject the new code
   - Edit `plugins/withMainActivityPiPCallback.js`
   - Add your code to `PIP_CALLBACK_BLOCK`
   - Run `npx expo prebuild` to regenerate

2. **Option B:** Put logic in `PipBridge` instead of MainActivity
   - Keep MainActivity simple (just calls PipBridge)
   - Add complex logic to `MediaSessionModule.kt` / `PipBridge`

3. **Option C:** Eject from Expo managed workflow
   - Not recommended unless absolutely necessary

**Current flow:**
```
MainActivity.onUserLeaveHint()
    → PipBridge.onUserLeaveHint(activity)
        → (native PiP logic here)

MainActivity.onPictureInPictureModeChanged()
    → PipBridge.notifyPipModeChanged(activity, isInPiP, config)
        → sends event to JS with PiP dimensions
```

Any view reparenting or TextureView manipulation should happen in `PipBridge`, NOT directly in MainActivity.

**PipBridge location:** `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`

Current PipBridge methods:
- `onUserLeaveHint(activity)` - Called when user leaves app, triggers PiP entry
- `notifyPipModeChanged(activity, isInPip, config)` - Sends PiP state/dimensions to JS
- `setPipEnabled(enabled)` - Enable/disable PiP
- `setPipAspectRatio(width, height)` - Set aspect ratio for PiP window
