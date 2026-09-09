import test from 'brittle'
import b4a from 'b4a'

import {
  BRANCH_CLASS,
  CONTEXT_CLASS,
  DIRECTION,
  EXIT_ORIGIN_SERVICE_POLICY,
  FINAL_EXIT_TRANSCRIPT_SIZE,
  M3_CONTEXT_AD_SIZE,
  M3_CONTEXT_ENVELOPE_SIZE,
  PAYLOAD_PARAMETERS_SIZE,
  SERVICE_POLICY_ENTRY_SIZE,
  TAIL_CONTROL_TRANSCRIPT_SIZE,
  cryptoSuite,
  decodeExitOriginServicePolicy,
  decodeFinalExitTranscript,
  decodeAdmittedLimits,
  decodeM3ContextAD,
  decodeM3ContextEnvelope,
  decodePayloadParameters,
  decodeTailControlTranscript,
  digestAdmittedLimits,
  digestExitOriginServicePolicy,
  digestPayloadParameters,
  digestTailControlTranscript,
  encodeAdmittedLimits,
  encodeExitOriginServicePolicy,
  encodeFinalExitTranscript,
  encodeM3ContextAD,
  encodeM3ContextEnvelope,
  encodePayloadParameters,
  encodeTailControlTranscript
} from '../index.js'
import { deriveFinalExitTestVector } from '../lib/final-exit.js'
import { deriveTailControlTestVector } from '../lib/tail-control.js'
import { expectCode, seed } from './helpers.js'

const TAIL_DOMAIN = b4a.from('hyperdht-private-routes/tail-control/transcript/v1')
const FINAL_DOMAIN = b4a.from('hyperdht-private-routes/final-exit/transcript/v1')

const EXPECTED_VECTORS = Object.freeze({
  admittedLimitsDigest: 'ea5dbf85e3dd17534b675e815453b0ef3a2254f3736d0297ab1acd5955ee790c',
  policyDigest: '61445e852f5e70095e836e2c1128cc1c024a15784406a476990279fe7094610b',
  parametersDigest: '1d248fe6302060ddfb8b015e3a7d51e2ff895f6c73ad8ce85329a68f82b04db2',
  tailDigest: '005d3b85d52d89a1b471a3a4a88f3e06967fdc2f1606470e195aa24618ed697f',
  tailOutputs: Object.freeze({
    forwardKey: '57fe1a22c0c4ffcc506b08637491db256d4f14e2d16e3f02ec462252aeb483a4',
    reverseKey: '2d7565ed3cf7934f29e2522da5c0a447e078654205119460672b7b186469259e',
    forwardNoncePrefix: '336ac023a004ef7190c79e59c13c3b9e',
    reverseNoncePrefix: 'edd347208ab421870636dedb2a343ebe',
    finalizeForwardKey: '8b4737f13ad09ecfc15cc8ebb10713cab7859892c5c28a7b8f177f8d644b440e',
    finalizeReverseKey: 'bf21d268f051cbe48c07c2fd29cae2d0d8ad81f54aa72f8b0a37e344ffeb99d9',
    finalizeForwardNoncePrefix: '7d85bc5ce7d4d2871cf3899483e897fb',
    finalizeReverseNoncePrefix: '7cd9563f4b030e065b5adc894bee830a'
  }),
  finalOutputs: Object.freeze({
    payloadForwardKey: 'd7e08006283ee9b52738b0ee84394482bee178dbbcaae8d51697bfff51b8e884',
    payloadReverseKey: 'e922c9931f8e8ba0e30bedf8bf6d89abc4494ccf4ab7f5e7a66e0fd3450221c3',
    payloadForwardNoncePrefix: 'ab9789ba0bf03ea392cf64929db0ec49',
    payloadReverseNoncePrefix: 'ec9df25e5f0a1daf592c3ae4fe087029',
    controlForwardKey: '4a709055daf4843d09d24a8cc7a155dbe1e825603c1e5afc7efdf1eaf54472fc',
    controlReverseKey: 'c92c834d793103bca7d41339e14eccd91734add5d13fbb53a12ba4b1a822296e',
    controlForwardNoncePrefix: 'f9570e0e631559c2235895d595423ee4',
    controlReverseNoncePrefix: '9a19451b7cd13c9c25bc748b0370cab1',
    finalizeForwardKey: '24793191f580a0f2acec7c0707aaf4e8bcf2edd3cb0b4938a5b2b48d3202a15f',
    finalizeReverseKey: '8f089a69f6ee91caa71f0f922edff6da1151a6145a0cb04063450296c8de15e3',
    finalizeForwardNoncePrefix: '696467f2d8b1031ca3cb4416e6d7350b',
    finalizeReverseNoncePrefix: 'c323919f000a5e60b65db39ed1f9cb9d'
  })
})

function u16(value) {
  return b4a.from([value >>> 8, value])
}

function u32(value) {
  return b4a.from([value >>> 24, value >>> 16, value >>> 8, value])
}

function u64(value) {
  const result = b4a.alloc(8)
  for (let index = 7; index >= 0; index--) {
    result[index] = Number(value & 0xffn)
    value >>= 8n
  }
  return result
}

function sequence(start, size) {
  const value = b4a.allocUnsafe(size)
  for (let index = 0; index < size; index++) value[index] = start + index
  return value
}

function forgedByteLength(value, byteLength) {
  Object.defineProperty(value, 'byteLength', { value: byteLength })
  return value
}

function overriddenSubarray(value) {
  value.subarray = () => b4a.alloc(0)
  return value
}

function policyEntry(value) {
  return b4a.concat([
    u16(value.commandId),
    u16(value.commandVersion),
    u32(value.maxRequestBytes),
    u32(value.maxResponseBytes),
    u32(value.timeoutMs),
    u16(value.maxOutstanding),
    u32(value.requestCost),
    u32(value.responseCost),
    u32(value.maxAmplificationBytes),
    b4a.from([value.mutationFlag, value.destinationValidationClass])
  ])
}

const context = Object.freeze({
  contextClass: CONTEXT_CLASS.ROUTE_PAYLOAD,
  branchId: sequence(0x00, 16),
  circuitId: sequence(0x10, 16),
  generation: 0x0102_0304_0506_0708n,
  direction: DIRECTION.REVERSE,
  innerCounter: 0x1112_1314_1516_1718n
})

const limits = Object.freeze({
  cellSize: 1200,
  maxCells: 4096,
  maxBytes: 1_048_576,
  maxCommands: 512,
  idleTimeoutMs: 30_000,
  expiresAtMs: 0x0102_0304_0506_0708n
})

const expectedPolicy = Object.freeze([
  {
    commandId: 0x0120,
    commandVersion: 1,
    maxRequestBytes: 32,
    maxResponseBytes: 4706,
    timeoutMs: 3000,
    maxOutstanding: 10,
    requestCost: 1,
    responseCost: 2,
    maxAmplificationBytes: 4445,
    mutationFlag: 0,
    destinationValidationClass: 1
  },
  {
    commandId: 0x0121,
    commandVersion: 1,
    maxRequestBytes: 1090,
    maxResponseBytes: 209,
    timeoutMs: 3000,
    maxOutstanding: 5,
    requestCost: 3,
    responseCost: 1,
    maxAmplificationBytes: 0,
    mutationFlag: 1,
    destinationValidationClass: 1
  },
  {
    commandId: 0x0122,
    commandVersion: 1,
    maxRequestBytes: 40,
    maxResponseBytes: 4650,
    timeoutMs: 3000,
    maxOutstanding: 10,
    requestCost: 1,
    responseCost: 2,
    maxAmplificationBytes: 4381,
    mutationFlag: 0,
    destinationValidationClass: 1
  },
  {
    commandId: 0x0123,
    commandVersion: 1,
    maxRequestBytes: 1066,
    maxResponseBytes: 209,
    timeoutMs: 3000,
    maxOutstanding: 5,
    requestCost: 3,
    responseCost: 1,
    maxAmplificationBytes: 0,
    mutationFlag: 1,
    destinationValidationClass: 1
  },
  {
    commandId: 0x0200,
    commandVersion: 1,
    maxRequestBytes: 69,
    maxResponseBytes: 4031,
    timeoutMs: 5000,
    maxOutstanding: 3,
    requestCost: 2,
    responseCost: 8,
    maxAmplificationBytes: 3733,
    mutationFlag: 0,
    destinationValidationClass: 2
  },
  {
    commandId: 0x02a0,
    commandVersion: 1,
    maxRequestBytes: 134,
    maxResponseBytes: 8270,
    timeoutMs: 5000,
    maxOutstanding: 3,
    requestCost: 2,
    responseCost: 12,
    maxAmplificationBytes: 7907,
    mutationFlag: 0,
    destinationValidationClass: 2
  },
  {
    commandId: 0x02a1,
    commandVersion: 1,
    maxRequestBytes: 189,
    maxResponseBytes: 288,
    timeoutMs: 3000,
    maxOutstanding: 5,
    requestCost: 3,
    responseCost: 2,
    maxAmplificationBytes: 0,
    mutationFlag: 1,
    destinationValidationClass: 2
  },
  {
    commandId: 0x02a2,
    commandVersion: 1,
    maxRequestBytes: 1161,
    maxResponseBytes: 581,
    timeoutMs: 5000,
    maxOutstanding: 5,
    requestCost: 5,
    responseCost: 3,
    maxAmplificationBytes: 0,
    mutationFlag: 1,
    destinationValidationClass: 2
  },
  {
    commandId: 0x02a3,
    commandVersion: 1,
    maxRequestBytes: 393,
    maxResponseBytes: 581,
    timeoutMs: 5000,
    maxOutstanding: 5,
    requestCost: 5,
    responseCost: 3,
    maxAmplificationBytes: 0,
    mutationFlag: 1,
    destinationValidationClass: 2
  }
])

test('M3ContextAD has the exact owner-approved 54-byte vector', (t) => {
  const expected = b4a.concat([
    b4a.from([3]),
    u32(1),
    sequence(0x00, 16),
    sequence(0x10, 16),
    u64(0x0102_0304_0506_0708n),
    b4a.from([1]),
    u64(0x1112_1314_1516_1718n)
  ])
  const encoded = encodeM3ContextAD(context)

  t.is(M3_CONTEXT_AD_SIZE, 54)
  t.is(encoded.byteLength, M3_CONTEXT_AD_SIZE)
  t.alike(encoded, expected)
  t.alike(decodeM3ContextAD(encoded), context)
})

test('M3 context envelope has the exact 1,101-byte vector and copies views', (t) => {
  const frame = b4a.alloc(1100, 0x5a)
  const expected = b4a.concat([b4a.from([CONTEXT_CLASS.ROUTE_PAYLOAD]), frame])
  const encoded = encodeM3ContextEnvelope({
    contextClass: CONTEXT_CLASS.ROUTE_PAYLOAD,
    frame
  })
  const decoded = decodeM3ContextEnvelope(encoded)

  t.is(M3_CONTEXT_ENVELOPE_SIZE, 1101)
  t.alike(encoded, expected)
  t.is(decoded.contextClass, CONTEXT_CLASS.ROUTE_PAYLOAD)
  t.alike(decoded.frame, frame)

  encoded.fill(0)
  t.alike(decoded.frame, frame)
  frame.fill(0)
  t.alike(decoded.frame, b4a.alloc(1100, 0x5a))
})

test('M3ContextAD binds every field and rejects class, direction, width, and overflow', (t) => {
  const baseline = encodeM3ContextAD(context)
  const substitutions = [
    { ...context, contextClass: CONTEXT_CLASS.TERMINAL_CONTROL_ORDERED },
    { ...context, branchId: b4a.alloc(16, 0xa1) },
    { ...context, circuitId: b4a.alloc(16, 0xa2) },
    { ...context, generation: context.generation + 1n },
    { ...context, direction: DIRECTION.FORWARD },
    { ...context, innerCounter: context.innerCounter + 1n }
  ]

  const key = seed(0x41)
  const noncePrefix = b4a.alloc(16, 0x42)
  const ciphertext = cryptoSuite.seal({
    key,
    noncePrefix,
    counter: context.innerCounter,
    associatedData: baseline,
    plaintext: b4a.from('m3-ad-substitution')
  })

  for (const substitution of substitutions) {
    const associatedData = encodeM3ContextAD(substitution)
    t.is(b4a.equals(associatedData, baseline), false)
    t.is(
      cryptoSuite.open({
        key,
        noncePrefix,
        counter: context.innerCounter,
        associatedData,
        ciphertext
      }),
      null
    )
  }

  expectCode(t, () => encodeM3ContextAD({ ...context, contextClass: 5 }), 'INVALID_ROUTE')
  expectCode(t, () => encodeM3ContextAD({ ...context, direction: 2 }), 'INVALID_ROUTE')
  expectCode(t, () => encodeM3ContextAD({ ...context, branchId: b4a.alloc(15) }), 'INVALID_ROUTE')
  expectCode(
    t,
    () => encodeM3ContextAD({ ...context, generation: 0x1_0000_0000_0000_0000n }),
    'INVALID_ROUTE'
  )
  expectCode(t, () => decodeM3ContextAD(b4a.concat([baseline, b4a.from([0])])), 'INVALID_ROUTE')
})

test('tail transcript, admitted-limits digest, and key schedule are byte exact', (t) => {
  const admittedLimitsDigest = b4a.from(EXPECTED_VECTORS.admittedLimitsDigest, 'hex')
  const value = {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: sequence(0x00, 16),
    circuitId: sequence(0x10, 16),
    generation: 0x0102_0304_0506_0708n,
    extensionIndex: 2,
    clientTailEphemeralPublicKey: b4a.alloc(32, 0x20),
    advertisedTailRouteEncryptionPublicKey: b4a.alloc(32, 0x21),
    candidateAdvertisementDigest: b4a.alloc(32, 0x22),
    clientNonce: b4a.alloc(32, 0x23),
    tailIdentity: b4a.alloc(32, 0x24),
    admittedLimitsDigest
  }
  const expected = b4a.concat([
    u16(TAIL_DOMAIN.byteLength),
    TAIL_DOMAIN,
    u32(1),
    b4a.from([0]),
    value.branchId,
    value.circuitId,
    u64(value.generation),
    b4a.from([2]),
    value.clientTailEphemeralPublicKey,
    value.advertisedTailRouteEncryptionPublicKey,
    value.candidateAdvertisementDigest,
    value.clientNonce,
    value.tailIdentity,
    admittedLimitsDigest
  ])
  const transcript = encodeTailControlTranscript(value)

  t.is(TAIL_CONTROL_TRANSCRIPT_SIZE, 290)
  t.alike(digestAdmittedLimits(limits), admittedLimitsDigest)
  t.alike(transcript, expected)
  t.alike(decodeTailControlTranscript(transcript), value)

  const sharedSecret = seed(0x51)
  const derived = deriveTailControlTestVector(sharedSecret, transcript, 2)
  for (const [name, expectedHex] of Object.entries(EXPECTED_VECTORS.tailOutputs)) {
    t.alike(derived[name], b4a.from(expectedHex, 'hex'))
  }
})

test('admitted limits require inherited cell size and nonzero resource bounds', (t) => {
  expectCode(t, () => encodeAdmittedLimits({ ...limits, cellSize: 1199 }), 'INVALID_ROUTE')
  for (const name of ['maxCells', 'maxBytes', 'maxCommands', 'idleTimeoutMs', 'expiresAtMs']) {
    expectCode(
      t,
      () => encodeAdmittedLimits({ ...limits, [name]: name === 'expiresAtMs' ? 0n : 0 }),
      'INVALID_ROUTE'
    )
  }

  const invalidEncoding = b4a.concat([
    u16(1199),
    u32(4096),
    u32(1_048_576),
    u32(512),
    u32(30_000),
    u64(0x0102_0304_0506_0708n)
  ])
  expectCode(t, () => decodeAdmittedLimits(invalidEncoding), 'INVALID_ROUTE')
})

test('exit-origin policy encoding/digest is canonical and immutable', (t) => {
  const encoded = encodeExitOriginServicePolicy(EXIT_ORIGIN_SERVICE_POLICY)
  const decoded = decodeExitOriginServicePolicy(encoded)
  const expected = b4a.concat([u16(9), ...expectedPolicy.map(policyEntry)])

  t.is(SERVICE_POLICY_ENTRY_SIZE, 32)
  t.is(encoded.byteLength, 2 + 9 * SERVICE_POLICY_ENTRY_SIZE)
  t.alike(EXIT_ORIGIN_SERVICE_POLICY, expectedPolicy)
  t.alike(encoded, expected)
  t.alike(decoded, expectedPolicy)
  t.alike(digestExitOriginServicePolicy(encoded), b4a.from(EXPECTED_VECTORS.policyDigest, 'hex'))

  const duplicate = b4a.from(encoded)
  duplicate.set(duplicate.subarray(2, 34), 34)
  expectCode(t, () => decodeExitOriginServicePolicy(duplicate), 'INVALID_ROUTE')

  const unsorted = b4a.from(encoded)
  const first = b4a.from(unsorted.subarray(2, 34))
  unsorted.copy(unsorted, 2, 34, 66)
  unsorted.set(first, 34)
  expectCode(t, () => decodeExitOriginServicePolicy(unsorted), 'INVALID_ROUTE')

  const overflow = EXIT_ORIGIN_SERVICE_POLICY.map((entry) => ({ ...entry }))
  overflow[0].maxRequestBytes = Number.MAX_SAFE_INTEGER + 1
  expectCode(t, () => encodeExitOriginServicePolicy(overflow), 'INVALID_ROUTE')
})

test('payload parameters and final-exit transcript have exact vectors and separated outputs', (t) => {
  const parameters = {
    cellSize: 1200,
    maxCellPayload: 1146,
    contextEnvelopeSize: 1101,
    routeFrameSize: 1100,
    maxRoutePayload: 1073,
    datagramReplayWindow: 64,
    maxQueuedBytes: 262_144,
    idleTimeoutMs: 30_000
  }
  const expectedParameters = b4a.concat([
    u16(1200),
    u16(1146),
    u16(1101),
    u16(1100),
    u16(1073),
    u16(64),
    u32(262_144),
    u32(30_000)
  ])
  const encodedParameters = encodePayloadParameters(parameters)
  const parametersDigest = b4a.from(EXPECTED_VECTORS.parametersDigest, 'hex')

  t.is(PAYLOAD_PARAMETERS_SIZE, 20)
  t.alike(encodedParameters, expectedParameters)
  t.alike(decodePayloadParameters(encodedParameters), parameters)
  t.alike(digestPayloadParameters(parameters), parametersDigest)

  const tailTranscript = encodeTailControlTranscript({
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: sequence(0x00, 16),
    circuitId: sequence(0x10, 16),
    generation: 0x0102_0304_0506_0708n,
    extensionIndex: 2,
    clientTailEphemeralPublicKey: b4a.alloc(32, 0x20),
    advertisedTailRouteEncryptionPublicKey: b4a.alloc(32, 0x21),
    candidateAdvertisementDigest: b4a.alloc(32, 0x22),
    clientNonce: b4a.alloc(32, 0x23),
    tailIdentity: b4a.alloc(32, 0x24),
    admittedLimitsDigest: digestAdmittedLimits(limits)
  })
  const value = {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: sequence(0x00, 16),
    circuitId: sequence(0x10, 16),
    generation: 0x0102_0304_0506_0708n,
    tailControlTranscriptDigest: b4a.from(EXPECTED_VECTORS.tailDigest, 'hex'),
    exitAdvertisementDigest: b4a.alloc(32, 0x31),
    exitIdentity: b4a.alloc(32, 0x32),
    clientActivationNonce: b4a.alloc(32, 0x33),
    exitOriginCommandPolicyDigest: b4a.from(EXPECTED_VECTORS.policyDigest, 'hex'),
    payloadParametersDigest: parametersDigest
  }
  const expected = b4a.concat([
    u16(FINAL_DOMAIN.byteLength),
    FINAL_DOMAIN,
    u32(1),
    b4a.from([0]),
    value.branchId,
    value.circuitId,
    u64(value.generation),
    value.tailControlTranscriptDigest,
    value.exitAdvertisementDigest,
    value.exitIdentity,
    value.clientActivationNonce,
    value.exitOriginCommandPolicyDigest,
    value.payloadParametersDigest
  ])
  const transcript = encodeFinalExitTranscript(value)

  t.is(FINAL_EXIT_TRANSCRIPT_SIZE, 287)
  t.alike(digestTailControlTranscript(tailTranscript), value.tailControlTranscriptDigest)
  t.alike(transcript, expected)
  t.alike(decodeFinalExitTranscript(transcript), value)

  const sharedSecret = seed(0x61)
  const derived = deriveFinalExitTestVector(sharedSecret, transcript)
  for (const [name, expectedHex] of Object.entries(EXPECTED_VECTORS.finalOutputs)) {
    t.alike(derived[name], b4a.from(expectedHex, 'hex'))
  }
})

test('one-field tail and final transcript substitution separates bytes and KDF outputs', (t) => {
  const tailValue = {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: sequence(0x00, 16),
    circuitId: sequence(0x10, 16),
    generation: 7n,
    extensionIndex: 2,
    clientTailEphemeralPublicKey: b4a.alloc(32, 0x20),
    advertisedTailRouteEncryptionPublicKey: b4a.alloc(32, 0x21),
    candidateAdvertisementDigest: b4a.alloc(32, 0x22),
    clientNonce: b4a.alloc(32, 0x23),
    tailIdentity: b4a.alloc(32, 0x24),
    admittedLimitsDigest: digestAdmittedLimits(limits)
  }
  const tailTranscript = encodeTailControlTranscript(tailValue)
  const tailKey = deriveTailControlTestVector(seed(0x71), tailTranscript, 2).forwardKey
  const tailSubstitutions = [
    { ...tailValue, branchClass: BRANCH_CLASS.ANNOUNCE },
    { ...tailValue, branchId: b4a.alloc(16, 0xa1) },
    { ...tailValue, circuitId: b4a.alloc(16, 0xa2) },
    { ...tailValue, generation: 8n },
    { ...tailValue, extensionIndex: 1 },
    { ...tailValue, clientTailEphemeralPublicKey: b4a.alloc(32, 0xa3) },
    { ...tailValue, advertisedTailRouteEncryptionPublicKey: b4a.alloc(32, 0xa4) },
    { ...tailValue, candidateAdvertisementDigest: b4a.alloc(32, 0xa5) },
    { ...tailValue, clientNonce: b4a.alloc(32, 0xa6) },
    { ...tailValue, tailIdentity: b4a.alloc(32, 0xa7) },
    { ...tailValue, admittedLimitsDigest: b4a.alloc(32, 0xa8) }
  ]

  for (const substitution of tailSubstitutions) {
    const encoded = encodeTailControlTranscript(substitution)
    t.is(b4a.equals(encoded, tailTranscript), false)
    t.is(
      b4a.equals(
        deriveTailControlTestVector(seed(0x71), encoded, substitution.extensionIndex).forwardKey,
        tailKey
      ),
      false
    )
  }

  const parametersDigest = digestPayloadParameters({
    cellSize: 1200,
    maxCellPayload: 1146,
    contextEnvelopeSize: 1101,
    routeFrameSize: 1100,
    maxRoutePayload: 1073,
    datagramReplayWindow: 64,
    maxQueuedBytes: 262_144,
    idleTimeoutMs: 30_000
  })
  const finalValue = {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: sequence(0x00, 16),
    circuitId: sequence(0x10, 16),
    generation: 7n,
    tailControlTranscriptDigest: digestTailControlTranscript(tailTranscript),
    exitAdvertisementDigest: b4a.alloc(32, 0x31),
    exitIdentity: b4a.alloc(32, 0x32),
    clientActivationNonce: b4a.alloc(32, 0x33),
    exitOriginCommandPolicyDigest: digestExitOriginServicePolicy(),
    payloadParametersDigest: parametersDigest
  }
  const finalTranscript = encodeFinalExitTranscript(finalValue)
  const finalKey = deriveFinalExitTestVector(seed(0x72), finalTranscript).payloadForwardKey
  const finalSubstitutions = [
    { ...finalValue, branchClass: BRANCH_CLASS.ANNOUNCE },
    { ...finalValue, branchId: b4a.alloc(16, 0xb1) },
    { ...finalValue, circuitId: b4a.alloc(16, 0xb2) },
    { ...finalValue, generation: 8n },
    { ...finalValue, tailControlTranscriptDigest: b4a.alloc(32, 0xb3) },
    { ...finalValue, exitAdvertisementDigest: b4a.alloc(32, 0xb4) },
    { ...finalValue, exitIdentity: b4a.alloc(32, 0xb5) },
    { ...finalValue, clientActivationNonce: b4a.alloc(32, 0xb6) },
    { ...finalValue, exitOriginCommandPolicyDigest: b4a.alloc(32, 0xb7) },
    { ...finalValue, payloadParametersDigest: b4a.alloc(32, 0xb8) }
  ]

  for (const substitution of finalSubstitutions) {
    const encoded = encodeFinalExitTranscript(substitution)
    t.is(b4a.equals(encoded, finalTranscript), false)
    t.is(
      b4a.equals(deriveFinalExitTestVector(seed(0x72), encoded).payloadForwardKey, finalKey),
      false
    )
  }
})

test('transcript and digest decoders reject unknown enums, lengths, trailing bytes, and constants', (t) => {
  const validContext = encodeM3ContextEnvelope({
    contextClass: CONTEXT_CLASS.TAIL_CONTROL_ORDERED,
    frame: b4a.alloc(1100)
  })
  const wrongClass = b4a.from(validContext)
  wrongClass[0] = 5
  expectCode(t, () => decodeM3ContextEnvelope(wrongClass), 'INVALID_ROUTE')
  expectCode(t, () => decodeM3ContextEnvelope(validContext.subarray(0, 1100)), 'INVALID_ROUTE')
  expectCode(
    t,
    () => decodeM3ContextEnvelope(b4a.concat([validContext, b4a.alloc(1)])),
    'INVALID_ROUTE'
  )

  const parameters = encodePayloadParameters({
    cellSize: 1200,
    maxCellPayload: 1146,
    contextEnvelopeSize: 1101,
    routeFrameSize: 1100,
    maxRoutePayload: 1073,
    datagramReplayWindow: 64,
    maxQueuedBytes: 262_144,
    idleTimeoutMs: 30_000
  })
  const altered = b4a.from(parameters)
  altered[1] ^= 1
  expectCode(t, () => decodePayloadParameters(altered), 'INVALID_ROUTE')
  expectCode(
    t,
    () => decodePayloadParameters(b4a.concat([parameters, b4a.alloc(1)])),
    'INVALID_ROUTE'
  )
})

test('all M3 codecs use intrinsic buffer extents and slicing', (t) => {
  const contextAD = encodeM3ContextAD(context)
  const contextEnvelope = encodeM3ContextEnvelope({
    contextClass: CONTEXT_CLASS.ROUTE_PAYLOAD,
    frame: b4a.alloc(1100, 0x41)
  })
  const admitted = encodeAdmittedLimits(limits)
  const tailValue = {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: sequence(0x00, 16),
    circuitId: sequence(0x10, 16),
    generation: 7n,
    extensionIndex: 2,
    clientTailEphemeralPublicKey: b4a.alloc(32, 0x20),
    advertisedTailRouteEncryptionPublicKey: b4a.alloc(32, 0x21),
    candidateAdvertisementDigest: b4a.alloc(32, 0x22),
    clientNonce: b4a.alloc(32, 0x23),
    tailIdentity: b4a.alloc(32, 0x24),
    admittedLimitsDigest: digestAdmittedLimits(limits)
  }
  const tail = encodeTailControlTranscript(tailValue)
  const policy = encodeExitOriginServicePolicy()
  const parametersValue = {
    cellSize: 1200,
    maxCellPayload: 1146,
    contextEnvelopeSize: 1101,
    routeFrameSize: 1100,
    maxRoutePayload: 1073,
    datagramReplayWindow: 64,
    maxQueuedBytes: 262_144,
    idleTimeoutMs: 30_000
  }
  const parameters = encodePayloadParameters(parametersValue)
  const finalValue = {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: sequence(0x00, 16),
    circuitId: sequence(0x10, 16),
    generation: 7n,
    tailControlTranscriptDigest: digestTailControlTranscript(tail),
    exitAdvertisementDigest: b4a.alloc(32, 0x31),
    exitIdentity: b4a.alloc(32, 0x32),
    clientActivationNonce: b4a.alloc(32, 0x33),
    exitOriginCommandPolicyDigest: digestExitOriginServicePolicy(),
    payloadParametersDigest: digestPayloadParameters(parametersValue)
  }
  const finalTranscript = encodeFinalExitTranscript(finalValue)

  const decodeCases = [
    [decodeM3ContextAD, contextAD],
    [decodeM3ContextEnvelope, contextEnvelope],
    [decodeAdmittedLimits, admitted],
    [decodeTailControlTranscript, tail],
    [decodeExitOriginServicePolicy, policy],
    [decodePayloadParameters, parameters],
    [decodeFinalExitTranscript, finalTranscript]
  ]
  for (const [decode, value] of decodeCases) {
    expectCode(
      t,
      () => decode(forgedByteLength(b4a.concat([value, b4a.alloc(1)]), value.byteLength)),
      'INVALID_ROUTE'
    )
    expectCode(
      t,
      () => decode(forgedByteLength(b4a.from(value.subarray(0, -1)), value.byteLength)),
      'INVALID_ROUTE'
    )
  }

  t.alike(decodeM3ContextAD(overriddenSubarray(b4a.from(contextAD))), decodeM3ContextAD(contextAD))
  t.alike(
    decodeM3ContextEnvelope(overriddenSubarray(b4a.from(contextEnvelope))),
    decodeM3ContextEnvelope(contextEnvelope)
  )
  t.alike(
    decodeTailControlTranscript(overriddenSubarray(b4a.from(tail))),
    decodeTailControlTranscript(tail)
  )
  t.alike(
    decodeFinalExitTranscript(overriddenSubarray(b4a.from(finalTranscript))),
    decodeFinalExitTranscript(finalTranscript)
  )

  for (const size of [15, 17]) {
    expectCode(
      t,
      () => encodeM3ContextAD({ ...context, branchId: forgedByteLength(b4a.alloc(size), 16) }),
      'INVALID_ROUTE'
    )
  }
  for (const size of [1099, 1101]) {
    expectCode(
      t,
      () =>
        encodeM3ContextEnvelope({
          contextClass: CONTEXT_CLASS.ROUTE_PAYLOAD,
          frame: forgedByteLength(b4a.alloc(size), 1100)
        }),
      'INVALID_ROUTE'
    )
  }
  for (const size of [31, 33]) {
    const forged = forgedByteLength(b4a.alloc(size), 32)
    expectCode(
      t,
      () => encodeTailControlTranscript({ ...tailValue, clientNonce: forged }),
      'INVALID_ROUTE'
    )
    expectCode(
      t,
      () => encodeFinalExitTranscript({ ...finalValue, exitIdentity: forged }),
      'INVALID_ROUTE'
    )
    expectCode(t, () => deriveTailControlTestVector(forged, tail, 2), 'INVALID_ROUTE')
    expectCode(t, () => deriveFinalExitTestVector(forged, finalTranscript), 'INVALID_ROUTE')
  }

  const forgedTail = forgedByteLength(b4a.concat([tail, b4a.alloc(1)]), tail.byteLength)
  expectCode(t, () => digestTailControlTranscript(forgedTail), 'INVALID_ROUTE')
  expectCode(t, () => deriveTailControlTestVector(seed(1), forgedTail, 2), 'INVALID_ROUTE')
  const shortTail = forgedByteLength(b4a.from(tail.subarray(0, -1)), tail.byteLength)
  expectCode(t, () => digestTailControlTranscript(shortTail), 'INVALID_ROUTE')
  expectCode(t, () => deriveTailControlTestVector(seed(1), shortTail, 2), 'INVALID_ROUTE')

  const forgedPolicy = forgedByteLength(b4a.concat([policy, b4a.alloc(1)]), policy.byteLength)
  expectCode(t, () => digestExitOriginServicePolicy(forgedPolicy), 'INVALID_ROUTE')
  expectCode(
    t,
    () =>
      digestExitOriginServicePolicy(
        forgedByteLength(b4a.from(policy.subarray(0, -1)), policy.byteLength)
      ),
    'INVALID_ROUTE'
  )

  const forgedParameters = forgedByteLength(
    b4a.concat([parameters, b4a.alloc(1)]),
    parameters.byteLength
  )
  expectCode(t, () => digestPayloadParameters(forgedParameters), 'INVALID_ROUTE')
  expectCode(
    t,
    () =>
      digestPayloadParameters(
        forgedByteLength(b4a.from(parameters.subarray(0, -1)), parameters.byteLength)
      ),
    'INVALID_ROUTE'
  )

  const forgedFinal = forgedByteLength(
    b4a.concat([finalTranscript, b4a.alloc(1)]),
    finalTranscript.byteLength
  )
  expectCode(t, () => deriveFinalExitTestVector(seed(1), forgedFinal), 'INVALID_ROUTE')
  expectCode(
    t,
    () =>
      deriveFinalExitTestVector(
        seed(1),
        forgedByteLength(b4a.from(finalTranscript.subarray(0, -1)), finalTranscript.byteLength)
      ),
    'INVALID_ROUTE'
  )
})

test('digest and KDF entry points reject hostile proxies with stable errors', (t) => {
  const sentinel = new Error('hostile proxy')
  const hostilePolicy = new Proxy(encodeExitOriginServicePolicy(), {
    getPrototypeOf() {
      throw sentinel
    }
  })
  const hostileParameters = new Proxy(
    encodePayloadParameters({
      cellSize: 1200,
      maxCellPayload: 1146,
      contextEnvelopeSize: 1101,
      routeFrameSize: 1100,
      maxRoutePayload: 1073,
      datagramReplayWindow: 64,
      maxQueuedBytes: 262_144,
      idleTimeoutMs: 30_000
    }),
    {
      getPrototypeOf() {
        throw sentinel
      }
    }
  )

  expectCode(t, () => digestExitOriginServicePolicy(hostilePolicy), 'INVALID_ROUTE')
  expectCode(t, () => digestPayloadParameters(hostileParameters), 'INVALID_ROUTE')
})

test('digest and KDF entry points require canonical transcript headers and enums', (t) => {
  const tail = encodeTailControlTranscript({
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: sequence(0x00, 16),
    circuitId: sequence(0x10, 16),
    generation: 7n,
    extensionIndex: 2,
    clientTailEphemeralPublicKey: b4a.alloc(32, 0x20),
    advertisedTailRouteEncryptionPublicKey: b4a.alloc(32, 0x21),
    candidateAdvertisementDigest: b4a.alloc(32, 0x22),
    clientNonce: b4a.alloc(32, 0x23),
    tailIdentity: b4a.alloc(32, 0x24),
    admittedLimitsDigest: digestAdmittedLimits(limits)
  })
  const malformedTail = [b4a.alloc(TAIL_CONTROL_TRANSCRIPT_SIZE)]
  for (const offset of [2, 52, 56, 97]) {
    const mutated = b4a.from(tail)
    mutated[offset] ^= 0xff
    malformedTail.push(mutated)
  }

  for (const transcript of malformedTail) {
    expectCode(t, () => digestTailControlTranscript(transcript), 'INVALID_ROUTE')
    expectCode(t, () => deriveTailControlTestVector(seed(1), transcript, 2), 'INVALID_ROUTE')
  }

  const finalTranscript = encodeFinalExitTranscript({
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: sequence(0x00, 16),
    circuitId: sequence(0x10, 16),
    generation: 7n,
    tailControlTranscriptDigest: digestTailControlTranscript(tail),
    exitAdvertisementDigest: b4a.alloc(32, 0x31),
    exitIdentity: b4a.alloc(32, 0x32),
    clientActivationNonce: b4a.alloc(32, 0x33),
    exitOriginCommandPolicyDigest: digestExitOriginServicePolicy(),
    payloadParametersDigest: digestPayloadParameters({
      cellSize: 1200,
      maxCellPayload: 1146,
      contextEnvelopeSize: 1101,
      routeFrameSize: 1100,
      maxRoutePayload: 1073,
      datagramReplayWindow: 64,
      maxQueuedBytes: 262_144,
      idleTimeoutMs: 30_000
    })
  })
  const malformedFinal = [b4a.alloc(FINAL_EXIT_TRANSCRIPT_SIZE)]
  for (const offset of [2, 50, 54]) {
    const mutated = b4a.from(finalTranscript)
    mutated[offset] ^= 0xff
    malformedFinal.push(mutated)
  }

  for (const transcript of malformedFinal) {
    expectCode(t, () => deriveFinalExitTestVector(seed(1), transcript), 'INVALID_ROUTE')
  }
})
