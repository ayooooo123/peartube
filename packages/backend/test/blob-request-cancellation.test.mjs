import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import {
  installExpectedBlobRequestCancellationHandler,
  isExpectedBlobRequestCancellation,
} from '../src/blob-request-cancellation.js'

const storagePath = new URL('../src/storage.js', import.meta.url)

test('detects expected Hypercore request cancellation errors from blob stream teardown', () => {
  assert.equal(isExpectedBlobRequestCancellation({ code: 'REQUEST_CANCELLED' }), true)
  assert.equal(isExpectedBlobRequestCancellation({ code: 'REQUEST_CANCELLED', message: 'Request was cancelled' }), true)
  assert.equal(isExpectedBlobRequestCancellation(Object.assign(new Error('Request was cancelled'), { code: 'REQUEST_CANCELLED' })), true)
  assert.equal(isExpectedBlobRequestCancellation({ code: 'REQUEST_CANCELLED', message: 'different cancellation' }), false)
  assert.equal(isExpectedBlobRequestCancellation({ code: 'OTHER', message: 'Request was cancelled' }), false)
  assert.equal(isExpectedBlobRequestCancellation(new Error('Request was cancelled')), false)
})

test('installed handler consumes only expected Hypercore request cancellations', () => {
  const consumed = []
  const forwarded = []
  const target = {
    on(event, listener) {
      assert.equal(event, 'unhandledRejection')
      this.listener = listener
      return this
    },
  }

  const result = installExpectedBlobRequestCancellationHandler({
    processLike: target,
    onConsumed: (reason) => consumed.push(reason),
    rethrow: (reason) => forwarded.push(reason),
  })

  assert.equal(result.installed, true)
  target.listener({ code: 'REQUEST_CANCELLED', message: 'Request was cancelled' })
  target.listener({ code: 'OTHER', message: 'boom' })

  assert.equal(consumed.length, 1)
  assert.deepEqual(forwarded, [{ code: 'OTHER', message: 'boom' }])
})

test('storage installs expected cancellation handler before starting the blob server', async () => {
  const src = await readFile(storagePath, 'utf8')
  const importIndex = src.indexOf("import { installExpectedBlobRequestCancellationHandler } from './blob-request-cancellation.js'")
  const installIndex = src.indexOf('installExpectedBlobRequestCancellationHandler()')
  const blobServerIndex = src.indexOf('blobServer = new BlobServer')

  assert.ok(importIndex >= 0, 'storage should import the blob request cancellation handler')
  assert.ok(installIndex >= 0, 'storage should install the blob request cancellation handler')
  assert.ok(blobServerIndex >= 0, 'storage should still create the blob server')
  assert.ok(installIndex < blobServerIndex, 'handler must be installed before blob-server requests can tear down streams')
})
