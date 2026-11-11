// Who tells the DHT that it holds a video. Its publisher does, and a relay does for a complete cached copy. A viewer
// that watched the whole film does not: its copy still serves the peers it is connected to, with no topic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import HyperDHT from 'hyperdht'
import hypercoreCrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { createNode } from '../src/index.js'
import { createLan } from '../src/lan.js'
import { formatWatchUri, parseUri } from '../src/protocol.js'
import { mdnsBus } from './mdns.js'

const tmp = label => mkdtempSync(join(tmpdir(), `peartube-topics-${label}-`))
const sha256 = buf => createHash('sha256').update(buf).digest('hex')

async function until (fn, ms, label) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

test('a video is announced by its publisher and by a relay that cached it, never by a viewer', { timeout: 120_000 }, async t => {
  const testnet = await createTestnet(3)
  const observer = new HyperDHT({ bootstrap: testnet.bootstrap })
  const nodes = []
  t.after(async () => {
    await observer.destroy()
    for (const node of nodes.reverse()) await node.close()
    await testnet.destroy()
  })
  const open = async opts => {
    const node = await createNode({ bootstrap: testnet.bootstrap, ...opts })
    nodes.push(node)
    return node
  }

  const publisher = await open({ storage: tmp('publisher') })
  const bytes = randomBytes(1536 * 1024 + 5)
  await publisher.publish({ id: 'imdb:tt0000201', title: 'Announced' }, Readable.from([bytes]))
  const tracker = publisher.status().tracker
  const viewer = await open({ storage: tmp('viewer'), tracker })
  const relay = await open({ storage: tmp('relay'), tracker, announceCache: true })

  // Both download the whole film, then list their catalog: the read that offers a relay's complete copy a slot.
  let blobs = ''
  for (const node of [viewer, relay]) {
    const entry = await until(async () => (await node.search('imdb:tt0000201'))[0], 60_000, 'catalog synced')
    blobs = parseUri(entry.magnetUrl).entry.blobs
    const body = Buffer.from(await (await fetch(entry.streamUrl)).arrayBuffer())
    assert.equal(sha256(body), sha256(bytes))
    await until(async () => (await node.search('imdb:tt0000201'))[0].cachedBytes >= bytes.length, 30_000, 'whole film cached')
  }

  const topic = hypercoreCrypto.discoveryKey(b4a.from(blobs, 'hex'))
  const announcers = async () => {
    const keys = new Set()
    for await (const reply of observer.lookup(topic)) for (const peer of reply.peers) keys.add(b4a.toString(peer.publicKey, 'hex'))
    return keys
  }
  const seen = await until(async () => {
    const keys = await announcers()
    return keys.has(publisher.peerKey) && keys.has(relay.peerKey) && keys
  }, 60_000, 'publisher and relay on the video topic')
  assert.equal(seen.has(viewer.peerKey), false, 'a viewer that holds the whole film is not on its topic')
})

// A watch link joins its channel's swarm, and only the last few links keep theirs. A followed channel is on that
// same topic: dropping a link's hold must not take the followed channel off the DHT or the LAN.
test('watch links past the limit do not take a followed channel off its topic', { timeout: 60_000 }, async t => {
  const testnet = await createTestnet(3)
  const bus = mdnsBus()
  const followed = randomBytes(32).toString('hex')
  const viewer = await createNode({
    storage: tmp('link-viewer'),
    bootstrap: testnet.bootstrap,
    sources: [{ key: followed, kind: 'channel' }],
    lan: keyPair => createLan({ host: '127.0.0.1', keyPair, adapter: bus(), dialAfter: 200 })
  })
  t.after(async () => {
    await viewer.close()
    await testnet.destroy()
  })
  const topic = hypercoreCrypto.discoveryKey(b4a.from(followed, 'hex'))
  // Every link names the same film, so only the channels change the count of LAN topics.
  const blobs = randomBytes(32).toString('hex')
  const link = channel => formatWatchUri({
    id: 'clip:linktest',
    title: 'Link',
    blobs,
    blob: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 1 }
  }, channel, 'channel')

  // The first link is for the followed channel. Five more channels push out its hold and the oldest of their own.
  await viewer.openUri(link(followed))
  const lanTopics = viewer.lanStats().topics
  for (let i = 0; i < 5; i++) await viewer.openUri(link(randomBytes(32).toString('hex')))
  await new Promise(resolve => setTimeout(resolve, 500))

  assert.ok(viewer.swarm.status(topic), 'the followed channel is still joined on the DHT')
  assert.equal(viewer.swarm.status(topic).isServer, true, 'and still announced there')
  assert.equal(viewer.lanStats().topics, lanTopics + 4, 'four link channels are held on the LAN, and the followed channel with them')
})
