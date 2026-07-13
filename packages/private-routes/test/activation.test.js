import test from 'brittle'
import b4a from 'b4a'
import * as publicApi from '../index.js'

import {
  AUTHORIZATION_MODE,
  ACTIVATION_FRAGMENT_HEADER_SIZE,
  ACTIVATION_FRAGMENT_TIMEOUT,
  DEFAULT_MAX_ACTOR_CIRCUITS,
  CAPABILITY,
  CELL_CLASS,
  DIRECTION,
  DOMAIN,
  PROTOCOL_VERSION,
  ROLE,
  buildPrivateTemplates,
  ActivationReassembler,
  fragmentActivation,
  activationChallengeCipher,
  destinationPossessionTag,
  encodeActivationParameters,
  entryPossessionTag,
  hashActivationParameters,
  createTemplateRegistry,
  createPrivateRelayActor,
  createPrivateSafetyEntryAttachment,
  destroyPrivateRelayActor,
  createPrivateDestinationActor,
  destroyPrivateDestinationActor,
  createPrivateRouteCompiler,
  sendPrivateDestinationStream,
  RouteManager,
  createCircuitAuthority,
  createRouteCompilerAuthority,
  createSafetyInstallerAuthority,
  cryptoSuite,
  decodePrivateTemplate,
  decodeTemplateRegister,
  decodeTemplateRegistered,
  encodeDescriptor,
  encodeRelayAdvertisement,
  encodePrivateTemplate,
  encodeTemplateRegister,
  encodeTemplateRegisterUnsigned,
  encodeTemplateRegistered,
  registerPrivateRoute,
  signDescriptor,
  signRelayAdvertisement,
  verifyDescriptor,
  readVerifiedDescriptor
} from '../index.js'
import {
  descriptorChecker,
  expectCode,
  privateRoleIdentity,
  safetyRoleIdentity,
  seed
} from './helpers.js'
import {
  TEST_ONLY_ACTIVATION_OBSERVER,
  TEST_ONLY_DESTINATION_PROOF_MUTATOR,
  TEST_ONLY_DESTINATION_REGISTRATION_ACK_MUTATOR,
  TEST_ONLY_REGISTRATION_COMMAND_ACK_MUTATOR,
  activateRegisteredRoute,
  registerPrivateRouteLegacy
} from '../lib/activation.js'

function relay(start, dial, epoch = 7n, expiresAt = 10_000n) {
  const identity = privateRoleIdentity(start)
  const encryption = cryptoSuite.encryptionKeyPair(seed(start + 80))
  return {
    identity,
    encryption,
    advertisement: signRelayAdvertisement(
      {
        version: PROTOCOL_VERSION,
        identityKey: identity.publicKey,
        routeEncryptionKey: encryption.publicKey,
        dial: b4a.from(dial),
        role: ROLE.PRIVATE,
        capabilities: CAPABILITY.KNOWN,
        epoch,
        expiresAt
      },
      identity.secretKey
    )
  }
}

function registrationSafetyRoute(sendControl, reverse = null) {
  return Object.freeze({
    attachEntry() {
      return Object.freeze({ destroy() {} })
    },
    sendControl,
    sendReverseFrame(cellClass, frame, deliver) {
      if (reverse) return reverse(cellClass, frame, deliver)
      return deliver(frame)
    }
  })
}

function destination() {
  const identity = cryptoSuite.keyPair(seed(210))
  return { identity, descriptorId: seed(211), epoch: 7n, expiresAt: 9_000n }
}

function builtFixture(relays = [relay(1, 'entry'), relay(20, 'middle'), relay(40, 'final')]) {
  const owner = destination()
  let random = 0
  const options = {
    descriptorId: owner.descriptorId,
    epoch: owner.epoch,
    expiresAt: owner.expiresAt,
    endpointKey: owner.identity.publicKey,
    routeSigningKey: owner.identity.publicKey,
    authorizationMode: AUTHORIZATION_MODE.DIRECT,
    destinationSecretKey: owner.identity.secretKey,
    relays: relays.map((value) => encodeRelayAdvertisement(value.advertisement)),
    randomBytes: (size) => b4a.alloc(size, ++random),
    finalToken: b4a.alloc(64, 0xfe),
    now: 1_000n
  }
  return { owner, relays, options, built: buildPrivateTemplates(options) }
}

function destinationActorFor(fixture, options = {}) {
  const encryption = cryptoSuite.encryptionKeyPair(seed(229))
  return createPrivateDestinationActor({
    identity: fixture.owner.identity.publicKey,
    identitySecretKey: fixture.owner.identity.secretKey,
    routeSigningKey: fixture.owner.identity.publicKey,
    routeSigningSecretKey: fixture.owner.identity.secretKey,
    routeEncryptionSecretKey: encryption.secretKey,
    finalToken: fixture.options.finalToken,
    now: options.now || (() => 1_000),
    randomBytes: options.randomBytes || sequenceBytes(220),
    ...options
  })
}

test('private template schema is canonical and bounded', (t) => {
  const value = {
    version: PROTOCOL_VERSION,
    descriptorId: seed(1),
    templateId: b4a.alloc(16, 2),
    epoch: 3n,
    expiresAt: 4n,
    relayIdentity: seed(5),
    nextAdvertisement: b4a.alloc(1024, 6),
    nextLayer: b4a.alloc(4096, 7)
  }
  const encoded = encodePrivateTemplate(value)
  t.is(encoded.byteLength, 101 + 1024 + 4096)
  t.alike(decodePrivateTemplate(encoded), value)
})

test('activation objects use exact bounded pre-open CONTROL fragments', (t) => {
  const message = b4a.alloc(4313, 0xa1)
  const fragments = fragmentActivation(message, { messageId: b4a.alloc(16, 0xa2) })
  t.is(fragments.length, 4)
  t.is(fragments[0].byteLength, 1146)
  let now = 0
  const reassembler = new ActivationReassembler({ now: () => now })
  for (let i = 0; i < fragments.length - 1; i++)
    t.is(reassembler.pushAuthenticated(fragments[i]), null)
  t.alike(reassembler.pushAuthenticated(fragments.at(-1)), message)
  t.exception(() => reassembler.pushAuthenticated(fragments[0]))
  now += ACTIVATION_FRAGMENT_TIMEOUT
  reassembler.expire()
})

test('activation fragment malformation, conflict, replay, and timeout clear only partial state', (t) => {
  function malformed(mutate) {
    const frames = fragmentActivation(b4a.alloc(1200, 1), { messageId: b4a.alloc(16, 2) })
    mutate(frames[0])
    const receiver = new ActivationReassembler({ now: () => 0 })
    t.exception(() => receiver.pushAuthenticated(frames[0]))
    t.is(receiver.bufferedBytes, 0)
  }
  malformed((frame) => {
    frame[18] = 0
    frame[19] = 0
  })
  malformed((frame) => {
    frame[18] = 0
    frame[19] = 9
  })
  malformed((frame) => {
    frame[16] = 0
    frame[17] = 2
  })
  malformed((frame) => {
    frame[20] = 0x20
    frame[21] = 0x01
  })
  let now = 0
  const receiver = new ActivationReassembler({ now: () => now })
  const frames = fragmentActivation(b4a.alloc(1200, 3), { messageId: b4a.alloc(16, 4) })
  t.is(receiver.pushAuthenticated(frames[0]), null)
  t.exception(() => receiver.pushAuthenticated(frames[0]))
  t.is(receiver.bufferedBytes, 0)
  const completed = fragmentActivation(b4a.from('done'), { messageId: b4a.alloc(16, 5) })[0]
  t.alike(receiver.pushAuthenticated(completed), b4a.from('done'))
  t.exception(() => receiver.pushAuthenticated(completed))
  const timeout = fragmentActivation(b4a.alloc(1200), { messageId: b4a.alloc(16, 6) })
  receiver.pushAuthenticated(timeout[0])
  now = 5_000
  t.is(receiver.expire(), true)
  t.is(receiver.bufferedBytes, 0)
})

test('activation fragments reject every structural bound with stable errors', (t) => {
  const mutations = [
    [
      'total zero',
      (frame) => {
        frame[18] = 0
        frame[19] = 0
      }
    ],
    [
      'total above eight',
      (frame) => {
        frame[18] = 0
        frame[19] = 9
      }
    ],
    [
      'index out of range',
      (frame) => {
        frame[16] = 0
        frame[17] = 2
      }
    ],
    [
      'inconsistent object length and total',
      (frame) => {
        frame[20] = 0
        frame[21] = 1
      }
    ],
    [
      'object above 8192',
      (frame) => {
        frame[20] = 0x20
        frame[21] = 1
      }
    ]
  ]
  for (const [name, mutate] of mutations) {
    const frames = fragmentActivation(b4a.alloc(1200, 1), {
      messageId: b4a.alloc(16, 2)
    })
    mutate(frames[0])
    const receiver = new ActivationReassembler({ now: () => 0 })
    expectCode(t, () => receiver.pushAuthenticated(frames[0]), 'INVALID_ROUTE')
    t.is(receiver.bufferedBytes, 0, name)
  }
})

test('identical and conflicting duplicate activation fragments clear partial state', (t) => {
  for (const conflicting of [false, true]) {
    const frames = fragmentActivation(b4a.alloc(1200, 3), {
      messageId: b4a.alloc(16, 4)
    })
    const duplicate = b4a.from(frames[0])
    if (conflicting) duplicate[duplicate.byteLength - 1] ^= 1
    const receiver = new ActivationReassembler({ now: () => 0 })
    t.is(receiver.pushAuthenticated(frames[0]), null)
    expectCode(t, () => receiver.pushAuthenticated(duplicate), 'INVALID_ROUTE')
    t.is(receiver.bufferedBytes, 0)
  }
})

test('replayed completed activation ID clears a same-circuit partial object', (t) => {
  const receiver = new ActivationReassembler({ now: () => 0 })
  const completed = fragmentActivation(b4a.from('complete'), {
    messageId: b4a.alloc(16, 5)
  })[0]
  const partial = fragmentActivation(b4a.alloc(1200, 6), {
    messageId: b4a.alloc(16, 6)
  })
  t.alike(receiver.pushAuthenticated(completed), b4a.from('complete'))
  t.is(receiver.pushAuthenticated(partial[0]), null)
  t.ok(receiver.bufferedBytes > 0)
  expectCode(t, () => receiver.pushAuthenticated(completed), 'REPLAY')
  t.is(receiver.bufferedBytes, 0)
})

test('activation fragment failure clears only its selected circuit', (t) => {
  const selected = new ActivationReassembler({ now: () => 0 })
  const unrelated = new ActivationReassembler({ now: () => 0 })
  const selectedFrames = fragmentActivation(b4a.alloc(1200, 7), {
    messageId: b4a.alloc(16, 7)
  })
  const unrelatedFrames = fragmentActivation(b4a.alloc(1200, 8), {
    messageId: b4a.alloc(16, 8)
  })
  selected.pushAuthenticated(selectedFrames[0])
  unrelated.pushAuthenticated(unrelatedFrames[0])
  expectCode(t, () => selected.pushAuthenticated(selectedFrames[0]), 'INVALID_ROUTE')
  t.is(selected.bufferedBytes, 0)
  t.ok(unrelated.bufferedBytes > 0)
  t.alike(unrelated.pushAuthenticated(unrelatedFrames[1]), b4a.alloc(1200, 8))
})

test('activation completed-ID replay state is bounded without eviction', (t) => {
  const receiver = new ActivationReassembler({ now: () => 0 })
  const completed = []
  for (let index = 0; index < 64; index++) {
    const messageId = b4a.alloc(16)
    messageId[14] = index >>> 8
    messageId[15] = index
    const frame = fragmentActivation(b4a.from([index]), { messageId })[0]
    completed.push(frame)
    t.alike(receiver.pushAuthenticated(frame), b4a.from([index]))
  }
  const overflowId = b4a.alloc(16)
  overflowId[15] = 64
  const overflow = fragmentActivation(b4a.from([64]), {
    messageId: overflowId
  })[0]
  expectCode(t, () => receiver.pushAuthenticated(overflow), 'CIRCUIT_LIMIT')
  expectCode(t, () => receiver.pushAuthenticated(completed[0]), 'REPLAY')
  t.is(receiver.bufferedBytes, 0)
})

test('reentrant activation clock cannot resurrect destroyed partial state', (t) => {
  let receiver = null
  receiver = new ActivationReassembler({
    now() {
      receiver.destroy()
      return 1
    }
  })
  const frames = fragmentActivation(b4a.alloc(1200, 1), {
    messageId: b4a.alloc(16, 2)
  })

  expectCode(t, () => receiver.pushAuthenticated(frames[0]), 'CIRCUIT_STATE')
  t.is(receiver.bufferedBytes, 0)
  receiver.destroy()
  t.is(receiver.bufferedBytes, 0)
})

test('activation fragment deadline rejects unsafe integer overflow without buffering', (t) => {
  const receiver = new ActivationReassembler({
    now: () => Number.MAX_SAFE_INTEGER - 1_000
  })
  const frames = fragmentActivation(b4a.alloc(1200, 1), {
    messageId: b4a.alloc(16, 2)
  })

  expectCode(t, () => receiver.pushAuthenticated(frames[0]), 'INVALID_ROUTE')
  t.is(receiver.bufferedBytes, 0)
})

test('activation challenge, possession, and parameter fixed vectors are locked', (t) => {
  const shared = seed(3)
  const base = seed(4)
  t.is(
    b4a.toString(activationChallengeCipher(shared, base, seed(5), 0), 'hex'),
    'f130e6a69d7b3ce6cebeada16abefdfae291d68ba35d7932a12baaaacbd02b0bfaa9dd22e6f66ab4d4b4e6e85427c3e2'
  )
  t.is(
    b4a.toString(entryPossessionTag(shared, base, seed(5), seed(6)), 'hex'),
    'ebd028ec0ed4a401d143a91694a06f95'
  )
  const parameters = {
    version: 0,
    cellSize: 1200,
    routeFrameSize: 1100,
    maxCellPayload: 1146,
    maxRoutePayload: 1073,
    capabilities: 7,
    safetyMin: 1,
    safetyMax: 3,
    privateMin: 1,
    privateMax: 3,
    counterWindow: 64
  }
  t.is(
    b4a.toString(encodeActivationParameters(parameters), 'hex'),
    '0004b0044c047a043100000007010301030040'
  )
  const parametersHash = hashActivationParameters(parameters)
  t.is(
    b4a.toString(parametersHash, 'hex'),
    '360071d84b1025f19abacef12337c1a66a92267799c240f592fb56290ddfbc95'
  )
  t.is(
    b4a.toString(activationChallengeCipher(shared, base, seed(7), 1), 'hex'),
    '6a88ea7af80771fa26b3817894f41f32a9021b11eccb2f2521137b9111d5473c50bda6698887a4dd08e7ba7812553838'
  )
  t.is(
    b4a.toString(destinationPossessionTag(shared, base, seed(7), seed(8), parametersHash), 'hex'),
    '3e0df041a520a11c80cfb53323f126b1'
  )
})

test('activation request carries every relay transcript field in bounded bytes', (t) => {
  t.is(typeof publicApi.encodeActivationRequest, 'function', 'encodeActivationRequest')
  t.is(typeof publicApi.decodeActivationRequest, 'function', 'decodeActivationRequest')
  if (typeof publicApi.encodeActivationRequest !== 'function') return

  const fixture = destinationProofFixture()
  const entryRequest = {
    entry: true,
    create: fixture.create,
    layer: b4a.alloc(0),
    expiresAt: 9_000n,
    startedAt: 1_000,
    parameters: fixture.parameters,
    entryProof: b4a.alloc(0)
  }
  const encodedEntry = publicApi.encodeActivationRequest(entryRequest)
  t.is(encodedEntry.byteLength, 41 + fixture.create.byteLength)
  t.alike(publicApi.decodeActivationRequest(encodedEntry), entryRequest)

  const forwardRequest = {
    ...entryRequest,
    entry: false,
    layer: b4a.from('next encrypted activation layer'),
    entryProof: fixture.entryProof
  }
  const encodedForward = publicApi.encodeActivationRequest(forwardRequest)
  t.is(
    encodedForward.byteLength,
    41 + fixture.create.byteLength + forwardRequest.layer.byteLength + fixture.entryProof.byteLength
  )
  t.ok(encodedForward.byteLength <= 8_192)
  t.alike(publicApi.decodeActivationRequest(encodedForward), forwardRequest)
})

test('CREATE and entry-proof codecs lock exact canonical schemas', (t) => {
  for (const name of [
    'encodeCreate',
    'decodeCreate',
    'hashCreateBase',
    'encodeEntryProofUnsigned',
    'decodeEntryProofUnsigned',
    'encodeEntryProof',
    'decodeEntryProof'
  ]) {
    t.is(typeof publicApi[name], 'function', name)
  }
  if (typeof publicApi.encodeCreate !== 'function') return

  const create = {
    version: PROTOCOL_VERSION,
    circuitId: b4a.alloc(16, 1),
    epoch: 7n,
    descriptorId: seed(2),
    sourceEphemeralKey: seed(3),
    safetyTranscriptHash: seed(4),
    entryChallengeCipher: b4a.alloc(48, 5),
    destinationChallengeCipher: b4a.alloc(48, 6),
    encryptedHops: b4a.alloc(4096, 7)
  }
  const encodedCreate = publicApi.encodeCreate(create)
  t.is(encodedCreate.byteLength, 4315)
  t.alike(publicApi.decodeCreate(encodedCreate), create)
  t.is(publicApi.hashCreateBase(create).byteLength, 32)

  const unsigned = {
    version: PROTOCOL_VERSION,
    circuitId: create.circuitId,
    epoch: create.epoch,
    entryIdentity: seed(8),
    createHash: seed(9),
    entryChallengeHash: seed(10),
    expiresAt: 9_000n
  }
  const proof = {
    ...unsigned,
    possessionTag: b4a.alloc(16, 11),
    identitySignature: b4a.alloc(64, 12)
  }
  t.is(publicApi.encodeEntryProofUnsigned(unsigned).byteLength, 129)
  t.alike(
    publicApi.decodeEntryProofUnsigned(publicApi.encodeEntryProofUnsigned(unsigned)),
    unsigned
  )
  t.is(publicApi.encodeEntryProof(proof).byteLength, 209)
  t.alike(publicApi.decodeEntryProof(publicApi.encodeEntryProof(proof)), proof)
})

function entryProofFixture(overrides = {}) {
  const source = cryptoSuite.encryptionKeyPair(seed(120))
  const entryRoute = cryptoSuite.encryptionKeyPair(seed(121))
  const entryIdentity = privateRoleIdentity(60)
  const challenge = seed(122)
  const createValue = {
    version: PROTOCOL_VERSION,
    circuitId: b4a.alloc(16, 0x7a),
    epoch: 7n,
    descriptorId: seed(123),
    sourceEphemeralKey: source.publicKey,
    safetyTranscriptHash: seed(124),
    entryChallengeCipher: b4a.alloc(48),
    destinationChallengeCipher: b4a.alloc(48, 0x7d),
    encryptedHops: b4a.from('opaque private instructions'),
    ...overrides.create
  }
  const baseHash = publicApi.hashCreateBase(createValue)
  const shared = cryptoSuite.keyAgreement(source.secretKey, entryRoute.publicKey)
  createValue.entryChallengeCipher = activationChallengeCipher(shared, baseHash, challenge, 0)
  const create = publicApi.encodeCreate(createValue)
  const cache = publicApi.createEntryReplayCache({ now: () => 1_000 })
  const proof = publicApi.createEntryProof({
    create,
    entryIdentity: entryIdentity.publicKey,
    entryIdentitySecretKey: entryIdentity.secretKey,
    entryRouteEncryptionSecretKey: entryRoute.secretKey,
    expectedDescriptorId: createValue.descriptorId,
    expectedEpoch: createValue.epoch,
    expectedCircuitId: createValue.circuitId,
    expiresAt: 9_000n,
    startedAt: 1_000,
    now: () => 1_000,
    replayCache: cache,
    ...overrides.proof
  })
  return {
    baseHash,
    cache,
    challenge,
    create,
    createValue,
    entryIdentity,
    entryRoute,
    proof,
    source
  }
}

test('entry proves CREATE possession and Ed25519 identity ownership', (t) => {
  for (const name of ['createEntryReplayCache', 'createEntryProof', 'verifyEntryProof']) {
    t.is(typeof publicApi[name], 'function', name)
  }
  if (typeof publicApi.createEntryProof !== 'function') return
  const f = entryProofFixture()
  const verified = publicApi.verifyEntryProof({
    create: f.create,
    proof: f.proof,
    entryIdentity: f.entryIdentity.publicKey,
    entryRouteEncryptionKey: f.entryRoute.publicKey,
    sourceEphemeralSecretKey: f.source.secretKey,
    entryChallenge: f.challenge,
    expiresAt: 9_000n,
    startedAt: 1_000,
    now: () => 1_000
  })

  t.alike(verified, publicApi.decodeEntryProof(f.proof))
  t.is(f.cache.size, 1)
  expectCode(
    t,
    () =>
      publicApi.createEntryProof({
        create: f.create,
        entryIdentity: f.entryIdentity.publicKey,
        entryIdentitySecretKey: f.entryIdentity.secretKey,
        entryRouteEncryptionSecretKey: f.entryRoute.secretKey,
        expectedDescriptorId: f.createValue.descriptorId,
        expectedEpoch: f.createValue.epoch,
        expectedCircuitId: f.createValue.circuitId,
        expiresAt: 9_000n,
        startedAt: 1_000,
        now: () => 1_000,
        replayCache: f.cache
      }),
    'REPLAY'
  )
})

test('entry proof rejects key, CREATE, challenge, tag, signature, and expiry mutations', (t) => {
  if (typeof publicApi.createEntryProof !== 'function') {
    t.fail('entry proof API is missing')
    return
  }
  const f = entryProofFixture()
  const verify = (overrides = {}) =>
    publicApi.verifyEntryProof({
      create: f.create,
      proof: f.proof,
      entryIdentity: f.entryIdentity.publicKey,
      entryRouteEncryptionKey: f.entryRoute.publicKey,
      sourceEphemeralSecretKey: f.source.secretKey,
      entryChallenge: f.challenge,
      expiresAt: 9_000n,
      startedAt: 1_000,
      now: () => 1_000,
      ...overrides
    })
  const wrongIdentity = privateRoleIdentity(80)
  const wrongRoute = cryptoSuite.encryptionKeyPair(seed(125))
  const changedCreate = b4a.from(f.create)
  changedCreate[40] ^= 1
  const changedCipher = b4a.from(f.create)
  changedCipher[130] ^= 1
  const changedTag = b4a.from(f.proof)
  changedTag[129] ^= 1
  const changedSignature = b4a.from(f.proof)
  changedSignature[changedSignature.byteLength - 1] ^= 1
  for (const overrides of [
    { entryIdentity: wrongIdentity.publicKey },
    { entryRouteEncryptionKey: wrongRoute.publicKey },
    { create: changedCreate },
    { create: changedCipher },
    { entryChallenge: seed(126) },
    { proof: changedTag },
    { proof: changedSignature }
  ])
    expectCode(t, () => verify(overrides), 'UNAUTHORIZED')

  expectCode(t, () => verify({ now: () => 9_000 }), 'ROUTE_UNAVAILABLE')

  expectCode(t, () => entryProofFixture({ proof: { now: () => 9_000 } }), 'ROUTE_UNAVAILABLE')
})

test('entry proof creation rejects wrong local keys without consuming replay state', (t) => {
  const f = entryProofFixture()
  const wrongIdentity = privateRoleIdentity(80)
  const wrongRole = safetyRoleIdentity(80)
  const wrongRoute = cryptoSuite.encryptionKeyPair(seed(127))
  for (const changed of [
    { entryIdentitySecretKey: wrongIdentity.secretKey },
    {
      entryIdentity: wrongRole.publicKey,
      entryIdentitySecretKey: wrongRole.secretKey
    },
    { entryRouteEncryptionSecretKey: wrongRoute.secretKey }
  ]) {
    const cache = publicApi.createEntryReplayCache({ now: () => 1_000 })
    expectCode(
      t,
      () =>
        publicApi.createEntryProof({
          create: f.create,
          entryIdentity: f.entryIdentity.publicKey,
          entryIdentitySecretKey: f.entryIdentity.secretKey,
          entryRouteEncryptionSecretKey: f.entryRoute.secretKey,
          expectedDescriptorId: f.createValue.descriptorId,
          expectedEpoch: f.createValue.epoch,
          expectedCircuitId: f.createValue.circuitId,
          expiresAt: 9_000n,
          startedAt: 1_000,
          now: () => 1_000,
          replayCache: cache,
          ...changed
        }),
      'UNAUTHORIZED'
    )
    t.is(cache.size, 0)
  }
})

test('entry proof activation deadline fails at exactly five seconds', (t) => {
  const f = entryProofFixture()
  const common = {
    create: f.create,
    entryIdentity: f.entryIdentity.publicKey,
    entryRouteEncryptionKey: f.entryRoute.publicKey,
    sourceEphemeralSecretKey: f.source.secretKey,
    entryChallenge: f.challenge,
    expiresAt: 9_000n,
    startedAt: 1_000
  }
  t.ok(publicApi.verifyEntryProof({ ...common, proof: f.proof, now: () => 5_999 }))
  expectCode(
    t,
    () => publicApi.verifyEntryProof({ ...common, proof: f.proof, now: () => 6_000 }),
    'ROUTE_UNAVAILABLE'
  )
  expectCode(
    t,
    () =>
      publicApi.createEntryProof({
        create: f.create,
        entryIdentity: f.entryIdentity.publicKey,
        entryIdentitySecretKey: f.entryIdentity.secretKey,
        entryRouteEncryptionSecretKey: f.entryRoute.secretKey,
        expectedDescriptorId: f.createValue.descriptorId,
        expectedEpoch: f.createValue.epoch,
        expectedCircuitId: f.createValue.circuitId,
        expiresAt: 9_000n,
        startedAt: 1_000,
        now: () => 6_000,
        replayCache: publicApi.createEntryReplayCache({ now: () => 6_000 })
      }),
    'ROUTE_UNAVAILABLE'
  )
})

test('CREATED codec and compiled transcript lock exact canonical schemas', (t) => {
  for (const name of [
    'encodeCreatedUnsigned',
    'decodeCreatedUnsigned',
    'encodeCreated',
    'decodeCreated',
    'hashCompiledTranscript'
  ])
    t.is(typeof publicApi[name], 'function', name)
  if (typeof publicApi.encodeCreated !== 'function') return

  const unsigned = {
    version: PROTOCOL_VERSION,
    circuitId: b4a.alloc(16, 1),
    epoch: 7n,
    descriptorId: seed(2),
    endpointIdentity: seed(3),
    compiledTranscriptHash: seed(4),
    parametersHash: seed(5),
    destinationChallengeHash: seed(6),
    entryProofHash: seed(7),
    expiresAt: 9_000n
  }
  const created = {
    ...unsigned,
    possessionTag: b4a.alloc(16, 8),
    routeSignature: b4a.alloc(64, 9)
  }
  t.is(publicApi.encodeCreatedUnsigned(unsigned).byteLength, 225)
  t.alike(publicApi.decodeCreatedUnsigned(publicApi.encodeCreatedUnsigned(unsigned)), unsigned)
  t.is(publicApi.encodeCreated(created).byteLength, 305)
  t.alike(publicApi.decodeCreated(publicApi.encodeCreated(created)), created)
  t.is(
    publicApi.hashCompiledTranscript({
      safetyTranscriptHash: seed(10),
      encryptedHops: b4a.from('opaque'),
      entryProof: b4a.alloc(209, 11),
      sourceEphemeralKey: seed(12),
      circuitId: b4a.alloc(16, 13),
      epoch: 7n
    }).byteLength,
    32
  )
})

test('activation decoders clear owned fields after late validation failure', (t) => {
  const privateTemplate = encodePrivateTemplate({
    version: PROTOCOL_VERSION,
    descriptorId: seed(1),
    templateId: b4a.alloc(16, 2),
    epoch: 7n,
    expiresAt: 9_000n,
    relayIdentity: seed(3),
    nextAdvertisement: b4a.alloc(32, 4),
    nextLayer: b4a.alloc(64, 5)
  })
  const register = encodeTemplateRegister({
    version: PROTOCOL_VERSION,
    authorizationMode: AUTHORIZATION_MODE.DIRECT,
    descriptorId: seed(6),
    templateId: b4a.alloc(16, 7),
    epoch: 7n,
    expiresAt: 9_000n,
    endpointKey: seed(8),
    routeSigningKey: seed(8),
    relayIdentity: seed(9),
    templateCommitment: seed(10),
    nextCommitment: seed(11),
    destinationSignature: b4a.alloc(64, 12)
  })
  const registered = encodeTemplateRegistered({
    version: PROTOCOL_VERSION,
    descriptorId: seed(13),
    templateId: b4a.alloc(16, 14),
    epoch: 7n,
    expiresAt: 9_000n,
    relayIdentity: seed(15),
    templateCommitment: seed(16),
    relayIdentitySignature: b4a.alloc(64, 17)
  })
  const create = publicApi.encodeCreate({
    version: PROTOCOL_VERSION,
    circuitId: b4a.alloc(16, 18),
    epoch: 7n,
    descriptorId: seed(19),
    sourceEphemeralKey: seed(20),
    safetyTranscriptHash: seed(21),
    entryChallengeCipher: b4a.alloc(48, 22),
    destinationChallengeCipher: b4a.alloc(48, 23),
    encryptedHops: b4a.alloc(64, 24)
  })
  const entryProof = publicApi.encodeEntryProof({
    version: PROTOCOL_VERSION,
    circuitId: b4a.alloc(16, 25),
    epoch: 7n,
    entryIdentity: seed(26),
    createHash: seed(27),
    entryChallengeHash: seed(28),
    expiresAt: 9_000n,
    possessionTag: b4a.alloc(16, 29),
    identitySignature: b4a.alloc(64, 30)
  })
  const created = publicApi.encodeCreated({
    version: PROTOCOL_VERSION,
    circuitId: b4a.alloc(16, 31),
    epoch: 7n,
    descriptorId: seed(32),
    endpointIdentity: seed(33),
    compiledTranscriptHash: seed(34),
    parametersHash: seed(35),
    destinationChallengeHash: seed(36),
    entryProofHash: seed(37),
    expiresAt: 9_000n,
    possessionTag: b4a.alloc(16, 38),
    routeSignature: b4a.alloc(64, 39)
  })

  for (const [name, decoder, valid] of [
    ['private template', decodePrivateTemplate, privateTemplate],
    ['REGISTER', decodeTemplateRegister, register],
    ['REGISTERED', decodeTemplateRegistered, registered],
    ['CREATE', publicApi.decodeCreate, create],
    ['entry proof', publicApi.decodeEntryProof, entryProof],
    ['CREATED', publicApi.decodeCreated, created]
  ]) {
    const message = b4a.from(valid)
    message[0] = PROTOCOL_VERSION + 1
    const snapshot = b4a.from(message)
    const allocations = []
    const originalAlloc = b4a.allocUnsafeSlow
    b4a.allocUnsafeSlow = (size) => {
      const output = originalAlloc(size)
      allocations.push(output)
      return output
    }
    try {
      t.exception(() => decoder(message), `${name} rejects the late invalid version`)
    } finally {
      b4a.allocUnsafeSlow = originalAlloc
    }
    t.ok(allocations.length > 0, `${name} owns decoded field copies`)
    t.ok(
      allocations.every((allocation) => allocation.every((byte) => byte === 0)),
      `${name} clears every owned field copy`
    )
    t.alike(message, snapshot, `${name} leaves caller input unchanged`)
  }
})

function destinationProofFixture() {
  const source = cryptoSuite.encryptionKeyPair(seed(130))
  const entryRoute = cryptoSuite.encryptionKeyPair(seed(131))
  const destinationRoute = cryptoSuite.encryptionKeyPair(seed(132))
  const entryIdentity = privateRoleIdentity(100)
  const destinationIdentity = cryptoSuite.keyPair(seed(133))
  const entryChallenge = seed(134)
  const destinationChallenge = seed(135)
  const createValue = {
    version: PROTOCOL_VERSION,
    circuitId: b4a.alloc(16, 0x88),
    epoch: 7n,
    descriptorId: seed(136),
    sourceEphemeralKey: source.publicKey,
    safetyTranscriptHash: seed(137),
    entryChallengeCipher: b4a.alloc(48),
    destinationChallengeCipher: b4a.alloc(48),
    encryptedHops: b4a.from('opaque registered private route')
  }
  const baseHash = publicApi.hashCreateBase(createValue)
  const entryShared = cryptoSuite.keyAgreement(source.secretKey, entryRoute.publicKey)
  const destinationShared = cryptoSuite.keyAgreement(source.secretKey, destinationRoute.publicKey)
  createValue.entryChallengeCipher = activationChallengeCipher(
    entryShared,
    baseHash,
    entryChallenge,
    0
  )
  createValue.destinationChallengeCipher = activationChallengeCipher(
    destinationShared,
    baseHash,
    destinationChallenge,
    1
  )
  const create = publicApi.encodeCreate(createValue)
  const entryProof = publicApi.createEntryProof({
    create,
    entryIdentity: entryIdentity.publicKey,
    entryIdentitySecretKey: entryIdentity.secretKey,
    entryRouteEncryptionSecretKey: entryRoute.secretKey,
    expectedDescriptorId: createValue.descriptorId,
    expectedEpoch: createValue.epoch,
    expectedCircuitId: createValue.circuitId,
    expiresAt: 9_000n,
    startedAt: 1_000,
    now: () => 1_000,
    replayCache: publicApi.createEntryReplayCache({ now: () => 1_000 })
  })
  const parameters = {
    version: 0,
    cellSize: 1200,
    routeFrameSize: 1100,
    maxCellPayload: 1146,
    maxRoutePayload: 1073,
    capabilities: 7,
    safetyMin: 1,
    safetyMax: 3,
    privateMin: 1,
    privateMax: 3,
    counterWindow: 64
  }
  const cache = publicApi.createDestinationReplayCache({ now: () => 1_000 })
  const sourceReplay = publicApi.createDestinationReplayCache({ now: () => 1_000 })
  const created = publicApi.createDestinationProof({
    create,
    entryProof,
    endpointIdentity: destinationIdentity.publicKey,
    routeSigningKey: destinationIdentity.publicKey,
    routeSigningSecretKey: destinationIdentity.secretKey,
    destinationRouteEncryptionSecretKey: destinationRoute.secretKey,
    expectedDescriptorId: createValue.descriptorId,
    expectedEpoch: createValue.epoch,
    expectedCircuitId: createValue.circuitId,
    parameters,
    expiresAt: 9_000n,
    startedAt: 1_000,
    now: () => 1_000,
    replayCache: cache
  })
  return {
    cache,
    create,
    createValue,
    created,
    destinationChallenge,
    destinationIdentity,
    destinationRoute,
    entryProof,
    parameters,
    source,
    sourceReplay
  }
}

test('destination activation request is canonical bounded bytes for the full proof context', (t) => {
  const fixture = destinationProofFixture()
  const value = {
    finalToken: b4a.alloc(64, 0xfe),
    create: fixture.create,
    entryProof: fixture.entryProof,
    parameters: fixture.parameters,
    expiresAt: 9_000n,
    startedAt: 1_000
  }
  const encoded = publicApi.encodeDestinationActivationRequest(value)

  t.ok(b4a.isBuffer(encoded))
  t.is(encoded.byteLength, 19 + 64 + fixture.create.byteLength + 209 + 19)
  t.ok(encoded.byteLength <= 8_192)
  t.alike(publicApi.decodeDestinationActivationRequest(encoded), value)

  const trailing = b4a.concat([encoded, b4a.from([0])])
  expectCode(t, () => publicApi.decodeDestinationActivationRequest(trailing), 'INVALID_ROUTE')
})

test('destination CREATED proves the full transcript and derives payload keys', (t) => {
  for (const name of [
    'createDestinationReplayCache',
    'createDestinationProof',
    'verifyDestinationProof'
  ])
    t.is(typeof publicApi[name], 'function', name)
  if (typeof publicApi.createDestinationProof !== 'function') return
  const f = destinationProofFixture()
  const verified = publicApi.verifyDestinationProof({
    create: f.create,
    entryProof: f.entryProof,
    created: f.created,
    endpointIdentity: f.destinationIdentity.publicKey,
    routeSigningKey: f.destinationIdentity.publicKey,
    destinationRouteEncryptionKey: f.destinationRoute.publicKey,
    sourceEphemeralSecretKey: f.source.secretKey,
    destinationChallenge: f.destinationChallenge,
    parameters: f.parameters,
    expiresAt: 9_000n,
    startedAt: 1_000,
    now: () => 1_000,
    replayCache: f.sourceReplay
  })

  t.alike(verified.created, publicApi.decodeCreated(f.created))
  t.is(verified.payloadKeys.forwardKey.byteLength, 32)
  t.is(verified.payloadKeys.reverseKey.byteLength, 32)
  t.is(verified.payloadKeys.forwardNoncePrefix.byteLength, 16)
  t.is(verified.payloadKeys.reverseNoncePrefix.byteLength, 16)
  t.is(f.cache.size, 1)
  t.is(f.sourceReplay.size, 1)
  expectCode(
    t,
    () =>
      publicApi.verifyDestinationProof({
        create: f.create,
        entryProof: f.entryProof,
        created: f.created,
        endpointIdentity: f.destinationIdentity.publicKey,
        routeSigningKey: f.destinationIdentity.publicKey,
        destinationRouteEncryptionKey: f.destinationRoute.publicKey,
        sourceEphemeralSecretKey: f.source.secretKey,
        destinationChallenge: f.destinationChallenge,
        parameters: f.parameters,
        expiresAt: 9_000n,
        startedAt: 1_000,
        now: () => 1_000,
        replayCache: f.sourceReplay
      }),
    'REPLAY'
  )
})

test('activation proof clocks reject rollback before startedAt', (t) => {
  const entry = entryProofFixture()
  const entryCreate = {
    create: entry.create,
    entryIdentity: entry.entryIdentity.publicKey,
    entryIdentitySecretKey: entry.entryIdentity.secretKey,
    entryRouteEncryptionSecretKey: entry.entryRoute.secretKey,
    expectedDescriptorId: entry.createValue.descriptorId,
    expectedEpoch: entry.createValue.epoch,
    expectedCircuitId: entry.createValue.circuitId,
    expiresAt: 9_000n,
    startedAt: 1_000,
    now: () => 999,
    replayCache: publicApi.createEntryReplayCache({ now: () => 999 })
  }
  expectCode(t, () => publicApi.createEntryProof(entryCreate), 'ROUTE_UNAVAILABLE')
  expectCode(
    t,
    () =>
      publicApi.verifyEntryProof({
        create: entry.create,
        proof: entry.proof,
        entryIdentity: entry.entryIdentity.publicKey,
        entryRouteEncryptionKey: entry.entryRoute.publicKey,
        sourceEphemeralSecretKey: entry.source.secretKey,
        entryChallenge: entry.challenge,
        expiresAt: 9_000n,
        startedAt: 1_000,
        now: () => 999
      }),
    'ROUTE_UNAVAILABLE'
  )

  const destination = destinationProofFixture()
  expectCode(
    t,
    () =>
      publicApi.createDestinationProof({
        create: destination.create,
        entryProof: destination.entryProof,
        endpointIdentity: destination.destinationIdentity.publicKey,
        routeSigningKey: destination.destinationIdentity.publicKey,
        routeSigningSecretKey: destination.destinationIdentity.secretKey,
        destinationRouteEncryptionSecretKey: destination.destinationRoute.secretKey,
        expectedDescriptorId: destination.createValue.descriptorId,
        expectedEpoch: destination.createValue.epoch,
        expectedCircuitId: destination.createValue.circuitId,
        parameters: destination.parameters,
        expiresAt: 9_000n,
        startedAt: 1_000,
        now: () => 999,
        replayCache: publicApi.createDestinationReplayCache({ now: () => 999 })
      }),
    'ROUTE_UNAVAILABLE'
  )
  expectCode(
    t,
    () =>
      publicApi.verifyDestinationProof({
        create: destination.create,
        entryProof: destination.entryProof,
        created: destination.created,
        endpointIdentity: destination.destinationIdentity.publicKey,
        routeSigningKey: destination.destinationIdentity.publicKey,
        destinationRouteEncryptionKey: destination.destinationRoute.publicKey,
        sourceEphemeralSecretKey: destination.source.secretKey,
        destinationChallenge: destination.destinationChallenge,
        parameters: destination.parameters,
        expiresAt: 9_000n,
        startedAt: 1_000,
        now: () => 999,
        replayCache: publicApi.createDestinationReplayCache({ now: () => 999 })
      }),
    'ROUTE_UNAVAILABLE'
  )
})

test('destination CREATED rejects every transcript, key, proof, and parameter mutation', (t) => {
  const f = destinationProofFixture()
  const verify = (overrides = {}) =>
    publicApi.verifyDestinationProof({
      create: f.create,
      entryProof: f.entryProof,
      created: f.created,
      endpointIdentity: f.destinationIdentity.publicKey,
      routeSigningKey: f.destinationIdentity.publicKey,
      destinationRouteEncryptionKey: f.destinationRoute.publicKey,
      sourceEphemeralSecretKey: f.source.secretKey,
      destinationChallenge: f.destinationChallenge,
      parameters: f.parameters,
      expiresAt: 9_000n,
      startedAt: 1_000,
      now: () => 1_000,
      replayCache: f.sourceReplay,
      ...overrides
    })
  const mutate = (value, index) => {
    const changed = b4a.from(value)
    changed[index] ^= 1
    return changed
  }
  const wrongIdentity = cryptoSuite.keyPair(seed(138))
  const wrongRoute = cryptoSuite.encryptionKeyPair(seed(139))
  const wrongParameters = { ...f.parameters, counterWindow: 63 }
  for (const overrides of [
    { endpointIdentity: wrongIdentity.publicKey },
    { routeSigningKey: wrongIdentity.publicKey },
    { destinationRouteEncryptionKey: wrongRoute.publicKey },
    { create: mutate(f.create, 40) },
    { create: mutate(f.create, 60) },
    { create: mutate(f.create, 90) },
    { create: mutate(f.create, 170) },
    { create: mutate(f.create, f.create.byteLength - 1) },
    { entryProof: mutate(f.entryProof, 40) },
    { destinationChallenge: seed(140) },
    { created: mutate(f.created, 225) },
    { created: mutate(f.created, f.created.byteLength - 1) },
    { parameters: wrongParameters }
  ])
    expectCode(t, () => verify(overrides), 'UNAUTHORIZED')

  expectCode(
    t,
    () =>
      publicApi.createDestinationProof({
        create: f.create,
        entryProof: f.entryProof,
        endpointIdentity: f.destinationIdentity.publicKey,
        routeSigningKey: f.destinationIdentity.publicKey,
        routeSigningSecretKey: f.destinationIdentity.secretKey,
        destinationRouteEncryptionSecretKey: f.destinationRoute.secretKey,
        expectedDescriptorId: f.createValue.descriptorId,
        expectedEpoch: f.createValue.epoch,
        expectedCircuitId: f.createValue.circuitId,
        parameters: f.parameters,
        expiresAt: 9_000n,
        startedAt: 1_000,
        now: () => 1_000,
        replayCache: f.cache
      }),
    'REPLAY'
  )
  expectCode(t, () => verify({ now: () => 6_000 }), 'ROUTE_UNAVAILABLE')
})

test('destination builds and registers a three-hop private route', (t) => {
  const owner = destination()
  const relays = [relay(1, 'entry'), relay(20, 'middle'), relay(40, 'final')]
  let random = 0
  const built = buildPrivateTemplates({
    descriptorId: owner.descriptorId,
    epoch: owner.epoch,
    expiresAt: owner.expiresAt,
    endpointKey: owner.identity.publicKey,
    routeSigningKey: owner.identity.publicKey,
    authorizationMode: AUTHORIZATION_MODE.DIRECT,
    destinationSecretKey: owner.identity.secretKey,
    relays: relays.map((value) => encodeRelayAdvertisement(value.advertisement)),
    randomBytes(size) {
      return b4a.alloc(size, ++random)
    },
    finalToken: b4a.alloc(64, 0xfe),
    now: 1_000n
  })

  t.is(built.encryptedHops.byteLength <= 4096, true)
  t.is(built.registrationCapsule.byteLength, 2_701)
  t.is(built.registrations.length, 3)

  for (let i = 0; i < relays.length; i++) {
    const registry = createTemplateRegistry({
      identity: relays[i].identity.publicKey,
      identitySecretKey: relays[i].identity.secretKey,
      routeEncryptionSecretKey: relays[i].encryption.secretKey,
      now: () => 1_000
    })
    const ack = registry.register(built.registrations[i])
    const decoded = decodeTemplateRegister(built.registrations[i].message)
    const decodedAck = decodeTemplateRegistered(ack)
    t.alike(decodedAck.descriptorId, owner.descriptorId)
    t.alike(decodedAck.templateId, decoded.templateId)
    t.alike(decodedAck.relayIdentity, relays[i].identity.publicKey)
    t.is(registry.size, 1)
    t.alike(Object.keys(registry.inspect()[0]).sort(), [
      'commitment',
      'descriptorId',
      'epoch',
      'expiresAt',
      'nextCommitment',
      'templateId'
    ])
  }
})

test('registration accepts an opaque entry actor and invokes the Safety CONTROL capability', (t) => {
  const fixture = builtFixture([relay(1, 'entry')])
  t.ok(b4a.isBuffer(fixture.built.registrationCapsule))
  const registrationCapsule = fixture.built.registrationCapsule || b4a.alloc(0)
  t.ok(registrationCapsule.byteLength > 0 && registrationCapsule.byteLength <= 8_192)
  const portableBuilt = Object.freeze({
    encryptedHops: b4a.from(fixture.built.encryptedHops),
    registrationCapsule: b4a.from(registrationCapsule),
    prepareCapsule: b4a.from(fixture.built.prepareCapsule),
    finalizeCapsule: b4a.from(fixture.built.finalizeCapsule),
    abortCapsule: b4a.from(fixture.built.abortCapsule),
    transactionId: b4a.from(fixture.built.transactionId),
    registrations: Object.freeze(
      fixture.built.registrations.map((registration) =>
        Object.freeze({
          message: b4a.from(registration.message),
          sealedTemplate: b4a.from(registration.sealedTemplate)
        })
      )
    )
  })
  const entry = fixture.relays[0]
  const destinationActor = destinationActorFor(fixture)
  const actor = createPrivateRelayActor({
    identity: entry.identity.publicKey,
    identitySecretKey: entry.identity.secretKey,
    routeEncryptionSecretKey: entry.encryption.secretKey,
    destination: destinationActor,
    now: () => 1_000,
    randomBytes: sequenceBytes(30)
  })
  let controls = 0
  const safetyRoute = registrationSafetyRoute(function sendControl(fragments, deliver) {
    controls += fragments.length
    for (const fragment of fragments) deliver(fragment)
    return true
  })

  const result = registerPrivateRoute({
    built: portableBuilt,
    entryActor: actor,
    safetyRoute,
    now: () => 1_000,
    randomBytes: sequenceBytes(60)
  })

  t.is(result.registered, true)
  t.is(result.acknowledgements.length, 1)
  t.alike(
    decodeTemplateRegistered(result.acknowledgements[0]).relayIdentity,
    entry.identity.publicKey
  )
  t.ok(controls > 0)
  t.alike(Object.keys(actor), [])
  t.is(actor.registry, undefined)
  t.is(actor.identitySecretKey, undefined)
  destroyPrivateRelayActor(actor)
  destroyPrivateDestinationActor(destinationActor)
})

test('relay-owned registration reveals only actual local adjacent CONTROL operations', (t) => {
  const fixture = builtFixture()
  const destinationActor = destinationActorFor(fixture)
  const views = fixture.relays.map(() => [])
  let next
  const actors = new Array(fixture.relays.length)
  for (let index = fixture.relays.length - 1; index >= 0; index--) {
    const value = fixture.relays[index]
    const actor = createPrivateRelayActor({
      identity: value.identity.publicKey,
      identitySecretKey: value.identity.secretKey,
      routeEncryptionSecretKey: value.encryption.secretKey,
      now: () => 1_000,
      randomBytes: sequenceBytes(100 + index * 20),
      next,
      destination: index === fixture.relays.length - 1 ? destinationActor : undefined,
      observe(event) {
        views[index].push(event)
      }
    })
    actors[index] = actor
    next = actor
  }
  const safetyRoute = registrationSafetyRoute(function sendControl(fragments, deliver) {
    for (const fragment of fragments) deliver(fragment)
    return true
  })

  const result = registerPrivateRoute({
    built: fixture.built,
    entryActor: actors[0],
    safetyRoute,
    now: () => 1_000,
    randomBytes: sequenceBytes(200)
  })

  t.is(result.registered, true)
  t.alike(Object.keys(result).sort(), ['acknowledgements', 'registered', 'safetyRoute'])
  t.is(result.acknowledgements.length, 3)
  for (let index = 0; index < result.acknowledgements.length; index++) {
    const acknowledgement = decodeTemplateRegistered(result.acknowledgements[index])
    t.alike(acknowledgement.relayIdentity, fixture.relays[index].identity.publicKey)
  }
  const adjacent = views.map((events) =>
    [
      ...new Set(
        events
          .filter((event) => event.peerIdentity !== undefined)
          .map((event) => event.peerIdentity)
      )
    ].sort()
  )
  t.alike(adjacent, [
    [b4a.toString(fixture.relays[1].identity.publicKey, 'hex')],
    [
      b4a.toString(fixture.relays[0].identity.publicKey, 'hex'),
      b4a.toString(fixture.relays[2].identity.publicKey, 'hex')
    ].sort(),
    [
      b4a.toString(fixture.relays[1].identity.publicKey, 'hex'),
      b4a.toString(fixture.owner.identity.publicKey, 'hex')
    ].sort()
  ])
  for (let index = 0; index < views.length; index++) {
    for (const event of views[index].filter((value) => value.packetBytes !== undefined)) {
      t.alike(Object.keys(event).sort(), [
        'localIdentity',
        'packetBytes',
        'packetHash',
        'peerIdentity'
      ])
      t.is(event.localIdentity, b4a.toString(fixture.relays[index].identity.publicKey, 'hex'))
      t.is(event.packetBytes, 1200)
      t.is(event.packetHash.length, 64)
    }
  }
  for (const actor of actors) destroyPrivateRelayActor(actor)
  destroyPrivateDestinationActor(destinationActor)
})

test('destination registration attachment authenticates ack and expires at exactly 5000ms', (t) => {
  for (const fault of ['4999', '5000', 'forged-ack', 'dropped-ack']) {
    const fixture = builtFixture([relay(1, `entry-${fault}`)])
    const entry = fixture.relays[0]
    let now = 1_000
    const relayEvents = []
    const destinationEvents = []
    const destinationActor = destinationActorFor(fixture, {
      now: () => now,
      observe(event) {
        destinationEvents.push(event)
      },
      [TEST_ONLY_DESTINATION_REGISTRATION_ACK_MUTATOR](acknowledgement) {
        if (fault === '4999') now = 5_999
        if (fault === '5000') now = 6_000
        if (fault === 'dropped-ack') return null
        if (fault === 'forged-ack') acknowledgement[0] ^= 1
        return acknowledgement
      }
    })
    const entryActor = createPrivateRelayActor({
      identity: entry.identity.publicKey,
      identitySecretKey: entry.identity.secretKey,
      routeEncryptionSecretKey: entry.encryption.secretKey,
      destination: destinationActor,
      now: () => now,
      randomBytes: sequenceBytes(400),
      observe(event) {
        relayEvents.push(event)
      }
    })
    const safetyRoute = registrationSafetyRoute(function sendControl(fragments, deliver) {
      let result
      for (const fragment of fragments) {
        const value = deliver(fragment)
        if (value !== undefined) result = value
      }
      return result === undefined ? true : result
    })

    const result = registerPrivateRoute({
      built: fixture.built,
      entryActor,
      safetyRoute,
      now: () => now,
      randomBytes: sequenceBytes(450)
    })

    t.is(result.registered, fault === '4999', fault)
    if (fault !== '4999') t.ok(result.failureCode, fault)
    const relayDestroyed = relayEvents.filter(
      (event) => event.type === 'private-registration-attachment-destroyed'
    )
    const destinationDestroyed = destinationEvents.filter(
      (event) => event.type === 'private-registration-attachment-destroyed'
    )
    t.alike(
      relayDestroyed.map(({ activeAttachments, contexts }) => [activeAttachments, contexts]),
      [[0, 6]],
      fault
    )
    t.alike(
      destinationDestroyed.map(({ activeAttachments, contexts }) => [activeAttachments, contexts]),
      [[0, 6]],
      fault
    )
    const registryEvent = relayEvents.find(
      (event) =>
        event.type ===
        (fault === '4999' ? 'private-registration-staged' : 'private-registration-rollback')
    )
    t.is(registryEvent.records, fault === '4999' ? 1 : 0, fault)
    t.ok(
      [...relayEvents, ...destinationEvents]
        .filter((event) => event.packetBytes !== undefined)
        .every((event) => event.packetBytes === 1200),
      fault
    )

    destroyPrivateRelayActor(entryActor)
    destroyPrivateDestinationActor(destinationActor)
  }

  const fixture = builtFixture()
  let now = 1_000
  const views = fixture.relays.map(() => [])
  const destinationActor = destinationActorFor(fixture, {
    now: () => now,
    [TEST_ONLY_DESTINATION_REGISTRATION_ACK_MUTATOR](acknowledgement) {
      now = 6_000
      return acknowledgement
    }
  })
  let next
  const actors = new Array(fixture.relays.length)
  for (let index = fixture.relays.length - 1; index >= 0; index--) {
    const relay = fixture.relays[index]
    actors[index] = createPrivateRelayActor({
      identity: relay.identity.publicKey,
      identitySecretKey: relay.identity.secretKey,
      routeEncryptionSecretKey: relay.encryption.secretKey,
      next,
      destination: index === fixture.relays.length - 1 ? destinationActor : undefined,
      now: () => now,
      randomBytes: sequenceBytes(500 + index * 20),
      observe(event) {
        views[index].push(event)
      }
    })
    next = actors[index]
  }
  const rolledBack = registerPrivateRoute({
    built: fixture.built,
    entryActor: actors[0],
    safetyRoute: registrationSafetyRoute(function sendControl(fragments, deliver) {
      for (const fragment of fragments) deliver(fragment)
      return true
    }),
    now: () => now,
    randomBytes: sequenceBytes(580)
  })
  t.is(rolledBack.registered, false)
  t.alike(
    views.map(
      (events) =>
        events.filter((event) => event.type === 'private-registration-rollback').at(-1).records
    ),
    [0, 0, 0]
  )
  for (const actor of actors) destroyPrivateRelayActor(actor)
  destroyPrivateDestinationActor(destinationActor)
})

test('destination registration attachment clears opened CONTROL fragments', (t) => {
  const fixture = builtFixture([relay(1, 'clear-opened-control')])
  const entry = fixture.relays[0]
  const destinationActor = destinationActorFor(fixture)
  const entryActor = createPrivateRelayActor({
    identity: entry.identity.publicKey,
    identitySecretKey: entry.identity.secretKey,
    routeEncryptionSecretKey: entry.encryption.secretKey,
    destination: destinationActor,
    now: () => 1_000,
    randomBytes: sequenceBytes(600)
  })
  const safetyRoute = registrationSafetyRoute(function sendControl(fragments, deliver) {
    let result
    for (const fragment of fragments) {
      const value = deliver(fragment)
      if (value !== undefined) result = value
    }
    return result === undefined ? true : result
  })
  const opened = []
  const originalFrom = b4a.from
  b4a.from = (...args) => {
    const output = originalFrom(...args)
    const input = args[0]
    if (b4a.isBuffer(input) && input.byteLength <= 1_146 && input.buffer.byteLength === 1_148)
      opened.push(output)
    return output
  }
  try {
    const result = registerPrivateRoute({
      built: fixture.built,
      entryActor,
      safetyRoute,
      now: () => 1_000,
      randomBytes: sequenceBytes(650)
    })
    t.ok(result.registered)
  } finally {
    b4a.from = originalFrom
    destroyPrivateRelayActor(entryActor)
    destroyPrivateDestinationActor(destinationActor)
  }
  t.ok(opened.length >= 2, 'captures forward token and reverse acknowledgement fragments')
  t.ok(
    opened.every((fragment) => fragment.every((byte) => byte === 0)),
    'every opened CONTROL fragment is cleared after reassembly'
  )
})

test('registration transaction deadline starts before the first Safety send', (t) => {
  const fixture = builtFixture([relay(1, 'deadline-entry')])
  const entry = fixture.relays[0]
  let now = 1_000
  let sends = 0
  let destroyed = 0
  const destinationActor = destinationActorFor(fixture, { now: () => now })
  const entryActor = createPrivateRelayActor({
    identity: entry.identity.publicKey,
    identitySecretKey: entry.identity.secretKey,
    routeEncryptionSecretKey: entry.encryption.secretKey,
    destination: destinationActor,
    now: () => now,
    randomBytes: sequenceBytes(600)
  })
  const safetyRoute = Object.freeze({
    attachEntry() {
      now = 6_000
      return Object.freeze({
        destroy() {
          destroyed++
        }
      })
    },
    sendControl() {
      sends++
      return true
    },
    sendReverseFrame(cellClass, frame, deliver) {
      return deliver(frame)
    }
  })

  const result = registerPrivateRoute({
    built: fixture.built,
    entryActor,
    safetyRoute,
    now: () => now,
    randomBytes: sequenceBytes(620)
  })

  t.alike(Object.keys(result).sort(), ['failureCode', 'registered', 'safetyRoute'])
  t.is(result.registered, false)
  t.is(result.failureCode, 'ROUTE_UNAVAILABLE')
  t.is(sends, 0)
  t.is(destroyed, 1)
  destroyPrivateRelayActor(entryActor)
  destroyPrivateDestinationActor(destinationActor)
})

test('registration PREPARE, FINALIZE, and ABORT are authenticated onion commands', (t) => {
  function actorsFor(
    fixture,
    now,
    views,
    commandAckMutator = null,
    entryTransmit = null,
    throwOnCommit = false,
    onObserve = null
  ) {
    const destinationActor = destinationActorFor(fixture, { now })
    let next
    const actors = new Array(fixture.relays.length)
    for (let index = fixture.relays.length - 1; index >= 0; index--) {
      const relay = fixture.relays[index]
      actors[index] = createPrivateRelayActor({
        identity: relay.identity.publicKey,
        identitySecretKey: relay.identity.secretKey,
        routeEncryptionSecretKey: relay.encryption.secretKey,
        next,
        destination: index === fixture.relays.length - 1 ? destinationActor : undefined,
        now,
        randomBytes: sequenceBytes(700 + index * 40),
        observe(event) {
          views[index].push(event)
          if (onObserve) onObserve(event, index)
          if (throwOnCommit && event.type === 'private-registration-commit')
            throw new Error('observer failure')
        },
        ...(index === 1 && commandAckMutator
          ? { [TEST_ONLY_REGISTRATION_COMMAND_ACK_MUTATOR]: commandAckMutator }
          : {}),
        ...(index === 0 && entryTransmit ? { transmit: entryTransmit } : {})
      })
      next = actors[index]
    }
    return { actors, destinationActor }
  }

  function safetyRoute(fault, setDeadline = null) {
    return registrationSafetyRoute(
      function sendControl(fragments, deliver) {
        for (const fragment of fragments) deliver(fragment)
        return true
      },
      function sendReverseFrame(cellClass, frame, deliver) {
        if (fault === 'drop') return false
        const changed = b4a.from(frame)
        if (fault === 'wrong-count') changed[ACTIVATION_FRAGMENT_HEADER_SIZE + 1] = 2
        if (fault === 'wrong-signature') changed[changed.byteLength - 1] ^= 1
        if (fault === 'deadline') setDeadline()
        return deliver(changed)
      }
    )
  }

  for (const fault of ['drop', 'wrong-count', 'wrong-signature', 'deadline']) {
    const fixture = builtFixture()
    let now = 1_000
    const views = fixture.relays.map(() => [])
    const { actors, destinationActor } = actorsFor(fixture, () => now, views)
    const route = safetyRoute(fault, () => {
      now = 6_000
    })
    const result = registerPrivateRoute({
      built: fixture.built,
      entryActor: actors[0],
      safetyRoute: route,
      now: () => now,
      randomBytes: sequenceBytes(900)
    })

    t.is(result.registered, false, fault)
    t.alike(
      views.map(
        (events) =>
          events.filter((event) => event.type === 'private-registration-rollback').at(-1).records
      ),
      [0, 0, 0],
      fault
    )
    t.ok(
      views.every(
        (events) => !events.some((event) => event.type === 'private-registration-commit')
      ),
      fault
    )
    for (const actor of actors) destroyPrivateRelayActor(actor)
    destroyPrivateDestinationActor(destinationActor)
  }

  {
    const fixture = builtFixture()
    const views = fixture.relays.map(() => [])
    let commandAcknowledgements = 0
    const { actors, destinationActor } = actorsFor(
      fixture,
      () => 1_000,
      views,
      (acknowledgement) => {
        commandAcknowledgements++
        return commandAcknowledgements === 1 ? null : acknowledgement
      }
    )
    const result = registerPrivateRoute({
      built: fixture.built,
      entryActor: actors[0],
      safetyRoute: safetyRoute(),
      now: () => 1_000,
      randomBytes: sequenceBytes(950)
    })

    t.is(result.registered, false, 'lost PREPARE acknowledgement fails registration')
    t.alike(
      views.map(
        (events) =>
          events.filter((event) => event.type === 'private-registration-rollback').at(-1).records
      ),
      [0, 0, 0],
      'ABORT removes staged and prepared records after downstream PREPARE'
    )
    t.ok(
      views.every(
        (events) => !events.some((event) => event.type === 'private-registration-commit')
      ),
      'no relay finalized the failed transaction'
    )
    for (const actor of actors) destroyPrivateRelayActor(actor)
    destroyPrivateDestinationActor(destinationActor)
  }

  {
    const fixture = builtFixture()
    const views = fixture.relays.map(() => [])
    let now = 1_000
    let commandAcknowledgements = 0
    const { actors, destinationActor } = actorsFor(
      fixture,
      () => now,
      views,
      (acknowledgement) => {
        commandAcknowledgements++
        if (commandAcknowledgements === 1) now = 6_000
        return acknowledgement
      }
    )
    const result = registerPrivateRoute({
      built: fixture.built,
      entryActor: actors[0],
      safetyRoute: safetyRoute(),
      now: () => now,
      randomBytes: sequenceBytes(975)
    })

    t.is(result.registered, false, 'deadline after deepest PREPARE fails before FINALIZE')
    t.alike(
      views.map(
        (events) =>
          events.filter((event) => event.type === 'private-registration-rollback').at(-1).records
      ),
      [0, 0, 0],
      'post-PREPARE deadline ABORT removes every staged/prepared record'
    )
    t.ok(
      views.every((events) => !events.some((event) => event.type === 'private-registration-commit'))
    )
    for (const actor of actors) destroyPrivateRelayActor(actor)
    destroyPrivateDestinationActor(destinationActor)
  }

  {
    const fixture = builtFixture()
    const views = fixture.relays.map(() => [])
    let entryActor = null
    let downstreamStaged = false
    let queued = false
    let pending = 0
    let cancellations = 0
    const transmit = (from, to, packet, receive) => {
      if (
        downstreamStaged &&
        !queued &&
        from !== entryActor &&
        to === entryActor &&
        packet.byteLength === 1_200
      ) {
        queued = true
        pending++
        return Object.freeze({
          cancel() {
            cancellations++
            pending--
            return 1
          }
        })
      }
      receive(packet)
      return true
    }
    const { actors, destinationActor } = actorsFor(
      fixture,
      () => 1_000,
      views,
      null,
      transmit,
      false,
      (event, index) => {
        if (index === fixture.relays.length - 1 && event.type === 'private-registration-staged')
          downstreamStaged = true
      }
    )
    entryActor = actors[0]
    const result = registerPrivateRoute({
      built: fixture.built,
      entryActor,
      safetyRoute: safetyRoute(),
      now: () => 1_000,
      randomBytes: sequenceBytes(980)
    })

    t.is(result.registered, false, 'dropped nested registration acknowledgement fails closed')
    t.is(pending, 0, 'dropped nested acknowledgement is cancelled')
    t.is(cancellations, 1, 'nested acknowledgement cancellation runs once')
    t.ok(
      views.every(
        (events) => !events.some((event) => event.type === 'private-registration-commit')
      ),
      'dropped nested acknowledgement cannot commit any relay'
    )
    for (const actor of actors) destroyPrivateRelayActor(actor)
    t.alike(
      views.map(
        (events) =>
          events.filter((event) => event.type === 'private-relay-destroying').at(-1).records
      ),
      [0, 0, 0],
      'authenticated ABORT removes downstream staged records after a lost return acknowledgement'
    )
    destroyPrivateDestinationActor(destinationActor)
  }

  for (const command of ['PREPARE', 'FINALIZE']) {
    const fixture = builtFixture()
    const views = fixture.relays.map(() => [])
    let entryActor = null
    let phase = 'STAGE'
    let queuedPhase = null
    let queued = false
    let pending = 0
    let cancellations = 0
    const transmit = (from, to, packet, receive) => {
      if (!queued && phase === command && from === entryActor && packet.byteLength === 1_200) {
        queued = true
        queuedPhase = phase
        pending++
        return Object.freeze({
          cancel() {
            cancellations++
            pending--
            return 1
          }
        })
      }
      receive(packet)
      return true
    }
    const { actors, destinationActor } = actorsFor(
      fixture,
      () => 1_000,
      views,
      null,
      transmit,
      false,
      (event, index) => {
        if (index !== fixture.relays.length - 1) return
        if (event.type === 'private-registration-staged') phase = 'PREPARE'
        if (event.type === 'private-registration-prepared') phase = 'FINALIZE'
      }
    )
    entryActor = actors[0]
    const result = registerPrivateRoute({
      built: fixture.built,
      entryActor: actors[0],
      safetyRoute: safetyRoute(),
      now: () => 1_000,
      randomBytes: sequenceBytes(command === 'PREPARE' ? 987 : 988)
    })

    t.is(result.registered, false, `queued ${command} is not reported committed`)
    t.is(queuedPhase, command, `the cancelled fragment belongs to ${command}`)
    t.is(pending, 0, `queued ${command} delivery is cancelled`)
    t.is(cancellations, 1, `queued ${command} cancellation runs once`)
    t.alike(
      views.map(
        (events) =>
          events.filter((event) => event.type === 'private-registration-rollback').at(-1).records
      ),
      [0, 0, 0],
      `${command} failure leaves no staged or prepared records`
    )
    t.ok(
      views.every(
        (events) => !events.some((event) => event.type === 'private-registration-commit')
      ),
      `${command} failure emits no false commit`
    )
    for (const actor of actors) destroyPrivateRelayActor(actor)
    destroyPrivateDestinationActor(destinationActor)
  }

  {
    const fixture = builtFixture()
    const views = fixture.relays.map(() => [])
    const { actors, destinationActor } = actorsFor(fixture, () => 1_000, views, null, null, true)
    const result = registerPrivateRoute({
      built: fixture.built,
      entryActor: actors[0],
      safetyRoute: safetyRoute(),
      now: () => 1_000,
      randomBytes: sequenceBytes(995)
    })

    t.is(result.registered, true, 'commit observer exceptions are passive')
    t.ok(
      views.every((events) => events.some((event) => event.type === 'private-registration-commit')),
      'every relay reaches the same committed decision'
    )
    for (const actor of actors) destroyPrivateRelayActor(actor)
    t.alike(
      views.map(
        (events) =>
          events.filter((event) => event.type === 'private-relay-destroying').at(-1).records
      ),
      [1, 1, 1],
      'observer failures leave one committed activatable record at every relay'
    )
    destroyPrivateDestinationActor(destinationActor)
  }

  const fixture = builtFixture()
  const views = fixture.relays.map(() => [])
  const { actors, destinationActor } = actorsFor(fixture, () => 1_000, views)
  const committed = registerPrivateRoute({
    built: fixture.built,
    entryActor: actors[0],
    safetyRoute: safetyRoute(),
    now: () => 1_000,
    randomBytes: sequenceBytes(1_000)
  })
  t.is(committed.registered, true)
  const rejectedReplay = registerPrivateRoute({
    built: fixture.built,
    entryActor: actors[0],
    safetyRoute: safetyRoute('drop'),
    now: () => 1_000,
    randomBytes: sequenceBytes(1_100)
  })
  t.is(rejectedReplay.registered, false)
  for (const actor of actors) destroyPrivateRelayActor(actor)
  t.alike(
    views.map(
      (events) => events.filter((event) => event.type === 'private-relay-destroying').at(-1).records
    ),
    [1, 1, 1]
  )
  destroyPrivateDestinationActor(destinationActor)
})

test('actor circuit limit configuration accepts 128 and rejects 129 structurally', (t) => {
  const fixture = builtFixture([relay(1, 'actor-limit-entry')])
  const entry = fixture.relays[0]
  const relayOptions = {
    identity: entry.identity.publicKey,
    identitySecretKey: entry.identity.secretKey,
    routeEncryptionSecretKey: entry.encryption.secretKey,
    now: () => 1_000,
    randomBytes: sequenceBytes(640)
  }

  t.is(DEFAULT_MAX_ACTOR_CIRCUITS, 128)
  t.is(publicApi.DEFAULT_MAX_ACTOR_CIRCUITS, 128)
  const relayActor = createPrivateRelayActor({
    ...relayOptions,
    maxCircuits: DEFAULT_MAX_ACTOR_CIRCUITS
  })
  const destinationActor = destinationActorFor(fixture, {
    maxCircuits: DEFAULT_MAX_ACTOR_CIRCUITS
  })
  expectCode(
    t,
    () => createPrivateRelayActor({ ...relayOptions, maxCircuits: 129 }),
    'INVALID_ROUTE'
  )
  expectCode(t, () => destinationActorFor(fixture, { maxCircuits: 129 }), 'INVALID_ROUTE')
  destroyPrivateRelayActor(relayActor)
  destroyPrivateDestinationActor(destinationActor)
})

test('Safety entry setup rejects unaccepted or undelivered link handshake bytes', (t) => {
  const safety = safetyRoleIdentity(1)

  for (const fault of [
    'forward-false-after-callback',
    'forward-undelivered-cancellable',
    'reverse-false-after-callback',
    'reverse-undelivered-cancellable'
  ]) {
    const value = relay(1, `safety-entry-${fault}`)
    const events = []
    const actor = createPrivateRelayActor({
      identity: value.identity.publicKey,
      identitySecretKey: value.identity.secretKey,
      routeEncryptionSecretKey: value.encryption.secretKey,
      now: () => 1_000,
      randomBytes: sequenceBytes(1_200),
      observe(event) {
        events.push(event)
      }
    })
    let pending = 0
    let cancellations = 0
    let forwardCalls = 0
    let reverseCalls = 0
    const retainedCallbacks = []

    expectCode(
      t,
      () =>
        createPrivateSafetyEntryAttachment({
          entryActor: actor,
          circuitId: b4a.alloc(16, 0xa1),
          epoch: 7n,
          expiresAt: 9_000n,
          finalSafetyIdentity: safety.publicKey,
          finalSafetyIdentitySecretKey: safety.secretKey,
          now: () => 1_000,
          randomBytes: sequenceBytes(1_240),
          transmit(direction, packet, receive) {
            retainedCallbacks.push(receive)
            if (direction === DIRECTION.FORWARD) {
              forwardCalls++
              if (fault === 'forward-undelivered-cancellable') {
                pending++
                return Object.freeze({
                  cancel() {
                    cancellations++
                    pending--
                    return 1
                  }
                })
              }
              receive(packet)
              return fault === 'forward-false-after-callback' ? false : true
            }
            reverseCalls++
            if (fault === 'reverse-undelivered-cancellable') {
              pending++
              return Object.freeze({
                cancel() {
                  cancellations++
                  pending--
                  return 1
                }
              })
            }
            receive(packet)
            return fault === 'reverse-false-after-callback' ? false : true
          }
        }),
      'ROUTE_UNAVAILABLE'
    )

    t.is(forwardCalls, 1, fault)
    t.is(
      reverseCalls,
      fault.startsWith('forward-') ? 0 : 1,
      `${fault} stops at the rejected direction`
    )
    t.is(pending, 0, `${fault} leaves no pending setup delivery`)
    t.is(
      cancellations,
      fault.endsWith('cancellable') ? 1 : 0,
      `${fault} cancels every unaccepted queued delivery`
    )
    t.is(
      events.filter(
        (event) =>
          event.type === 'private-binding-opened' || event.type === 'private-circuit-destroyed'
      ).length,
      0,
      `${fault} installs no binding or circuit state`
    )
    const eventsBeforeLateDelivery = events.length
    let lateError = null
    try {
      for (const receive of retainedCallbacks) receive(null)
    } catch (err) {
      lateError = err
    }
    t.is(lateError, null, `${fault} ignores callbacks retained past setup completion`)
    t.is(
      events.length,
      eventsBeforeLateDelivery,
      `${fault} late callbacks cannot mutate relay state`
    )
    destroyPrivateRelayActor(actor)
  }
})

test('public registration rejects an all-registry topology', (t) => {
  const fixture = builtFixture([relay(1, 'entry')])
  const value = fixture.relays[0]
  const registry = createTemplateRegistry({
    identity: value.identity.publicKey,
    identitySecretKey: value.identity.secretKey,
    routeEncryptionSecretKey: value.encryption.secretKey,
    now: () => 1_000
  })

  expectCode(
    t,
    () =>
      registerPrivateRoute({
        built: fixture.built,
        registries: [registry],
        destinationIdentity: fixture.owner.identity.publicKey,
        destinationIdentitySecretKey: fixture.owner.identity.secretKey,
        safetyRoute: {},
        now: () => 1_000,
        randomBytes: sequenceBytes(250)
      }),
    'INVALID_ROUTE'
  )
  registry.destroy()
})

test('public RouteManager compiles actor proofs before bidirectional OPEN', (t) => {
  const fixture = builtFixture([
    relay(1, 'entry'),
    relay(20, 'private-middle'),
    relay(40, 'private-final')
  ])
  const destinationRoute = cryptoSuite.encryptionKeyPair(seed(231))
  let activationNow = 1_000
  let forgeCreated = false
  const destinationPackets = []
  const destinationActor = createPrivateDestinationActor({
    identity: fixture.owner.identity.publicKey,
    identitySecretKey: fixture.owner.identity.secretKey,
    routeSigningKey: fixture.owner.identity.publicKey,
    routeSigningSecretKey: fixture.owner.identity.secretKey,
    routeEncryptionSecretKey: destinationRoute.secretKey,
    finalToken: fixture.options.finalToken,
    now: () => activationNow,
    randomBytes: sequenceBytes(280),
    maxCircuits: 8,
    observe(event) {
      destinationPackets.push(event)
    },
    [TEST_ONLY_DESTINATION_PROOF_MUTATOR](proof) {
      if (forgeCreated) proof[proof.byteLength - 1] ^= 1
      return proof
    }
  })
  const actorPackets = []
  const finalRelay = fixture.relays[2]
  const finalActor = createPrivateRelayActor({
    identity: finalRelay.identity.publicKey,
    identitySecretKey: finalRelay.identity.secretKey,
    routeEncryptionSecretKey: finalRelay.encryption.secretKey,
    destination: destinationActor,
    now: () => activationNow,
    randomBytes: sequenceBytes(290),
    observe(event) {
      actorPackets.push(event)
    }
  })
  const entry = fixture.relays[0]
  const middleRelay = fixture.relays[1]
  const middleActor = createPrivateRelayActor({
    identity: middleRelay.identity.publicKey,
    identitySecretKey: middleRelay.identity.secretKey,
    routeEncryptionSecretKey: middleRelay.encryption.secretKey,
    next: finalActor,
    now: () => activationNow,
    randomBytes: sequenceBytes(295),
    observe(event) {
      actorPackets.push(event)
    }
  })
  const entryActor = createPrivateRelayActor({
    identity: entry.identity.publicKey,
    identitySecretKey: entry.identity.secretKey,
    routeEncryptionSecretKey: entry.encryption.secretKey,
    next: middleActor,
    now: () => activationNow,
    randomBytes: sequenceBytes(300),
    observe(event) {
      actorPackets.push(event)
    }
  })
  let controlCells = 0
  let suppressControl = false
  let suppressCreated = false
  let lateCreated = false
  let waitForCreatedMode = false
  const createdWaitViews = []
  let dataFrames = 0
  let reverseFrames = 0
  let reverseControlFrames = 0
  const safetyRoute = Object.freeze({
    attachEntry() {
      return Object.freeze({ destroy() {} })
    },
    sendControl(fragments, deliver) {
      let result
      controlCells += fragments.length
      if (suppressControl) return true
      for (const fragment of fragments) {
        const value = deliver(fragment)
        if (value !== undefined) result = value
      }
      return result === undefined ? true : result
    },
    sendFrame(cellClass, frame, deliver) {
      dataFrames++
      return deliver(frame)
    },
    sendReverseFrame(cellClass, frame, deliver) {
      if (cellClass === CELL_CLASS.CONTROL) {
        reverseControlFrames++
        if (suppressCreated) return true
        if (lateCreated) activationNow += 5_000
      } else reverseFrames++
      return deliver(frame)
    }
  })
  t.is(
    registerPrivateRoute({
      built: fixture.built,
      entryActor,
      safetyRoute,
      now: () => activationNow,
      randomBytes: sequenceBytes(320)
    }).registered,
    true
  )
  actorPackets.length = 0
  const signed = signDescriptor(
    {
      version: PROTOCOL_VERSION,
      authorizationMode: AUTHORIZATION_MODE.DIRECT,
      descriptorId: fixture.owner.descriptorId,
      endpointKey: fixture.owner.identity.publicKey,
      routeSigningKey: fixture.owner.identity.publicKey,
      routeEncryptionKey: destinationRoute.publicKey,
      entryAdvertisement: encodeRelayAdvertisement(entry.advertisement),
      epoch: fixture.owner.epoch,
      expiresAt: fixture.owner.expiresAt,
      capabilities: CAPABILITY.KNOWN,
      cellSize: 1200,
      encryptedHops: fixture.built.encryptedHops
    },
    fixture.owner.identity.secretKey
  )
  const verified = verifyDescriptor(encodeDescriptor(signed), {
    requestedEndpointKey: fixture.owner.identity.publicKey,
    now: 1_000n
  })
  const safetyIdentity = safetyRoleIdentity(1)
  const safetyEncryption = cryptoSuite.encryptionKeyPair(seed(232))
  const safetyAdvertisement = encodeRelayAdvertisement(
    signRelayAdvertisement(
      {
        version: PROTOCOL_VERSION,
        identityKey: safetyIdentity.publicKey,
        routeEncryptionKey: safetyEncryption.publicKey,
        dial: b4a.from('compiled-safety'),
        role: ROLE.SAFETY,
        capabilities: CAPABILITY.KNOWN,
        epoch: fixture.owner.epoch,
        expiresAt: 10_000n
      },
      safetyIdentity.secretKey
    )
  )
  const phases = []
  const atDestination = []
  const atDestinationDatagram = []
  const atSource = []
  const sourceDestinationReplayCache = publicApi.createDestinationReplayCache({
    now: () => activationNow,
    maxEntries: DEFAULT_MAX_ACTOR_CIRCUITS
  })
  const installer = createSafetyInstallerAuthority()
  const compiler = createRouteCompilerAuthority()
  const compilerCapability = compiler.issuer.issue(
    createPrivateRouteCompiler({
      entryActor,
      destinationActor,
      safetyRouteChecker: installer.routeChecker,
      now: () => activationNow,
      randomBytes: sequenceBytes(340),
      waitForCreated(deadline) {
        if (!waitForCreatedMode) return false
        activationNow = deadline - 1
        createdWaitViews.push({
          now: activationNow,
          activeSafetyRoutes,
          relayDestroyed: actorPackets.filter((event) => event.type === 'private-circuit-destroyed')
            .length,
          destinationDestroyed: destinationPackets.filter(
            (event) => event.type === 'private-destination-circuit-destroyed'
          ).length
        })
        activationNow = deadline
        return false
      },
      sourceDestinationReplayCache,
      onDestinationStream(frame) {
        atDestination.push(b4a.from(frame))
      },
      onDestinationDatagram(frame) {
        atDestinationDatagram.push(b4a.from(frame))
      },
      onSourceStream(frame) {
        atSource.push(b4a.from(frame))
      },
      observe(event) {
        phases.push(event.phase)
      }
    })
  )
  const circuitAuthority = createCircuitAuthority()
  const circuitIds = []
  const managerCrypto = Object.freeze({
    verify: cryptoSuite.verify,
    randomBytes(size) {
      const value = cryptoSuite.randomBytes(size)
      if (size === 16) circuitIds.push(b4a.from(value))
      return value
    }
  })
  let activeSafetyRoutes = 0
  const installerCapability = installer.issuer.issue({
    authenticate() {},
    install() {},
    rollback() {},
    finalize() {
      activeSafetyRoutes++
      let live = true
      return {
        transcriptHash32: cryptoSuite.hash([safetyAdvertisement]),
        attachEntry: safetyRoute.attachEntry,
        sendControl: safetyRoute.sendControl,
        sendFrame: safetyRoute.sendFrame,
        sendReverseFrame: safetyRoute.sendReverseFrame,
        destroy() {
          if (!live) return
          live = false
          activeSafetyRoutes--
        }
      }
    }
  })
  const manager = new RouteManager({
    network: {},
    registry: { allows: () => true },
    crypto: managerCrypto,
    clock: () => activationNow,
    descriptorChecker: descriptorChecker(),
    circuitIssuer: circuitAuthority.issuer,
    safetyInstaller: installerCapability,
    safetyInstallerChecker: installer.checker,
    safetyRouteChecker: installer.routeChecker,
    routeCompiler: compilerCapability,
    routeCompilerChecker: compiler.checker,
    limits: { maxSafetyHops: 3 }
  })

  const circuit = manager.open({ safety: [safetyAdvertisement], descriptor: verified })

  t.is(circuitIds.length, 1)
  t.is(sourceDestinationReplayCache.size, 1)
  t.alike(Object.keys(circuit).sort(), ['destroy', 'drain', 'sendDatagram', 'sendStreamFrame'])
  t.alike(phases, ['create-sent', 'entry-proof-verified', 'created-verified', 'open'])
  t.ok(controlCells > 0)
  t.is(actorPackets.filter((event) => event.type === 'private-created-control').length, 2)
  t.is(destinationPackets.filter((event) => event.type === 'private-created-control').length, 1)
  t.is(activeSafetyRoutes, 1)
  circuit.sendStreamFrame(b4a.from('actor forward'))
  circuit.sendStreamFrame(b4a.from('actor forward two'))
  circuit.sendDatagram(b4a.from('actor datagram'))
  circuit.sendDatagram(b4a.from('actor datagram two'))
  sendPrivateDestinationStream(destinationActor, b4a.from('actor reverse'))
  t.alike(atDestination, [b4a.from('actor forward'), b4a.from('actor forward two')])
  t.alike(atDestinationDatagram, [b4a.from('actor datagram'), b4a.from('actor datagram two')])
  t.alike(atSource, [b4a.from('actor reverse')])
  t.is(dataFrames, 4)
  t.is(reverseFrames, 1)
  t.is(reverseControlFrames, 2)
  const reused = actorPackets.filter(
    (event) =>
      event.type === 'private-frame' &&
      event.localIdentity === b4a.toString(entry.identity.publicKey, 'hex') &&
      event.peerIdentity === b4a.toString(middleRelay.identity.publicKey, 'hex') &&
      event.cellClass === CELL_CLASS.STREAM &&
      event.direction === DIRECTION.FORWARD
  )
  t.is(reused.length, 2)
  t.alike(
    reused.map((event) => event.counter),
    [0n, 1n]
  )
  t.is(reused[0].localId, reused[1].localId)
  t.is(reused[0].peerLocalId, reused[1].peerLocalId)
  t.is(reused[0].bindingFingerprint, reused[1].bindingFingerprint)
  const reusedDatagrams = actorPackets.filter(
    (event) =>
      event.type === 'private-frame' &&
      event.localIdentity === b4a.toString(entry.identity.publicKey, 'hex') &&
      event.peerIdentity === b4a.toString(middleRelay.identity.publicKey, 'hex') &&
      event.cellClass === CELL_CLASS.DATAGRAM &&
      event.direction === DIRECTION.FORWARD
  )
  t.is(reusedDatagrams.length, 2)
  t.alike(
    reusedDatagrams.map((event) => event.counter),
    [0n, 1n]
  )
  t.is(reusedDatagrams[0].localId, reused[0].localId)
  t.is(reusedDatagrams[0].peerLocalId, reused[0].peerLocalId)
  t.is(reusedDatagrams[0].bindingFingerprint, reused[0].bindingFingerprint)
  circuit.drain()
  expectCode(t, () => circuit.sendStreamFrame(b4a.from('late forward')), 'CIRCUIT_STATE')
  sendPrivateDestinationStream(destinationActor, b4a.from('draining reverse'))
  t.alike(atSource, [b4a.from('actor reverse'), b4a.from('draining reverse')])
  t.is(reverseFrames, 2)
  const concurrent = manager.open({ safety: [safetyAdvertisement], descriptor: verified })
  t.is(circuitIds.length, 2)
  t.is(sourceDestinationReplayCache.size, 2)
  t.is(reverseControlFrames, 3)
  t.is(sourceDestinationReplayCache.size, 2)
  t.is(activeSafetyRoutes, 2)
  sendPrivateDestinationStream(
    destinationActor,
    b4a.from('source a while source b is open'),
    circuitIds[0]
  )
  sendPrivateDestinationStream(destinationActor, b4a.from('source b reverse one'), circuitIds[1])
  sendPrivateDestinationStream(destinationActor, b4a.from('source b reverse two'), circuitIds[1])
  concurrent.sendStreamFrame(b4a.from('source b before destroy'))
  const sourceB = actorPackets.filter(
    (event) =>
      event.type === 'private-frame' &&
      event.localIdentity === b4a.toString(entry.identity.publicKey, 'hex') &&
      event.cellClass === CELL_CLASS.STREAM &&
      event.direction === DIRECTION.FORWARD &&
      event.bindingFingerprint !== reused[0].bindingFingerprint
  )
  t.is(sourceB.length, 1)
  t.is(sourceB[0].counter, 0n)
  circuit.destroy()
  t.alike(
    actorPackets
      .filter((event) => event.type === 'private-circuit-destroyed')
      .slice(-3)
      .map((event) => event.activeCircuits),
    [1, 1, 1]
  )
  const zeroized = actorPackets.filter((event) => event.type === 'private-binding-zeroized').at(-1)
  t.is(zeroized.contexts.length, 12)
  t.ok(
    zeroized.contexts.every(
      (context) =>
        b4a.equals(context.key, b4a.alloc(32)) && b4a.equals(context.noncePrefix, b4a.alloc(16))
    )
  )
  concurrent.sendStreamFrame(b4a.from('source b after destroy'))
  sendPrivateDestinationStream(
    destinationActor,
    b4a.from('source b reverse after source a destroy'),
    circuitIds[1]
  )
  t.alike(atDestination.slice(-2), [
    b4a.from('source b before destroy'),
    b4a.from('source b after destroy')
  ])
  t.alike(atSource.slice(-4), [
    b4a.from('source a while source b is open'),
    b4a.from('source b reverse one'),
    b4a.from('source b reverse two'),
    b4a.from('source b reverse after source a destroy')
  ])
  const destinationReverse = actorPackets.filter(
    (event) =>
      event.type === 'private-frame' &&
      event.localIdentity === b4a.toString(finalRelay.identity.publicKey, 'hex') &&
      event.peerIdentity === b4a.toString(fixture.owner.identity.publicKey, 'hex') &&
      event.cellClass === CELL_CLASS.STREAM &&
      event.direction === DIRECTION.REVERSE
  )
  const destinationReverseByBinding = new Map()
  for (const event of destinationReverse) {
    const events = destinationReverseByBinding.get(event.bindingFingerprint) || []
    events.push(event)
    destinationReverseByBinding.set(event.bindingFingerprint, events)
  }
  t.is(destinationReverseByBinding.size, 2)
  t.ok(
    Array.from(destinationReverseByBinding.values()).every(
      (events) =>
        events.length === 3 && events.every((event, index) => event.counter === BigInt(index))
    )
  )
  const sourceBAfterDestroy = actorPackets.filter(
    (event) =>
      event.type === 'private-frame' &&
      event.localIdentity === b4a.toString(entry.identity.publicKey, 'hex') &&
      event.cellClass === CELL_CLASS.STREAM &&
      event.direction === DIRECTION.FORWARD &&
      event.bindingFingerprint === sourceB[0].bindingFingerprint
  )
  t.alike(
    sourceBAfterDestroy.map((event) => event.counter),
    [0n, 1n]
  )
  t.ok(actorPackets.length >= 6)
  t.ok(
    actorPackets
      .filter((event) => event.packetBytes !== undefined)
      .every((event) => event.packetBytes === 1200)
  )
  t.ok(
    actorPackets.every(
      (event) =>
        event.localIdentity === b4a.toString(entry.identity.publicKey, 'hex') ||
        event.localIdentity === b4a.toString(middleRelay.identity.publicKey, 'hex') ||
        event.localIdentity === b4a.toString(finalRelay.identity.publicKey, 'hex')
    )
  )
  concurrent.destroy()
  t.alike(
    actorPackets
      .filter((event) => event.type === 'private-circuit-destroyed')
      .slice(-3)
      .map((event) => event.activeCircuits),
    [0, 0, 0]
  )
  t.is(activeSafetyRoutes, 0)
  t.ok(
    actorPackets
      .filter((event) => event.type === 'private-binding-zeroized')
      .every((event) => event.queuedBytes === 0)
  )
  t.alike(
    destinationPackets
      .filter((event) => event.type === 'private-destination-circuit-destroyed')
      .at(-1),
    {
      type: 'private-destination-circuit-destroyed',
      activeCircuits: 0,
      reverseBindings: 0,
      routeActors: 0,
      activationReplayTombstones: 2
    }
  )

  function expectFailedActivationClean(code, mutate) {
    const relayDestroyedBefore = actorPackets.filter(
      (event) => event.type === 'private-circuit-destroyed'
    ).length
    const destinationDestroyedBefore = destinationPackets.filter(
      (event) => event.type === 'private-destination-circuit-destroyed'
    ).length
    mutate(true)
    expectCode(t, () => manager.open({ safety: [safetyAdvertisement], descriptor: verified }), code)
    mutate(false)
    const destroyed = actorPackets.filter((event) => event.type === 'private-circuit-destroyed')
    t.is(destroyed.length, relayDestroyedBefore + 3)
    t.ok(
      destroyed
        .slice(-3)
        .every((event) => event.activeCircuits === 0 && event.activationReplayTombstones > 0)
    )
    t.ok(destroyed.slice(-3).some((event) => event.entryReplayTombstones > 0))
    const destinationDestroyed = destinationPackets.filter(
      (event) => event.type === 'private-destination-circuit-destroyed'
    )
    t.is(destinationDestroyed.length, destinationDestroyedBefore + 1)
    t.alike(
      {
        activeCircuits: destinationDestroyed.at(-1).activeCircuits,
        reverseBindings: destinationDestroyed.at(-1).reverseBindings,
        routeActors: destinationDestroyed.at(-1).routeActors
      },
      { activeCircuits: 0, reverseBindings: 0, routeActors: 0 }
    )
    t.ok(destinationDestroyed.at(-1).activationReplayTombstones > 0)
    t.is(activeSafetyRoutes, 0)
    t.is(phases.filter((phase) => phase === 'open').length, 2)
  }

  expectFailedActivationClean('UNAUTHORIZED', (enabled) => {
    forgeCreated = enabled
  })
  const relayDestroyedBeforeWait = actorPackets.filter(
    (event) => event.type === 'private-circuit-destroyed'
  ).length
  const destinationDestroyedBeforeWait = destinationPackets.filter(
    (event) => event.type === 'private-destination-circuit-destroyed'
  ).length
  waitForCreatedMode = true
  expectFailedActivationClean('ROUTE_UNAVAILABLE', (enabled) => {
    suppressCreated = enabled
  })
  waitForCreatedMode = false
  t.alike(createdWaitViews, [
    {
      now: 5_999,
      activeSafetyRoutes: 1,
      relayDestroyed: relayDestroyedBeforeWait,
      destinationDestroyed: destinationDestroyedBeforeWait
    }
  ])
  activationNow = 1_000
  expectFailedActivationClean('ROUTE_UNAVAILABLE', (enabled) => {
    lateCreated = enabled
    if (!enabled) activationNow = 1_000
  })

  // A missing forward CREATE is independently fail-closed and allocates no actor circuit.
  suppressControl = true
  expectCode(
    t,
    () => manager.open({ safety: [safetyAdvertisement], descriptor: verified }),
    'ROUTE_UNAVAILABLE'
  )
  t.is(activeSafetyRoutes, 0)
  suppressControl = false
  const reopened = manager.open({ safety: [safetyAdvertisement], descriptor: verified })
  t.is(phases.filter((phase) => phase === 'open').length, 3)
  reopened.destroy()
  destroyPrivateRelayActor(entryActor)
  destroyPrivateRelayActor(entryActor)
  destroyPrivateRelayActor(middleActor)
  destroyPrivateRelayActor(middleActor)
  destroyPrivateRelayActor(finalActor)
  destroyPrivateRelayActor(finalActor)
  destroyPrivateDestinationActor(destinationActor)
  destroyPrivateDestinationActor(destinationActor)
})

test('private route construction rejects a fourth hop before sealing', (t) => {
  const owner = destination()
  const relays = [relay(1, 'a'), relay(20, 'b'), relay(40, 'c'), relay(60, 'd')]
  let calls = 0
  t.exception(
    () =>
      buildPrivateTemplates({
        descriptorId: owner.descriptorId,
        epoch: owner.epoch,
        expiresAt: owner.expiresAt,
        endpointKey: owner.identity.publicKey,
        routeSigningKey: owner.identity.publicKey,
        authorizationMode: AUTHORIZATION_MODE.DIRECT,
        destinationSecretKey: owner.identity.secretKey,
        relays: relays.map((value) => encodeRelayAdvertisement(value.advertisement)),
        randomBytes(size) {
          calls++
          return b4a.alloc(size, calls)
        },
        finalToken: b4a.alloc(64),
        now: 1_000n
      }),
    /Route is invalid/
  )
  t.is(calls, 0)
})

test('registration traversal cleans temporary state on success, timeout, rejection, and dropped ack', (t) => {
  for (const fault of [undefined, 'timeout', 'reject', 'drop-ack', 'wrong-final-token']) {
    const owner = destination()
    const relays = [relay(1, 'entry'), relay(20, 'middle'), relay(40, 'final')]
    let random = 0
    const built = buildPrivateTemplates({
      descriptorId: owner.descriptorId,
      epoch: owner.epoch,
      expiresAt: owner.expiresAt,
      endpointKey: owner.identity.publicKey,
      routeSigningKey: owner.identity.publicKey,
      authorizationMode: AUTHORIZATION_MODE.DIRECT,
      destinationSecretKey: owner.identity.secretKey,
      relays: relays.map((value) => encodeRelayAdvertisement(value.advertisement)),
      randomBytes: (size) => b4a.alloc(size, ++random),
      finalToken: b4a.alloc(64, 0xfe),
      now: 1_000n
    })
    const registries = relays.map((value) =>
      createTemplateRegistry({
        identity: value.identity.publicKey,
        identitySecretKey: value.identity.secretKey,
        routeEncryptionSecretKey: value.encryption.secretKey,
        now: () => 1_000
      })
    )
    const safetyRoute = Object.freeze({ id: 'preexisting-safety-route' })
    const observerViews = []
    const result = registerPrivateRouteLegacy({
      built,
      registries,
      destinationIdentity: owner.identity.publicKey,
      destinationIdentitySecretKey: owner.identity.secretKey,
      safetyRoute,
      fault,
      now: () => 1_000,
      randomBytes: (size) => b4a.alloc(size, ++random),
      [TEST_ONLY_ACTIVATION_OBSERVER](view) {
        observerViews.push(view)
      }
    })
    if (fault === undefined && !result.registered)
      t.comment(`unexpected traversal failure: ${result.failureCode}`)
    t.is(result.safetyRoute, safetyRoute)
    t.is(result.resources.links, 0)
    t.is(result.resources.ids, 0)
    t.is(result.resources.secretBytes, 0)
    t.is(result.resources.queuedBytes, 0)
    t.is(result.resources.fragmentBytes, 0)
    t.is(result.proof.peakLinks, 4)
    t.is(result.proof.peakIds, 8)
    t.is(result.proof.peakSecretBytes > 0, true)
    t.is(result.proof.peakQueuedBytes, fault === undefined ? 1200 : 0)
    t.is(result.proof.zeroizedContexts, 48)
    t.is(result.proof.postActiveCircuits, 0)
    t.is(result.proof.postQueuedBytes, 0)
    t.is(result.proof.postFragmentBytes, 0)
    if (fault === undefined) {
      t.is(result.registered, true)
      t.alike(
        registries.map((registry) => registry.size),
        [1, 1, 1]
      )
      t.absent(result.proof.adjacencies)
      t.alike(
        observerViews.map(({ node, adjacent }) => [node, adjacent]),
        [
          ['entry', ['safety-final', 'middle']],
          ['middle', ['entry', 'final']],
          ['final', ['middle', 'destination']],
          ['destination', ['guard', 'final']]
        ]
      )
    } else {
      t.is(result.registered, false)
      t.alike(
        registries.map((registry) => registry.size),
        [0, 0, 0]
      )
    }
  }
})

test('private construction rejects signatures, roles, loops, duplicate dials, epochs, and expiry', (t) => {
  const owner = destination()
  const first = relay(1, 'same')
  const second = relay(20, 'same')
  const base = {
    descriptorId: owner.descriptorId,
    epoch: owner.epoch,
    expiresAt: owner.expiresAt,
    endpointKey: owner.identity.publicKey,
    routeSigningKey: owner.identity.publicKey,
    authorizationMode: AUTHORIZATION_MODE.DIRECT,
    destinationSecretKey: owner.identity.secretKey,
    randomBytes: (size) => b4a.alloc(size, 1),
    finalToken: b4a.alloc(64),
    now: 1_000n
  }
  const good = encodeRelayAdvertisement(first.advertisement)
  const badSignature = b4a.from(good)
  badSignature[badSignature.byteLength - 1] ^= 1
  const wrongRole = encodeRelayAdvertisement({ ...first.advertisement, role: ROLE.SAFETY })
  const wrongEpoch = encodeRelayAdvertisement(relay(40, 'epoch', 8n).advertisement)
  const expired = encodeRelayAdvertisement(relay(60, 'expired', 7n, 900n).advertisement)
  for (const relays of [
    [badSignature],
    [wrongRole],
    [good, good],
    [good, encodeRelayAdvertisement(second.advertisement)],
    [wrongEpoch],
    [expired]
  ])
    t.exception(() => buildPrivateTemplates({ ...base, relays }))
})

test('registration rejects forged seals, unregistered activation, bad signatures, and commitments', (t) => {
  const fixture = builtFixture([relay(1, 'entry')])
  const value = fixture.relays[0]
  const makeRegistry = (secret = value.identity.secretKey) =>
    createTemplateRegistry({
      identity: value.identity.publicKey,
      identitySecretKey: secret,
      routeEncryptionSecretKey: value.encryption.secretKey,
      now: () => 1_000
    })
  const forged = {
    message: fixture.built.registrations[0].message,
    sealedTemplate: b4a.from(fixture.built.registrations[0].sealedTemplate)
  }
  forged.sealedTemplate[forged.sealedTemplate.byteLength - 1] ^= 1
  t.exception(() => makeRegistry().register(forged))
  t.exception(() =>
    makeRegistry().activate({
      descriptorId: fixture.owner.descriptorId,
      templateId: b4a.alloc(16),
      epoch: fixture.owner.epoch,
      templateCommitment: seed(1)
    })
  )

  const decoded = decodeTemplateRegister(fixture.built.registrations[0].message)
  for (const field of ['templateCommitment', 'nextCommitment']) {
    const changed = { ...decoded, [field]: seed(99) }
    const unsigned = encodeTemplateRegisterUnsigned(changed)
    changed.destinationSignature = cryptoSuite.sign(
      b4a.concat([DOMAIN.TEMPLATE_REGISTER, unsigned]),
      fixture.owner.identity.secretKey
    )
    t.exception(() =>
      makeRegistry().register({
        message: encodeTemplateRegister(changed),
        sealedTemplate: fixture.built.registrations[0].sealedTemplate
      })
    )
  }

  const wrongDestination = b4a.from(fixture.built.registrations[0].message)
  wrongDestination[wrongDestination.byteLength - 1] ^= 1
  t.exception(() =>
    makeRegistry().register({
      message: wrongDestination,
      sealedTemplate: fixture.built.registrations[0].sealedTemplate
    })
  )

  const traversal = registerPrivateRouteLegacy({
    built: fixture.built,
    registries: [makeRegistry(cryptoSuite.keyPair(seed(199)).secretKey)],
    destinationIdentity: fixture.owner.identity.publicKey,
    destinationIdentitySecretKey: fixture.owner.identity.secretKey,
    safetyRoute: {},
    now: () => 1_000,
    randomBytes: (size) => b4a.alloc(size, 7)
  })
  t.is(traversal.registered, false)
})

test('registration is idempotent, conflicting replay fails, and records expire independently', (t) => {
  let now = 1_000
  const fixture = builtFixture([relay(1, 'entry')])
  const value = fixture.relays[0]
  const registry = createTemplateRegistry({
    identity: value.identity.publicKey,
    identitySecretKey: value.identity.secretKey,
    routeEncryptionSecretKey: value.encryption.secretKey,
    now: () => now
  })
  const firstAck = registry.register(fixture.built.registrations[0])
  t.alike(registry.register(fixture.built.registrations[0]), firstAck)
  const conflicting = buildPrivateTemplates({
    ...fixture.options,
    randomBytes: (size) => b4a.alloc(size, 1)
  })
  t.exception(() => registry.register(conflicting.registrations[0]))
  t.is(registry.size, 1)
  now = 9_000
  t.is(registry.size, 0)
})

test('template registry owns key snapshots and caller mutation cannot corrupt registration', (t) => {
  const fixture = builtFixture([relay(1, 'entry')])
  const value = fixture.relays[0]
  const identity = b4a.from(value.identity.publicKey)
  const identitySecretKey = b4a.from(value.identity.secretKey)
  const routeEncryptionSecretKey = b4a.from(value.encryption.secretKey)
  const registry = createTemplateRegistry({
    identity,
    identitySecretKey,
    routeEncryptionSecretKey,
    now: () => 1_000
  })
  identity.fill(0)
  identitySecretKey.fill(0)
  routeEncryptionSecretKey.fill(0)

  const ack = registry.register(fixture.built.registrations[0])
  t.alike(decodeTemplateRegistered(ack).relayIdentity, value.identity.publicKey)
  t.is(registry.size, 1)
})

test('destroyed template registry is sticky closed and retains no usable records', (t) => {
  const fixture = builtFixture([relay(1, 'entry')])
  const value = fixture.relays[0]
  const registry = createTemplateRegistry({
    identity: value.identity.publicKey,
    identitySecretKey: value.identity.secretKey,
    routeEncryptionSecretKey: value.encryption.secretKey,
    now: () => 1_000
  })
  registry.register(fixture.built.registrations[0])
  registry.destroy()
  registry.destroy()

  for (const operation of [
    () => registry.size,
    () => registry.inspect(),
    () => registry.register(fixture.built.registrations[0]),
    () =>
      registry.activate({
        descriptorId: fixture.owner.descriptorId,
        templateId: b4a.alloc(16),
        epoch: fixture.owner.epoch,
        templateCommitment: seed(1)
      })
  ])
    expectCode(t, operation, 'CIRCUIT_STATE')
})

test('template and encrypted-hop sizes fail at exact bounds before unsafe allocation', (t) => {
  const template = {
    version: PROTOCOL_VERSION,
    descriptorId: seed(1),
    templateId: b4a.alloc(16),
    epoch: 1n,
    expiresAt: 2n,
    relayIdentity: seed(2),
    nextAdvertisement: b4a.alloc(0),
    nextLayer: b4a.alloc(1)
  }
  t.exception(() => encodePrivateTemplate({ ...template, nextAdvertisement: b4a.alloc(1025) }))
  t.exception(() => encodePrivateTemplate({ ...template, nextLayer: b4a.alloc(4097) }))
})

test('source-facing verified descriptor contains only entry and opaque encrypted bytes', (t) => {
  const fixture = builtFixture()
  const descriptor = signDescriptor(
    {
      version: PROTOCOL_VERSION,
      authorizationMode: AUTHORIZATION_MODE.DIRECT,
      descriptorId: fixture.owner.descriptorId,
      endpointKey: fixture.owner.identity.publicKey,
      routeSigningKey: fixture.owner.identity.publicKey,
      routeEncryptionKey: cryptoSuite.encryptionKeyPair(seed(230)).publicKey,
      entryAdvertisement: encodeRelayAdvertisement(fixture.relays[0].advertisement),
      epoch: fixture.owner.epoch,
      expiresAt: fixture.owner.expiresAt,
      capabilities: CAPABILITY.KNOWN,
      cellSize: 1200,
      encryptedHops: fixture.built.encryptedHops
    },
    fixture.owner.identity.secretKey
  )
  const verified = verifyDescriptor(
    // The signed descriptor serialization is the only source-facing representation.
    encodeDescriptor(descriptor),
    { requestedEndpointKey: fixture.owner.identity.publicKey, now: 1_000n }
  )
  const visible = readVerifiedDescriptor(verified)
  t.is('activateRegisteredRoute' in publicApi, false)
  t.absent(visible.path)
  t.absent(visible.templates)
  t.absent(visible.acknowledgements)
  for (const hidden of fixture.relays.slice(1)) {
    t.is(b4a.indexOf(visible.encryptedHops, hidden.identity.publicKey), -1)
    t.is(b4a.indexOf(visible.encryptedHops, hidden.advertisement.dial), -1)
  }
})

test('two sources activate one registered descriptor with isolated per-source state', (t) => {
  const fixture = builtFixture()
  const registries = fixture.relays.map((value, index) => {
    const registry = createTemplateRegistry({
      identity: value.identity.publicKey,
      identitySecretKey: value.identity.secretKey,
      routeEncryptionSecretKey: value.encryption.secretKey,
      now: () => 1_000
    })
    registry.register(fixture.built.registrations[index])
    return registry
  })
  const views = []
  const common = {
    registries,
    encryptedHops: fixture.built.encryptedHops,
    descriptorId: fixture.owner.descriptorId,
    epoch: fixture.owner.epoch,
    expiresAt: fixture.owner.expiresAt,
    destinationIdentity: fixture.owner.identity.publicKey,
    destinationIdentitySecretKey: fixture.owner.identity.secretKey,
    now: () => 1_000,
    [TEST_ONLY_ACTIVATION_OBSERVER](view) {
      views.push(view)
    }
  }
  const a = activateRegisteredRoute({
    ...common,
    sourceEphemeralKey: seed(241),
    sourceCircuitId: b4a.alloc(16, 1),
    randomBytes: sequenceBytes(10)
  })
  const b = activateRegisteredRoute({
    ...common,
    sourceEphemeralKey: seed(242),
    sourceCircuitId: b4a.alloc(16, 2),
    randomBytes: sequenceBytes(80)
  })
  const activationViews = views.filter((view) => view.phase === 'activation')
  t.is(a.state, 'open')
  t.is(b.state, 'open')
  t.is(activationViews.length, 6)
  t.ok(activationViews.every((view) => view.decryptCount === 1 && view.adjacent.length === 2))
  t.is(
    new Set(activationViews.flatMap((view) => view.localIds)).size,
    activationViews.flatMap((view) => view.localIds).length
  )
  const first = activationViews.filter((view) => view.circuitId === activationViews[0].circuitId)
  const second = activationViews.filter((view) => view.circuitId !== activationViews[0].circuitId)
  t.is(
    first
      .flatMap((view) => view.contextHashes)
      .some((value) => second.flatMap((view) => view.contextHashes).includes(value)),
    false
  )
  a.destroy()
  t.is(a.state, 'destroyed')
  t.is(b.state, 'open')
  t.alike(b.testReverse(b4a.from('still isolated')), b4a.from('still isolated'))
  const packets = views.filter((view) => view.phase === 'packet')
  t.is(packets.length, 3)
  t.is(new Set(packets.map((view) => view.frameHash)).size, 1)
  b.destroy()
})

function sequenceBytes(start) {
  let value = start
  return (size) => b4a.alloc(size, value++)
}
