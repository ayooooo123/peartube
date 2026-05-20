import test from 'node:test'
import assert from 'node:assert/strict'

import { createDescriptorBloom, decodeDescriptorBloom } from '../src/gossip/bloom.js'
import { createGossipSync, validateIncomingDescriptor, validateIncomingProof } from '../src/gossip/sync.js'

function descriptor(id, now = Date.now()) {
  return {
    descriptorId: id,
    expiresAt: now + 60_000,
    publishAt: now,
    availabilityEpoch: Math.floor(now / 600_000),
    flags: 0,
  }
}

test('descriptor bloom decode preserves advertised geometry', () => {
  const bloom = createDescriptorBloom({ size: 2048, hashCount: 7 })
  const ids = Array.from({ length: 40 }, (_, i) => `descriptor-${i}`)
  for (const id of ids) bloom.add(id)

  const decoded = decodeDescriptorBloom(bloom.serialize())

  assert.equal(decoded.size, 2048)
  assert.equal(decoded.hashCount, 7)
  for (const id of ids) assert.equal(decoded.has(id), true, `${id} should survive bloom round-trip`)
})

test('gossip ingress fails closed without explicit signature verifier or test bypass', async () => {
  const entry = descriptor('aa'.repeat(32))

  assert.deepEqual(
    await validateIncomingDescriptor(entry, { now: Date.now() }),
    { ok: false, reason: 'bad-signature', entry, descriptor: entry },
  )

  assert.equal((await validateIncomingDescriptor(entry, { allowUnsignedForTests: true, now: Date.now() })).ok, true)
  assert.equal((await validateIncomingDescriptor(entry, { verifySignature: async () => true, now: Date.now() })).ok, true)
})

test('gossip exchange offers local descriptors the remote bloom lacks', async () => {
  const now = Date.now()
  const sync = createGossipSync({
    identity: { createdAt: now - 7 * 24 * 60 * 60 * 1000, validProofCount: 4 },
    now,
    allowUnsignedForTests: true,
  })
  const offered = []
  const requested = []
  const remoteBloom = createDescriptorBloom({ size: 512, hashCount: 4 }).serialize()
  const peer = {
    sendBloom: async () => remoteBloom,
    sendDescriptors: async (descriptors) => offered.push(...descriptors),
    requestDescriptors: async (ids) => requested.push(...ids),
    pendingRequests: 0,
  }
  const local = [descriptor('11'.repeat(32), now), descriptor('22'.repeat(32), now)]

  const result = await sync.exchange(peer, local)

  assert.equal(offered.length, result.remoteMissing.length)
  assert.equal(offered.length > 0, true)
  assert.deepEqual(requested, [])
})

test('gossip fanout spends burst quota across repeated calls', async () => {
  const now = Date.now()
  const sync = createGossipSync({
    identity: { createdAt: now, validProofCount: 0, failureCount: 10, quarantined: true },
    now,
    allowUnsignedForTests: true,
  })
  sync.state.quota.reset(1)
  const peers = [{ sendBloom: async () => {} }, { sendBloom: async () => {} }]

  assert.equal(await sync.fanout(peers, []), 1)
  assert.equal(await sync.fanout(peers, []), 0)
})

test('proof ingest marks proof descriptor ids as known', async () => {
  const now = Date.now()
  const sync = createGossipSync({ now, allowUnsignedForTests: true })
  const id = '33'.repeat(32)
  const accepted = await sync.ingest([{ proof: { descriptorId: id, observedAt: now, expiresAt: now + 60_000 } }])

  assert.equal(accepted.length, 1)
  assert.equal(sync.state.bloom.has(id), true)
  assert.equal(sync.state.knownDescriptors.includes(id), true)
})


test('gossip exchange reports the actual missing descriptor set, not a sentinel string', async () => {
  const now = Date.now()
  const sync = createGossipSync({
    identity: { createdAt: now - 7 * 24 * 60 * 60 * 1000, validProofCount: 4 },
    now,
    allowUnsignedForTests: true,
  })
  const remoteBloom = createDescriptorBloom({ size: 512, hashCount: 4 })
  const known = descriptor('44'.repeat(32), now)
  const missing = descriptor('55'.repeat(32), now)
  remoteBloom.add(known.descriptorId)
  const offered = []
  const peer = {
    sendBloom: async () => remoteBloom.serialize(),
    sendDescriptors: async (descriptors) => offered.push(...descriptors),
  }

  const result = await sync.exchange(peer, [known, missing])

  assert.deepEqual(result.missing.map((item) => item.descriptorId), [missing.descriptorId])
  assert.deepEqual(result.remoteMissing.map((item) => item.descriptorId), [missing.descriptorId])
  assert.deepEqual(offered.map((item) => item.descriptorId), [missing.descriptorId])
})

test('descriptor and proof validation tolerate modest clock drift and epoch skew', async () => {
  const now = Date.now()
  const skewedDescriptor = descriptor('66'.repeat(32), now)
  skewedDescriptor.publishAt = now + 15 * 60_000
  skewedDescriptor.expiresAt = now - 2 * 60_000
  skewedDescriptor.availabilityEpoch = Math.floor(now / 600_000) + 5

  const descriptorResult = await validateIncomingDescriptor(skewedDescriptor, {
    now,
    allowUnsignedForTests: true,
  })
  assert.equal(descriptorResult.ok, true, descriptorResult.reason)

  const proof = {
    descriptorId: '77'.repeat(32),
    observedAt: now + 15 * 60_000,
    expiresAt: now - 2 * 60_000,
  }
  const proofResult = await validateIncomingProof({ proof }, {
    now,
    allowUnsignedForTests: true,
  })
  assert.equal(proofResult.ok, true, proofResult.reason)
})
