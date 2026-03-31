# Task: Remove black bars above/below mini-player video without cropping

## Symptom
User reports black bars above and below the video in the player. Wants the video to fit the player perfectly without cutting any video off.

## Current likely cause
`VideoPlayerOverlayImpl.tsx` currently uses:
- `videoHeight = getPlayerPageVideoHeight(screenWidth)` for the fullscreen page frame
- `effectiveAR = videoAspectRatio || 16/9` for mini-player sizing

On Android mini mode, the video wrapper is kept at a fullscreen-sized baseline for PiP reliability, but that baseline height may still come from the 16:9 page frame instead of the actual video aspect ratio. That would create letterboxing when the actual video AR differs from the page frame.

## Goal
- no bars above/below in mini player
- no cropping
- keep Android PiP stable

## Most likely fix
For Android mini mode, base the native-wrapper baseline height on the actual video aspect ratio (`screenWidth / effectiveAR`) rather than the fullscreen page frame height. That should keep the wrapper aspect ratio aligned with the visible mini-player bounds while preserving a stable fullscreen-width baseline for PiP.

## Files
- `packages/app/components/VideoPlayerOverlayImpl.tsx`
- possibly `VideoContainer.tsx` / `PearInlineVideoView.tsx` if resizeMode assumptions matter

## Discussion

## Claude Proposal

### Root cause

Two independent height calculations diverge when the video AR ≠ 16:9:

| Value | Source | Depends on actual AR? |
|---|---|---|
| `videoHeight` (`videoHeightShared`) | `getPlayerPageVideoHeight(screenWidth)` → `screenWidth * 9/16` | **No** — always 16:9 |
| `dynMiniHeight` (`miniPipDynHeightShared`) | `computeMiniSize(screenWidth, effectiveAR, …)` → `w / effectiveAR` | **Yes** |

In the Android mini-mode branch (line ~1630), the wrapper is kept at `fullH = videoHeightShared` (16:9) and a scale transform shrinks it to the mini-player clip size:

```js
const scaleY = fullH > 0 ? miniPipDynHeightShared.value / fullH : 1
// wrapper: { width: fullW, height: fullH } with transform [{ scaleX }, { scaleY }]
```

If the video is 4:3, `fullH` (16:9) is *shorter* than what the AR needs. VLC `resizeMode=contain` letterboxes inside the 16:9 wrapper. The clip box (`dynMiniHeight`) is computed from the real AR, so the letterbox bars are visible.

If the video is 21:9, `fullH` is *taller* than needed, and VLC pillarboxes — the top/bottom bars appear again.

### Proposed fix (minimal, single-variable)

Replace the 16:9-locked `videoHeight` with an AR-aware height for the Android mini-mode baseline, while keeping the fullscreen page frame unchanged.

**In `VideoPlayerOverlayImpl.tsx`, inside the `videoWrapperStyle` worklet** (~line 1623):

```js
// BEFORE:
const fullH = videoHeightShared.value + cutoutInset

// AFTER:
const arAwareH = aspectRatioShared.value > 0
  ? Math.round(screenWidthShared.value / aspectRatioShared.value)
  : videoHeightShared.value
const fullH = (Platform.OS === 'android' && isMiniPlayerModeShared.value)
  ? arAwareH
  : videoHeightShared.value + cutoutInset
```

This changes **only** the Android mini-mode path. Fullscreen, iOS, and PiP branches continue to use the 16:9 page frame height.

### Why this is safe for PiP

- The baseline wrapper stays at `screenWidth` wide (unchanged).
- `fullH` only changes in the `isMiniPlayerModeShared` branch, which is **exited** before PiP entry (PiP always transitions from fullscreen, never from mini).
- `frozenVideoHeightShared` (used by the PiP branch at line 1601) is unaffected — it still freezes the 16:9 fullscreen height.
- The scale transform ratio (`miniHeight / fullH`) now divides two values that share the same AR, producing a pure size scale with no letterbox.

### What about `frozenVideoHeightShared`?

No change needed. It's only read in the `isPipLayoutActiveShared` branch (line 1601), which is mutually exclusive with the mini-player branch. PiP always operates from a fullscreen baseline.

### Risk assessment

| Concern | Risk |
|---|---|
| Android PiP black screen | **None** — PiP branch untouched, `frozenVideoHeightShared` unchanged |
| Fullscreen layout shift | **None** — `fullH` change is gated on `isMiniPlayerModeShared` |
| iOS mini-player | **None** — iOS doesn't enter the Android mini branch |
| Scale correctness | **Improved** — scaleY now maps between same-AR rectangles |

### Optional follow-up (not in this PR)

The fullscreen page frame itself could also be made AR-aware (`videoHeight = screenWidth / effectiveAR` clamped to screen height), which would eliminate letterboxing in fullscreen too. But that touches the PiP-frozen values and the fullscreen→PiP transition path, so it's a separate, higher-risk change.
