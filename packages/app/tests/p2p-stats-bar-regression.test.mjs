import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve('components/video-player/P2PStatsBar.tsx'), 'utf8')

test('P2P stats bar does not claim preparing when bytes are actively transferring', () => {
  assert.match(source, /if \(downloadSpeed > 0\) return \{ color: '#fbbf24', label: 'Downloading' \}/)
})
