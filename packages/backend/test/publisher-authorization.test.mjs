import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  PUBLISHER_RECORD_TYPES,
  encodePublisherOperationBody,
  createPublisherNamespaceDescriptor,
  createPublisherAuthorizationState,
  reducePublisherOperation,
  reducePublisherOperations,
  createPublisherKeyProvider
} from '../src/publisher/index.js'
import {
  prepareSignedEnvelope,
  attachSignedEnvelopeSignature,
  signedRecordSignaturePreimage,
  prepareMultiSignedEnvelope,
  attachMultiSignedEnvelopeSignatures,
  multiSignedRecordSignaturePreimage
} from '@peartube/backend/records'

const bytes = (length, seed = 0) => b4a.from(Array.from({ length }, (_, index) => (seed + index) & 255))
const id = seed => bytes(32, seed)
const equal = (left, right) => b4a.equals(left, right)
const hex = value => b4a.toString(value, 'hex')

function signedOperation({ descriptor, signer, recordType, policyEpoch, sequence, body, signedAt = 1_700_000_000_000, expiresAt }) {
  const prepared = prepareSignedEnvelope({
    recordType,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: signer.publicKey,
    policyEpoch,
    issuerSequence: sequence,
    signedAt,
    expiresAt,
    canonicalBody: b4a.isBuffer(body) ? body : encodePublisherOperationBody(recordType, body)
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), signer.secretKey))
}

function signedTransition({ descriptor, signers, policyEpoch, sequence, body, signedAt = 1_700_000_000_000 }) {
  const prepared = prepareMultiSignedEnvelope({
    recordType: PUBLISHER_RECORD_TYPES.ROOT_TRANSITION,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    policyEpoch,
    issuerSequence: sequence,
    signedAt,
    canonicalBody: encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.ROOT_TRANSITION, body)
  }, { hash: crypto.hash })
  const signatures = signers.map(signer => ({
    signerKey: signer.publicKey,
    signature: crypto.sign(multiSignedRecordSignaturePreimage(prepared), signer.secretKey)
  })).sort((left, right) => b4a.compare(left.signerKey, right.signerKey))
  return attachMultiSignedEnvelopeSignatures(prepared, signatures)
}

function fixture() {
  const root = crypto.keyPair(bytes(32, 1))
  const recoveryA = crypto.keyPair(bytes(32, 2))
  const recoveryB = crypto.keyPair(bytes(32, 3))
  const recoveryC = crypto.keyPair(bytes(32, 4))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: id(40),
    profileRef: b4a.from('profile:auth'),
    recoveryKeys: [recoveryA.publicKey, recoveryB.publicKey, recoveryC.publicKey].sort(b4a.compare),
    recoveryThreshold: 2
  })
  return { root, recoveryA, recoveryB, recoveryC, descriptor, provider: createPublisherKeyProvider() }
}

test('authorization is signature plus current publisher membership, role, epoch, source writer, and expiry', (t) => {
  const { root, descriptor, provider } = fixture()
  const publisherWriter = crypto.keyPair(bytes(32, 11))
  const moderator = crypto.keyPair(bytes(32, 12))
  const state = createPublisherAuthorizationState(descriptor)

  const admitPublisher = signedOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: publisherWriter.publicKey,
      signerKey: publisherWriter.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_700_000_010_000,
      admissionNonce: bytes(16, 80)
    }
  })
  t.is(reducePublisherOperation(state, admitPublisher, { keyProvider: provider, sourceWriterKey: id(99) }).code, 'ACCEPTED')

  const publication = signedOperation({
    descriptor,
    signer: publisherWriter,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    body: { publicationId: id(100), manifestId: id(101), payload: b4a.from('publication-a') }
  })
  t.is(reducePublisherOperation(state, publication, { keyProvider: provider, sourceWriterKey: publisherWriter.publicKey }).code, 'ACCEPTED')
  t.is(reducePublisherOperation(state, publication, { keyProvider: provider, sourceWriterKey: publisherWriter.publicKey }).code, 'DUPLICATE')

  const wrongSource = signedOperation({
    descriptor,
    signer: publisherWriter,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 2,
    body: { publicationId: id(102), manifestId: id(103), payload: b4a.from('wrong source') }
  })
  t.is(reducePublisherOperation(state, wrongSource, { keyProvider: provider, sourceWriterKey: moderator.publicKey }).code, 'SOURCE_WRITER_MISMATCH')

  const announceMisuse = signedOperation({
    descriptor,
    signer: publisherWriter,
    recordType: PUBLISHER_RECORD_TYPES.VIEW_HEAD,
    policyEpoch: 0,
    sequence: 2,
    body: { viewKey: id(104), length: 5, digest: id(105), authorizationStateDigest: id(106) }
  })
  t.is(reducePublisherOperation(state, announceMisuse, { keyProvider: provider, sourceWriterKey: publisherWriter.publicKey }).code, 'CAPABILITY_REQUIRED')

  const expired = signedOperation({
    descriptor,
    signer: publisherWriter,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 2,
    signedAt: 1_700_000_010_001,
    body: { publicationId: id(107), manifestId: id(108), payload: b4a.from('expired writer') }
  })
  t.is(reducePublisherOperation(state, expired, { keyProvider: provider, sourceWriterKey: publisherWriter.publicKey }).code, 'WRITER_EXPIRED')

  const admitModerator = signedOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      writerKey: moderator.publicKey,
      signerKey: moderator.publicKey,
      capabilities: ['moderate'],
      firstAcceptedSequence: 1,
      expiresAt: 1_700_000_020_000,
      admissionNonce: bytes(16, 96)
    }
  })
  t.is(reducePublisherOperation(state, admitModerator, { keyProvider: provider, sourceWriterKey: id(99) }).code, 'ACCEPTED')
  const ownerAction = signedOperation({
    descriptor,
    signer: moderator,
    recordType: PUBLISHER_RECORD_TYPES.OWNER_ACTION,
    policyEpoch: 0,
    sequence: 1,
    body: { action: 'hide', targetType: 'publication', targetId: id(100), reason: b4a.from('publisher policy') }
  })
  t.is(reducePublisherOperation(state, ownerAction, { keyProvider: provider, sourceWriterKey: moderator.publicKey }).code, 'ACCEPTED')
})

test('revocation cutoffs preserve delayed history but reject continuation, stale epochs, and sequence forks', (t) => {
  const { root, descriptor, provider } = fixture()
  const removed = crypto.keyPair(bytes(32, 21))
  const retained = crypto.keyPair(bytes(32, 22))
  const state = createPublisherAuthorizationState(descriptor)

  for (const [index, writer] of [removed, retained].entries()) {
    const admission = signedOperation({
      descriptor,
      signer: root,
      recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
      policyEpoch: 0,
      sequence: index + 1,
      body: {
        writerKey: writer.publicKey,
        signerKey: writer.publicKey,
        capabilities: ['publish'],
        firstAcceptedSequence: 1,
        expiresAt: 1_800_000_000_000,
        admissionNonce: bytes(16, 120 + index * 16)
      }
    })
    t.is(reducePublisherOperation(state, admission, { keyProvider: provider, sourceWriterKey: id(90) }).code, 'ACCEPTED')
  }

  const revocation = signedOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 3,
    body: { newPolicyEpoch: 1, revocations: [{ writerKey: removed.publicKey, acceptedThroughSequence: 3 }] }
  })
  t.is(reducePublisherOperation(state, revocation, { keyProvider: provider, sourceWriterKey: id(90) }).code, 'ACCEPTED')
  t.is(state.policyEpoch, 1)

  const delayed = signedOperation({
    descriptor,
    signer: removed,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 3,
    body: { publicationId: id(130), manifestId: id(131), payload: b4a.from('delayed accepted') }
  })
  t.is(reducePublisherOperation(state, delayed, { keyProvider: provider, sourceWriterKey: removed.publicKey }).code, 'ACCEPTED_THROUGH_CUTOFF')

  const continuation = signedOperation({
    descriptor,
    signer: removed,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 4,
    body: { publicationId: id(132), manifestId: id(133), payload: b4a.from('removed continuation') }
  })
  t.is(reducePublisherOperation(state, continuation, { keyProvider: provider, sourceWriterKey: removed.publicKey }).code, 'REVOKED_WRITER')

  const stale = signedOperation({
    descriptor,
    signer: retained,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    body: { publicationId: id(134), manifestId: id(135), payload: b4a.from('stale') }
  })
  t.is(reducePublisherOperation(state, stale, { keyProvider: provider, sourceWriterKey: retained.publicKey }).code, 'STALE_POLICY_EPOCH')

  const current = signedOperation({
    descriptor,
    signer: retained,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 1,
    sequence: 1,
    body: { publicationId: id(136), manifestId: id(137), payload: b4a.from('current') }
  })
  t.is(reducePublisherOperation(state, current, { keyProvider: provider, sourceWriterKey: retained.publicKey }).code, 'ACCEPTED')

  const sequenceFork = signedOperation({
    descriptor,
    signer: retained,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 1,
    sequence: 1,
    body: { publicationId: id(138), manifestId: id(139), payload: b4a.from('fork') }
  })
  t.is(reducePublisherOperation(state, sequenceFork, { keyProvider: provider, sourceWriterKey: retained.publicKey }).code, 'SEQUENCE_CONFLICT')
})

test('root rotation and recovery use exact shared multi-signer roles, quorum, and monotonic epochs', (t) => {
  const { root, recoveryA, recoveryB, recoveryC, descriptor, provider } = fixture()
  const newRoot = crypto.keyPair(bytes(32, 31))
  const rotationBody = {
    mode: 'rotation',
    previousRootKey: root.publicKey,
    newRootKey: newRoot.publicKey,
    newCatalogEpoch: 1,
    recoveryKeys: descriptor.recoveryKeys,
    recoveryThreshold: descriptor.recoveryThreshold,
    profileRef: descriptor.profileRef
  }
  const state = createPublisherAuthorizationState(descriptor)
  const rotation = signedTransition({ descriptor, signers: [root, newRoot], policyEpoch: 0, sequence: 1, body: rotationBody })
  t.is(reducePublisherOperation(state, rotation, { keyProvider: provider, sourceWriterKey: id(200) }).code, 'ACCEPTED')
  t.ok(equal(state.activeRootKey, newRoot.publicKey))
  t.is(state.catalogEpoch, 1)

  const badEpoch = signedTransition({ descriptor, signers: [newRoot, root], policyEpoch: 0, sequence: 2, body: { ...rotationBody, previousRootKey: newRoot.publicKey, newRootKey: root.publicKey, newCatalogEpoch: 3 } })
  t.is(reducePublisherOperation(state, badEpoch, { keyProvider: provider, sourceWriterKey: id(200) }).code, 'CATALOG_EPOCH_NOT_MONOTONIC')

  const recoveryState = createPublisherAuthorizationState(descriptor)
  const recoveredRoot = crypto.keyPair(bytes(32, 32))
  const recoveryBody = { ...rotationBody, mode: 'recovery', newRootKey: recoveredRoot.publicKey }
  const recovery = signedTransition({ descriptor, signers: [recoveredRoot, recoveryA, recoveryB], policyEpoch: 0, sequence: 1, body: recoveryBody })
  t.is(reducePublisherOperation(recoveryState, recovery, { keyProvider: provider, sourceWriterKey: id(201) }).code, 'ACCEPTED')

  const extraRecoveryState = createPublisherAuthorizationState(descriptor)
  const extra = signedTransition({ descriptor, signers: [recoveredRoot, recoveryA, recoveryB, recoveryC], policyEpoch: 0, sequence: 1, body: recoveryBody })
  t.is(reducePublisherOperation(extraRecoveryState, extra, { keyProvider: provider, sourceWriterKey: id(201) }).code, 'SIGNER_POLICY_REJECTED')
})

test('complete-set reduction uses operation ID as the explicit sequence/fork tie-break and rejects unknown records', (t) => {
  const { root, descriptor, provider } = fixture()
  const nextA = crypto.keyPair(bytes(32, 41))
  const nextB = crypto.keyPair(bytes(32, 42))
  const body = newRoot => ({
    mode: 'rotation',
    previousRootKey: root.publicKey,
    newRootKey: newRoot.publicKey,
    newCatalogEpoch: 1,
    recoveryKeys: descriptor.recoveryKeys,
    recoveryThreshold: descriptor.recoveryThreshold,
    profileRef: descriptor.profileRef
  })
  const transitionA = signedTransition({ descriptor, signers: [root, nextA], policyEpoch: 0, sequence: 1, body: body(nextA) })
  const transitionB = signedTransition({ descriptor, signers: [root, nextB], policyEpoch: 0, sequence: 1, body: body(nextB) })
  const expected = b4a.compare(transitionA.transitionId, transitionB.transitionId) < 0 ? transitionA : transitionB
  const reduced = reducePublisherOperations(descriptor, [
    { value: transitionB, sourceWriterKey: id(230) },
    { value: transitionA, sourceWriterKey: id(231) }
  ], { keyProvider: provider })

  t.ok(equal(reduced.state.activeRootKey, expected === transitionA ? nextA.publicKey : nextB.publicKey), 'lexicographically smaller transition ID wins')
  t.is(reduced.accepted.length, 1)
  t.is(reduced.rejected[0].code, 'SEQUENCE_CONFLICT')

  const writer = crypto.keyPair(bytes(32, 43))
  const unknown = signedOperation({
    descriptor,
    signer: writer,
    recordType: 'publisher.catalog.unknown',
    policyEpoch: 0,
    sequence: 1,
    body: b4a.from('unknown bytes')
  })
  const unknownState = createPublisherAuthorizationState(descriptor)
  const result = reducePublisherOperation(unknownState, unknown, { keyProvider: provider, sourceWriterKey: writer.publicKey })
  t.is(result.code, 'UNKNOWN_RECORD_TYPE')
  t.is(unknownState.acceptedRecordIds.size, 0, 'unknown operation cannot mutate replay or authority state')
  t.absent(hex(unknown.recordId) === '')
})

test('an unauthorized lower-ID claimed-signer fork cannot reserve an admitted writer sequence', (t) => {
  const { root, descriptor, provider } = fixture()
  const writer = crypto.keyPair(bytes(32, 51))
  const attacker = crypto.keyPair(bytes(32, 52))
  const admission = signedOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: writer.publicKey,
      signerKey: writer.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 210)
    }
  })
  const valid = signedOperation({
    descriptor,
    signer: writer,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    body: { publicationId: id(220), manifestId: id(221), payload: b4a.from('valid writer operation') }
  })
  let forged = null
  for (let seed = 0; seed < 1_024; seed++) {
    const prepared = prepareSignedEnvelope({
      recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
      schemaMajor: 1,
      schemaMinor: 0,
      issuerIdentityKey: descriptor.publisherId,
      signerKey: writer.publicKey,
      policyEpoch: 0,
      issuerSequence: 1,
      signedAt: 1_700_000_000_000,
      canonicalBody: encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.PUBLICATION, {
        publicationId: id(222),
        manifestId: id(223),
        payload: b4a.from(`forged-${seed}`)
      })
    }, { hash: crypto.hash })
    if (b4a.compare(prepared.recordId, valid.recordId) >= 0) continue
    forged = attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), attacker.secretKey))
    break
  }
  t.ok(forged, 'fixture finds a deterministic lower operation ID')

  const reduced = reducePublisherOperations(descriptor, [
    { value: admission, sourceWriterKey: id(240) },
    { value: forged, sourceWriterKey: attacker.publicKey },
    { value: valid, sourceWriterKey: writer.publicKey }
  ], { keyProvider: provider })
  t.ok(reduced.accepted.some(entry => entry.value === valid), 'authorized writer keeps its sequence')
  t.ok(reduced.rejected.some(entry => entry.value === forged && entry.code === 'SOURCE_WRITER_MISMATCH'), 'invalid claimed-signer candidate is rejected without reserving sequence')
  t.absent(reduced.rejected.some(entry => entry.value === valid), 'valid operation never loses a tie-break to an unauthorized candidate')
})

test('retractions require the capability of their exact decoded target type', (t) => {
  const { root, descriptor, provider } = fixture()
  const claimWriter = crypto.keyPair(bytes(32, 61))
  const publishWriter = crypto.keyPair(bytes(32, 62))
  const state = createPublisherAuthorizationState(descriptor)

  for (const [index, [writer, capability]] of [[claimWriter, 'claim'], [publishWriter, 'publish']].entries()) {
    const admission = signedOperation({
      descriptor,
      signer: root,
      recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
      policyEpoch: 0,
      sequence: index + 1,
      body: {
        writerKey: writer.publicKey,
        signerKey: writer.publicKey,
        capabilities: [capability],
        firstAcceptedSequence: 1,
        expiresAt: 1_800_000_000_000,
        admissionNonce: bytes(16, 200 + index * 16)
      }
    })
    t.is(reducePublisherOperation(state, admission, { keyProvider: provider, sourceWriterKey: id(90) }).code, 'ACCEPTED')
  }

  const retraction = (signer, sequence, targetType, targetId) => signedOperation({
    descriptor,
    signer,
    recordType: PUBLISHER_RECORD_TYPES.RETRACTION,
    policyEpoch: 0,
    sequence,
    body: { targetType, targetId, reason: b4a.from(`retract ${targetType}`) }
  })

  t.is(
    reducePublisherOperation(state, retraction(claimWriter, 1, 'claim', id(210)), {
      keyProvider: provider,
      sourceWriterKey: claimWriter.publicKey
    }).code,
    'ACCEPTED',
    'claim-capable writer may retract a claim'
  )
  t.is(
    reducePublisherOperation(state, retraction(claimWriter, 2, 'publication', id(211)), {
      keyProvider: provider,
      sourceWriterKey: claimWriter.publicKey
    }).code,
    'CAPABILITY_REQUIRED',
    'claim capability cannot retract a publication'
  )
  t.is(
    reducePublisherOperation(state, retraction(publishWriter, 1, 'collection', id(212)), {
      keyProvider: provider,
      sourceWriterKey: publishWriter.publicKey
    }).code,
    'ACCEPTED',
    'publish-capable writer may retract a collection'
  )
  t.is(
    reducePublisherOperation(state, retraction(publishWriter, 2, 'claim', id(213)), {
      keyProvider: provider,
      sourceWriterKey: publishWriter.publicKey
    }).code,
    'CAPABILITY_REQUIRED',
    'publish capability cannot retract a claim'
  )
})

test('recovery is disabled when the committed recovery policy is empty', (t) => {
  const root = crypto.keyPair(bytes(32, 71))
  const newRoot = crypto.keyPair(bytes(32, 72))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: id(73),
    profileRef: b4a.from('profile:no-recovery'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  const state = createPublisherAuthorizationState(descriptor)
  const recovery = signedTransition({
    descriptor,
    signers: [newRoot],
    policyEpoch: 0,
    sequence: 1,
    body: {
      mode: 'recovery',
      previousRootKey: root.publicKey,
      newRootKey: newRoot.publicKey,
      newCatalogEpoch: 1,
      recoveryKeys: [],
      recoveryThreshold: 0,
      profileRef: b4a.from('profile:takeover')
    }
  })
  t.is(
    reducePublisherOperation(state, recovery, { keyProvider: createPublisherKeyProvider() }).code,
    'RECOVERY_DISABLED',
    'a new root self-signature cannot replace an absent recovery quorum'
  )
})

test('revoked cutoff frames cannot predate admission and signer generations cannot be reused', (t) => {
  const { root, descriptor, provider } = fixture()
  const firstWriter = crypto.keyPair(bytes(32, 81))
  const targetWriter = crypto.keyPair(bytes(32, 82))
  const state = createPublisherAuthorizationState(descriptor)
  const admission = (sequence, policyEpoch, writerKey, signerKey, nonceSeed) => signedOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch,
    sequence,
    body: {
      writerKey,
      signerKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, nonceSeed)
    }
  })
  const revocation = (sequence, policyEpoch, writerKey, newPolicyEpoch, cutoff) => signedOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch,
    sequence,
    body: {
      newPolicyEpoch,
      revocations: [{ writerKey, acceptedThroughSequence: cutoff }]
    }
  })

  t.is(reducePublisherOperation(state, admission(1, 0, firstWriter.publicKey, firstWriter.publicKey, 180), { keyProvider: provider }).code, 'ACCEPTED')
  t.is(reducePublisherOperation(state, revocation(2, 0, firstWriter.publicKey, 1, 1), { keyProvider: provider }).code, 'ACCEPTED')
  t.is(
    reducePublisherOperation(
      state,
      admission(3, 1, targetWriter.publicKey, firstWriter.publicKey, 196),
      { keyProvider: provider }
    ).code,
    'SIGNER_ALREADY_BOUND',
    'a revoked signer remains bound to its original delayed-history generation'
  )

  t.is(reducePublisherOperation(state, admission(3, 1, targetWriter.publicKey, targetWriter.publicKey, 212), { keyProvider: provider }).code, 'ACCEPTED')
  t.is(reducePublisherOperation(state, revocation(4, 1, targetWriter.publicKey, 2, 3), { keyProvider: provider }).code, 'ACCEPTED')
  const beforeAdmissionEpoch = signedOperation({
    descriptor,
    signer: targetWriter,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    body: { publicationId: id(214), manifestId: id(215), payload: b4a.from('predates admission epoch') }
  })
  t.is(
    reducePublisherOperation(state, beforeAdmissionEpoch, {
      keyProvider: provider,
      sourceWriterKey: targetWriter.publicKey
    }).code,
    'POLICY_EPOCH_BEFORE_ADMISSION'
  )
})

test('writer sequences are monotonic within their bound Autobase source feed', (t) => {
  const { root, descriptor, provider } = fixture()
  const writer = crypto.keyPair(bytes(32, 91))
  const state = createPublisherAuthorizationState(descriptor)
  const admission = signedOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: writer.publicKey,
      signerKey: writer.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 220)
    }
  })
  t.is(reducePublisherOperation(state, admission, { keyProvider: provider }).code, 'ACCEPTED')
  const publication = sequence => signedOperation({
    descriptor,
    signer: writer,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence,
    body: { publicationId: id(220 + sequence), manifestId: id(224 + sequence), payload: b4a.from(`sequence ${sequence}`) }
  })
  t.is(reducePublisherOperation(state, publication(2), { keyProvider: provider, sourceWriterKey: writer.publicKey }).code, 'ACCEPTED')
  t.is(
    reducePublisherOperation(state, publication(1), {
      keyProvider: provider,
      sourceWriterKey: writer.publicKey
    }).code,
    'WRITER_SEQUENCE_NOT_MONOTONIC'
  )
})

test('writer sequence monotonicity survives revocation and readmission generations', (t) => {
  const { root, descriptor, provider } = fixture()
  const firstSigner = crypto.keyPair(bytes(32, 101))
  const secondSigner = crypto.keyPair(bytes(32, 102))
  const state = createPublisherAuthorizationState(descriptor)
  const admission = (sequence, policyEpoch, signer, firstAcceptedSequence, nonceSeed) => signedOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch,
    sequence,
    body: {
      writerKey: firstSigner.publicKey,
      signerKey: signer.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, nonceSeed)
    }
  })
  t.is(reducePublisherOperation(state, admission(1, 0, firstSigner, 1, 240), { keyProvider: provider }).code, 'ACCEPTED')
  const publication = signedOperation({
    descriptor,
    signer: firstSigner,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 5,
    body: { publicationId: id(241), manifestId: id(242), payload: b4a.from('generation one sequence five') }
  })
  t.is(
    reducePublisherOperation(state, publication, { keyProvider: provider, sourceWriterKey: firstSigner.publicKey }).code,
    'ACCEPTED'
  )
  const revocation = signedOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: firstSigner.publicKey, acceptedThroughSequence: 0 }]
    }
  })
  t.is(reducePublisherOperation(state, revocation, { keyProvider: provider }).code, 'ACCEPTED')
  t.is(
    reducePublisherOperation(state, admission(3, 1, secondSigner, 1, 243), { keyProvider: provider }).code,
    'SEQUENCE_BEFORE_ADMISSION',
    'readmission cannot reset a source feed below its historically accepted sequence'
  )
})
