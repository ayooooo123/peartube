# Replace MpvPlayer with HTML5 Video (react-native-video web) Implementation Plan

> **Superseded/extended by `2026-06-11-retire-libmpv-cross-platform.md`** — this doc
> is the Electrobun/web slice of a broader cross-platform libmpv retirement. Two
> updates since this was written: (1) the "Known tradeoffs" codec loss below is no
> longer accepted — `MseVideoPlayer.web.tsx` + mediabunny already remux MKV, and a
> bare-ffmpeg audio-transcode fallback (`2026-06-11-desktop-mse-audio-transcode-fallback.md`)
> covers AC-3/DTS, so this becomes a **regression-free** swap; (2) the desktop-native
> app is now **in scope** of the umbrella plan, not permanently out of scope.

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify all platforms on `react-native-video` by removing the MpvPlayer/bare-mpv desktop playback path and using react-native-video's built-in web implementation (which renders a standard HTML5 `<video>` tag) on Pear Desktop.

**Architecture:** Currently, desktop (Pear) uses bare-mpv with canvas-based frame streaming over RPC, while mobile uses react-native-video (ExoPlayer on Android, AVPlayer on iOS). react-native-video v6.19.1 ships a `Video.web.tsx` that renders a native `<video>` element via react-native-web. By removing the MpvPlayer code path and making `PearInlineVideoView` render on web, we get a unified player component across all platforms. The blob server already serves video over HTTP with Range request support, so `<video src={blobUrl}>` works directly.

**Tech Stack:** react-native-video ^6.19.1, react-native-web (already in Expo), Metro `.web.tsx` resolution

**Known tradeoffs:** HTML5 `<video>` in Chromium has narrower codec support than mpv (no MKV containers, no AC3/DTS audio, HEVC only via hardware decode). This is accepted — the user reports no playback issues on Android (ExoPlayer) and wants consistency over codec breadth.

**Out of scope:** The `packages/desktop-native` Swift native app has its own `MpvPlayerView.swift` and mpv sidecar infrastructure — that is a separate native macOS app and is not affected by this plan.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| **Delete** | `packages/app/components/MpvPlayer.web.tsx` | Canvas-based mpv player + HTML5 fallback (531 lines) |
| **Rewrite** | `packages/app/components/video-player/PearInlineVideoView.web.tsx` | Currently returns `null`; will become the real web player |
| **Modify** | `packages/app/components/VideoPlayerOverlayImpl.tsx` | Remove MpvPlayer import, replace 3 render sites, simplify platform conditions |
| **Modify** | `packages/app/components/video-player/PearInlineVideoView.tsx` | Remove `Platform.OS === 'web'` early return guard (line 348-350) |
| **Modify** | `packages/app/pear-src/workers/core/index.ts` | Remove mpv infrastructure (~100 lines: handlers, frame server, player map, lazy loading) |
| **Modify** | `packages/spec/schema.cjs` | Remove 9 mpv RPC method registrations + 18 message type definitions |
| **Modify** | `packages/app/package.json` | Remove `ensure-bare-mpv.js` from `pear:install` script |
| **Delete** | `packages/app/scripts/ensure-bare-mpv.js` | Script that copies bare-mpv into pear node_modules |

---

## Chunk 1: Frontend — Swap MpvPlayer for PearInlineVideoView on web

### Task 1: Make PearInlineVideoView render on web

The current `PearInlineVideoView.web.tsx` is a stub that returns `null`. We need it to render react-native-video's `<Video>` component, which on web resolves to a `<video>` tag.

**Strategy:** Delete the `.web.tsx` stub so Metro falls through to `PearInlineVideoView.tsx`, then remove the web guard from that file. react-native-video's own `.web.tsx` handles the web rendering. Props like `useTextureView`, `bufferConfig`, `enterPictureInPictureOnLeave` are silently ignored by the web implementation.

**Files:**
- Delete: `packages/app/components/video-player/PearInlineVideoView.web.tsx`
- Modify: `packages/app/components/video-player/PearInlineVideoView.tsx:348-350`

- [ ] **Step 1: Delete the web stub**

Delete `packages/app/components/video-player/PearInlineVideoView.web.tsx` entirely. This file currently exports a memo'd component returning `null` and a `getPearInlinePlayerId` helper. The helper is also defined identically in the native `.tsx` file (line 38-40), so nothing is lost.

- [ ] **Step 2: Remove the web early-return guard from PearInlineVideoView.tsx**

In `packages/app/components/video-player/PearInlineVideoView.tsx`, remove lines 348-350:

```typescript
// DELETE these 3 lines:
if (Platform.OS === 'web') {
  return null
}
```

The component will now render the `<Video>` component on all platforms. react-native-video's web implementation handles the rendering.

- [ ] **Step 3: Guard native-only callbacks for web safety**

In `PearInlineVideoView.tsx`, the stuck-playback detection uses `AppState` (lines 121-133) which works on web via react-native-web but fires differently. The `handleProgress` function (line 233) does stuck detection with reload attempts — on web, a stuck reload is a source remount. This should work as-is since `sourceKey` state change forces a re-render of the `<Video>` element.

Review that the `AppState` listener doesn't cause issues on web. It shouldn't — `react-native-web` maps `AppState` to `visibilitychange` events. No code change expected, but verify during testing.

- [ ] **Step 4: Verify react-native-video resolves on web**

Run: `cd packages/app && npx expo start --web --no-dev`

Open browser, navigate to a video. Verify:
- The `<video>` tag appears in DOM (inspect element)
- Video loads from blob server URL
- Play/pause/seek controls work through the overlay
- Progress callbacks fire (scrubber updates)

- [ ] **Step 5: Commit**

```bash
git add packages/app/components/video-player/PearInlineVideoView.tsx
git rm packages/app/components/video-player/PearInlineVideoView.web.tsx
git commit -m "feat(player): enable PearInlineVideoView on web platform

Remove the web stub that returned null and the Platform.OS === 'web'
guard. react-native-video's built-in web implementation renders a
standard HTML5 <video> tag via react-native-web."
```

---

### Task 2: Replace MpvPlayer with PearInlineVideoView in VideoPlayerOverlayImpl.tsx

There are 3 MpvPlayer render sites and 1 PearInlineVideoView render site in this file. The MpvPlayer sites need to be replaced, and the platform conditions simplified.

**Key interface difference:** MpvPlayer uses `ref={playerRef}` (React forwardRef + `useImperativeHandle`) and has its own simplified props. PearInlineVideoView uses `playerRef={playerRef}` (direct assignment pattern) and requires richer props (isPlaying, playbackRate, seekPosition, etc.). All required props are already available in the overlay's scope.

**Key callback difference:** MpvPlayer's `onProgress` returns `{currentTime, duration}` in **seconds** — the overlay multiplies by 1000. PearInlineVideoView's `onProgress` passes react-native-video's data directly (already in the format the overlay expects). So when replacing MpvPlayer, remove the `* 1000` conversion.

**Files:**
- Modify: `packages/app/components/VideoPlayerOverlayImpl.tsx`

- [ ] **Step 1: Remove MpvPlayer import**

In `packages/app/components/VideoPlayerOverlayImpl.tsx`, delete lines 10-11:

```typescript
// DELETE these 2 lines:
// MpvPlayer for Pear Desktop
import { MpvPlayer } from './MpvPlayer'
```

- [ ] **Step 2: Replace MpvPlayer in desktop mini player (lines 2333-2348)**

Replace the MpvPlayer block at lines 2333-2348 with PearInlineVideoView. The surrounding `<div>` container (lines 2319-2325) stays — it provides the mini player dimensions.

Replace:
```tsx
<MpvPlayer
  key={`mpv-mini:${playbackSession}:${currentVideo?.channelKey || ''}:${currentVideo?.id || videoUrl}`}
  ref={playerRef}
  url={videoUrl}
  autoPlay
  onCanPlay={onPlaying}
  onPaused={onPaused}
  onPlaying={onPlaying}
  onEnded={onEnded}
  onError={(err) => onError?.({ nativeEvent: { error: err } } as any)}
  onProgress={(data) => onProgress?.({
    currentTime: data.currentTime * 1000,
    duration: data.duration * 1000,
  } as any)}
  style={{ width: '100%', height: '100%' }}
/>
```

With:
```tsx
<PearInlineVideoView
  style={StyleSheet.absoluteFill}
  playerRef={playerRef}
  videoUrl={videoUrl}
  playbackSession={playbackSession}
  currentVideoKey={`${currentVideo?.channelKey || ''}:${currentVideo?.id || ''}`}
  isPlaying={isPlaying}
  playbackRate={playbackRate}
  seekPosition={playerSeekPosition}
  videoTitle={currentVideo?.title}
  channelName={currentVideo?.channel?.name}
  thumbnailUrl={currentVideo?.thumbnailUrl}
  onLoad={handleVideoLoad}
  onProgress={onProgress}
  onPlaying={onPlaying}
  onPaused={onPaused}
  onBuffering={onBuffering}
  onEnded={onEnded}
  onError={onError}
  onVideoStateChange={onVideoStateChange}
/>
```

Note: No PiP props needed in mini player mode. No `* 1000` conversion — PearInlineVideoView passes progress data in the format the overlay expects.

- [ ] **Step 3: Replace MpvPlayer in desktop fullscreen player (lines 2551-2566)**

Same replacement pattern as Step 2. Replace the MpvPlayer at lines 2551-2566:

Replace:
```tsx
<MpvPlayer
  key={`mpv:${playbackSession}:${currentVideo?.channelKey || ''}:${currentVideo?.id || videoUrl}`}
  ref={playerRef}
  url={videoUrl}
  autoPlay
  onCanPlay={onPlaying}
  onPaused={onPaused}
  onPlaying={onPlaying}
  onEnded={onEnded}
  onError={(err) => onError?.({ nativeEvent: { error: err } } as any)}
  onProgress={(data) => onProgress?.({
    currentTime: data.currentTime * 1000,
    duration: data.duration * 1000,
  } as any)}
  style={{ width: '100%', height: '100%', borderRadius: 12 }}
/>
```

With:
```tsx
<PearInlineVideoView
  style={{ ...StyleSheet.absoluteFillObject, borderRadius: 12 }}
  playerRef={playerRef}
  videoUrl={videoUrl}
  playbackSession={playbackSession}
  currentVideoKey={`${currentVideo?.channelKey || ''}:${currentVideo?.id || ''}`}
  isPlaying={isPlaying}
  playbackRate={playbackRate}
  seekPosition={playerSeekPosition}
  videoTitle={currentVideo?.title}
  channelName={currentVideo?.channel?.name}
  thumbnailUrl={currentVideo?.thumbnailUrl}
  onLoad={handleVideoLoad}
  onProgress={onProgress}
  onPlaying={onPlaying}
  onPaused={onPaused}
  onBuffering={onBuffering}
  onEnded={onEnded}
  onError={onError}
  onVideoStateChange={onVideoStateChange}
/>
```

- [ ] **Step 4: Unify the mobile fallback render path (lines 2941-2985)**

Currently at lines 2941-2985 there are two mutually exclusive blocks:
- `Platform.OS !== 'web'` → PearInlineVideoView (mobile)
- `Platform.OS === 'web' && isPear` → MpvPlayer (desktop)

Since PearInlineVideoView now works on web, merge these into a single block:

Replace:
```tsx
{Platform.OS !== 'web' && videoUrl && (
  <PearInlineVideoView
    ... (existing props)
  />
)}
{Platform.OS === 'web' && isPear && videoUrl && (
  <MpvPlayer
    ... (mpv props)
  />
)}
```

With:
```tsx
{videoUrl && (
  <PearInlineVideoView
    style={StyleSheet.absoluteFill}
    playerRef={playerRef}
    videoUrl={videoUrl}
    playbackSession={playbackSession}
    currentVideoKey={`${currentVideo?.channelKey || ''}:${currentVideo?.id || ''}`}
    isPlaying={isPlaying}
    playbackRate={playbackRate}
    seekPosition={playerSeekPosition}
    isInPipMode={isInPipMode}
    pipWindowSize={pipWindowSize}
    pipEnabled={iosPipEnabled}
    videoTitle={currentVideo?.title}
    channelName={currentVideo?.channel?.name}
    thumbnailUrl={currentVideo?.thumbnailUrl}
    onLoad={handleVideoLoad}
    onPictureInPictureChanged={handlePipStatusChanged}
    onProgress={onProgress}
    onPlaying={onPlaying}
    onPaused={onPaused}
    onBuffering={onBuffering}
    onEnded={onEnded}
    onError={onError}
    onVideoStateChange={onVideoStateChange}
  />
)}
```

The PiP props are harmless on web — react-native-video's web implementation ignores them if browser PiP isn't available.

- [ ] **Step 5: Remove the player type logging variable**

At line 497, the `player` variable is only used for logging:
```typescript
const player = Platform.OS === 'web' ? (isPear ? 'mpv' : 'web') : 'react-native-video'
```

Change to:
```typescript
const player = Platform.OS === 'web' ? 'react-native-video-web' : 'react-native-video'
```

This is cosmetic — it's only used in the `playerLogKeyRef` for dedup logging.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd packages/platform && npx tsc --noEmit`

Note: This runs typecheck on `packages/platform`, not `packages/app` (per CLAUDE.md — pre-existing TS errors exist in platform, app doesn't have its own tsconfig for checking).

Also verify Metro can resolve the module:
Run: `cd packages/app && npx expo start --web` — check for import resolution errors in terminal.

- [ ] **Step 7: Commit**

```bash
git add packages/app/components/VideoPlayerOverlayImpl.tsx
git commit -m "refactor(player): replace MpvPlayer with PearInlineVideoView on desktop

Swap all 3 MpvPlayer render sites (mini player, fullscreen, mobile
fallback) to PearInlineVideoView. Unify the mobile/desktop video player
conditional into a single PearInlineVideoView that renders on all
platforms via react-native-video's web implementation."
```

---

### Task 3: Delete MpvPlayer.web.tsx

**Files:**
- Delete: `packages/app/components/MpvPlayer.web.tsx`

- [ ] **Step 1: Verify no remaining imports**

Search for any remaining references to MpvPlayer:

```bash
grep -r "MpvPlayer\|from.*MpvPlayer\|import.*MpvPlayer" packages/app/components/ packages/app/lib/
```

Expected: No matches. If there are matches, update those files first.

- [ ] **Step 2: Delete MpvPlayer.web.tsx**

```bash
git rm packages/app/components/MpvPlayer.web.tsx
```

This removes 531 lines: the MpvPlayer component (canvas frame streaming, RPC player lifecycle, frame server HTTP fetching) and Html5VideoFallback component.

- [ ] **Step 3: Commit**

```bash
git rm packages/app/components/MpvPlayer.web.tsx
git commit -m "chore(player): remove MpvPlayer.web.tsx

Canvas-based mpv frame streaming component is no longer used.
Desktop playback now uses react-native-video's HTML5 <video> tag."
```

---

## Chunk 2: Backend — Remove mpv infrastructure from Pear worker

### Task 4: Remove mpv handlers and infrastructure from pear worker

The Pear worker (`packages/app/pear-src/workers/core/index.ts`) has ~100 lines of mpv infrastructure: lazy loading, player map, frame server HTTP handler, 9 RPC handlers, and shutdown cleanup. All of this is now dead code.

**Files:**
- Modify: `packages/app/pear-src/workers/core/index.ts`

- [ ] **Step 1: Remove mpv infrastructure variables and functions (lines 24-75)**

Delete the following blocks:
- Lines 24-25: `isMpvSupported` platform detection
- Lines 27-29: `MpvPlayer`, `mpvLoadError`, `mpvLoadPromise` variables
- Lines 31-42: `loadBareMpv()` async function
- Lines 43-44: `if (isMpvSupported)` eager load / else clause
- Lines 45-46: `mpvPlayers` Map, `mpvPlayerIdCounter`
- Lines 47-49: `mpvFrameServer`, `mpvFrameServerPort`, `mpvFrameServerReady` variables
- Lines 50-65: `handleMpvFrameRequest()` HTTP handler
- Lines 66-75: `ensureMpvFrameServer()` function

- [ ] **Step 2: Remove mpv RPC handlers (lines 689-706)**

Delete lines 689-706:
```typescript
B.mpvAvailable = async () => { ... }
B.mpvCreate = async (r: any) => { ... }
B.mpvLoadFile = async (r: any) => { ... }
B.mpvPlay = async (r: any) => { ... }
B.mpvPause = async (r: any) => { ... }
B.mpvSeek = async (r: any) => { ... }
B.mpvGetState = async (r: any) => { ... }
B.mpvRenderFrame = async (r: any) => { ... }
B.mpvDestroy = async (r: any) => { ... }
```

Replace with no-op stubs that return "not available" so the HRPC schema doesn't error if any old client calls them:
```typescript
// mpv handlers removed — desktop uses HTML5 <video> now
B.mpvAvailable = async () => ({ available: false, error: 'mpv removed — using HTML5 video' })
B.mpvCreate = async () => ({ success: false, error: 'mpv removed' })
B.mpvLoadFile = async () => ({ success: false, error: 'mpv removed' })
B.mpvPlay = async () => ({ success: false })
B.mpvPause = async () => ({ success: false })
B.mpvSeek = async () => ({ success: false })
B.mpvGetState = async () => ({ success: false, error: 'mpv removed' })
B.mpvRenderFrame = async () => ({ success: false, hasFrame: false, frameData: null, error: 'mpv removed' })
B.mpvDestroy = async () => ({ success: false })
```

- [ ] **Step 3: Remove mpv cleanup from shutdown handler (lines 792-794)**

Delete these lines from the `Pear.teardown` handler:
```typescript
for (const [id, state] of mpvPlayers) { try { state.player.destroy() } catch {} }
mpvPlayers.clear()
if (mpvFrameServer) { try { mpvFrameServer.close() } catch {}; mpvFrameServer = null; mpvFrameServerPort = 0; mpvFrameServerReady = null }
```

- [ ] **Step 4: Remove bare-mpv dependency from pear-src/package.json**

In `packages/app/pear-src/package.json` (line 33), remove:
```json
"bare-mpv": "file:../../bare-mpv",
```

- [ ] **Step 5: Remove ensure-bare-mpv from pear build pipeline**

In `packages/app/package.json` (line 23), change:
```json
"pear:install": "cd pear && npm install && cd .. && node scripts/ensure-bare-mpv.js",
```
To:
```json
"pear:install": "cd pear && npm install",
```

- [ ] **Step 6: Delete ensure-bare-mpv.js script**

```bash
git rm packages/app/scripts/ensure-bare-mpv.js
```

- [ ] **Step 7: Verify pear worker compiles**

```bash
cd packages/app && npx swc pear-src/workers/core/index.ts -o /dev/null
```

Expected: Compiles without errors. The `bare-mpv` import is removed, so no unresolved module.

- [ ] **Step 8: Commit**

```bash
git add packages/app/pear-src/workers/core/index.ts packages/app/pear-src/package.json packages/app/package.json
git rm packages/app/scripts/ensure-bare-mpv.js
git commit -m "chore(worker): remove mpv infrastructure from pear worker

Remove bare-mpv lazy loading, frame server, player map, and 9 RPC
handlers. Replace with no-op stubs for schema compatibility.
Remove ensure-bare-mpv.js build script."
```

---

### Task 5: Remove mpv RPC schema definitions

The HRPC schema still defines 9 mpv methods and 18 message types. Removing them keeps the schema clean, but requires regenerating the HRPC spec.

**Files:**
- Modify: `packages/spec/schema.cjs`

- [ ] **Step 1: Remove mpv message type definitions (lines 981-1123)**

Delete all `ns.register()` blocks for mpv types:
- `mpv-available-request` / `mpv-available-response` (lines 981-992)
- `mpv-create-request` / `mpv-create-response` (lines 994-1010)
- `mpv-load-file-request` / `mpv-load-file-response` (lines 1012-1026)
- `mpv-play-request` / `mpv-play-response` (lines 1028-1041)
- `mpv-pause-request` / `mpv-pause-response` (lines 1043-1056)
- `mpv-seek-request` / `mpv-seek-response` (lines 1058-1072)
- `mpv-get-state-request` / `mpv-get-state-response` (lines 1074-1090)
- `mpv-render-frame-request` / `mpv-render-frame-response` (lines 1092-1109)
- `mpv-destroy-request` / `mpv-destroy-response` (lines 1111-1124)

- [ ] **Step 2: Remove mpv RPC method registrations (lines 2370-2423)**

Delete the `// MPV player commands` section and all 9 `rpcNs.register()` blocks for mpv methods.

- [ ] **Step 3: Regenerate HRPC spec**

```bash
cd packages/spec && node schema.cjs
```

This regenerates `spec/hrpc/` and `spec/schema/`. Verify no errors.

- [ ] **Step 4: Remove mpv no-op stubs from pear worker**

Now that the schema no longer defines mpv methods, remove the no-op stubs added in Task 4 Step 2. The HRPC runtime won't call handlers for methods that don't exist in the schema.

In `packages/app/pear-src/workers/core/index.ts`, delete the `B.mpvAvailable` through `B.mpvDestroy` stub assignments.

- [ ] **Step 5: Rebuild pear to verify**

```bash
cd packages/app && npm run pear:build
```

Expected: Build succeeds. No "handler not registered" errors since the mpv methods are gone from the schema.

- [ ] **Step 6: Commit**

```bash
git add packages/spec/schema.cjs packages/spec/spec/ packages/app/pear-src/workers/core/index.ts
git commit -m "chore(spec): remove mpv RPC schema definitions

Remove 9 mpv method registrations and 18 message type definitions.
Regenerate HRPC spec. Clean up no-op stubs from pear worker."
```

---

## Chunk 3: Verification & Cleanup

### Task 6: End-to-end verification

- [ ] **Step 1: Test desktop Pear playback**

```bash
cd packages/app && npm run pear:build
cd packages/app/pear && pear run --dev --store=$HOME/.peartube .
```

Verify:
1. Navigate to a video
2. Video plays in the main player area (HTML5 `<video>` in DOM)
3. Play/pause works (spacebar and click)
4. Seek works (scrubber drag, click)
5. Progress bar updates
6. Mini player works (minimize button → floating mini player with playback)
7. Volume control (if wired)
8. Video ends → `onEnded` fires

- [ ] **Step 2: Test mobile playback still works (regression)**

```bash
cd packages/app && npx expo start
```

Test on iOS simulator and/or Android emulator:
1. Video plays normally
2. PiP works (home button on Android, PiP button on iOS)
3. Background audio continues
4. Notification controls appear

- [ ] **Step 3: Verify no MpvPlayer references remain**

```bash
grep -r "MpvPlayer\|bare-mpv\|mpvAvailable\|mpvCreate\|mpvLoadFile\|mpvPlay\|mpvPause\|mpvSeek\|mpvGetState\|mpvRenderFrame\|mpvDestroy\|ensureMpvFrameServer\|mpvFrameServer" packages/app/components/ packages/app/lib/ packages/app/pear-src/ packages/spec/
```

Expected: No matches (except possibly in git history or generated bundles).

Note: `packages/desktop-native/` and `packages/bare-mpv/` will still have mpv references — that's the separate Swift native app, out of scope for this plan.

- [ ] **Step 4: Final commit (if any fixups needed)**

If Steps 1-3 revealed any issues, fix and commit.
