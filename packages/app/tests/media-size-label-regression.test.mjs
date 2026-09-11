import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { formatBytes, formatSizeLabel } from '../lib/formatters.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

function read(relative) {
  return readFileSync(resolve(__dirname, '..', relative), 'utf8')
}
async function loadChannelPresentation() {
  const overlay = read('components/VideoPlayerOverlayImpl.tsx')
  const start = overlay.indexOf('function resolveChannelPresentation')
  const end = overlay.indexOf('\nfunction resolveDownloadFlags', start)
  assert.notEqual(start, -1, 'the production channel presentation helper must remain available')
  assert.notEqual(end, -1, 'the production channel presentation helper must have a bounded body')
  const result = await build({
    stdin: {
      contents: [
        "import { formatSizeLabel } from './lib/formatters.ts'",
        'type VideoData = { channel?: { name?: string }; channelKey?: string; size?: number | string | null }',
        overlay.slice(start, end),
        'export { resolveChannelPresentation }',
      ].join('\n'),
      resolveDir: resolve(__dirname, '..'),
      sourcefile: 'channel-presentation.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
  })
  const directory = mkdtempSync(join(__dirname, '.channel-presentation-'))
  const output = join(directory, 'presentation.cjs')
  writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
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


// The size exists: it is on the signed manifest. The entity response used to
// answer with no renditions at all, so the detail screen had nothing to pass
// the player when Play started.
test('the played rendition carries its manifest byte length into the player', () => {
  const page = read('components/routes/MediaEntityPage.tsx')
  assert.match(page, /byteLength: renditionByteLength\(sourceEntity, prepared\.renditionId\)/)

  const route = read('app/media/[id].tsx')
  assert.match(route, /prepared\.byteLength === null \? \{\} : \{ size: prepared\.byteLength \}/)
})
test('player channel presentation wires unknown and known sizes into the metadata label', async () => {
  const { resolveChannelPresentation } = await loadChannelPresentation()
  assert.equal(
    resolveChannelPresentation(null, { channelKey: 'channel-1', size: 0 }).sizeLabel,
    null,
  )
  assert.equal(
    resolveChannelPresentation('Archivist', { channelKey: 'channel-1', size: 179775 }).sizeLabel,
    formatBytes(179775),
  )
})
