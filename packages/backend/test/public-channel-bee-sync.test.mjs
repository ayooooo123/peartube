import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Corestore from 'corestore'
import { PublicChannelBee } from '../src/channel/public-channel-bee.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function closeSilently(resource) {
  if (!resource || typeof resource.close !== 'function') return
  try { await resource.close() } catch {}
}

test('syncFromChannel keeps existing public videos when a channel unexpectedly reads empty', async (t) => {
  const dir = makeTempDir('peartube-public-bee-sync-')
  const store = new Corestore(dir)
  let publicBee = null

  try {
    await store.ready()
    publicBee = new PublicChannelBee(store, { name: 'public-sync-guard-test' })
    await publicBee.ready()

    await publicBee.putVideo('video-1', {
      title: 'Existing public video',
      uploadedAt: 1,
    })

    await publicBee.syncFromChannel({
      keyHex: 'aa'.repeat(32),
      view: { core: { length: 6 } },
      base: { local: { length: 5 } },
      async getMetadata() {
        return {
          name: 'Guarded Channel',
        }
      },
      async listVideos() {
        return []
      },
    })

    const videos = await publicBee.listVideos()
    t.is(videos.length, 1)
    t.is(videos[0]?.id, 'video-1')
    t.is(videos[0]?.title, 'Existing public video')
  } finally {
    await closeSilently(publicBee)
    await closeSilently(store)
    rmSync(dir, { recursive: true, force: true })
  }
})
