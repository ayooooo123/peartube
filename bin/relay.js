#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createNode } from '../src/index.js'
import { createAcquirer } from '../src/acquire.js'
import { createApi } from '../src/http.js'

const env = process.env
const storage = env.PEARTUBE_STORAGE || './peartube-data'
mkdirSync(storage, { recursive: true, mode: 0o700 })

const node = await createNode({
  storage,
  tracker: env.PEARTUBE_TRACKER || null,
  streamHost: env.PEARTUBE_STREAM_HOST || '127.0.0.1',
  streamPort: Number(env.PEARTUBE_STREAM_PORT || 8175),
  dhtPort: env.PEARTUBE_DHT_PORT ? Number(env.PEARTUBE_DHT_PORT) : undefined,
  relayThrough: env.PEARTUBE_RELAY_THROUGH ? env.PEARTUBE_RELAY_THROUGH.split(',') : null
})
const acquirer = createAcquirer(node, join(storage, 'jobs.json'))
const api = createApi({ node, acquirer })
const apiPort = Number(env.PEARTUBE_API_PORT || 8174)
api.listen(apiPort, env.PEARTUBE_API_HOST || '0.0.0.0')

console.log(JSON.stringify({ msg: 'relay ready', api: apiPort, ...node.status() }))
setInterval(() => console.log(JSON.stringify({ msg: 'heartbeat', ...node.status() })), 60_000).unref()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    api.close()
    await node.close()
    process.exit(0)
  })
}
