import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Corestore from 'corestore'
import { MultiWriterChannel } from '../src/channel/multi-writer-channel.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function closeSilently(resource) {
  if (!resource || typeof resource.close !== 'function') return
  try { await resource.close() } catch {}
}

test('updateMetadata syncs createdBy and createdAt to the public bee', async (t) => {
  const dir = makeTempDir('peartube-channel-owner-meta-')
  const store = new Corestore(dir)
  let channel = null

  try {
    await store.ready()
    channel = new MultiWriterChannel(store, { encrypt: false })
    await channel.ready()

    await channel.updateMetadata({
      name: 'Relay Owner Test',
      createdBy: 'owner-public-key',
      createdAt: 12345
    })

    const publicMeta = await channel.publicBee.getMetadata()

    t.is(publicMeta.createdBy, 'owner-public-key')
    t.is(publicMeta.createdAt, 12345)
  } finally {
    await closeSilently(channel)
    await closeSilently(store)
    rmSync(dir, { recursive: true, force: true })
  }
})
