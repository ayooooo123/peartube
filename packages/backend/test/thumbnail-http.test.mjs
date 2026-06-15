import assert from 'node:assert/strict'
import { test } from 'node:test'

import { serveThumbnailHttpRequest } from '../src/thumbnail-http.js'

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
