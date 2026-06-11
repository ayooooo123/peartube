import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('mobile player page height is shared and stays 16:9 across overlay and watch route', () => {
  const layoutSource = readAppFile('lib/video-layout.ts')
  const overlaySource = readAppFile('components/VideoPlayerOverlayImpl.tsx')
  const watchRouteSource = readAppFile('app/video/[id].tsx')

  assert.match(
    layoutSource,
    /export function getPlayerPageVideoHeight\(screenWidth: number\)\s*\{\s*return Math\.round\(screenWidth \* 9 \/ 16\)\s*\}/,
    'video page sizing should live in a shared helper with a fixed 16:9 frame',
  )
  assert.match(
    overlaySource,
    /import \{ getPlayerPageVideoHeight \} from '@\/lib\/video-layout'/,
    'overlay should use the shared player page sizing helper',
  )
  assert.match(
    overlaySource,
    /const videoHeight = getPlayerPageVideoHeight\(screenWidth\)/,
    'overlay should size the fullscreen page frame from the shared helper instead of native video aspect ratio',
  )
  assert.match(
    overlaySource,
    /const effectiveAR = videoAspectRatio \|\| 16 \/ 9/,
    'overlay should still define a safe aspect-ratio fallback for desktop and mini-player sizing',
  )
  assert.match(
    watchRouteSource,
    /import \{ getPlayerPageVideoHeight \} from '@\/lib\/video-layout'/,
    'watch route should use the shared player page sizing helper',
  )
  assert.match(
    watchRouteSource,
    /const videoHeight = getPlayerPageVideoHeight\(screenWidth\)/,
    'watch route should reserve the same player frame height as the overlay',
  )
})

test('android fullscreen overlay does not add a second JS cutout shift on top of native handling', () => {
  const overlaySource = readAppFile('components/VideoPlayerOverlayImpl.tsx')

  assert.match(
    overlaySource,
    /height: frozenVideoHeightShared\.value,/,
    'android PiP freeze branch should keep the fullscreen video slot height unchanged',
  )
  assert.match(
    overlaySource,
    /if \(isPipLayoutActiveShared\.value && Platform\.OS === 'android'\) \{\s+return \{\s+position: 'absolute',\s+top: 0,/,
    'android PiP positioning should stay at top: 0 because native media-session already handles the inset',
  )
  assert.match(
    overlaySource,
    /const cutoutInset = Platform\.OS === 'ios' && !isInPipModeShared\.value && !isLandscapeFullscreenShared\.value/,
    'fullscreen wrapper growth should be limited to iOS so Android stays aligned with the watch page spacer',
  )
  assert.match(
    overlaySource,
    /const cutoutOffset = Platform\.OS === 'ios'\s+&& !isInPipModeShared\.value\s+&& !isLandscapeFullscreenShared\.value/,
    'video surface offset should be limited to iOS so Android does not get shifted twice',
  )
  assert.doesNotMatch(
    overlaySource,
    /MediaSession\.setSurfaceViewInset\([^)]*\)/,
    'inline Android playback should not translate the Media3 SurfaceView from JS; native playback owns surface inset handling',
  )
  assert.match(
    overlaySource,
    /setSurfaceViewInset and setAutoPictureInPicture are no longer needed/,
    'the overlay should document that Android surface inset handling has moved out of JS layout code',
  )
  assert.match(
    overlaySource,
    /const fullscreenTopInset = Platform\.OS === 'android' && !isInPipModeShared\.value && !isLandscapeFullscreenShared\.value/,
    'android fullscreen container should respect the top safe inset at the page level instead of shifting the video surface',
  )
  assert.match(
    overlaySource,
    /\[miniPipY\.value, fullscreenTopInset\]/,
    'fullscreen container animation should settle below the Android cutout instead of ending at top 0',
  )
})

test('VideoPlayerContext accepts aspect-ratio updates from both inline host event shapes', () => {
  const source = readAppFile('lib/VideoPlayerContext.tsx')

  assert.match(
    source,
    /\(\s*data\.type === 'onNewVideoLayout'\s*\|\|\s*data\.type === 'video-size'\s*\)/,
    'VideoPlayerContext should accept both react-native-video and native pear-player video size events',
  )
})

test('native player controls use a dedicated tap overlay above the video surface', () => {
  const overlaySource = readAppFile('components/VideoPlayerOverlayImpl.tsx')

  assert.match(
    overlaySource,
    /<Pressable\s+style=\{StyleSheet\.absoluteFill\}\s+onPress=\{handleVideoTap\}\s+testID="video-tap-overlay"/,
    'native video controls should be toggled by an explicit absolute-fill tap target instead of relying on parent presses around the video surface',
  )
  assert.doesNotMatch(
    overlaySource,
    /<MpvMobileVideoView[\s\S]*>\s*\{overlayContent\}\s*<\/MpvMobileVideoView>/,
    'native overlay chrome should not be nested inside the video host when a dedicated tap layer is needed above the renderer',
  )
})

test('fullscreen controls container lets empty-space taps fall through to the dismiss overlay', () => {
  const overlaySource = readAppFile('components/VideoPlayerOverlayImpl.tsx')

  assert.match(
    overlaySource,
    /<Animated\.View pointerEvents="box-none" style=\{\[styles\.controlsOverlayBase, controlsOverlayStyle\]\}>/,
    'the fullscreen controls wrapper should only capture taps on actual buttons so a second background tap can dismiss controls',
  )
})

test('Android mini-player layout is no longer suppressed by the removed split-player flag', () => {
  const overlaySource = readAppFile('components/VideoPlayerOverlayImpl.tsx')

  assert.doesNotMatch(
    overlaySource,
    /disableMiniLayoutOnAndroidSplit/,
    'the split-player mini-layout guard was removed along with the permanently-disabled flag; the in-app Android mini player must stay available',
  )
  assert.doesNotMatch(
    overlaySource,
    /androidSplitPlayerEnabled/,
    'the overlay should no longer consume the removed androidSplitPlayerEnabled context value',
  )
})

test('mobile mini-player drag snaps to safe-area corners', () => {
  const overlaySource = readAppFile('components/VideoPlayerOverlayImpl.tsx')
  const derivedSource = readAppFile('components/video-player/overlayDerivedState.ts')

  assert.match(
    overlaySource,
    /getMobileMiniPlayerSnapPosition/,
    'overlay should use the dedicated corner snap helper',
  )
  assert.match(
    derivedSource,
    /export function getMobileMiniPlayerSnapPosition\(\{\s*corner,\s*screenWidth,\s*screenHeight,\s*topInset,\s*rightInset,\s*bottomInset,\s*leftInset,\s*bottomOffset,\s*aspectRatio,\s*sizeMode,/,
    'mobile mini-player placement should be derived from a dedicated corner snap helper',
  )
  assert.match(
    derivedSource,
    /const bounds = computeMiniBounds\(\s*screenWidth,\s*screenHeight,\s*topInset,\s*rightInset,\s*bottomInset,\s*leftInset,\s*bottomOffset,\s*miniWidth,\s*miniHeight,/,
    'mobile snap helper should derive bounds from safe-area insets, tab bar offset, and dynamic mini-player size',
  )
  assert.match(
    derivedSource,
    /topBound: insetTop \+ margin,/,
    'mobile top-corner snapping should stay below the safe-area inset',
  )
  assert.match(
    derivedSource,
    /bottomBound: screenHeight - bottomMargin - miniHeight,/,
    'mobile bottom-corner snapping should stay above the tab bar and bottom inset',
  )
  assert.match(
    overlaySource,
    /const nextPos = getMobileMiniPlayerSnapPosition\(\{\s*corner: miniPlayerCorner,/,
    'mobile mini-player relayout should reuse the selected corner instead of always resetting to bottom-right',
  )
  assert.match(
    overlaySource,
    /if \(isMiniPlayerModeShared\.value && Platform\.OS !== 'web'\) \{/,
    'the shared pan gesture should switch into mobile mini-player drag mode outside the web desktop branch',
  )
  assert.match(
    overlaySource,
    /const snap = resolveSnapTarget\(/,
    'mobile mini-player drag release should snap to the nearest safe-area anchor',
  )
  assert.match(
    overlaySource,
    /runOnJS\(setMiniPlayerCorner\)\(snap\.corner\)/,
    'mobile mini-player drag release should persist the snapped corner in React state',
  )
  assert.match(
    overlaySource,
    /miniPipX\.value = withSpring\(snap\.x, \{ \.\.\.SPRING_CONFIG_MINI_SNAP, velocity: event\.velocityX \}\)/,
    'mobile mini-player drag release should spring the player to the snapped horizontal corner',
  )
  assert.match(
    overlaySource,
    /miniPipY\.value = withSpring\(snap\.y, \{ \.\.\.SPRING_CONFIG_MINI_SNAP, velocity: event\.velocityY \}\)/,
    'mobile mini-player drag release should spring the player to the snapped vertical corner',
  )
})

test('mobile pill tab bar owns its own route matching and stays disabled on desktop', () => {
  const layoutSource = readAppFile('app/(tabs)/_layout.tsx')
  const tabBarSource = readAppFile('components/PillTabBar.tsx')

  assert.match(
    layoutSource,
    /tabBar=\{\(\) => <PillTabBar \/>\}/,
    'tabs layout should mount the pill tab bar through its self-contained router-aware API',
  )
  assert.match(
    tabBarSource,
    /import \{ usePathname, useRouter \} from 'expo-router'/,
    'pill tab bar should derive active state and navigation from expo-router paths',
  )
  assert.match(
    tabBarSource,
    /const \{ isDesktop \} = usePlatform\(\)/,
    'pill tab bar should check desktop mode directly instead of rendering a mobile control there',
  )
  assert.match(
    tabBarSource,
    /if \(isDesktop\) \{\s+return null\s+\}/,
    'pill tab bar should not render on desktop layouts',
  )
  assert.match(
    tabBarSource,
    /router\.replace\(tab\.path as any\)/,
    'pill tab bar should navigate by explicit route path so custom route layouts stay in sync',
  )
  assert.doesNotMatch(
    tabBarSource,
    /interface PillTabBarProps/,
    'pill tab bar should no longer depend on TabNavigator state props',
  )
})

test('mobile pill tab bar renders vector icons on Android instead of text fallbacks', () => {
  const tabBarSource = readAppFile('components/PillTabBar.tsx')
  const appJson = JSON.parse(readAppFile('app.json'))

  assert.match(tabBarSource, /<Feather name=\{tab\.icon\} size=\{iconSize\} color=\{iconColor\}/, 'pill tab bar should render Feather glyphs for every tab')
  assert.doesNotMatch(tabBarSource, /function TextIcon/, 'pill tab bar should not render H\/D\/S text placeholders on Android')
  assert.doesNotMatch(tabBarSource, /Platform\.OS === 'android' \? \(/, 'Android should use the same vector icon component as iOS')
  assert.ok(
    appJson.expo.plugins.includes('./plugins/withVectorIconFonts.js'),
    'prebuild should copy @expo/vector-icons font assets into native Android builds',
  )
})
