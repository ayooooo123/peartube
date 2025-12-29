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
