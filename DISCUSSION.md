# Task: Diagnose Maximum update depth exceeded during video playback / PiP flow

## Symptom
User reports phone getting hot while playing a video. Logs show repeated foreground/background handling and then React error:

```
LOG  [VideoPlayerOverlay] Auto-PiP set: true
LOG  [VideoPlayerOverlay] PiP layout: { ... playerMode: "fullscreen", windowHeight: 108, windowWidth: 254 ... }
LOG  [App] Resuming network from foreground
LOG  [VideoPlayerContext] Coming to foreground, wasPlaying: true wasInPiP: true pipInFlight: false
LOG  [App] Skipping network suspend - local playback is active (state: background)
LOG  [VideoPlayerContext] Going to background, wasPlaying: true playerMode: fullscreen
... repeats ...
LOG  [VideoPlayerOverlay] PiP status changed: false 0 0
LOG  [VideoPlayerContext] PiP exit resume confirmed via progress
LOG  [VideoPlayerOverlay] Re-armed Auto-PiP after PiP exit (state-driven)
ERROR  Maximum update depth exceeded. This can happen when a component calls setState inside useEffect, but useEffect either doesn't have a dependency array, or one of the dependencies changes on every render.
```

## Key suspects
1. `packages/app/components/VideoPlayerOverlayImpl.tsx`
   - PiP effects around `isInPipMode`, `pipExitRearmNonce`, `showControlsTemporarily`, `handlePipStatusChanged`
   - mini-player size effect / other setState-in-useEffect loops
2. `packages/app/lib/VideoPlayerContext.tsx`
   - AppState listener causing background/foreground loops
   - PiP listener / foreground restore / seek nudge
3. `packages/app/app/_layout.tsx`
   - app state / suspend/resume network loop

## Goal
Find the actual source of the React 'Maximum update depth exceeded' loop. Not just a guess — trace which useEffect/setState cycle could cause repeated rerenders.

## Discussion

## Claude Proposal
The most likely React-side loop is not `_layout.tsx`'s network suspend/resume logic itself, but the Android PiP exit path in `packages/app/components/VideoPlayerOverlayImpl.tsx`, where PiP-exit callbacks feed state that immediately re-triggers PiP re-arm effects.

Most suspicious cycle:

1. `handlePipStatusChanged` in `VideoPlayerOverlayImpl.tsx` (`~810-829`) runs on every native `onPictureInPictureChanged` event from `PearInlineVideoView`.
   - On PiP exit (`event.isInPictureInPicture === false`) it does three things that matter:
     - `setPipWindowSize(null)`
     - `maximizePlayer()`
     - `setPipExitRearmNonce((n) => n + 1)` on Android
   - `setPipExitRearmNonce` is the dangerous one because it always produces a new state value, so repeated false-exit callbacks can force unbounded rerenders.

2. That nonce drives the dedicated PiP re-arm effect in `VideoPlayerOverlayImpl.tsx` (`~2176-2192`):
   - Dependencies: `[pipExitRearmNonce, isInPipMode, pipSupported, currentVideo, isCasting, playerMode]`
   - Once the player is back in fullscreen, the effect calls `MediaSession.setAutoPictureInPicture(true)` and logs `Re-armed Auto-PiP after PiP exit (state-driven)`.
   - This matches the last log line immediately before the React maximum-depth error.

3. There is a second overlapping PiP-exit effect earlier in the same file (`~379-414`):
   - Dependencies: `[isInPipMode, currentVideo, isCasting, playerMode, pipSupported, showControlsTemporarily]`
   - When `isInPipMode` flips false after previously being true, it calls `showControlsTemporarily()` (which does `setShowControls(true)` and later `setShowControls(false)`) and also calls `MediaSession.setAutoPictureInPicture(true)` again on Android.
   - So the same PiP exit is being handled twice by effects that both perform state/native side effects.

Why this is the most likely root cause:
- The repeated foreground/background logs from `VideoPlayerContext.tsx` (`APP_BACKGROUND` / `APP_FOREGROUND` handler around `~452-551`) and `_layout.tsx` (`handleAppStateChange` around `~667-774`) explain the noisy lifecycle churn during PiP transitions, but those handlers are event-driven and mostly write refs or one-off state. They do not contain an obvious self-sustaining React dependency loop.
- By contrast, the overlay PiP exit path has an actual feedback mechanism:
  - native PiP exit callback -> `setPipExitRearmNonce` / `maximizePlayer`
  - rerender -> PiP re-arm effect(s) run -> native `setAutoPictureInPicture(true)`
  - player/view lifecycle shifts again during exit/foreground restore -> another PiP status callback can arrive
  - callback increments nonce again, repeating the cycle
- Because the nonce increments monotonically, React cannot bail out on same-value state; every repeated exit callback guarantees another render.

Supporting context from `VideoPlayerContext.tsx`:
- The Android PiP listener (`~742-867`) also updates PiP-related state on exit: `setPipWindowSize(null)`, `dispatch({ type: 'PIP_EXITED_ANDROID', ... })`, and `setIsPlaying(shouldResume)`.
- The AppState foreground handler (`~485-545`) may run in the same exit window and can also call `setPipWindowSize(null)` plus foreground restore logic.
- This means PiP exit is currently handled in multiple places at once, but the only inspected code path that can force an always-new React state update on every repeated exit signal is `setPipExitRearmNonce((n) => n + 1)` in the overlay callback.

Conclusion: the maximum update depth error is most likely rooted in duplicate Android PiP-exit handling inside `VideoPlayerOverlayImpl.tsx`, especially the `handlePipStatusChanged` -> `pipExitRearmNonce` -> re-arm `useEffect` chain, with the earlier PiP-exit effect (`isInPipMode` dependency) adding a second overlapping re-arm path.

## Codex Review

I inspected the three suspect files with a narrow focus on two failure modes: a useEffect that sets state which then retriggers the same effect through its dependency list, and listener/effect churn that repeatedly re-subscribes native events.

Bottom line: I do not see a strong "classic" self-sustaining useEffect loop in these files where an effect writes the exact dependency that causes itself to run again forever. Most setState calls inside effects are convergent:

- VideoPlayerOverlayImpl.tsx:602 updates local seekPosition from effectiveCurrentTime, but the effect depends on effectiveCurrentTime/isSeeking, not on seekPosition.
- VideoPlayerOverlayImpl.tsx:610 clears scrubPendingTime, but once it sets null the effect exits on the next render.
- VideoPlayerOverlayImpl.tsx:1079 clears pendingLandscapeExit/isLandscapeFullscreen after the layout stabilizes; that also converges.
- VideoPlayerOverlayImpl.tsx:2130 sets iosPipEnabled, but iosPipEnabled is not in that dependency list.
- VideoPlayerContext.tsx:384 reacts to state.mode / wasPlayingWhenPipEntered and writes unrelated local state such as isPlaying, pipWindowSize, etc.; those setters do not feed back into that effect's dependencies.

I also do not see obvious event-listener registration churn in the inspected files:

- VideoPlayerContext AppState listener at 452 is mounted from an effect whose deps are stable (dispatch, forceReloadPlayback, isPrimaryController, restoreLastClosedVideo). It should only re-register when primary-controller status changes, not on every render.
- VideoPlayerContext PiP listener at 742 is likewise gated by isPrimaryController and otherwise stable.
- Root _layout AppState listener at 776 is tied to a memoized handleAppStateChange callback, so it is not obviously churning every render either.
- VideoPlayerOverlayImpl itself does not register the PiP/AppState listeners; it mainly reacts to callback props and context state.

What does stand out instead is duplicated PiP-exit handling across layers, combined with foreground/background oscillation:

1. RootLayout resumes network on every AppState active transition (_layout.tsx:740-766).
2. VideoPlayerContext separately handles the same AppState transition and may dispatch APP_FOREGROUND, clear PiP window state, issue a seek nudge, and restore playback (VideoPlayerContext.tsx:485-545).
3. VideoPlayerContext also handles native PiP events and on PiP exit dispatches PIP_EXITED_ANDROID, sets isPlaying, clears pipWindowSize, and reasserts play several times (VideoPlayerContext.tsx:742-867).
4. VideoPlayerOverlay handles PiP exit too: handlePipStatusChanged clears pipWindowSize, may call maximizePlayer(), and bumps pipExitRearmNonce (VideoPlayerOverlayImpl.tsx:810-829). Then two separate re-arm paths call MediaSession.setAutoPictureInPicture(true):
   - immediate re-arm in the isInPipMode effect (379-414)
   - state-driven re-arm in the pipExitRearmNonce effect (2176-2192)

That means a single PiP exit can fan out into several state transitions in quick succession:
- AppState active
- PiP listener exit handling in context
- overlay PiP callback exit handling
- maximizePlayer -> playerMode change
- auto-PiP re-arm effect(s)
- foreground seek nudge / isPlaying restoration

This looks much more like a native-event feedback storm than a pure React dependency-cycle bug. The repeated logs in the symptom match that pattern: foreground/background keeps bouncing, and each bounce triggers more PiP/player-mode state work.

My current diagnosis is:

- Primary issue: overlapping PiP/AppState exit handlers are probably causing repeated mode/state transitions during the PiP exit tail.
- Not the primary issue: a direct useEffect self-loop from "set state -> dependency changes -> same effect reruns forever" does not appear to be present in these three files.
- Not clearly the primary issue: listener registration churn is not obvious in these three files.
- Secondary suspicion worth keeping in mind: handlePipStatusChanged is recreated with unnecessary dependencies (pipSupported/currentVideo/isCasting even though unused in the callback body). If PearInlineVideoView internally subscribes native PiP listeners in an effect keyed on that callback prop, callback identity churn could amplify native event churn. That is not proven from these files alone, but it is the only credible listener-churn angle I found.

If I had to name the most suspicious concrete site in the inspected code, it is the duplicated Android PiP exit work split between VideoPlayerContext.tsx:742-867 and VideoPlayerOverlayImpl.tsx:379-414 plus 810-829 plus 2176-2192, not a single runaway useEffect.
