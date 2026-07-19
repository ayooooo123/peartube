import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'

import b4a from 'b4a'
import test from 'brittle'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import IdentityKey from 'keet-identity-key'
import IdentityEncoding from 'keet-identity-key/lib/encoding.js'
import Protomux from 'protomux'

import {
  createChannelRootDescriptor,
  signChannelRootDescriptor,
} from '../src/channel-descriptor.js'
import { createSeedPinRequest } from '../src/seed-pin/auth.js'
import { createDurableManifest } from '../src/seed-pin/manifest.js'
import {
  MAX_SEED_PIN_FRAME_BYTES,
  MAX_SEED_PIN_PROOF_CHAIN,
  MAX_SEED_PIN_PROOF_HEX_BYTES,
  MAX_SEED_PIN_REFS,
  MAX_STATUS_EXPIRY_WINDOW_MS,
  PIN_REQUEST_ENCODING,
  PIN_RESPONSE_ENCODING,
  SEED_PIN_ERROR_CODES,
  SEED_PIN_PROTOCOL,
  STATUS_REQUEST_ENCODING,
  createSeedPinStatusRequest,
  verifySeedPinStatusRequest,
  seedPinAuthorizationDigest,
  seedPinSuccessResponse,
  SeedPinVerificationLimiter,
} from '../src/seed-pin/protocol.js'
import {
  SeedPinClient,
  MAX_TIMER_DELAY_MS,
  SeedPinProtocolError,
  SeedPinTransportError,
} from '../src/seed-pin/client.js'
import { SeedPinServer } from '../src/seed-pin/server.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const CHANNEL_KEY = '11'.repeat(32)
const OTHER_CHANNEL_KEY = '12'.repeat(32)
const METADATA_KEY = '22'.repeat(32)
const MEDIA_KEY = '33'.repeat(32)
const CORE_A = '44'.repeat(32)
const CORE_B = '55'.repeat(32)
const CORE_C = '66'.repeat(32)
const NOW = 1_900_000_000_000
const EXPIRES_AT = NOW + 60_000
const PROOF_EPOCH = 1_800_000_000_000

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

function flipHexByte (value) {
  const bytes = b4a.from(value, 'hex')
  bytes[0] ^= 0xff
  return b4a.toString(bytes, 'hex')
}

async function bootstrapAt (identity, publicKey, epoch) {
  const originalNow = Date.now
  Date.now = () => epoch
  try {
    return await identity.bootstrap(publicKey)
  } finally {
    Date.now = originalNow
  }
}

function makeManifest (rowId = 'video/seed-pin/1') {
  return createDurableManifest({
    channelKey: CHANNEL_KEY,
    rowId,
    refs: [
      { coreKey: CORE_A, start: 0, end: 8, kind: 'media' },
      { coreKey: CORE_B, start: 2, end: 3, kind: 'thumbnail' },
    ],
    assets: {
      media: [0],
      thumbnail: 1,
      artwork: { avatar: null, poster: null, banner: null, backdrop: null },
    },
  })
}

async function buildFixture () {
  const identity = await IdentityKey.from({ mnemonic: MNEMONIC })
  const otherIdentity = await IdentityKey.from({ mnemonic: OTHER_MNEMONIC })
  const device = crypto.keyPair(b4a.alloc(32, 0x71))
  const otherDevice = crypto.keyPair(b4a.alloc(32, 0x72))
  const proof = await bootstrapAt(identity, device.publicKey, PROOF_EPOCH)
  const otherDeviceProof = await bootstrapAt(identity, otherDevice.publicKey, PROOF_EPOCH + 1)
  const otherIdentityProof = await bootstrapAt(otherIdentity, device.publicKey, PROOF_EPOCH + 2)

  const descriptorInput = {
    channelId: CHANNEL_KEY,
    metadataKey: METADATA_KEY,
    mediaKey: MEDIA_KEY,
    seq: 4,
    createdAt: PROOF_EPOCH,
    updatedAt: PROOF_EPOCH + 10,
    profile: { displayName: 'Seed owner' },
    capabilities: {
      media: 'hyperdrive',
      metadata: 'hyperbee',
      thumbnails: 'inline-or-media-path',
    },
  }
  const descriptor = createChannelRootDescriptor({
    ...descriptorInput,
    identityPublicKey: identity.identityPublicKey,
  })
  const signedDescriptor = await signChannelRootDescriptor({
    descriptor,
    deviceKeyPair: device,
    deviceProof: proof,
  })
  const otherChannelDescriptor = await signChannelRootDescriptor({
    descriptor: createChannelRootDescriptor({
      ...descriptorInput,
      identityPublicKey: identity.identityPublicKey,
      channelId: OTHER_CHANNEL_KEY,
    }),
    deviceKeyPair: device,
    deviceProof: proof,
  })
  const otherIdentityDescriptor = await signChannelRootDescriptor({
    descriptor: createChannelRootDescriptor({
      ...descriptorInput,
      identityPublicKey: otherIdentity.identityPublicKey,
    }),
    deviceKeyPair: device,
    deviceProof: otherIdentityProof,
  })

  const manifest = makeManifest()
  const request = await createSeedPinRequest({
    manifest,
    expiresAt: EXPIRES_AT,
    deviceKeyPair: device,
    deviceProof: proof,
    signedDescriptor,
  })

  return {
    identity,
    otherIdentity,
    device,
    otherDevice,
    proof,
    otherDeviceProof,
    otherIdentityProof,
    signedDescriptor,
    otherChannelDescriptor,
    otherIdentityDescriptor,
    manifest,
    request,
  }
}

let fixturePromise = null
function fixture () {
  if (fixturePromise === null) fixturePromise = buildFixture()
  return fixturePromise
}

async function requestFor (base, rowId, options = {}) {
  return createSeedPinRequest({
    manifest: options.manifest || makeManifest(rowId),
    expiresAt: options.expiresAt ?? EXPIRES_AT,
    deviceKeyPair: options.deviceKeyPair || base.device,
    deviceProof: options.deviceProof || base.proof,
    signedDescriptor: options.signedDescriptor || base.signedDescriptor,
  })
}

class MemoryDuplex extends Duplex {
  constructor () {
    super()
    this.other = null
    this.userData = null
    this.remotePublicKey = null
  }

  _read () {}

  _write (chunk, _encoding, callback) {
    this.other?.push(chunk)
    callback()
  }

  _final (callback) {
    this.other?.push(null)
    callback()
  }
}

function createMemoryConnectionPair (clientPublicKey) {
  const client = new MemoryDuplex()
  const server = new MemoryDuplex()
  client.other = server
  server.other = client
  client.remotePublicKey = b4a.alloc(32, 0xa1)
  server.remotePublicKey = b4a.from(clientPublicKey)
  return [client, server]
}

function ownerFrom (base, device = base.device) {
  return {
    identityPublicKey: b4a.toString(base.identity.identityPublicKey, 'hex'),
    devicePublicKey: b4a.toString(device.publicKey, 'hex'),
  }
}

function acceptedStatus (request, acceptedAt = NOW) {
  return {
    requestId: request.requestId,
    state: 'accepted',
    acceptedAt,
    updatedAt: acceptedAt,
    completedAt: null,
    errorCode: null,
    error: null,
    refs: request.manifest.refs.map((ref) => ({
      ...ref,
      state: 'pending',
      bytesPinned: 0,
    })),
  }
}

class FakePinStore {
  constructor () {
    this.records = new Map()
    this.calls = { get: 0, claim: 0, finalize: 0, insert: 0, status: 0 }
    this.claimError = null
    this.claimOutcome = null
    this.finalizeError = null
    this.finalizeOutcome = null
    this.beforeClaim = null
    this.claimCounter = 0
    this.claimLeaseMs = 30_000
  }

  async getByRequestId (requestId) {
    this.calls.get++
    return this.records.get(requestId) || null
  }

  async claimVerified (input) {
    this.calls.claim++
    if (this.claimError) throw this.claimError
    if (this.beforeClaim) await this.beforeClaim()
    if (this.claimOutcome) return this.claimOutcome
    const existing = this.records.get(input.request.requestId)
    if (existing) {
      const matched = existing.owner.identityPublicKey === input.owner.identityPublicKey &&
        existing.owner.devicePublicKey === input.owner.devicePublicKey &&
        existing.authorizationDigest === input.authorizationDigest
      if (!matched) return { outcome: 'conflict', record: existing, claimToken: null }
      const reclaimable = existing.status.state === 'retryable-admission' ||
        (existing.status.state === 'admitting' && existing.claimExpiresAt <= input.claimedAt)
      if (reclaimable) {
        const claimToken = this.nextClaimToken()
        existing.status = { ...existing.status, state: 'admitting', updatedAt: input.claimedAt }
        existing.claimToken = claimToken
        existing.claimExpiresAt = input.claimedAt + this.claimLeaseMs
        return { outcome: 'claimed', record: existing, claimToken }
      }
      return { outcome: 'matched', record: existing, claimToken: null }
    }
    const claimToken = this.nextClaimToken()
    const status = { ...acceptedStatus(input.request, input.acceptedAt), state: 'admitting' }
    const record = {
      ...input,
      status,
      claimToken,
      claimExpiresAt: input.claimedAt + this.claimLeaseMs,
    }
    this.records.set(input.request.requestId, record)
    this.calls.insert++
    return { outcome: 'claimed', record, claimToken }
  }

  async finalizeAdmission ({ requestId, authorizationDigest, claimToken, decision }) {
    this.calls.finalize++
    if (this.finalizeError) throw this.finalizeError
    if (this.finalizeOutcome) return this.finalizeOutcome
    const record = this.records.get(requestId)
    if (!record || record.authorizationDigest !== authorizationDigest ||
        record.claimToken !== claimToken) {
      return { outcome: 'conflict', record: record || null }
    }
    record.status = {
      ...record.status,
      state: decision.state,
      updatedAt: decision.updatedAt,
      errorCode: decision.code,
      error: decision.error,
    }
    record.claimToken = null
    record.claimExpiresAt = null
    return { outcome: 'finalized', record }
  }

  nextClaimToken () {
    return (++this.claimCounter).toString(16).padStart(64, '0')
  }

  async getOwnedStatus ({ requestId, identityPublicKey, devicePublicKey }) {
    this.calls.status++
    const record = this.records.get(requestId)
    if (!record) return null
    if (record.owner.identityPublicKey !== identityPublicKey) return null
    if (record.owner.devicePublicKey !== devicePublicKey) return null
    return clone(record.status)
  }

  setStatus (requestId, patch) {
    const record = this.records.get(requestId)
    assert(record)
    record.status = { ...record.status, ...clone(patch) }
  }
}

function createWorker (onStart = null) {
  return {
    attempts: [],
    calls: [],
    scheduled: new Set(),
    async start (requestId) {
      this.attempts.push(requestId)
      if (this.scheduled.has(requestId)) return
      if (onStart) await onStart(requestId)
      this.scheduled.add(requestId)
      this.calls.push(requestId)
    },
  }
}

function credentials (base, overrides = {}) {
  return {
    identityPublicKey: overrides.identityPublicKey || base.identity.identityPublicKey,
    deviceKeyPair: overrides.deviceKeyPair || base.device,
    deviceProof: overrides.deviceProof || base.proof,
  }
}

async function createPair (base, options = {}) {
  const store = options.store || new FakePinStore()
  const worker = options.worker || createWorker()
  const remotePublicKey = options.remotePublicKey || base.device.publicKey
  const [clientStream, serverStream] = createMemoryConnectionPair(remotePublicKey)
  const serverMux = Protomux.from(serverStream)
  const clientMux = Protomux.from(clientStream)
  const server = new SeedPinServer(serverMux, {
    remotePublicKey,
    store,
    worker,
    admission: options.admission,
    capacity: options.capacity,
    verificationLimiter: options.verificationLimiter,
    now: options.serverNow || (() => NOW),
  })
  const client = new SeedPinClient(clientMux, {
    ...credentials(base, options.credentials),
    now: options.clientNow || (() => NOW),
    requestTimeout: options.requestTimeout || 1_000,
    statusTtl: options.statusTtl,
  })
  await Promise.all([server.opened(), client.opened()])
  return { client, server, clientStream, serverStream, store, worker }
}

async function closePair (pair) {
  pair.client?.close()
  pair.server?.close()
  pair.clientStream?.destroy()
  pair.serverStream?.destroy()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function expectProtocolCode (promise, code, retryable = false) {
  try {
    await promise
    assert.fail(`expected ${code}`)
  } catch (error) {
    assert(error instanceof SeedPinProtocolError)
    assert.equal(error.code, code)
    assert.equal(error.retryable, retryable)
    assert.equal(typeof error.message, 'string')
    assert(error.message.length > 0)
    return error
  }
}

async function waitFor (predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function createBarrier (parties) {
  let arrived = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  return async () => {
    arrived++
    if (arrived === parties) release()
    await gate
  }
}

function encodeParts (...parts) {
  return b4a.concat(parts.map(([encoding, value]) => c.encode(encoding, value)))
}

test('status requests use canonical IdentityKey device proofs bound to the live key and expiry', async (t) => {
  const base = await fixture()
  const statusRequest = createSeedPinStatusRequest({
    requestId: base.request.requestId,
    expiresAt: EXPIRES_AT,
    ...credentials(base),
  })
  const verified = verifySeedPinStatusRequest(statusRequest, {
    remotePublicKey: base.device.publicKey,
    now: NOW,
  })

  t.is(SEED_PIN_PROTOCOL, 'peartube/seed-pin/1')
  t.is(verified.valid, true)
  t.is(verified.requestId, base.request.requestId)
  t.is(verified.identityPublicKey, b4a.toString(base.identity.identityPublicKey, 'hex'))
  t.is(verified.devicePublicKey, b4a.toString(base.device.publicKey, 'hex'))

  const wrongPeer = verifySeedPinStatusRequest(statusRequest, {
    remotePublicKey: base.otherDevice.publicKey,
    now: NOW,
  })
  t.is(wrongPeer.valid, false)
  const expired = verifySeedPinStatusRequest(statusRequest, {
    remotePublicKey: base.device.publicKey,
    now: EXPIRES_AT,
  })
  t.is(expired.valid, false)

  const nonCanonical = { ...statusRequest, attestation: statusRequest.attestation.toUpperCase() }
  t.is(verifySeedPinStatusRequest(nonCanonical, {
    remotePublicKey: base.device.publicKey,
    now: NOW,
  }).valid, false)
})

test('proof preflight rejects attacker chain counts before package decode', async (t) => {
  const base = await fixture()
  const statusRequest = createSeedPinStatusRequest({
    requestId: base.request.requestId,
    expiresAt: EXPIRES_AT,
    ...credentials(base),
  })
  const proofWithCount = (count) => b4a.toString(encodeParts(
    [c.uint, 1],
    [c.uint64, Math.floor(NOW / 1000)],
    [c.fixed32, base.identity.identityPublicKey],
    [c.uint, count],
  ), 'hex')
  const hugeCount = proofWithCount(0x100000)
  const overLimit = proofWithCount(MAX_SEED_PIN_PROOF_CHAIN + 1)
  const truncatedAtLimit = proofWithCount(MAX_SEED_PIN_PROOF_CHAIN)
  const originalDecode = IdentityEncoding.ProofEncoding.decode
  let decodeCalls = 0
  IdentityEncoding.ProofEncoding.decode = (state) => {
    decodeCalls++
    return originalDecode(state)
  }
  try {
    for (const deviceProof of [hugeCount, overLimit, truncatedAtLimit]) {
      t.is(verifySeedPinStatusRequest({ ...statusRequest, deviceProof }, {
        remotePublicKey: base.device.publicKey,
        now: NOW,
      }).valid, false)
    }
    t.is(decodeCalls, 0)
    assert.throws(() => createSeedPinStatusRequest({
      requestId: base.request.requestId,
      expiresAt: EXPIRES_AT,
      ...credentials(base, { deviceProof: overLimit }),
    }))
    t.is(decodeCalls, 0)

    const attestationResult = verifySeedPinStatusRequest({
      ...statusRequest,
      attestation: hugeCount,
    }, {
      remotePublicKey: base.device.publicKey,
      now: NOW,
    })
    t.is(attestationResult.valid, false)
    t.is(decodeCalls, 2)
  } finally {
    IdentityEncoding.ProofEncoding.decode = originalDecode
  }
})

test('client enforces status expiry and runtime timer boundaries', async (t) => {
  const base = await fixture()
  const pair = await createPair(base, { statusTtl: MAX_STATUS_EXPIRY_WINDOW_MS })
  try {
    await pair.client.pin(base.request)
    t.is((await pair.client.status(base.request.requestId)).state, 'accepted')
  } finally {
    await closePair(pair)
  }

  const createUnopenedClient = (options) => {
    const [clientStream, peerStream] = createMemoryConnectionPair(base.device.publicKey)
    const client = new SeedPinClient(Protomux.from(clientStream), {
      ...credentials(base),
      now: () => NOW,
      ...options,
    })
    return { client, clientStream, peerStream }
  }
  const assertRejectedOptions = (options) => {
    const [clientStream, peerStream] = createMemoryConnectionPair(base.device.publicKey)
    try {
      assert.throws(() => new SeedPinClient(Protomux.from(clientStream), {
        ...credentials(base),
        now: () => NOW,
        ...options,
      }))
    } finally {
      clientStream.destroy()
      peerStream.destroy()
    }
  }
  assertRejectedOptions({ statusTtl: MAX_STATUS_EXPIRY_WINDOW_MS + 1 })
  assertRejectedOptions({ requestTimeout: MAX_TIMER_DELAY_MS + 1 })

  const warnings = []
  const onWarning = (warning) => warnings.push(warning)
  process.on('warning', onWarning)
  const timerClient = createUnopenedClient({ requestTimeout: MAX_TIMER_DELAY_MS })
  try {
    assert.throws(() => timerClient.client.pin(base.request, {
      timeout: MAX_TIMER_DELAY_MS + 1,
    }))
    const pending = timerClient.client.pin(base.request, { timeout: MAX_TIMER_DELAY_MS })
    timerClient.client.close()
    await assert.rejects(pending, SeedPinTransportError)
    await new Promise((resolve) => setTimeout(resolve, 0))
    t.is(warnings.some((warning) => warning.name === 'TimeoutOverflowWarning'), false)
  } finally {
    process.off('warning', onWarning)
    timerClient.client.close()
    timerClient.clientStream.destroy()
    timerClient.peerStream.destroy()
  }

  t.is(verifySeedPinStatusRequest(createSeedPinStatusRequest({
    requestId: base.request.requestId,
    expiresAt: NOW + MAX_STATUS_EXPIRY_WINDOW_MS,
    ...credentials(base),
  }), {
    remotePublicKey: base.device.publicKey,
    now: NOW,
  }).valid, true)
  t.is(verifySeedPinStatusRequest(createSeedPinStatusRequest({
    requestId: base.request.requestId,
    expiresAt: NOW + MAX_STATUS_EXPIRY_WINDOW_MS + 1,
    ...credentials(base),
  }), {
    remotePublicKey: base.device.publicKey,
    now: NOW,
  }).valid, false)
})

test('valid pin admission returns a stable accepted status over paired Protomux', async (t) => {
  const base = await fixture()
  const counts = { admission: 0, capacity: 0 }
  const pair = await createPair(base, {
    admission: async () => { counts.admission++; return true },
    capacity: async () => { counts.capacity++; return true },
  })
  try {
    const status = await pair.client.pin(base.request)
    t.is(status.requestId, base.request.requestId)
    t.is(status.state, 'accepted')
    t.is(status.refs.length, base.manifest.refs.length)
    t.alike(counts, { admission: 1, capacity: 1 })
    t.is(pair.store.calls.claim, 1)
    t.alike(pair.worker.calls, [base.request.requestId])
    const record = pair.store.records.get(base.request.requestId)
    t.alike(record.owner, ownerFrom(base))
    t.ok(/^[0-9a-f]{64}$/.test(record.authorizationDigest))
    t.is(record.acceptedAt, NOW)
  } finally {
    await closePair(pair)
  }
})

test('owned status reports progress and completion', async (t) => {
  const base = await fixture()
  const pair = await createPair(base)
  try {
    await pair.client.pin(base.request)
    pair.store.setStatus(base.request.requestId, {
      state: 'pinning',
      updatedAt: NOW + 10,
      refs: base.manifest.refs.map((ref, index) => ({
        ...ref,
        state: index === 0 ? 'complete' : 'pinning',
        bytesPinned: index === 0 ? ref.end - ref.start : 1,
      })),
    })
    const progress = await pair.client.status(base.request.requestId)
    t.is(progress.state, 'pinning')
    t.is(progress.refs[0].state, 'complete')
    t.is(progress.refs[1].state, 'pinning')

    pair.store.setStatus(base.request.requestId, {
      state: 'complete',
      updatedAt: NOW + 20,
      completedAt: NOW + 20,
      refs: base.manifest.refs.map((ref) => ({
        ...ref,
        state: 'complete',
        bytesPinned: ref.end - ref.start,
      })),
    })
    const complete = await pair.client.status(base.request.requestId)
    t.is(complete.state, 'complete')
    t.is(complete.completedAt, NOW + 20)
    t.ok(complete.refs.every((ref) => ref.state === 'complete'))
  } finally {
    await closePair(pair)
  }
})

test('pin authentication rejects wrong live peer and tampered proof before callbacks', async (t) => {
  const base = await fixture()
  const counts = { admission: 0, capacity: 0 }
  const common = {
    admission: async () => { counts.admission++; return true },
    capacity: async () => { counts.capacity++; return true },
  }

  const wrongPeerPair = await createPair(base, {
    ...common,
    remotePublicKey: base.otherDevice.publicKey,
  })
  try {
    await expectProtocolCode(
      wrongPeerPair.client.pin(base.request),
      SEED_PIN_ERROR_CODES.LIVE_PEER_MISMATCH,
    )
  } finally {
    await closePair(wrongPeerPair)
  }

  const tampered = clone(base.request)
  tampered.signedDescriptor.proof = flipHexByte(tampered.signedDescriptor.proof)
  const tamperedPair = await createPair(base, common)
  try {
    await expectProtocolCode(
      tamperedPair.client.pin(tampered),
      SEED_PIN_ERROR_CODES.INVALID_AUTH,
    )
  } finally {
    await closePair(tamperedPair)
  }

  t.alike(counts, { admission: 0, capacity: 0 })
})

test('pin authentication rejects identity, channel, manifest, ID, and expiry binding failures', async (t) => {
  const base = await fixture()
  const cases = []

  const identity = clone(base.request)
  identity.signedDescriptor = clone(base.otherIdentityDescriptor)
  cases.push([identity, [SEED_PIN_ERROR_CODES.IDENTITY_MISMATCH, SEED_PIN_ERROR_CODES.INVALID_AUTH], NOW])

  const channel = clone(base.request)
  channel.signedDescriptor = clone(base.otherChannelDescriptor)
  cases.push([channel, [SEED_PIN_ERROR_CODES.CHANNEL_MISMATCH], NOW])

  const manifest = clone(base.request)
  manifest.manifest.rowId = 'video/tampered'
  cases.push([manifest, [SEED_PIN_ERROR_CODES.INVALID_REQUEST], NOW])

  const id = clone(base.request)
  id.requestId = flipHexByte(id.requestId)
  cases.push([id, [SEED_PIN_ERROR_CODES.INVALID_REQUEST], NOW])

  cases.push([base.request, [SEED_PIN_ERROR_CODES.EXPIRED], EXPIRES_AT])

  for (const [request, codes, now] of cases) {
    let callbacks = 0
    const pair = await createPair(base, {
      serverNow: () => now,
      admission: async () => { callbacks++; return true },
      capacity: async () => { callbacks++; return true },
    })
    try {
      let error = null
      try {
        await pair.client.pin(request)
      } catch (cause) {
        error = cause
      }
      t.ok(error instanceof SeedPinProtocolError)
      t.ok(codes.includes(error.code), `${error?.code} should be one of ${codes.join(', ')}`)
      t.is(callbacks, 0)
      t.is(pair.store.calls.claim, 0)
      t.is(pair.worker.calls.length, 0)
    } finally {
      await closePair(pair)
    }
  }
})

test('shared verification limiter retains permits through store and admission, rejects bursts, and recovers', async (t) => {
  assert.throws(() => new SeedPinVerificationLimiter({ maxConcurrent: 0 }))
  assert.throws(() => new SeedPinVerificationLimiter({ maxConcurrent: Infinity }))
  const base = await fixture()
  const otherRequest = await requestFor(base, 'video/limiter-burst')
  const maxManifest = createDurableManifest({
    channelKey: CHANNEL_KEY,
    rowId: 'video/limiter-max-refs',
    refs: Array.from({ length: MAX_SEED_PIN_REFS }, (_, index) => ({
      coreKey: CORE_A,
      start: index * 2,
      end: index * 2 + 1,
      kind: 'media',
    })),
    assets: {
      media: Array.from({ length: MAX_SEED_PIN_REFS }, (_, index) => index),
      thumbnail: null,
      artwork: { avatar: null, poster: null, banner: null, backdrop: null },
    },
  })
  const maxRequest = await requestFor(base, 'unused', { manifest: maxManifest })
  const tampered = clone(base.request)
  tampered.signedDescriptor.proof = flipHexByte(tampered.signedDescriptor.proof)
  const limiter = new SeedPinVerificationLimiter({ maxConcurrent: 1 })
  const store = new FakePinStore()
  const worker = createWorker()
  let claimEntered = false
  let releaseClaim
  const claimGate = new Promise((resolve) => { releaseClaim = resolve })
  store.beforeClaim = async () => {
    claimEntered = true
    await claimGate
  }
  let admissionCalls = 0
  let admissionEntered = false
  let releaseAdmission
  const admissionGate = new Promise((resolve) => { releaseAdmission = resolve })
  const options = {
    store,
    worker,
    verificationLimiter: limiter,
    admission: async () => {
      admissionCalls++
      admissionEntered = true
      await admissionGate
      return true
    },
  }
  const firstPair = await createPair(base, options)
  const secondPair = await createPair(base, options)
  try {
    const firstPending = firstPair.client.pin(base.request)
    await waitFor(() => claimEntered)
    t.is(limiter.active, 1)
    const saturated = [otherRequest, maxRequest, tampered, otherRequest, maxRequest, tampered]
    await Promise.all(saturated.map((request) => expectProtocolCode(
      secondPair.client.pin(request),
      SEED_PIN_ERROR_CODES.BUSY,
      true,
    )))
    await expectProtocolCode(
      secondPair.client.status(base.request.requestId),
      SEED_PIN_ERROR_CODES.BUSY,
      true,
    )
    t.is(saturated.length, 6)
    t.is(store.calls.claim, 1)
    t.is(admissionCalls, 0)

    releaseClaim()
    await waitFor(() => admissionEntered)
    t.is(limiter.active, 1)
    await expectProtocolCode(
      secondPair.client.pin(otherRequest),
      SEED_PIN_ERROR_CODES.BUSY,
      true,
    )
    t.is(store.calls.claim, 1)
    t.is(admissionCalls, 1)

    releaseAdmission()
    t.is((await firstPending).state, 'accepted')
    t.is(limiter.active, 0)

    await expectProtocolCode(
      firstPair.client.pin(tampered),
      SEED_PIN_ERROR_CODES.INVALID_AUTH,
    )
    t.is(limiter.active, 0)

    const throwingPair = await createPair(base, {
      store: new FakePinStore(),
      verificationLimiter: limiter,
      admission: async () => { throw new Error('policy failure') },
    })
    try {
      await expectProtocolCode(
        throwingPair.client.pin(otherRequest),
        SEED_PIN_ERROR_CODES.BUSY,
        true,
      )
      t.is(limiter.active, 0)
    } finally {
      await closePair(throwingPair)
    }
  } finally {
    releaseClaim()
    releaseAdmission()
    await closePair(firstPair)
    await closePair(secondPair)
  }
})

test('policy and capacity denials and callback exceptions use stable codes', async (t) => {
  const base = await fixture()
  const cases = [
    [{ admission: async () => false }, SEED_PIN_ERROR_CODES.POLICY_REJECTED, false],
    [{ admission: async () => { throw new Error('private policy detail') } }, SEED_PIN_ERROR_CODES.BUSY, true],
    [{ capacity: async () => false }, SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED, true],
    [{ capacity: async () => { throw new Error('private capacity detail') } }, SEED_PIN_ERROR_CODES.BUSY, true],
  ]

  for (const [options, code, retryable] of cases) {
    const pair = await createPair(base, options)
    try {
      const error = await expectProtocolCode(pair.client.pin(base.request), code, retryable)
      t.not(error.message, 'private policy detail')
      t.not(error.message, 'private capacity detail')
      t.is(pair.store.calls.claim, 1)
      t.is(pair.worker.calls.length, 0)
    } finally {
      await closePair(pair)
    }
  }
})

test('storage failures stay internal while worker failures are retryable across reconnect', async (t) => {
  const base = await fixture()
  const store = new FakePinStore()
  store.claimError = new Error('database secret')
  const storagePair = await createPair(base, { store })
  try {
    const error = await expectProtocolCode(
      storagePair.client.pin(base.request),
      SEED_PIN_ERROR_CODES.INTERNAL,
      true,
    )
    t.not(error.message, 'database secret')
    store.claimError = null
    const second = await requestFor(base, 'video/after-storage-error')
    t.is((await storagePair.client.pin(second)).state, 'accepted')
  } finally {
    await closePair(storagePair)
  }

  const malformedStore = new FakePinStore()
  malformedStore.claimOutcome = { outcome: 'unexpected', record: null }
  const malformedPair = await createPair(base, { store: malformedStore })
  try {
    await expectProtocolCode(
      malformedPair.client.pin(base.request),
      SEED_PIN_ERROR_CODES.INTERNAL,
      true,
    )
    t.is(malformedPair.worker.calls.length, 0)
  } finally {
    await closePair(malformedPair)
  }

  let finalizeAdmissionCalls = 0
  const finalizeStore = new FakePinStore()
  finalizeStore.finalizeError = new Error('finalize secret')
  const finalizePair = await createPair(base, {
    store: finalizeStore,
    admission: async () => { finalizeAdmissionCalls++; return true },
  })
  try {
    const error = await expectProtocolCode(
      finalizePair.client.pin(base.request),
      SEED_PIN_ERROR_CODES.INTERNAL,
      true,
    )
    t.not(error.message, 'finalize secret')
    t.is(finalizeStore.records.get(base.request.requestId).status.state, 'admitting')
  } finally {
    await closePair(finalizePair)
  }
  finalizeStore.finalizeError = null
  finalizeStore.records.get(base.request.requestId).claimExpiresAt = NOW - 1
  const finalizeRecoveryPair = await createPair(base, {
    store: finalizeStore,
    admission: async () => { finalizeAdmissionCalls++; return true },
  })
  try {
    t.is((await finalizeRecoveryPair.client.pin(base.request)).state, 'accepted')
    t.is(finalizeAdmissionCalls, 2)
    t.is(finalizeStore.calls.insert, 1)
  } finally {
    await closePair(finalizeRecoveryPair)
  }

  let startAttempts = 0
  let admissionCalls = 0
  const retryStore = new FakePinStore()
  const retryWorker = createWorker(async () => {
    if (++startAttempts === 1) throw new Error('worker secret')
  })
  const workerPair = await createPair(base, {
    store: retryStore,
    worker: retryWorker,
    admission: async () => { admissionCalls++; return true },
  })
  try {
    const error = await expectProtocolCode(
      workerPair.client.pin(base.request),
      SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE,
      true,
    )
    t.not(error.message, 'worker secret')
    t.is(retryStore.records.get(base.request.requestId).status.state, 'accepted')
  } finally {
    await closePair(workerPair)
  }

  const resumedPair = await createPair(base, { store: retryStore, worker: retryWorker })
  try {
    const [resumed] = await resumedPair.client.resume([base.request.requestId])
    t.is(resumed.state, 'accepted')
    t.is(startAttempts, 2)
    t.is((await resumedPair.client.status(base.request.requestId)).state, 'accepted')
    t.is(startAttempts, 2)
    t.is(retryWorker.attempts.length, 3)
    t.is(retryWorker.calls.length, 1)
    t.is(retryStore.calls.insert, 1)
    t.is(admissionCalls, 1)
  } finally {
    await closePair(resumedPair)
  }
})

test('exact replay is idempotent and a request-ID body collision is rejected before allocation', async (t) => {
  const base = await fixture()
  const counts = { admission: 0, capacity: 0 }
  const pair = await createPair(base, {
    admission: async () => { counts.admission++; return true },
    capacity: async () => { counts.capacity++; return true },
  })
  try {
    const first = await pair.client.pin(base.request)
    pair.store.setStatus(base.request.requestId, { state: 'pinning', updatedAt: NOW + 1 })
    const replay = await pair.client.pin(base.request)
    t.is(first.state, 'accepted')
    t.is(replay.state, 'pinning')
    t.alike(counts, { admission: 1, capacity: 1 })
    t.is(pair.store.calls.claim, 2)
    t.is(pair.worker.calls.length, 1)

    pair.store.setStatus(base.request.requestId, { state: 'retryable', updatedAt: NOW + 2 })
    t.is((await pair.client.pin(base.request)).state, 'retryable')
    t.is(pair.worker.attempts.length, 2)
    t.is(pair.worker.calls.length, 1)

    for (const state of ['complete', 'failed', 'cancelled', 'released']) {
      pair.store.setStatus(base.request.requestId, {
        state,
        updatedAt: NOW + 2,
        completedAt: state === 'complete' ? NOW + 2 : null,
      })
      t.is((await pair.client.pin(base.request)).state, state)
      t.is(pair.worker.calls.length, 1)
    }

    const collision = await requestFor(base, 'unused', {
      manifest: base.manifest,
      expiresAt: EXPIRES_AT + 1,
    })
    await expectProtocolCode(
      pair.client.pin(collision),
      SEED_PIN_ERROR_CODES.REPLAY_CONFLICT,
    )
    t.alike(counts, { admission: 1, capacity: 1 })
    t.is(pair.store.calls.claim, 8)
    t.is(pair.worker.calls.length, 1)
  } finally {
    await closePair(pair)
  }
})

test('semantic reordered replay stores and digests one canonical verified request body', async (t) => {
  const base = await fixture()
  const manifest = createDurableManifest({
    channelKey: CHANNEL_KEY,
    rowId: 'video/semantic-replay',
    refs: [
      { coreKey: CORE_A, start: 0, end: 8, kind: 'media' },
      { coreKey: CORE_B, start: 2, end: 3, kind: 'thumbnail' },
      { coreKey: CORE_C, start: 10, end: 20, kind: 'media' },
    ],
    assets: {
      media: [0, 2],
      thumbnail: 1,
      artwork: { avatar: null, poster: null, banner: null, backdrop: null },
    },
  })
  const canonical = await requestFor(base, 'unused', { manifest })
  const reordered = clone(canonical)
  reordered.manifest.refs.reverse()
  reordered.manifest.assets.media = [0, 2]
  reordered.manifest.assets.thumbnail = 1
  const store = new FakePinStore()
  let admissionCalls = 0
  const pair = await createPair(base, {
    store,
    admission: async () => { admissionCalls++; return true },
  })
  try {
    t.is((await pair.client.pin(reordered)).state, 'accepted')
    t.is((await pair.client.pin(canonical)).state, 'accepted')
    const record = store.records.get(canonical.requestId)
    t.alike(record.request.manifest, canonical.manifest)
    t.is(record.authorizationDigest, seedPinAuthorizationDigest(canonical))
    t.is(store.calls.insert, 1)
    t.is(admissionCalls, 1)
  } finally {
    await closePair(pair)
  }
})

test('claim result tokens are exact, store-issued, digest-bound, and unexpired', async (t) => {
  const base = await fixture()
  const mutations = [
    (result) => { delete result.claimToken },
    (result) => { result.extra = true },
    (result) => { result.claimToken = 'ff'.repeat(32) },
    (result) => { result.record.claimExpiresAt = NOW },
  ]

  for (const mutate of mutations) {
    const store = new FakePinStore()
    const claimVerified = store.claimVerified.bind(store)
    store.claimVerified = async (input) => {
      const result = await claimVerified(input)
      mutate(result)
      return result
    }
    let admissionCalls = 0
    const pair = await createPair(base, {
      store,
      admission: async () => { admissionCalls++; return true },
    })
    try {
      await expectProtocolCode(
        pair.client.pin(base.request),
        SEED_PIN_ERROR_CODES.INTERNAL,
        true,
      )
      t.is(admissionCalls, 0)
      t.is(pair.worker.calls.length, 0)
    } finally {
      await closePair(pair)
    }
  }
})

test('finalize admission rejects claim tokens swapped across request and digest records', async (t) => {
  const base = await fixture()
  const otherRequest = await requestFor(base, 'video/token-swap')
  const store = new FakePinStore()
  let entered = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const pair = await createPair(base, {
    store,
    admission: async () => {
      entered++
      await gate
      return true
    },
  })
  try {
    const pending = [
      pair.client.pin(base.request),
      pair.client.pin(otherRequest),
    ]
    await waitFor(() => entered === 2)
    const firstRecord = store.records.get(base.request.requestId)
    const secondRecord = store.records.get(otherRequest.requestId)
    const firstToken = firstRecord.claimToken
    firstRecord.claimToken = secondRecord.claimToken
    secondRecord.claimToken = firstToken
    release()
    const outcomes = await Promise.allSettled(pending)
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'rejected')
      assert(outcome.reason instanceof SeedPinProtocolError)
      assert.equal(outcome.reason.code, SEED_PIN_ERROR_CODES.BUSY)
      assert.equal(outcome.reason.retryable, true)
    }
    t.is(store.calls.finalize, 2)
    t.is(store.calls.insert, 2)
    t.is(pair.worker.calls.length, 0)
  } finally {
    release()
    await closePair(pair)
  }
})

test('expired admission leases are reclaimed with a fresh store-issued claim token', async (t) => {
  const base = await fixture()
  const store = new FakePinStore()
  const authorizationDigest = seedPinAuthorizationDigest(base.request)
  const stale = await store.claimVerified({
    request: clone(base.request),
    owner: ownerFrom(base),
    authorizationDigest,
    acceptedAt: NOW - 100,
    claimedAt: NOW - 100,
  })
  t.is(stale.outcome, 'claimed')
  store.records.get(base.request.requestId).claimExpiresAt = NOW - 1
  let admissionCalls = 0
  const pair = await createPair(base, {
    store,
    admission: async () => { admissionCalls++; return true },
  })
  try {
    t.is((await pair.client.pin(base.request)).state, 'accepted')
    t.is(store.calls.claim, 2)
    t.is(store.calls.insert, 1)
    t.is(admissionCalls, 1)
    t.is(pair.worker.calls.length, 1)
    t.is(store.claimCounter, 2)
  } finally {
    await closePair(pair)
  }
})

test('capacity rejection is retryable and exact replay reclaims admission', async (t) => {
  const base = await fixture()
  const store = new FakePinStore()
  let available = false
  let admissionCalls = 0
  let capacityCalls = 0
  const pair = await createPair(base, {
    store,
    admission: async () => { admissionCalls++; return true },
    capacity: async () => { capacityCalls++; return available },
  })
  try {
    await expectProtocolCode(
      pair.client.pin(base.request),
      SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED,
      true,
    )
    t.is(store.records.get(base.request.requestId).status.state, 'retryable-admission')
    available = true
    t.is((await pair.client.pin(base.request)).state, 'accepted')
    t.is(store.calls.insert, 1)
    t.is(admissionCalls, 2)
    t.is(capacityCalls, 2)
    t.is(pair.worker.calls.length, 1)
  } finally {
    await closePair(pair)
  }
})

test('atomic store outcomes make exact races across two servers one insert and one idempotent schedule', async (t) => {
  const base = await fixture()
  const store = new FakePinStore()
  const worker = createWorker()
  let admissionCalls = 0
  const options = {
    store,
    worker,
    admission: async () => { admissionCalls++; return true },
  }
  store.beforeClaim = createBarrier(2)
  const firstPair = await createPair(base, options)
  const secondPair = await createPair(base, options)
  try {
    const outcomes = await Promise.allSettled([
      firstPair.client.pin(base.request),
      secondPair.client.pin(base.request),
    ])
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
    t.is(fulfilled.length, 1)
    t.is(fulfilled[0].value.requestId, base.request.requestId)
    t.is(rejected.length, 1)
    t.is(rejected[0].reason.code, SEED_PIN_ERROR_CODES.BUSY)
    t.is(rejected[0].reason.retryable, true)
    t.is(store.calls.claim, 2)
    t.is(store.calls.insert, 1)
    t.is(store.records.size, 1)
    t.is(worker.calls.length, 1)
    t.is(admissionCalls, 1)
  } finally {
    await closePair(firstPair)
    await closePair(secondPair)
  }
})

test('atomic store conflict wins across two racing servers without a second insert or schedule', async (t) => {
  const base = await fixture()
  const collision = await requestFor(base, 'unused', {
    manifest: base.manifest,
    expiresAt: EXPIRES_AT + 1,
  })
  const store = new FakePinStore()
  const worker = createWorker()
  const callbacks = { admission: 0, capacity: 0 }
  const options = {
    store,
    worker,
    admission: async () => { callbacks.admission++; return true },
    capacity: async () => { callbacks.capacity++; return true },
  }
  store.beforeClaim = createBarrier(2)
  const firstPair = await createPair(base, options)
  const secondPair = await createPair(base, options)
  try {
    const outcomes = await Promise.allSettled([
      firstPair.client.pin(base.request),
      secondPair.client.pin(collision),
    ])
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
    t.is(fulfilled.length, 1)
    t.is(rejected.length, 1)
    t.ok(rejected[0].reason instanceof SeedPinProtocolError)
    t.is(rejected[0].reason.code, SEED_PIN_ERROR_CODES.REPLAY_CONFLICT)
    t.is(store.calls.insert, 1)
    t.is(store.records.size, 1)
    t.is(worker.calls.length, 1)
    t.alike(callbacks, { admission: 1, capacity: 1 })
  } finally {
    await closePair(firstPair)
    await closePair(secondPair)
  }
})

test('status requires the original authenticated identity and device', async (t) => {
  const base = await fixture()
  const store = new FakePinStore()
  const ownerPair = await createPair(base, { store })
  try {
    await ownerPair.client.pin(base.request)
  } finally {
    await closePair(ownerPair)
  }

  const otherIdentityPair = await createPair(base, {
    store,
    credentials: {
      identityPublicKey: base.otherIdentity.identityPublicKey,
      deviceKeyPair: base.device,
      deviceProof: base.otherIdentityProof,
    },
  })
  try {
    await expectProtocolCode(
      otherIdentityPair.client.status(base.request.requestId),
      SEED_PIN_ERROR_CODES.FORBIDDEN,
    )
  } finally {
    await closePair(otherIdentityPair)
  }

  const otherDevicePair = await createPair(base, {
    store,
    remotePublicKey: base.otherDevice.publicKey,
    credentials: {
      identityPublicKey: base.identity.identityPublicKey,
      deviceKeyPair: base.otherDevice,
      deviceProof: base.otherDeviceProof,
    },
  })
  try {
    await expectProtocolCode(
      otherDevicePair.client.status(base.request.requestId),
      SEED_PIN_ERROR_CODES.FORBIDDEN,
    )
    await expectProtocolCode(
      otherDevicePair.client.status('ff'.repeat(32)),
      SEED_PIN_ERROR_CODES.NOT_FOUND,
    )
  } finally {
    await closePair(otherDevicePair)
  }
})

test('disconnect rejects every pending call with a typed retryable transport error', async (t) => {
  const base = await fixture()
  const limiter = new SeedPinVerificationLimiter({ maxConcurrent: 1 })
  let entered = false
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const pair = await createPair(base, {
    admission: async () => { entered = true; await gate; return true },
    verificationLimiter: limiter,
    requestTimeout: 5_000,
  })
  const pending = pair.client.pin(base.request)
  await waitFor(() => entered)
  t.is(limiter.active, 1)
  pair.clientStream.destroy()

  try {
    await pending
    t.fail('pending pin should reject')
  } catch (error) {
    t.ok(error instanceof SeedPinTransportError)
    t.is(error.retryable, true)
    t.is(error.code, 'TRANSPORT_CLOSED')
  } finally {
    release()
    await waitFor(() => limiter.active === 0)
    await closePair(pair)
  }
  t.is(pair.client.pendingCount, 0)
  t.is(limiter.active, 0)
})

test('reconnect with the same device resumes correlated owned statuses', async (t) => {
  const base = await fixture()
  const secondRequest = await requestFor(base, 'video/seed-pin/2')
  const store = new FakePinStore()
  const firstPair = await createPair(base, { store })
  try {
    await firstPair.client.pin(base.request)
    await firstPair.client.pin(secondRequest)
  } finally {
    await closePair(firstPair)
  }

  store.setStatus(base.request.requestId, { state: 'pinning', updatedAt: NOW + 1 })
  store.setStatus(secondRequest.requestId, {
    state: 'complete',
    updatedAt: NOW + 2,
    completedAt: NOW + 2,
  })
  const resumedPair = await createPair(base, { store })
  try {
    const statuses = await resumedPair.client.resume([
      secondRequest.requestId,
      base.request.requestId,
    ])
    t.is(statuses.length, 2)
    t.is(statuses[0].requestId, secondRequest.requestId)
    t.is(statuses[0].state, 'complete')
    t.is(statuses[1].requestId, base.request.requestId)
    t.is(statuses[1].state, 'pinning')
  } finally {
    await closePair(resumedPair)
  }
})

test('one pending correlation map handles out-of-order pin responses', async (t) => {
  const base = await fixture()
  const slow = await requestFor(base, 'video/slow')
  const fast = await requestFor(base, 'video/fast')
  const order = []
  const pair = await createPair(base, {
    admission: async ({ request }) => {
      if (request.requestId === slow.requestId) {
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      return true
    },
  })
  try {
    const slowPromise = pair.client.pin(slow).then((status) => { order.push('slow'); return status })
    const fastPromise = pair.client.pin(fast).then((status) => { order.push('fast'); return status })
    const [slowStatus, fastStatus] = await Promise.all([slowPromise, fastPromise])
    t.alike(order, ['fast', 'slow'])
    t.is(slowStatus.requestId, slow.requestId)
    t.is(fastStatus.requestId, fast.requestId)
    t.is(pair.client.pendingCount, 0)
  } finally {
    await closePair(pair)
  }
})

test('cross-kind and duplicate responses cannot resolve the wrong pending operation', async (t) => {
  const base = await fixture()
  let pinEntered = false
  let releasePin
  const pinGate = new Promise((resolve) => { releasePin = resolve })
  const pair = await createPair(base, {
    admission: async () => {
      pinEntered = true
      await pinGate
      return true
    },
  })
  const complete = {
    ...acceptedStatus(base.request),
    state: 'complete',
    completedAt: NOW,
  }
  try {
    let pinSettled = false
    const pinPending = pair.client.pin(base.request).then((status) => {
      pinSettled = true
      return status
    })
    await waitFor(() => pinEntered)
    const pinCorrelation = [...pair.client.pending.keys()][0]
    pair.server.statusResponse.send(seedPinSuccessResponse(
      pinCorrelation,
      base.request.requestId,
      complete,
    ))
    await new Promise((resolve) => setTimeout(resolve, 0))
    t.is(pinSettled, false)
    t.is(pair.client.pendingCount, 1)
    releasePin()
    t.is((await pinPending).state, 'accepted')
    t.is(pair.client.pendingCount, 0)

    let statusEntered = false
    let releaseStatus
    const statusGate = new Promise((resolve) => { releaseStatus = resolve })
    const getByRequestId = pair.store.getByRequestId.bind(pair.store)
    pair.store.getByRequestId = async (requestId) => {
      statusEntered = true
      await statusGate
      return getByRequestId(requestId)
    }
    let statusSettled = false
    const statusPending = pair.client.status(base.request.requestId).then((status) => {
      statusSettled = true
      return status
    })
    await waitFor(() => statusEntered)
    const statusCorrelation = [...pair.client.pending.keys()][0]
    pair.server.pinResponse.send(seedPinSuccessResponse(
      statusCorrelation,
      base.request.requestId,
      complete,
    ))
    await new Promise((resolve) => setTimeout(resolve, 0))
    t.is(statusSettled, false)
    t.is(pair.client.pendingCount, 1)
    releaseStatus()
    t.is((await statusPending).state, 'accepted')
    t.is(pair.client.pendingCount, 0)

    pair.server.statusResponse.send(seedPinSuccessResponse(
      statusCorrelation,
      base.request.requestId,
      complete,
    ))
    await new Promise((resolve) => setTimeout(resolve, 0))
    t.is(pair.client.pendingCount, 0)
  } finally {
    releasePin()
    await closePair(pair)
  }
})

test('hostile PIN_REQUEST proof counts never reach the package decoder and the paired channel recovers', async (t) => {
  const base = await fixture()
  const store = new FakePinStore()
  const worker = createWorker()
  let admissionCalls = 0
  let capacityCalls = 0
  const [clientStream, serverStream] = createMemoryConnectionPair(base.device.publicKey)
  const server = new SeedPinServer(Protomux.from(serverStream), {
    remotePublicKey: base.device.publicKey,
    store,
    worker,
    admission: async () => {
      admissionCalls++
      return true
    },
    capacity: async () => {
      capacityCalls++
      return true
    },
    now: () => NOW,
  })
  const responses = []
  const mux = Protomux.from(clientStream)
  const rawChannel = mux.createChannel({
    protocol: SEED_PIN_PROTOCOL,
    messages: [
      { encoding: c.raw },
      {
        encoding: c.raw,
        onmessage: (frame) => responses.push(c.decode(PIN_RESPONSE_ENCODING, frame)),
      },
      { encoding: c.raw },
      { encoding: c.raw },
    ],
  })
  rawChannel.open()
  await Promise.all([server.opened(), rawChannel.fullyOpened()])

  const hostileProofBytes = encodeParts(
    [c.uint, 1],
    [c.uint64, Math.floor(NOW / 1000)],
    [c.fixed32, base.identity.identityPublicKey],
    [c.uint, 0x100000],
  )
  const hostileProof = b4a.toString(hostileProofBytes, 'hex')
  const originalDecode = IdentityEncoding.ProofEncoding.decode
  let packageDecodes = 0
  let hostilePackageDecodes = 0
  IdentityEncoding.ProofEncoding.decode = (state) => {
    packageDecodes++
    const candidate = state.buffer.subarray(state.start, state.end)
    if (candidate.byteLength === hostileProofBytes.byteLength &&
        b4a.equals(candidate, hostileProofBytes)) {
      hostilePackageDecodes++
    }
    return originalDecode(state)
  }

  try {
    const requestMessage = rawChannel.messages[0]
    requestMessage.send(c.encode(PIN_REQUEST_ENCODING, {
      version: 1,
      correlationId: 91,
      requestId: base.request.requestId,
      request: {
        ...base.request,
        signedDescriptor: {
          ...base.request.signedDescriptor,
          proof: hostileProof,
        },
      },
    }))
    await waitFor(() => responses.length === 1)
    t.is(responses[0].code, SEED_PIN_ERROR_CODES.INVALID_AUTH)
    t.is(packageDecodes, 0)
    t.is(hostilePackageDecodes, 0)

    requestMessage.send(c.encode(PIN_REQUEST_ENCODING, {
      version: 1,
      correlationId: 92,
      requestId: base.request.requestId,
      request: {
        ...base.request,
        signedDescriptor: {
          ...base.request.signedDescriptor,
          attestation: hostileProof,
        },
      },
    }))
    await waitFor(() => responses.length === 2)
    t.is(responses[1].code, SEED_PIN_ERROR_CODES.INVALID_AUTH)
    t.is(packageDecodes, 1)
    t.is(hostilePackageDecodes, 0)

    requestMessage.send(c.encode(PIN_REQUEST_ENCODING, {
      version: 1,
      correlationId: 93,
      requestId: base.request.requestId,
      request: { ...base.request, attestation: hostileProof },
    }))
    await waitFor(() => responses.length === 3)
    t.is(responses[2].code, SEED_PIN_ERROR_CODES.INVALID_AUTH)
    t.is(packageDecodes, 5)
    t.is(hostilePackageDecodes, 0)
    t.is(store.calls.claim, 0)
    t.is(admissionCalls, 0)
    t.is(capacityCalls, 0)
    t.is(worker.calls.length, 0)
    t.is(serverStream.destroyed, false)

    requestMessage.send(c.encode(PIN_REQUEST_ENCODING, {
      version: 1,
      correlationId: 94,
      requestId: base.request.requestId,
      request: base.request,
    }))
    await waitFor(() => responses.length === 4)
    t.is(responses[3].status.state, 'accepted')
    t.is(hostilePackageDecodes, 0)
    t.is(store.calls.claim, 1)
    t.is(admissionCalls, 1)
    t.is(capacityCalls, 1)
    t.is(worker.calls.length, 1)
    t.is(serverStream.destroyed, false)
  } finally {
    IdentityEncoding.ProofEncoding.decode = originalDecode
    server.close()
    rawChannel.close()
    clientStream.destroy()
    serverStream.destroy()
  }
})

test('malformed and oversized frames, counts, strings, and proofs fail closed while the server remains usable', async (t) => {
  const base = await fixture()
  const store = new FakePinStore()
  const worker = createWorker()
  const [clientStream, serverStream] = createMemoryConnectionPair(base.device.publicKey)
  const server = new SeedPinServer(Protomux.from(serverStream), {
    remotePublicKey: base.device.publicKey,
    store,
    worker,
    now: () => NOW,
  })
  const mux = Protomux.from(clientStream)
  const rawChannel = mux.createChannel({
    protocol: SEED_PIN_PROTOCOL,
    messages: [
      { encoding: c.raw },
      { encoding: c.raw },
      { encoding: c.raw },
      { encoding: c.raw },
    ],
  })
  rawChannel.open()
  await Promise.all([server.opened(), rawChannel.fullyOpened()])

  try {
    const requestMessage = rawChannel.messages[0]
    const statusMessage = rawChannel.messages[2]
    requestMessage.send(b4a.from([1]))
    requestMessage.send(b4a.alloc(MAX_SEED_PIN_FRAME_BYTES + 1))

    const oversizedString = encodeParts(
      [c.uint, 1],
      [c.uint, 11],
      [c.uint, 65],
    )
    requestMessage.send(oversizedString)

    const oversizedCount = encodeParts(
      [c.uint, 1],
      [c.uint, 12],
      [c.string, base.request.requestId],
      [c.uint, 1],
      [c.uint, 1],
      [c.string, CHANNEL_KEY],
      [c.string, base.manifest.rowId],
      [c.uint, MAX_SEED_PIN_REFS + 1],
    )
    requestMessage.send(oversizedCount)

    const oversizedProof = encodeParts(
      [c.uint, 1],
      [c.uint, 13],
      [c.string, base.request.requestId],
      [c.uint, 1],
      [c.string, base.request.requestId],
      [c.string, b4a.toString(base.identity.identityPublicKey, 'hex')],
      [c.string, b4a.toString(base.device.publicKey, 'hex')],
      [c.uint, EXPIRES_AT],
      [c.uint, MAX_SEED_PIN_PROOF_HEX_BYTES + 1],
    )
    statusMessage.send(oversizedProof)
    const hostileProof = b4a.toString(encodeParts(
      [c.uint, 1],
      [c.uint64, Math.floor(NOW / 1000)],
      [c.fixed32, base.identity.identityPublicKey],
      [c.uint, 0x100000],
    ), 'hex')
    const validStatusRequest = createSeedPinStatusRequest({
      requestId: base.request.requestId,
      expiresAt: EXPIRES_AT,
      ...credentials(base),
    })
    for (let index = 0; index < 16; index++) {
      statusMessage.send(c.encode(STATUS_REQUEST_ENCODING, {
        version: 1,
        correlationId: 100 + index,
        requestId: base.request.requestId,
        request: { ...validStatusRequest, deviceProof: hostileProof },
      }))
    }

    await new Promise((resolve) => setTimeout(resolve, 10))
    t.is(serverStream.destroyed, false)
    t.is(store.calls.claim, 0)

    requestMessage.send(c.encode(PIN_REQUEST_ENCODING, {
      version: 1,
      correlationId: 99,
      requestId: base.request.requestId,
      request: base.request,
    }))
    await waitFor(() => store.calls.claim === 1)
    t.is(worker.calls.length, 1)
    t.is(serverStream.destroyed, false)
  } finally {
    server.close()
    rawChannel.close()
    clientStream.destroy()
    serverStream.destroy()
  }
})

test('wire codecs reject noncanonical shapes and never carry secret keys', async (t) => {
  const base = await fixture()
  const statusRequest = createSeedPinStatusRequest({
    requestId: base.request.requestId,
    expiresAt: EXPIRES_AT,
    ...credentials(base),
  })
  const pinBytes = c.encode(PIN_REQUEST_ENCODING, {
    version: 1,
    correlationId: 1,
    requestId: base.request.requestId,
    request: base.request,
  })
  const statusBytes = c.encode(STATUS_REQUEST_ENCODING, {
    version: 1,
    correlationId: 2,
    requestId: base.request.requestId,
    request: statusRequest,
  })

  t.is(b4a.indexOf(pinBytes, base.device.secretKey), -1)
  t.is(b4a.indexOf(statusBytes, base.device.secretKey), -1)
  t.not(b4a.toString(pinBytes), 'secretKey')
  t.not(b4a.toString(statusBytes), 'secretKey')

  assert.throws(() => c.encode(PIN_REQUEST_ENCODING, {
    version: 1,
    correlationId: 3,
    requestId: base.request.requestId.toUpperCase(),
    request: base.request,
  }))
  assert.throws(() => c.encode(STATUS_REQUEST_ENCODING, {
    version: 1,
    correlationId: 4,
    requestId: base.request.requestId,
    request: { ...statusRequest, unknown: true },
  }))
  assert.throws(() => c.encode(PIN_REQUEST_ENCODING, {
    version: 1,
    correlationId: 5,
    requestId: base.request.requestId,
    request: { ...base.request, claimToken: 'aa'.repeat(32) },
  }))
  t.pass('strict encoders reject uppercase hex and extra fields')
})

test('backend seed-pin package subpath exports the stable protocol API', async (t) => {
  const api = await import('@peartube/backend/seed-pin')
  t.is(api.SEED_PIN_PROTOCOL, SEED_PIN_PROTOCOL)
  t.is(api.SeedPinClient, SeedPinClient)
  t.is(api.SeedPinServer, SeedPinServer)
  t.is(api.SeedPinVerificationLimiter, SeedPinVerificationLimiter)
  t.is(api.MAX_SEED_PIN_PROOF_CHAIN, MAX_SEED_PIN_PROOF_CHAIN)
  t.is(api.MAX_STATUS_EXPIRY_WINDOW_MS, MAX_STATUS_EXPIRY_WINDOW_MS)
  t.is(api.MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS)
  t.is(typeof api.createSeedPinRequest, 'function')
  t.is(typeof api.createSeedPinStatusRequest, 'function')
})
