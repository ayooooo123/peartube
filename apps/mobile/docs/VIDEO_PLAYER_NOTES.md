# Video Player Implementation Notes

## Overview
PearTube mobile uses `react-native-vlc-media-player` for video playback due to its broad codec support (MKV, multiple audio tracks, subtitles, network streams, RTSP, HLS, etc.).

## Features Implemented

### Core Playback
- [x] VLC-based video playback with broad codec support
- [x] Play/pause controls
- [x] Progress bar with current time / duration display
- [x] Seek by dragging progress bar
- [x] Skip forward/backward 10 seconds
- [x] Playback speed control (0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x)

### Mini Player (YouTube-style)
- [x] Floating mini player at bottom of screen
- [x] Continues playback when navigating away
- [x] Tap to expand back to fullscreen
- [x] Play/pause and close buttons
- [x] Progress bar indicator
- [x] Swipe down to dismiss

### Animations & Gestures
- [x] Smooth animated transitions between mini and fullscreen (react-native-reanimated)
- [x] Pan gesture to drag between states
- [x] Velocity-based snap to mini or fullscreen
- [x] Controls overlay with fade in/out on tap
- [x] Auto-hide controls after 3 seconds

### P2P Integration
- [x] P2P stats bar showing:
  - Connection status (Connecting, Downloading, Cached)
  - Peer count
  - Download progress percentage
  - Download speed (MB/s)
- [x] Loading overlay during initial P2P connection
- [x] Uses `drive.monitor()` for efficient event-driven stats (not polling)

## Architecture

### Key Files
- `lib/VideoPlayerContext.tsx` - Global state management for video playback
- `components/VideoPlayerOverlay.tsx` - Main player UI with animations
- `components/MiniPlayer.tsx` - YouTube-style floating mini player

### Context State
- `currentVideo` / `videoUrl` - Current video data and stream URL
- `isPlaying` / `isLoading` - Playback state
- `playerMode` - 'hidden' | 'mini' | 'fullscreen'
- `currentTime` / `duration` / `progress` - Playback position
- `vlcSeekPosition` - Seek target (0-1 range, undefined when not seeking)

## VLC Player Specifics

### Seeking Implementation
VLC uses a `seek` **prop** (not a ref method) with values 0-1:

```tsx
<VLCPlayer
  seek={vlcSeekPosition !== undefined ? vlcSeekPosition : -1}
  // ...
/>
```

**Critical: Use -1 as sentinel value, not null/undefined**

When a React Native prop is removed or set to null, RN sends the default value (0 for float) to native code. This causes unwanted seek to beginning. Using -1 works because VLC's native code ignores values outside [0,1]:

```objc
// From RCTVLCPlayer.m
- (void)setSeek:(float)pos {
    if ([_player isSeekable]) {
        if (pos>=0 && pos <= 1) {  // -1 fails this check
            [_player setPosition:pos];
        }
    }
}
```

### Seek Flow
1. User triggers seek → `seekTo(timeInSeconds)` called
2. Calculate normalized position: `seekValue = time / duration`
3. Set `vlcSeekPosition` to seekValue
4. VLCPlayer receives `seek={0.5}` → native setSeek called → video seeks
5. After 100ms, clear: `setSeekPosition(undefined)`
6. VLCPlayer receives `seek={-1}` → native ignores it

### Progress Callback
VLC reports time in **milliseconds**:

```tsx
onProgress={(data) => {
  setCurrentTime(data.currentTime / 1000)  // Convert to seconds
  setDuration(data.duration / 1000)
}}
```

### Buffering Callback
VLC's onBuffering provides an object with `isBuffering` boolean:

```tsx
onBuffering={(data) => {
  if (data?.isBuffering !== undefined) {
    setIsLoading(data.isBuffering)
  }
}}
```

## Problems Encountered & Solutions

### 1. Loading overlay staying visible during playback
**Problem**: "Connecting to P2P..." overlay stayed on screen even when video was playing.
**Cause**: `onBuffering` callback wasn't checking the `isBuffering` value, always setting loading to true.
**Solution**: Check `data.isBuffering` and set loading state accordingly.

### 2. Seeking not working (visual only)
**Problem**: Progress bar moved but video didn't seek.
**Cause**: Attempted to use `playerRef.current.seek()` which doesn't exist. VLC uses a `seek` prop.
**Solution**: Pass seek position via prop, not ref method.

### 3. Video restarting when seeking
**Problem**: Any seek attempt caused video to restart from beginning.
**Cause**: Removing the `seek` prop (setting to null/undefined) caused React Native to send default float value (0) to native.
**Solution**: Use -1 as "no seek" value instead of removing the prop. VLC ignores -1 because it's outside [0,1] range.

## Dependencies

```json
{
  "react-native-vlc-media-player": "VLC-based playback",
  "react-native-reanimated": "60fps animations for player transitions",
  "react-native-gesture-handler": "Pan/tap gestures for player controls",
  "react-native-safe-area-context": "Safe area insets for notch/home indicator",
  "lucide-react-native": "Icons (Play, Pause, RotateCcw, RotateCw, etc.)"
}
```

## Technical Notes

### Animation System
The player uses `react-native-reanimated` for smooth 60fps animations:
- `animProgress` shared value (0 = mini, 1 = fullscreen)
- Interpolated values for position, size, opacity
- Spring-based animations with custom config
- Gesture-driven transitions with velocity detection

### State Management
Global video state via React Context allows:
- Continuous playback across screen navigation
- Mini player persistence
- Shared playback controls from any screen

### P2P Stats with Hyperdrive Monitor

The backend uses Hyperdrive's built-in `drive.monitor()` for efficient download progress tracking:

```javascript
// Create monitor for a specific video file
const monitor = drive.monitor(videoPath)
await monitor.ready()

// Event-driven updates (fires on each block download)
monitor.on('update', () => {
  const stats = monitor.downloadStats
  // stats.blocks - blocks downloaded during monitoring
  // stats.peers - current peer count
  // monitor.downloadSpeed() - accurate real-time speed via speedometer
})
```

**Key implementation details:**
- Initial local blocks counted separately (monitor only tracks new downloads)
- Total progress = `initialBlocks + monitor.downloadStats.blocks`
- Speed uses built-in `speedometer` library for accuracy
- Monitor stored in Map for cleanup and live speed queries
- Cleanup after 30 seconds post-completion

### VLC Expo Plugin
The app uses the VLC Expo config plugin for native integration:
```json
// app.config.js
{
  "plugins": [
    ["react-native-vlc-media-player", {
      "ios": { "includeVLCKit": false },
      "android": { "legacyJetifier": false }
    }]
  ]
}
```

## Future Improvements

### High Priority
- [ ] Volume control (gesture or slider)
- [ ] Fullscreen orientation lock (landscape)
- [ ] Resume playback from last position

### Medium Priority
- [ ] Platform-specific native-looking controls (iOS/Android)
- [ ] Picture-in-Picture support
- [ ] Subtitle track selection UI
- [ ] Audio track selection UI
- [ ] Thumbnail previews on seek

### Low Priority
- [ ] AirPlay integration (iOS)
- [ ] Chromecast support
- [ ] Keyboard shortcuts (for iPad)
- [ ] Background audio mode
- [ ] Lock screen controls
