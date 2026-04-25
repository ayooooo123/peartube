import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import Hypercore from 'hypercore'

import { channelDiscoveryTopic, createDriveDiscoveryNetwork } from '../src/index.mjs'

test('channelDiscoveryTopic derives the Hypercore discovery key for a channel key', () => {
  const channelKey = '11'.repeat(32)
  const topic = channelDiscoveryTopic(channelKey)

  assert.deepEqual(Buffer.from(topic), Buffer.from(Hypercore.discoveryKey(Buffer.from(channelKey, 'hex'))))
})

test('createDriveDiscoveryNetwork joins discovery and replicates store connections', async () => {
  const channelKey = '22'.repeat(32)
  const swarm = new FakeSwarm()
  const store = new FakeStore()

  const network = createDriveDiscoveryNetwork({ store, channelKey, swarm, announce: true, lookup: false })

  assert.equal(swarm.joins.length, 1)
  assert.deepEqual(Buffer.from(swarm.joins[0].topic), Buffer.from(Hypercore.discoveryKey(Buffer.from(channelKey, 'hex'))))
  assert.deepEqual(swarm.joins[0].options, { server: true, client: false })

  const conn = { id: 'peer-connection' }
  swarm.emit('connection', conn)
  assert.deepEqual(store.replicated, [conn])

  await network.close()
  assert.equal(swarm.destroyed, true)
})

test('engine startDiscovery wires the engine store and channel key into discovery', async () => {
  const { createEngine } = await import('../src/index.mjs')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const engine = await createEngine({ storagePath: await mkdtemp(join(tmpdir(), 'peartube-engine-network-')) })
  const swarm = new FakeSwarm()

  try {
    const network = engine.startDiscovery({ swarm, announce: true, lookup: true })
    assert.equal(network, engine.network)
    assert.equal(swarm.joins.length, 1)
    assert.deepEqual(Buffer.from(swarm.joins[0].topic), Buffer.from(Hypercore.discoveryKey(Buffer.from(engine.channelKey, 'hex'))))

    const conn = { id: 'engine-peer' }
    swarm.emit('connection', conn)
    assert.equal(swarm.destroyed, false)

    await engine.close()
    assert.equal(swarm.destroyed, true)
  } finally {
    await engine.close().catch(() => {})
  }
})

class FakeSwarm extends EventEmitter {
  constructor() {
    super()
    this.joins = []
    this.destroyed = false
  }

  join(topic, options) {
    this.joins.push({ topic, options })
    return {
      flushed() {
        return Promise.resolve()
      },
      destroy() {}
    }
  }

  async destroy() {
    this.destroyed = true
  }
}

class FakeStore {
  constructor() {
    this.replicated = []
  }

  replicate(conn) {
    this.replicated.push(conn)
  }
}
