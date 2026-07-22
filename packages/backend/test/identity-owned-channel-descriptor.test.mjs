import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import IdentityKey from 'keet-identity-key'

import { createIdentityManager } from '../src/identity.js'
import { verifySignedChannelRootDescriptor } from '../src/channel-descriptor.js'

function hexKey (fill) {
  return Buffer.alloc(32, fill).toString('hex')
}

// Minimal metaDb stub backing the identity manager's persistence.
function createMetaDb (seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    async get (key) {
      return store.has(key) ? { value: store.get(key) } : null
    },
    async put (key, value) { store.set(key, value) },
  }
}

// A grouped archive channel: writable public bee, no channel/root descriptor yet.
function createGroupedChannel ({ keyHex, publicBeeKey, blobsKeyHex }) {
  let root = null
  return {
    keyHex,
    publicBeeKey,
    blobsKeyHex,
    name: 'Severance',
    publicBee: {
      writable: true,
      async getRootDescriptor () { return root },
      async setRootDescriptor (signed) { root = signed },
      async setMetadata () {},
    },
  }
}

async function bootstrapActiveIdentity () {
  const mnemonic = IdentityKey.generateMnemonic()
  const identity = await IdentityKey.from({ mnemonic })
  const device = crypto.keyPair()
  const proof = await identity.bootstrap(device.publicKey)
  return {
    identityPublicKey: b4a.toString(identity.identityPublicKey, 'hex'),
    proofHex: b4a.toString(proof, 'hex'),
    device,
  }
}

test('signs a grouped channel root descriptor bound to the channel key, vouched by the active identity', async () => {
  const { identityPublicKey, proofHex, device } = await bootstrapActiveIdentity()
  const channelKey = hexKey(0xaa)
  const publicBeeKey = hexKey(0xbb)
  const blobsKeyHex = hexKey(0xcc)

  const metaDb = createMetaDb({
    identities: [{
      publicKey: identityPublicKey,
      channelKey: hexKey(0x11),
      driveKey: hexKey(0x11),
      name: 'Relay',
      signedDescriptor: { proof: proofHex },
    }],
    activeIdentity: identityPublicKey,
  })
  const ctx = { metaDb, swarm: { keyPair: device } }
  const manager = createIdentityManager({ ctx })
  await manager.loadIdentities()

  const channel = createGroupedChannel({ keyHex: channelKey, publicBeeKey, blobsKeyHex })
  const result = await manager.signChannelRootDescriptorForOwnedChannel(channel, { profile: { name: 'Severance' } })

  assert.equal(result.ok, true)
  assert.equal(result.changed, true)

  const written = await channel.publicBee.getRootDescriptor()
  const verified = await verifySignedChannelRootDescriptor(written)
  assert.equal(verified.valid, true)
  // The descriptor must bind to the grouped channel key (what the entry is
  // announced under), not the vouching identity key — otherwise strict peers
  // reject with descriptor-channel-mismatch.
  assert.equal(verified.descriptor.channelId, channelKey)
  assert.equal(verified.descriptor.metadataKey, publicBeeKey)
  assert.equal(verified.descriptor.mediaKey, blobsKeyHex)
  assert.equal(verified.identityPublicKey, identityPublicKey)
})

test('is idempotent when a valid descriptor already exists', async () => {
  const { identityPublicKey, proofHex, device } = await bootstrapActiveIdentity()
  const channelKey = hexKey(0xa1)
  const metaDb = createMetaDb({
    identities: [{ publicKey: identityPublicKey, channelKey: hexKey(0x12), driveKey: hexKey(0x12), name: 'Relay', signedDescriptor: { proof: proofHex } }],
    activeIdentity: identityPublicKey,
  })
  const manager = createIdentityManager({ ctx: { metaDb, swarm: { keyPair: device } } })
  await manager.loadIdentities()

  const channel = createGroupedChannel({ keyHex: channelKey, publicBeeKey: hexKey(0xb1), blobsKeyHex: hexKey(0xc1) })
  const first = await manager.signChannelRootDescriptorForOwnedChannel(channel)
  assert.equal(first.changed, true)
  const second = await manager.signChannelRootDescriptorForOwnedChannel(channel)
  assert.equal(second.ok, true)
  assert.equal(second.changed, false)
})

test('fails closed without an active identity proof', async () => {
  const device = crypto.keyPair()
  const metaDb = createMetaDb({
    identities: [{ publicKey: hexKey(0x99), channelKey: hexKey(0x13), driveKey: hexKey(0x13), name: 'Relay' }],
    activeIdentity: hexKey(0x99),
  })
  const manager = createIdentityManager({ ctx: { metaDb, swarm: { keyPair: device } } })
  await manager.loadIdentities()

  const channel = createGroupedChannel({ keyHex: hexKey(0xa2), publicBeeKey: hexKey(0xb2), blobsKeyHex: hexKey(0xc2) })
  const result = await manager.signChannelRootDescriptorForOwnedChannel(channel)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'active-identity-proof-unavailable')
})
