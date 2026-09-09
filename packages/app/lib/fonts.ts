/**
 * Font files for expo-font `useFonts`, shared by the native and web root
 * layouts. Kept apart from typography.ts so components can import the type
 * scale without pulling binary assets into non-Metro bundlers (tests).
 */
export const fontAssets = {
  'Syne-ExtraBold': require('../assets/fonts/Syne-ExtraBold.ttf'),
  'Syne-Bold': require('../assets/fonts/Syne-Bold.ttf'),
  'JetBrainsMono-Regular': require('../assets/fonts/JetBrainsMono-Regular.ttf'),
  'JetBrainsMono-Medium': require('../assets/fonts/JetBrainsMono-Medium.ttf'),
}
