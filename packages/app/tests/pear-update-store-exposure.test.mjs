/**
 * What an update peer can actually read off a running device.
 *
 * The helper tests next door prove the wiring in isolation with fakes. This
 * one runs two real Corestores over a real Noise stream and asks the only
 * question that matters: with the mobile updater attached to the connection,
 * can the peer pull anything out of the backend's store besides the update?
 *
 * The `blanket store.replicate` case is the shipped-then-fixed behaviour. It
 * is kept as the contrast: without it, an assertion that a private core stays
 * unreadable proves nothing, because it would also pass against a peer that
 * was never connected at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import SecretStream from '@hyperswarm/secret-stream'
import b4a from 'b4a'

import { attachUpdateDriveReplication } from '../backend/pear-update-replication.mjs'

const PAYLOAD = b4a.from('ota-payload-bytes')
const PRIVATE = b4a.from('a viewer watch record')
const PROBE_TIMEOUT_MS = 800

function tmpdir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `peartube-${label}-`))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ } })
  return dir
}

/**
 * A device: the backend's root store, one private core in it, and the update
 * drive on its own namespace — exactly the layout `startPearUpdates` builds.
 */
async function createDevice(t, label) {
  const store = new Corestore(tmpdir(t, label))
  await store.ready()
  t.after(() => store.close())

  const drive = new Hyperdrive(store.namespace('pear-runtime'))
  await drive.ready()
  await drive.put('/by-arch/android-arm64/app/app.bundle', PAYLOAD)
  await drive.getBlobs()

  const privateCore = store.get({ name: 'personal-watch-history' })
  await privateCore.append(PRIVATE)

  return { store, drive, privateCore }
}

/** The peer that wants the update, and also wants everything else. */
async function createUpdatePeer(t, label, { driveKey, privateKey }) {
  const store = new Corestore(tmpdir(t, label))
  await store.ready()
  t.after(() => store.close())

  const mirror = new Hyperdrive(store, driveKey)
  await mirror.ready()
  // Knowing a core's key is the whole attack: Corestore answers a
  // discovery-key probe for any core on disk when the store is replicated.
  const probe = store.get({ key: privateKey })
  await probe.ready()

  return { store, mirror, probe }
}

function connect() {
  const initiator = new SecretStream(true)
  const responder = new SecretStream(false)
  initiator.rawStream.pipe(responder.rawStream).pipe(initiator.rawStream)
  return { initiator, responder }
}

async function readPrivate(probe) {
  try {
    const block = await probe.get(0, { timeout: PROBE_TIMEOUT_MS })
    return block === null ? null : b4a.toString(block)
  } catch {
    return null
  }
}

test('an update peer gets the payload and nothing else off the device store', async (t) => {
  const device = await createDevice(t, 'device')
  const peer = await createUpdatePeer(t, 'peer', {
    driveKey: device.drive.key,
    privateKey: device.privateCore.key,
  })

  const { initiator, responder } = connect()
  const swarm = {
    connections: [initiator],
    on() {},
    removeListener() {},
    join: () => ({ destroy: async () => {} }),
  }

  const { detach } = attachUpdateDriveReplication({ swarm, drive: device.drive })
  t.after(detach)
  peer.store.replicate(responder)

  await peer.mirror.core.update({ wait: true })
  const payload = await peer.mirror.get('/by-arch/android-arm64/app/app.bundle')

  assert.equal(payload && b4a.toString(payload), b4a.toString(PAYLOAD), 'the update replicates')
  assert.equal(await readPrivate(peer.probe), null, 'the private core stays unreadable')
})

test('a blanket store replicate hands the same peer the private core', async (t) => {
  const device = await createDevice(t, 'device-blanket')
  const peer = await createUpdatePeer(t, 'peer-blanket', {
    driveKey: device.drive.key,
    privateKey: device.privateCore.key,
  })

  const { initiator, responder } = connect()
  // The shipped mobile wiring: `store.replicate(connection)` on the root store.
  device.store.replicate(initiator)
  peer.store.replicate(responder)

  await peer.mirror.core.update({ wait: true })
  const payload = await peer.mirror.get('/by-arch/android-arm64/app/app.bundle')

  assert.equal(payload && b4a.toString(payload), b4a.toString(PAYLOAD))
  assert.equal(
    await readPrivate(peer.probe),
    b4a.toString(PRIVATE),
    'the contrast case must leak, or the test above proves nothing',
  )
})
