import b4a from 'b4a'
import Hyperswarm from 'hyperswarm'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createChannelDrive, writeSampleVideo } from './channel-drive.mjs'

const storagePath = resolve(process.argv[2] || '.tmp/peer-a')
await mkdir(storagePath, { recursive: true })

const channel = await createChannelDrive({ storagePath, name: 'Alice' })
const video = await writeSampleVideo({
  drive: channel.drive,
  channelKey: channel.channelKey,
  id: 'v1',
  title: 'Hyperswarm drive demo',
  size: 4 * 1024 * 1024
})

const swarm = new Hyperswarm()
swarm.on('connection', conn => {
  console.log('[peer-a] connection')
  channel.store.replicate(conn)
})

const discovery = swarm.join(channel.drive.discoveryKey, { server: true, client: true })
discovery.flushed().catch(() => {})

console.log('[peer-a] storage:', storagePath)
console.log('[peer-a] drive key:', b4a.toString(channel.drive.key, 'hex'))
console.log('[peer-a] file:', video.filename)
console.log('[peer-a] waiting for peers; Ctrl+C to stop')

async function shutdown() {
  console.log('\n[peer-a] shutting down')
  await swarm.destroy().catch(() => {})
  await channel.close().catch(() => {})
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
