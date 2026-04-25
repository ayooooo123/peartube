import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import { join } from 'node:path'

import { createBlobPlaybackServer, getHyperdriveFileUrl } from './blob-playback.mjs'
import { createChannelDrive, writeSampleVideo } from './channel-drive.mjs'

export async function createReplicatedPeers({ basePath, videoSize = 2 * 1024 * 1024 }) {
  const peerA = await createChannelDrive({
    storagePath: join(basePath, 'peer-a'),
    name: 'Alice'
  })
  const video = await writeSampleVideo({
    drive: peerA.drive,
    channelKey: peerA.channelKey,
    id: 'v1',
    title: 'Replicated drive video',
    size: videoSize
  })

  const peerBStore = new Corestore(join(basePath, 'peer-b'))
  const peerBDrive = new Hyperdrive(peerBStore, peerA.drive.key)
  const peerBBlobServer = await createBlobPlaybackServer({ store: peerBStore })
  const playbackUrl = getHyperdriveFileUrl({
    server: peerBBlobServer,
    driveKey: peerA.drive.key,
    filename: video.filename,
    mimeType: video.mimeType
  })

  const peerB = {
    store: peerBStore,
    drive: peerBDrive,
    blobServer: peerBBlobServer
  }

  return {
    peerA,
    peerB,
    playbackUrl,
    async close() {
      await peerBBlobServer.close().catch(() => {})
      await peerBDrive.close().catch(() => {})
      await peerBStore.close().catch(() => {})
      await peerA.close().catch(() => {})
    }
  }
}

export function connectPeers(peerA, peerB) {
  const aReplication = peerA.store.replicate(true)
  const bReplication = peerB.store.replicate(false)

  aReplication.pipe(bReplication).pipe(aReplication)

  return function disconnect() {
    try { aReplication.destroy?.() } catch {}
    try { bReplication.destroy?.() } catch {}
  }
}

export async function waitForRangeReadable({ url, range = 'bytes=0-63', timeoutMs = 8000 }) {
  const started = Date.now()
  let lastError = null

  while (Date.now() - started < timeoutMs) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1000)
      const response = await fetch(url, { headers: { Range: range }, signal: controller.signal })
      clearTimeout(timer)
      const body = Buffer.from(await response.arrayBuffer())
      if (response.status === 206 && body.length > 0) return { response, body }
      lastError = new Error(`unexpected response ${response.status} body=${body.length}`)
    } catch (err) {
      lastError = err
    }
    await delay(150)
  }

  throw new Error(`range did not become readable within ${timeoutMs}ms: ${lastError?.message || 'unknown error'}`)
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
