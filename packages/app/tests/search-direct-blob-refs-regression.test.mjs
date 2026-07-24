import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const searchSource = fs.readFileSync(path.join(repoRoot, 'packages/app/app/search.tsx'), 'utf8')

test('Search preserves direct blob refs through native playback', () => {
  assert.match(searchSource, /const videoAny = video as VideoData & \{ blobId\?: string \| null; blobsCoreKey\?: string \| null \}/)
  assert.match(searchSource, /const videoRef = \(video\.path && typeof video\.path === 'string' && video\.path\.startsWith\('\/'\)\)[\s\S]*\? video\.path[\s\S]*: video\.id/)
  assert.match(searchSource, /rpc\.preparePlayback\(\{[\s\S]*videoId: videoRef,[\s\S]*publicBeeKey: video\.publicBeeKey \|\| undefined,[\s\S]*blobId: videoAny\.blobId \|\| undefined,[\s\S]*blobsCoreKey: videoAny\.blobsCoreKey \|\| undefined,[\s\S]*mimeType: video\.mimeType \|\| undefined,[\s\S]*\}\)/)
  assert.match(searchSource, /const coreVideo: CoreVideoData = \{[\s\S]*publicBeeKey: video\.publicBeeKey,[\s\S]*blobId: videoAny\.blobId \|\| null,[\s\S]*blobsCoreKey: videoAny\.blobsCoreKey \|\| null,[\s\S]*\}/)
})

test('Search route serialization keeps direct refs for web playback handoff', () => {
  assert.match(searchSource, /JSON\.stringify\(\{ \.\.\.video, channelKey \}\)/)
  assert.match(searchSource, /__peartubePendingWatchVideo = pendingWatch/)
})

