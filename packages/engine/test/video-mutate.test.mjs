import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEngine } from '../src/index.mjs'

test('engine updates and deletes video metadata without losing source bytes', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'peartube-engine-video-mutate-'))
  const engine = await createEngine({ storagePath, name: 'Editor' })

  try {
    await engine.writeVideo({ id: 'v1', title: 'Original', bytes: Buffer.from('keep-me') })

    const updated = await engine.updateVideo('v1', {
      title: 'Updated',
      description: 'edited',
      category: 'news'
    })

    assert.equal(updated.title, 'Updated')
    assert.equal(updated.description, 'edited')
    assert.equal(updated.category, 'news')
    assert.equal(updated.byteLength, 7)

    assert.equal(await engine.deleteVideo('v1'), true)
    assert.equal(await engine.getVideo('v1'), null)
    assert.deepEqual(await engine.readVideoBytes('v1'), Buffer.from('keep-me'))
  } finally {
    await engine.close()
  }
})
