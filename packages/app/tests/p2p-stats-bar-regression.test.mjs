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
  assert.match(source, /sessionDownloadedBytes > 0/, 'streaming state should use bytes downloaded during the active playback session')
  assert.match(source, /sessionDownloadedBlocks > 0/, 'streaming state should use blocks downloaded during the active playback session')
  assert.doesNotMatch(source, /Number\(stats\?\.progress \?\? 0\) > 0/, 'sampled aggregate progress must not be treated as live streaming')
  assert.match(source, /if \(hasPlayableProgress\) return \{ color: '#60a5fa', label: 'Streaming' \}/, 'loaded playable progress should stay in streaming state instead of falling through to preparing')
})

test('P2P stats bar treats fully loaded videos as cached before streaming', () => {
  const cachedCheckIndex = source.indexOf("if (isCached) return { color: '#4ade80', label: 'Cached' }")
  const streamingCheckIndex = source.indexOf("if (hasPlayableProgress) return { color: '#60a5fa', label: 'Streaming' }")

  assert.notEqual(cachedCheckIndex, -1, 'stats bar should normalize fully loaded videos to Cached')
  assert.notEqual(streamingCheckIndex, -1, 'stats bar should still show Streaming for partial playable progress')
  assert.ok(cachedCheckIndex < streamingCheckIndex, 'Cached must win over Streaming for fully cached videos')
  assert.match(source, /stats\?\.status === 'complete'/, 'complete status should count as cached')
  assert.match(source, /Number\(stats\?\.progress \?\? 0\) >= 100/, '100% progress should count as cached')
  assert.match(source, /totalBlocks > 0 && downloadedBlocks >= totalBlocks/, 'all blocks downloaded should count as cached')
  assert.match(source, /totalBytes > 0 && downloadedBytes >= totalBytes/, 'all bytes downloaded should count as cached')
  assert.match(source, /stats && !isCached && hasProgressDetails/, 'progress bar should not render as an active transfer once cached')
})
