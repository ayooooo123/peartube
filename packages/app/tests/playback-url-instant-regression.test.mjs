import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const apiPath = new URL('../../backend/src/api.js', import.meta.url)
const storagePath = new URL('../../backend/src/storage.js', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

test('preparePlayback/getVideoUrl uses instant blob URLs when blob keys are already known', async () => {
  const src = await source(apiPath)

  const directBlobKeyStart = src.indexOf('if (blobId && blobsCoreKey)')
  assert.notEqual(directBlobKeyStart, -1, 'expected direct blobId/blobsCoreKey fast path')
  const directBlobKeyBlock = src.slice(directBlobKeyStart, src.indexOf('const meta = await this.getVideoData', directBlobKeyStart))
  assert.match(directBlobKeyBlock, /instant:\s*true/, 'direct blobId/blobsCoreKey playback must not wait on peer discovery before returning a URL')

  const publicBeeKeyStart = src.indexOf('if (meta.blobsCoreKey)')
  assert.notEqual(publicBeeKeyStart, -1, 'expected publicBee blobsCoreKey fast path')
  const publicBeeKeyBlock = src.slice(publicBeeKeyStart, src.indexOf('// Fallback: load channel', publicBeeKeyStart))
  assert.match(publicBeeKeyBlock, /instant:\s*true/, 'publicBee blobsCoreKey playback must not wait on peer discovery before returning a URL')
})

test('fallback channel blob-entry playback also returns an instant blob URL', async () => {
  const src = await source(apiPath)
  const fallbackStart = src.indexOf('// Fallback: load channel to get blob entry')
  assert.notEqual(fallbackStart, -1, 'expected fallback blob-entry path')
  const fallbackBlock = src.slice(fallbackStart, src.indexOf('},\n\n    /**\n     * Prepare normal watch playback', fallbackStart))

  assert.match(fallbackBlock, /const blobEntry = await channel\.getBlobEntry\(meta\)/, 'expected fallback to resolve blob entry from channel metadata')
  assert.match(fallbackBlock, /getVideoUrlFromBlob\(ctx, blobsKeyHex, blobEntry\.blobId, \{[\s\S]*instant:\s*true/, 'fallback blob-entry path should not wait on core update once it has blob coordinates')
})

test('instant blob URL path generates the blob-server link before background core readiness/update', async () => {
  const src = await source(storagePath)
  const start = src.indexOf('function getVideoUrlInstant')
  assert.notEqual(start, -1, 'expected getVideoUrlInstant helper')
  const block = src.slice(start, src.indexOf('export async function getVideoUrlFromBlob', start))

  const linkIndex = block.indexOf('ctx.blobServer.getLink')
  const readyIndex = block.indexOf('blobsCore.ready().then')
  assert.notEqual(linkIndex, -1, 'instant path must generate a blob URL')
  assert.notEqual(readyIndex, -1, 'instant path should still kick off background sync')
  assert.ok(linkIndex < readyIndex, 'instant path must return URL generation before background core ready/update work')
})
