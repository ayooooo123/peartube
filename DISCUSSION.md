# Task: PiP pause button changes state but does not actually pause playback

## Symptom
User reports that pressing pause in Android PiP does not actually pause the video.

## Strong hypothesis
In `VideoPlayerContext.tsx`, the remote command handler currently updates `isPlaying`, but on Android it does not directly call `playerRef.current?.pause?.()` for remote pause or `playerRef.current?.play?.()` for remote play while backgrounded/PiP. Since PiP/background is timing-sensitive, relying only on React state -> `paused={!isPlaying}` propagation may be too indirect.

## Files to inspect
- `packages/app/lib/VideoPlayerContext.tsx`
- `packages/app/components/video-player/PearInlineVideoView.tsx`
- `packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt`

## Goal
Make PiP play/pause buttons directly control the underlying player on Android without reintroducing state races.

## Discussion

## Claude Proposal

### Root cause

The remote-command listener in `VideoPlayerContext.tsx` (L569–671) already calls
`playerRef.current?.play()` / `pause()` directly for **iOS** when backgrounded or
in PiP, but every one of those branches is guarded by `Platform.OS === 'ios'`.
Android relies solely on `setIsPlaying(true/false)` → React prop propagation
(`paused={!isPlaying}`), which is unreliable during PiP/background because the
React tree may be throttled or the view unmounted.

Three specific gaps:

| Command           | Line  | iOS behaviour             | Android behaviour (bug)                  |
|-------------------|-------|---------------------------|------------------------------------------|
| `play` (bg)       | 605–614 | `setIsPlaying` + `playerRef.play()` | Sets ref, returns early — **no play**    |
| `pause` (bg/pip)  | 628–631 | `setIsPlaying` + `playerRef.pause()` | `setIsPlaying` only — **no pause**       |
| `togglePlayPause` | 665–667 | `setIsPlaying` + `playerRef.play()` | `resumeFromRemote` only — **no direct call** |

### Smallest safe fix

Add direct `playerRef` calls for Android in the same three branches. No new state,
no new refs, no architectural changes — mirrors what iOS already does.

```tsx
// ── play (case 'play', backgrounded, ~L605) ──────────────────────
case 'play':
  console.log('[VideoPlayerContext] Setting isPlaying = true')
  if (isBackgroundedRef.current) {
    if (Platform.OS === 'ios' && currentVideoRef.current) {
      setIsPlaying(true)
      try { playerRef.current?.play?.() } catch {}
-   } else {
+   } else if (Platform.OS === 'android') {
+     // Android PiP/background: direct play + state update.
+     // remotePlayWhileBackgroundedRef is still set so foreground
+     // resume logic continues to work.
      remotePlayWhileBackgroundedRef.current = true
-     return
+     setIsPlaying(true)
+     try { playerRef.current?.play?.() } catch {}
+     return
    }
    break
  }
  resumeFromRemote()
  break

// ── pause (case 'pause', ~L628) ──────────────────────────────────
  setIsPlaying(false)
- if (isBackgroundedRef.current && Platform.OS === 'ios') {
+ if (isBackgroundedRef.current || isInPipModeRef.current) {
    try { playerRef.current?.pause?.() } catch {}
  }
  break

// ── togglePlayPause (case 'togglePlayPause', ~L661) ──────────────
case 'togglePlayPause':
  console.log('[VideoPlayerContext] Toggling play/pause')
  if (isPlayingRef.current) {
    setIsPlaying(false)
+   if (isBackgroundedRef.current || isInPipModeRef.current) {
+     try { playerRef.current?.pause?.() } catch {}
+   }
- } else if (isBackgroundedRef.current && Platform.OS === 'ios' && currentVideoRef.current) {
+ } else if (isBackgroundedRef.current && currentVideoRef.current) {
    setIsPlaying(true)
    try { playerRef.current?.play?.() } catch {}
  } else {
    resumeFromRemote()
  }
  break
```

### Why this is safe

1. **Idempotent** — `play()` on an already-playing player is a no-op in VLC;
   same for `pause()`. No double-fire risk.
2. **State stays in sync** — `setIsPlaying` is still called alongside the direct
   call, so React state and MediaSession metadata remain correct.
3. **Existing PiP-exit guard preserved** — the `pipExitExpectedPlayingRef` /
   `pipExitResumeUntilRef` check (L619–627) still runs *before* the pause branch,
   preventing the known Android PiP-exit spurious-pause race.
4. **`remotePlayWhileBackgroundedRef` still set** — foreground-resume logic
   (`onForeground`) still fires correctly when the user returns to the app.
5. **No new refs, effects, or native changes** — change is confined to one
   `useEffect` in `VideoPlayerContext.tsx`.
