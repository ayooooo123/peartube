// A TV receiver's mDNS advertisement on a network that remembers names (an mDNS cache, a reflector, a router).
// bonjour-service does not throw when an advertisement's name is taken: it logs "Service name is already in use" and
// silently stops the advertisement. Ways the cast advertisement and browse can fail around restarts:
//   1. A receiver killed without a goodbye starts again under the name it used before: the name is taken, the new
//      advertisement is dropped, and senders never list the receiver (or list only the dead one).
//   2. A receiver whose address changes advertises again under the same name: dropped the same way.
//   3. The old record goes down later: a sender drops the receiver by its id while its new record is live.
// Not covered here: a cache that answers the old record after the new one. The record heard last wins, so a sender
// can hold the old LAN address until its next browse; it then reaches the receiver over the DHT instead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createCastController, createReceiver } from '../src/cast.js'
import { createLan } from '../src/lan.js'
import { mdnsBus } from './mdns.js'

const tmp = label => mkdtempSync(join(tmpdir(), `peartube-cast-mdns-${label}-`))

async function waitFor (fn, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const val = fn()
    if (val) return val
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test('a receiver restarted without a goodbye is listed again on a network that remembers names', { timeout: 60_000 }, async t => {
  const testnet = await createTestnet(3)
  const bus = mdnsBus({ goodbyes: true })
  const lanBus = mdnsBus()
  const used = new Set()
  // Like bonjour-service on a network with a cache: a name heard before is dropped without an error.
  const remembers = adapter => ({
    advertise (record, handlers) {
      if (used.has(record.name)) return { stop: async () => {} }
      used.add(record.name)
      return adapter.advertise(record, handlers)
    },
    browse: (query, handlers) => adapter.browse(query, handlers)
  })
  // A killed receiver sends no goodbye: the cache keeps answering for its record until `goodbye()`.
  const killed = []
  const killable = adapter => ({
    advertise (record, handlers) {
      const handle = adapter.advertise(record, handlers)
      killed.push(handle)
      return { stop: async () => {} }
    },
    browse: (query, handlers) => adapter.browse(query, handlers)
  })
  const open = label => createNode({
    storage: tmp(label),
    bootstrap: testnet.bootstrap,
    lan: keyPair => createLan({ host: '127.0.0.1', keyPair, adapter: lanBus(), dialAfter: 200 })
  })
  const castDir = tmp('tv-cast')
  const node1 = await open('tv-node-1')
  const node2 = await open('tv-node-2')
  let tv2 = null
  let cast = null
  t.after(async () => {
    await cast?.close()
    await tv2?.close()
    await node2.close()
    await node1.close()
    await testnet.destroy()
  })

  const tv1 = await createReceiver({ storage: castDir, name: 'Pi TV', port: 0, lanHost: '127.0.0.1', node: node1, adapter: remembers(killable(bus())) })
  await tv1.close()
  await node1.close()

  // The same receiver (same storage, so the same id and display name) starts again.
  tv2 = await createReceiver({ storage: castDir, name: 'Pi TV', port: 0, lanHost: '127.0.0.1', node: node2, adapter: remembers(bus()) })
  assert.equal(tv2.deviceId, tv1.deviceId)

  cast = createCastController({ storage: tmp('phone-cast'), getNode: () => null, adapter: remembers(bus()) })
  await cast.setLanHost('127.0.0.1')
  const live = () => cast.listReceivers().find(r => r.id === tv2.deviceId && r.publicKey === node2.peerKey)
  await waitFor(live, 'the restarted receiver at its new key')

  // The old record's goodbye comes late (a cache or reflector passing it on): the live receiver stays listed.
  for (const handle of killed) await handle.stop()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(live(), 'the old record going down does not remove the live receiver')

  // The receiver moves to another address and advertises again: senders follow it.
  await tv2.setHost('127.0.0.2')
  await waitFor(() => live()?.host === '127.0.0.2', 'the receiver at its new address')
})
