import test from 'node:test'
import assert from 'node:assert/strict'

import { createVideoRecord, validateVideoRecord } from '../src/index.mjs'

test('video records carry old-stack compatible metadata fields', () => {
  const record = createVideoRecord({
    channelKey: 'channel',
    id: 'v1',
    title: 'Compat',
    description: 'desc',
    byteLength: 42,
    mimeType: 'video/webm',
    category: 'tech',
    duration: 12,
    width: 1920,
    height: 1080,
    createdAt: 123
  })

  assert.equal(validateVideoRecord(record).ok, true)
  assert.equal(record.description, 'desc')
  assert.equal(record.category, 'tech')
  assert.equal(record.size, 42)
  assert.equal(record.uploadedAt, 123)
  assert.equal(record.duration, 12)
  assert.equal(record.width, 1920)
  assert.equal(record.height, 1080)
})
