# Task: Tune mini player size and simplify dismissal model

## User feedback
- Phase 1 mini player behavior works pretty well
- Mini player is too small
- We do NOT need swipe-to-dismiss
- Close via X button is sufficient

## Scope
1. Increase mini player size modestly without making it feel bulky
2. Keep current snap/corner behavior
3. Do not add dismissal gesture work in future spec as default recommendation

## Current implementation
In `packages/app/components/video-player/constants.ts`:
- `MINI_PIP_WIDTH_FRACTION = 0.36`
- `MINI_PIP_WIDTH_MIN = 168`
- `MINI_PIP_WIDTH_MAX = 220`

## Candidate adjustment
Increase to something like:
- fraction 0.42
- min 188
- max 252

Need a balanced recommendation so it feels more like YouTube mini player, still leaving room for feed browsing.

## Discussion

## Codex Proposal
Recommend a moderate bump rather than the full candidate jump:

- `MINI_PIP_WIDTH_FRACTION`: `0.36` -> `0.40`
- `MINI_PIP_WIDTH_MIN`: `168` -> `184`
- `MINI_PIP_WIDTH_MAX`: `220` -> `240`

Why this set:
- It makes the mini player visibly larger on common phones without pushing too far into feed-browsing space.
- `0.40` is a clear step up from the current size, but still less aggressive than `0.42`.
- Capping at `240` lines up with the existing legacy `MINI_PIP_WIDTH = 240`, which reduces the chance of visual/layout mismatch versus raising the responsive max above that legacy width.
- On many phones the current config is effectively pinned near the `168` minimum; moving the minimum to `184` is what will make the biggest practical difference.

Implementation side effects / things to verify when increasing mini size:
- Bounds shrink inward: `computeMiniBounds()` uses mini width/height directly, so a larger card reduces draggable space on the right and bottom edges.
- Snap anchors move inward: corner snap behavior should still work, but the resting positions will sit farther from the screen edges simply because the card is larger.
- More content occlusion: a larger mini player will cover more feed/comment area, especially in bottom-right docked position.
- Bottom overlap risk increases: because bottom bounds account for `bottomChrome`, larger height can crowd tab bar / bottom UI sooner on shorter screens.
- Slow-release snap feel may change slightly: the current `SNAP_HYSTERESIS_PX = 24` remains usable, but with a larger card the snap can feel a little “stickier” to the current corner because the card’s center travels more for the same edge movement.

Important implementation note:
- The responsive size is computed in `computeMiniSize()`, but there are still legacy fixed-size references (`MINI_PIP_WIDTH = 240`, `MINI_PIP_HEIGHT = 135`) used in `styles.ts`, `useVideoGestures.ts`, and `SWIPE_DISMISS_THRESHOLD`.
- If only the responsive trio is changed, some drag bounds, dismiss distance, and mini metadata/control layout can become inconsistent with the rendered size.
- For a safe tuning pass, change the responsive constants above in `packages/app/components/video-player/constants.ts`, then verify whether the remaining fixed-width/fixed-height usages should also be aligned or migrated to the computed mini size.

Dismissal recommendation:
- Do not add or prioritize swipe-to-dismiss work. Keep close via X button as the primary dismissal path.

## Claude Proposal
Recommended mini player sizing for phase 1 follow-up:
- width fraction: 0.40
- min width: 184
- max width: 244

Why this tuning:
- 0.40 is a noticeable bump from 0.36 without crossing into "large overlay" territory.
- A 184 min width helps smaller phones feel less cramped and improves legibility of video content and controls.
- A 244 max width gives tablets and larger phones a bit more presence, but still preserves browseability and keeps the mini player from dominating the feed.
- This is slightly more conservative than the 0.42 / 188 / 252 candidate, which risks feeling a little too bulky during scrolling.
- Net effect: more YouTube-like usability, but still clearly a secondary playback surface.

Spec recommendation:
- Explicitly drop swipe-to-dismiss from the spec for this phase.
- Recommend X-only close as the sole dismissal model.

Why:
- User feedback already says swipe-to-dismiss is unnecessary.
- X-only close is simpler, more predictable, and avoids accidental dismissal while dragging or browsing.
- Keeping snap/corner behavior but removing dismissal gestures reduces implementation complexity and interaction ambiguity.
