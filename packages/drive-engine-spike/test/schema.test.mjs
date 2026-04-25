import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createProfileRecord,
  createVideoRecord,
  validateProfileRecord,
  validateVideoRecord,
  videoRecordPath
} from '../src/schema.mjs'

test('profile validation accepts a valid profile record', () => {
  const record = createProfileRecord({ channelKey: 'abc123', name: 'Alice', createdAt: 123 })
  assert.equal(validateProfileRecord(record).ok, true)
})

test('video validation accepts valid video metadata', () => {
  const record = createVideoRecord({
    channelKey: 'abc123',
    id: 'v1',
    title: 'Hello',
    filename: '/videos/v1/source.mp4',
    byteLength: 1024,
    mimeType: 'video/mp4',
    createdAt: 123
  })
  assert.equal(validateVideoRecord(record).ok, true)
})

test('video validation rejects path traversal filenames', () => {
  const record = createVideoRecord({
    channelKey: 'abc123',
    id: 'v1',
    title: 'Bad',
    filename: '/videos/v1/../../secret.mp4',
    byteLength: 1024,
    mimeType: 'video/mp4',
    createdAt: 123
  })
  const result = validateVideoRecord(record)
  assert.equal(result.ok, false)
  assert.match(result.error, /filename/i)
})

test('videoRecordPath returns canonical video metadata path', () => {
  assert.equal(videoRecordPath('v1'), '/videos/v1/video.json')
})
