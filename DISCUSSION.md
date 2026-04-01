# Task: Deeper Grayjay vs PearTube Android PiP lifecycle diff

## Goal
We have exhausted the shallow PiP action-list theories. PearTube now supplies the same basic 2-action PiP setup as Grayjay, but Android still swaps back to the single default transport control after certain shell interactions (especially drag/reposition).

We need to compare the deeper PiP lifecycle and playback/session integration between Grayjay and PearTube.

## Already proven
### PearTube
- builds 2 PiP actions on entry: Background + Pause
- uses BroadcastReceiver dispatch
- uses custom app-specific icons
- action list is applied before PiP entry
- after removing APP_MUSIC / MUSIC_PLAYER activity classification from the installed package, the initial PiP entry behavior improved
- while paused, custom actions can surface; drag/reposition still causes Android to visually collapse back to a single default control
- multiple attempted hooks/callbacks did not explain or stop the drag regression:
  - `onConfigurationChanged`
  - `notifyPipBoundsChanged`
  - `onPictureInPictureUiStateChanged`
  - delayed/ignored transient `isInPip=false` handling
  - post-entry param refresh
  - direct native custom-play/pause PiP refresh
  - Grayjay-style MediaSession action-mask alignment

### Grayjay
- uses standard Android PiP RemoteActions
- order: Background first, Play/Pause second
- uses BroadcastReceiver with extra payloads
- has an active media session too
- on this exact same device, user visually confirms Grayjay shows two adjacent buttons in PiP while playing
- on this exact same device, user visually confirms Grayjay still shows both buttons after dragging/repositioning the PiP window

## Key verified runtime findings
### PearTube app logs
- On PiP entry, PearTube logs correct custom actions:
  - `buildPipActions: count=2 labels=[Background, Pause] currentIsPlaying=true`
- In some runs, drag/shell interactions emitted transient `notifyPipModeChanged(false)` while the window was still PiP-sized.
- After filtering that path, the visible regression still happens even when no useful app callback is emitted.
- In the latest captures, drag/reposition can still regress the visible controls without any of these firing:
  - `onConfigurationChanged`
  - `notifyPipBoundsChanged`
  - `onPictureInPictureUiStateChanged`
- So the app state/action list can remain correct while the shell changes the visible PiP strip anyway.

### Android system logs
- PearTube playing MediaSession action mask originally differed from Grayjay:
  - PearTube: `actions=847`
  - Grayjay: `actions=822`
- Aligning PearTube's MediaSession action mask with Grayjay more closely did NOT fix the drag regression.
- Grayjay system logs during drag show a shell-level path we have not matched from app callbacks:
  - `WindowManagerShell: onTaskInfoChanged ... state=scheduled_bounds_change`
  - `PipTransitionState ... scheduled_bounds_change -> changing-bounds -> changed-bounds`
  - `PictureInPictureParams(... hasSetActions=true ... isAutoPipEnabled=true ...)`
- Grayjay keeps both buttons visible after this shell-driven bounds-change sequence.

## Strongest current hypothesis
The missing signal is probably not an Activity callback at all.

On this device, drag/reposition appears to be handled at the WindowManagerShell / task-info level:
- scheduled_bounds_change
- changing-bounds
- changed-bounds
- show/hide PiP menu UI events

Grayjay stays stable through that shell-level bounds-change sequence.
PearTube does not.

So the remaining gap is likely one of:
1. PearTube is not updating the same PiP params fields that Grayjay has in place during shell bounds changes.
2. PearTube's host/task/window configuration differs in some subtle but important way at the shell/task level.
3. Android is re-evaluating visible controls from task/PiP params during bounds changes, and PearTube's params/runtime state fail that re-evaluation while Grayjay's do not.

## Need to inspect now
1. Grayjay PiP entry + drag lifecycle at the shell/task level
   - exact task/window mode changes around drag
   - exact PiP params state visible to shell during scheduled_bounds_change / changed-bounds
   - any task-organizer / shell-visible differences implied by manifest or window config

2. PearTube PiP drag lifecycle at the shell/task level
   - whether similar `WindowManagerShell` / `onTaskInfoChanged` / `PipTransitionState` lines appear
   - if they do, whether PiP params differ at those moments
   - if they don't, why PearTube is on a different shell path

3. Host/task differences
   - manifest flags actually installed on-device
   - task/window mode behavior
   - whether Grayjay's activity/task arrangement is materially different during PiP drag

## Output wanted
- exact verified lifecycle differences
- most likely root cause for why Grayjay keeps 2 visible buttons after drag while PearTube does not
- one targeted next patch, not a list of guesses

## Discussion

## Hermes Lifecycle Diff

Verified deeper differences between Grayjay and PearTube:

1. Grayjay really does use 2 standard PiP RemoteActions while playing on this same device.
2. PearTube now also supplies 2 custom PiP actions before entry, verified in logs.
3. PearTube can show the correct 2-action PiP strip on entry after removing the APP_MUSIC / MUSIC_PLAYER activity classification.
4. The remaining breakage is now most reproducible after drag/reposition: Android visually collapses PearTube back to the default single control even though PearTube is still building the correct custom action list.
5. Grayjay does not regress after drag on this same device.
6. The usual app-level callbacks have NOT been sufficient to explain the drag regression in PearTube:
   - config changes did not fire reliably
   - PiP UI state callback did not provide a usable signal
   - transient false/true PiP mode flap handling was not the root fix
7. System logs suggest Grayjay's stable drag behavior passes through shell/task-level PiP bounds-change transitions (`onTaskInfoChanged`, `scheduled_bounds_change`, `changing-bounds`, `changed-bounds`) while retaining valid PiP params with actions set.
8. A more Grayjay-like MediaSession action mask did not solve the issue.

Conclusion:
- Keep the clean action-layer alignment changes.
- Keep the removal of APP_MUSIC / MUSIC_PLAYER classification.
- Keep the fresh-param PiP entry reliability fix on Android 12+.
- Remaining root cause appears to be shell/task-level PiP behavior during drag/reposition, not ordinary app callback wiring.
- Next step should focus on shell/task/runtime differences between PearTube and Grayjay during bounds-change transitions, not more blind activity callback guessing.

## Codex Review

1. Strongest missed difference

The strongest missed difference is not "which callbacks fire"; it is that Android shell is probably rebuilding the visible PiP action strip from the pinned task's latest `TaskInfo.pictureInPictureParams` snapshot during `scheduled_bounds_change -> changed-bounds`, not from whatever PearTube had at initial entry.

PearTube currently has multiple native PiP-param writers that replace the whole params object with different field sets:
- `PipBridge.onUserLeaveHint()` sets actions plus `autoEnterEnabled=true` before entry (`packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt:193-214`).
- `updateActivityPipParams()` sets actions plus `autoEnterEnabled`, but not `seamlessResizeEnabled` (`packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt:1242-1279`).
- `enterPiP()` sets actions plus `seamlessResizeEnabled`, but not `autoEnterEnabled` (`packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt:1208-1224`).
- `refreshPipParams()` sets actions plus `seamlessResizeEnabled`, but not `autoEnterEnabled` (`packages/app/modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt:1362-1381`).

That matters because `setPictureInPictureParams()` is not patching one field; it replaces the activity/task-visible params blob. Grayjay's drag logs explicitly showed shell still seeing `PictureInPictureParams(... hasSetActions=true ... isAutoPipEnabled=true ...)` during bounds change. PearTube's common post-entry refresh path does not preserve that same shell-visible state. So the most likely shell-side recomputation is: on bounds change, Android re-evaluates the action strip from the current task params plus media-session state; Grayjay still has a canonical params snapshot with app actions intact, while PearTube may have already overwritten its task snapshot with a partial params object and the shell falls back to the single default media control.

2. Prior theory to discard

I would discard the theory that one more app-level callback hook is the missing fix. The regression already survives without useful signals from `onConfigurationChanged`, `notifyPipBoundsChanged`, or `onPictureInPictureUiStateChanged`, and the Grayjay-style MediaSession action-mask alignment also did not move the result. The remaining problem is more likely "what the shell sees on the task record at bounds-change time" than "what callback PearTube can catch in the activity."

3. One specific next diagnostic I would try

I would add one diagnostic before any more fixes: log a canonical PiP-param signature at every native write site and compare it against shell task-info during drag. Concretely, every `setPictureInPictureParams()` / `enterPictureInPictureMode()` call should log:
- reason
- action count and labels
- whether `autoEnterEnabled` was set
- whether `seamlessResizeEnabled` was set
- aspect ratio
- source rect hint

Then capture PearTube's `WindowManagerShell` / `ActivityTaskManager` lines during a drag and check one narrow question: when PearTube hits `scheduled_bounds_change -> changed-bounds`, does the shell still report `hasSetActions=true` and `isAutoPipEnabled=true`, or has a post-entry write already replaced the task snapshot with a params object that dropped one of those fields? If those shell-visible fields diverge from Grayjay at bounds-change time, that is the root cause worth fixing next.
