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

test('VideoPlayerOverlay delegates mini-player geometry helpers to derived helper module', () => {
  const overlaySource = readAppFile('components/VideoPlayerOverlayImpl.tsx')
  const helperSource = readAppFile('components/video-player/overlayDerivedState.ts')

  assert.match(overlaySource, /from '\.\/video-player\/overlayDerivedState'/, 'overlay should import extracted derived helpers')
  assert.doesNotMatch(overlaySource, /function computeMiniSize\(/, 'computeMiniSize should not remain inline in the overlay component')
  assert.doesNotMatch(overlaySource, /function computeMiniBounds\(/, 'computeMiniBounds should not remain inline in the overlay component')
  assert.doesNotMatch(overlaySource, /function resolveSnapTarget\(/, 'resolveSnapTarget should not remain inline in the overlay component')
  assert.doesNotMatch(overlaySource, /function getMobileMiniPlayerSnapPosition\(/, 'getMobileMiniPlayerSnapPosition should not remain inline in the overlay component')

  assert.match(helperSource, /export function computeMiniSize\(/, 'helper module should export computeMiniSize')
  assert.match(helperSource, /export function computeMiniBounds\(/, 'helper module should export computeMiniBounds')
  assert.match(helperSource, /export function resolveSnapTarget\(/, 'helper module should export resolveSnapTarget')
  assert.match(helperSource, /export function getMobileMiniPlayerSnapPosition\(/, 'helper module should export mobile snap position helper')
  assert.match(helperSource, /'worklet'/, 'worklet helpers should retain worklet directives')
})
