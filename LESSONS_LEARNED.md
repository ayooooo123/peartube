# Lessons Learned

## Pear Runtime

### Do NOT clear pear's by-dkey cache
The pear runtime itself is a pear app distributed via the pear protocol. The `~/Library/Application Support/pear/by-dkey/` directory contains the runtime binaries. Clearing this directory will break the `pear` command entirely.

**What I broke:**
```bash
rm -rf ~/Library/Application\ Support/pear/by-dkey/*  # DON'T DO THIS
```

**What happens:**
- The `pear` symlink at `~/Library/Application Support/pear/bin/pear` points to `current`
- `current` is a symlink to a specific version in `by-dkey/`
- Clearing `by-dkey` breaks everything

**To reinstall pear:** The runtime is NOT installed via curl. It's a pear app itself - needs to be installed through the pear protocol/bootstrap process.

### "Cannot find module '/'" error
This error from `DependencyStream._resolveModule` during `pear run --dev` was NOT caused by:
- The pear-electron/pre script
- The expo web export files
- The package.json pear config
- The node_modules directory

The error persisted even with:
- Minimal HTML with no scripts
- Minimal pear config (`{"name":"x","type":"desktop"}`)
- No node_modules

But a clean directory at `/tmp/pear-test` worked fine - indicating the issue was related to cached state in pear, not the project files themselves.

**Investigation approach that would have been better:**
1. First test in a completely clean directory to isolate pear vs project issues
2. If clean test works, investigate project-specific caching, NOT pear's internal cache
3. Never delete pear's by-dkey directory

---

## React Native Web / Expo

### Platform-Specific Files (.web.tsx)

Metro bundler automatically resolves platform-specific file extensions. For example:
- `VideoCard.tsx` - Native iOS/Android version
- `VideoCard.web.tsx` - Web/Desktop version

**Critical: Interfaces MUST match!**

When using platform-specific files that are imported via an index.ts, both versions must export the same interface. Otherwise you get React error #130 (Element type is invalid: undefined).

**Example of broken setup:**
```typescript
// VideoCard.tsx (native)
interface VideoCardProps {
  video: VideoData
  onPress: () => void
}
export function VideoCard({ video, onPress }: VideoCardProps) { ... }

// VideoCard.web.tsx (web) - WRONG: different interface!
interface VideoCardProps {
  id: string
  title: string
  onPress?: () => void
}
export function VideoCardDesktop({ id, title, onPress }: VideoCardProps) { ... }
```

When index.ts exports `{ VideoCard }` from `./VideoCard`, Metro resolves to `./VideoCard.web.tsx` on web - but if it exports a differently-named function or different interface, imports will break.

**Solution: Keep interfaces consistent, or use separate explicit imports for web components.**

### Check for .web.tsx Versions!

When debugging issues that only occur on desktop/web, ALWAYS check if there's a `.web.tsx` version of the file you're editing. Changes to `index.tsx` won't affect desktop if `index.web.tsx` exists!

Common locations with platform-specific files:
- `app/(tabs)/index.tsx` vs `app/(tabs)/index.web.tsx`
- `components/video/VideoCard.tsx` vs `components/video/VideoCard.web.tsx`
- `components/desktop/*.web.tsx` (desktop-only components)

---

## Desktop UI Patterns

### Modal/View State Management

When playing videos on desktop, close any open modals/views first. The video player overlay takes over the main content area, so leaving modals open causes overlapping UI.

```typescript
// In playVideo function - close channel view before playing
const playVideo = useCallback(async (video: VideoData) => {
  // Close any open views first
  setViewingChannel(null)
  setChannelVideos([])

  // Then load and play video
  const result = await rpcCall(CMD.GET_VIDEO_URL, { ... })
  if (result?.url) {
    loadAndPlayVideo(video, result.url)
  }
}, [rpcCall, loadAndPlayVideo])
```

### Z-Index Layering

Desktop layout has multiple fixed-position elements. Use high z-index for overlays:
- Sidebar: z-index 50
- Header: z-index 100
- Video overlay: z-index 1000 (must be higher than everything)

### Desktop Layout Constants

```typescript
PEAR_BAR_HEIGHT = 52   // macOS traffic lights area
HEADER_HEIGHT = 56     // App header with search
SIDEBAR_WIDTH = 240    // Expanded sidebar
SIDEBAR_COLLAPSED = 72 // Collapsed sidebar
```

Sidebar top position = `PEAR_BAR_HEIGHT + HEADER_HEIGHT` (108px) because it's position:fixed relative to viewport, not content area.

---

## Autobase / Comments

### Viewer Autobase needs its own keyPair
When opening a read-only CommentsAutobase on a viewer, pass a per-device `keyPair` to Autobase (e.g. `corestore.createKeyPair('peartube-comments-viewer:<channelKey>')`).
If you do not, Autobase follows the bootstrap core's `autobase/local` pointer (owner local writer) and the viewer never reaches `base.opened=true` (inputs stays 0, ready() times out).

### Optional: force fast-forward bootstrap for viewers
If a viewer still stalls during ready(), force a fast-forward bootstrap (`force: true`, `minimum: 1`) before waiting for ready().

---

## MPV Playback + Upload

### Pear worker is ESM; avoid top-level require
Pear workers are bundled as ESM. `require` is not defined, so native addons must be loaded via dynamic `import()` and cached in a loader.

### Metro must ignore pear build output
Metro will crawl `packages/app/pear` and can crash on file/dir name collisions. Blocklist the pear build directory in `packages/app/metro.config.js`.

### Avoid mpv re-init loops
Do not put volatile callbacks in the mpv init effect dependency list. Keep callbacks in refs so mpv is not created/destroyed every render.

### Web playback controls need manual wiring
mpv has no native controls in the canvas. Play/pause/seek must call the mpv ref, and the watch page needs its own control overlay logic.

### Disable audio transcoding when mpv is default
With mpv on desktop and VLC on mobile, audio transcoding can be disabled to preserve original codecs. Gate it in the Pear worker and the shared audio transcoder so uploads keep original media.

---

## Chromecast HLS Transcoding (Mobile)

### E-AC3 -> AAC frame size mismatch causes encoder errors
Symptom: Chromecast stays idle and logs show repeated `Audio error: Invalid argument` or crash.
Cause: E-AC3 frames are 1536 samples, AAC-LC requires 1024 samples. Sending 1536 samples directly to the AAC encoder fails.
Fix: Buffer resampled audio with `AudioFIFO` and read exactly 1024 samples per AAC frame before encoding.

### Use-after-free crash when reusing encoderFrame
Symptom: `hardened_malloc: fatal allocator error: detected write after free` shortly after casting begins.
Cause: `audioEncoder.sendFrame()` may keep a reference to `encoderFrame` buffers. Reusing the same frame without reallocating can lead to writing into freed memory.
Fix: Before each FIFO read, call `encoderFrame.unref()` and `encoderFrame.alloc()` to allocate a fresh buffer. Also `audioFrame.unref()` after each decoded audio frame to release decoder-owned buffers.

### Keep FIFO/frames sample format aligned with encoder
Use `audioEncoder.sampleFormat` for:
- `resampledFrame.format`
- `AudioFIFO` sample format
- `encoderFrame.format`
This avoids mismatches between resampler output and encoder input.

### HLS playlist crash fix
Symptom: `/hls/.../stream.m3u8` request throws `firstSegmentIndex is not defined`.
Fix: Define `firstSegmentIndex`/`lastSegmentIndex` in `packages/app/backend/hls-segment-manager.mjs` when generating playlists.

### Code locations and rebuild
- Transcode logic: `packages/app/backend/hls-transcoder.mjs`
- Playlist generation: `packages/app/backend/hls-segment-manager.mjs`
- Bundle version marker: `packages/app/backend/index.mjs`
- Rebuild mobile bundle: `npm run bundle:backend`
Check logs for:
`[Backend] Bundle version: add-audio-fifo-v4`
`[HlsTranscoder] TRANSCODER_VERSION: add-audio-fifo-v4`

---

## Android Picture-in-Picture (PiP) with VLC

### Second PiP Entry Zoom Issue

**Problem:** First PiP entry works, but subsequent entries show zoomed/incorrectly sized video.

**Root Cause:** When `mNativePipWidthPx` and `mNativePipHeightPx` are already set to the PiP dimensions (e.g., 527x297), calling `holder.setFixedSize(527, 297)` with the SAME dimensions doesn't trigger `surfaceChanged()` because Android detects no change.

**Fix:** Before setting new PiP dimensions, check if they're the same as current. If so, reset first:
```java
boolean dimensionsChanged = (mNativePipWidthPx != widthPx || mNativePipHeightPx != heightPx);
if (!dimensionsChanged && mNativePipWidthPx > 0) {
    // Force reset to ensure surfaceChanged fires
    mNativePipWidthPx = 0;
    mNativePipHeightPx = 0;
    holder.setSizeFromLayout();  // Reset to layout-based sizing
}
// Then set the actual dimensions
mNativePipWidthPx = widthPx;
mNativePipHeightPx = heightPx;
holder.setFixedSize(widthPx, heightPx);
```

### JS-Side Debounce Breaking Dimension Updates

**Problem:** JS side debounce at lines 365-368 of `VideoPlayerContext.tsx` only checked the boolean `isInPictureInPicture`, not the dimensions. This meant PiP resize events (same boolean, different dimensions) were dropped.

**Fix:** Check both state AND dimensions in debounce logic:
```typescript
const sameState = event.isInPictureInPicture === wasInPip
const sameDimensions = event.width === pipWindowSize?.width && event.height === pipWindowSize?.height
const tooSoon = now - lastPipEventTimeRef.current < 100

if (sameState && sameDimensions && tooSoon) {
  return  // Only skip if BOTH are identical
}
```

### VLC Sizing API Calls

**Key APIs for PiP sizing:**
- `vlcOut.setWindowSize(width, height)` - Sets the window/surface size VLC renders to
- `mMediaPlayer.setScale(0)` - Best fit (auto-scale to window)
- `mMediaPlayer.setAspectRatio(width + ":" + height)` - Force aspect ratio to match container
- `mMediaPlayer.updateVideoSurfaces()` - Tells VLC to re-evaluate and re-render

**Important:** `mVideoWidth` and `mVideoHeight` member variables are used by VLC internally. When entering PiP, update these to match the PiP container size.

### Avoid Hacky Delay Loops

**Problem:** Original code had multiple `postDelayed()` loops (50ms, 150ms, 300ms, 500ms, 800ms, 1200ms) that were unreliable and could corrupt `mVideoWidth/mVideoHeight`.

**Better approach:** Use event-driven callbacks:
- `surfaceChanged()` - Called when SurfaceHolder dimensions change
- `onNewVideoLayout()` - VLC callback when video layout changes
- Single 100ms delayed re-apply as backup (not multiple)

### Key Files for Android PiP

| File | Purpose |
|------|---------|
| `ReactVlcPlayerView.java` | VLC SurfaceView with PiP sizing logic |
| `VlcPlayerBridge.java` | Native module bridge for PiP commands |
| `PipBridge.java` | Android PiP API integration |
| `VideoPlayerContext.tsx` | JS state management for PiP mode |

### Initial PiP Entry Zoom Issue (SOLVED)

**Problem:** First PiP entry shows video zoomed/cropped. It only fixes when user drags/moves the PiP window.

**Root Cause:** React Native throttles UI updates when app is backgrounded/in PiP mode. The Surface resizes immediately, but the View stays at fullscreen dimensions until user interaction forces a re-render.

**The Challenge:**
1. Native `onPictureInPictureModeChanged` fires
2. We can resize the Surface immediately (528x298)
3. But React Native View stays at fullscreen (960x540)
4. Android stretches the smaller Surface to fill the larger View = **ZOOM**
5. Calling `setLayoutParams()`, `requestLayout()`, `invalidate()` don't work - React Native controls the View

**The Solution: Transform-Based Approach**

Instead of fighting React Native's layout system, apply a **scale transform** to the View:

```java
public void applyPipSizeFromNative(int widthPx, int heightPx) {
    mNativePipWidthPx = widthPx;
    mNativePipHeightPx = heightPx;

    int viewWidth = getWidth();
    int viewHeight = getHeight();

    if (viewWidth > 0 && viewHeight > 0) {
        // Calculate scale based on width (landscape PiP is width-constrained)
        float scale = (float) widthPx / viewWidth;

        // Set pivot to top-left and apply uniform scale
        setPivotX(0);
        setPivotY(0);
        setScaleX(scale);
        setScaleY(scale);
    }
}
```

**How it works:**
- View stays at fullscreen (960x540) as React Native wants
- Transform scales it down visually to PiP size (528x298)
- Android's PiP window clips to show only the scaled content
- Video appears correctly sized immediately!

**Transform Clearing (Critical):**

When React Native finally resizes the View (on drag or later), clear the transform to avoid double-scaling:

```java
// In surfaceChanged, onLayoutChange, AND onPreDraw listener:
boolean viewMatchesPip = Math.abs(width - mNativePipWidthPx) < 10
                      && Math.abs(height - mNativePipHeightPx) < 10;

if (viewMatchesPip && (getScaleX() != 1.0f || getScaleY() != 1.0f)) {
    setScaleX(1.0f);
    setScaleY(1.0f);
    setPivotX(width / 2f);
    setPivotY(height / 2f);
}
```

Three places clear the transform to catch all timing scenarios:
1. `surfaceChanged()` - when Surface resizes
2. `onLayoutChange()` - when View resizes
3. `OnPreDrawListener` - catches the frame BEFORE it's drawn (fastest)

**Remaining Minor Issue:**

When dragging/resizing PiP window, there's a very brief stutter (1-2 frames) where video appears in top-left corner before transform clears. This is cosmetic and clears almost instantly.

**JS-Side Changes Required:**

Also save/restore `playerMode` on PiP entry/exit so user returns to correct state:

```typescript
// On PiP enter:
playerModeBeforePipRef.current = playerMode

// On PiP exit:
setPlayerMode(playerModeBeforePipRef.current)  // Not always 'fullscreen'
```

**Why Transform Works When Layout Doesn't:**

- `setLayoutParams()` - React Native intercepts and overrides
- `requestLayout()` - React Native doesn't process in background
- `setScaleX/Y()` - **Visual-only transform**, doesn't affect layout, React Native doesn't care
- The transform is applied at render time, before the frame is drawn to screen

### Debugging PiP Issues

Add logging with `VLC_PIP` tag and filter with:
```bash
adb logcat -s VLC_PIP:D
```

Also check PipBridge and MediaSession logs:
```bash
adb logcat | grep -E "VLC_PIP|PipBridge|MediaSession|VideoPlayerContext"
```

Key log points:
- `applyPipSizeFromNative` - Entering PiP, shows transform scale applied
- `clearPipSizeFromNative` - Exiting PiP, transform cleared
- `surfaceChanged` - Surface dimension changes, shows if transform was cleared
- `onLayoutChange` - View layout changes, shows scale value
- `onPreDraw: View matches PiP, clearing transform` - Transform cleared before frame draw
- `Manager.setPipContainerSize` - React Native prop reaching native (if never appears = RN throttled)

**Log Pattern for Successful PiP Entry:**
```
applyPipSizeFromNative: 528x298 px (view: 960x540)
applyPipSizeFromNative: applied transform scale=0.55 viewLandscape=true
surfaceChanged: 528x298 nativePip=528x298 scale=0.55
  → If View matches, expect: "clearing transform"
  → If View still fullscreen, transform stays, video still looks correct
```

**Log Pattern for PiP Exit:**
```
clearPipSizeFromNative
clearPipSizeFromNative: reset transforms to identity
```
