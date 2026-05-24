import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../components/video-player/P2PStatsBar.tsx'), 'utf8')

test('P2P stats bar does not claim preparing when bytes are actively transferring', () => {
  assert.match(source, /if \(downloadSpeed > 0\) return \{ color: '#fbbf24', label: 'Downloading' \}/)
})

test('P2P stats bar treats an actively loaded video as ready even when transfer speeds are momentarily idle', () => {
  assert.match(source, /const hasPlayableProgress =/, 'stats bar should classify playable byte or block progress separately from transfer speed')
  assert.match(source, /if \(hasPlayableProgress\) return \{ color: '#60a5fa', label: 'Streaming' \}/, 'loaded playable progress should stay in streaming state instead of falling through to preparing')
})
