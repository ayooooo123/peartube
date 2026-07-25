import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const apiPath = new URL('../../backend/src/api.js', import.meta.url)
const servicePath = new URL('../../backend/src/blob-playback-service.js', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

test('preparePlayback/getVideoUrl delegates known blob refs to the instant playback service', async () => {
  const src = await source(apiPath)

  const getVideoUrlStart = src.indexOf('async getVideoUrl')
  assert.notEqual(getVideoUrlStart, -1, 'expected getVideoUrl implementation')
  const directBlobKeyBlock = src.slice(getVideoUrlStart, src.indexOf('const meta = await this.getVideoData', getVideoUrlStart))
  assert.match(directBlobKeyBlock, /if \(playbackBlobRef\?\.blobId && playbackBlobRef\?\.blobsCoreKey\)/, 'expected normalized direct blob fast path')
  assert.match(directBlobKeyBlock, /blobPlayback\.resolveDirectBlobUrl\(\{[\s\S]*blobsCoreKey: playbackBlobRef\.blobsCoreKey,[\s\S]*blobId: playbackBlobRef\.blobId,/, 'direct blob playback must delegate to the instant playback service')

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

test('getVideoData has direct blob metadata fallback before channel load', async () => {
  const src = await source(apiPath)
  const getVideoDataStart = src.indexOf('async getVideoData')
  assert.notEqual(getVideoDataStart, -1, 'expected getVideoData implementation')
  const channelLoadIndex = src.indexOf('const channel = await loadChannel(ctx, driveKey)', getVideoDataStart)
  assert.notEqual(channelLoadIndex, -1, 'expected channel-load fallback')
  const directBlock = src.slice(getVideoDataStart, channelLoadIndex)

  assert.match(directBlock, /if \(blobId && blobsCoreKey\)/, 'getVideoData should accept direct blob refs')
  assert.match(directBlock, /GET_VIDEO_DATA: INSTANT metadata from direct blobId\/blobsCoreKey/, 'direct metadata path should be logged')
  assert.match(directBlock, /blobId,[\s\S]*blobsCoreKey,/, 'direct metadata path should return blob metadata without loadChannel')
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
