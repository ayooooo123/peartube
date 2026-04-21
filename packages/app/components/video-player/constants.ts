/**
 * Video Player Constants
 *
 * Shared constants for the video player overlay, including dimensions,
 * animation configurations, and thresholds.
 */

// Mini PiP dimensions (mobile) — legacy fixed values kept for styles.ts mini info strip
export const MINI_PIP_WIDTH = 240
export const MINI_PIP_HEIGHT = 135
export const MINI_PIP_MARGIN = 12
export const MINI_PIP_CORNER_RADIUS = 16

// Responsive mini sizes — actual values computed at runtime via computeMiniSize(sizeMode)
export const MINI_PIP_COMPACT_WIDTH_FRACTION = 0.50
export const MINI_PIP_COMPACT_WIDTH_MIN = 220
export const MINI_PIP_COMPACT_WIDTH_MAX = 360

export const MINI_PIP_EXPANDED_WIDTH_FRACTION = 0.92
export const MINI_PIP_EXPANDED_WIDTH_MIN = 320
export const MINI_PIP_EXPANDED_WIDTH_MAX = 520

// Tab bar
export const TAB_BAR_HEIGHT = 42

// Animation
export const ANIMATION_DURATION = 300

// Swipe dismiss thresholds
export const SWIPE_DISMISS_THRESHOLD = MINI_PIP_WIDTH * 0.35 // ~84px
export const SWIPE_VELOCITY_THRESHOLD = 500 // px/s

// Spring configurations for smooth animations
export const SPRING_CONFIG = {
  damping: 20,
  stiffness: 200,
  mass: 0.8,
}

// Bouncy spring for maximize (visible overshoot when returning to fullscreen)
export const SPRING_CONFIG_BOUNCY = {
  damping: 15,
  stiffness: 200,
  mass: 0.8,
}

// Tighter spring for minimize (clean settle, no overshoot)
export const SPRING_CONFIG_TIGHT = {
  damping: 25,
  stiffness: 200,
  mass: 0.8,
}

// Snap spring for mini corner docking.
// Tuned to feel more weighted/smooth like YouTube's mini player while still
// preserving decisive corner snaps and diagonal fling support.
export const SPRING_CONFIG_MINI_SNAP = {
  damping: 44,
  stiffness: 520,
  mass: 0.95,
  restDisplacementThreshold: 0.5,
  restSpeedThreshold: 4,
  overshootClamping: false,
}

// Snap algorithm velocity thresholds
export const SNAP_LOW_SPEED = 500       // px/s — below this, nearest corner from release point
export const SNAP_FLING_SPEED = 1400    // px/s — above this, longer projection horizon
export const SNAP_TOSS_HORIZON = 0.18   // seconds — projection for toss (500–1400 px/s)
export const SNAP_FLING_HORIZON = 0.22  // seconds — projection for fling (≥1400 px/s)
export const SNAP_HYSTERESIS_PX = 24    // center-distance for slow-release stickiness

// Mini player visual tuning
export const MINI_DRAG_SCALE = 0.988
export const MINI_SHADOW_DOCKED = { opacity: 0.16, radius: 12, offsetY: 4, elevation: 9 }
export const MINI_SHADOW_DRAGGING = { opacity: 0.24, radius: 18, offsetY: 6, elevation: 14 }
export const MINI_DRAG_OVERSHOOT_X = 24
export const MINI_DRAG_OVERSHOOT_TOP = 16
export const MINI_DRAG_OVERSHOOT_BOTTOM = 16

// Desktop mini player dimensions
export const DESKTOP_MINI_WIDTH = 320
export const DESKTOP_MINI_HEIGHT = 180
export const DESKTOP_MINI_PADDING = 24
export const DESKTOP_MINI_CONTROLS_HEIGHT = 48

// Double-tap / button seek step (seconds)
export const SEEK_STEP_SECONDS = 10

// Comments pagination
export const COMMENTS_PER_PAGE = 25

// Playback speeds
export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
