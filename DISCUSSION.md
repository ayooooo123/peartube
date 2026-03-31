# Task: Define a proper Android backgrounding / lock screen / PiP-close UX flow for PearTube

## Goal
Turn the desired Android UX into a concrete implementation spec that simplifies the current behavior.

## Product principles
- mini player is in-app UI state
- PiP is system UI state
- lock screen is media-session UI state
- backgrounding is app lifecycle
- session open/closed is playback/backend ownership

Do not conflate these.

## Desired policy
- `currentVideo !== null` means the video session is open and backend/network should stay warm
- Home while playing -> PiP
- Lock screen while playing -> background audio + media controls, not forced PiP
- PiP close -> close video session
- Pause != close
- Only suspend network when session is truly closed or after idle timeout
- Mini mode should not directly decide backend suspend behavior

## Need from discussion
1. A clean event/state table for:
   - APP_HOME
   - APP_LOCKED
   - APP_FOREGROUND
   - PIP_ENTERED
   - PIP_EXITED
   - PIP_CLOSED
   - VIDEO_CLOSED
   - TASK_REMOVED
   - REMOTE_PLAY / REMOTE_PAUSE / REMOTE_STOP
2. Recommended source-of-truth variables
3. Suggested code ownership:
   - `_layout.tsx`
   - `VideoPlayerContext.tsx`
   - `playerStateMachine.ts`
   - Android MediaSession/PipBridge
4. Low-risk refactor plan to move toward this model

## Discussion

## Claude Proposal

### 1. Event / State Table

The core insight: **the player state machine should not model PiP sub-phases**. PiP entering/active/exiting are *system animation states*, not player states. The player only cares about two things: its **view mode** (fullscreen, mini, hidden) and whether **the system is currently showing a PiP window** (a boolean flag, not a state machine mode).

#### Source events and their effects

| Event | Trigger | Player Mode Change | MediaSession | ForegroundService | Backend/Network |
|-------|---------|-------------------|--------------|-------------------|-----------------|
| **APP_HOME** (playing) | `onUserLeaveHint` + not locked | none (stay fullscreen/mini) | keep active | keep alive | keep warm |
| **APP_HOME** (paused) | `onUserLeaveHint` + not locked | none | keep active | keep alive | keep warm |
| **APP_LOCKED** (playing) | screen off / power button | none | keep active, update lock screen | start if not running | keep warm |
| **APP_LOCKED** (paused) | screen off | none | keep active | keep alive | keep warm |
| **APP_FOREGROUND** | app resumed | none (restore pre-background mode) | keep active | keep alive | keep warm |
| **PIP_ENTERED** | system PiP animation started | none (flag `isSystemPip = true`) | keep active | keep alive | keep warm |
| **PIP_EXITED** | user tapped PiP to return to app | flag `isSystemPip = false` | keep active | keep alive | keep warm |
| **PIP_CLOSED** | user dismissed PiP window | → hidden (`closeVideo()`) | deactivate | stop | suspend after idle |
| **VIDEO_CLOSED** | user closes player in-app | → hidden | deactivate | stop | suspend after idle |
| **TASK_REMOVED** | user swipes app from recents | → hidden | deactivate, release | stop | suspend |
| **REMOTE_PLAY** | lock screen / notification / headset | resume playback | update state | keep alive | keep warm |
| **REMOTE_PAUSE** | lock screen / notification / headset | pause playback (mode unchanged) | update state | keep alive | keep warm |
| **REMOTE_STOP** | lock screen dismiss / notification clear | → hidden (`closeVideo()`) | deactivate | stop | suspend after idle |

Key distinction from current code: **APP_HOME no longer forces PiP entry from JS**. Instead, `setAutoEnterEnabled(true)` on the PiP params handles it natively — the system enters PiP automatically on home press. JS only needs to know about the resulting `PIP_ENTERED` callback, not orchestrate the transition.

#### How to distinguish Home vs Lock Screen

Current problem: both Home and Lock trigger `onUserLeaveHint()`. The fix:

```kotlin
// In MainActivity.kt
override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    // onUserLeaveHint is ONLY called for Home/Recents, NOT for screen lock.
    // Screen lock fires onPause/onStop without onUserLeaveHint.
    PipBridge.onUserLeaveHint(this)
}
```

Actually, `onUserLeaveHint()` is **already correct** — Android only calls it for intentional user navigation away (Home, Recents), not for screen lock. The current code already handles this correctly via `setAutoEnterEnabled`. The issue is that the JS side conflates the PiP system callback with complex mode transitions. The fix is *removing JS-side complexity*, not changing native triggers.

For lock screen specifically: when the screen turns off, `AppState` goes to `'background'` without `onUserLeaveHint` firing. The current code treats this the same as Home. The fix: **don't enter PiP on `APP_BACKGROUND` from JS** — let `setAutoEnterEnabled` handle Home, and let lock screen just keep audio playing via the foreground service.

### 2. Source-of-Truth Variables

**Proposed — 5 variables replace ~15 refs:**

| Variable | Type | Owner | Purpose |
|----------|------|-------|---------|
| `playerMode` | `'hidden' \| 'fullscreen' \| 'mini'` | `playerStateMachine.ts` | In-app UI layout. PiP is NOT a player mode. |
| `currentVideo` | `VideoData \| null` | `VideoPlayerContext.tsx` | Session ownership. Non-null = session open, backend warm. |
| `isSystemPip` | `boolean` | `VideoPlayerContext.tsx` (from native event) | System PiP window is visible. UI overlay reads this to hide controls. |
| `isPlaying` | `boolean` | `VideoPlayerContext.tsx` | Transport state. Independent of mode. |
| `isBackgrounded` | `boolean` | `VideoPlayerContext.tsx` (from AppState) | App lifecycle. Used to gate PiP-exit seek nudge, not for mode decisions. |

**What this eliminates:**
- `pip_entering`, `pip_active`, `pip_exiting` state machine modes → replaced by `isSystemPip` boolean
- `wasPlayingWhenPipEntered`, `wasPlayingWhenBackgrounded` → no longer needed; playback continues uninterrupted through PiP/background
- `pipExitShouldResumeRef`, `pipExitExpectedPlayingRef`, `pipExitResumeUntilRef`, `pipExitReassertLoggedAtRef` → no longer needed; playback doesn't pause on PiP exit
- `pipTransitionInFlightRef`, `pipTransitionTimeoutRef` → no longer needed; no debounced PiP handler
- `maximizedForPipRef` → no longer needed; no mini→fullscreen pre-PiP coercion
- `modeBeforePip` in state machine → no longer needed; mode doesn't change for PiP

### 3. Code Ownership

#### `playerStateMachine.ts` — Pure UI mode transitions only

```typescript
// SIMPLIFIED: 3 modes, no PiP states
type PlayerMode = 'hidden' | 'fullscreen' | 'mini'

type PlayerEvent =
  | { type: 'LOAD_VIDEO'; video: VideoData; url: string }
  | { type: 'CLOSE_VIDEO' }
  | { type: 'MINIMIZE' }
  | { type: 'MAXIMIZE' }

// That's it. No APP_BACKGROUND, no PIP_ENTERED, no REMOTE_*.
// Those are side effects handled by VideoPlayerContext, not mode transitions.
```

The state machine becomes trivially simple:
- `hidden + LOAD_VIDEO → fullscreen`
- `fullscreen + MINIMIZE → mini`
- `mini + MAXIMIZE → fullscreen`
- `* + CLOSE_VIDEO → hidden`
- `mini + LOAD_VIDEO → fullscreen` (new video)

#### `VideoPlayerContext.tsx` — Session lifecycle + side effects

Owns:
- `currentVideo` (session open/close)
- `isPlaying` (transport state)
- `isSystemPip` (read from native PiP events)
- `isBackgrounded` (read from AppState)
- Calling `MediaSession.setActive(true/false)` on session open/close
- Calling `MediaSession.setAutoPictureInPicture(true/false)` based on `currentVideo !== null && isPlaying`
- Calling `MediaSession.setNowPlaying()` / `setPlaybackState()` on metadata/position changes
- Handling `onRemoteCommand` events (play/pause/stop/seek)
- Handling `onPictureInPictureChanged` events (set `isSystemPip`, detect PiP dismiss → `closeVideo()`)
- Deciding when to call `closeVideo()` (PiP dismiss, remote stop, user close)

Does NOT own:
- PiP entry/exit animations (system handles via `setAutoEnterEnabled`)
- Foreground service start/stop (MediaSessionModule handles on `setActive`)
- Audio focus (ExoPlayer/VLC handles directly)
- Layout/rendering decisions during PiP (VideoPlayerOverlayImpl reads `isSystemPip`)

#### `_layout.tsx` — App lifecycle only

Owns:
- Backend initialization / teardown
- Network suspend/resume based on `currentVideo` (via context)
- `onTaskRemoved` cleanup (if needed)

Does NOT own:
- Player mode transitions (that's VideoPlayerContext + state machine)
- PiP logic (that's VideoPlayerContext + native)

#### Native: `MediaSessionModule.kt` + `PipBridge` — Merged & simplified

**Merge `PipBridge` into `MediaSessionModule`**. `PipBridge` exists solely because `MainActivity` needs a static reference. This can be a companion object method on `MediaSessionModule` instead of a separate top-level object.

**Merge `PipServiceBridge` into `MediaSessionModule`**. Same rationale — it's a workaround for service→module communication that can be a direct reference.

Native side owns:
- `onUserLeaveHint()` → auto-PiP via `setAutoEnterEnabled` (already works, just remove manual `enterPictureInPictureMode` call)
- `onPictureInPictureModeChanged()` → emit JS event with `isInPictureInPicture` + dimensions
- PiP dismiss detection → emit `onRemoteCommand({ command: 'stop' })` (JS calls `closeVideo()`)
- MediaSession setup/teardown (on `setActive`)
- Foreground service lifecycle (on `setActive`)
- PiP action buttons (play/pause/rewind/forward)
- Lock screen media controls (via MediaSession transport controls)

#### Native: `MediaPlaybackService.kt` — Simplified

Remove PiP action routing from the service. PiP actions should route through `MediaSessionCompat.Callback` (which they already partially do), not through a parallel intent-action path. The service should only:
- Hold the foreground notification
- Hold WakeLock/WiFi lock when cast mode is active
- Display media controls via `MediaStyle` notification

### 4. Low-Risk Refactor Plan

#### Phase 1: Decouple PiP from player mode (JS only, no native changes)

**Risk: Low. Changes are additive, old paths still work.**

1. Add `isSystemPip: boolean` to `VideoPlayerContext` value, driven by `onPictureInPictureChanged` events
2. In `VideoPlayerOverlayImpl`, replace all `isInPipMode` / `isPipLayoutActiveShared` checks with reads from `isSystemPip`. The overlay hides controls and shows video-only when `isSystemPip` is true — this is a rendering concern, not a mode concern
3. Stop dispatching `PIP_ENTERED_ANDROID` / `PIP_EXITED_ANDROID` to the state machine reducer. Instead, set `isSystemPip` directly from the native event listener
4. Keep the old `pip_entering`/`pip_active`/`pip_exiting` modes in the type system but make them unreachable (they'll be dead code)

**Validation**: PiP enter/exit should work identically. The overlay hides controls in PiP. Player mode stays `fullscreen` throughout.

#### Phase 2: Remove mini→fullscreen PiP coercion (JS only)

**Risk: Low. Removes a workaround that was needed when PiP entry was JS-driven.**

1. Remove the `APP_BACKGROUND` handler that coerces `mini → fullscreen` for PiP handoff
2. Remove `maximizedForPipRef` and related logic
3. Let `setAutoEnterEnabled(true)` handle PiP entry from any mode — Android's auto-enter captures the current window regardless of internal layout state

**Validation**: Press Home from mini player. PiP should still enter (system handles it). Return from PiP should restore mini mode.

#### Phase 3: Simplify state machine (JS only)

**Risk: Low. Removing dead code paths.**

1. Remove `pip_entering`, `pip_active`, `pip_exiting` from `PlayerStateMode`
2. Remove `ModeBeforePip`, `wasPlayingWhenPipEntered`, `wasPlayingWhenBackgrounded` from state
3. Remove `APP_BACKGROUND`, `APP_FOREGROUND`, `REMOTE_*`, `PIP_*` event types from the reducer
4. The state machine becomes the 5-transition table described above
5. Move remote command handling to a simple `useEffect` in `VideoPlayerContext` that calls `play()`/`pause()`/`closeVideo()` directly

**Validation**: All player mode transitions (load, minimize, maximize, close) work. PiP works via `isSystemPip`. Remote commands work.

#### Phase 4: Implement PiP-close → session close

**Risk: Low. Adding a clear behavior.**

1. In the native `notifyPipModeChanged` → PiP dismiss detection (the `maybePauseAfterDismissal` logic), emit `onRemoteCommand({ command: 'stop' })` (already does this via `handlePipStop`)
2. In `VideoPlayerContext`, handle remote `stop` command by calling `closeVideo()`
3. `closeVideo()` calls `MediaSession.setActive(false)` → stops foreground service → backend can idle-suspend

**Validation**: Dismiss PiP window. Video session should fully close. Lock screen controls should disappear.

#### Phase 5: Lock screen background audio (native change)

**Risk: Medium. Requires testing across Android versions.**

1. Ensure `MediaPlaybackService` starts with `FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK` whenever `setActive(true)` is called (already does this)
2. Verify that when the screen locks while playing, audio continues (the foreground service + WakeLock should handle this)
3. Verify lock screen shows media controls (MediaSession metadata + transport controls should handle this)
4. The key behavior: screen lock does NOT trigger PiP. `onUserLeaveHint` is not called on screen lock, so `setAutoEnterEnabled` won't fire. Audio just keeps playing.

**Validation**: Play video → lock screen. Audio continues. Lock screen shows Now Playing with controls. Unlock → app shows video in previous mode.

#### Phase 6: Native cleanup (merge PipBridge)

**Risk: Medium. Structural refactor of native code.**

1. Move `PipBridge` logic into `MediaSessionModule.Companion`
2. Remove `PipServiceBridge` — route PiP actions through `MediaSessionCompat.Callback`
3. Remove `applySurfaceViewTransforms` (already documented as legacy/no-op for NitroVLC)
4. Remove `findSurfaceViews` (only used by `applySurfaceViewTransforms`)
5. Simplify `notifyPipModeChanged` — remove the `maybePauseAfterDismissal` polling loop, replace with a single check after PiP exit

### 5. Architecture Diagram (After)

```
┌─────────────────────────────────────────────────────┐
│ VideoPlayerContext.tsx                                │
│                                                       │
│  currentVideo ──── session open? ──── backend warm   │
│  isPlaying ─────── transport state                    │
│  isSystemPip ───── read from native event             │
│  isBackgrounded ── read from AppState                 │
│                                                       │
│  closeVideo() ──→ dispatch(CLOSE_VIDEO)               │
│              ──→ MediaSession.setActive(false)        │
│              ──→ MediaSession.setAutoPiP(false)       │
│                                                       │
│  onRemoteCommand ──→ play/pause/closeVideo            │
│  onPipChanged ────→ set isSystemPip                   │
│                   → if dismissed: closeVideo()        │
└───────────────┬───────────────────────────────────────┘
                │
    ┌───────────▼───────────┐
    │ playerStateMachine.ts │
    │                       │
    │ hidden ↔ fullscreen   │
    │          ↕             │
    │         mini           │
    │                       │
    │ No PiP states.        │
    │ No lifecycle events.  │
    └───────────────────────┘

┌─────────────────────────────────────────────────────┐
│ MediaSessionModule.kt (native)                       │
│                                                       │
│  setActive(true)  → start foreground service          │
│                   → create MediaSession               │
│                   → register noisy receiver           │
│                                                       │
│  setActive(false) → stop foreground service           │
│                   → release MediaSession              │
│                                                       │
│  setAutoEnterEnabled(true/false)                      │
│    → system handles PiP on Home press                 │
│                                                       │
│  onPipModeChanged → emit JS event                     │
│  onPipDismissed   → emit stop command                 │
│                                                       │
│  MediaSession.Callback                                │
│    → play/pause/stop/seek → emit JS events            │
│    → PiP action buttons route here too                │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ MediaPlaybackService.kt (native)                     │
│                                                       │
│  Foreground notification with MediaStyle              │
│  WakeLock + WiFi lock (cast mode only)                │
│  No PiP action routing (removed)                      │
└─────────────────────────────────────────────────────┘
```

### 6. What This Doesn't Address (Out of Scope)

- **TextureView PiP rendering issues** (zoom/crop, frozen dimensions). These are rendering-layer problems orthogonal to the state management cleanup. Phase 1-4 should work with the current PiP rendering approach.
- **iOS PiP**. iOS uses native AVPictureInPictureController which is a separate code path.
- **Chromecast foreground service**. Already works independently via `startCastForegroundService`.
- **Backend idle timeout**. The spec says "suspend after idle timeout" but doesn't define the timeout duration or mechanism. This can be a follow-up.
