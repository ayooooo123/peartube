import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEngine } from '../src/index.mjs'

test('engine lists videos newest first and reads video bytes', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'peartube-engine-list-'))
  const engine = await createEngine({ storagePath, name: 'Alice' })

  await engine.writeVideo({ id: 'old', title: 'Old Video', bytes: Buffer.from('old'), createdAt: 100 })
  await engine.writeVideo({ id: 'new', title: 'New Video', bytes: Buffer.from('new'), createdAt: 200 })

  const records = await engine.listVideos()
  assert.deepEqual(records.map((record) => record.id), ['new', 'old'])

  const bytes = await engine.readVideoBytes('new')
  assert.equal(bytes.toString('utf8'), 'new')

  await engine.close()
})
