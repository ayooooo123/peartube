import b4a from 'b4a'
import Corestore from 'corestore'
import Hypercore from 'hypercore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createBlobPlaybackServer, getHyperdriveFileUrl } from './blob-playback.mjs'
import { readJson } from './channel-drive.mjs'

const driveKeyHex = process.argv[2]
if (!driveKeyHex) {
  console.error('usage: npm run demo:peer-b -- <drive-key-hex> [storage-path]')
  process.exit(1)
}

const storagePath = resolve(process.argv[3] || '.tmp/peer-b')
await mkdir(storagePath, { recursive: true })

const driveKey = b4a.from(driveKeyHex, 'hex')
const store = new Corestore(storagePath)
const drive = new Hyperdrive(store, driveKey)
const blobServer = await createBlobPlaybackServer({ store })

const swarm = new Hyperswarm()
swarm.on('connection', conn => {
  console.log('[peer-b] connection')
  store.replicate(conn)
})

const topic = Hypercore.discoveryKey(driveKey)
const discovery = swarm.join(topic, { server: false, client: true })
discovery.flushed().catch(() => {})

console.log('[peer-b] storage:', storagePath)
console.log('[peer-b] drive key:', driveKeyHex)
console.log('[peer-b] waiting for metadata...')

const video = await waitForVideoRecord(drive, '/videos/v1/video.json', 30000)
const url = getHyperdriveFileUrl({
  server: blobServer,
  driveKey,
  filename: video.filename,
  mimeType: video.mimeType
})

console.log('[peer-b] video:', JSON.stringify(video, null, 2))
console.log('[peer-b] playback url:', url.replace(/token=[^&]+/, 'token=***'))

const range = await fetch(url, { headers: { Range: 'bytes=0-63' } })
const body = Buffer.from(await range.arrayBuffer())
console.log('[peer-b] range status:', range.status)
console.log('[peer-b] range content-range:', range.headers.get('content-range'))
console.log('[peer-b] range bytes:', body.length)
console.log('[peer-b] range head:', body.subarray(0, 27).toString())
console.log('[peer-b] done; Ctrl+C to keep inspecting or stop')

async function waitForVideoRecord(targetDrive, filename, timeoutMs) {
  const started = Date.now()
  let lastError = null

  while (Date.now() - started < timeoutMs) {
    try {
      const value = await readJson(targetDrive, filename)
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await delay(250)
  }

  throw new Error(`video record not readable after ${timeoutMs}ms: ${lastError?.message || 'not found'}`)
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function shutdown() {
  console.log('\n[peer-b] shutting down')
  await swarm.destroy().catch(() => {})
  await blobServer.close().catch(() => {})
  await drive.close().catch(() => {})
  await store.close().catch(() => {})
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
