# Android PiP 50/50 Issue - Current Approach

## Problem Statement

When entering Picture-in-Picture (PiP) mode on Android, the PiP window shows **half video, half black/grey space** (the "50/50 issue"). This happens because Android captures the entire Activity window, including React Native layout padding around the video.

## Root Cause

Android's PiP system captures the **entire Activity window** and scales it down. It does NOT crop to just the video area.

## Current Approach: Native View Reparenting

**Key insight:** We can't change React Native's layout fast enough before Android captures. Instead, we **move the video view out of React Native's hierarchy** to the Activity root, where it fills the entire window.

### How It Works

```
Before reparenting:                After reparenting:
┌─────────────────────┐           ┌─────────────────────┐
│ Activity Root       │           │ Activity Root       │
│  └── RN Root        │           │  ├── RN Root        │
│       └── Video     │  ──────►  │  │    └── (empty)   │
│           (450px)   │           │  └── Video          │
│       └── Comments  │           │      (MATCH_PARENT) │
└─────────────────────┘           └─────────────────────┘

Android captures entire window     Video fills entire window
= 50/50 issue                      = Clean PiP
```

### Sequence

1. User in fullscreen mode with normal React Native layout
2. User leaves app → `onUserLeaveHint` fires
3. **We reparent video to Activity root** (fills entire window)
4. `setAutoEnterEnabled(true)` triggers PiP entry
5. Android captures window → only video is visible
6. User returns → `onPictureInPictureModeChanged(false)`
7. **We restore video to React Native hierarchy**

### Key Files Changed

| File | Change |
|------|--------|
| `VlcPlayerBridge.kt` | `reparentForPip()` - moves view to Activity root |
| `VlcPlayerBridge.kt` | `restoreFromPip()` - restores view to RN hierarchy |
| `MediaSessionModule.kt` | `onUserLeaveHint()` - calls reparentForPip |

### Code: VlcPlayerBridge.reparentForPip()

```kotlin
fun reparentForPip(activity: Activity): Boolean {
    val playerView = activePlayerView ?: return false
    val rootContent = activity.window.decorView.findViewById<ViewGroup>(android.R.id.content)

    // Save original parent for restoration
    val parent = playerView.parent as? ViewGroup ?: return false
    originalParent = parent
    originalParentIndex = parent.indexOfChild(playerView)
    originalLayoutParams = playerView.layoutParams

    // Remove from React Native hierarchy
    parent.removeView(playerView)

    // Add to Activity root with fullscreen layout
    val fullscreenParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
    rootContent.addView(playerView, fullscreenParams)

    isReparentedForPip = true
    return true
}
```

### Code: VlcPlayerBridge.restoreFromPip()

```kotlin
fun restoreFromPip(): Boolean {
    val playerView = activePlayerView ?: return false
    val savedParent = originalParent ?: return false

    // Remove from Activity root
    (playerView.parent as? ViewGroup)?.removeView(playerView)

    // Restore to original React Native parent
    savedParent.addView(playerView, originalParentIndex, originalLayoutParams)

    isReparentedForPip = false
    return true
}
```

## Testing

```bash
cd packages/app
npx expo run:android --device
```

1. Play a video in fullscreen mode
2. Press home button or swipe up
3. Check logs: `adb logcat | grep -iE "(pip|reparent)"`
4. Video should appear in PiP window without 50/50 issue
5. Tap PiP to return - video should restore to normal layout

## Debug Commands

```bash
# Watch reparenting logs
adb logcat | grep -E "reparentForPip|restoreFromPip|onUserLeaveHint"

# Clear logs before testing
adb logcat -c
```

## Potential Issues

### Issue: Video doesn't restore correctly
The view hierarchy might be different after PiP exit. Check `originalParentIndex` validity.

### Issue: Video flickers during transition
The reparenting happens on main thread synchronously, but React Native might try to re-layout.

### Issue: Reparenting fails
Check that `activePlayerView` is registered and has a parent.

## Previous Approaches (Failed)

1. **PipHostActivity** - BAL blocked
2. **setAutoEnterEnabled alone** - 50/50 issue
3. **Native transforms** - React Native resets them
4. **Manual enterPictureInPictureMode** - returns false
5. **React Native fullscreen layout** - breaks normal playback UI

## Why This Approach Should Work

Unlike transforms (which RN can reset), actual view reparenting:
- Physically moves the view out of RN's control
- React Native can't reset what it doesn't own
- The view is genuinely full-screen (not visually scaled)
- Android captures the Activity window with only the video visible
