import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Corestore from 'corestore'

import {
  PUBLISHER_LIMITS,
  PUBLISHER_RECORD_TYPES,
  PublisherCatalog,
  createPublisherNamespaceDescriptor,
  decodePublisherNamespaceDescriptor,
  encodePublisherNamespaceDescriptor,
  derivePublisherId,
  encodePublisherCatalogFrame,
  rebuildPublisherCatalogView,
  applyPublisherCatalogNodes,
  getPublisherProjection,
  openPublisherCatalogView,
  encodePublisherOperationBody
} from '../src/publisher/index.js'
import {
  prepareSignedEnvelope,
  attachSignedEnvelopeSignature,
  signedRecordSignaturePreimage
} from '@peartube/backend/records'

const bytes = (length, seed = 0) => b4a.from(Array.from({ length }, (_, index) => (seed + index) & 255))
const id = seed => bytes(32, seed)
const equal = (left, right) => b4a.equals(left, right)
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function throws (t, fn, pattern) {
  try {
    fn()
  } catch (error) {
    t.ok(pattern.test(error?.message || ''), `expected ${pattern}, received ${error?.message || error}`)
    return
  }
  t.fail(`expected ${pattern} to be thrown`)
}

async function waitUntil(check, message, timeout = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await sleep(25)
  }
  throw new Error(message)
}

function signed({ descriptor, signer, recordType, policyEpoch, sequence, body, signedAt = 1_700_000_000_000 }) {
  const canonicalBody = recordType === PUBLISHER_RECORD_TYPES.NAMESPACE
    ? encodePublisherNamespaceDescriptor(body)
    : encodePublisherOperationBody(recordType, body)
  const prepared = prepareSignedEnvelope({
    recordType,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: signer.publicKey,
    policyEpoch,
    issuerSequence: sequence,
    signedAt,
    canonicalBody
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), signer.secretKey))
}

function deviceSigner(keyPair) {
  return Object.freeze({
    signerKey: b4a.from(keyPair.publicKey),
    async sign(preimage) {
      return crypto.sign(preimage, keyPair.secretKey)
    }
  })
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name))
}

async function replaceJournal(view, sourceWriterKey, frames) {
  for await (const entry of view.createReadStream({ gte: 'journal/', lt: 'journal/\xff' })) await view.del(entry.key)
  for (let index = 0; index < frames.length; index++) {
    await view.put(
      `journal/${String(index).padStart(16, '0')}`,
      b4a.concat([sourceWriterKey, encodePublisherCatalogFrame(frames[index])])
    )
  }
  await view.put('meta/journal-count', b4a.from(String(frames.length)))
}

test('typed catalog operation bodies reject unknown fields, unknown variants, noncanonical order, and allocation-sized input', (t) => {
  const body = {
    writerKey: id(1),
    signerKey: id(33),
    capabilities: ['announce', 'publish'],
    firstAcceptedSequence: 1,
    expiresAt: 1_800_000_000_000,
    admissionNonce: bytes(16, 40)
  }
  t.ok(encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.WRITER_ADMISSION, body).byteLength > 0)
  throws(t, () => encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.WRITER_ADMISSION, { ...body, surprise: true }), /unknown field/)
  throws(t, () => encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.WRITER_ADMISSION, { ...body, capabilities: ['publish', 'announce'] }), /ordered/)
  throws(t, () => encodePublisherOperationBody('publisher.catalog.not-supported', b4a.alloc(0)), /unknown record type/)
  throws(t, () => encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.PUBLICATION, {
    publicationId: id(2),
    manifestId: id(3),
    payload: b4a.alloc(PUBLISHER_LIMITS.maxPayloadBytes + 1)
  }), /payload.*limit/)

  let opened = 0
  const fakeStore = { namespace() { opened++; return this } }
  throws(t, () => new PublisherCatalog(fakeStore, { key: b4a.alloc(31) }), /catalog bootstrap key/)
  throws(t, () => new PublisherCatalog(fakeStore, { publisherId: b4a.alloc(31) }), /publisherId/)
  throws(t, () => new PublisherCatalog(fakeStore, {
    publisherId: id(251),
    keyProvider: {
      verifySignedEnvelope () {},
      verifyMultiSignedEnvelope () {}
    }
  }), /verifySignature/)
  t.is(opened, 0, 'invalid bounds are rejected before namespacing or opening storage')
})

test('accepted page ingest rebuilds an isolated catalog view with exact source provenance', async (t) => {
  const dir = tempDir('peartube-publisher-page-ingest-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 252))
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, { publisherId })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
  })
  const genesis = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor,
  })
  const frame = encodePublisherCatalogFrame(genesis)

  const result = await catalog.ingestAcceptedPage([{
    operationId: b4a.toString(genesis.recordId, 'hex'),
    sourceWriterKey: catalog.localWriterKey,
    frame,
  }])
  const authorization = await catalog.getAuthorizationState()

  t.is(result.accepted, 1)
  t.is(authorization.policyEpoch, 0)
  const storedDescriptor = decodePublisherNamespaceDescriptor((await catalog.view.get('state/descriptor')).value)
  t.ok(equal(storedDescriptor.publisherId, publisherId))
  const page = await catalog.listAcceptedPage({ limit: 1 })
  t.ok(equal(page.entries[0].sourceWriterKey, catalog.localWriterKey))
  t.ok(equal(page.entries[0].frame, frame))

  await catalog.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('two real device writers converge on canonical conflict winners, signed heads, and restart state', async (t) => {
  const dirA = tempDir('peartube-publisher-a-')
  const dirB = tempDir('peartube-publisher-b-')
  const storeA = new Corestore(dirA)
  const storeB = new Corestore(dirB)
  await Promise.all([storeA.ready(), storeB.ready()])
  const root = crypto.keyPair(bytes(32, 10))
  const signerA = deviceSigner(crypto.keyPair(bytes(32, 11)))
  const signerB = deviceSigner(crypto.keyPair(bytes(32, 12)))
  const publisherId = derivePublisherId(root.publicKey)
  const catalogA = new PublisherCatalog(storeA, { publisherId, deviceSigner: signerA })
  await catalogA.ready()
  const catalogB = new PublisherCatalog(storeB, { key: catalogA.key, publisherId, deviceSigner: signerB })
  await catalogB.ready()

  let streamA = storeA.replicate(true, { live: true })
  let streamB = storeB.replicate(false, { live: true })
  streamA.pipe(streamB).pipe(streamA)

  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalogA.key,
    profileRef: b4a.from('profile:catalog'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  const genesis = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  })
  await catalogA.append(genesis)

  // Claimed policy sequence, not append/arrival order, controls root reduction.
  for (const [sequence, writerKey, signerKey, nonceSeed] of [
    [2, catalogB.localWriterKey, catalogB.localSignerKey, 90],
    [1, catalogA.localWriterKey, catalogA.localSignerKey, 70]
  ]) {
    await catalogA.append(signed({
      descriptor,
      signer: root,
      recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
      policyEpoch: 0,
      sequence,
      body: {
        writerKey,
        signerKey,
        capabilities: ['announce', 'publish'],
        firstAcceptedSequence: 1,
        expiresAt: 1_800_000_000_000,
        admissionNonce: bytes(16, nonceSeed)
      }
    }))
  }

  await waitUntil(async () => {
    await catalogB.update()
    return catalogB.writable
  }, 'second catalog writer was not admitted')

  streamA.destroy()
  streamB.destroy()
  const publicationId = id(150)
  const operationA = await catalogA.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    signedAt: 1_700_000_000_000,
    body: { publicationId, manifestId: id(151), payload: b4a.from('writer-a') }
  })
  const operationB = await catalogB.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    signedAt: 1_700_000_000_000,
    body: { publicationId, manifestId: id(152), payload: b4a.from('writer-b') }
  })
  await Promise.all([catalogA.append(operationA), catalogB.append(operationB)])

  streamA = storeA.replicate(true, { live: true })
  streamB = storeB.replicate(false, { live: true })
  streamA.pipe(streamB).pipe(streamA)
  const expected = b4a.compare(operationA.recordId, operationB.recordId) < 0 ? operationA : operationB

  let lastConvergence = null
  try {
    await waitUntil(async () => {
      await Promise.all([catalogA.update(), catalogB.update()])
      const [projectionA, projectionB] = await Promise.all([
        catalogA.getProjection('publication', publicationId),
        catalogB.getProjection('publication', publicationId)
      ])
      lastConvergence = {
        projectionA: projectionA && b4a.toString(projectionA.recordId, 'hex'),
        projectionB: projectionB && b4a.toString(projectionB.recordId, 'hex'),
        expected: b4a.toString(expected.recordId, 'hex'),
        rejectedA: (await catalogA.listRejected()).map(entry => entry.code),
        rejectedB: (await catalogB.listRejected()).map(entry => entry.code),
        writableA: catalogA.writable,
        writableB: catalogB.writable
      }
      return projectionA && projectionB && equal(projectionA.recordId, expected.recordId) && equal(projectionB.recordId, expected.recordId)
    }, 'catalog replicas did not converge on the operation-ID conflict winner')
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(lastConvergence)}`)
  }

  const [snapshotA, snapshotB] = await Promise.all([catalogA.getViewSnapshot(), catalogB.getViewSnapshot()])
  t.ok(equal(snapshotA, snapshotB), 'replicas materialize byte-identical deterministic Hyperbee entries')
  const rejected = await catalogA.listRejected()
  t.ok(rejected.some(entry => entry.code === 'CONFLICT_LOST'), 'losing concurrent publication remains diagnostic history only')

  streamA.destroy()
  streamB.destroy()
  const validAfterForgery = await catalogA.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 2,
    signedAt: 1_700_000_000_000,
    body: { publicationId: id(160), manifestId: id(161), payload: b4a.from('authorized after forged lower ID') }
  })
  const attacker = crypto.keyPair(bytes(32, 99))
  let forgedLowerId = null
  for (let seed = 0; seed < 1_024; seed++) {
    const prepared = prepareSignedEnvelope({
      recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
      schemaMajor: 1,
      schemaMinor: 0,
      issuerIdentityKey: descriptor.publisherId,
      signerKey: catalogA.localSignerKey,
      policyEpoch: 0,
      issuerSequence: 2,
      signedAt: 1_700_000_000_000,
      canonicalBody: encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.PUBLICATION, {
        publicationId: id(162),
        manifestId: id(163),
        payload: b4a.from(`forged-source-${seed}`)
      })
    }, { hash: crypto.hash })
    if (b4a.compare(prepared.recordId, validAfterForgery.recordId) >= 0) continue
    forgedLowerId = attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), attacker.secretKey))
    break
  }
  t.ok(forgedLowerId, 'real catalog fixture finds a lower claimed-signer operation ID')
  await Promise.all([catalogB.append(forgedLowerId), catalogA.append(validAfterForgery)])
  streamA = storeA.replicate(true, { live: true })
  streamB = storeB.replicate(false, { live: true })
  streamA.pipe(streamB).pipe(streamA)
  await waitUntil(async () => {
    await Promise.all([catalogA.update(), catalogB.update()])
    const [validA, validB] = await Promise.all([
      catalogA.getProjection('publication', id(160)),
      catalogB.getProjection('publication', id(160))
    ])
    return validA && validB && equal(validA.recordId, validAfterForgery.recordId) && equal(validB.recordId, validAfterForgery.recordId)
  }, 'unauthorized lower-ID source claimed an admitted signer sequence')
  t.ok((await catalogA.listRejected()).some(entry => entry.operationId === b4a.toString(forgedLowerId.recordId, 'hex') && entry.code === 'SOURCE_WRITER_MISMATCH'), 'view rejects the unauthorized source without reserving the signer sequence')


  const beforeAnnouncement = await catalogA.getViewHead()
  await catalogA.append(await catalogA.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.VIEW_HEAD,
    policyEpoch: 0,
    sequence: 3,
    signedAt: 1_700_000_000_000,
    body: beforeAnnouncement
  }))
  await waitUntil(async () => {
    await catalogB.update()
    const head = await catalogB.getLatestAnnouncement()
    return head && equal(head.body.digest, beforeAnnouncement.digest)
  }, 'signed head announcement did not replicate')
  t.ok(equal(beforeAnnouncement.viewKey, catalogA.view.key), 'head names the deterministic view key')

  streamA.destroy()
  streamB.destroy()
  const foreignRoot = crypto.keyPair(bytes(32, 200))
  let foreignGenesis = null
  let foreignDescriptor = null
  for (let seed = 0; seed < 1_024; seed++) {
    const candidateDescriptor = createPublisherNamespaceDescriptor({
      genesisRootKey: foreignRoot.publicKey,
      catalogBootstrapKey: catalogA.key,
      profileRef: b4a.from(`profile:foreign-${seed}`),
      recoveryKeys: [],
      recoveryThreshold: 0
    })
    const candidate = signed({
      descriptor: candidateDescriptor,
      signer: foreignRoot,
      recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
      policyEpoch: 0,
      sequence: 0,
      body: candidateDescriptor
    })
    if (b4a.compare(candidate.recordId, genesis.recordId) >= 0) continue
    foreignGenesis = candidate
    foreignDescriptor = candidateDescriptor
    break
  }
  t.ok(foreignGenesis, 'fixture deterministically grinds a lower-ID self-signed foreign namespace')
  t.unlike(b4a.toString(foreignDescriptor.publisherId, 'hex'), b4a.toString(descriptor.publisherId, 'hex'), 'forged namespace has a foreign genesis identity')
  await catalogB.append(foreignGenesis)

  await catalogB.close()
  await storeB.close()

  const reopenedStoreB = new Corestore(dirB)
  await reopenedStoreB.ready()
  const reopenedB = new PublisherCatalog(reopenedStoreB, { key: catalogA.key, publisherId, deviceSigner: signerB })
  await reopenedB.ready()
  const reopenedDescriptorEntry = await reopenedB.view.get('state/descriptor')
  const reopenedDescriptor = decodePublisherNamespaceDescriptor(reopenedDescriptorEntry.value)
  t.ok(equal(reopenedDescriptor.publisherId, descriptor.publisherId), 'restart retains the expected publisher namespace despite a lower-ID foreign genesis')
  const reopenedProjection = await reopenedB.getProjection('publication', publicationId)
  t.ok(reopenedProjection && equal(reopenedProjection.recordId, expected.recordId), 'catalog restarts from catalogBootstrapKey with canonical projection')
  t.ok(reopenedB.writable, 'persisted admitted writer remains writable after restart')
  t.ok((await reopenedB.listRejected()).some(entry => entry.operationId === b4a.toString(foreignGenesis.recordId, 'hex') && entry.code === 'CONFLICTING_NAMESPACE'), 'foreign namespace remains diagnostic history only')

  await reopenedB.close()
  await reopenedStoreB.close()
  await catalogA.close()
  t.absent(storeA.closed, 'catalog close does not close caller-owned Corestore')
  await storeA.close()
  fs.rmSync(dirA, { recursive: true, force: true })
  fs.rmSync(dirB, { recursive: true, force: true })
})

test('catalog close owns only explicitly transferred storage and is idempotent', async (t) => {
  const dir = tempDir('peartube-publisher-owned-')
  const store = new Corestore(dir)
  await store.ready()
  const catalog = new PublisherCatalog(store, { ownsStore: true, publisherId: id(250) })
  await catalog.ready()
  await catalog.close()
  await catalog.close()
  t.ok(store.closed, 'explicitly owned store is closed exactly with catalog lifecycle')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('local catalog operations use an admitted device signer distinct from the Autobase writer key', async (t) => {
  const dir = tempDir('peartube-publisher-device-signer-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 31))
  const device = crypto.keyPair(bytes(32, 63))
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, { publisherId, deviceSigner: deviceSigner(device) })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:device-signer'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: catalog.localWriterKey,
      signerKey: device.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 150)
    }
  }))

  const publicationId = id(181)
  const operation = await catalog.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    signedAt: 1_700_000_000_000,
    body: { publicationId, manifestId: id(182), payload: b4a.from('device signed') }
  })
  t.ok(equal(operation.signerKey, device.publicKey), 'envelope names the admitted device signer')
  t.absent(equal(operation.signerKey, catalog.localWriterKey), 'envelope signer is distinct from its Autobase source')
  t.absent(catalog.options.deviceSigner.secretKey, 'catalog retains no device secret bytes')
  const [acceptedReceipt] = await catalog.appendBatchAndConfirm([operation])
  t.ok(acceptedReceipt.accepted, 'confirmed append reports deterministic view acceptance')
  t.ok(equal(acceptedReceipt.operationId, operation.recordId), 'confirmed append returns the canonical operation ID')
  t.ok(await catalog.getProjection('publication', publicationId), 'device-signed local operation reaches the catalog view')

  const validAfterPoison = await catalog.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 2,
    signedAt: 1_700_000_000_000,
    body: { publicationId: id(183), manifestId: id(184), payload: b4a.from('tampered signature') }
  })
  const rejectedOperation = { ...validAfterPoison, signature: b4a.from(validAfterPoison.signature) }
  rejectedOperation.signature[0] ^= 1
  const rejectedReceipt = await catalog.appendAndConfirm(rejectedOperation)
  t.absent(rejectedReceipt.accepted, 'confirmed append reports deterministic rejection')
  t.is(rejectedReceipt.rejectionCode, 'SIGNATURE_REJECTED')
  t.is(
    (await catalog.getOperationReceipt(rejectedOperation.recordId)).rejectionCode,
    'SIGNATURE_REJECTED',
    'bounded receipt lookup is stable after apply'
  )
  const recoveredReceipt = await catalog.appendAndConfirm(validAfterPoison)
  t.ok(recoveredReceipt.accepted, 'a poisoned copy cannot suppress a later valid frame with the same unsigned record ID')
  t.ok(await catalog.getProjection('publication', id(183)), 'the later valid frame is projected')
  t.absent((await catalog.listRejected()).some(entry => entry.operationId === b4a.toString(validAfterPoison.recordId, 'hex')), 'accepted occurrence supersedes contextual rejection diagnostics')

  const conflict = await catalog.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 3,
    signedAt: 1_700_000_000_000,
    body: { publicationId, manifestId: id(185), payload: b4a.from('canonical conflict') }
  })
  await catalog.appendAndConfirm(conflict)
  const conflictWinner = await catalog.getProjection('publication', publicationId)
  const conflictLoser = equal(conflictWinner.recordId, operation.recordId) ? conflict : operation
  const conflictReceipt = await catalog.getOperationReceipt(conflictLoser.recordId)
  t.absent(conflictReceipt.accepted, 'canonical projection conflict loser is not reported as accepted')
  t.is(conflictReceipt.rejectionCode, 'CONFLICT_LOST')

  const newRoot = crypto.keyPair(bytes(32, 64))
  const transitionAuthorization = await catalog.getRootTransitionAuthorization({
    mode: 'rotation',
    newRootKey: newRoot.publicKey
  })
  t.ok(equal(transitionAuthorization.publisherId, publisherId))
  t.ok(equal(transitionAuthorization.activeRootKey, root.publicKey))
  t.is(transitionAuthorization.policyEpoch, 0)
  t.is(transitionAuthorization.expectedSequence, 2)
  t.is(transitionAuthorization.catalogEpoch, 0)
  t.is(transitionAuthorization.signerPolicy.requiredSignerKeys.length, 2)
  t.ok(transitionAuthorization.signerPolicy.requiredSignerKeys.some(key => equal(key, root.publicKey)))
  t.ok(transitionAuthorization.signerPolicy.requiredSignerKeys.some(key => equal(key, newRoot.publicKey)))
  t.is(transitionAuthorization.signerPolicy.quorumSignerKeys.length, 0)
  t.is(transitionAuthorization.signerPolicy.quorum, 0)
  await t.exception(
    catalog.getRootTransitionAuthorization({ mode: 'recovery', newRootKey: newRoot.publicKey }),
    /recovery.*disabled/i
  )
  await t.exception(
    catalog.getRootTransitionAuthorization({ mode: 'rotation', newRootKey: b4a.alloc(31) }),
    /newRootKey.*32 bytes/i
  )

  await catalog.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('recovery transition authorization exposes the exact committed quorum', async (t) => {
  const dir = tempDir('peartube-publisher-recovery-authorization-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 65))
  const newRoot = crypto.keyPair(bytes(32, 66))
  const recoveryKeys = [
    crypto.keyPair(bytes(32, 67)).publicKey,
    crypto.keyPair(bytes(32, 68)).publicKey,
    crypto.keyPair(bytes(32, 69)).publicKey
  ].sort(b4a.compare)
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, { publisherId })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:recovery-authorization'),
    recoveryKeys,
    recoveryThreshold: 2
  })
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))

  const authorization = await catalog.getRootTransitionAuthorization({
    mode: 'recovery',
    newRootKey: newRoot.publicKey
  })
  t.is(authorization.signerPolicy.requiredSignerKeys.length, 1)
  t.ok(equal(authorization.signerPolicy.requiredSignerKeys[0], newRoot.publicKey))
  t.is(authorization.signerPolicy.quorumSignerKeys.length, recoveryKeys.length)
  for (let index = 0; index < recoveryKeys.length; index++) {
    t.ok(equal(authorization.signerPolicy.quorumSignerKeys[index], recoveryKeys[index]))
  }
  t.is(authorization.signerPolicy.quorum, 2)

  await catalog.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('caught-up persisted catalog refuses a different expected publisherId before exposing its view', async (t) => {
  const dir = tempDir('peartube-publisher-reopen-pin-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 91))
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, { publisherId })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:persisted-pin'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))
  const key = b4a.from(catalog.key)
  await catalog.close()
  await store.close()

  const reopenedStore = new Corestore(dir)
  await reopenedStore.ready()
  const wrongPublisherId = id(223)
  const reopened = new PublisherCatalog(reopenedStore, { key, publisherId: wrongPublisherId })
  await t.exception(reopened.ready(), /persisted.*publisherId|publisherId.*persisted/i)
  t.is(reopened.view, null, 'failed identity pin never exposes the caught-up persisted view')

  await reopened.close()
  await reopenedStore.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('catalog-position epoch history survives unrelated revocation and restart without admitting earlier data', async (t) => {
  const dir = tempDir('peartube-publisher-epoch-history-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 101))
  const signerAKeyPair = crypto.keyPair(bytes(32, 102))
  const signerA = deviceSigner(signerAKeyPair)
  const writerB = crypto.keyPair(bytes(32, 103))
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, { publisherId, deviceSigner: signerA })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:epoch-history'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))

  const beforeAdmissionId = id(224)
  await catalog.append(signed({
    descriptor,
    signer: signerAKeyPair,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    body: { publicationId: beforeAdmissionId, manifestId: id(225), payload: b4a.from('before admission') }
  }))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: catalog.localWriterKey,
      signerKey: signerAKeyPair.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 226)
    }
  }))
  t.is(await catalog.getProjection('publication', beforeAdmissionId), null, 'data before its admission position stays rejected')

  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      writerKey: writerB.publicKey,
      signerKey: writerB.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 227)
    }
  }))
  const publicationId = id(228)
  const publication = await catalog.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 2,
    signedAt: 1_700_000_000_000,
    body: { publicationId, manifestId: id(229), payload: b4a.from('writer A epoch zero') }
  })
  await catalog.append(publication)
  t.ok(await catalog.getProjection('publication', publicationId), 'epoch-zero projection exists before policy changes')

  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 3,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: writerB.publicKey, acceptedThroughSequence: 0 }]
    }
  }))
  const afterRevocation = await catalog.getProjection('publication', publicationId)
  t.ok(afterRevocation && equal(afterRevocation.recordId, publication.recordId), 'revoking writer B does not erase writer A epoch-zero history')
  const transitionAuthorization = await catalog.getRootTransitionAuthorization({
    mode: 'rotation',
    newRootKey: id(230)
  })
  t.is(transitionAuthorization.policyEpoch, 1, 'transition authorization reports policy epoch independently of catalog epoch')
  t.is(transitionAuthorization.expectedSequence, 4)
  t.is(transitionAuthorization.catalogEpoch, 0)

  const key = b4a.from(catalog.key)
  await catalog.close()
  await store.close()
  const reopenedStore = new Corestore(dir)
  await reopenedStore.ready()
  const reopened = new PublisherCatalog(reopenedStore, { key, publisherId, deviceSigner: signerA })
  await reopened.ready()
  const afterRestart = await reopened.getProjection('publication', publicationId)
  t.ok(afterRestart && equal(afterRestart.recordId, publication.recordId), 'deterministic restart retains the historical projection')
  t.is(await reopened.getProjection('publication', beforeAdmissionId), null, 'restart keeps pre-admission data rejected')

  await reopened.close()
  await reopenedStore.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('revoked remote writer drains delayed cutoff history before Autobase feed removal', async (t) => {
  const dirA = tempDir('peartube-publisher-cutoff-a-')
  const dirB = tempDir('peartube-publisher-cutoff-b-')
  const storeA = new Corestore(dirA)
  const storeB = new Corestore(dirB)
  await Promise.all([storeA.ready(), storeB.ready()])
  const root = crypto.keyPair(bytes(32, 111))
  const signerA = deviceSigner(crypto.keyPair(bytes(32, 112)))
  const signerB = deviceSigner(crypto.keyPair(bytes(32, 113)))
  const publisherId = derivePublisherId(root.publicKey)
  const catalogA = new PublisherCatalog(storeA, { publisherId, deviceSigner: signerA })
  await catalogA.ready()
  const catalogB = new PublisherCatalog(storeB, { key: catalogA.key, publisherId, deviceSigner: signerB })
  await catalogB.ready()

  let streamA = storeA.replicate(true, { live: true })
  let streamB = storeB.replicate(false, { live: true })
  streamA.pipe(streamB).pipe(streamA)
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalogA.key,
    profileRef: b4a.from('profile:delayed-cutoff'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  await catalogA.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))
  for (const [sequence, catalog, nonceSeed] of [[1, catalogA, 232], [2, catalogB, 233]]) {
    await catalogA.append(signed({
      descriptor,
      signer: root,
      recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
      policyEpoch: 0,
      sequence,
      body: {
        writerKey: catalog.localWriterKey,
        signerKey: catalog.localSignerKey,
        capabilities: ['publish'],
        firstAcceptedSequence: 1,
        expiresAt: 1_800_000_000_000,
        admissionNonce: bytes(16, nonceSeed)
      }
    }))
  }
  await waitUntil(async () => {
    await catalogB.update()
    return catalogB.writable
  }, 'remote writer was not admitted')

  streamA.destroy()
  streamB.destroy()
  const throughCutoffId = id(234)
  const aboveCutoffId = id(235)
  const throughCutoff = await catalogB.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    signedAt: 1_700_000_000_000,
    body: { publicationId: throughCutoffId, manifestId: id(236), payload: b4a.from('delayed through cutoff') }
  })
  const aboveCutoff = await catalogB.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 2,
    signedAt: 1_700_000_000_000,
    body: { publicationId: aboveCutoffId, manifestId: id(237), payload: b4a.from('above cutoff') }
  })
  await catalogB.append(throughCutoff)
  await catalogB.append(aboveCutoff)
  await catalogA.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 3,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: catalogB.localWriterKey, acceptedThroughSequence: 1 }]
    }
  }))

  streamA = storeA.replicate(true, { live: true })
  streamB = storeB.replicate(false, { live: true })
  streamA.pipe(streamB).pipe(streamA)
  let lastCutoffState = null
  try {
    await waitUntil(async () => {
      await Promise.all([catalogA.update(), catalogB.update()])
      const delayed = await catalogA.getProjection('publication', throughCutoffId)
      const rejected = await catalogA.listRejected()
      lastCutoffState = {
        delayed: delayed && b4a.toString(delayed.recordId, 'hex'),
        rejected,
        writableA: catalogA.writable,
        writableB: catalogB.writable
      }
      return delayed &&
        equal(delayed.recordId, throughCutoff.recordId) &&
        rejected.some(entry => entry.operationId === b4a.toString(aboveCutoff.recordId, 'hex') && entry.code === 'REVOKED_WRITER')
    }, 'revoked writer cutoff history did not drain before feed removal')
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(lastCutoffState)}`)
  }
  t.is(await catalogA.getProjection('publication', aboveCutoffId), null, 'above-cutoff operation never reaches projections')

  streamA.destroy()
  streamB.destroy()
  await catalogB.close()
  await catalogA.close()
  await Promise.all([storeA.close(), storeB.close()])
  fs.rmSync(dirA, { recursive: true, force: true })
  fs.rmSync(dirB, { recursive: true, force: true })
})

test('bounded journal saturation evicts rejected frames without freezing later authority', async (t) => {
  const dir = tempDir('peartube-publisher-journal-bound-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 121))
  const signerKeyPair = crypto.keyPair(bytes(32, 122))
  const signer = deviceSigner(signerKeyPair)
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, { publisherId, deviceSigner: signer, journalLimit: 5 })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:journal-bound'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: catalog.localWriterKey,
      signerKey: signerKeyPair.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 238)
    }
  }))

  const unadmittedSigner = crypto.keyPair(bytes(32, 123))
  for (let index = 0; index < 3; index++) {
    const validLooking = signed({
      descriptor,
      signer: unadmittedSigner,
      recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
      policyEpoch: 0,
      sequence: 50 + index,
      body: {
        publicationId: id(240 + index),
        manifestId: id(243 + index),
        payload: b4a.from(`terminal rejection ${index}`)
      }
    })
    const invalidSignature = { ...validLooking, signature: b4a.from(validLooking.signature) }
    invalidSignature.signature[0] ^= 1
    await catalog.append(invalidSignature)
  }

  const writerB = crypto.keyPair(bytes(32, 124))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      writerKey: writerB.publicKey,
      signerKey: writerB.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 247)
    }
  }))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 3,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: writerB.publicKey, acceptedThroughSequence: 0 }]
    }
  }))

  const publicationId = id(248)
  const valid = await catalog.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 1,
    sequence: 1,
    signedAt: 1_700_000_000_000,
    body: { publicationId, manifestId: id(249), payload: b4a.from('valid after saturation') }
  })
  await catalog.append(valid)
  const projection = await catalog.getProjection('publication', publicationId)
  t.ok(projection && equal(projection.recordId, valid.recordId), 'valid record after rejected saturation is still applied')
  const rejected = await catalog.listRejected()
  t.ok(rejected.some(entry => entry.code === 'JOURNAL_OVERFLOW' && entry.droppedCount > 0), 'bounded overflow is surfaced diagnostically')

  await catalog.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('journal compaction preserves out-of-order authority that becomes valid later', async (t) => {
  const dir = tempDir('peartube-publisher-journal-future-authority-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 131))
  const signerKeyPair = crypto.keyPair(bytes(32, 132))
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, {
    publisherId,
    deviceSigner: deviceSigner(signerKeyPair),
    journalLimit: 5
  })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:future-authority'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))

  const writerB = crypto.keyPair(bytes(32, 133))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      writerKey: writerB.publicKey,
      signerKey: writerB.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 250)
    }
  }))

  const foreignRoot = crypto.keyPair(bytes(32, 134))
  const foreignDescriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: foreignRoot.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:foreign-journal-spam'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  for (let index = 0; index < 3; index++) {
    await catalog.append(signed({
      descriptor: foreignDescriptor,
      signer: foreignRoot,
      recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
      policyEpoch: 0,
      sequence: index + 1,
      body: {
        publicationId: id(251 + index),
        manifestId: id(254 - index),
        payload: b4a.from(`foreign terminal rejection ${index}`)
      }
    }))
  }

  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: catalog.localWriterKey,
      signerKey: signerKeyPair.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 253)
    }
  }))
  const revocation = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 3,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: writerB.publicKey, acceptedThroughSequence: 0 }]
    }
  })
  await catalog.append(revocation)
  const descriptorEntry = await catalog.view.get('state/descriptor')
  const replayedDescriptor = decodePublisherNamespaceDescriptor(descriptorEntry.value)
  t.is(replayedDescriptor.policySequence, 3, 'missing sequence arrival reactivates preserved later authority through revocation')
  t.absent(
    (await catalog.listRejected()).some(entry => entry.operationId === b4a.toString(revocation.recordId, 'hex')),
    'future-valid authority is not compacted into terminal diagnostics'
  )

  await catalog.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('accepted data saturation leaves reserved capacity for later root authority', async (t) => {
  const dir = tempDir('peartube-publisher-journal-authority-reserve-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 141))
  const signerKeyPair = crypto.keyPair(bytes(32, 142))
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, {
    publisherId,
    deviceSigner: deviceSigner(signerKeyPair),
    journalLimit: 5
  })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:authority-reserve'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: catalog.localWriterKey,
      signerKey: signerKeyPair.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 143)
    }
  }))
  for (let sequence = 1; sequence <= 3; sequence++) {
    await catalog.append(await catalog.createLocalOperation({
      recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
      policyEpoch: 0,
      sequence,
      signedAt: 1_700_000_000_000,
      body: {
        publicationId: id(150 + sequence),
        manifestId: id(160 + sequence),
        payload: b4a.from(`accepted saturation ${sequence}`)
      }
    }))
  }

  const writerB = crypto.keyPair(bytes(32, 144))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      writerKey: writerB.publicKey,
      signerKey: writerB.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 145)
    }
  }))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 3,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: writerB.publicKey, acceptedThroughSequence: 0 }]
    }
  }))
  const descriptorEntry = await catalog.view.get('state/descriptor')
  const currentDescriptor = decodePublisherNamespaceDescriptor(descriptorEntry.value)
  t.is(currentDescriptor.policySequence, 3, 'admission and revocation apply after accepted data reaches its bounded quota')
  t.ok(
    (await catalog.listRejected()).some(entry => entry.code === 'JOURNAL_OVERFLOW'),
    'data quota overflow remains explicit while root authority continues'
  )

  await catalog.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('speculative authority frames cannot consume the root authority reserve', async (t) => {
  const dir = tempDir('peartube-publisher-speculative-authority-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 151))
  const signerKeyPair = crypto.keyPair(bytes(32, 152))
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, {
    publisherId,
    deviceSigner: deviceSigner(signerKeyPair),
    journalLimit: 5
  })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:speculative-authority'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: catalog.localWriterKey,
      signerKey: signerKeyPair.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 153)
    }
  }))

  const attacker = crypto.keyPair(bytes(32, 154))
  for (let sequence = 2; sequence <= 4; sequence++) {
    await catalog.append(signed({
      descriptor,
      signer: attacker,
      recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
      policyEpoch: 0,
      sequence,
      body: {
        writerKey: id(160 + sequence),
        signerKey: id(170 + sequence),
        capabilities: ['publish'],
        firstAcceptedSequence: 1,
        expiresAt: 1_800_000_000_000,
        admissionNonce: bytes(16, 180 + sequence)
      }
    }))
  }

  const writerB = crypto.keyPair(bytes(32, 155))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      writerKey: writerB.publicKey,
      signerKey: writerB.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 156)
    }
  }))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 3,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: writerB.publicKey, acceptedThroughSequence: 0 }]
    }
  }))
  const descriptorEntry = await catalog.view.get('state/descriptor')
  t.is(
    decodePublisherNamespaceDescriptor(descriptorEntry.value).policySequence,
    3,
    'real admission and revocation retain the authority lane under speculative spam'
  )
  t.ok((await catalog.listRejected()).some(entry => entry.code === 'JOURNAL_OVERFLOW'), 'speculative authority overflow is diagnostic')

  await catalog.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('out-of-order signed writer sequences cannot justify early revoked-feed drainage', async (t) => {
  const dir = tempDir('peartube-publisher-drain-order-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 161))
  const signerKeyPair = crypto.keyPair(bytes(32, 162))
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, { publisherId, deviceSigner: deviceSigner(signerKeyPair) })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:drain-order'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: catalog.localWriterKey,
      signerKey: signerKeyPair.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 163)
    }
  }))
  const publication = async (sequence, publicationId) => catalog.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence,
    signedAt: 1_700_000_000_000,
    body: { publicationId, manifestId: id(170 + sequence), payload: b4a.from(`out of order ${sequence}`) }
  })
  const aboveCutoffId = id(174)
  const throughCutoffId = id(175)
  const aboveCutoff = await publication(2, aboveCutoffId)
  const throughCutoff = await publication(1, throughCutoffId)
  await catalog.append(aboveCutoff)
  await catalog.append(throughCutoff)
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: catalog.localWriterKey, acceptedThroughSequence: 1 }]
    }
  }))

  t.is(await catalog.getProjection('publication', aboveCutoffId), null, 'above-cutoff sequence is rejected')
  t.is(await catalog.getProjection('publication', throughCutoffId), null, 'later lower sequence is not treated as delayed authorized history')
  const rejected = await catalog.listRejected()
  t.ok(
    rejected.some(entry => entry.operationId === b4a.toString(throughCutoff.recordId, 'hex') && entry.code === 'WRITER_SEQUENCE_NOT_MONOTONIC'),
    'feed-order sequence regression is explicit'
  )

  await catalog.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('drained writer removal is retried until Autobase reports it removable', async (t) => {
  const dir = tempDir('peartube-publisher-remove-retry-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 181))
  const signerKeyPair = crypto.keyPair(bytes(32, 182))
  const writerB = crypto.keyPair(bytes(32, 183))
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, { publisherId, deviceSigner: deviceSigner(signerKeyPair) })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:remove-retry'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))
  for (const [sequence, writerKey, signerKey, nonceSeed] of [
    [1, catalog.localWriterKey, signerKeyPair.publicKey, 184],
    [2, writerB.publicKey, writerB.publicKey, 200]
  ]) {
    await catalog.append(signed({
      descriptor,
      signer: root,
      recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
      policyEpoch: 0,
      sequence,
      body: {
        writerKey,
        signerKey,
        capabilities: ['publish'],
        firstAcceptedSequence: 1,
        expiresAt: 1_800_000_000_000,
        admissionNonce: bytes(16, nonceSeed)
      }
    }))
  }

  const applyHost = catalog.base._applyState.hostcalls
  const originalRemoveable = applyHost.removeable
  const originalRemoveWriter = applyHost.removeWriter
  let canRemove = false
  let removeCalls = 0
  applyHost.removeable = () => canRemove
  applyHost.removeWriter = async function (writerKey) {
    removeCalls++
    return originalRemoveWriter.call(this, writerKey)
  }
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 3,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: writerB.publicKey, acceptedThroughSequence: 0 }]
    }
  }))
  t.is(removeCalls, 0, 'first non-removable attempt is deferred')
  canRemove = true
  await catalog.append(await catalog.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 1,
    sequence: 1,
    signedAt: 1_700_000_000_000,
    body: { publicationId: id(210), manifestId: id(211), payload: b4a.from('trigger retry') }
  }))
  t.is(removeCalls, 1, 'later rebuild retries and removes the drained writer')
  applyHost.removeable = originalRemoveable
  applyHost.removeWriter = originalRemoveWriter

  await catalog.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('forged genesis frames cannot consume the accepted authority reserve', async (t) => {
  const dir = tempDir('peartube-publisher-forged-genesis-quota-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 221))
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, { publisherId, journalLimit: 5 })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:forged-genesis-quota'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  for (let seed = 222; seed <= 226; seed++) {
    await catalog.append(signed({
      descriptor,
      signer: crypto.keyPair(bytes(32, seed)),
      recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
      policyEpoch: 0,
      sequence: 0,
      body: descriptor
    }))
  }
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  }))
  const writer = crypto.keyPair(bytes(32, 227))
  await catalog.append(signed({
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
      admissionNonce: bytes(16, 228)
    }
  }))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: writer.publicKey, acceptedThroughSequence: 0 }]
    }
  }))
  const descriptorEntry = await catalog.view.get('state/descriptor')
  t.ok(descriptorEntry, 'valid genesis is not displaced by forged reserve claims')
  t.is(decodePublisherNamespaceDescriptor(descriptorEntry.value).policySequence, 2, 'validated authority survives forged genesis quota spam')

  await catalog.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('accepted authority replay frames are journal-idempotent', async (t) => {
  const dir = tempDir('peartube-publisher-authority-replay-quota-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 231))
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, { publisherId, journalLimit: 5 })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:authority-replay-quota'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  const genesis = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  })
  await catalog.append(genesis)
  const writerA = crypto.keyPair(bytes(32, 232))
  const admissionA = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: writerA.publicKey,
      signerKey: writerA.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 233)
    }
  })
  await catalog.append(admissionA)
  for (let replay = 0; replay < 4; replay++) await catalog.append(admissionA)
  const writerB = crypto.keyPair(bytes(32, 234))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      writerKey: writerB.publicKey,
      signerKey: writerB.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 235)
    }
  }))
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 3,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: writerB.publicKey, acceptedThroughSequence: 0 }]
    }
  }))
  const descriptorEntry = await catalog.view.get('state/descriptor')
  t.is(decodePublisherNamespaceDescriptor(descriptorEntry.value).policySequence, 3, 'authority replay cannot consume later authority capacity')

  await catalog.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('authority candidate selection carries position-aware feed sequence high-water', async (t) => {
  const dir = tempDir('peartube-publisher-authority-high-water-')
  const store = new Corestore(dir)
  await store.ready()
  const view = openPublisherCatalogView({ get: name => store.get({ name }) })
  await view.ready()
  const bootstrapKey = id(239)
  const sourceWriterKey = id(240)
  const root = crypto.keyPair(bytes(32, 241))
  const firstSigner = crypto.keyPair(bytes(32, 242))
  const lowSigner = crypto.keyPair(bytes(32, 243))
  const highSigner = crypto.keyPair(bytes(32, 244))
  const publisherId = derivePublisherId(root.publicKey)
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bootstrapKey,
    profileRef: b4a.from('profile:authority-high-water'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  const genesis = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  })
  const firstAdmission = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: sourceWriterKey,
      signerKey: firstSigner.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 245)
    }
  })
  const observedSequence = signed({
    descriptor,
    signer: firstSigner,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 5,
    body: { publicationId: id(246), manifestId: id(247), payload: b4a.from('observed sequence five') }
  })
  const revocation = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: sourceWriterKey, acceptedThroughSequence: 0 }]
    }
  })
  let invalidLow = null
  let validHigh = null
  for (let seed = 0; seed < 256; seed++) {
    const lowCandidate = signed({
      descriptor,
      signer: root,
      recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
      policyEpoch: 1,
      sequence: 3,
      body: {
        writerKey: sourceWriterKey,
        signerKey: lowSigner.publicKey,
        capabilities: ['publish'],
        firstAcceptedSequence: 1,
        expiresAt: 1_800_000_000_000,
        admissionNonce: bytes(16, seed)
      }
    })
    const highCandidate = signed({
      descriptor,
      signer: root,
      recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
      policyEpoch: 1,
      sequence: 3,
      body: {
        writerKey: sourceWriterKey,
        signerKey: highSigner.publicKey,
        capabilities: ['publish'],
        firstAcceptedSequence: 6,
        expiresAt: 1_800_000_000_000,
        admissionNonce: bytes(16, seed)
      }
    })
    if (!invalidLow || b4a.compare(lowCandidate.recordId, invalidLow.recordId) < 0) invalidLow = lowCandidate
    if (!validHigh || b4a.compare(highCandidate.recordId, validHigh.recordId) > 0) validHigh = highCandidate
  }
  t.ok(b4a.compare(invalidLow.recordId, validHigh.recordId) < 0, 'invalid low readmission would win an ID-only authority prepass')

  await replaceJournal(view, sourceWriterKey, [
    genesis,
    firstAdmission,
    observedSequence,
    revocation,
    invalidLow,
    validHigh
  ])
  const rebuilt = await rebuildPublisherCatalogView(view, {
    key: bootstrapKey,
    addWriter: async () => {},
    removeable: () => false,
    removeWriter: async () => {}
  }, { publisherId })
  t.is(rebuilt.state.policySequence, 3, 'valid high-water readmission advances root authority')
  t.ok(equal(rebuilt.state.writers.get(b4a.toString(sourceWriterKey, 'hex')).signerKey, highSigner.publicKey))
  t.ok(
    rebuilt.rejected.some(entry => equal(entry.value.recordId, invalidLow.recordId) && entry.code === 'SEQUENCE_BEFORE_ADMISSION'),
    'low readmission is rejected before it can suppress the valid authority candidate'
  )

  await view.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('revoked writer is drained when its authenticated sequence reaches the cutoff exactly', async (t) => {
  const dir = tempDir('peartube-publisher-cutoff-equal-drain-')
  const store = new Corestore(dir)
  await store.ready()
  const view = openPublisherCatalogView({ get: name => store.get({ name }) })
  await view.ready()
  const bootstrapKey = id(249)
  const sourceWriterKey = id(250)
  const root = crypto.keyPair(bytes(32, 251))
  const signer = crypto.keyPair(bytes(32, 252))
  const publisherId = derivePublisherId(root.publicKey)
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bootstrapKey,
    profileRef: b4a.from('profile:cutoff-equal-drain'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  const genesis = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  })
  const admission = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: sourceWriterKey,
      signerKey: signer.publicKey,
      capabilities: ['publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 253)
    }
  })
  const throughCutoff = signed({
    descriptor,
    signer,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    body: { publicationId: id(254), manifestId: id(255), payload: b4a.from('exact cutoff') }
  })
  const revocation = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
    policyEpoch: 0,
    sequence: 2,
    body: {
      newPolicyEpoch: 1,
      revocations: [{ writerKey: sourceWriterKey, acceptedThroughSequence: 1 }]
    }
  })
  let removeCalls = 0
  const host = {
    key: bootstrapKey,
    addWriter: async () => {},
    removeable: () => true,
    removeWriter: async () => { removeCalls++ }
  }
  await replaceJournal(view, sourceWriterKey, [genesis, admission, throughCutoff])
  await rebuildPublisherCatalogView(view, host, { publisherId })
  await replaceJournal(view, sourceWriterKey, [genesis, admission, throughCutoff, revocation])
  await rebuildPublisherCatalogView(view, host, { publisherId })
  t.is(removeCalls, 0, 'cutoff equality checkpoints for one rebuild so peers can consume the final authorized frame')
  await rebuildPublisherCatalogView(view, host, { publisherId })
  t.is(removeCalls, 1, 'cutoff-equal authenticated history completes the bounded drain on the checkpoint retry')

  await view.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('journal compaction evicts only the exact terminal context of a shared record ID', async (t) => {
  const dir = tempDir('peartube-publisher-context-compaction-')
  const store = new Corestore(dir)
  await store.ready()
  const view = openPublisherCatalogView({ get: name => store.get({ name }) })
  await view.ready()
  const bootstrapKey = id(11)
  const rootSource = id(12)
  const writerSource = id(13)
  const root = crypto.keyPair(bytes(32, 14))
  const writer = crypto.keyPair(bytes(32, 15))
  const futureWriter = crypto.keyPair(bytes(32, 16))
  const missingWriter = crypto.keyPair(bytes(32, 17))
  const publisherId = derivePublisherId(root.publicKey)
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bootstrapKey,
    profileRef: b4a.from('profile:context-compaction'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  const node = (sourceWriterKey, value) => ({
    value: encodePublisherCatalogFrame(value),
    from: { key: sourceWriterKey }
  })
  const host = {
    key: bootstrapKey,
    addWriter: async () => {},
    removeable: () => false,
    removeWriter: async () => {}
  }
  const options = { publisherId, journalLimit: 8 }
  const genesis = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  })
  const admission = (sequence, writerKey, signerKey, nonceSeed) => signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
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
  await applyPublisherCatalogNodes([
    node(rootSource, genesis),
    node(rootSource, admission(1, writerSource, writer.publicKey, 18)),
    node(rootSource, admission(2, id(19), id(20), 21))
  ], view, host, options)

  const futureValid = admission(4, futureWriter.publicKey, futureWriter.publicKey, 22)
  const poisonedContext = { ...futureValid, signature: b4a.from(futureValid.signature) }
  poisonedContext.signature[0] ^= 1
  const invalidData = sequence => {
    const value = signed({
      descriptor,
      signer: writer,
      recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
      policyEpoch: 0,
      sequence,
      body: { publicationId: id(30 + sequence), manifestId: id(40 + sequence), payload: b4a.from(`terminal ${sequence}`) }
    })
    value.signature[0] ^= 1
    return value
  }
  await applyPublisherCatalogNodes([
    node(rootSource, futureValid),
    node(rootSource, poisonedContext),
    node(writerSource, invalidData(1)),
    node(writerSource, invalidData(2)),
    node(writerSource, invalidData(3))
  ], view, host, options)

  const rebuilt = await applyPublisherCatalogNodes([
    node(rootSource, admission(3, missingWriter.publicKey, missingWriter.publicKey, 23))
  ], view, host, options)
  t.ok(
    rebuilt.state.writers.has(b4a.toString(futureWriter.publicKey, 'hex')),
    'terminal signature context cannot evict the same-ID authority frame that becomes valid later'
  )

  await view.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('state-dependent rejection survives compaction until a late authority conflict resolves', async (t) => {
  const dir = tempDir('peartube-publisher-contextual-rejection-')
  const store = new Corestore(dir)
  await store.ready()
  const view = openPublisherCatalogView({ get: name => store.get({ name }) })
  await view.ready()
  const bootstrapKey = id(51)
  const rootSource = id(52)
  const writerSource = id(53)
  const fillerSource = id(86)
  const root = crypto.keyPair(bytes(32, 54))
  const writer = crypto.keyPair(bytes(32, 55))
  const filler = crypto.keyPair(bytes(32, 87))
  const publisherId = derivePublisherId(root.publicKey)
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bootstrapKey,
    profileRef: b4a.from('profile:contextual-rejection'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  const node = (sourceWriterKey, value) => ({
    value: encodePublisherCatalogFrame(value),
    from: { key: sourceWriterKey }
  })
  const host = {
    key: bootstrapKey,
    addWriter: async () => {},
    removeable: () => false,
    removeWriter: async () => {}
  }
  const options = { publisherId, journalLimit: 8 }
  const genesis = signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  })
  const admission = (sequence, capabilities, nonceSeed, admittedWriterKey = writerSource, admittedSignerKey = writer.publicKey) => signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence,
    body: {
      writerKey: admittedWriterKey,
      signerKey: admittedSignerKey,
      capabilities,
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, nonceSeed)
    }
  })
  let currentAdmission = admission(1, ['announce'], 56)
  let resolvingAdmission = null
  for (let seed = 57; seed < 313; seed++) {
    const candidate = admission(1, ['publish'], seed & 255)
    if (b4a.compare(candidate.recordId, currentAdmission.recordId) < 0) {
      resolvingAdmission = candidate
      break
    }
  }
  t.ok(resolvingAdmission, 'fixture finds a lower-ID authority conflict that changes admitted capabilities')
  await applyPublisherCatalogNodes([
    node(rootSource, genesis),
    node(rootSource, currentAdmission),
    node(rootSource, admission(2, ['publish'], 88, fillerSource, filler.publicKey)),
  ], view, host, options)

  const publicationId = id(57)
  const publication = signed({
    descriptor,
    signer: writer,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    body: { publicationId, manifestId: id(58), payload: b4a.from('contextually authorized later') }
  })
  const corrupt = value => {
    const copy = { ...value, signature: b4a.from(value.signature) }
    copy.signature[0] ^= 1
    return copy
  }
  const invalidData = sequence => corrupt(signed({
    descriptor,
    signer: filler,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence,
    body: { publicationId: id(60 + sequence), manifestId: id(70 + sequence), payload: b4a.from(`invalid ${sequence}`) }
  }))
  await applyPublisherCatalogNodes([
    node(writerSource, publication),
    node(fillerSource, invalidData(2)),
    node(fillerSource, invalidData(3)),
    node(fillerSource, invalidData(4)),
    node(rootSource, admission(3, ['publish'], 83, id(84), id(85)))
  ], view, host, options)

  const resolved = await applyPublisherCatalogNodes([node(rootSource, resolvingAdmission)], view, host, options)
  const resolvingOutcome = resolved.accepted.find(entry => equal(entry.value.recordId, resolvingAdmission.recordId)) ||
    resolved.rejected.find(entry => equal(entry.value.recordId, resolvingAdmission.recordId))
  t.is(resolvingOutcome?.code, 'ACCEPTED', 'late authority conflict is retained by the bounded journal')
  t.alike(resolved.state.writers.get(b4a.toString(writerSource, 'hex'))?.capabilities, ['publish'], 'late lower-ID admission wins the authority conflict')
  t.ok(
    resolved.rejected.some(entry => equal(entry.value.recordId, publication.recordId)),
    'state-dependent rejection remains in position-aware replay history after compaction'
  )
  const laterPublication = signed({
    descriptor,
    signer: writer,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 2,
    body: { publicationId: id(59), manifestId: id(60), payload: b4a.from('authorized after conflict') }
  })
  await applyPublisherCatalogNodes([node(writerSource, laterPublication)], view, host, options)
  const projected = await getPublisherProjection(view, 'publication', id(59))
  t.ok(projected && equal(projected.recordId, laterPublication.recordId), 'later data uses the resolved capability without rewriting prior catalog positions')

  await view.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('writer high-water carry cannot read past the authority candidate position', async (t) => {
  const dir = tempDir('peartube-publisher-position-bounded-high-water-')
  const store = new Corestore(dir)
  await store.ready()
  const view = openPublisherCatalogView({ get: name => store.get({ name }) })
  await view.ready()
  const bootstrapKey = id(101)
  const rootSource = id(102)
  const writerSource = id(103)
  const root = crypto.keyPair(bytes(32, 104))
  const oldSigner = crypto.keyPair(bytes(32, 105))
  const newSigner = crypto.keyPair(bytes(32, 106))
  const publisherId = derivePublisherId(root.publicKey)
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bootstrapKey,
    profileRef: b4a.from('profile:position-bounded-high-water'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  const node = (sourceWriterKey, value) => ({
    value: encodePublisherCatalogFrame(value),
    from: { key: sourceWriterKey }
  })
  const rootOperation = (recordType, policyEpoch, sequence, body) => signed({
    descriptor,
    signer: root,
    recordType,
    policyEpoch,
    sequence,
    body
  })
  const publication = (signer, policyEpoch, sequence, publicationId) => signed({
    descriptor,
    signer,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch,
    sequence,
    body: { publicationId, manifestId: id(publicationId[0] + 1), payload: b4a.from(`sequence ${sequence}`) }
  })
  const genesis = rootOperation(PUBLISHER_RECORD_TYPES.NAMESPACE, 0, 0, descriptor)
  const admission = rootOperation(PUBLISHER_RECORD_TYPES.WRITER_ADMISSION, 0, 1, {
    writerKey: writerSource,
    signerKey: oldSigner.publicKey,
    capabilities: ['publish'],
    firstAcceptedSequence: 1,
    expiresAt: 1_800_000_000_000,
    admissionNonce: bytes(16, 107)
  })
  const throughCutoff = publication(oldSigner, 0, 1, id(108))
  const revocation = rootOperation(PUBLISHER_RECORD_TYPES.WRITER_REVOCATION, 0, 2, {
    newPolicyEpoch: 1,
    revocations: [{ writerKey: writerSource, acceptedThroughSequence: 1 }]
  })
  const readmission = rootOperation(PUBLISHER_RECORD_TYPES.WRITER_ADMISSION, 1, 3, {
    writerKey: writerSource,
    signerKey: newSigner.publicKey,
    capabilities: ['publish'],
    firstAcceptedSequence: 2,
    expiresAt: 1_800_000_000_000,
    admissionNonce: bytes(16, 109)
  })
  const afterReadmissionId = id(110)
  const afterReadmission = publication(newSigner, 1, 2, afterReadmissionId)
  const laterOldGeneration = publication(oldSigner, 0, 100, id(112))
  const host = {
    key: bootstrapKey,
    addWriter: async () => {},
    removeable: () => false,
    removeWriter: async () => {}
  }
  const rebuilt = await applyPublisherCatalogNodes([
    node(rootSource, genesis),
    node(rootSource, admission),
    node(writerSource, throughCutoff),
    node(rootSource, revocation),
    node(rootSource, readmission),
    node(writerSource, afterReadmission),
    node(writerSource, laterOldGeneration)
  ], view, host, { publisherId })
  t.ok(equal(
    rebuilt.state.writers.get(b4a.toString(writerSource, 'hex'))?.signerKey,
    newSigner.publicKey
  ), 'later old-generation data cannot retroactively invalidate readmission')
  const projected = await getPublisherProjection(view, 'publication', afterReadmissionId)
  t.ok(projected && equal(projected.recordId, afterReadmission.recordId), 'post-readmission history remains projected')

  await view.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('persisted pre-cutover namespace genesis migrates once and survives strict rebuilds', async (t) => {
  const dir = tempDir('peartube-publisher-legacy-compat-')
  const store = new Corestore(dir)
  await store.ready()
  const view = openPublisherCatalogView({ get: name => store.get({ name }) })
  await view.ready()
  const bootstrapKey = id(201)
  const sourceWriterKey = id(202)
  const root = crypto.keyPair(bytes(32, 203))
  const publisherId = derivePublisherId(root.publicKey)
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bootstrapKey,
    profileRef: b4a.from('profile:legacy-persisted'),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  const encoded = encodePublisherNamespaceDescriptor(descriptor)
  const capability = b4a.from(descriptor.requiredCapabilities[0])
  const compatibilitySuffix = b4a.concat([
    b4a.from([
      descriptor.minimumProtocolMajor,
      descriptor.protocolMinor,
      descriptor.requiredCapabilities.length,
      capability.byteLength
    ]),
    capability
  ])
  t.ok(equal(encoded.subarray(encoded.byteLength - compatibilitySuffix.byteLength), compatibilitySuffix))
  const legacyBody = encoded.subarray(0, encoded.byteLength - compatibilitySuffix.byteLength)
  const prepared = prepareSignedEnvelope({
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: publisherId,
    signerKey: root.publicKey,
    policyEpoch: 0,
    issuerSequence: 0,
    signedAt: 1_700_000_000_000,
    canonicalBody: legacyBody
  }, { hash: crypto.hash })
  const genesis = attachSignedEnvelopeSignature(
    prepared,
    crypto.sign(signedRecordSignaturePreimage(prepared), root.secretKey)
  )
  const frame = encodePublisherCatalogFrame(genesis)
  await replaceJournal(view, sourceWriterKey, [genesis])
  await view.put('state/descriptor', legacyBody)
  await view.put(`accepted/${b4a.toString(genesis.recordId, 'hex')}`, frame)

  const host = {
    key: bootstrapKey,
    async addWriter() {},
    removeable() { return true },
    async removeWriter() {},
  }
  const first = await rebuildPublisherCatalogView(view, host, { publisherId })
  t.ok(first.descriptor, 'exact previously accepted legacy genesis survives the cutover rebuild')
  const migrated = await view.get('state/descriptor')
  t.alike(decodePublisherNamespaceDescriptor(migrated.value), descriptor, 'rebuild migrates persisted descriptor to canonical advertised encoding')
  const second = await rebuildPublisherCatalogView(view, host, { publisherId })
  t.ok(second.descriptor, 'strict subsequent rebuild no longer needs legacy admission')

  await view.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

// Discovery hands a consumer a publisher's bootstrap key and nothing else. The
// Autobase behind that key cannot open until a peer replicates its first
// block, and the scope that would replicate it is only joined once the catalog
// has been bound - so awaiting Autobase readiness deadlocks the very first
// follow of every publisher. A follower rebuilds the catalog locally from
// verified accepted pages instead, so opening must not wait on the base.
test('a catalog opened from an unreachable remote bootstrap key still becomes usable', async (t) => {
  const dir = tempDir('peartube-publisher-remote-open-')
  const store = new Corestore(dir)
  await store.ready()
  const root = crypto.keyPair(bytes(32, 231))
  const publisherId = derivePublisherId(root.publicKey)
  // A key no peer will ever serve, which is exactly a freshly discovered
  // publisher before its scope is joined.
  const unreachableBootstrapKey = bytes(32, 232)

  const catalog = new PublisherCatalog(store, { publisherId, key: unreachableBootstrapKey })
  const opened = await Promise.race([
    catalog.ready().then(() => 'ready'),
    new Promise(resolve => setTimeout(() => resolve('stalled'), 20000))
  ])
  t.is(opened, 'ready', 'opening does not block on an unreachable base')

  // The base never opened, so nothing may present this as a writable catalog.
  t.absent(catalog.writable, 'an unreplicated remote catalog is never writable')

  // The verified page view is local and must be available for page ingest.
  const view = await catalog.openVerifiedPageView()
  t.ok(view, 'the verified page view opens without the base')

  await catalog.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
