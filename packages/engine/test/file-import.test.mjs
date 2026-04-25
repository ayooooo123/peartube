import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEngine } from '../src/index.mjs'

test('engine imports a local video file with generated id and MIME sniffing', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'peartube-engine-file-import-'))
  const storagePath = join(rootPath, 'store')
  const sourcePath = join(rootPath, 'sample.mp4')
  const mp4Header = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypisom'),
    Buffer.from('payload')
  ])
  await writeFile(sourcePath, mp4Header)

  const engine = await createEngine({ storagePath, name: 'Uploader' })
  try {
    const record = await engine.writeVideoFile(sourcePath, {
      title: 'Imported',
      description: 'from disk',
      category: 'demo'
    })

    assert.match(record.id, /^[a-f0-9]{32}$/)
    assert.equal(record.mimeType, 'video/mp4')
    assert.equal(record.size, mp4Header.length)
    assert.equal(record.description, 'from disk')
    assert.equal(record.category, 'demo')
    assert.deepEqual(await engine.readVideoBytes(record.id), mp4Header)
  } finally {
    await engine.close()
  }
})
