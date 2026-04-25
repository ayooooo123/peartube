import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

import Corestore from 'corestore'
import Autobase from 'autobase'
import b4a from 'b4a'

import { MultiWriterChannel } from '../src/channel/multi-writer-channel.js'

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeFakeConnection() {
  const conn = new EventEmitter()
  conn.destroyed = false
  return conn
}

function makeFakeSwarm(connection) {
  const swarm = new EventEmitter()
  swarm.connections = new Set(connection ? [connection] : [])
  swarm.join = () => ({
    flushed: async () => {},
    destroy() {},
    close() {},
  })
  return swarm
}

async function closeQuietly(resource) {
  if (!resource || typeof resource.close !== 'function') return
  try {
    await resource.close()
  } catch {}
}

test('new channels do not replicate over pre-existing unrelated swarm connections during open', async (t) => {
  const dir = makeTempDir('peartube-channel-bootstrap-')
  const store = new Corestore(dir)
  await store.ready()

  const existingConnection = makeFakeConnection()
  const swarm = makeFakeSwarm(existingConnection)
  const writerKeyPair = await store.createKeyPair('channel-bootstrap-test-writer')

  const originalReplicate = Autobase.prototype.replicate
  const replicateCalls = []
  Autobase.prototype.replicate = function patchedReplicate(conn, ...args) {
    replicateCalls.push({ key: this.key, conn })
    return originalReplicate.call(this, conn, ...args)
  }

  let channel = null
  try {
    channel = new MultiWriterChannel(store, {
      key: null,
      keyPair: writerKeyPair,
      encrypt: false,
      swarm,
    })

    await channel.ready()

    const channelKeyHex = b4a.toString(channel.key, 'hex')
    const channelReplicateCalls = replicateCalls.filter((call) =>
      call.conn === existingConnection && call.key && b4a.toString(call.key, 'hex') === channelKeyHex
    )

    t.is(
      channelReplicateCalls.length,
      0,
      'brand-new channel bootstrap should not replicate on unrelated existing swarm connections'
    )
  } finally {
    Autobase.prototype.replicate = originalReplicate
    await closeQuietly(channel)
    await closeQuietly(store)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
