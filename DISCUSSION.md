# Task: Fix PiP getting disabled before onUserLeaveHint

## Evidence
Earlier device logs showed:
- Auto-PiP enabled successfully (`setAutoPiP: enabled=true`)
- Then BEFORE `onUserLeaveHint`, app logged `playerMode: 'hidden', hasVideo: false, enabling: false`
- Then `PipBridge.onUserLeaveHint` ran with `pipEnabled=false`

So PiP is not failing to enter — it is being disabled prematurely before leave hint.

## Likely root cause
In VideoPlayerContext remote command listener, Android backgrounding may trigger a remote `stop` command via MediaSession / browser service / notification service.
The current `stop` handler always does a full close:
- stop/pause player
- currentVideoRef.current = null
- dispatch(CLOSE_VIDEO)
- clear media session

If this happens during the background -> PiP handoff window, it tears down playback before MainActivity.onUserLeaveHint can enter PiP.

## Minimal fix
Ignore remote `stop` commands on Android while backgrounding / PiP handoff is in progress:
- Platform.OS === 'android'
- currentVideoRef.current exists
- and (isBackgroundedRef.current || pipTransitionInFlightRef.current || pipExitExpectedPlayingRef.current)

In that case log and return without closing the player.

This preserves playback long enough for `onUserLeaveHint` to enter PiP.

## Discussion
