/**
 * React Native 0.85 dropped `StyleSheet.absoluteFillObject`, and its
 * `absoluteFill` is a compiled handle on web rather than a plain object, so
 * overlay geometry that needs to be spread into another style uses this.
 */
export const ABSOLUTE_FILL = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const
