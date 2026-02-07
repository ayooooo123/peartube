# Nitro VLC Module Audit

## Critical Issues Found

### 1. **Android: Race Condition in Event Handling** (CRITICAL)
**File:** `HybridNitroVLCView.kt:383-448`

The `handlePlayerEvent` method accesses the player inside a synchronized block but invokes callbacks outside of it. If `dispose()` is called between these two points, the player will be null when callbacks try to access it later.

```kotlin
// PROBLEM: player is accessed inside lock
synchronized(playerLock) {
    val player = mediaPlayer ?: return  // Returns early if null
    // ... extract event data ...
}

// But callbacks are invoked OUTSIDE the lock
onPlayingEvent?.let { onPlaying?.invoke(it) }
```

**Fix:** Move all callback invocations inside the synchronized block, or capture all necessary data before releasing the lock.

### 2. **Android: Unsafe Media Creation** (CRITICAL)
**File:** `HybridNitroVLCView.kt:369`

```kotlin
val media = Media(libVLC, Uri.parse(value.uri))  // Can throw!
```

The `Media` constructor can throw exceptions if:
- libVLC is null (initialization failed)
- The URI is malformed
- The URI scheme is not supported

**Fix:** Wrap in try-catch and emit onError callback:
```kotlin
try {
    val media = Media(libVLC, Uri.parse(value.uri))
    // ...
} catch (e: Exception) {
    onError?.invoke(SimpleCallbackEventProps(0.0))
}
```

### 3. **Android: Null libVLC in loadMedia** (CRITICAL)
**File:** `HybridNitroVLCView.kt:369`

```kotlin
val media = Media(libVLC, Uri.parse(value.uri))  // libVLC can be null!
```

If `ensurePlayer()` fails to initialize (line 241), libVLC remains null, but loadMedia continues and crashes.

**Fix:** Add null check:
```kotlin
val vlc = libVLC ?: run {
    onError?.invoke(SimpleCallbackEventProps(0.0))
    return
}
val media = Media(vlc, Uri.parse(value.uri))
```

### 4. **Android: Early Media Release** (HIGH)
**File:** `HybridNitroVLCView.kt:372`

```kotlin
player.media = media
media.release()  // Released immediately!
```

The media is released right after assigning to player. If the player hasn't fully taken ownership, this can cause use-after-free.

**Fix:** Don't call release() - the player owns the media now.

### 5. **iOS: Silent Failures** (HIGH)
**File:** `HybridNitroVLCView.swift:252`

```swift
private func loadMedia(uri: String) {
    guard let url = URL(string: uri) else { return }  // Silent failure!
    player?.media = VLCMedia(url: url)
}
```

If URL creation fails (malformed URI), there's no error callback - the user sees nothing happening.

**Fix:** Emit error callback:
```swift
guard let url = URL(string: uri) else {
    onError?(SimpleCallbackEventProps(target: 0))
    return
}
```

### 6. **iOS: Unsafe Player Access** (HIGH)
**File:** `HybridNitroVLCView.swift:394-424`

```swift
fileprivate func handleStateChanged() {
    guard let player else { return }  // Returns silently
    // ...
}
```

Multiple delegate callbacks check for nil player and return silently. If the player becomes nil due to an error, the JS layer never knows.

**Fix:** Track error state and emit onError when player is unexpectedly nil.

### 7. **iOS: Memory Management Issue** (MEDIUM)
**File:** `HybridNitroVLCView.swift:332-333`

```swift
aspectRatioCString = strdup(ratio)
player.videoAspectRatio = aspectRatioCString
```

The strdup'd string is never freed if the player is deallocated without calling cleanup.

**Fix:** Ensure cleanup() is always called, or use a deinit that frees the string.

### 8. **Video Track Required for onLoad** (MEDIUM)
**File:** `HybridNitroVLCView.kt:471`

```kotlin
private fun buildVideoInfo(player: MediaPlayer): VideoInfo? {
    val videoTrack = player.currentVideoTrack ?: return null  // Returns null for audio-only!
```

For audio-only content, onLoad is never emitted because there's no video track.

**Fix:** Make video track optional:
```kotlin
val videoTrack = player.currentVideoTrack
val width = videoTrack?.width ?: 0
val height = videoTrack?.height ?: 0
```

### 9. **Android: Unprotected Surface Access** (MEDIUM)
**File:** `HybridNitroVLCView.kt:266-275`

```kotlin
private fun attachSurface(holder: SurfaceHolder) {
    val player = mediaPlayer ?: return
    if (holder.surface == null || !holder.surface.isValid) return
    val vout = player.vlcVout
    vout.setVideoSurface(holder.surface, holder)
    if (!vout.areViewsAttached()) {
        vout.attachViews(this)
        viewsAttached = true
    }
}
```

Surface operations can throw if called at wrong time. No try-catch protection.

**Fix:** Wrap in try-catch.

### 10. **Thread Safety: Callbacks from Wrong Thread** (MEDIUM)

Both iOS and Android may invoke VLC callbacks from background threads, but the Nitro callbacks may need to be on the main thread for JS.

**Fix:** Ensure all Nitro callbacks are dispatched to the main thread:
```kotlin
// Android
runOnUiThread {
    onPlaying?.invoke(event)
}

// iOS  
DispatchQueue.main.async {
    self.onPlaying?(event)
}
```

## Recommended Priority Fixes

1. **Critical (Fix Immediately):**
   - Issue #1: Race condition in event handling
   - Issue #2: Unsafe Media creation
   - Issue #3: Null libVLC access

2. **High (Fix Before Release):**
   - Issue #4: Early media release
   - Issue #5: Silent failures
   - Issue #6: Unsafe player access

3. **Medium (Fix When Possible):**
   - Issue #7: Memory management
   - Issue #8: Audio-only support
   - Issue #9: Surface protection
   - Issue #10: Thread safety

## Testing Recommendations

1. Test with malformed URIs
2. Test with network failures
3. Test rapid play/stop/play cycles
4. Test audio-only content
5. Test with app backgrounding/foregrounding
6. Test on low-memory devices
