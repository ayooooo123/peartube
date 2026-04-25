import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEngine } from '../src/index.mjs'

test('remote engine opens a channel by key and replicates video records/bytes', async () => {
  const writerPath = await mkdtemp(join(tmpdir(), 'peartube-engine-writer-'))
  const readerPath = await mkdtemp(join(tmpdir(), 'peartube-engine-reader-'))
  const writer = await createEngine({ storagePath: writerPath, name: 'Alice' })
  await writer.writeVideo({ id: 'v1', title: 'Replicated Video', bytes: Buffer.from('replicated') })

  const reader = await createEngine({ storagePath: readerPath, channelKey: writer.channelKey })
  const replication = replicateStores(writer.store, reader.store)

  try {
    const records = await waitFor(async () => {
      const videos = await reader.listVideos()
      return videos.length === 1 ? videos : null
    })
    assert.equal(records[0].title, 'Replicated Video')

    const bytes = await waitFor(async () => {
      try {
        return await reader.readVideoBytes('v1')
      } catch {
        return null
      }
    })
    assert.equal(bytes.toString('utf8'), 'replicated')
  } finally {
    replication.destroy()
    await reader.close()
    await writer.close()
  }
})

function replicateStores(left, right) {
  const a = left.replicate(true)
  const b = right.replicate(false)
  a.pipe(b).pipe(a)
  return {
    destroy() {
      a.destroy()
      b.destroy()
    }
  }
}

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('timed out waiting for condition')
}
