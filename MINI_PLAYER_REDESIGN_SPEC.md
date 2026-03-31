# PearTube Mini Player Redesign Spec

Status: implementation-ready
Scope: mobile React Native app (`packages/app`), using `react-native-reanimated` + `react-native-gesture-handler`
Decision: implement the mini player as one persistent player surface with rect-driven transitions, 4-corner docking, velocity-biased snap, deliberate downward dismiss, and PiP continuity.

## 1. UX goals

1. The player must feel like one persistent object across fullscreen, mini, drag, dismiss, and PiP handoff.
2. Fullscreen -> mini and mini -> fullscreen must animate the same playback surface. No visual remount, no crossfade between separate player trees, no teleport.
3. Slow drag-and-drop should feel precise and calm.
4. Fast flicks, including diagonal flicks, should express corner intent and land predictably.
5. Docked mini player should feel stable and exact in all four corners.
6. Primary close model should be the explicit X button. Gesture dismissal is optional future work, not required for the target experience.
7. PiP enter/exit should preserve the user’s sense of where the player “lives” in-app.
8. All transitions must be interruptible and state-driven, not timing-hack driven.

## 2. State model

Use two layers of state.

### 2.1 Semantic JS state

Keep the existing PearTube semantic state machine in `packages/app/lib/playerStateMachine.ts`:
- `hidden`
- `loading`
- `fullscreen`
- `mini`
- `pip_entering`
- `pip_active`
- `pip_exiting`

Do not add a second independent JS player mode system.

Add persistent mini-player context stored alongside existing player state or in overlay-local state:
- `lastDockCorner: 'tl' | 'tr' | 'bl' | 'br'`
- `lastMiniRect: { x: number; y: number; width: number; height: number } | null`
- `currentAspectRatio: number`
- `miniReturnTarget: 'mini' | 'fullscreen'` for PiP exit restoration
- `sourceFullscreenRect: Rect | null` captured from measurement before minimize

Default `lastDockCorner = 'br'`.

### 2.2 UI-thread interaction state

Keep motion state on the UI thread with a numeric enum shared value:
- `0 idle`
- `1 transitioning`
- `2 dragging`
- `3 snapping`
- `4 dismissing`

UI-thread shared values:
- `playerX`
- `playerY`
- `playerWidth`
- `playerHeight`
- `transitionProgress` where `0 = fullscreen`, `1 = mini`
- `dragScale`
- `cornerRadius`
- `shadowOpacity`
- `shadowRadius`
- `dockCornerSV`
- `isMiniVisible`

Rule: JS owns semantic mode; Reanimated owns per-frame geometry and gesture resolution.

## 3. Geometry

### 3.1 Mini size

Use responsive mini size derived from viewport width.

Phone mini width:
- `miniWidth = clamp(round(screenWidth * 0.36), 168, 220)`

Mini height:
- `miniHeight = round(miniWidth / aspectRatio)`
- `aspectRatio = currentVideoAspectRatio || 16 / 9`

Notes:
- Keep live video aspect ratio if known.
- Recompute on aspect-ratio change, orientation change, safe area change, or bottom chrome change.
- Replace the current fixed mobile `240 x 135` assumption with this responsive model.

### 3.2 Insets and margins

Base spacing:
- horizontal margin: `12`
- top margin: `safeArea.top + 12`
- bottom margin: `max(safeArea.bottom + 12, tabBarHeight + safeArea.bottom + 12, transientBottomChromeHeight + 12)`

If a toast, bottom sheet, CTA, or temporary bottom chrome overlaps the docking area, add its occupied height into `transientBottomChromeHeight`.

### 3.3 Legal mini bounds

Let:
- `leftBound = safeArea.left + 12`
- `rightBound = screenWidth - safeArea.right - 12 - miniWidth`
- `topBound = safeArea.top + 12`
- `bottomBound = screenHeight - bottomMargin - miniHeight`

### 3.4 Anchor positions

Four anchors are exact legal top-left positions:
- `TL = { x: leftBound,  y: topBound }`
- `TR = { x: rightBound, y: topBound }`
- `BL = { x: leftBound,  y: bottomBound }`
- `BR = { x: rightBound, y: bottomBound }`

Default entry corner: `BR`, unless `lastDockCorner` is still valid for the new bounds.

### 3.5 Visual styling

Mini card values:
- corner radius: `16`
- drag scale: `0.985`
- drag shadow opacity: `0.22`
- docked shadow opacity: `0.18`
- shadow radius docked: `14`
- shadow radius dragging: `18`
- shadow Y offset docked: `4`
- shadow Y offset dragging: `6`
- hit slop around visible card: `10`

Fullscreen radius should animate from current fullscreen container radius to `16` as `transitionProgress` approaches mini.

## 4. Transition behavior

## 4.1 Fullscreen -> mini

Animation source:
- measure the current fullscreen player rect in window coordinates before minimize
- animate from that rect to the target mini anchor rect

Animation model:
- one animated container
- interpolate `x`, `y`, `width`, `height`, `radius`, and shadow from source rect to target mini rect
- fade fullscreen controls out early and mini controls in late

Control timing:
- fullscreen controls fade to 0 over first `100ms` equivalent of progress
- mini controls begin fade-in at `transitionProgress = 0.60`
- mini controls fully visible by `transitionProgress = 0.90`

Transition spring:
- stiffness `300`
- damping `32`
- mass `1.0`
- restDisplacementThreshold `0.5`
- restSpeedThreshold `4`

Target feel:
- effective duration should read as about `260ms`
- transition must be interruptible at any point

## 4.2 Mini -> fullscreen

Reverse the same rect interpolation from current mini rect to measured fullscreen rect.

Expand spring:
- stiffness `320`
- damping `32`
- mass `1.0`
- restDisplacementThreshold `0.5`
- restSpeedThreshold `4`

Rules:
- expansion must originate from the current actual mini rect, not a default corner rect
- shadow reduces continuously to fullscreen
- radius animates back to fullscreen radius

## 5. Drag behavior

Use `Gesture.Pan()` from RNGH.

### 5.1 On start

- cancel active x/y springs
- cache `dragStartX`, `dragStartY`
- set interaction state to `dragging`
- set `dragScale` to `0.985`
- raise shadow to dragging values

### 5.2 On update

Follow finger 1:1 inside an overshoot envelope.

Overshoot envelope:
- horizontal overshoot: `24`
- top overshoot: `16`
- bottom overshoot while not dismissing: `16`
- bottom overshoot when dismiss is enabled: `96`

Recommended behavior:
- use hard clamp within overshoot envelope for first implementation
- do not add complex elastic rubber-band math in v1
- always resolve overshoot on release via snap or dismiss

Update equations:
- `x = clamp(dragStartX + translationX, leftBound - 24, rightBound + 24)`
- `y = clamp(dragStartY + translationY, topBound - 16, bottomBound + dismissOvershoot)`

### 5.3 During drag affordances

- visible card stays full size except `scale = 0.985`
- controls remain stable; do not reflow layout during drag
- no tilt in v1
- close button can increase opacity slightly as `y` approaches bottom dismiss zone

## 6. 4-corner snap algorithm

This is the final algorithm.

### 6.1 Inputs

At gesture end read:
- `releaseX = playerX.value`
- `releaseY = playerY.value`
- `vx = velocityX`
- `vy = velocityY`
- `speed = hypot(vx, vy)`

All calculations use top-left positions, but corner selection is based on card center distance.

### 6.2 Velocity regimes

- low velocity: `speed < 500 px/s`
- toss: `500 <= speed < 1400 px/s`
- fling: `speed >= 1400 px/s`

Projection horizon:
- low velocity: `0`
- toss: `0.18s`
- fling: `0.22s`

### 6.3 Projected target point

- `targetX = releaseX + vx * horizon`
- `targetY = releaseY + vy * horizon`

Clamp target point to legal bounds:
- `targetX = clamp(targetX, leftBound, rightBound)`
- `targetY = clamp(targetY, topBound, bottomBound)`

If `horizon = 0`, use current release point.

### 6.4 Anchor scoring

Compute target card center:
- `targetCenterX = targetX + miniWidth / 2`
- `targetCenterY = targetY + miniHeight / 2`

For each anchor, compute anchor center and score by squared Euclidean distance:
- `score = (anchorCenterX - targetCenterX)^2 + (anchorCenterY - targetCenterY)^2`

Choose the anchor with the lowest score.

### 6.5 Slow-release hysteresis

To prevent twitchy corner changes on gentle drops:
- if `speed < 500` and current dock corner score is within `24px` center-distance equivalent of the best score, keep the current dock corner

Implementation note:
- compare actual center distance, not squared score, for the `24px` hysteresis threshold

### 6.6 Snap output

Snap target is the exact chosen anchor top-left.

After snap commit:
- update `lastDockCorner`
- update `lastMiniRect`
- set interaction state back to `idle`

### 6.7 Why this algorithm is final

This projected-distance algorithm is preferred over quadrant splitting because it:
- supports diagonal fling naturally
- stays stable near center
- avoids arbitrary row/column switching rules
- can run fully in the gesture end worklet without JS latency

## 7. Spring configs

Use these exact spring configs.

### 7.1 Snap spring

For mini corner docking:
- stiffness `340`
- damping `30`
- mass `0.9`
- restDisplacementThreshold `0.5`
- restSpeedThreshold `4`
- overshootClamping `false`

Pass release velocity through to both `x` and `y` springs.

### 7.2 Fullscreen <-> mini rect spring

For object continuity transitions:
- stiffness `300`
- damping `32`
- mass `1.0`
- restDisplacementThreshold `0.5`
- restSpeedThreshold `4`

### 7.3 Cancel-dismiss spring

If dismiss is not committed:
- stiffness `360`
- damping `32`
- mass `0.9`
- restDisplacementThreshold `0.5`
- restSpeedThreshold `4`

## 8. Close behavior

Phase-1 recommendation: use the explicit X button as the only close affordance.

Why:
- avoids accidental dismissals during diagonal flings
- keeps the motion system focused on move/snap/maximize
- matches the user's preference for a simpler, more predictable mini player
- reduces gesture competition while mini-player drag polish is still being tuned

Implementation guidance:
- keep the close button always visible in mini mode
- close button remains the sole dismissal path in v1
- do not implement swipe-to-dismiss in phase 1 or phase 2 unless later user testing shows a strong need

Future option (not recommended by default):
- a downward dismiss gesture can be prototyped behind a feature flag, but should not be part of the baseline redesign spec

## 9. Control layout and visual polish

The mini player should feel like a premium floating object, not a reduced fullscreen layout.

### 9.1 Resting mini-player chrome

Visible at rest:
- video surface
- close button (top-right)
- optional title strip only if we decide discoverability needs it later; default off in v1

Hidden at rest:
- progress bar
- timestamps
- playback speed
- cast
- fullscreen controls

The mini player should look almost content-only when idle.

### 9.2 Tap and double-tap behavior

Single tap on mini player:
- reveal mini-player controls / close affordance if hidden
- should not maximize by default

Double tap on mini player:
- maximize to fullscreen
- thresholds:
  - max delay between taps: `240ms`
  - max movement per tap: `16px`

Long-press is reserved; do not add a long-press menu in v1.

### 9.3 Close button

Close button geometry:
- container size: `28 x 28`
- hit target: `36 x 36`
- top inset inside card: `8`
- right inset inside card: `8`
- background: `rgba(0,0,0,0.48)`
- icon size: `14`
- icon color: `rgba(255,255,255,0.92)`
- radius: `14`

Close button behavior:
- always visible in mini mode
- fades slightly brighter on hover/press equivalent
- remains visually pinned while dragging (do not reflow)

### 9.4 Shadow and depth

Dramatic shadow changes are part of the premium feel.

Docked:
- shadowOpacity: `0.18`
- shadowRadius: `14`
- shadowOffsetY: `4`
- elevation: `10`

Dragging:
- shadowOpacity: `0.24`
- shadowRadius: `18`
- shadowOffsetY: `6`
- elevation: `14`

Fullscreen transition:
- shadow falls toward `0`
- radius falls toward fullscreen radius

### 9.5 Motion choreography

The motion should read as one object moving between containers.

Fullscreen -> mini choreography:
1. fullscreen overlay controls fade out first (`80–100ms`)
2. player rect begins translating/scaling immediately
3. mini close button fades in only after `transitionProgress >= 0.70`
4. shadow/radius animate continuously with rect

Mini -> fullscreen choreography:
1. mini close button fades out by `transitionProgress <= 0.35`
2. object expands and translates to fullscreen rect
3. fullscreen controls begin appearing after `transitionProgress <= 0.30`
4. do not crossfade between two player surfaces

## 10. PiP continuity rules

PiP should feel like the same player continuing, not a new mode.

### 10.1 Entry rules

If app backgrounds from fullscreen:
- remember `miniReturnTarget = 'fullscreen'`

If app backgrounds from mini:
- remember `miniReturnTarget = 'mini'`
- remember `lastDockCorner`
- remember `lastMiniRect`

### 10.2 Return rules

On PiP exit back into app:
- if `miniReturnTarget === 'mini'`, restore mini player immediately at `lastMiniRect` / `lastDockCorner`
- if `miniReturnTarget === 'fullscreen'`, restore fullscreen immediately
- do not restore to a default mini corner unless bounds changed enough to invalidate the old one

### 10.3 Invalidating stored mini rect

Recompute and clamp `lastMiniRect` if:
- orientation changed
- safe area changed materially
- tab bar height changed materially
- screen width class changed

Otherwise preserve it exactly.

## 11. PearTube implementation mapping

Map the spec onto current code instead of building a second system.

### 11.1 Existing code to reuse

In `VideoPlayerOverlayImpl.tsx` we already have:
- `miniPipX`, `miniPipY`
- `miniPipDynWidthShared`
- `miniDragStartXShared`, `miniDragStartYShared`
- `miniPlayerCorner`
- `isMiniPlayerDraggingShared`
- `getMobileMiniPlayerSnapPosition(...)`
- `SPRING_CONFIG_TIGHT`

These should remain the core primitives.

### 11.2 Existing behavior to replace

Replace:
- center-of-screen heuristic only (`isRight` / `isBottom` based on midpoint)
- current simple nearest quadrant snap in `panGesture.onEnd`

With:
- projected-point corner selection from section 6
- velocity-aware snap
- hysteresis to avoid accidental corner flips

### 11.3 Existing geometry to replace

Replace fixed assumptions around:
- `MINI_PIP_WIDTH`
- `MINI_PIP_HEIGHT`

With responsive geometry derived from section 3.

### 11.4 Existing transition path to keep

Keep the current single-surface mental model:
- same overlay/player object animates between fullscreen and mini
- do not introduce a second React subtree for the mini player

## 12. Phase 1 implementation plan

Phase 1 scope is intentionally narrow:
1. responsive mini geometry
2. 4-corner snap targets
3. projected-point fling selection
4. diagonal fling support
5. preserved dock corner
6. stronger drag/docked shadow/radius tuning

Do NOT include in phase 1:
- dismiss gesture
- PiP continuity refactor
- mini-player special controls redesign
- title strip
- advanced rubber banding

### 12.1 Concrete coding steps

1. Create a `resolveMiniPlayerMetrics(...)` helper returning:
   - width
   - height
   - bounds
   - anchors
2. Replace `getMobileMiniPlayerSnapPosition(...)` internals with the new geometry helper
3. Replace `panGesture.onEnd` mini branch with:
   - projected point computation
   - anchor scoring
   - hysteresis
   - spring to selected anchor
4. Update `miniPlayerCorner` writes so they always reflect selected anchor
5. Tune `SPRING_CONFIG_TIGHT` or create a dedicated `SPRING_CONFIG_MINI_SNAP`
6. Preserve `miniPipX/Y` across fullscreen <-> mini transitions

## 13. Acceptance criteria

The redesign is successful when all are true:
- mini player can be docked in all 4 corners
- slow release snaps to nearest corner predictably
- fast diagonal fling can land diagonally
- mini player never clips under safe area or tab bar
- no jump when drag begins
- no teleport when snapping
- fullscreen -> mini and mini -> fullscreen feel like the same object moving
- repeated minimize/restore cycles preserve last dock corner
- PiP handoff still works with same active player

## 14. Optional phase 2 improvements

After phase 1 is stable:
- downward dismiss gesture
- slight elastic overshoot near bounds
- close button opacity adaptation during dismiss
- optional title strip or quick controls
- persistence of dock corner across app relaunches
- subtle haptic on corner snap

### 8.3 Cancel path

If dismiss conditions are not met:
- run normal snap algorithm
- spring to chosen anchor with snap spring

### 8.4 Safety rule

Diagonal flicks to a top corner or opposite side must never accidentally dismiss unless the bottom-edge thresholds above are met.

## 9. PiP continuity

PiP behavior must preserve semantic location and return path.

### 9.1 Entering PiP

Before PiP activation, capture:
- current semantic mode (`fullscreen` or `mini`)
- current visible rect
- current `lastDockCorner`
- current `lastMiniRect`

If entering PiP from mini:
- mini rect is the source of truth

If entering PiP from fullscreen:
- fullscreen rect is the source of truth
- if Android/iOS platform hooks permit, visually animate app chrome toward the PiP handoff impression before the system takes ownership

### 9.2 While PiP is active

- semantic JS mode remains `pip_active`
- keep last committed in-app rect and corner stored
- do not clear `lastDockCorner` during PiP

### 9.3 Exiting PiP back into app

On return:
- if restore target is mini, restore to `lastMiniRect` if still valid; otherwise recompute from `lastDockCorner`
- if restore target is fullscreen, animate from remembered PiP-origin impression / last mini rect into measured fullscreen rect
- if bounds changed during PiP, preserve corner identity, not absolute pixels

### 9.4 Semantic rule

PiP should feel like the same object left the app and came back; the player should not reappear in a different corner unless bounds invalidated the prior rect.

## 10. Reanimated / PearTube implementation notes

### 10.1 Architecture

Implement inside the existing overlay/player stack rather than creating a second mobile mini player implementation.

Target integration points:
- `packages/app/components/VideoPlayerOverlayImpl.tsx`
- `packages/app/components/video-player/constants.ts`
- `packages/app/lib/VideoPlayerContext.tsx`
- `packages/app/lib/playerStateMachine.ts` only if new persistent mini metadata needs to be stored there

### 10.2 Core design

1. Keep one playback surface mounted.
2. Surround it with one animated container whose rect is driven by shared values.
3. Derive `x`, `y`, `width`, `height`, `radius`, shadow, and overlay opacity from a unified rect model.
4. Compute snap target inside the gesture end worklet, not in JS.
5. Use `runOnJS` only to commit semantic side effects after snap/dismiss/expand completes.

### 10.3 Required shared values / derived values

Shared values:
- bounds inputs: screen width, screen height, safe area, tab bar height, transient bottom chrome height, aspect ratio
- current rect: `playerX`, `playerY`, `playerWidth`, `playerHeight`
- `transitionProgress`
- `dockCornerSV`
- `interactionStateSV`
- `lastCommittedMiniX`, `lastCommittedMiniY`, `lastCommittedMiniWidth`, `lastCommittedMiniHeight`

Derived worklets:
- `computeMiniSize(screenWidth, aspectRatio)`
- `computeMiniBounds(window, insets, tabBarHeight, transientBottomChromeHeight, aspectRatio)`
- `getCornerAnchors(bounds)`
- `getAnchorCenters(anchors, miniWidth, miniHeight)`
- `nearestCornerForPoint(point, anchors)`
- `resolveSnapTarget(releasePosition, velocity, bounds, currentCorner)`
- `shouldDismiss(releasePosition, velocity, bounds)`

### 10.4 Interruptibility rules

- minimize interrupted by maximize: reverse from current rect/progress
- maximize interrupted by minimize: reverse from current rect/progress
- drag is disabled while `transitionProgress < 0.90` during fullscreen -> mini transition
- once mini geometry is at least 90% settled, user may take over with drag
- do not allow mixed fullscreen-transition + drag math simultaneously in v1

### 10.5 Layout change rules

On orientation, inset, tab bar, or aspect-ratio changes while in mini:
- recompute mini size and bounds
- preserve `lastDockCorner`
- spring to the anchor for that corner in the new bounds
- do not preserve stale absolute x/y if it would place the player mid-screen or off-screen

### 10.6 Constants update

Current mobile constants in `packages/app/components/video-player/constants.ts` are not the target behavior.

Replace fixed assumptions with spec-driven values:
- fixed `MINI_PIP_WIDTH` / `MINI_PIP_HEIGHT` should become derived mobile mini size
- `MINI_PIP_MARGIN = 12` remains valid
- `MINI_PIP_CORNER_RADIUS` should change to `16`
- spring configs should be updated to the values in this spec
- current swipe dismiss thresholds should be replaced by the dismiss rules in this spec

## 11. Implementation plan

### Phase 1: single-surface continuity

1. Refactor mobile mini geometry into derived bounds/anchors instead of fixed width/height constants.
2. Keep one player surface mounted during fullscreen <-> mini.
3. Measure fullscreen source rect and animate into target mini rect.
4. Store `lastDockCorner` and `lastMiniRect`.
5. Update constants and shared values for rect-driven motion.

### Phase 2: 4-corner drag and snap

1. Implement pan gesture on the mini player container.
2. Add overshoot envelope and drag affordances.
3. Implement worklet-side snap resolution using projected target point.
4. Add hysteresis for slow releases.
5. Persist last successful dock corner.

### Phase 3: dismiss polish

1. Implement bottom-edge dismiss commit logic.
2. Add cancel-dismiss spring path.
3. Fade controls/shadow correctly during dismiss.
4. Verify diagonal flings do not accidentally dismiss.

### Phase 4: PiP continuity

1. Capture source rect and corner on PiP entry.
2. Restore mini/fullscreen from remembered semantic location on PiP exit.
3. Handle orientation/safe-area changes while PiP was active.
4. Add analytics for snap target distribution, dismiss cancels, and accidental-close rate if desired.

## 12. Acceptance criteria

1. Fullscreen -> mini uses one visual player surface and never visibly remounts or teleports.
2. Mini -> fullscreen expands from the exact current mini rect in the current corner.
3. Mini player docks cleanly and repeatably in all four corners.
4. Slow releases under `500 px/s` favor nearest corner and do not feel twitchy.
5. Fast diagonal flicks at `>= 500 px/s` reliably reach the intended corner using projected release math.
6. Strong flings at `>= 1400 px/s` feel more momentum-aware without becoming chaotic.
7. After any successful snap, the next programmatic minimize returns to the last used corner unless bounds invalidated it.
8. Dismiss only occurs when `releaseY > bottomBound + 56` or `vy > 1100` near the bottom edge.
9. Horizontal or diagonal snap gestures do not accidentally dismiss.
10. PiP entry and exit preserve corner semantics and last committed mini location.
11. Orientation, inset, tab bar, and aspect-ratio changes keep the mini player on-screen and anchored to the same semantic corner.
12. All transitions are interruptible and do not rely on fixed timeout sequencing.

## 13. Final defaults summary

- default dock corner: `br`
- mini width: `clamp(round(screenWidth * 0.36), 168, 220)`
- mini height: `round(miniWidth / aspectRatio)`
- margins: `12 + safe area + bottom chrome`
- mini corner radius: `16`
- low-speed release: nearest corner from current position
- toss release: projected corner using `0.18s` horizon
- fling release: projected corner using `0.22s` horizon
- low-speed threshold: `500 px/s`
- fling threshold: `1400 px/s`
- snap spring: `stiffness 340, damping 30, mass 0.9`
- transition spring: `stiffness 300, damping 32, mass 1.0`
- dismiss commit: `releaseY > bottomBound + 56` or `vy > 1100` near bottom
- dismiss off-screen timing: `180ms ease-out`

This is the final spec to implement.