import b4a from 'b4a'
import test from 'brittle'

import { createIdentityManager } from '../src/identity.js'
import { createBackendSeedPinAdmission } from '../src/seed-pin/admission.js'
import { resolveSeedPinClientAuth } from '../src/seed-pin/registration.js'
import { startBackendSeedPin } from '../src/orchestrator.js'

const OWNED_IDENTITY = '11'.repeat(32)
const FOREIGN_IDENTITY = '12'.repeat(32)
const OWNED_CHANNEL = '21'.repeat(32)
const PAIRED_CHANNEL = '22'.repeat(32)
const FOREIGN_CHANNEL = '23'.repeat(32)
const DEVICE_KEY = b4a.alloc(32, 0x31)
const PROOF = b4a.alloc(64, 0x41)

function verifiedFacts (identityPublicKey = OWNED_IDENTITY, channelKey = OWNED_CHANNEL) {
  return Object.freeze({
    valid: true,
    identityPublicKey,
    requesterDevicePublicKey: b4a.toString(DEVICE_KEY, 'hex'),
    channelKey,
  })
}

test('backend admission accepts only a verified owned identity targeting a live owned or paired channel', async (t) => {
  const accesses = new Map([
    [OWNED_CHANNEL, 'owned'],
    [PAIRED_CHANNEL, 'paired'],
  ])
  let lastLookup = null
  const identityManager = {
    getSeedPinOwnershipFacts (query) {
      lastLookup = query
      return {
        identityOwned: query.identityPublicKey === OWNED_IDENTITY,
        channelAccess: accesses.get(query.channelKey) || null,
      }
    },
  }
  const admission = createBackendSeedPinAdmission({ identityManager })

  t.is(await admission({ verified: verifiedFacts() }), true)
  t.alike(lastLookup, {
    identityPublicKey: OWNED_IDENTITY,
    channelKey: OWNED_CHANNEL,
  }, 'only normalized authorization facts are looked up')
  t.is(await admission({ verified: verifiedFacts(OWNED_IDENTITY, PAIRED_CHANNEL) }), true)
  t.is(await admission({ verified: verifiedFacts(FOREIGN_IDENTITY, OWNED_CHANNEL) }), false)
  t.is(await admission({ verified: verifiedFacts(OWNED_IDENTITY, FOREIGN_CHANNEL) }), false)

  accesses.delete(PAIRED_CHANNEL)
  t.is(await admission({ verified: verifiedFacts(OWNED_IDENTITY, PAIRED_CHANNEL) }), false, 'deleted pairing rejects without cached authorization')
})

test('backend admission fails closed on malformed facts, manager errors, and transport-key allowlists', async (t) => {
  const remotePublicKey = '31'.repeat(32)
  const admission = createBackendSeedPinAdmission({
    identityManager: {
      getSeedPinOwnershipFacts () { throw new Error('metadata unavailable') },
    },
  })

  t.is(await admission({ verified: verifiedFacts(), remotePublicKey, trustedRelayKeys: [remotePublicKey] }), false)
  t.is(await admission({ verified: { ...verifiedFacts(), valid: false } }), false)
  t.is(await admission({ verified: { ...verifiedFacts(), identityPublicKey: OWNED_IDENTITY.toUpperCase() } }), false)
  t.is(await admission({ request: { manifest: { channelKey: OWNED_CHANNEL } } }), false, 'raw request fields are not authorization facts')
})

test('backend seed-pin startup wires live owner authorization into every receiver', async (t) => {
  let registrationOptions = null
  const identityManager = {
    getSeedPinOwnershipFacts ({ identityPublicKey, channelKey }) {
      return {
        identityOwned: identityPublicKey === OWNED_IDENTITY,
        channelAccess: channelKey === OWNED_CHANNEL ? 'owned' : null,
      }
    },
  }
  const registration = {
    ready: Promise.resolve(),
    refreshClientAuthCalls: 0,
    async refreshClientAuth () { this.refreshClientAuthCalls++ },
    async unregister () {},
  }
  const ctx = {
    lifecycle: { own () {} },
    seedPinRegistration: null,
  }

  const result = await startBackendSeedPin({
    ctx,
    identityManager,
    register: (runtimeCtx, options) => {
      t.is(runtimeCtx, ctx)
      registrationOptions = options
      return registration
    },
    resolveClientAuth: async () => null,
  })

  t.is(result, registration)
  t.is(registration.refreshClientAuthCalls, 1)
  t.is(await registrationOptions.admission({ verified: verifiedFacts() }), true)
  t.is(
    await registrationOptions.admission({ verified: verifiedFacts(FOREIGN_IDENTITY, OWNED_CHANNEL) }),
    false,
    'a valid foreign publisher signature is not sufficient for receiver admission',
  )
  t.is(
    await registrationOptions.admission({ verified: verifiedFacts(OWNED_IDENTITY, FOREIGN_CHANNEL) }),
    false,
    'an unowned channel is rejected before storage or worker scheduling',
  )
})

test('identity manager exposes narrow live owned/paired authorization facts', async (t) => {
  const signedDescriptor = {
    schema: 'peartube.channel.root.signed.v1',
    proof: b4a.toString(PROOF, 'hex'),
    descriptor: {
      identityPublicKey: OWNED_IDENTITY,
      channelId: OWNED_CHANNEL,
    },
  }
  const stored = [
    {
      publicKey: OWNED_IDENTITY,
      channelKey: OWNED_CHANNEL,
      driveKey: OWNED_CHANNEL,
      channelWriterKeyName: 'writer:owned',
      signedDescriptor,
      isActive: true,
      createdAt: 1,
    },
    {
      publicKey: FOREIGN_IDENTITY,
      channelKey: PAIRED_CHANNEL,
      driveKey: PAIRED_CHANNEL,
      paired: true,
      isActive: false,
      createdAt: 2,
    },
  ]
  const values = new Map([
    ['identities', stored],
    ['activeIdentity', OWNED_IDENTITY],
  ])
  const ctx = {
    metaDb: {
      async get (key) { return values.has(key) ? { value: values.get(key) } : null },
      async put (key, value) { values.set(key, value) },
    },
  }
  const manager = createIdentityManager({ ctx })
  await manager.loadIdentities()

  t.alike(manager.getSeedPinOwnershipFacts({ identityPublicKey: OWNED_IDENTITY, channelKey: OWNED_CHANNEL }), {
    identityOwned: true,
    channelAccess: 'owned',
  })
  t.alike(manager.getSeedPinOwnershipFacts({ identityPublicKey: OWNED_IDENTITY, channelKey: PAIRED_CHANNEL }), {
    identityOwned: true,
    channelAccess: 'paired',
  })
  t.alike(manager.getSeedPinOwnershipFacts({ identityPublicKey: FOREIGN_IDENTITY, channelKey: PAIRED_CHANNEL }), {
    identityOwned: false,
    channelAccess: 'paired',
  })
  t.alike(manager.getActiveSeedPinCandidate(), {
    identityPublicKey: OWNED_IDENTITY,
    channelKey: OWNED_CHANNEL,
    deviceProof: PROOF,
    signedDescriptor,
  })
})

test('client auth resolver requires the stored descriptor proof to bind the active device, identity, and channel', async (t) => {
  const signedDescriptor = {
    schema: 'peartube.channel.root.signed.v1',
    proof: b4a.toString(PROOF, 'hex'),
    descriptor: { identityPublicKey: OWNED_IDENTITY, channelId: OWNED_CHANNEL },
  }
  const identityManager = {
    getActiveSeedPinCandidate () {
      return {
        identityPublicKey: OWNED_IDENTITY,
        channelKey: OWNED_CHANNEL,
        deviceProof: PROOF,
        signedDescriptor,
      }
    },
  }
  const deviceKeyPair = { publicKey: DEVICE_KEY, secretKey: b4a.alloc(64, 0x32) }
  const validVerification = {
    valid: true,
    identityPublicKey: OWNED_IDENTITY,
    devicePublicKey: b4a.toString(DEVICE_KEY, 'hex'),
    descriptor: signedDescriptor.descriptor,
  }

  const auth = await resolveSeedPinClientAuth({
    ctx: { swarm: { keyPair: deviceKeyPair } },
    identityManager,
    verifySignedDescriptor: async () => validVerification,
  })
  t.is(auth.identityPublicKey, OWNED_IDENTITY)
  t.is(auth.deviceKeyPair, deviceKeyPair)
  t.alike(auth.deviceProof, PROOF)
  t.is(auth.signedDescriptor, signedDescriptor)

  const wrongDevice = await resolveSeedPinClientAuth({
    ctx: { swarm: { keyPair: deviceKeyPair } },
    identityManager,
    verifySignedDescriptor: async () => ({ ...validVerification, devicePublicKey: 'ff'.repeat(32) }),
  })
  t.is(wrongDevice, null)

  identityManager.getActiveSeedPinCandidate = () => null
  t.is(await resolveSeedPinClientAuth({
    ctx: { swarm: { keyPair: deviceKeyPair } },
    identityManager,
    verifySignedDescriptor: async () => validVerification,
  }), null)
})
