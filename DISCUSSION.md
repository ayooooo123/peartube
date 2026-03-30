# Task: Fix tap-to-seek restarting video

## Symptom
- User taps a spot on the progress bar
- Progress indicator moves there visually
- Actual video restarts / seeks to the beginning instead of the tapped position

## Important clarification
This means the **Scrubber gesture/UI layer is working** (indicator moves), but the **actual player seek pipeline is broken** somewhere after `handleCommit`.

## Suspected path
Scrubber.tsx:
- onEnd/onFinalize -> handleCommit(timeSeconds)

VideoPlayerOverlayImpl.tsx:
- handleScrubCommit(timeSeconds) -> seekTo(clamped)

VideoPlayerContext.tsx:
- seekTo(timeSeconds)
  - computes `seekValue = clampedTime / dur`
  - sets `seekPosition(seekValue)`  // ratio 0..1

PearInlineVideoView.tsx:
- useEffect(applyPendingSeek(seekPosition))
- applyPendingSeek(nextSeekPosition)
  - treats seekPosition as ratio 0..1
  - targetMs = clampedSeek * durationMs
  - videoRef.current?.seek(targetMs / 1000)

## Hypothesis
The prop-driven seek pipeline (`seekPosition` ratio -> applyPendingSeek -> videoRef.seek(seconds)`) is racing or misfiring on Android. Since the adapter already exposes `playerRef.current.seek(timeSeconds)`, the simplest and most robust fix may be:

- In VideoPlayerContext.seekTo() and seekBy(), call `playerRef.current?.seek?.(clampedTime)` directly on native (same as web path)
- Keep `setSeekPosition(...)` only as a fallback if playerRef is unavailable / not ready yet
- This bypasses the ratio conversion + prop/effect pipeline entirely for normal seeks

## Files to inspect
- packages/app/lib/VideoPlayerContext.tsx (seekTo, seekBy)
- packages/app/components/video-player/PearInlineVideoView.tsx (adapter, applyPendingSeek)

## Discussion

## Hermes Review
- I reviewed `VideoPlayerContext.seekTo/seekBy` and `PearInlineVideoView.applyPendingSeek/adapter`.
- The native path currently does not seek imperatively when the user taps the scrubber. Instead, `seekTo()` and `seekBy()` convert the absolute target time into a normalized `seekPosition` ratio, then rely on `PearInlineVideoView` to notice that prop change, multiply by its locally known duration, and finally call `videoRef.current?.seek(...)`.
- That means the actual native seek depends on a deferred prop/effect pipeline with two extra assumptions:
  1. `VideoPlayerContext`'s duration and `PearInlineVideoView`'s `durationMsRef` stay in sync.
  2. The `seekPosition` ratio is applied against the currently loaded native player instance at the right moment.
- The adapter already exposes the correct imperative API: `playerRef.current.seek(timeSeconds)` directly calls `videoRef.current?.seek(Math.max(0, timeSeconds))`.
- So on native, tap-to-seek is currently taking the long path even though a short, explicit path already exists.

### Diagnosis
- I agree with the suspicion that the ratio pipeline is the likely reason tap-to-seek visually moves the scrubber but the actual video jumps back/restarts.
- The scrubber UI updates because `VideoPlayerContext` immediately sets `currentTime` and `seekPosition`.
- But the real seek happens later inside `applyPendingSeek()`, which derives seconds from a ratio and local duration cache. If that duration cache is stale/zero, tied to a freshly recreated player, or otherwise out of sync with the context, the computed target passed to `videoRef.seek(...)` can be wrong. A bad ratio application is exactly the sort of failure that would leave the UI looking right while the player itself seeks to 0 or restarts playback position.
- In contrast, `playerRef.current.seek(clampedTime)` already expresses the desired operation in the correct unit for `react-native-video` and avoids the extra ratio conversion, effect timing, and duplicate duration bookkeeping.

### Proposed minimal fix
- Change native `seekTo()` and `seekBy()` to first call `playerRef.current?.seek?.(targetSeconds)` directly, just like the web path already does.
- Keep the optimistic `currentTimeRef/currentTime` update and `startSeekConfirm(targetSeconds)` logic so the UI remains responsive and the pending-seek confirmation still clears transient state.
- Only fall back to `setSeekPosition(targetSeconds / duration)` when `playerRef.current?.seek` is unavailable, such as early-load/resume cases where the player ref is not ready yet.
- Keep `applyPendingSeek(seekPosition)` in `PearInlineVideoView` as that fallback mechanism for pending seeks during load/reload, but do not use it as the primary path for ordinary user scrub commits on native.

### Why this is minimal and safer
- No new player API is needed; the imperative adapter already exists.
- It aligns native behavior with the already-working direct-seek web behavior.
- It preserves the existing ratio-based pending-seek path for cases where the native player is not yet ready, instead of removing that machinery entirely.
- It reduces the bug surface area to one direct call with seconds, rather than context duration -> ratio -> view duration -> seconds.

### Bottom line
- Yes: native should use imperative `playerRef.current.seek(seconds)` as the primary seek path.
- The current `seekPosition` ratio pipeline should be retained only as a fallback/pending-load mechanism, not the default path for tap-to-seek.
