# Task: Background-mode sometimes disables PiP and triggers P2P reconnect overlay

## Symptom
User reports that background mode sometimes causes PiP to get disabled. When this happens and the video is reopened from background, the "connecting to P2P" overlay appears on top of the video. That overlay normally does not appear when PiP/background behavior is healthy.

## Strong hint
This likely means the app is sometimes suspending networking / backend state when it should not, or failing to recognize that active local playback / PiP should keep the playback path warm.

## Suspect files
- `packages/app/app/_layout.tsx`
  - network suspend/resume AppState handling
  - logs like `[App] Resuming network from foreground` and `[App] Skipping network suspend - local playback is active`
- `packages/app/lib/VideoPlayerContext.tsx`
  - background / foreground handling
  - PiP flags and app-state handling
- `packages/app/components/VideoPlayerOverlayImpl.tsx`
  - PiP enable/disable interactions if any still affect app-state timing

## Goal
Find root cause first. Avoid blind fixes.

## Need to determine
1. Under what exact condition does network suspend still happen while playback/PiP should keep it alive?
2. Is the app confusing background-with-active-playback vs true inactive background?
3. Is PiP disablement actually secondary to a backend/network suspend/resume cycle?

## Discussion

## Claude Proposal

### Root cause: `playbackActiveEmitter` has a race-window where it reads `false` during the background transition

The emitter lives in `packages/app/lib/video-player/VideoControlContext.tsx`:

```ts
export const playbackActiveEmitter = {
  isActive: false,
  set(active: boolean) { this.isActive = active },
}
```

It is updated from a React `useEffect` in `VideoPlayerContext.tsx:247-250`:

```ts
useEffect(() => {
  isPlayingRef.current = isPlaying
  _playbackActiveEmitter.set(currentVideo !== null && (isPlaying || isInPipMode))
}, [isPlaying, currentVideo, isInPipMode])
```

The condition is: `currentVideo !== null && (isPlaying || isInPipMode)`.

### Why this is too narrow — three failure windows

**1. `isPlaying` goes false before the background handler checks it**

When the app backgrounds on Android, the OS may briefly pause audio focus or the native player may fire a `pause` event during the PiP entry transition. `VideoPlayerContext` handles `case 'pause'` by calling `setIsPlaying(false)` (line 632). This triggers the `useEffect`, which sets `playbackActiveEmitter.isActive = false`. If the grace-timer check in `_layout.tsx:703` fires during this window, it sees `isActive === false` and proceeds to call `suspendNetwork()`.

The code already defends against *spurious pauses during PiP exit* (lines 271-278, `pipExitExpectedPlayingRef`), but there is no equivalent guard for the *PiP entry* path. A brief native pause during PiP entry is enough to flip the emitter off.

**2. `isInPipMode` is set asynchronously — gap between background and PiP**

`isInPipMode` (React state) is only set to `true` when the native PiP callback reaches JS. On Android, the sequence is:

1. `AppState` → `background` (immediate)
2. `_layout.tsx` `handleAppStateChange` fires, checks `playbackActiveEmitter.isActive`
3. Native PiP animation starts
4. Native PiP callback fires → JS sets `isInPipMode = true` → effect updates emitter

Between steps 2 and 4, `isInPipMode` is still `false`. If `isPlaying` is also momentarily false (window #1), the emitter reads `false` and the 8-second grace timer begins. If the pause lasts >8s or the timer was already running from a prior `inactive` event, `suspendNetwork()` fires.

**3. Background audio playback without PiP**

On iOS, background audio continues playing without PiP (e.g., user switches apps while listening to a video). If PiP fails or is not enabled, `isInPipMode` stays `false`. The emitter then depends entirely on `isPlaying`. A momentary buffering stall or audio-session interruption that flips `isPlaying = false` will drop the guard, and the 8-second timer will suspend the network — killing the stream and causing the "connecting to P2P" overlay on return.

### Why network suspend causes the overlay on re-open

`suspendNetwork()` tears down the Hyperswarm connections. When the user returns to foreground, `_layout.tsx:744` calls `resumeNetwork()`, but re-establishing the P2P swarm takes time. During this reconnection window, the UI shows the "connecting to P2P" overlay because the backend reports no active peers/connections.

If PiP was active, the PiP window also becomes useless (no data flowing), so Android may dismiss it or the app effectively disables it.

### Proposed fix

**The emitter condition should be: `currentVideo !== null`** (video session is open), not `currentVideo !== null && (isPlaying || isInPipMode)`.

Rationale: if a video is loaded, the user expects it to remain connected and resumable. Transient play/pause state and the async PiP flag should not be the signal that governs network lifecycle. The network should stay alive for the entire duration of an open video session.

Concretely:

```ts
// VideoPlayerContext.tsx — line 249
_playbackActiveEmitter.set(currentVideo !== null)
```

This eliminates all three race windows. The network will only be suspended when the video is fully closed (`currentVideo === null`), which is a clean, unambiguous signal.

The 8-second grace timer in `_layout.tsx` already provides the safety net for cases where the user closes a video and immediately backgrounds — the timer will still fire and suspend if appropriate.

### Alternative (more conservative)

If full-session keepalive is too broad (e.g., concern about keeping network alive for a paused-and-forgotten video), add a `videoSessionActive` flag that is `true` from `loadAndPlayVideo` to `closeVideo`, independent of play/pause state:

```ts
_playbackActiveEmitter.set(currentVideo !== null && (isPlaying || isInPipMode || isBackgroundedRef.current))
```

This adds `isBackgroundedRef.current` so that any open video prevents suspend while backgrounded, but allows suspend if the user returns to foreground and pauses. However, this still has the gap where `isBackgroundedRef` is set *inside* `VideoPlayerContext`'s handler, which may fire after `_layout.tsx`'s handler (React effect ordering). The simpler `currentVideo !== null` is more robust.

### Secondary: the 8-second grace timer can stack

In `_layout.tsx:699`, the grace timer is set inside `maybeSuspendWithGrace`, but `clearCastSuspendGraceTimer` only clears `castSuspendGraceTimerRef`. If the app rapidly cycles `inactive` → `active` → `background` (common on Android during PiP transitions), a new `maybeSuspendWithGrace` call can start while the previous grace timer is still pending. The `suspendInFlightRef` guard prevents re-entry into `maybeSuspendWithGrace`, but the *already-scheduled* timer callback from the first call will still fire and check `playbackActiveEmitter.isActive` at an arbitrary future time. This is a secondary contributor — the timer may fire after PiP is settled but during a transient pause.
