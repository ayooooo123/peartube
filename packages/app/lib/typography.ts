/**
 * Brand typography for inline-style call sites.
 *
 * Headings use Space Grotesk (loaded in app/_layout.tsx via expo-font);
 * body text intentionally stays on the system font for a native feel.
 * NativeWind call sites can use the `font-heading` / `font-heading-medium`
 * utilities from tailwind.config.js instead.
 *
 * The nested `title` / `body` / `caption` / `label` scales mirror client application's
 * type ramp. Each entry is a partial RN TextStyle meant to be spread into a
 * StyleSheet entry: `title: { ...fonts.title.lg, color: colors.text }`.
 * They carry no fontFamily so they compose with either font above.
 */
import type { TextStyle } from 'react-native'

type TypeScale = {
  fontSize: number
  lineHeight: number
  fontWeight: TextStyle['fontWeight']
  letterSpacing?: number
}

export const fonts = {
  heading: 'SpaceGrotesk-Bold',
  headingMedium: 'SpaceGrotesk-Medium',

  title: {
    xl: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
    lg: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
    md: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  },
  body: {
    lg: { fontSize: 18, lineHeight: 26, fontWeight: '400' },
    md: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
    sm: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  },
  caption: {
    sm: { fontSize: 12, lineHeight: 16, fontWeight: '500', letterSpacing: 0.4 },
  },
  label: {
    md: { fontSize: 15, lineHeight: 20, fontWeight: '600', letterSpacing: 0.2 },
  },
} as const satisfies {
  heading: string
  headingMedium: string
  title: Record<'xl' | 'lg' | 'md', TypeScale>
  body: Record<'lg' | 'md' | 'sm', TypeScale>
  caption: Record<'sm', TypeScale>
  label: Record<'md', TypeScale>
}
