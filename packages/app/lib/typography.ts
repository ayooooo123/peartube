/**
 * Brand typography for inline-style call sites.
 *
 * Headings use Space Grotesk (loaded in app/_layout.tsx via expo-font);
 * body text intentionally stays on the system font for a native feel.
 * NativeWind call sites can use the `font-heading` / `font-heading-medium`
 * utilities from tailwind.config.js instead.
 */
export const fonts = {
  heading: 'SpaceGrotesk-Bold',
  headingMedium: 'SpaceGrotesk-Medium',
} as const
