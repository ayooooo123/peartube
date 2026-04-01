# Task: Verify how Grayjay exposes its extra Android PiP/media control button

## Goal
Stop guessing. Inspect Grayjay's real Android source and compare its PiP/media-session implementation to PearTube.

## Need to answer
1. Does Grayjay use standard Android PiP `RemoteAction`s?
2. If yes, how many actions does it set and in what order?
3. Is the extra visible button really a PiP action, or is it coming from media session / notification / some overlay?
4. What exact native mechanism should PearTube copy?

## PearTube current behavior
- Device only shows: pause, maximize, close, app settings
- Our added `backgroundAudio` action never fires in logs
- That suggests Android is not surfacing it at all

## Need inspected
- Grayjay Android source for PiP/media session
- PearTube:
  - `MediaSessionModule.kt`
  - `MediaPlaybackService.kt`

## Output format
Append findings under your own heading with:
- verified file paths
- exact APIs/classes used
- what PearTube should change

## Discussion
