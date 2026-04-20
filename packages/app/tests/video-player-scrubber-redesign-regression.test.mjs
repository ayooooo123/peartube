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

test('Scrubber source keeps the redesign geometry aligned with the spec', () => {
  const source = readAppFile('components/video-player/Scrubber.tsx')

  assert.match(
    source,
    /bufferProgress\?: number/,
    'Scrubber should keep bufferProgress optional so existing scrubber callsites do not break when the redesign ships',
  )
  assert.match(
    source,
    /bufferProgress = 0,/,
    'Scrubber should default bufferProgress to 0 for callers that have not wired the new buffer layer yet',
  )
  assert.match(
    source,
    /const TRACK_WRAPPER_HEIGHT = TRACK_HEIGHT_SCRUB/,
    'Scrubber should reserve a stable wrapper height so the track can expand symmetrically instead of growing downward from a zero-height wrapper',
  )
  assert.match(
    source,
    /const tooltipWidthSV = useSharedValue\(0\)/,
    'Scrubber should measure the tooltip width so the preview pill can be clamped at both edges',
  )
  assert.match(
    source,
    /const startYSV = useSharedValue\(0\)/,
    'Scrubber should store the gesture startY in a shared value so release worklets cannot lose the field on Android',
  )
  assert.match(
    source,
    /const dragOffsetSV = useSharedValue\(0\)/,
    'Scrubber should store drag offset in a shared value instead of a plain closure var shared across worklets',
  )
  assert.match(
    source,
    /const verticalDistance = Math\.abs\(evt\.y - startYSV\.value\)/,
    'Scrubber should derive fine-scrubbing speed from the vertical drift distance using the shared gesture startY',
  )
  assert.doesNotMatch(
    source,
    /let startY = 0/,
    'Scrubber should not rely on a plain worklet closure var for startY because Hermes release builds can drop it',
  )
  assert.doesNotMatch(
    source,
    /let dragOffset = 0/,
    'Scrubber should not rely on a plain worklet closure var for dragOffset because worklet callbacks do not reliably share mutable JS locals',
  )
  assert.match(
    source,
    /verticalDistance > 80[\s\S]*0\.25/,
    'Scrubber should quarter the drag speed when the finger moves far away from the bar',
  )
  assert.match(
    source,
    /verticalDistance > 40[\s\S]*0\.5/,
    'Scrubber should halve the drag speed at the mid-distance fine-scrub threshold',
  )
  assert.match(
    source,
    /clamp\(handleCenterX - tooltipWidth \/ 2,\s*0,\s*maxTooltipOffset\)/,
    'Scrubber should clamp the tooltip translateX against the measured track bounds instead of guessing with a hard-coded offset',
  )
  assert.match(
    source,
    /<View style=\{styles\.scrubberTooltipBubble\}[^>]*>[\s\S]*<View style=\{styles\.scrubberTooltipArrow\} \/>/,
    'Scrubber should render the tooltip arrow outside the pill body so the arrow looks like a pointer instead of extra bubble padding',
  )
})

test('player overlay source uses the redesigned bottom time row instead of the legacy floating fullscreen button', () => {
  const overlaySource = readAppFile('components/VideoPlayerOverlayImpl.tsx')
  const stylesSource = readAppFile('components/video-player/styles.ts')

  assert.match(
    overlaySource,
    /<View style=\{styles\.timeDisplayRow\}>[\s\S]*<Pressable onPress=\{toggleLandscapeFullscreen\} style=\{styles\.timeDisplayAction\}>/,
    'the redesign should place the fullscreen toggle inside the bottom time row instead of keeping it as a separate floating button',
  )
  assert.doesNotMatch(
    overlaySource,
    /const fullscreenButtonStyle = useAnimatedStyle/,
    'the legacy fullscreen button positioning block should be removed once the toggle lives in the time row',
  )
  assert.match(
    stylesSource,
    /timeDisplayRow:/,
    'styles should define a dedicated bottom time row container for the redesign',
  )
  assert.match(
    stylesSource,
    /timeTextCurrent:/,
    'styles should split the current time styling from the muted duration styling called for in the spec',
  )
  assert.match(
    stylesSource,
    /timeTextMuted:/,
    'styles should define the muted slash and duration styling from the redesign spec',
  )
  assert.match(
    stylesSource,
    /timeDisplayAction:/,
    'styles should define the fullscreen action hit target that sits on the right edge of the time row',
  )
})
