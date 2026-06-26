import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { serveThumbnailHttpRequest } from '../src/thumbnail-http.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const thumbnailSource = readFileSync(resolve(__dirname, '../src/thumbnail-http.js'), 'utf8')
const storageSource = readFileSync(resolve(__dirname, '../src/storage.js'), 'utf8')

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    ended: false,
    body: undefined,
    headersSent: false,
    writableEnded: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v },
    end(b) { this.ended = true; this.body = b; this.writableEnded = true },
  }
}

test('serveThumbnailHttpRequest ignores requests without the pt_thumbnail marker', async () => {
  const res = mockRes()
  const handled = await serveThumbnailHttpRequest(
    { store: {}, blobServer: {} },
    { method: 'GET', url: '/?key=x&blob=y&type=image/jpeg' },
    res
  )
  assert.equal(handled, false)
  assert.equal(res.ended, false, 'must fall through to the upstream handler')
})

test('serveThumbnailHttpRequest ignores non-GET/HEAD methods even when tagged', async () => {
  const res = mockRes()
  const handled = await serveThumbnailHttpRequest(
    { store: {}, blobServer: {} },
    { method: 'POST', url: '/?pt_thumbnail=1&key=x&blob=y' },
    res
  )
  assert.equal(handled, false)
  assert.equal(res.ended, false)
})

test('serveThumbnailHttpRequest returns false when no store is available', async () => {
  const res = mockRes()
  const handled = await serveThumbnailHttpRequest(
    {},
    { method: 'GET', url: '/?pt_thumbnail=1&key=x&blob=y' },
    res
  )
  assert.equal(handled, false)
})

test('thumbnail blob requests retain swarm discovery while image loaders retry', () => {
  assert.match(
    storageSource,
    /retainDiscovery:\s*\(discoveryKey,\s*options\)\s*=>\s*retainSwarmDiscovery\(/,
    'storage should pass retained discovery into the thumbnail responder',
  )
  assert.match(
    thumbnailSource,
    /deps\?\.retainDiscovery/,
    'thumbnail responder should use the retained discovery hook',
  )
  assert.match(
    thumbnailSource,
    /retainDiscovery\(core\.discoveryKey,/,
    'thumbnail responder should retain the blob core discovery key',
  )
  assert.doesNotMatch(
    thumbnailSource,
    /swarm\.join\(core\.discoveryKey\)/,
    'thumbnail responder should not use an unretained one-off swarm join',
  )
})
