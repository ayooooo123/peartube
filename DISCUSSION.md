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
