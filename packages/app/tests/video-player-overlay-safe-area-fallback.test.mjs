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

test('VideoPlayerOverlay falls back to zero insets instead of throwing when safe-area context is missing', () => {
  const source = readAppFile('components/VideoPlayerOverlayImpl.tsx')

  assert.match(
    source,
    /SafeAreaInsetsContext/,
    'overlay should read SafeAreaInsetsContext directly so it can tolerate missing provider state',
  )
  assert.doesNotMatch(
    source,
    /const insets = useSafeAreaInsets\(\)/,
    'overlay should not call the throwing useSafeAreaInsets hook directly',
  )
  assert.match(
    source,
    /const insets = useContext\(SafeAreaInsetsContext\) \?\? ZERO_EDGE_INSETS/,
    'overlay should fall back to zero insets when safe-area context is unavailable',
  )
})
