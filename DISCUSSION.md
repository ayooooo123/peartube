# Task: Implement Phase 1 of MINI_PLAYER_REDESIGN_SPEC

## Goal
Implement Phase 1 of `MINI_PLAYER_REDESIGN_SPEC.md` in PearTube's mobile player.

## Scope (Phase 1 only)
1. Responsive mini-player geometry (replace fixed width/height assumptions)
2. 4-corner snap targets (TL, TR, BL, BR)
3. Velocity-biased projected snap selection
4. Diagonal fling support
5. Preserve last dock corner
6. Stronger drag vs docked shadow/radius tuning

## Do NOT implement yet
- dismiss gesture
- PiP continuity refactor
- mini-player control redesign
- title strip / extra chrome
- elastic rubber banding

## Existing code to inspect
Primary file:
- `packages/app/components/VideoPlayerOverlayImpl.tsx`

Key existing pieces:
- `getMobileMiniPlayerSnapPosition(...)`
- `MINI_PIP_WIDTH`, `MINI_PIP_HEIGHT`, `MINI_PIP_MARGIN`, `MINI_PIP_CORNER_RADIUS`
- `miniPlayerCorner` state
- `miniPipX`, `miniPipY`, `miniPipDynWidthShared`
- mini-player branch inside `panGesture.onUpdate` / `panGesture.onEnd`
- current snap logic uses simple midpoint heuristic:
  - `isRight = miniPipX + width/2 > screenWidth/2`
  - `isBottom = miniPipY > (topY + bottomY) / 2`

## What needs replacing
Current mini-player drag end behavior is too simplistic:
- no velocity projection
- no diagonal fling behavior
- basically nearest quadrant only

## Spec requirements to implement
From `MINI_PLAYER_REDESIGN_SPEC.md`:
- miniWidth = clamp(round(screenWidth * 0.36), 168, 220)
- miniHeight = round(miniWidth / aspectRatio)
- margins = 12 + safe area / tab bar offsets
- 4 anchors from legal bounds
- snap algorithm:
  - low velocity < 500 px/s => nearest corner to current release point
  - toss 500..1400 => horizon 0.18s
  - fling >= 1400 => horizon 0.22s
  - projected target = release + velocity * horizon
  - choose nearest anchor by squared center distance
  - hysteresis: if speed < 500 and current dock corner is within 24px center-distance of best score, keep current corner
- spring config for snap:
  - stiffness 340
  - damping 30
  - mass 0.9
  - restDisplacementThreshold 0.5
  - restSpeedThreshold 4
- dragging visual tuning:
  - dragScale 0.985
  - docked shadowOpacity 0.18, radius 14, offsetY 4
  - dragging shadowOpacity 0.24, radius 18, offsetY 6
  - cornerRadius 16 in mini mode

## Claude Proposal

### Overview

The implementation keeps all changes inside two files: `constants.ts` (new constants + spring configs) and `VideoPlayerOverlayImpl.tsx` (geometry helpers, snap algorithm, gesture branches, animated styles). No new files, no new hooks, no architectural changes. The existing `getMobileMiniPlayerSnapPosition` becomes a thin wrapper around a richer geometry system, and the `panGesture.onEnd` mini branch gets replaced with a projected-snap worklet.

---

### 1. Constants changes (`packages/app/components/video-player/constants.ts`)

**Replace:**
```ts
export const MINI_PIP_WIDTH = 240
export const MINI_PIP_HEIGHT = 135
export const MINI_PIP_CORNER_RADIUS = 8
```

**With:**
```ts
// Responsive mini size — actual values computed at runtime
export const MINI_PIP_WIDTH_FRACTION = 0.36
export const MINI_PIP_WIDTH_MIN = 168
export const MINI_PIP_WIDTH_MAX = 220
export const MINI_PIP_CORNER_RADIUS = 16

// Keep MINI_PIP_MARGIN = 12 (unchanged)
```

**Add new spring config:**
```ts
export const SPRING_CONFIG_MINI_SNAP = {
  damping: 30,
  stiffness: 340,
  mass: 0.9,
  restDisplacementThreshold: 0.5,
  restSpeedThreshold: 4,
  overshootClamping: false,
}
```

**Add snap algorithm constants:**
```ts
export const SNAP_LOW_SPEED = 500       // px/s
export const SNAP_FLING_SPEED = 1400    // px/s
export const SNAP_TOSS_HORIZON = 0.18   // seconds
export const SNAP_FLING_HORIZON = 0.22  // seconds
export const SNAP_HYSTERESIS_PX = 24    // center-distance for slow-release stickiness
```

**Add visual tuning constants:**
```ts
export const MINI_DRAG_SCALE = 0.985
export const MINI_SHADOW_DOCKED = { opacity: 0.18, radius: 14, offsetY: 4 }
export const MINI_SHADOW_DRAGGING = { opacity: 0.24, radius: 18, offsetY: 6 }
```

**Keep `SPRING_CONFIG_TIGHT` unchanged** — it's still used for fullscreen↔mini transitions and other non-snap animations. `SPRING_CONFIG_MINI_SNAP` is only for corner docking.

---

### 2. Geometry helpers (top of `VideoPlayerOverlayImpl.tsx`, near existing `getMobileMiniPlayerSnapPosition`)

#### 2a. `computeMiniSize` — pure worklet

```ts
function computeMiniSize(screenWidth: number, aspectRatio: number) {
  'worklet'
  const ar = aspectRatio > 0 ? aspectRatio : 16 / 9
  const w = Math.max(MINI_PIP_WIDTH_MIN, Math.min(MINI_PIP_WIDTH_MAX, Math.round(screenWidth * MINI_PIP_WIDTH_FRACTION)))
  const h = Math.round(w / ar)
  return { width: w, height: h }
}
```

This replaces both `MINI_PIP_WIDTH` (fixed 240) and `MINI_PIP_HEIGHT` (fixed 135), and also replaces the `dynMiniWidth` computation (line 348) which currently derives width from height×AR capped at 240. The new model derives height from width÷AR, matching the spec.

#### 2b. `computeMiniBounds` — pure worklet

```ts
interface MiniBounds {
  leftBound: number
  rightBound: number
  topBound: number
  bottomBound: number
}

function computeMiniBounds(
  screenWidth: number,
  screenHeight: number,
  insetTop: number,
  insetBottom: number,
  bottomChrome: number,   // max(tabBarHeight, transientChromeHeight)
  miniWidth: number,
  miniHeight: number,
): MiniBounds {
  'worklet'
  const margin = MINI_PIP_MARGIN // 12
  const bottomMargin = Math.max(insetBottom + margin, bottomChrome + insetBottom + margin)
  return {
    leftBound:   margin,                                   // safeArea.left is 0 on phones
    rightBound:  screenWidth - margin - miniWidth,
    topBound:    insetTop + margin,
    bottomBound: screenHeight - bottomMargin - miniHeight,
  }
}
```

**Threading safe area / bottom chrome:** `insetTop` comes from `insetTopShared.value` (already a shared value). `bottomChrome` comes from `miniPlayerBottomShared.value` (already computed as `max(reportedTabBarHeight, expectedTabBarHeight)`). `insetBottom` comes from `insetBottomShared.value`. All are already available on the UI thread. No new shared values needed for bounds inputs.

**Why `insetBottom` is separate from `bottomChrome`:** The spec says `bottomMargin = max(safeArea.bottom + 12, tabBarHeight + safeArea.bottom + 12)`. The tab bar already includes bottom inset in `miniPlayerBottom`, so the actual formula simplifies to `max(insetBottom + 12, miniPlayerBottom + 12)`. Since `miniPlayerBottom >= insetBottom` in practice, this reduces to `miniPlayerBottom + 12`, but we keep the max for correctness on edge-case devices.

#### 2c. `getCornerAnchors` — pure worklet

```ts
type AnchorCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

interface Anchor { x: number; y: number; corner: AnchorCorner }

function getCornerAnchors(bounds: MiniBounds): [Anchor, Anchor, Anchor, Anchor] {
  'worklet'
  return [
    { x: bounds.leftBound,  y: bounds.topBound,    corner: 'top-left' },
    { x: bounds.rightBound, y: bounds.topBound,    corner: 'top-right' },
    { x: bounds.leftBound,  y: bounds.bottomBound, corner: 'bottom-left' },
    { x: bounds.rightBound, y: bounds.bottomBound, corner: 'bottom-right' },
  ]
}
```

#### 2d. `resolveSnapTarget` — the core algorithm, pure worklet

```ts
function resolveSnapTarget(
  releaseX: number,
  releaseY: number,
  vx: number,
  vy: number,
  anchors: Anchor[],
  miniWidth: number,
  miniHeight: number,
  currentCorner: AnchorCorner,
  bounds: MiniBounds,
): Anchor {
  'worklet'
  const speed = Math.sqrt(vx * vx + vy * vy)

  // Determine projection horizon
  let horizon = 0
  if (speed >= SNAP_FLING_SPEED) {
    horizon = SNAP_FLING_HORIZON
  } else if (speed >= SNAP_LOW_SPEED) {
    horizon = SNAP_TOSS_HORIZON
  }

  // Project release point
  let targetX = releaseX + vx * horizon
  let targetY = releaseY + vy * horizon

  // Clamp to legal bounds
  targetX = Math.max(bounds.leftBound, Math.min(bounds.rightBound, targetX))
  targetY = Math.max(bounds.topBound, Math.min(bounds.bottomBound, targetY))

  // Target card center
  const tcx = targetX + miniWidth / 2
  const tcy = targetY + miniHeight / 2

  // Score each anchor by squared center distance
  let bestAnchor = anchors[0]
  let bestScore = Infinity
  let currentAnchorScore = Infinity

  for (let i = 0; i < anchors.length; i++) {
    const acx = anchors[i].x + miniWidth / 2
    const acy = anchors[i].y + miniHeight / 2
    const score = (acx - tcx) * (acx - tcx) + (acy - tcy) * (acy - tcy)
    if (score < bestScore) {
      bestScore = score
      bestAnchor = anchors[i]
    }
    if (anchors[i].corner === currentCorner) {
      currentAnchorScore = score
    }
  }

  // Hysteresis: on slow release, prefer current corner if it's close enough
  if (speed < SNAP_LOW_SPEED && currentAnchorScore < Infinity) {
    const bestDist = Math.sqrt(bestScore)
    const currentDist = Math.sqrt(currentAnchorScore)
    if (currentDist - bestDist < SNAP_HYSTERESIS_PX) {
      return anchors.find(a => a.corner === currentCorner) ?? bestAnchor
    }
  }

  return bestAnchor
}
```

**Why squared distance for scoring but sqrt for hysteresis:** Squared distance is fine for ranking (monotonic), but the 24px hysteresis threshold is defined in actual pixels per spec, so we sqrt only for the comparison. We could alternatively square the threshold (24²=576) and compare scores directly — either works, but actual distance is clearer.

---

### 3. Replace `getMobileMiniPlayerSnapPosition`

The existing function stays as a JS-side helper (used in `useEffect` for programmatic repositioning), but its internals change:

```ts
function getMobileMiniPlayerSnapPosition({
  corner,
  screenWidth,
  screenHeight,
  miniWidth,
  topInset,
  bottomOffset,
}: { ... }) {
  const { height: miniHeight } = computeMiniSize(screenWidth, /* need AR here */)
  // Problem: this function doesn't receive aspectRatio today
  ...
}
```

**Change required:** Add `aspectRatio: number` parameter. The two call sites (lines 793 and 887) already have `effectiveAR` in scope. The function body becomes:

```ts
function getMobileMiniPlayerSnapPosition({ corner, screenWidth, screenHeight, topInset, bottomOffset, aspectRatio }: { ... }) {
  const { width: miniWidth, height: miniHeight } = computeMiniSize(screenWidth, aspectRatio)
  const bounds = computeMiniBounds(screenWidth, screenHeight, topInset, 0, bottomOffset, miniWidth, miniHeight)
  const anchors = getCornerAnchors(bounds)
  const anchor = anchors.find(a => a.corner === corner) ?? anchors[3] // default BR
  return { x: anchor.x, y: anchor.y, width: miniWidth, height: miniHeight }
}
```

Return type gains `width` and `height` so callers can use responsive dimensions. The existing `dynMiniWidth` local (line 348) and `miniPipDynWidthShared` shared value should be seeded from this return value instead of the old `Math.min(Math.round(MINI_PIP_HEIGHT * effectiveAR), MINI_PIP_WIDTH)` formula.

---

### 4. Replace `panGesture.onEnd` mini branch (lines 1119–1137)

Current code:
```ts
const isRight = miniPipX.value + miniPipDynWidthShared.value / 2 > screenWidthShared.value / 2
const isBottom = miniPipY.value > (topY + bottomY) / 2
```

**Replace with:**
```ts
// Inside .onEnd worklet:
if (isMiniPlayerDraggingShared.value) {
  isMiniPlayerDraggingShared.value = false
  isGestureActive.value = false

  const { width: mw, height: mh } = computeMiniSize(screenWidthShared.value, aspectRatioShared.value)
  const bounds = computeMiniBounds(
    screenWidthShared.value,
    screenHeightShared.value,
    insetTopShared.value,
    insetBottomShared.value,
    miniPlayerBottomShared.value,
    mw, mh,
  )
  const anchors = getCornerAnchors(bounds)
  const snap = resolveSnapTarget(
    miniPipX.value, miniPipY.value,
    event.velocityX, event.velocityY,
    anchors, mw, mh,
    currentDockCornerShared.value,   // new shared value (see §5)
    bounds,
  )

  miniPipX.value = withSpring(snap.x, SPRING_CONFIG_MINI_SNAP, () => {})
  miniPipY.value = withSpring(snap.y, SPRING_CONFIG_MINI_SNAP)
  currentDockCornerShared.value = snap.corner
  runOnJS(setMiniPlayerCorner)(snap.corner)
  runOnJS(setIsDraggingMiniPlayer)(false)
  return
}
```

**Key difference:** `withSpring` now uses `SPRING_CONFIG_MINI_SNAP` (340/30/0.9) instead of `SPRING_CONFIG_TIGHT` (200/25/0.8). The new spring is stiffer with slightly less damping, giving a snappy dock with a tiny natural overshoot (per `overshootClamping: false`).

**Velocity passthrough:** Reanimated's `withSpring` accepts `velocity` in its config. We should pass release velocity to make the spring continuation feel physical:
```ts
miniPipX.value = withSpring(snap.x, { ...SPRING_CONFIG_MINI_SNAP, velocity: event.velocityX })
miniPipY.value = withSpring(snap.y, { ...SPRING_CONFIG_MINI_SNAP, velocity: event.velocityY })
```

---

### 5. New shared value: `currentDockCornerShared`

The snap worklet needs to know the current dock corner for hysteresis, but `miniPlayerCorner` is JS state (React `useState`). Reading it from the worklet would require `runOnJS` which defeats the purpose.

**Add:**
```ts
const currentDockCornerShared = useSharedValue<AnchorCorner>('bottom-right')
```

Keep it in sync with `setMiniPlayerCorner` — whenever we call `runOnJS(setMiniPlayerCorner)(corner)`, also set `currentDockCornerShared.value = corner` on the UI thread (which we're already on in the worklet). The JS `miniPlayerCorner` state stays as the source of truth for React renders; the shared value is a UI-thread mirror for the snap algorithm.

---

### 6. New shared value: `aspectRatioShared`

The worklet needs aspect ratio for `computeMiniSize`. Currently `effectiveAR` is a JS-side `const`.

**Add:**
```ts
const aspectRatioShared = useSharedValue(effectiveAR)
```

Sync it in the existing `useEffect` block (around line 860) that already syncs `videoHeightShared`, `miniPipDynWidthShared`, etc:
```ts
aspectRatioShared.value = effectiveAR
```

---

### 7. Replace `panGesture.onUpdate` mini clamp bounds (lines 1094–1101)

Current code uses `MINI_PIP_HEIGHT` for Y bounds. Replace with responsive height:

```ts
if (isMiniPlayerDraggingShared.value) {
  const { width: mw, height: mh } = computeMiniSize(screenWidthShared.value, aspectRatioShared.value)
  const bounds = computeMiniBounds(
    screenWidthShared.value, screenHeightShared.value,
    insetTopShared.value, insetBottomShared.value,
    miniPlayerBottomShared.value, mw, mh,
  )
  miniPipX.value = Math.max(bounds.leftBound, Math.min(bounds.rightBound,
    miniDragStartXShared.value + event.translationX))
  miniPipY.value = Math.max(bounds.topBound, Math.min(bounds.bottomBound,
    miniDragStartYShared.value + event.translationY))
  return
}
```

---

### 8. Replace `dynMiniWidth` computation (line 348)

Current: `const dynMiniWidth = Math.min(Math.round(MINI_PIP_HEIGHT * effectiveAR), MINI_PIP_WIDTH)`

This inverts the spec's model (it derives width from a fixed height). Replace with:

```ts
const { width: dynMiniWidth, height: dynMiniHeight } = computeMiniSize(screenWidth, effectiveAR)
```

Add `dynMiniHeight` and propagate it:
- `miniPipDynWidthShared` continues to mirror `dynMiniWidth`
- Add `miniPipDynHeightShared = useSharedValue(dynMiniHeight)` and sync it alongside `miniPipDynWidthShared`
- All places that reference `MINI_PIP_HEIGHT` in worklets should use `miniPipDynHeightShared.value` instead

**Affected locations in `VideoPlayerOverlayImpl.tsx`:**
- Line 1098: `maxY` clamp in `onUpdate` → replaced by §7 above
- Line 1113: `totalDistance` for drag-to-minimize progress → use `miniPipDynHeightShared.value`
- Line 1126: `bottomY` in `onEnd` → replaced by §4 above
- Line 1264: height interpolation in animated style → use `miniPipDynHeightShared.value`
- Line 1353: `miniScale` for fullscreen→mini scale → use `dynMiniWidth` (already correct, just comes from new source)
- Line 1410: another height interpolation → use `miniPipDynHeightShared.value`

**Affected locations in `useVideoGestures.ts`:** Lines 91–94, 122, 141–143, 157, 161–162 all reference `MINI_PIP_WIDTH` / `MINI_PIP_HEIGHT`. These need the same treatment — pass `miniPipDynWidthShared` and `miniPipDynHeightShared` into the hook's props and use `.value` in worklets.

**Affected location in `styles.ts`:** Lines 421, 424, 446 use `MINI_PIP_WIDTH`/`MINI_PIP_HEIGHT` for static StyleSheet styles. These are the info strip / controls strip below the mini player. They should become dynamic (either `useAnimatedStyle` driven or passed as props). However, since phase 1 does NOT redesign mini controls, we can keep these as approximate static sizes and fix them in a later phase. Alternatively, set them to `MINI_PIP_WIDTH_MAX` and `MINI_PIP_WIDTH_MAX / (16/9)` as safe upper bounds.

---

### 9. Shadow / visual tuning in animated styles

The existing animated container style (around line 1280+) already interpolates `borderRadius`. Update it:

- Change `MINI_PIP_CORNER_RADIUS` interpolation endpoint from `8` to `16` (already handled by the constant change)
- Add `shadowOpacity`, `shadowRadius`, `shadowOffset` interpolation keyed off `isMiniPlayerDraggingShared`:
  - When dragging: `MINI_SHADOW_DRAGGING` values
  - When docked: `MINI_SHADOW_DOCKED` values
  - Transition between them with a short `withTiming(value, { duration: 150 })` on drag start/end
- Add `transform: [{ scale: isMiniPlayerDraggingShared.value ? MINI_DRAG_SCALE : 1 }]` — also animated with a short timing

These shadow/scale changes go into the existing `containerStyle` `useAnimatedStyle` block. They only apply when `animProgress` is near 0 (mini mode), so gate them behind `animProgress.value < 0.1`.

---

### 10. Preserve dock corner across fullscreen↔mini cycles

Currently the `useEffect` at line 882 re-snaps to `miniPlayerCorner` whenever `playerMode` changes to `mini`. This already preserves corner — the `miniPlayerCorner` state just needs to survive fullscreen transitions, which it does (it's `useState` in the overlay component, not reset on mode change).

**One fix needed:** When `playerMode` transitions to `mini` (line 886), the snap position must now use responsive geometry:
```ts
const nextPos = getMobileMiniPlayerSnapPosition({
  corner: miniPlayerCorner,
  screenWidth, screenHeight,
  topInset: stableInsetTopRef.current,
  bottomOffset: miniPlayerBottom,
  aspectRatio: effectiveAR,   // new param
})
miniPipX.value = withSpring(nextPos.x, SPRING_CONFIG_TIGHT)
miniPipY.value = withSpring(nextPos.y, SPRING_CONFIG_TIGHT)
miniPipDynWidthShared.value = nextPos.width
miniPipDynHeightShared.value = nextPos.height
```

---

### 11. Summary of changes by file

**`constants.ts`:**
- Replace `MINI_PIP_WIDTH`, `MINI_PIP_HEIGHT` with `MINI_PIP_WIDTH_FRACTION/MIN/MAX`
- Change `MINI_PIP_CORNER_RADIUS` from 8 → 16
- Add `SPRING_CONFIG_MINI_SNAP`
- Add snap constants (`SNAP_LOW_SPEED`, `SNAP_FLING_SPEED`, `SNAP_TOSS_HORIZON`, `SNAP_FLING_HORIZON`, `SNAP_HYSTERESIS_PX`)
- Add visual tuning constants (`MINI_DRAG_SCALE`, `MINI_SHADOW_DOCKED`, `MINI_SHADOW_DRAGGING`)

**`VideoPlayerOverlayImpl.tsx`:**
- Add 4 worklet helpers: `computeMiniSize`, `computeMiniBounds`, `getCornerAnchors`, `resolveSnapTarget`
- Rewrite `getMobileMiniPlayerSnapPosition` internals (add `aspectRatio` param, return `width`/`height`)
- Add shared values: `aspectRatioShared`, `currentDockCornerShared`, `miniPipDynHeightShared`
- Replace `dynMiniWidth` derivation (line 348)
- Replace `panGesture.onUpdate` mini clamp (lines 1094–1101)
- Replace `panGesture.onEnd` mini snap (lines 1119–1137) with projected-snap algorithm
- Update animated style interpolation endpoints for height/radius/shadow
- Update `useEffect` playerMode→mini snap to use responsive geometry

**`useVideoGestures.ts`:**
- Accept `miniPipDynWidthShared` and `miniPipDynHeightShared` as props
- Replace all `MINI_PIP_WIDTH`/`MINI_PIP_HEIGHT` references with shared value reads
- (The snap logic here is a secondary code path — if it's actually used on some platform, apply the same `resolveSnapTarget` algorithm)

**`styles.ts`:**
- Defer to phase 2. Use `MINI_PIP_WIDTH_MAX` as static fallback for now.

---

### 12. What this does NOT touch (phase 1 boundary)

- No dismiss gesture changes (keep existing horizontal swipe dismiss as-is)
- No PiP continuity changes
- No mini-player control redesign
- No rubber-band overshoot (hard clamp only)
- No `playerStateMachine.ts` changes
- No new interaction states (the numeric enum from the spec is deferred)

## Discussion

## Codex Review

The proposal is directionally solid on geometry and velocity-based snapping, but it overreaches for phase 1. It spreads the change across constants, shared values, gesture code, and style behavior instead of minimizing the first pass inside `VideoPlayerOverlayImpl.tsx`, which increases regression surface before the new snap model is proven.

Top 3 phase 1 risks in `VideoPlayerOverlayImpl.tsx`:
1. UI-thread state drift: `miniPlayerCorner`, `currentDockCornerShared`, `aspectRatioShared`, and dynamic mini dimensions can fall out of sync during rotate/mode transitions and cause snaps to the wrong corner.
2. Bounds math regressions: combining `insetTop`, `insetBottom`, and `miniPlayerBottom` inside new worklet helpers is easy to get subtly wrong, especially near tab bar / safe-area edges.
3. Partial responsive migration: replacing fixed mini-player geometry in overlay logic without fully aligning every dependent interpolation and gesture path can produce mismatched hit areas, drag limits, or height animations.
