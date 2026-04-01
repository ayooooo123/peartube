# Task: Add a real background_audio mode before adding a PiP 'send to background audio' action

## Goal
Design the minimum clean change needed for a Grayjay-style PiP action that dismisses PiP but keeps the session playing in background audio mode.

## Current constraint
`hidden` is too close to teardown / invisible-player behavior. We should not overload it.

## Proposal direction
Add a new presentation/session mode:
- `background_audio`

Semantics:
- no visible player UI in app
- session remains open
- desiredPlaying may remain true
- MediaSession stays active
- backend/network stays warm
- reopening app can restore fullscreen or mini explicitly

## Files to inspect
- `packages/app/lib/playerStateMachine.ts`
- `packages/app/lib/VideoPlayerContext.tsx`
- `packages/app/components/VideoPlayerOverlayImpl.tsx`
- Android media session / PiP action plumbing

## Need from discussion
1. Minimum mode/state-machine changes for `background_audio`
2. Which current `hidden` behaviors must NOT apply to `background_audio`
3. Best restore behavior from background audio back into app
4. How the future PiP action should map to this mode cleanly

## Discussion

## Claude Proposal

### 1. State-machine shape

Add `'background_audio'` to `PlayerStateMode`. It is an **active** mode (has `video` + `url`), not a hidden mode:

```ts
export type PlayerStateMode =
  | 'hidden'
  | 'loading'
  | 'fullscreen'
  | 'mini'
  | 'pip_entering'
  | 'pip_active'
  | 'pip_exiting'
  | 'background_audio'   // ← new
```

The `ActivePlayerState` union already covers `Exclude<PlayerStateMode, 'hidden'>`, so `background_audio` gets `video` + `url` for free — no type changes needed there.

Add a `modeBeforeBackgroundAudio` field to `PlaybackMemory` (parallels `modeBeforePip`):

```ts
type PlaybackMemory = {
  wasPlayingWhenBackgrounded: boolean
  wasPlayingWhenPipEntered: boolean
  modeBeforePip: ModeBeforePip
  modeBeforeBackgroundAudio: ModeBeforePip  // ← new
}
```

#### Transition map additions

```
background_audio: {
  LOAD_VIDEO:    'fullscreen'   // new video → pop back to fullscreen
  CLOSE_VIDEO:   'hidden'       // user explicitly closes
  MAXIMIZE:      'fullscreen'   // restore from background audio
  APP_FOREGROUND: 'fullscreen' | 'mini'  // use modeBeforeBackgroundAudio
  REMOTE_PLAY:   'background_audio'      // already playing, no-op
  REMOTE_PAUSE:  'background_audio'      // stay in bg audio, just paused
  REMOTE_TOGGLE_PLAY_PAUSE: 'background_audio'
  REMOTE_STOP:   'hidden'       // if we add REMOTE_STOP event later
}
```

Entry transitions (new event `ENTER_BACKGROUND_AUDIO`):

```
fullscreen → background_audio  (via ENTER_BACKGROUND_AUDIO)
mini       → background_audio  (via ENTER_BACKGROUND_AUDIO)
pip_active → background_audio  (via ENTER_BACKGROUND_AUDIO, from PiP action)
```

New event type:

```ts
| {
    type: 'ENTER_BACKGROUND_AUDIO'
    source: 'pipActionBackgroundAudio' | 'userBackgroundAudio'
  }
```

#### `toUnifiedViewMode` mapping

```ts
case 'background_audio':
  return 'hidden'  // no visible player UI — overlay renders nothing
```

This is correct because from the *view layout* perspective, background_audio has no visible player. The unified view mode is about rendering, not session lifecycle.

### 2. `hidden`-mode teardown behaviors that must NOT run for `background_audio`

The mode-change effect in `VideoPlayerContext.tsx` (lines 405–437) runs this when `nextMode === 'hidden'`:

| Teardown behavior | Run for `background_audio`? | Why |
|---|---|---|
| Clear seek timeout + ref | ❌ No | Seek state should survive; user may return |
| Clear PiP transition refs | ✅ Yes | PiP is done if entering from PiP |
| `isInPipModeRef = false` | ✅ Yes | No longer in PiP |
| `setPipWindowSize(null)` | ✅ Yes | No PiP window |
| `setSeekPosition(undefined)` | ❌ No | Preserve scrubber state for restore |
| `setVideoStats(null)` | ❌ No | Stats still flowing from backend |
| `setVideoAspectRatio(null)` | ❌ No | Needed for restore layout |
| `setIsLoading(false)` | ❌ No | May still be buffering |
| `MediaSession.clearNowPlaying()` | ❌ **Absolutely not** | This IS the background audio session |
| `setMediaSessionActive(false)` | ❌ **Absolutely not** | Must stay active for lock-screen controls |
| `mediaSessionActiveRef = false` | ❌ **Absolutely not** | Same reason |

The `closeSession()` function (lines 1283–1346) must also **never** be called for a `background_audio` transition. `closeSession` does:
- `playerRef.current?.stop()` / `.pause()` — would kill audio
- `currentVideoRef.current = null` — would lose session identity
- `MediaSession.clearNowPlaying()` — would kill lock-screen controls
- dispatches `CLOSE_VIDEO` → `hidden`

**Implementation**: Add a guard at the top of the mode-change effect:

```ts
if (nextMode === 'background_audio') {
  // Clear PiP state if coming from PiP
  if (previousMode.startsWith('pip_')) {
    pipTransitionInFlightRef.current = false
    pipExitShouldResumeRef.current = false
    isInPipModeRef.current = false
    setPipWindowSize(null)
  }
  // Everything else stays alive — MediaSession, video refs, stats, seek state
  return
}
```

### 3. Overlay rendering

In `VideoPlayerOverlayImpl.tsx`, the early-return at line 2267 (`if (!currentVideo) return null`) already handles unmounting. For `background_audio`, `currentVideo` is still set (it's an active mode), so we need an explicit guard:

```tsx
if (!currentVideo) return null
if (playerMode === 'background_audio') return null  // no visible player
```

This unmounts the VLC/video view but the `VideoPlayerContext` provider (which lives in `_layout.tsx`) stays mounted, keeping all refs, MediaSession, and backend connections alive.

The landscape-exit effect (line 2148) should also trigger for `background_audio`:

```ts
if ((playerMode === 'mini' || playerMode === 'hidden' || playerMode === 'background_audio') && isLandscapeFullscreen) {
```

### 4. Restore behavior

**APP_FOREGROUND while in `background_audio`**: Restore to `modeBeforeBackgroundAudio` (fullscreen or mini). The reducer handles this:

```ts
case 'background_audio': {
  switch (event.type) {
    case 'APP_FOREGROUND':
      return { ...state, mode: state.modeBeforeBackgroundAudio }
    case 'MAXIMIZE':
      return withMode(state, 'fullscreen')
    // ...
  }
}
```

**REMOTE_PLAY / REMOTE_PAUSE**: Stay in `background_audio`. Only `APP_FOREGROUND`, `MAXIMIZE`, or `LOAD_VIDEO` exit it. This avoids accidental mode flips from lock-screen play/pause.

**`restoreFromBackgroundAudio()` helper** exposed on context:

```ts
const restoreFromBackgroundAudio = useCallback(() => {
  if (state.mode !== 'background_audio') return
  dispatch({
    type: 'MAXIMIZE',
    source: 'maximizePlayer',
  })
}, [state.mode, dispatch])
```

### 5. How the future PiP action maps cleanly

The PiP custom action (Android `RemoteAction` / iOS PiP controller action) dispatches:

```ts
dispatch({
  type: 'ENTER_BACKGROUND_AUDIO',
  source: 'pipActionBackgroundAudio',
})
```

On Android, this also calls `PipBridge.exitPip()` (or equivalent) to dismiss the PiP window. The state machine handles the rest — `pip_active → background_audio` stores `modeBeforePip` into `modeBeforeBackgroundAudio` and clears PiP state.

### 6. `_playbackActiveEmitter` — no change needed

Line 254: `_playbackActiveEmitter.set(currentVideo !== null)`. Since `background_audio` keeps `currentVideo` set, the backend/network stays warm automatically. No change needed.

### Summary: files touched

| File | Change |
|---|---|
| `playerStateMachine.ts` | Add `'background_audio'` to mode union, add `modeBeforeBackgroundAudio` to `PlaybackMemory`, add `ENTER_BACKGROUND_AUDIO` event, add transition map entry, add reducer case |
| `VideoPlayerContext.tsx` | Add `background_audio` guard in mode-change effect (skip teardown), expose `restoreFromBackgroundAudio`, do NOT call `closeSession` for bg audio transitions |
| `VideoPlayerOverlayImpl.tsx` | Early-return `null` when `playerMode === 'background_audio'`, add to landscape-exit guard |
| `video-player.ts` | Possibly add `'background_audio'` to `PlayerViewMode` if the unified contract needs it (or map to `'hidden'` in `toUnifiedViewMode`) |

Total: ~80 lines of state machine + ~15 lines of context guards + ~5 lines of overlay. No new files.
