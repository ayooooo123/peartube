import Autobee from 'autobee'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperblobs from 'hyperblobs'
import BlobServer from 'hypercore-blob-server'
import b4a from 'b4a'
import { createHash } from 'node:crypto'
import { pipelinePromise, Transform } from 'streamx'
import { join } from 'node:path'
import { createLan } from './lan.js'

const ID = /^[a-z0-9]+:[a-z0-9]+(:s\d{2}e\d{2,3})?$/
const HEX64 = /^[0-9a-f]{64}$/
const MAX_TITLE = 300

// A tracker entry is public and replicated to every relay. apply is the only
// gate: it keeps well-formed announces and files each under its writer's key,
// so a writer can add or remove only its own entries.
// Values here come from any peer, so every check must be total: typeof before regex.
const str = (v, re) => typeof v === 'string' && re.test(v)

export function decodeOp (value) {
  let op
  try { op = JSON.parse(value) } catch { return null }
  if (op === null || typeof op !== 'object') return null
  if (op.type === 'remove') return typeof op.key === 'string' ? op : null
  if (op.type !== 'announce' || !str(op.id, ID) || !str(op.blobs, HEX64) || !str(op.sha256, HEX64)) return null
  if (typeof op.title !== 'string' || op.title.length > MAX_TITLE || !Number.isSafeInteger(op.size) || op.size < 0) return null
  const { blockOffset, blockLength, byteOffset, byteLength } = op.blob || {}
  if (![blockOffset, blockLength, byteOffset, byteLength].every(n => Number.isSafeInteger(n) && n >= 0)) return null
  return op
}

// A relay's first well-formed op arrives optimistically, as a join request.
// Granting it as a non-indexer writer lets its later ops be ordinary appends;
// an ungranted optimistic writer cannot append again.
async function apply (nodes, view, host) {
  for (const node of nodes) {
    const op = decodeOp(node.value)
    if (!op) continue
    await host.addWriter(node.key, { isIndexer: false })
    const writer = b4a.toString(node.key, 'hex')
    const w = view.write()
    if (op.type === 'remove') {
      if (op.key.split('/')[1] === writer) w.tryDelete(b4a.from(op.key))
    } else {
      w.tryPut(b4a.from(`${op.id}/${writer}/${op.blobs}:${op.blob.blockOffset}`), node.value)
    }
    await w.flush()
  }
}

export async function createNode ({
  storage,
  tracker: trackerKey = null,
  streamHost = '127.0.0.1',
  streamPort = 0,
  bootstrap,
  dhtPort,
  relayThrough = null,
  lan: lanOptions = null
}) {
  const store = new Corestore(join(storage, 'corestore'))
  // fastForward: false - Autobee's default lets a peer that is far enough
  // ahead hand over its built view, skipping our apply. On an open tracker any
  // relay could then forge entries under other writers' keys; every node must
  // build its own view with apply.
  const tracker = new Autobee(store.namespace('tracker'), trackerKey && b4a.from(trackerKey, 'hex'), { apply, optimistic: true, fastForward: false })
  await tracker.ready()
  // A fresh tracker ignores everyone's writes until its founder writes once.
  if (!trackerKey && tracker.local.length === 0) {
    await tracker.append(b4a.from(JSON.stringify({ type: 'init' })))
    await tracker.updated()
  }

  const blobsCore = store.get({ name: 'blobs' })
  await blobsCore.ready()
  const blobs = new Hyperblobs(blobsCore)
  const blobsKey = b4a.toString(blobsCore.key, 'hex')

  // Double-randomized NATs cannot holepunch; relayThrough lets them meet via a blind relay.
  const swarm = new Hyperswarm({ bootstrap, port: dhtPort, relayThrough: relayThrough && (force => force ? relayThrough.map(k => b4a.from(k, 'hex')) : null) })
  swarm.on('connection', conn => tracker.replicate(conn))
  swarm.join(tracker.discoveryKey)

  // Optional LAN path (mDNS + isolated DHT) for peers the public DHT cannot
  // connect, e.g. two randomized NATs on one network. Same key pair as the swarm.
  const lanPeers = new Set()
  const lan = lanOptions && createLan({ ...lanOptions, keyPair: swarm.keyPair })
  if (lan) {
    lan.on('connection', conn => {
      lanPeers.add(conn)
      conn.once('close', () => lanPeers.delete(conn))
      tracker.replicate(conn)
    })
    await lan.ready()
    lan.join(tracker.discoveryKey)
  }

  // No stream token for now: stream URLs are open, like the API.
  const server = new BlobServer(store, { host: streamHost, port: streamPort, token: null })
  await server.listen()

  function streamUrl (entry) {
    return server.getLink(b4a.from(entry.blobs, 'hex'), { blob: entry.blob })
  }

  // Every tracker entry for id, or every entry in the tracker without one.
  async function search (id = null) {
    await tracker.update()
    const results = []
    const range = id ? { gte: b4a.from(`${id}/`), lt: b4a.from(`${id}/\xff`) } : {}
    for await (const node of tracker.view.createReadStream(range)) {
      const entry = JSON.parse(node.value)
      results.push({ key: b4a.toString(node.key), id: entry.id, title: entry.title, size: entry.size, sha256: entry.sha256, local: entry.blobs === blobsKey, streamUrl: streamUrl(entry) })
    }
    return results
  }

  // Store a readable stream as a blob and hash it on the way in. Returns the
  // announce op without publishing it. pipelinePromise destroys every stream
  // on failure, which releases the Hyperblobs write lock; an abandoned writer
  // would hang every later put.
  async function put ({ id, title }, source, onData = null) {
    if (!str(id, ID)) throw new Error(`Invalid id ${id}`)
    const hash = createHash('sha256')
    let size = 0
    const hasher = new Transform({ transform (chunk, cb) { hash.update(chunk); size += chunk.length; if (onData) onData(size); cb(null, chunk) } })
    const writer = blobs.createWriteStream()
    await pipelinePromise(source, hasher, writer)
    return { type: 'announce', id, title: String(title || id).slice(0, MAX_TITLE), size, sha256: hash.digest('hex'), blobs: blobsKey, blob: writer.id }
  }

  async function publish (meta, source) {
    const op = await put(meta, source)
    await append(op)
    return { ...op, streamUrl: streamUrl(op) }
  }

  async function remove (key) {
    await append({ type: 'remove', key })
  }

  // Resolves once op is in the local oplog. A relay that has not synced the
  // tracker yet holds optimistic writes in memory only, and a restart would
  // drop them; this waits until the write is durable (for a joiner, until it
  // first syncs).
  async function append (op) {
    const before = tracker.local.length
    await tracker.append(b4a.from(JSON.stringify(op)), { optimistic: !tracker.writable })
    await tracker.updated()
    while (tracker.local.length <= before) {
      if (closing) throw new Error('Node closed before the write was durable')
      await new Promise(resolve => setTimeout(resolve, 500))
      await tracker.update()
    }
  }

  function status () {
    return { tracker: b4a.toString(tracker.key, 'hex'), writer: b4a.toString(tracker.local.key, 'hex'), blobs: blobsKey, blobBytes: blobsCore.byteLength, peers: swarm.connections.size, lanPeers: lanPeers.size }
  }

  let closing = false
  async function close () {
    closing = true
    await lan?.destroy()
    await swarm.destroy()
    await tracker.close()
    await server.close()
    await store.close()
  }

  return { tracker, swarm, search, put, append, publish, remove, status, streamUrl, close, get closing () { return closing } }
}
