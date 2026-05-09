import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import IdentityKey from 'keet-identity-key'

import {
  createChannelRootDescriptor,
  signChannelRootDescriptor,
  verifySignedChannelRootDescriptor,
  CHANNEL_ROOT_DESCRIPTOR_SCHEMA
} from '../src/channel-descriptor.js'

function hexKey (fill) {
  return Buffer.alloc(32, fill).toString('hex')
}

test('signed channel root descriptors authorize metadata and media keys through an attested device', async () => {
  const mnemonic = IdentityKey.generateMnemonic()
  const identity = await IdentityKey.from({ mnemonic })
  const device = crypto.keyPair()
  const proof = await identity.bootstrap(device.publicKey)

  const descriptor = createChannelRootDescriptor({
    identityPublicKey: b4a.toString(identity.identityPublicKey, 'hex'),
    metadataKey: hexKey(1),
    mediaKey: hexKey(2),
    seq: 7,
    createdAt: 111,
    updatedAt: 222,
    profile: { name: 'Booraka' }
  })

  assert.equal(descriptor.schema, CHANNEL_ROOT_DESCRIPTOR_SCHEMA)
  assert.equal(descriptor.channelId, b4a.toString(identity.identityPublicKey, 'hex'))

  const signed = await signChannelRootDescriptor({ descriptor, deviceKeyPair: device, deviceProof: proof })
  const verified = await verifySignedChannelRootDescriptor(signed)

  assert.equal(verified.valid, true)
  assert.equal(verified.descriptor.metadataKey, hexKey(1))
  assert.equal(verified.descriptor.mediaKey, hexKey(2))
  assert.equal(verified.identityPublicKey, descriptor.identityPublicKey)
  assert.equal(verified.devicePublicKey, b4a.toString(device.publicKey, 'hex'))
})

test('descriptor verification rejects tampered metadata/media mappings', async () => {
  const mnemonic = IdentityKey.generateMnemonic()
  const identity = await IdentityKey.from({ mnemonic })
  const device = crypto.keyPair()
  const proof = await identity.bootstrap(device.publicKey)

  const descriptor = createChannelRootDescriptor({
    identityPublicKey: b4a.toString(identity.identityPublicKey, 'hex'),
    metadataKey: hexKey(3),
    mediaKey: hexKey(4),
    seq: 1,
    createdAt: 10,
    updatedAt: 20
  })
  const signed = await signChannelRootDescriptor({ descriptor, deviceKeyPair: device, deviceProof: proof })

  const tampered = {
    ...signed,
    descriptor: {
      ...signed.descriptor,
      mediaKey: hexKey(9)
    }
  }

  const verified = await verifySignedChannelRootDescriptor(tampered)
  assert.equal(verified.valid, false)
})

test('descriptor creation validates canonical 32-byte hex keys and monotonic seq fields', () => {
  assert.throws(() => createChannelRootDescriptor({
    identityPublicKey: 'bad',
    metadataKey: hexKey(1),
    mediaKey: hexKey(2)
  }), /identityPublicKey/)

  assert.throws(() => createChannelRootDescriptor({
    identityPublicKey: hexKey(0),
    metadataKey: hexKey(1),
    mediaKey: hexKey(2),
    seq: -1
  }), /seq/)
})
