# Task: Align PearTube Android PiP setup with mediastorm's simpler/native-first model

## Goal
Refactor PearTube's Android PiP entry/exit setup to follow the architectural lessons from mediastorm v1.4 frontend:
- native-first PiP flow
- immediate ref updates for PiP transition state
- AppState as secondary/fallback, not source of truth
- fewer overlapping React effects for PiP enable/re-arm
- one clear owner for PiP state transitions

## Mediastorm findings to emulate
1. Single main player/controller, PiP treated as mode of same session
2. Native-first callback ordering: request PiP first, set refs immediately, reconcile later
3. Ref-based race handling instead of multiple React state/effect loops
4. AppState should not be deciding PiP truth

## PearTube current pain
PiP logic is split across:
- `packages/app/components/VideoPlayerOverlayImpl.tsx`
- `packages/app/lib/VideoPlayerContext.tsx`
- `packages/app/lib/playerStateMachine.ts`
- `packages/app/modules/expo-media-session/android/.../MediaSessionModule.kt`

Symptoms we've seen:
- PiP entry breaks after certain in-app transitions (mini/fullscreen)
- repeated re-arm logic and duplicated PiP exit handling
- max update depth loops / hot phone during PiP cycles
- fragile dependence on AppState / effects firing in the right order

## Relevant PearTube snippets
### VideoPlayerOverlayImpl.tsx
- auto-PiP effect around line ~2150
- PiP status callback `handlePipStatusChanged`
- `isInPipMode` effect near top that also reacts to exit

### VideoPlayerContext.tsx
- AppState listener dispatching APP_BACKGROUND / APP_FOREGROUND
- Android PiP listener
- remote command listener stop/pause handling
- setIsInPipMode callback / modeBeforePip refs

### MediaSessionModule.kt
- `PipBridge.setPipEnabled(enabled)`
- `PipBridge.onUserLeaveHint(activity)`
- direct `enterPictureInPictureMode(...)`

## Desired outcome
A simpler flow where:
- PiP enablement is refreshed from ONE primary place
- PiP exit re-arm is not duplicated across multiple effects
- native callbacks / refs own transition truth
- AppState/background listeners stop fighting PiP

## Deliverable for this round
- propose concrete refactor plan
- then implement the minimal core changes to align with mediastorm's model without rewriting the entire player

## Discussion

## Codex Proposal

### Recommendation
Adopt a native-first Android PiP flow where Kotlin owns actual PiP truth, `VideoPlayerContext` is the only JS coordinator, and `VideoPlayerOverlayImpl` becomes render-only for Android PiP. The smallest high-impact refactor is not a player rewrite; it is a control-plane cleanup that removes the extra places currently inferring, re-arming, and clearing PiP.

### Ownership of PiP state
- `MediaSessionModule.kt` / `PipBridge` should own OS-facing PiP eligibility and emit the single canonical Android PiP enter/exit event.
- `VideoPlayerContext.tsx` should be the only JS owner of Android PiP session state. It already has the right immediate refs for race handling: `isInPipModeRef`, `pipTransitionInFlightRef`, `modeBeforePipRef`, `pipExitExpectedPlayingRef`, and `pipWindowSizeRef`.
- `VideoPlayerOverlayImpl.tsx` should only consume derived PiP state for layout and controls. It should not enable PiP, clear PiP, or synthesize Android PiP transitions.
- `playerStateMachine.ts` should remain a reducer for UI/session mode, not the source of truth for whether Android is in PiP. The reducer should only react to native PiP events dispatched by `VideoPlayerContext`.

### Duplicate effects / paths to remove
- Remove the Android auto-PiP effect from `VideoPlayerOverlayImpl.tsx`. PearTube already computes `shouldEnablePip` in `VideoPlayerContext.tsx`; that should drive one context-owned effect that calls `MediaSession.setAutoPictureInPicture(...)`.
- Remove Android mutation from `handlePipStatusChanged` in `VideoPlayerOverlayImpl.tsx`. On Android, `MediaSession.addPictureInPictureListener(...)` in `VideoPlayerContext.tsx` already updates `pipWindowSize`, PiP refs, and reducer state.
- Make `setIsInPipMode` effectively iOS-only. Right now Android has a native listener plus a React callback-shaped API that can express the same transition from a second place. That dual path is exactly what mediastorm avoids.
- Stop clearing Android PiP state from the AppState foreground effect in `VideoPlayerContext.tsx`. The foreground listener should not set `isInPipModeRef.current = false`, null out `pipWindowSize`, or otherwise decide that PiP exited; only the native PiP callback should do that.
- Delete dead overlay re-arm plumbing that exists only because PiP ownership is split: `pipExitNeedsRearmRef`, `autoPipEnabledRef`, and `isAutoPipEnabledShared` if it stays unused after the ownership move.

### Smallest high-impact refactor
1. Keep the current player and reducer, but introduce one Android PiP arming boolean in `VideoPlayerContext` as the single source of truth for native enablement.
2. That boolean should represent "keep native PiP armed for this session" and should be based on: active video, fullscreen, not casting. It should not flip false just because the app is currently in PiP; PiP state and PiP eligibility are separate concerns.
3. Add one context-owned effect that diffs the last armed value and calls `MediaSession.setAutoPictureInPicture(armed)` only when the value actually changes.
4. In `MediaSessionModule.kt`, make `setAutoPiP` / `PipBridge.setPipEnabled` idempotent so React re-renders do not keep rewriting PiP params when nothing changed.
5. Keep `MediaSession.addPictureInPictureListener(...)` as the only Android enter/exit input. That listener should update refs immediately, dispatch `PIP_ENTERED_ANDROID` / `PIP_EXITED_ANDROID`, and preserve the existing resume-on-exit logic.
6. Strip Android PiP control work out of `VideoPlayerOverlayImpl.tsx`; it should only react visually to `isInPipMode` and `pipWindowSize`.
7. Trim the Android AppState listener down to background bookkeeping and non-PiP fallback restore. AppState can still say "the app backgrounded", but it should not say "Android is now in PiP" or "PiP just ended".

### Why this is the right first cut
- It aligns PearTube with mediastorm's simpler model: native event first, refs updated immediately, React state reconciled afterward.
- It removes the three-way race between native PiP callbacks, overlay effects, and AppState.
- It preserves the current player surface and most of the reducer, which keeps the refactor small.
- It should eliminate the current re-arm/exit duplication without needing a full player-state-machine rewrite.

### Follow-up I would explicitly defer
- Do not rewrite the full player state machine in this pass.
- Do not collapse all PiP reducer modes yet, although `pip_exiting` now looks like cleanup debt rather than an active architectural need.
- Do not change the Android layout heuristics in `VideoPlayerOverlayImpl.tsx` yet; those are display concerns and can stay once ownership is centralized.

## Hermes Review

### Smallest high-impact refactor
Make `VideoPlayerContext.tsx` the only JS PiP controller on Android, and narrow its job to two things only:
1. keep one native PiP arm/disarm flag in sync with playback eligibility
2. react to one native PiP entered/exited event stream

That is the closest PearTube can get to mediastorm's native-first model without rewriting the player. The current bugs are not mainly about missing logic; they come from the same transition being handled in three places: overlay, context/AppState, and native.

### Why this is the best minimal cut
- `VideoPlayerOverlayImpl.tsx` still owns Android auto-PiP arming via its effect at `2165-2185`, even though `VideoPlayerContext.tsx` already computes `shouldEnablePip`.
- Android PiP enter/exit is already emitted natively through `MediaSession.addPictureInPictureListener(...)` in `VideoPlayerContext.tsx:971-1086`, but `setIsInPipMode` in `VideoPlayerContext.tsx:1334-1363` provides a second Android transition path and `handlePipStatusChanged` in the overlay still writes PiP-related state.
- App foreground handling in `VideoPlayerContext.tsx:707-726` still conditionally clears PiP refs/window size, which means AppState is still participating in PiP truth instead of just being background bookkeeping.
- Native already has delayed exit confirmation and canonical event emission in `MediaSessionModule.kt` via `notifyPipModeChanged(...)` and `sendPipEvent(...)`, so the cleanest win is to trust that path fully instead of layering JS re-arm/exit interpretation on top.

### Proposed ownership model
- Native/Kotlin owns real PiP truth and emits only the canonical event stream.
- `VideoPlayerContext.tsx` owns the JS-side refs for race handling (`isInPipModeRef`, `pipTransitionInFlightRef`, `pipExitExpectedPlayingRef`, `modeBeforePipRef`) and is the only place allowed to dispatch `PIP_ENTERED_ANDROID` / `PIP_EXITED_ANDROID`.
- `VideoPlayerOverlayImpl.tsx` becomes Android PiP render-only: layout, controls visibility, and aspect-ratio updates are fine; PiP state transitions and native arming are not.
- `playerStateMachine.ts` stays as a reducer that consumes canonical PiP events, not as a second PiP inference layer.

### Concrete proposal
1. Move Android `MediaSession.setAutoPictureInPicture(...)` ownership out of `VideoPlayerOverlayImpl.tsx` and into a single effect in `VideoPlayerContext.tsx` driven by `shouldEnablePip`.
2. Redefine `shouldEnablePip` as eligibility, not current mode. It should answer "should native stay armed for this active session?" and should not flip false merely because the app is currently in PiP.
3. Make Android `setIsInPipMode` a no-op or iOS-only compatibility shim. The Android listener at `971-1086` is already the canonical transition source; keeping both guarantees duplicate enter/exit dispatch risk.
4. Stop clearing Android PiP refs from AppState foreground handling. AppState should never set `isInPipModeRef.current = false` or null out PiP window state based on foreground timing; only the native PiP callback should do that.
5. Delete overlay-side Android re-arm bookkeeping once arming moves to context: `pipExitNeedsRearmRef`, `autoPipEnabledRef`, and `isAutoPipEnabledShared` should disappear if they are no longer used for iOS.
6. In `MediaSessionModule.kt`, make `PipBridge.setPipEnabled(enabled)` and `updateActivityPipParams(enabled)` explicitly idempotent so JS can safely keep the arm flag asserted without repeated param churn.

### Expected impact
This is small but high leverage because it removes duplicate PiP ownership without changing the visible player architecture:
- one place arms native PiP
- one place consumes native PiP callbacks
- AppState no longer races PiP exit
- overlay stops trying to coordinate Android PiP session state

That matches mediastorm's native-first/ref-driven pattern: arm native once for the session, update refs immediately on native callback, and let reducer/UI reconcile afterward.

### Explicitly defer
- Do not redesign the reducer yet.
- Do not remove `pip_entering` in this pass unless it becomes obviously unused after de-duplication.
- Do not touch Android PiP layout math beyond what is necessary to remove ownership overlap.
