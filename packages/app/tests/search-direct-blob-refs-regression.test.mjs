import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const searchSource = fs.readFileSync(path.join(repoRoot, 'packages/app/app/(tabs)/search.tsx'), 'utf8')

test('tab Search preserves direct blob refs from search metadata', () => {
  assert.match(searchSource, /type SearchVideoData = VideoData & \{[\s\S]*blobId\?: string \| null[\s\S]*blobsCoreKey\?: string \| null/s)
  assert.match(searchSource, /path:\s*metadata\.path \|\| r\.path \|\| undefined/)
  assert.match(searchSource, /blobId:\s*metadata\.blobId \|\| r\.blobId \|\| undefined/)
  assert.match(searchSource, /blobsCoreKey:\s*metadata\.blobsCoreKey \|\| r\.blobsCoreKey \|\| undefined/)
  assert.match(searchSource, /mimeType:\s*metadata\.mimeType \|\| r\.mimeType \|\| undefined/)
})

test('tab Search sends direct refs through playback', () => {
  assert.match(searchSource, /function getSearchVideoRef\(video: SearchVideoData\)[\s\S]*video\.path\.startsWith\('\/'\)/)
  assert.match(searchSource, /const videoRef = getSearchVideoRef\(video\)/)
  assert.match(searchSource, /rpc\.preparePlayback\(\{[\s\S]*videoId: videoRef,[\s\S]*publicBeeKey: video\.publicBeeKey \|\| undefined,[\s\S]*blobId: video\.blobId \|\| undefined,[\s\S]*blobsCoreKey: video\.blobsCoreKey \|\| undefined,[\s\S]*mimeType: video\.mimeType \|\| undefined,[\s\S]*\}\)/)
  assert.match(searchSource, /const coreVideo: CoreVideoData = \{[\s\S]*publicBeeKey: video\.publicBeeKey,[\s\S]*blobId: video\.blobId \|\| null,[\s\S]*blobsCoreKey: video\.blobsCoreKey \|\| null,[\s\S]*\}/)
})

test('tab Search route serialization keeps direct refs for web playback handoff', () => {
  assert.match(searchSource, /function makeRouteVideoData\(video: SearchVideoData, channelKey: string\)/)
  assert.match(searchSource, /blobId: video\.blobId \|\| undefined/)
  assert.match(searchSource, /blobsCoreKey: video\.blobsCoreKey \|\| undefined/)
  assert.match(searchSource, /mimeType: video\.mimeType \|\| undefined/)
  assert.match(searchSource, /encodeURIComponent\(makeRouteVideoData\(video, channelKey\)\)/)
})
