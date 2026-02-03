/**
 * Video Player Constants
 *
 * Shared constants for the video player overlay, including dimensions,
 * animation configurations, and thresholds.
 */

// Mini PiP dimensions (mobile)
export const MINI_PIP_WIDTH = 240
export const MINI_PIP_HEIGHT = 135
export const MINI_PIP_MARGIN = 12
export const MINI_PIP_CORNER_RADIUS = 8

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

// Desktop mini player dimensions
export const DESKTOP_MINI_WIDTH = 320
export const DESKTOP_MINI_HEIGHT = 180
export const DESKTOP_MINI_PADDING = 24
export const DESKTOP_MINI_CONTROLS_HEIGHT = 48

// Comments pagination
export const COMMENTS_PER_PAGE = 25

// Playback speeds
export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
