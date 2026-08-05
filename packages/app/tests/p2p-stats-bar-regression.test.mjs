import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../components/video-player/P2PStatsBar.tsx'), 'utf8')

test('P2P stats bar reports active peer transfers as streaming', () => {
  assert.match(
    source,
    /if \(peerCount > 0 && \(downloadSpeed > 0 \|\| stats\?\.status === 'downloading'\)\) \{[\s\S]*`Streaming from \$\{peerCount\}/,
  )
})

test('P2P stats bar does not infer live streaming from aggregate cache progress', () => {
  assert.match(source, /const hasPlayableProgress = downloadSpeed > 0/)
  assert.doesNotMatch(source, /hasPlayableProgress = [^\n]*(?:downloadedBytes|downloadedBlocks|stats\?\.progress)/)
})

test('P2P stats bar treats fully loaded videos as saved before streaming', () => {
  const cachedCheckIndex = source.indexOf("if (isCached) return 'Saved on this device'")
  const streamingCheckIndex = source.indexOf('if (hasPlayableProgress) {')

  assert.notEqual(cachedCheckIndex, -1, 'stats bar should normalize fully loaded videos to local saved state')
  assert.notEqual(streamingCheckIndex, -1, 'stats bar should still show streaming for partial playable progress')
  assert.ok(cachedCheckIndex < streamingCheckIndex, 'saved state must win over streaming for fully cached videos')
  assert.match(source, /stats\?\.status === 'complete'/, 'complete status should count as cached')
  assert.match(source, /Number\(stats\?\.progress \?\? 0\) >= 100/, '100% progress should count as cached')
  assert.match(source, /totalBlocks > 0 && downloadedBlocks >= totalBlocks/, 'all blocks downloaded should count as cached')
  assert.match(source, /totalBytes > 0 && downloadedBytes >= totalBytes/, 'all bytes downloaded should count as cached')
  assert.match(source, /stats && !isCached && hasProgressDetails/, 'progress bar should not render as an active transfer once cached')
})

// A publication plays with no P2P stats at all: the channel-drive stats poller
// needs a channel key and skips these titles, so `stats` stays null for the
// whole session. The bar read that as "Starting player…" over frames that were
// already on screen.
test('P2P stats bar stops claiming the player is starting once it plays', () => {
  const playingIndex = source.indexOf("if (playing) return 'Playing'")
  const startingIndex = source.indexOf("if (!stats) return 'Starting player…'")

  assert.notEqual(playingIndex, -1, 'the bar reads the player state, not only the swarm')
  assert.notEqual(startingIndex, -1, 'a player that has not started still says so')
  assert.ok(playingIndex < startingIndex, 'real playback wins over the absence of stats')
  assert.match(source, /if \(failed \|\| stats\?\.status === 'error'\)/, 'a terminal failure is not a starting player either')
})
