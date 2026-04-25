import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEngine, validateVideoRecord } from '../src/index.mjs'

const HEADER = 'PEARTUBE_ENGINE_VIDEO'

test('engine writes video file and metadata into the channel drive', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'peartube-engine-video-'))
  const engine = await createEngine({ storagePath, name: 'Alice' })
  const bytes = Buffer.alloc(128 * 1024, 0)
  bytes.write(HEADER, 0, 'utf8')

  const record = await engine.writeVideo({
    id: 'v1',
    title: 'Engine video',
    bytes,
    mimeType: 'video/mp4'
  })

  assert.equal(validateVideoRecord(record).ok, true)
  assert.equal(record.filename, '/videos/v1/source.mp4')
  assert.equal(record.byteLength, bytes.length)

  const storedRecord = await engine.readJson('/videos/v1/video.json')
  assert.equal(storedRecord.title, 'Engine video')

  const storedBytes = await engine.drive.get('/videos/v1/source.mp4')
  assert.equal(storedBytes.subarray(0, HEADER.length).toString(), HEADER)

  await engine.close()
})
