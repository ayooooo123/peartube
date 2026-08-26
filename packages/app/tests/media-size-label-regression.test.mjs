import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatBytes, formatSizeLabel } from '../lib/formatters.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

function read(relative) {
  return readFileSync(resolve(__dirname, '..', relative), 'utf8')
}

// A publication that reached the player without a manifest byte length has no
// size to state. Printing "0 B" beside a title that is decoding frames is a
// plain falsehood, and the project omits unknown counters rather than zeroing
// them.
test('an unknown size is omitted, never rendered as zero', () => {
  assert.equal(formatSizeLabel(undefined), null)
  assert.equal(formatSizeLabel(null), null)
  assert.equal(formatSizeLabel(0), null)
  assert.equal(formatSizeLabel(-1), null)
  assert.equal(formatSizeLabel('not a number'), null)
  assert.equal(formatSizeLabel(Number.NaN), null)
  assert.equal(formatSizeLabel(Number.POSITIVE_INFINITY), null)
})

test('a known size reads the same as everywhere else in the app', () => {
  assert.equal(formatSizeLabel(179775), formatBytes(179775))
  assert.equal(formatSizeLabel('179775'), formatBytes(179775))
  assert.equal(formatSizeLabel(512), '512 B')
})

// formatBytes still answers "0 B" on purpose: a progress readout of
// "0 B / 4.2 MB" is true, and only the standalone metadata segment is a lie.
test('the byte formatter itself keeps reporting zero for progress readouts', () => {
  assert.equal(formatBytes(0), '0 B')
})

test('the player metadata lines drop the size segment when it is unknown', () => {
  const overlay = read('components/VideoPlayerOverlayImpl.tsx')
  assert.match(overlay, /const sizeLabel = formatSizeLabel\(currentVideo\.size\)/)
  assert.match(overlay, /\{sizeLabel \? ` · \$\{sizeLabel\}` : ''\}/, 'the native meta line')
  assert.match(overlay, /\{sizeLabel \? <span>\{sizeLabel\}<\/span> : null\}/, 'the desktop meta line')
  assert.doesNotMatch(overlay, /formatSize\(currentVideo\.size\)/, 'no path renders the title size as zero')

  const watchPage = read('app/video/[id].tsx')
  assert.match(watchPage, /formatSizeLabel\(videoData\?\.size\)/)
  assert.doesNotMatch(watchPage, /formatSize\(videoData\?\.size \|\| 0\)/)
})

// The size exists: it is on the signed manifest. The entity response used to
// answer with no renditions at all, so the detail screen had nothing to pass
// the player when Play started.
test('the played rendition carries its manifest byte length into the player', () => {
  const page = read('components/routes/MediaEntityPage.tsx')
  assert.match(page, /byteLength: renditionByteLength\(sourceEntity, prepared\.renditionId\)/)

  const route = read('app/media/[id].tsx')
  assert.match(route, /prepared\.byteLength === null \? \{\} : \{ size: prepared\.byteLength \}/)
})
