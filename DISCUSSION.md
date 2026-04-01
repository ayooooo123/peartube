# Task: Deeper Grayjay vs PearTube Android PiP lifecycle diff

## Goal
We have exhausted the shallow PiP action-list theories. PearTube now supplies the same basic 2-action PiP setup as Grayjay, but Android still only shows the single pause button while playing.

We need to compare the deeper PiP lifecycle and playback/session integration between Grayjay and PearTube.

## Already proven
### PearTube
- builds 2 PiP actions on entry: Background + Pause
- uses BroadcastReceiver dispatch
- uses custom app-specific icons
- action list is applied before PiP entry
- even suppressing MediaSession transport actions and advertising STATE_NONE during PiP does NOT make the extra button appear while playing
- when paused, custom actions surface; when resumed, Android collapses back to a single pause button

### Grayjay
- uses standard Android PiP RemoteActions
- order: Background first, Play/Pause second
- uses BroadcastReceiver with extra payloads
- has an active media session too
- on this exact same device, user visually confirms Grayjay shows two adjacent buttons in PiP while playing:
  - pause
  - send to background

## Need to inspect now
1. Grayjay PiP entry lifecycle and timing
   - when `setPictureInPictureParams()` is called
   - whether it updates params continuously before/after entry
   - whether it changes media-session/playback mode during PiP entry
   - whether it switches to an audio/background mode flag that changes shell behavior

2. PearTube PiP lifecycle
   - `MainActivity.onUserLeaveHint`
   - `PipBridge.onUserLeaveHint`
   - `notifyPipModeChanged`
   - `updateActivityPipParams`
   - `refreshPipParams`
   - `VideoPlayerContext` PiP listeners

3. Activity/host differences
   - manifest flags
   - launchMode / task retention / config changes
   - whether Grayjay uses a simpler single PiP host with fewer dynamic param refreshes

## Output wanted
- exact verified lifecycle differences
- most likely root cause for why Grayjay gets 2 visible buttons while PearTube does not
- one targeted next patch, not a list of guesses

## Discussion

## Hermes Lifecycle Diff

Verified deeper differences between Grayjay and PearTube:

1. Grayjay really does use 2 standard PiP RemoteActions while playing on this same device.
2. PearTube now also supplies 2 custom PiP actions before entry, verified in logs.
3. PearTube logs proved Android still collapses to a single pause button while playing, but shows both custom actions once paused.
4. Grayjay MainActivity differs (`singleInstance`, `resizeableActivity=true`), but matching that in PearTube did not change the visible PiP controls.
5. Grayjay's Android 12+ PiP entry relies on armed params / auto-enter semantics more than PearTube's original force-enter path, but matching that also did not change the visible controls.
6. Suppressing MediaSession transport actions, advertising STATE_NONE, and even temporarily deactivating MediaSession during active PiP did not change Android's single-button playing-state behavior in PearTube.
7. Therefore, the useful remaining proven changes are only the clean Grayjay-aligned action-layer ones:
   - BroadcastReceiver dispatch
   - Grayjay-style receiver payload extras
   - 2 PiP actions (Background + Play/Pause)
   - custom app-specific icons

Conclusion:
- Keep the clean action-layer alignment changes.
- Revert the failed lifecycle/session experiments.
- Remaining root cause is still deeper than action/session plumbing and likely tied to a subtler host/player/runtime difference that has not yet been isolated.
