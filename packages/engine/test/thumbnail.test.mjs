import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEngine } from '../src/index.mjs'

test('engine writes thumbnail bytes, updates metadata, and serves thumbnail URL', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'peartube-engine-thumbnail-'))
  const engine = await createEngine({ storagePath, name: 'Thumbs' })

  try {
    await engine.writeVideo({ id: 'v1', title: 'Has thumb', bytes: Buffer.from('video') })
    const updated = await engine.setVideoThumbnail('v1', {
      bytes: Buffer.from('jpeg-ish'),
      mimeType: 'image/jpeg'
    })

    assert.equal(updated.thumbnail, '/videos/v1/thumbnail')
    assert.equal(updated.thumbnailMimeType, 'image/jpeg')
    assert.equal(updated.thumbnailByteLength, 8)

    const res = await fetch(await engine.thumbnailUrl('v1'))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/jpeg')
    assert.equal(await res.text(), 'jpeg-ish')
  } finally {
    await engine.close()
  }
})
