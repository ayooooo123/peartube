import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const sourcePath = path.resolve(__dirname, '../src/transcode/temp-file-reader.mjs')

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8')
}

test('TempFileReader treats download underflow as an error instead of EOF', () => {
  const source = readSource()
  const syncReadStart = source.indexOf('  syncRead(buffer) {')
  const syncSeekStart = source.indexOf('  /**\n   * Seek for IOContext', syncReadStart)
  const syncReadBlock = source.slice(syncReadStart, syncSeekStart)
  const underflowStart = syncReadBlock.indexOf('if (!this.downloadComplete && availableToRead <= 0)')
  const partialReadStart = syncReadBlock.indexOf('if (availableToRead > 0 && availableToRead < toRead)', underflowStart)
  const underflowBlock = syncReadBlock.slice(underflowStart, partialReadStart)

  assert.match(underflowBlock, /this\.downloadError = new Error\('Download underflow before EOF'/, 'underflow should poison the reader with an explicit error')
  assert.match(underflowBlock, /return -1/, 'underflow must signal read failure instead of EOF')
  assert.doesNotMatch(underflowBlock, /return 0/, 'underflow must not silently report EOF and truncate output')
})
