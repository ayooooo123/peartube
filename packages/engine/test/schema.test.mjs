import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createProfileRecord,
  createVideoRecord,
  validateProfileRecord,
  validateVideoRecord,
  videoRecordPath,
  videoSourcePath
} from '../src/schema.mjs'

test('profile records validate', () => {
  const record = createProfileRecord({ channelKey: 'abc', name: 'Alice', createdAt: 123 })
  assert.equal(validateProfileRecord(record).ok, true)
})

test('video records validate and use canonical paths', () => {
  const record = createVideoRecord({
    channelKey: 'abc',
    id: 'v1',
    title: 'Hello',
    filename: videoSourcePath('v1'),
    byteLength: 100,
    mimeType: 'video/mp4',
    createdAt: 123
  })
  assert.equal(validateVideoRecord(record).ok, true)
  assert.equal(videoRecordPath('v1'), '/videos/v1/video.json')
  assert.equal(videoSourcePath('v1'), '/videos/v1/source.mp4')
})

test('video records reject unsafe filenames', () => {
  const record = createVideoRecord({
    channelKey: 'abc',
    id: 'v1',
    title: 'Bad',
    filename: '/videos/v1/../secret.mp4',
    byteLength: 100,
    mimeType: 'video/mp4',
    createdAt: 123
  })
  const result = validateVideoRecord(record)
  assert.equal(result.ok, false)
  assert.match(result.error, /filename/i)
})
