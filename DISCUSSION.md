# Task: Mini player phase 2 — smoothness polish + double-tap maximize

## Current status
Phase 1 mini player redesign is in and working well:
- 4-corner snap
- velocity-biased fling
- diagonal fling support
- larger mini player

## User feedback
- Snap/fling behavior is great
- But it still doesn't feel as smooth/premium as YouTube's mini player
- Hard to articulate exactly why, but likely motion/continuity polish
- User wants double-tap on the mini player to make it larger / maximize, similar to native PiP behavior
- User does NOT want swipe-to-dismiss as a required behavior; X close is sufficient

## Goals for this phase
1. Improve the overall feel / smoothness of mini-player motion
2. Add double-tap-to-maximize on mini player
3. Continue preserving object continuity between fullscreen <-> mini
4. Avoid adding dismiss gesture complexity

## Likely areas for polish
- spring tuning (current snap may feel too stiff or robotic)
- drag-lift treatment (scale/shadow) may need to be more subtle / premium
- release snap could benefit from slightly better velocity passthrough or settle tuning
- fullscreen->mini and mini->fullscreen choreography may need more consistent timing
- dock snap may need softer arrival / less abrupt final settle
- visual continuity: radius/shadow/scale may not be transitioning smoothly enough

## Existing implementation locations
- `packages/app/components/VideoPlayerOverlayImpl.tsx`
  - helpers: computeMiniSize, computeMiniBounds, getCornerAnchors, resolveSnapTarget
  - pan gesture mini-player branch
  - shared values for miniPipX/Y, miniPipDynWidth/Height, currentDockCornerShared
  - current springs use SPRING_CONFIG_MINI_SNAP from constants.ts
- `packages/app/components/video-player/constants.ts`
  - SPRING_CONFIG_MINI_SNAP
  - MINI_DRAG_SCALE
  - MINI_SHADOW_DOCKED / MINI_SHADOW_DRAGGING

## Need from discussion
1. What specific motion values would make this feel smoother / more YouTube-like?
2. Should snap spring be softer? More damping? Less stiffness? Velocity clamped?
3. Should fullscreen<->mini use a different spring from corner snap?
4. Best implementation for double-tap maximize in RN Gesture Handler without conflicting with drag and single tap behavior
5. Any simple visual polish changes that improve smoothness perception without redesigning controls

## Constraints
- Keep 4-corner snap/f fling behavior
- No dismiss gesture in this phase
- Double tap should only maximize from mini mode
- Don't destabilize PiP

## Discussion

## Codex Proposal

### 1. Split the motion model into two springs instead of reusing one snap spring everywhere
Use different springs for:

- mini corner docking after drag release
- fullscreen <-> mini layout choreography / maximize transition

Reason: dock settle should feel soft and catch the window, while fullscreen <-> mini continuity should feel tighter and more intentional.

Recommended values:

```ts
export const SPRING_CONFIG_MINI_SNAP = {
  damping: 34,
  stiffness: 255,
  mass: 0.92,
  restDisplacementThreshold: 0.35,
  restSpeedThreshold: 2.2,
  overshootClamping: false,
}

export const SPRING_CONFIG_MINI_EXPAND = {
  damping: 30,
  stiffness: 300,
  mass: 0.95,
  restDisplacementThreshold: 0.25,
  restSpeedThreshold: 1.8,
  overshootClamping: false,
}
```

Why these numbers versus current `damping: 30, stiffness: 340, mass: 0.9`:
- `340` stiffness is likely causing the last 10-15% of travel to feel robotic and abrupt
- raising damping slightly while lowering stiffness makes arrival less "magnetic"
- lower rest thresholds reduce visible micro-jitter at the end of settle
- keeping overshoot enabled preserves a subtle premium bounce, but with the softer spring it should stay controlled

If this still feels too tight on device, reduce snap stiffness once more to `240` before touching damping.

### 2. Improve release velocity handling before passing velocity into `withSpring`
Current code passes raw gesture velocity directly:

```ts
miniPipX.value = withSpring(snap.x, { ...SPRING_CONFIG_MINI_SNAP, velocity: event.velocityX })
miniPipY.value = withSpring(snap.y, { ...SPRING_CONFIG_MINI_SNAP, velocity: event.velocityY })
```

That is directionally correct, but raw velocity creates two polish issues:
- large fling values can make near-corner releases feel too aggressive
- the chosen snap corner may be correct, but the incoming spring energy can still overshoot more than desired

Recommended handling:
1. continue using raw velocity for target resolution
2. clamp the velocity that is injected into the spring
3. zero out velocity on an axis when the target delta on that axis is very small
4. optionally attenuate cross-axis velocity when one axis dominates the snap

Suggested worklet helper:

```ts
const clampSpringVelocity = (velocity: number, delta: number) => {
  'worklet'
  if (Math.abs(delta) < 10) return 0
  return Math.max(-1800, Math.min(1800, velocity))
}
```

Then on release:

```ts
const dx = snap.x - miniPipX.value
const dy = snap.y - miniPipY.value

const springVX = clampSpringVelocity(event.velocityX, dx)
const springVY = clampSpringVelocity(event.velocityY, dy)

miniPipX.value = withSpring(snap.x, { ...SPRING_CONFIG_MINI_SNAP, velocity: springVX })
miniPipY.value = withSpring(snap.y, { ...SPRING_CONFIG_MINI_SNAP, velocity: springVY })
```

Optional refinement for diagonal flings:

```ts
const dominantX = Math.abs(dx) > Math.abs(dy) * 1.25
const dominantY = Math.abs(dy) > Math.abs(dx) * 1.25

const springVX = clampSpringVelocity(
  dominantY ? event.velocityX * 0.7 : event.velocityX,
  dx,
)
const springVY = clampSpringVelocity(
  dominantX ? event.velocityY * 0.7 : event.velocityY,
  dy,
)
```

This keeps fling-biased corner choice intact, but makes the settle feel intentional rather than chaotic.

### 3. Add a short "lift" animation state that is subtler than the current drag treatment
Current visual treatment is already close, but slightly too static for a premium feel.

Recommended constant tweaks:

```ts
export const MINI_DRAG_SCALE = 0.992
export const MINI_SHADOW_DOCKED = { opacity: 0.16, radius: 12, offsetY: 3, elevation: 8 }
export const MINI_SHADOW_DRAGGING = { opacity: 0.20, radius: 16, offsetY: 5, elevation: 12 }
```

Reasoning:
- `0.985` scale reads as a stronger press than necessary for a floating mini player
- a smaller scale delta feels more expensive and less "button-like"
- slightly reduced docked/draggable shadow spread lowers the perception of sudden state switching

Also animate the drag visual state with a timing curve rather than switching instantly from boolean state if feasible:
- 90ms in on drag start
- 110ms out on release

That tiny continuity improvement is often perceived as "smoother physics" even though it is visual.

### 4. Robust RNGH composition for drag + single tap + double tap without conflicts
For phase 2, use three explicit gestures and compose them so tap recognition happens only in mini mode, while pan remains available everywhere it already is.

Recommended structure:

```ts
const singleTapGesture = Gesture.Tap()
  .enabled(isMiniPlayerMode && !isInPipMode)
  .maxDuration(220)
  .maxDistance(8)
  .numberOfTaps(1)
  .onEnd((_event, success) => {
    'worklet'
    if (!success) return
    runOnJS(handleMiniSingleTap)()
  })

const doubleTapGesture = Gesture.Tap()
  .enabled(isMiniPlayerMode && !isInPipMode)
  .maxDuration(220)
  .maxDelay(220)
  .maxDistance(8)
  .numberOfTaps(2)
  .onEnd((_event, success) => {
    'worklet'
    if (!success) return
    runOnJS(maximizePlayer)()
  })

singleTapGesture.requireExternalGestureToFail(doubleTapGesture)
```

Then compose taps exclusively against each other, and race the tap cluster against pan:

```ts
const miniTapGesture = Gesture.Exclusive(doubleTapGesture, singleTapGesture)
const composedGesture = Gesture.Race(panGesture, miniTapGesture)
```

Why this composition is the safest here:
- `Gesture.Exclusive(doubleTap, singleTap)` ensures single tap waits for double tap failure, so maximize never also triggers single-tap UI toggling
- `Gesture.Race(pan, miniTap)` ensures once the pointer meaningfully moves and pan activates, taps are cancelled automatically
- because `panGesture` already has `.minDistance(12)`, taps with `maxDistance(8)` get a clean dead zone between intent classes
- drag keeps priority once movement is real, but quick taps do not need to wait on pan to fully fail

I would not use `Gesture.Simultaneous` here for the wrapper-level gestures because it makes it easier for tap callbacks to fire after tiny drifts, especially on Android.

### 5. Recommended exact RNGH guardrails
Use these thresholds to avoid accidental conflicts:

- `panGesture.minDistance(12)` keep as-is
- `Tap.maxDistance(8)` for both single and double tap
- `Tap.maxDuration(220)` for both
- `doubleTap.maxDelay(220)`
- `panGesture.maxPointers(1)` keep as-is

Additionally, gate tap handlers with the same state constraints as drag:
- only enabled in mini mode
- disabled when PiP layout is active
- disabled in Android split mode path if that path bypasses normal mini layout
- disabled while `isMiniPlayerDraggingShared.value` is true

If needed, make pan even more deliberate by adding:

```ts
.activeOffsetX([-10, 10])
.activeOffsetY([-10, 10])
```

This is optional because `minDistance(12)` already helps, but it can make tap-vs-drag classification more stable on devices with noisy touch input.

### 6. Tap behavior recommendations
Use tap responsibilities like this:
- single tap on mini player: reveal controls / show affordances only, do not maximize
- double tap on mini player: maximize to fullscreen player

That mirrors user expectation from native PiP-like surfaces and avoids accidental full expansions.

If the current mini player already uses single tap to show controls, preserve that behavior. If it does not, single tap can be a no-op in phase 2; the important part is that it must not interfere with double tap.

### 7. Maximize choreography should not reuse the mini snap spring
When double tap triggers maximize, use the dedicated expand spring or a short timing + spring handoff:
- layout progress to fullscreen: `withSpring(...SPRING_CONFIG_MINI_EXPAND)`
- avoid injecting tap velocity into this transition
- keep border radius/shadow fading tied to the same progress value as size/position

For perceived continuity, radius and shadow should finish slightly before controls fully settle. A good rule:
- geometry spring drives bounds
- controls fade/translate over 140-180ms
- shadow/radius interpolate directly from the same geometry progress

### 8. Minimal code-shape recommendation in `VideoPlayerOverlayImpl.tsx`
Current file has:

```ts
const composedGesture = panGesture
```

Phase 2 should become conceptually:

```ts
const miniSingleTapGesture = ...
const miniDoubleTapGesture = ...
const miniTapGesture = Gesture.Exclusive(miniDoubleTapGesture, miniSingleTapGesture)
const composedGesture = Gesture.Race(panGesture, miniTapGesture)
```

Important: keep the existing pan worklet path unchanged for fullscreen drag-to-minimize and mini drag/snap. Only wrap it with the tap composition. That gives the feature without destabilizing PiP or the existing snap logic.

### 9. Lowest-risk implementation order
1. tune snap spring + velocity clamping
2. soften drag scale/shadow values
3. add double tap with `Exclusive(doubleTap, singleTap)` and `Race(pan, tapCluster)`
4. only then tune maximize choreography spring separately

This ordering gives the most noticeable feel improvement first, while keeping gesture regressions easy to isolate.

## Claude Proposal

Mini-player phase 2 should optimize for one thing above all: perceived continuity. YouTube feels "premium" less because the card moves faster and more because every property changes together with the same intent. Position, scale, radius, and shadow all begin immediately, settle at slightly different moments, and never look like independent animations fighting each other. PearTube already has good snap logic; what is missing is softer energy management and more coherent visual follow-through.

### 1. Motion principles to copy from YouTube

1. The player should feel slightly "light" while dragging, not rigidly pinned to the finger.
   - Keep the content effectively attached to the finger for translation, but visually communicate lift with a very small scale-down and a cleaner, softer shadow.
   - Avoid exaggerated drag treatment. Premium motion is subtle.

2. Arrival should be soft, not springy in a bouncy way.
   - YouTube does not feel rubbery. It feels confidently damped.
   - The mini player should preserve fling velocity into the snap, but final settle should absorb energy quickly with little or no overshoot.

3. Transition choreography should be asymmetric.
   - Fullscreen -> mini can be slightly more expressive because the user is collapsing a large surface into a smaller object.
   - Mini -> fullscreen should be faster and more direct, especially for double-tap. It should feel like an intent-confirming expansion, not a decorative animation.

4. Visual properties should not jump at the end.
   - Radius, shadow, and scale should all interpolate continuously during drag and during mode transitions.
   - If any of those pop at the last 10%, the whole motion feels cheaper even if position is correct.

### 2. Concrete spring/timing recommendations

Use distinct animation configs for three cases. One spring for everything is likely part of why the current behavior feels more mechanical than YouTube.

#### A. Corner snap after drag/fling
This should feel soft, heavily damped, and velocity-aware.

Recommended target config:
- stiffness: 520-580
- damping: 42-48
- mass: 0.9-1.0
- restDisplacementThreshold: 0.5
- restSpeedThreshold: 0.5
- overshootClamping: false if your damping is high enough, true if you still see edge bounce on high-velocity flings

Opinionated default:
- stiffness: 560
- damping: 46
- mass: 0.95

Why: this is softer than a typical snappy card spring but still fast. The important change is relatively high damping so the last 15% of travel does not buzz or wobble. If the current snap feels robotic, it is usually because stiffness is high without enough damping, or because the settle becomes visually static too abruptly.

Velocity handling:
- Pass gesture velocity into the spring, but clamp it before handoff.
- Clamp each axis independently to roughly 2200-2600 px/s.
- If raw velocity is much higher, let target selection use the raw directionality, but feed the spring the clamped value.

Why: target resolution should respect fling intent, but the settle animation should not become harsher just because the release velocity spiked.

#### B. Fullscreen -> mini transition
This should feel slightly more composed and "cinematic" than corner snap.

Recommended target config:
- stiffness: 380-440
- damping: 34-38
- mass: 1.0-1.05

Opinionated default:
- stiffness: 420
- damping: 36
- mass: 1.0

Additional timing guidance:
- Start position/size/radius immediately together.
- Delay shadow reduction by ~16ms at most, or just let it trail through interpolation; do not visibly stage it.
- Total perceived duration should land around 280-320ms depending on distance.

Why: collapsing from fullscreen needs a little more readability. A slightly gentler spring improves object continuity and makes the player feel like a persistent surface, not a layer being teleported.

#### C. Mini -> fullscreen transition
This should be the quickest and least ornamental.

Recommended target config:
- stiffness: 520-620
- damping: 40-46
- mass: 0.95-1.0

Opinionated default:
- stiffness: 580
- damping: 44
- mass: 0.95

Perceived duration target:
- 220-260ms

Why: expansion should feel decisive. If this is too soft, double-tap-to-maximize will feel mushy.

### 3. Drag-lift treatment: scale and shadow

This is the highest-leverage visual polish change.

Current mini-player drag treatment is likely too binary or too strong. YouTube-style polish comes from a tiny lift, not an obvious transform.

Recommended scale behavior:
- Docked scale: 1.0
- Dragging scale: 0.985-0.99
- My recommendation: 0.988

Why smaller, not larger? Because a tiny scale-down during drag makes the card feel like it detached from its dock constraints and entered a composited interaction layer. Scaling up often feels cartoony in this pattern.

Scale timing:
- On gesture begin: animate to drag scale in 90-120ms using timing, not spring
- On release: animate back to 1.0 in 140-180ms, starting immediately as snap begins

Opinionated recommendation:
- withTiming(0.988, { duration: 100 }) on begin
- withTiming(1, { duration: 160 }) on release

Why timing, not spring: the lift treatment should be stable and predictable; tying scale to the same spring as translation often introduces visible micro-wobble.

Recommended shadow behavior:
- Increase shadow during drag, but make it broader and softer rather than much darker.
- Reduce opacity contrast; increase blur/radius more than opacity.

Suggested visual direction:
- Docked: low elevation, compact shadow
- Dragging: +20-30% larger radius, +10-15% offset, +0.04 to +0.06 opacity at most

Example if values are tokenized numerically:
- docked shadow opacity: 0.16
- dragging shadow opacity: 0.21
- docked radius: 12
- dragging radius: 18
- docked y-offset: 4
- dragging y-offset: 6

Why: many implementations try to communicate drag by making the shadow too dark. That reads as heavy rather than premium. YouTube tends to imply lift through softness.

### 4. Radius and edge continuity

If the mini player corner radius changes at all between states, it must interpolate continuously during transitions. Do not snap from fullscreen radius to mini radius near the end.

Recommendation:
- Drive radius from the same normalized progress as width/height during fullscreen <-> mini transitions.
- During free drag between corners, keep radius constant.
- If the mini player has a separate inner content mask and outer container shadow, make sure both radii stay in sync.

Common cheap-looking failure mode:
- outer card radius finishes after content mask radius, exposing a one-frame mismatch
- shadow uses stale bounds for a frame after resize

If present, fixing that can make the whole interaction feel more expensive without changing any visible design tokens.

### 5. Snap feel improvements beyond spring constants

A few interaction rules matter as much as the spring values:

1. Add a tiny magnetic capture near corners.
   - Within ~20-24 px of a corner target, slightly bias target resolution toward that corner even if another corner is marginally closer.
   - This reduces indecisive last-moment target flipping.

2. Avoid abrupt axis deceleration asymmetry.
   - When diagonal fling resolves to a corner, both x and y should settle with coherent damping.
   - If one axis finishes significantly earlier than the other, the card feels like it "hooks" into place rather than gliding in.

3. Freeze target choice on release.
   - Once release resolves a target corner, do not recompute target during spring settle.
   - Re-targeting mid-flight is a major source of non-premium feel.

4. Preserve velocity direction but not chaos.
   - Use velocity for intent and early travel, but let damping dominate the last half of the animation.

### 6. Double-tap-to-maximize behavior

This should be implemented only in mini mode and should feel instant, reliable, and conflict-free.

Behavior spec:
- Double-tap anywhere on the mini player surface maximizes to fullscreen/player-expanded state.
- It should not depend on tapping a specific chrome region.
- It should be disabled during active drag and while the card is settling from a release.
- It should only fire from stable mini mode, not during fullscreen->mini transition mid-flight.

Tap recognition thresholds:
- max delay between taps: 220-250ms
- max movement per tap: 8-10 px
- My recommendation: 240ms and 10 px

Conflict handling with pan:
- Compose the double-tap gesture to fail when pan activates.
- Pan should activate only after movement exceeds a deliberate threshold, e.g. 4-6 px.
- Double-tap should require two successful taps with movement under threshold.

In RNGH terms, the intended relationship is:
- miniPlayerPan is simultaneous with tap gestures only before activation threshold
- doubleTap requires pan to fail once meaningful drag begins
- single tap, if any existing behavior remains, must wait for doubleTap to fail

Practical recommendation:
- Use Gesture.Exclusive(doubleTap, singleTap) if you have a single-tap affordance on mini player
- Then compose that tap group with pan so that pan wins on movement, taps win on stationary interaction
- Guard doubleTap callback with `isMini && !isDragging && !isSettling`

Animation on double-tap maximize:
- Do not use a fade or crossfade.
- Immediately animate mini -> fullscreen using the dedicated expansion spring above.
- Start from the exact current mini bounds, including if the mini player is docked top-right/top-left/bottom-right/bottom-left.
- Restore scale to 1.0 first if the card is in drag-lift state, ideally in the same frame as maximize begins.

Optional but recommended polish:
- On first tap of the double tap, do nothing visually.
- Do not flash controls or show pressed opacity. That makes the gesture feel cheaper and noisier.

### 7. Simple implementation guidance in current PearTube structure

In `constants.ts`, split the current motion tokens into separate configs instead of overloading `SPRING_CONFIG_MINI_SNAP`:
- `SPRING_CONFIG_MINI_DOCK_SNAP`
- `SPRING_CONFIG_MINI_COLLAPSE`
- `SPRING_CONFIG_MINI_EXPAND`
- `MINI_DRAG_SCALE_ACTIVE`
- `MINI_DRAG_SCALE_IN_DURATION`
- `MINI_DRAG_SCALE_OUT_DURATION`
- `MINI_VELOCITY_CLAMP`

In `VideoPlayerOverlayImpl.tsx`:
- Keep `resolveSnapTarget` as the source of truth for corner selection.
- Clamp release velocity right before calling `withSpring`.
- Track a small `isMiniSettlingShared` flag from release until both x/y springs finish.
- Gate double-tap on that settling flag.
- Use a dedicated `Gesture.Tap().numberOfTaps(2)` only when in mini mode.
- Keep target corner frozen during settle and update `currentDockCornerShared` at release time, not after animation completion.

That last point matters: if the logical dock corner updates only after animation completes, any dependent shadow/radius/layout logic may lag by a frame and subtly cheapen the transition.

### 8. Strong recommendations / what I would actually ship

If this were my patch, I would make exactly these changes first:

1. Introduce three separate spring configs for snap, collapse, and expand.
2. Reduce drag scale effect to 0.988 and animate it with short timings, not spring.
3. Make drag shadow softer and broader instead of much darker.
4. Clamp release velocity to about 2400 px/s per axis before spring handoff.
5. Add `isMiniSettling` and disable double-tap during settle.
6. Implement double-tap maximize anywhere on mini player with 240ms max delay and 10 px max movement.
7. Ensure radius/shadow/size all interpolate continuously during fullscreen <-> mini.

Those changes should produce the biggest "this feels more like YouTube" improvement without changing the overall interaction model or adding dismiss complexity.
