# Task: Mini player compact/expanded size toggle on double tap

## Clarification from user
Double tapping the mini player should NOT maximize to fullscreen.
It should toggle the mini player between:
- compact mini player
- larger mini player

This should mirror native PiP behavior where the floating player can be small or larger while still remaining a floating player.

## Desired behavior
- single tap: show/hide mini controls (or no-op if that's already the current behavior)
- double tap: toggle mini size mode compact <-> expanded
- maximize back to fullscreen should remain on explicit maximize button only
- preserve current dock corner while resizing
- animate smoothly between compact and expanded rects
- snapping/fling logic should use the current active size

## Existing implementation
- current mini size is responsive but single-size only
- `miniPlayerCorner` persists current corner
- mini geometry is computed via `computeMiniSize(screenWidth, aspectRatio)`
- double tap currently calls `maximizeFromMini()`

## Proposed implementation direction
- add `miniPlayerSizeMode: 'compact' | 'expanded'` state/ref
- create `computeMiniSize(screenWidth, aspectRatio, sizeMode)`
- compact:
  - current-ish size, maybe slightly bigger than now
- expanded:
  - larger PiP-like size, still clearly floating over content
- on size toggle:
  - recompute width/height
  - recompute legal bounds
  - preserve current corner anchor
  - animate x/y/width/height to new anchored rect
- update snap algorithm to use current size mode dimensions

## Discussion

## Codex Proposal

### 1. Introduce an explicit mini size mode and mirror it on the UI thread
Add a new state/ref alongside `miniPlayerCorner`:
- `const [miniPlayerSizeMode, setMiniPlayerSizeMode] = useState<'compact' | 'expanded'>('compact')`
- `const miniPlayerSizeModeShared = useSharedValue<'compact' | 'expanded'>(miniPlayerSizeMode)`

Keep `miniPlayerCorner` as the stable docking identity. The key change is that corner and size mode become orthogonal state:
- `miniPlayerCorner` answers which anchor to use
- `miniPlayerSizeMode` answers which width/height to use

That separation lets double tap resize the mini player without changing fullscreen/mini mode and without reusing maximize semantics.

### 2. Thread size mode through `computeMiniSize` and every caller that derives bounds
The current implementation in `packages/app/components/VideoPlayerOverlayImpl.tsx` has a single-size worklet helper:
- `computeMiniSize(screenWidth, aspectRatio)`
- `getMobileMiniPlayerSnapPosition(...)` calls it
- mini drag update/end worklets call it
- the render path derives `dynMiniWidth/dynMiniHeight` from it

Change the signature to:
- `computeMiniSize(screenWidth, aspectRatio, sizeMode)`

Implementation shape:
- keep current compact behavior as the default baseline so existing layout stays stable
- add expanded sizing with a larger width fraction and/or larger max width, but preserve aspect ratio exactly
- return `{ width, height }` exactly as today so downstream math is unchanged

Concretely, I would avoid sprinkling `if (sizeMode === ...)` everywhere and instead define per-mode sizing constants, e.g.:
- compact: current `MINI_PIP_WIDTH_FRACTION`, `MINI_PIP_WIDTH_MIN`, `MINI_PIP_WIDTH_MAX`
- expanded: new larger fraction/max pair, still capped so it remains obviously floating

Then update all size/bounds callsites to pass the active mode:
- `const { width: dynMiniWidth, height: dynMiniHeight } = computeMiniSize(screenWidth, effectiveAR, miniPlayerSizeMode)`
- `getMobileMiniPlayerSnapPosition({ ..., aspectRatio, sizeMode })`
- pan gesture `.onUpdate` and `.onEnd` worklets: `computeMiniSize(screenWidthShared.value, aspectRatioShared.value, miniPlayerSizeModeShared.value)`

This is the most important plumbing step because snap targets, legal drag bounds, and mini->fullscreen interpolation already depend on mini width/height. If one caller keeps using the old size, the player will visually resize but still drag/snap against stale geometry.

### 3. Preserve the current corner by anchoring resize from `miniPlayerCorner`, not from raw `x/y`
The existing code already has the right primitive for this:
- `miniPlayerCorner` in JS
- `currentDockCornerShared` in the worklet
- `getMobileMiniPlayerSnapPosition({ corner, ... })`

Use those to recompute the resized rect from the same corner whenever size mode changes.

Recommended toggle flow:
1. Double tap while `playerMode === 'mini'`
2. Flip `miniPlayerSizeMode`
3. Recompute `{ x, y, width, height }` via `getMobileMiniPlayerSnapPosition({ corner: miniPlayerCorner, ..., sizeMode: nextMode })`
4. Animate `miniPipX`, `miniPipY`, `miniPipDynWidthShared`, and `miniPipDynHeightShared` to the new anchored rect
5. Leave `miniPlayerCorner` unchanged

Why this matters:
- if you only animate width/height and leave `miniPipX/Y` untouched, a bottom-right docked mini player will appear to grow inward from the wrong origin
- recomputing from the stored corner ensures top-left stays top-left, bottom-right stays bottom-right, etc.

This also fits the current `useEffect` at ~1043, which already repositions mini mode from `miniPlayerCorner` on layout changes. That effect should simply also depend on `miniPlayerSizeMode` and pass it into `getMobileMiniPlayerSnapPosition(...)`.

### 4. Replace double-tap maximize with a dedicated size toggle callback
Right now:
- `maximizeFromMini()` just calls `maximizePlayer()`
- `miniDoubleTapGesture` calls `runOnJS(maximizeFromMini)()`

Replace that path with something like `toggleMiniPlayerSizeMode()`.

Implementation detail:
- do the state flip on JS
- immediately update `miniPlayerSizeModeShared.value` during render, the same way other shared layout inputs are mirrored now
- if currently in mini mode and not dragging, animate to the new snapped rect for the same corner

Pseudo-flow:
- `const toggleMiniPlayerSizeMode = useCallback(() => { ... }, [...])`
- `miniDoubleTapGesture.onEnd(... runOnJS(toggleMiniPlayerSizeMode)())`

Do not route this through `maximizePlayer()` or `animProgress`, because the player is not changing modes. It remains `playerMode === 'mini'`; only the mini endpoint geometry changes.

### 5. Keep snap/fling behavior unchanged by feeding it the active dimensions, not by changing the algorithm
The current snap/fling behavior is already clean:
- drag update clamps against `computeMiniBounds(...)`
- drag end computes anchors from bounds
- `resolveSnapTarget(...)` projects velocity and applies hysteresis toward `currentDockCornerShared`

This logic should not be rewritten. It should only receive the correct dimensions for the active size mode.

Specifically, on drag update/end:
- compute `mw/mh` from `computeMiniSize(..., miniPlayerSizeModeShared.value)`
- compute `bounds` from those dimensions
- compute anchors from those bounds
- keep using `currentDockCornerShared` for hysteresis

That preserves existing toss/fling feel while making the legal rectangle bigger/smaller with the selected mini size.

Important subtlety: when toggling size mode while already docked, also update `currentDockCornerShared.value = miniPlayerCorner`. That keeps slow-release hysteresis aligned with the preserved anchor after the resize.

### 6. Suggested implementation shape for the resize animation
For the actual compact/expanded toggle in mini mode:
- animate `miniPipX` and `miniPipY` with `SPRING_CONFIG_TIGHT` or `SPRING_CONFIG_MINI_SNAP`
- animate `miniPipDynWidthShared` and `miniPipDynHeightShared` with the same spring family
- do not touch `animProgress` unless transitioning between fullscreen and mini

That reuses the existing animated container path, because `containerStyle` already interpolates from:
- `miniPipDynWidthShared.value`
- `miniPipDynHeightShared.value`
- `miniPipX.value`
- `miniPipY.value`

So the resize can stay entirely inside the current geometry model.

### 7. Minimal code touch points
Most likely files/areas to update:
- `packages/app/components/VideoPlayerOverlayImpl.tsx`
  - add `miniPlayerSizeMode` + shared mirror
  - extend `computeMiniSize`
  - extend `getMobileMiniPlayerSnapPosition`
  - update `dynMiniWidth/dynMiniHeight` derivation
  - update mini layout reposition effect
  - swap double tap from `maximizeFromMini` to `toggleMiniPlayerSizeMode`
  - pass size mode through drag update/end worklets
- `packages/app/components/video-player/constants.ts`
  - add compact/expanded sizing constants instead of a single width profile

### 8. Proposed non-goals / guardrails
To reduce regressions, I would explicitly avoid:
- changing the existing snap scoring in `resolveSnapTarget(...)`
- changing fullscreen drag-to-minimize logic
- changing maximize button behavior (`maximizeFromMini` should still exist for the explicit button)
- storing freeform `x/y` as the source of truth for resize anchoring

The safest model is: `corner + sizeMode -> size -> bounds -> anchored x/y`.
That keeps the current phase-2 drag/snap behavior intact while making double tap a pure compact/expanded mini resize.

## Claude Proposal

Use two clearly distinct floating sizes so the interaction feels intentionally PiP-like rather than "small vs almost the same small." The compact size should be the default resting state for passive watching, while the expanded size should feel like a quick readability boost for subtitles, faces, or detail-heavy scenes without ever implying fullscreen.

Recommended size formulas:
- compact width: clamp(screenWidth * 0.32, 220px, 300px)
- compact height: derive from aspect ratio, with the same min/max constraints applied via width-first sizing
- expanded width: clamp(compactWidth * 1.35, 300px, min(420px, screenWidth * 0.5))
- expanded height: derive from aspect ratio from expanded width
- preserve a consistent outer margin from screen edges in both modes so the player still reads as "docked" to its current corner

This gives roughly a 35% step up in perceived size, which is large enough to feel satisfying on double tap but still conservative enough to avoid covering too much feed/UI. If current mini player size is already near the compact recommendation, keep it close; the more important UX point is that expanded should be visibly larger, not just marginally resized.

How the size toggle should feel:
- double tap should instantly communicate "resize in place," not "open"
- animate width, height, and anchored position together over about 180-220ms with a smooth ease-out
- keep the same dock corner fixed during the animation so the player appears to grow or shrink outward from that corner
- do not crossfade to another state or trigger fullscreen affordances during the gesture
- if controls are visible, keep them visible through the resize so the interaction feels continuous
- ignore accidental triple-tap weirdness by making repeated double taps simply alternate modes cleanly

Behaviorally, expanded mode should not be sticky in a way that surprises the user: if the app already persists mini-player corner, it is reasonable to persist size mode for the session, but defaulting back to compact on fresh open is safer unless product explicitly wants last-used memory.

Visual polish considerations:
- slightly increase shadow/elevation in expanded mode so the larger surface still feels floating above the app, not embedded in it
- keep border radius identical or nearly identical across both sizes; changing radius too much can make the component feel like a different object
- ensure overlay controls scale comfortably with the larger size, especially hit targets for close/maximize
- subtitle and caption safe area should be checked in expanded mode so text is not too close to rounded corners or controls
- preserve drag affordance immediately after resizing; users often resize and then reposition in one flow
- if resize occurs near screen edges, legal bounds should be recomputed before the animation completes so the player never appears to clip off-screen

Net recommendation: define compact as the everyday default around one-third of screen width, define expanded as approximately 1.35x compact capped at about half the screen width, and make double tap perform a fast anchored resize with no fullscreen implication.
