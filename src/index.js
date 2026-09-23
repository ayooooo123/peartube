import Autobee from 'autobee'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperblobs from 'hyperblobs'
import BlobServer from 'hypercore-blob-server'
import b4a from 'b4a'
import { createHash } from 'node:crypto'
import { pipelinePromise, Transform } from 'streamx'
import { join } from 'node:path'

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
  streamToken = null,
  bootstrap,
  dhtPort,
  relayThrough = null
}) {
  const store = new Corestore(join(storage, 'corestore'))
  const tracker = new Autobee(store.namespace('tracker'), trackerKey && b4a.from(trackerKey, 'hex'), { apply, optimistic: true })
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

  const server = new BlobServer(store, { host: streamHost, port: streamPort, token: streamToken })
  await server.listen()

  function streamUrl (entry) {
    return server.getLink(b4a.from(entry.blobs, 'hex'), { blob: entry.blob })
  }

  async function search (id) {
    await tracker.update()
    const results = []
    const range = { gte: b4a.from(`${id}/`), lt: b4a.from(`${id}/\xff`) }
    for await (const node of tracker.view.createReadStream(range)) {
      const entry = JSON.parse(node.value)
      results.push({ key: b4a.toString(node.key), id: entry.id, title: entry.title, size: entry.size, sha256: entry.sha256, local: entry.blobs === blobsKey, streamUrl: streamUrl(entry) })
    }
    return results
  }

  // Store a readable stream as a blob, hash it on the way in, then announce it.
  // pipelinePromise destroys every stream on failure, which releases the
  // Hyperblobs write lock; an abandoned writer would hang every later publish.
  async function publish ({ id, title }, source) {
    if (!str(id, ID)) throw new Error(`Invalid id ${id}`)
    const hash = createHash('sha256')
    let size = 0
    const hasher = new Transform({ transform (chunk, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk) } })
    const writer = blobs.createWriteStream()
    await pipelinePromise(source, hasher, writer)
    const op = { type: 'announce', id, title: String(title || id).slice(0, MAX_TITLE), size, sha256: hash.digest('hex'), blobs: blobsKey, blob: writer.id }
    await append(op)
    return { ...op, streamUrl: streamUrl(op) }
  }

  async function remove (key) {
    await append({ type: 'remove', key })
  }

  async function append (op) {
    await tracker.append(b4a.from(JSON.stringify(op)), { optimistic: !tracker.writable })
    await tracker.updated()
  }

  function status () {
    return { tracker: b4a.toString(tracker.key, 'hex'), writer: b4a.toString(tracker.local.key, 'hex'), blobs: blobsKey, blobBytes: blobsCore.byteLength, peers: swarm.connections.size }
  }

  async function close () {
    await swarm.destroy()
    await tracker.close()
    await server.close()
    await store.close()
  }

  return { tracker, swarm, search, publish, remove, status, streamUrl, close }
}
