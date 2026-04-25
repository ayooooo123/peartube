import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEngine } from '../src/index.mjs'

test('engine serves channel video bytes through local blob server with range support', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'peartube-engine-blob-'))
  const engine = await createEngine({ storagePath, name: 'Alice' })
  const bytes = Buffer.from('0123456789abcdef')

  await engine.writeVideo({ id: 'v1', title: 'Range Video', bytes })
  const url = await engine.getVideoUrl('v1')

  const full = await fetch(url)
  assert.equal(full.status, 200)
  assert.equal(await full.text(), '0123456789abcdef')

  const ranged = await fetch(url, { headers: { range: 'bytes=4-7' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('accept-ranges'), 'bytes')
  assert.equal(await ranged.text(), '4567')

  await engine.close()
})
