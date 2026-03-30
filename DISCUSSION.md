# Task: Fix Android PiP not triggering on first video open

## Symptom
- Open video fresh
- Immediately swipe home
- PiP does NOT trigger
- If user minimize/maximize in-app first, then swipe home, PiP works

## Root cause hypothesis
In VideoPlayerOverlayImpl.tsx auto-PiP effect:

```ts
const shouldAutoPip = Platform.OS === 'android'
  ? currentVideo !== null && !isCasting && isPlaying
  : ...
```

On Android, auto-PiP is gated on `isPlaying`. Right after opening a video, before the first native `onPlaying` event fires, `isPlaying` is still false.
If user swipes home during that startup window, `setAutoPictureInPicture(false)` was the last applied value, so MainActivity's `onUserLeaveHint` can't enter PiP.

This matches the symptom exactly:
- first-open immediate home = too early, PiP disabled
- after minimize/maximize = playback state settled, isPlaying true, PiP enabled

## Proposed fix
For Android only, prime auto-PiP based on "has an active video in playable modes" instead of waiting for isPlaying:

```ts
const shouldAutoPip = Platform.OS === 'android'
  ? currentVideo !== null && !isCasting && (playerMode === 'fullscreen' || playerMode === 'mini')
  : ...
```

This makes PiP available immediately on first open.

## Safety
- PiP entry still only happens natively via onUserLeaveHint
- currentVideo must exist
- casting still disables PiP
- only fullscreen/mini modes qualify
- if user opens video but never leaves app, no behavior change

## Discussion
