/**
 * Font files for expo-font `useFonts`, shared by the native and web root
 * layouts. Kept apart from typography.ts so components can import the type
 * scale without pulling binary assets into non-Metro bundlers (tests).
 */
import syneExtraBold from '../assets/fonts/Syne-ExtraBold.ttf'
import syneBold from '../assets/fonts/Syne-Bold.ttf'
import jetBrainsMonoRegular from '../assets/fonts/JetBrainsMono-Regular.ttf'
import jetBrainsMonoMedium from '../assets/fonts/JetBrainsMono-Medium.ttf'

export const fontAssets = {
  'Syne-ExtraBold': syneExtraBold,
  'Syne-Bold': syneBold,
  'JetBrainsMono-Regular': jetBrainsMonoRegular,
  'JetBrainsMono-Medium': jetBrainsMonoMedium,
}
