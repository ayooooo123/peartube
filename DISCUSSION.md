# Task: Phase 2 — explicit closeSession(reason) and pause vs close semantics

## Goal
Implement a dedicated `closeSession(reason)` flow so PearTube stops scattering teardown behavior across PiP/remote/app-state paths.

## Need to inspect
- `packages/app/lib/VideoPlayerContext.tsx`
  - closePlayer / minimize / maximize / restore / PiP exit paths
  - remote command handling
  - currentVideo/session teardown logic
- `packages/app/lib/playerStateMachine.ts`
  - CLOSE / APP_FOREGROUND / PIP_EXITED_ANDROID / REMOTE_STOP transitions
- Android MediaSession glue
  - how PiP close or remote stop currently surfaces

## Desired outcome
- one explicit helper that closes a video session
- pause does not clear session
- close does clear session
- later we can map PiP close onto this helper cleanly

## Discussion

## Claude Proposal

### Problem summary

Session teardown is duplicated in three places, each resetting a different subset of state:

| Call site | Location | What it resets |
|-----------|----------|----------------|
| `closeVideo()` | line 1298 | Full teardown: queued playback, seek refs, PiP refs, player stop/pause, suppress foreground restore, lastClosed=null, currentVideo=null, dispatch CLOSE_VIDEO, clear MediaSession, reset stats/time/duration |
| remote `stop` handler | line 655 | Partial teardown: PiP exit refs, player stop/pause, lastClosed=null, currentVideo=null, dispatch CLOSE_VIDEO, clear MediaSession, reset stats/time/duration. **Missing**: queued playback drain, seek refs, suppress foreground restore, `closingVideoRef` |
| `pendingAndroidMinimizeClose` PiP-entry path | line 816 | Minimal teardown: player stop/pause, dispatch CLOSE_VIDEO. **Missing**: almost everything else — refs, MediaSession, stats, currentVideo |

This means:
1. Adding a new teardown step requires editing 3 places (shotgun surgery).
2. The remote-stop and PiP-close paths skip important cleanup, risking stale state bugs (e.g., stale `currentVideoRef` after PiP close, foreground restore firing after remote stop).

### Proposed shape: `closeSession(reason)`

```typescript
type CloseReason = 'user' | 'remote-stop' | 'pip-close' | 'new-video'

const closeSession = useCallback((reason: CloseReason) => {
  console.log(`[VideoPlayerContext] closeSession(${reason})`)

  // ── 1. Mark closing ──────────────────────────────
  closingVideoRef.current = true
  pendingAndroidMinimizeCloseRef.current = false

  // ── 2. Cancel queued / in-flight playback ────────
  queuedPlaybackStartRef.current = null
  playbackStartInFlightRef.current = false
  playbackStartCooldownUntilRef.current = 0
  if (playbackStartDrainTimerRef.current) {
    clearTimeout(playbackStartDrainTimerRef.current)
    playbackStartDrainTimerRef.current = null
  }

  // ── 3. Cancel pending seek ───────────────────────
  if (seekClearTimeoutRef.current) {
    clearTimeout(seekClearTimeoutRef.current)
    seekClearTimeoutRef.current = null
  }
  seekConfirmRef.current = null

  // ── 4. Reset PiP transition state ────────────────
  pipExitShouldResumeRef.current = false
  pipExitExpectedPlayingRef.current = false
  pipExitResumeUntilRef.current = 0
  pipTransitionInFlightRef.current = false

  // ── 5. Stop native player ────────────────────────
  try {
    playerRef.current?.stop?.()
    playerRef.current?.pause?.()
  } catch {}

  // ── 6. Suppress foreground restore (avoid ghost resurrect) ─
  if (reason !== 'new-video') {
    suppressForegroundRestoreRef.current = true
    const suppressUntil = Date.now() + 2000
    if (suppressUntil > suppressForegroundRestoreUntilRef.current) {
      suppressForegroundRestoreUntilRef.current = suppressUntil
    }
  }

  // ── 7. Clear session refs ────────────────────────
  // Note: NOT saving to lastClosed — that's a caller concern
  // (closeVideo saves it, remote-stop intentionally doesn't)
  currentVideoRef.current = null
  videoUrlRef.current = null
  remotePlayWhileBackgroundedRef.current = false

  // ── 8. Dispatch state transition + reset UI state ─
  setIsPlaying(false)
  dispatch({ type: 'CLOSE_VIDEO', source: 'closeVideo' })
  setVideoStats(null)
  setCurrentTime(0)
  setDuration(0)

  // ── 9. Clear MediaSession ────────────────────────
  if (Platform.OS !== 'web') {
    MediaSession.clearNowPlaying().catch(() => {})
    MediaSession.clearPendingPlayerLaunchPayload().catch(() => {})
    setMediaSessionActive(false)
  }
  mediaSessionActiveRef.current = false
}, [dispatch, setMediaSessionActive])
```

### Key design decisions

1. **`reason` is a plain string union, not a config object.** Each reason maps to a single well-known code path. If we later need per-reason branching (e.g., `reason !== 'new-video'` for suppress-foreground), the reason tag is sufficient — no need for `{ suppressRestore: boolean, clearLastClosed: boolean }` option bags that recreate the current fragmentation.

2. **`lastClosedVideo` is NOT set inside `closeSession`.** The current `closeVideo()` saves `lastClosedVideo` for "resume where you left off" UX, but remote-stop intentionally nulls it. This is a *caller* concern. `closeVideo()` will save it before calling `closeSession('user')`, and remote-stop won't.

3. **Foreground restore suppression is skipped for `'new-video'`.** When closing the old session to load a new one (`performPlaybackStartNow`), we don't want to suppress foreground restore — the new video should restore normally.

4. **`pendingAndroidMinimizeClose` stays as a ref, not a reason.** The PiP-entry path (line 816) uses `pendingAndroidMinimizeCloseRef` as a flag to decide *whether* to close. That decision logic stays where it is — but the *teardown* it performs routes through `closeSession('pip-close')` instead of its current 4-line inline version.

### Migration plan: which call sites route through it first

**Phase 2a — safe, high-value (do first):**

| Call site | Change |
|-----------|--------|
| `closeVideo()` (line 1298) | Save `lastClosedVideo/Url/Time`, then call `closeSession('user')`. Remove all inline teardown. |
| Remote `stop` handler (line 655) | Null out `lastClosed*` refs, then call `closeSession('remote-stop')`. Removes ~20 lines of partial teardown and fixes missing cleanup. |
| `pendingAndroidMinimizeClose` PiP-entry (line 816) | Replace 4-line inline teardown with `closeSession('pip-close')`. Fixes the most incomplete teardown path. |

**Phase 2b — follow-up (lower risk, do second):**

| Call site | Change |
|-----------|--------|
| `performPlaybackStartNow` (line 947) | Already resets many of the same refs. Could call `closeSession('new-video')` for the "stop old player" portion, then proceed with load. Requires care: some refs it resets (like `closingVideoRef = false`) are intentionally *opposite* of what `closeSession` sets. Evaluate whether a `prepareForNewSession()` wrapper is cleaner. |

### What this unlocks

- **PiP dismiss → close** becomes `closeSession('pip-close')` — no more incomplete teardown.
- **Future close reasons** (e.g., `'error'`, `'timeout'`, `'channel-gone'`) just add a union member.
- **Audit is trivial**: grep for `closeSession` to see every path that ends a session. Currently you have to grep for `dispatch.*CLOSE_VIDEO` AND `currentVideoRef.current = null` AND `playerRef.current?.stop` to find them all.
