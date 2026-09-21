import test from 'node:test'
import assert from 'node:assert/strict'

import { attachUpdateDriveReplication } from '../backend/pear-update-replication.mjs'

function createCore (name) {
  return {
    name,
    discoveryKey: Buffer.from(name.padEnd(32, '.')),
    replicated: [],
    replicate (mux) {
      this.replicated.push(mux)
    },
  }
}

function createDrive () {
  const listeners = new Map()
  return {
    core: createCore('drive-core'),
    blobs: null,
    on (event, listener) {
      listeners.set(event, listener)
    },
    removeListener (event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event)
    },
    emit (event, value) {
      listeners.get(event)?.(value)
    },
    listenerCount (event) {
      return listeners.has(event) ? 1 : 0
    },
  }
}

function createSwarm (connections = []) {
  return {
    connections,
    listeners: [],
    joined: [],
    on (event, listener) {
      if (event === 'connection') this.listeners.push(listener)
    },
    removeListener (event, listener) {
      if (event !== 'connection') return
      this.listeners = this.listeners.filter((entry) => entry !== listener)
    },
    join (discoveryKey, options) {
      this.joined.push({ discoveryKey, options })
      return { destroy: async () => {} }
    },
    connect (connection) {
      this.connections.push(connection)
      for (const listener of this.listeners) listener(connection)
    },
  }
}

// `Protomux.from` returns an object that already reports `isProtomux`, so a
// bare marker stands in for a real muxed connection.
const connection = (id) => ({ isProtomux: true, id })

test('the drive core is attached to a shared swarm under a client-only topic join', () => {
  const existing = connection('existing')
  const swarm = createSwarm([existing])
  const drive = createDrive()

  attachUpdateDriveReplication({ swarm, drive })

  assert.deepEqual(drive.core.replicated, [existing])
  assert.equal(swarm.joined.length, 1)
  assert.deepEqual(swarm.joined[0].options, { client: true, server: false })
  assert.equal(swarm.joined[0].discoveryKey, drive.core.discoveryKey)
})

test('the blobs core replicates once the drive header syncs, on old and new connections', () => {
  const existing = connection('existing')
  const swarm = createSwarm([existing])
  const drive = createDrive()

  attachUpdateDriveReplication({ swarm, drive })

  const blobsCore = createCore('blobs-core')
  drive.emit('blobs', { core: blobsCore })
  assert.deepEqual(blobsCore.replicated, [existing], 'a late blobs core catches up on live connections')

  const fresh = connection('fresh')
  swarm.connect(fresh)
  assert.deepEqual(drive.core.replicated, [existing, fresh])
  assert.deepEqual(blobsCore.replicated, [existing, fresh])
})

test('a core is offered to each connection exactly once', () => {
  const swarm = createSwarm([])
  const drive = createDrive()
  const blobsCore = createCore('blobs-core')
  drive.blobs = { core: blobsCore }

  attachUpdateDriveReplication({ swarm, drive })

  // The header may already have synced, so `blobs` can fire for a core that
  // was attached from `drive.blobs` at construction.
  drive.emit('blobs', { core: blobsCore })

  const only = connection('only')
  swarm.connect(only)
  assert.deepEqual(blobsCore.replicated, [only])
})

test('detach stops replicating and releases both listeners', () => {
  const swarm = createSwarm([])
  const drive = createDrive()

  const { detach } = attachUpdateDriveReplication({ swarm, drive })
  detach()

  swarm.connect(connection('after-detach'))
  assert.deepEqual(drive.core.replicated, [])
  assert.equal(swarm.listeners.length, 0)
  assert.equal(drive.listenerCount('blobs'), 0)
})

test('a failing core reports the stage and leaves the rest attached', () => {
  const swarm = createSwarm([])
  const drive = createDrive()
  const failures = []

  attachUpdateDriveReplication({
    swarm,
    drive,
    onError: (error, stage) => failures.push({ message: error.message, stage }),
  })

  const blobsCore = createCore('blobs-core')
  blobsCore.replicate = () => { throw new Error('channel closed') }
  drive.emit('blobs', { core: blobsCore })

  swarm.connect(connection('live'))

  assert.deepEqual(failures, [{ message: 'channel closed', stage: 'replicate' }])
  assert.equal(drive.core.replicated.length, 1, 'the drive core still replicates')
})

test('a swarm that refuses the topic join still returns a usable handle', () => {
  const swarm = createSwarm([])
  swarm.join = () => { throw new Error('swarm destroyed') }
  const drive = createDrive()
  const failures = []

  const { discovery, detach } = attachUpdateDriveReplication({
    swarm,
    drive,
    onError: (error, stage) => failures.push(stage),
  })

  assert.equal(discovery, null)
  assert.deepEqual(failures, ['join'])
  detach()
})
