/**
 * Shared motion conventions.
 *
 * Use these presets with reanimated's withSpring/withTiming so the whole app
 * settles with the same character instead of per-screen magic numbers.
 */
export const springs = {
  /** Quick, confident settle — list items, chips, small UI. */
  snappy: { damping: 18, stiffness: 320 },
  /** Soft, ambient motion — rails, cards entering, large surfaces. */
  gentle: { damping: 22, stiffness: 160 },
  /** Press feedback (matches the established PillTabBar press spring). */
  press: { damping: 15, stiffness: 400 },
} as const

export const durations = {
  fast: 150,
  normal: 220,
  slow: 350,
} as const
