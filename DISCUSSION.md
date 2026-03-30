# Task: Fix pan-drag jumping to start after tap-to-seek

## Symptom
- Tap-to-seek now works
- But if user then drags, the indicator can jump back toward the beginning/start

## Likely cause
Current gesture split uses:
- Tap gesture = jump to tapped point and commit seek
- Pan gesture = onBegin computes `startProgress` from the NEW touch point (`p = getProgressFromTouch(evt.x, tw)`)

That means the pan gesture is still acting like "touch-to-place thumb" even though tap-to-seek already owns that interaction.
When user intends to DRAG after a previous tap/seek, pan should grab the CURRENT indicator position, not recompute from touch X.

## Proposed fix
- Keep `Gesture.Tap()` exactly as-is for tap-to-seek
- Change `Gesture.Pan()` so onBegin:
  - does NOT compute `p = getProgressFromTouch(evt.x, tw)`
  - instead sets `startProgress = lockActiveSV ? lockProgressSV : uiProgressSV`
  - optionally snaps `uiProgressSV` to current locked progress so drag starts exactly where indicator is
- Pan then applies `translationX / trackWidth` relative to current indicator position

This cleanly separates responsibilities:
- Tap = place playhead
- Pan = drag existing playhead

## Discussion
