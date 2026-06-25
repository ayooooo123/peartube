import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

test('Studio published rows start playback through the shared player path', () => {
  const source = fs.readFileSync(
    path.join(appRoot, 'app/(tabs)/studio.tsx'),
    'utf8',
  )

  assert.match(source, /loadAndPlayVideo/, 'Studio should use the shared player context for published video playback')
  assert.match(source, /const playPublishedVideo = useCallback/, 'Studio should define a published-row playback handler')
  assert.match(source, /rpc\.preparePlayback\(playbackRequest\)/, 'Studio should resolve playback through the backend before opening the player')
  assert.match(source, /onPress=\{\(\) => playPublishedVideo\(item\)\}/, 'Published rows must be pressable, not just show a play icon')
  assert.match(source, /blobId: item\.blobId \|\| undefined/, 'Published row playback should pass direct blob refs when available')
  assert.match(source, /blobsCoreKey: item\.blobsCoreKey \|\| undefined/, 'Published row playback should pass direct blobs core refs when available')
})
