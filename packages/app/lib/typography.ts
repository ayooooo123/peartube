/**
 * Brand typography for inline-style call sites.
 *
 * Three voices, no more:
 *   - `fonts.display`  — Syne ExtraBold. Screen titles, hero titles, big numbers.
 *                        Always uppercase, tight tracking.
 *   - `fonts.heading`  — Syne Bold. Section headers, card titles, button labels.
 *   - `fonts.mono`     — JetBrains Mono. Every machine fact: durations, peer
 *                        counts, byte sizes, timestamps, hashes, keys, eyebrow
 *                        labels, tab labels. Uppercase + letterSpacing for
 *                        labels, normal case for values.
 * Body copy stays on the system font for a native feel.
 *
 * All fonts are loaded by the root layouts via expo-font (see lib/fonts.ts).
 * NativeWind call sites use `font-display` / `font-heading` / `font-mono`.
 *
 * The nested scales are partial RN TextStyles meant to be spread into a
 * StyleSheet entry: `title: { ...fonts.title.lg, color: colors.text }`.
 */
import type { TextStyle } from 'react-native'

type TypeScale = {
  fontSize: number
  lineHeight: number
  fontWeight?: TextStyle['fontWeight']
  fontFamily?: string
  letterSpacing?: number
  textTransform?: TextStyle['textTransform']
}

const DISPLAY = 'Syne-ExtraBold'
const HEADING = 'Syne-Bold'
const MONO = 'JetBrainsMono-Regular'
const MONO_MEDIUM = 'JetBrainsMono-Medium'

export const fonts = {
  display: DISPLAY,
  heading: HEADING,
  /** Kept for call sites that want a lighter heading; Syne Bold is the floor. */
  headingMedium: HEADING,
  mono: MONO,
  monoMedium: MONO_MEDIUM,

  /** Uppercase Syne ExtraBold. Screen and hero titles. */
  title: {
    xl: { fontSize: 32, lineHeight: 34, fontFamily: DISPLAY, letterSpacing: -0.8, textTransform: 'uppercase' },
    lg: { fontSize: 24, lineHeight: 26, fontFamily: DISPLAY, letterSpacing: -0.5, textTransform: 'uppercase' },
    md: { fontSize: 18, lineHeight: 22, fontFamily: HEADING, letterSpacing: -0.2 },
  },
  body: {
    lg: { fontSize: 18, lineHeight: 26, fontWeight: '400' },
    md: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
    sm: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  },
  /** Mono eyebrow: uppercase, tracked. Section kickers, tab labels, badges. */
  caption: {
    sm: { fontSize: 11, lineHeight: 14, fontFamily: MONO_MEDIUM, letterSpacing: 1.2, textTransform: 'uppercase' },
  },
  /** Mono value: durations, counts, sizes, timestamps. Normal case. */
  meta: {
    md: { fontSize: 13, lineHeight: 18, fontFamily: MONO },
    sm: { fontSize: 12, lineHeight: 16, fontFamily: MONO },
    xs: { fontSize: 10, lineHeight: 12, fontFamily: MONO },
  },
  /** Button and control labels. */
  label: {
    md: { fontSize: 13, lineHeight: 16, fontFamily: HEADING, letterSpacing: 0.6, textTransform: 'uppercase' },
  },
} as const satisfies {
  display: string
  heading: string
  headingMedium: string
  mono: string
  monoMedium: string
  title: Record<'xl' | 'lg' | 'md', TypeScale>
  body: Record<'lg' | 'md' | 'sm', TypeScale>
  caption: Record<'sm', TypeScale>
  meta: Record<'md' | 'sm' | 'xs', TypeScale>
  label: Record<'md', TypeScale>
}

