import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createApi } from '../../backend/src/api.js'

const apiPath = new URL('../../backend/src/api.js', import.meta.url)
const servicePath = new URL('../../backend/src/blob-playback-service.js', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

test('getVideoUrl prefers authoritative immutable metadata before bounded legacy direct refs', async () => {
  const src = await source(apiPath)

  const getVideoUrlStart = src.indexOf('async getVideoUrl')
  assert.notEqual(getVideoUrlStart, -1, 'expected getVideoUrl implementation')
  const channelFallback = src.indexOf('let channel = null', getVideoUrlStart)
  const playbackBlock = src.slice(getVideoUrlStart, channelFallback)
  assert.match(playbackBlock, /const meta = await this\.getVideoData/, 'authoritative metadata must load first')
  assert.match(playbackBlock, /resolveImmutableStaticPlayback\(meta, mimeType\)/, 'immutable publication playback has priority')
  assert.match(playbackBlock, /if \(playbackBlobRef\?\.blobId && playbackBlobRef\?\.blobsCoreKey\)/, 'legacy direct refs remain a bounded fallback')
  assert.match(playbackBlock, /blobPlayback\.resolveDirectBlobUrl\(\{[\s\S]*blobsCoreKey: playbackBlobRef\.blobsCoreKey,[\s\S]*blobId: playbackBlobRef\.blobId,/, 'legacy direct fallback still uses the instant playback service')

  const metaStart = src.indexOf('return blobPlayback.resolveFromMetadata(meta')
  assert.notEqual(metaStart, -1, 'expected metadata playback fallback to use playback service')
})

test('fallback channel blob-entry playback is centralized in the playback service', async () => {
  const src = await source(servicePath)
  const fallbackStart = src.indexOf('async resolveFromMetadata')
  assert.notEqual(fallbackStart, -1, 'expected metadata resolver')
  const fallbackBlock = src.slice(fallbackStart, src.indexOf('async preparePlayback', fallbackStart))

  assert.match(fallbackBlock, /const blobEntry = await channel\.getBlobEntry\(meta\)/, 'expected fallback to resolve blob entry from channel metadata')
  assert.match(fallbackBlock, /return this\.resolveDirectBlobUrl\(\{[\s\S]*blobsCoreKey,[\s\S]*blobId,/, 'fallback blob-entry path should use the centralized instant URL generator')
})

test('getVideoData returns direct blob metadata before channel load', async () => {
  let channelLoads = 0
  const api = createApi({
    ctx: {},
    loadChannel: async () => {
      channelLoads += 1
      throw new Error('direct metadata should not load a channel')
    },
  })
  const metadata = await api.getVideoData(
    'channel-key',
    '/videos/instant.mp4',
    'public-bee-key',
    'blob-id',
    'blobs-core-key',
    'video/mp4',
  )

  assert.equal(metadata.id, 'instant')
  assert.equal(metadata.path, '/videos/instant.mp4')
  assert.equal(metadata.publicBeeKey, 'public-bee-key')
  assert.equal(metadata.blobId, 'blob-id')
  assert.equal(metadata.blobsCoreKey, 'blobs-core-key')
  assert.equal(metadata.mimeType, 'video/mp4')
  assert.equal(channelLoads, 0, 'the direct metadata branch precedes channel lookup')
})

test('instant blob URL path generates the blob-server link before background core readiness/update', async () => {
  const src = await source(servicePath)
  const start = src.indexOf('resolveDirectBlobUrl')
  assert.notEqual(start, -1, 'expected resolveDirectBlobUrl helper')
  const block = src.slice(start, src.indexOf('return { url }', start))

  const linkIndex = block.indexOf('ctx.blobServer.getLink')
  const warmIndex = block.indexOf('this.warmDirectBlobRef')
  assert.notEqual(linkIndex, -1, 'instant path must generate a blob URL')
  assert.notEqual(warmIndex, -1, 'instant path should still kick off background sync')
  assert.ok(linkIndex < warmIndex, 'instant path must generate the URL before background core ready/update work')
})
