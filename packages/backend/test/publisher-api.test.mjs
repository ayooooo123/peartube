import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Corestore from 'corestore'
import Hyperbee from 'hyperbee'

import * as publisherApiModule from '../src/api/publisher.js'
import {
  PUBLISHER_RECORD_TYPES,
  createPublisherNamespaceDescriptor,
  decodePublisherNamespaceDescriptor,
  derivePublisherId,
  encodePublisherNamespaceDescriptor,
  encodePublisherOperationBody,
  verifyPublisherNamespaceProof,
} from '../src/publisher/index.js'
import {
  attachMultiSignedEnvelopeSignatures,
  attachSignedEnvelopeSignature,
  decodeUnsignedMultiSignedEnvelope,
  decodeUnsignedSignedEnvelope,
  multiSignedRecordSignaturePreimage,
  prepareMultiSignedEnvelope,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage
} from '@peartube/backend/records'
import { SHARED_HANDLER_NAMES } from '../src/hrpc-handlers.js'
import { attachMobileHandlers } from '../src/mobile-handlers.js'

const NOW = 1_700_000_000_000
const bytes = (length, seed = 0) => b4a.from(Array.from({ length }, (_, index) => (seed + index) & 255))
const hex = value => b4a.toString(value, 'hex')
const intentId = seed => seed.toString(16).padStart(32, '0')

function signedNamespaceGenesis(descriptor, root) {
  const prepared = prepareSignedEnvelope({
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: root.publicKey,
    policyEpoch: 0,
    issuerSequence: 0,
    signedAt: NOW,
    canonicalBody: encodePublisherNamespaceDescriptor(descriptor),
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(
    prepared,
    crypto.sign(signedRecordSignaturePreimage(prepared), root.secretKey)
  )
}

function signedNamespaceTransition(descriptor, root, nextRoot, newCatalogEpoch) {
  const prepared = prepareMultiSignedEnvelope({
    recordType: PUBLISHER_RECORD_TYPES.ROOT_TRANSITION,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    policyEpoch: 0,
    issuerSequence: 1,
    signedAt: NOW + 1,
    canonicalBody: encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.ROOT_TRANSITION, {
      mode: 'rotation',
      previousRootKey: root.publicKey,
      newRootKey: nextRoot.publicKey,
      newCatalogEpoch,
      recoveryKeys: descriptor.recoveryKeys,
      recoveryThreshold: descriptor.recoveryThreshold,
      profileRef: descriptor.profileRef,
    }),
  }, { hash: crypto.hash })
  const preimage = multiSignedRecordSignaturePreimage(prepared)
  const signatures = [root, nextRoot].map(signer => ({
    signerKey: signer.publicKey,
    signature: crypto.sign(preimage, signer.secretKey),
  })).sort((left, right) => b4a.compare(left.signerKey, right.signerKey))
  return attachMultiSignedEnvelopeSignatures(prepared, signatures)
}

function createCatalogRegistry({ catalogKey = bytes(32, 100), appendError = null, rootTransitionState = null } = {}) {
  const appended = []
  const pending = new Map()
  let binding = null
  const catalog = {
    key: b4a.from(catalogKey),
    writable: true,
    localWriterKey: b4a.from(catalogKey),
    localSignerKey: bytes(32, 99),
    async waitForWritable() {
      return true
    },
    async getAuthorizationState() {
      const namespace = appended.find(value => value.recordType === PUBLISHER_RECORD_TYPES.NAMESPACE)
      if (!namespace) return null
      const writers = appended
        .filter(value => value.recordType === PUBLISHER_RECORD_TYPES.WRITER_ADMISSION)
        .map(value => {
          const body = decodePublisherOperationBody(value.recordType, value.canonicalBody)
          return {
            key: hex(body.writerKey),
            signerKey: hex(body.signerKey),
            capabilities: body.capabilities,
            firstAcceptedSequence: body.firstAcceptedSequence,
            lastAcceptedSequence: body.firstAcceptedSequence - 1,
            expiresAt: body.expiresAt,
            admissionPolicyEpoch: 0,
            revocation: null
          }
        })
      return { policyEpoch: 0, policySequence: writers.length, writers }
    },
    async getOperationReceipt(operationId) {
      return appended.some(value => b4a.equals(value.recordId || value.transitionId, operationId))
        ? { accepted: true }
        : { accepted: false }
    },
    async appendAndConfirm(value) {
      if (appendError) throw appendError
      appended.push(value)
      return { operationId: b4a.from(value.recordId || value.transitionId), accepted: true }
    },
    async getRootOperationAuthorization() {
      if (!binding) throw new Error('root authorization unavailable')
      return {
        publisherId: b4a.from(binding.publisherId),
        activeRootKey: b4a.from(binding.genesisRootKey),
        policyEpoch: rootTransitionState?.policyEpoch || 0,
        expectedSequence: rootTransitionState?.expectedSequence || 1,
        catalogEpoch: rootTransitionState?.catalogEpoch || 0,
        signerPolicy: {
          requiredSignerKeys: [b4a.from(binding.genesisRootKey)],
          quorumSignerKeys: [],
          quorum: 0
        }
      }
    },
    async getRootTransitionAuthorization({ mode, newRootKey }) {
      if (!rootTransitionState || !binding) throw new Error('transition authorization unavailable')
      return {
        publisherId: b4a.from(binding.publisherId),
        activeRootKey: b4a.from(binding.genesisRootKey),
        policyEpoch: rootTransitionState.policyEpoch,
        expectedSequence: rootTransitionState.expectedSequence,
        catalogEpoch: rootTransitionState.catalogEpoch,
        signerPolicy: rootTransitionState.signerPolicy || {
          requiredSignerKeys: mode === 'rotation'
            ? [b4a.from(binding.genesisRootKey), b4a.from(newRootKey)]
            : [b4a.from(newRootKey)],
          quorumSignerKeys: [],
          quorum: 0
        }
      }
    }
  }
  return {
    catalog,
    appended,
    bind(publisherId, genesisRootKey) {
      binding = {
        catalog,
        publisherId: b4a.from(publisherId),
        genesisRootKey: b4a.from(genesisRootKey),
        catalogBootstrapKey: b4a.from(catalog.key)
      }
    },
    async provision() {
      return binding
    },
    async getWritableBindings() {
      return binding ? [binding] : []
    },
    async listBindingPage() {
      return { items: binding ? [binding] : [], nextCursor: null, errors: [], release: async () => {} }
    },
    async resolve() {
      return binding
    },
    async loadPendingTransition(publisherId, transitionId) {
      return pending.get(`${hex(publisherId)}:${hex(transitionId)}`) || null
    },
    async savePendingTransition(value) {
      pending.set(`${hex(value.publisherId)}:${hex(value.transitionId)}`, value)
      return value
    },
    async deletePendingTransition(publisherId, transitionId) {
      pending.delete(`${hex(publisherId)}:${hex(transitionId)}`)
    }
  }
}

function createNamespaceFixture(options = {}) {
  const root = crypto.keyPair(bytes(32, options.rootSeed ?? 1))
  const publisherId = derivePublisherId(root.publicKey)
  const registry = options.registry || createCatalogRegistry(options)
  registry.bind?.(publisherId, root.publicKey)
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: registry.catalog.key,
    profileRef: b4a.from('publisher profile')
  })
  const body = encodePublisherNamespaceDescriptor(descriptor)
  let clock = options.now ?? NOW
  const api = publisherApiModule.createPublisherApi({
    now: () => clock,
    catalogRegistry: registry,
    maxIntents: options.maxIntents,
    ctx: options.ctx,
  })
  return {
    api,
    body,
    descriptor,
    publisherId,
    publisherIdHex: hex(publisherId),
    registry,
    root,
    setNow(value) { clock = value }
  }
}

function prepareRequest(fixture, seed = 1, overrides = {}) {
  return {
    intentId: intentId(seed),
    publisherId: fixture.publisherIdHex,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    signerPublicKey: fixture.root.publicKey,
    body: fixture.body,
    displaySummaryJson: '{"action":"create publisher"}',
    issuedAt: NOW,
    expiresInMs: 60_000,
    intentExpiresAt: NOW + 60_000,
    ...overrides
  }
}

function signedSubmitRequest(fixture, prepared, overrides = {}) {
  const signature = crypto.sign(signedRecordSignaturePreimage({
    recordType: prepared.recordType,
    recordId: prepared.candidateRecordId
  }), fixture.root.secretKey)
  return {
    intentId: prepared.intentId,
    publisherId: prepared.publisherId,
    recordType: prepared.recordType,
    unsignedBytes: prepared.unsignedBytes,
    candidateRecordId: prepared.candidateRecordId,
    displaySummaryJson: prepared.displaySummaryJson,
    signer: fixture.root.publicKey,
    signerPublicKey: fixture.root.publicKey,
    signature,
    ...overrides
  }
}

test('prepare uses canonical verification-only records and pins a provisioned namespace catalog', async (t) => {
  const fixture = createNamespaceFixture()
  const provisioned = await fixture.api.provisionPublisherCatalog({
    publisherId: fixture.publisherIdHex,
    genesisRootKey: fixture.root.publicKey
  })
  t.is(provisioned.success, true)
  t.alike(provisioned.catalogBootstrapKey, fixture.registry.catalog.key)
  const wrongPublisher = await fixture.api.provisionPublisherCatalog({
    publisherId: hex(bytes(32, 230)),
    genesisRootKey: fixture.root.publicKey
  })
  t.is(wrongPublisher.success, false)
  t.is(wrongPublisher.errorCode, 'PUBLISHER_ID_MISMATCH')

  const prepared = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture))
  t.is(prepared.success, true, 'the verification-only key provider is not called for removed signing methods')
  t.is(prepared.error, null)
  t.is(prepared.intentId, intentId(1))
  t.alike(prepared.signerPublicKey, fixture.root.publicKey)
  t.alike(prepared.candidateRecordId, crypto.hash(prepared.unsignedBytes))

  const decoded = decodeUnsignedSignedEnvelope(prepared.unsignedBytes)
  t.is(decoded.recordType, PUBLISHER_RECORD_TYPES.NAMESPACE)
  t.alike(decoded.issuerIdentityKey, fixture.publisherId)
  t.alike(decoded.signerKey, fixture.root.publicKey)
  t.is(decoded.policyEpoch, 0)
  t.is(decoded.expiresAt, undefined, 'intent TTL is not embedded as a permanent root-record expiry')
  t.is(prepared.expiresAt, 0, 'absent record expiry stays absent on the wire')
  t.is(prepared.intentExpiresAt, NOW + 60_000, 'prepare response carries the exact bounded intent expiry')
  t.is(decoded.issuerSequence, 0)
  t.alike(decodePublisherNamespaceDescriptor(decoded.canonicalBody), fixture.descriptor)

  const invented = createPublisherNamespaceDescriptor({
    genesisRootKey: fixture.root.publicKey,
    catalogBootstrapKey: bytes(32, 220)
  })
  const mismatch = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 2, {
    body: encodePublisherNamespaceDescriptor(invented)
  }))
  t.is(mismatch.success, false)
  t.is(mismatch.error, 'PUBLISHER_CATALOG_MISMATCH')
})
test('provision reports one writable local catalog with public writer and signer keys', async (t) => {
  const root = crypto.keyPair(bytes(32, 17))
  const publisherId = derivePublisherId(root.publicKey)
  const localWriterKey = bytes(32, 18)
  const localSignerKey = bytes(32, 19)
  let writableChecks = 0
  const binding = {
    publisherId,
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 20),
    catalog: {
      writable: true,
      key: bytes(32, 20),
      localWriterKey,
      localSignerKey,
      async waitForWritable() {
        writableChecks++
        return true
      },
      async getAuthorizationState() {
        return null
      }
    }
  }
  const registry = {
    async listBindingPage() {
      return { items: [binding], nextCursor: null, errors: [], release: async () => {} }
    },
    async provision() {
      return binding
    }
  }
  const api = publisherApiModule.createPublisherApi({ catalogRegistry: registry, now: () => NOW })

  const provisioned = await api.provisionPublisherCatalog({
    publisherId: hex(publisherId),
    genesisRootKey: root.publicKey
  })

  t.is(provisioned.success, true)
  t.is(provisioned.writable, true)
  t.is(provisioned.namespaceInitialized, false)
  t.is(provisioned.admitted, false)
  t.alike(provisioned.localWriterKey, localWriterKey)
  t.alike(provisioned.localSignerKey, localSignerKey)
  t.is(writableChecks, 1)
})

test('shell root intent path admits and revokes the normal device writer without importing root material', async t => {
  const fixture = createNamespaceFixture()
  const writerKey = bytes(32, 40)
  const signerKey = bytes(32, 41)
  for (const [seed, recordType, body] of [
    [60, PUBLISHER_RECORD_TYPES.WRITER_ADMISSION, {
      writerKey,
      signerKey,
      capabilities: ['claim', 'publish'],
      firstAcceptedSequence: 1,
      expiresAt: NOW + 100_000,
      admissionNonce: bytes(16, 42)
    }],
    [61, PUBLISHER_RECORD_TYPES.WRITER_REVOCATION, {
      newPolicyEpoch: 1,
      revocations: [{ writerKey, acceptedThroughSequence: 3 }]
    }]
  ]) {
    const prepared = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, seed, {
      recordType,
      signerPublicKey: fixture.root.publicKey,
      body: encodePublisherOperationBody(recordType, body),
      expiresInMs: 0
    }))
    t.is(prepared.success, true)
    const decoded = decodeUnsignedSignedEnvelope(prepared.unsignedBytes)
    t.is(decoded.recordType, recordType)
    const submitted = await fixture.api.submitPublisherRootOperation(signedSubmitRequest(fixture, prepared))
    t.is(submitted.success, true)
    t.is(submitted.complete, true)
  }
  t.is(fixture.registry.appended.length, 2)
})

test('writer admission fails closed while legacy publication migration is pending', async t => {
  let migrationChecks = 0
  const fixture = createNamespaceFixture({
    ctx: {
      async completePublicationV1Migration() {
        migrationChecks++
        return { status: 'pending' }
      }
    }
  })
  const recordType = PUBLISHER_RECORD_TYPES.WRITER_ADMISSION
  const prepared = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 62, {
    recordType,
    signerPublicKey: fixture.root.publicKey,
    body: encodePublisherOperationBody(recordType, {
      writerKey: fixture.registry.catalog.localWriterKey,
      signerKey: fixture.registry.catalog.localSignerKey,
      capabilities: ['claim', 'publish'],
      firstAcceptedSequence: 1,
      expiresAt: NOW + 100_000,
      admissionNonce: bytes(16, 44)
    }),
    expiresInMs: 0
  }))
  t.is(prepared.success, true)
  const submitted = await fixture.api.submitPublisherRootOperation(
    signedSubmitRequest(fixture, prepared)
  )
  t.is(submitted.success, false)
  t.is(submitted.reason, 'PUBLISHER_MIGRATION_PENDING')
  t.is(migrationChecks, 1)
})


test('valid single-signed namespace intent appends exactly once and replay is rejected', async (t) => {
  const fixture = createNamespaceFixture()
  const prepared = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 3))
  const request = signedSubmitRequest(fixture, prepared)
  const submitted = await fixture.api.submitPublisherRootOperation(request)

  t.is(submitted.success, true)
  t.is(submitted.valid, true)
  t.is(submitted.complete, true)
  t.is(submitted.reason, null)
  t.alike(submitted.recordId, prepared.candidateRecordId)
  t.alike(submitted.signer, fixture.root.publicKey)
  t.alike(submitted.signerPublicKey, fixture.root.publicKey)
  t.alike(submitted.signature, request.signature)
  t.is(fixture.registry.appended.length, 1)
  t.alike(fixture.registry.appended[0].canonicalBody, fixture.body)

  const replay = await fixture.api.submitPublisherRootOperation(request)
  t.is(replay.success, false)
  t.is(replay.complete, false)
  t.is(replay.reason, 'PUBLISHER_INTENT_UNKNOWN')
  t.is(fixture.registry.appended.length, 1, 'replay never appends')

  const duplicatePrepared = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 4))
  const duplicateRecord = await fixture.api.submitPublisherRootOperation(signedSubmitRequest(fixture, duplicatePrepared))
  t.is(duplicateRecord.success, false)
  t.is(duplicateRecord.reason, 'PUBLISHER_RECORD_REPLAY')
  t.is(fixture.registry.appended.length, 1, 'fresh-intent duplicate never appends')
})

test('concurrent fresh intents cannot append the same candidate twice', async (t) => {
  const fixture = createNamespaceFixture()
  const first = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 8))
  const second = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 9))
  t.alike(first.candidateRecordId, second.candidateRecordId)
  const results = await Promise.all([
    fixture.api.submitPublisherRootOperation(signedSubmitRequest(fixture, first)),
    fixture.api.submitPublisherRootOperation(signedSubmitRequest(fixture, second))
  ])
  t.is(results.filter(result => result.success).length, 1)
  t.is(results.find(result => !result.success)?.reason, 'PUBLISHER_RECORD_REPLAY')
  t.is(fixture.registry.appended.length, 1)
})

test('real context registry durably applies a provisioned namespace genesis before success', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-publisher-api-'))
  const store = new Corestore(directory)
  await store.ready()
  const metadataCore = store.get({ name: 'publisher-api-test-metadata' })
  await metadataCore.ready()
  const metaDb = new Hyperbee(metadataCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await metaDb.ready()
  const device = crypto.keyPair(bytes(32, 71))
  const registry = publisherApiModule.createPublisherCatalogRegistry({ store, metaDb }, {
    now: () => NOW,
    deviceSigner: {
      signerKey: device.publicKey,
      sign: preimage => crypto.sign(preimage, device.secretKey)
    }
  })
  try {
    const reboundPublishers = []
    const root = crypto.keyPair(bytes(32, 70))
    const publisherId = derivePublisherId(root.publicKey)
    const api = publisherApiModule.createPublisherApi({
      catalogRegistry: registry,
      now: () => NOW,
      ctx: {
        scopedNetwork: {
          async rebindLocalPublisherCatalog(request) {
            reboundPublishers.push(request.publisherId)
          },
        },
      },
    })
    const provisioned = await api.provisionPublisherCatalog({
      publisherId: hex(publisherId),
      genesisRootKey: root.publicKey
    })
    t.is(provisioned.success, true)
    const descriptor = createPublisherNamespaceDescriptor({
      genesisRootKey: root.publicKey,
      catalogBootstrapKey: provisioned.catalogBootstrapKey
    })
    const prepared = await api.preparePublisherRootOperation({
      intentId: intentId(5),
      publisherId: hex(publisherId),
      recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
      signerPublicKey: root.publicKey,
      body: encodePublisherNamespaceDescriptor(descriptor),
      issuedAt: NOW,
      expiresInMs: 60_000,
      intentExpiresAt: NOW + 60_000
    })
    t.is(prepared.success, true)
    const signature = crypto.sign(signedRecordSignaturePreimage({
      recordType: prepared.recordType,
      recordId: prepared.candidateRecordId
    }), root.secretKey)
    const submitted = await api.submitPublisherRootOperation({
      intentId: prepared.intentId,
      publisherId: prepared.publisherId,
      recordType: prepared.recordType,
      unsignedBytes: prepared.unsignedBytes,
      candidateRecordId: prepared.candidateRecordId,
      displaySummaryJson: prepared.displaySummaryJson,
      signer: root.publicKey,
      signerPublicKey: root.publicKey,
      signature
    })
    t.is(submitted.reason, null, 'confirmed append has no failure reason')
    t.is(submitted.success, true)
    t.is(submitted.complete, true)
    const binding = await registry.resolve(publisherId)
    const receipt = await binding.catalog.getOperationReceipt(prepared.candidateRecordId)
    t.is(receipt.accepted, true)

    const newRoot = crypto.keyPair(bytes(32, 90))
    const transitionBody = encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.ROOT_TRANSITION, {
      mode: 'rotation',
      previousRootKey: root.publicKey,
      newRootKey: newRoot.publicKey,
      newCatalogEpoch: 1,
      recoveryKeys: [],
      recoveryThreshold: 0,
      profileRef: b4a.alloc(0)
    })
    async function submitRotationContribution(seed, signer) {
      const transition = await api.preparePublisherRootOperation({
        intentId: intentId(seed),
        publisherId: hex(publisherId),
        recordType: PUBLISHER_RECORD_TYPES.ROOT_TRANSITION,
        signerPublicKey: signer.publicKey,
        body: transitionBody,
        issuedAt: NOW + 1,
        expiresInMs: 60_000,
        intentExpiresAt: NOW + 60_000
      })
      t.is(transition.success, true)
      const transitionSignature = crypto.sign(multiSignedRecordSignaturePreimage({
        recordType: transition.recordType,
        transitionId: transition.candidateRecordId
      }), signer.secretKey)
      return {
        transition,
        result: await api.submitPublisherRootOperation({
          intentId: transition.intentId,
          publisherId: transition.publisherId,
          recordType: transition.recordType,
          unsignedBytes: transition.unsignedBytes,
          candidateRecordId: transition.candidateRecordId,
          displaySummaryJson: transition.displaySummaryJson,
          signer: signer.publicKey,
          signerPublicKey: signer.publicKey,
          signature: transitionSignature
        })
      }
    }
    const firstRotation = await submitRotationContribution(6, root)
    t.is(firstRotation.result.success, false)
    t.is(firstRotation.result.complete, false)
    t.is(firstRotation.result.reason, 'PUBLISHER_ROOT_TRANSITION_PENDING')
    const secondRotation = await submitRotationContribution(7, newRoot)
    t.alike(secondRotation.transition.candidateRecordId, firstRotation.transition.candidateRecordId)
    t.is(secondRotation.result.success, true)
    t.is(secondRotation.result.complete, true)
    const transitionReceipt = await binding.catalog.getOperationReceipt(secondRotation.transition.candidateRecordId)
    t.is(transitionReceipt.accepted, true)
    t.alike(reboundPublishers, [hex(publisherId)], 'accepted transition notifies the live scoped transport exactly once')
  } finally {
    await registry.close()
    await store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('catalog registry binds only the catalog key named by a verified namespace descriptor', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-publisher-binding-'))
  const store = new Corestore(directory)
  await store.ready()
  const metadataCore = store.get({ name: 'publisher-binding-metadata' })
  await metadataCore.ready()
  const metaDb = new Hyperbee(metadataCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await metaDb.ready()
  const root = crypto.keyPair(bytes(32, 111))
  const publisherId = derivePublisherId(root.publicKey)
  const catalogBootstrapKey = bytes(32, 112)
  const descriptor = createPublisherNamespaceDescriptor({ genesisRootKey: root.publicKey, catalogBootstrapKey })
  const opened = []
  let closedCatalogs = 0
  const registry = publisherApiModule.createPublisherCatalogRegistry({ store, metaDb }, {
    catalogFactory (_store, catalogOptions) {
      opened.push(catalogOptions)
      return {
        key: b4a.from(catalogOptions.key),
        async ready () {},
        async close () { closedCatalogs++ },
      }
    },
    maxOpenCatalogs: 1,
  })
  try {
    const binding = await registry.bindNamespace(descriptor)
    t.alike(binding.publisherId, publisherId)
    t.alike(binding.catalogBootstrapKey, catalogBootstrapKey)
    t.is(opened.length, 1)
    t.alike(opened[0].publisherId, publisherId)
    t.alike(opened[0].key, catalogBootstrapKey)
    t.ok(/^peartube-publisher-[0-9a-f]{32}$/.test(opened[0].namespace))
    const resolved = await registry.resolve(publisherId)
    t.is(resolved, binding, 'verified descriptor binding is durable in the registry')
    t.is(await registry.release(publisherId), true)
    t.is(closedCatalogs, 1, 'release closes and evicts the inactive catalog')
    const secondRoot = crypto.keyPair(bytes(32, 120))
    const secondPublisherId = derivePublisherId(secondRoot.publicKey)
    const secondCatalogKey = bytes(32, 121)
    const secondDescriptor = createPublisherNamespaceDescriptor({ genesisRootKey: secondRoot.publicKey, catalogBootstrapKey: secondCatalogKey })
    const secondBinding = await registry.bindNamespace(secondDescriptor)
    t.alike(secondBinding.catalogBootstrapKey, secondCatalogKey, 'eviction frees bounded registry capacity')
  } finally {
    await registry.close()
    await store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('catalog registry accepts authenticated monotonic root rotation and rejects skipped or stale epochs', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-publisher-rotation-binding-'))
  const store = new Corestore(directory)
  await store.ready()
  const metadataCore = store.get({ name: 'publisher-rotation-binding-metadata' })
  await metadataCore.ready()
  const metaDb = new Hyperbee(metadataCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await metaDb.ready()
  const root = crypto.keyPair(bytes(32, 130))
  const nextRoot = crypto.keyPair(bytes(32, 131))
  const catalogBootstrapKey = bytes(32, 132)
  const genesisDescriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey,
  })
  const genesis = signedNamespaceGenesis(genesisDescriptor, root)
  const transition = signedNamespaceTransition(genesisDescriptor, root, nextRoot, 1)
  const locator = {
    publisherId: hex(genesisDescriptor.publisherId),
    catalogBootstrapKey: hex(catalogBootstrapKey),
    catalogEpoch: 1,
  }
  const verified = verifyPublisherNamespaceProof({
    locator,
    genesis,
    transitions: [transition],
  })
  const registry = publisherApiModule.createPublisherCatalogRegistry({ store, metaDb }, {
    catalogFactory (_store, catalogOptions) {
      return {
        key: b4a.from(catalogOptions.key),
        async ready () {},
        async close () {},
      }
    },
  })
  try {
    await registry.bindNamespace(genesisDescriptor)
    const rotated = await registry.bindNamespace(verified.descriptor, {
      verifiedNamespaceProof: { genesis, transitions: [transition] },
    })
    t.is(rotated.namespaceDescriptor.catalogEpoch, 1)
    t.alike(rotated.genesisRootKey, root.publicKey, 'stable publisher identity remains bound to the genesis root')

    const skippedTransition = signedNamespaceTransition(genesisDescriptor, root, nextRoot, 2)
    await t.exception(registry.bindNamespace(verified.descriptor, {
      verifiedNamespaceProof: { genesis, transitions: [skippedTransition] },
    }), /transition|epoch/i)
    await t.exception(registry.bindNamespace(genesisDescriptor), /stale|epoch/i)
  } finally {
    await registry.close()
    await store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('submit consumes terminal attempts and rejects every prepared-intent substitution', async (t) => {
  const fixture = createNamespaceFixture()
  const wrongSigner = crypto.keyPair(bytes(32, 40))
  const substitutions = [
    ['publisherId', () => ({ publisherId: hex(bytes(32, 200)) }), 'PUBLISHER_INTENT_MISMATCH'],
    ['recordType', () => ({ recordType: PUBLISHER_RECORD_TYPES.ROOT_TRANSITION }), 'PUBLISHER_INTENT_MISMATCH'],
    ['unsignedBytes', prepared => ({ unsignedBytes: b4a.concat([prepared.unsignedBytes, b4a.from([0])]) }), 'PUBLISHER_INTENT_MISMATCH'],
    ['candidateRecordId', () => ({ candidateRecordId: bytes(32, 201) }), 'PUBLISHER_INTENT_MISMATCH'],
    ['displaySummaryJson', () => ({ displaySummaryJson: '{"action":"substitute"}' }), 'PUBLISHER_INTENT_MISMATCH'],
    ['signerPublicKey', () => ({ signerPublicKey: wrongSigner.publicKey }), 'PUBLISHER_SIGNER_MISMATCH'],
    ['signer', () => ({ signer: wrongSigner.publicKey }), 'PUBLISHER_SIGNER_MISMATCH'],
    ['signature', prepared => {
      const signature = crypto.sign(signedRecordSignaturePreimage({ recordType: prepared.recordType, recordId: prepared.candidateRecordId }), wrongSigner.secretKey)
      return { signature }
    }, 'PUBLISHER_SIGNATURE_INVALID']
  ]

  let seed = 10
  for (const [name, mutate, reason] of substitutions) {
    const prepared = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, seed++))
    const valid = signedSubmitRequest(fixture, prepared)
    const rejected = await fixture.api.submitPublisherRootOperation({ ...valid, ...mutate(prepared) })
    t.is(rejected.success, false, `${name} substitution fails`)
    t.is(rejected.complete, false, `${name} substitution is incomplete`)
    t.is(rejected.reason, reason, `${name} has a stable redacted reason`)
    const consumed = await fixture.api.submitPublisherRootOperation(valid)
    t.is(consumed.reason, 'PUBLISHER_INTENT_UNKNOWN', `${name} terminal attempt consumed its intent`)
  }
  t.is(fixture.registry.appended.length, 0)
})

test('expired, duplicate, capacity-bound, and append-failed intents never report success', async (t) => {
  const fixture = createNamespaceFixture({ maxIntents: 2 })
  const first = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 30, { intentExpiresAt: NOW + 1 }))
  const duplicate = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 30))
  t.is(duplicate.success, false)
  t.is(duplicate.error, 'PUBLISHER_INTENT_DUPLICATE')
  t.is((await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 31))).success, true)
  const full = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 32))
  t.is(full.success, false)
  t.is(full.error, 'PUBLISHER_INTENT_CAPACITY')

  fixture.setNow(NOW + 1)
  const expired = await fixture.api.submitPublisherRootOperation(signedSubmitRequest(fixture, first))
  t.is(expired.success, false)
  t.is(expired.reason, 'PUBLISHER_INTENT_EXPIRED')
  t.is(fixture.registry.appended.length, 0)

  const secretText = hex(fixture.body)
  const failingRegistry = createCatalogRegistry({ appendError: new Error(`append leaked ${secretText}`) })
  const failing = createNamespaceFixture({ registry: failingRegistry })
  const prepared = await failing.api.preparePublisherRootOperation(prepareRequest(failing, 33))
  const result = await failing.api.submitPublisherRootOperation(signedSubmitRequest(failing, prepared))
  t.is(result.success, false)
  t.is(result.valid, true, 'signature validity is distinct from persistence')
  t.is(result.complete, false)
  t.is(result.reason, 'PUBLISHER_CATALOG_APPEND_FAILED')
  t.absent(JSON.stringify(result).includes(secretText), 'raw append exception/body is redacted')
})

test('durably accumulated root-transition contributions append only at the exact authorized quorum', async (t) => {
  const registry = createCatalogRegistry({
    rootTransitionState: { policyEpoch: 0, expectedSequence: 1, catalogEpoch: 0 }
  })
  const fixture = createNamespaceFixture({ registry })
  const newRoot = crypto.keyPair(bytes(32, 180))
  const body = encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.ROOT_TRANSITION, {
    mode: 'rotation',
    previousRootKey: fixture.root.publicKey,
    newRootKey: newRoot.publicKey,
    newCatalogEpoch: 1,
    recoveryKeys: [],
    recoveryThreshold: 0,
    profileRef: b4a.alloc(0)
  })
  const first = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 40, {
    recordType: PUBLISHER_RECORD_TYPES.ROOT_TRANSITION,
    signerPublicKey: fixture.root.publicKey,
    body
  }))
  t.is(first.success, true)
  const decoded = decodeUnsignedMultiSignedEnvelope(first.unsignedBytes)
  t.is(decoded.recordType, PUBLISHER_RECORD_TYPES.ROOT_TRANSITION)
  t.alike(first.candidateRecordId, crypto.hash(first.unsignedBytes))
  const firstSignature = crypto.sign(multiSignedRecordSignaturePreimage({
    recordType: first.recordType,
    transitionId: first.candidateRecordId
  }), fixture.root.secretKey)
  const firstResult = await fixture.api.submitPublisherRootOperation({
    intentId: first.intentId,
    publisherId: first.publisherId,
    recordType: first.recordType,
    unsignedBytes: first.unsignedBytes,
    candidateRecordId: first.candidateRecordId,
    displaySummaryJson: first.displaySummaryJson,
    signer: fixture.root.publicKey,
    signerPublicKey: fixture.root.publicKey,
    signature: firstSignature
  })
  t.is(firstResult.success, false, 'one contribution is not persisted success')
  t.is(firstResult.valid, true)
  t.is(firstResult.complete, false)
  t.is(firstResult.reason, 'PUBLISHER_ROOT_TRANSITION_PENDING')
  t.is(firstResult.pendingSignatureCount, 1)
  t.is(registry.appended.length, 0)

  const second = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, 41, {
    recordType: PUBLISHER_RECORD_TYPES.ROOT_TRANSITION,
    signerPublicKey: newRoot.publicKey,
    body
  }))
  t.alike(second.unsignedBytes, first.unsignedBytes, 'signer contribution does not alter canonical transition bytes')
  const secondSignature = crypto.sign(multiSignedRecordSignaturePreimage({
    recordType: second.recordType,
    transitionId: second.candidateRecordId
  }), newRoot.secretKey)
  const completed = await fixture.api.submitPublisherRootOperation({
    intentId: second.intentId,
    publisherId: second.publisherId,
    recordType: second.recordType,
    unsignedBytes: second.unsignedBytes,
    candidateRecordId: second.candidateRecordId,
    displaySummaryJson: second.displaySummaryJson,
    signer: newRoot.publicKey,
    signerPublicKey: newRoot.publicKey,
    signature: secondSignature
  })
  t.is(completed.success, true)
  t.is(completed.valid, true)
  t.is(completed.complete, true)
  t.is(completed.reason, null)
  t.is(registry.appended.length, 1)
  t.is(registry.appended[0].signatures.length, 2)
  t.ok(b4a.compare(registry.appended[0].signatures[0].signerKey, registry.appended[0].signatures[1].signerKey) < 0)
  t.is(await registry.loadPendingTransition(fixture.publisherId, first.candidateRecordId), null)
})

test('recovery transition requires the new root and committed recovery quorum', async (t) => {
  const transitionState = { policyEpoch: 3, expectedSequence: 8, catalogEpoch: 4, signerPolicy: null }
  const registry = createCatalogRegistry({ rootTransitionState: transitionState })
  const fixture = createNamespaceFixture({ registry, rootSeed: 11 })
  const newRoot = crypto.keyPair(bytes(32, 120))
  const recovery = crypto.keyPair(bytes(32, 150))
  transitionState.signerPolicy = {
    requiredSignerKeys: [newRoot.publicKey],
    quorumSignerKeys: [recovery.publicKey],
    quorum: 1
  }
  const body = encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.ROOT_TRANSITION, {
    mode: 'recovery',
    previousRootKey: fixture.root.publicKey,
    newRootKey: newRoot.publicKey,
    newCatalogEpoch: 5,
    recoveryKeys: [recovery.publicKey],
    recoveryThreshold: 1,
    profileRef: b4a.alloc(0)
  })

  async function contribute(seed, signer) {
    const prepared = await fixture.api.preparePublisherRootOperation(prepareRequest(fixture, seed, {
      recordType: PUBLISHER_RECORD_TYPES.ROOT_TRANSITION,
      signerPublicKey: signer.publicKey,
      issuedAt: NOW + 5,
      body
    }))
    const signature = crypto.sign(multiSignedRecordSignaturePreimage({
      recordType: prepared.recordType,
      transitionId: prepared.candidateRecordId
    }), signer.secretKey)
    return fixture.api.submitPublisherRootOperation({
      intentId: prepared.intentId,
      publisherId: prepared.publisherId,
      recordType: prepared.recordType,
      unsignedBytes: prepared.unsignedBytes,
      candidateRecordId: prepared.candidateRecordId,
      displaySummaryJson: prepared.displaySummaryJson,
      signer: signer.publicKey,
      signerPublicKey: signer.publicKey,
      signature
    })
  }

  const partial = await contribute(50, recovery)
  t.is(partial.success, false)
  t.is(partial.valid, true)
  t.is(partial.complete, false)
  t.is(partial.reason, 'PUBLISHER_ROOT_TRANSITION_PENDING')
  const completed = await contribute(51, newRoot)
  t.is(completed.success, true)
  t.is(completed.complete, true)
  t.is(registry.appended.length, 1)
})

test('publisher registry opens lazily so unrelated API contexts remain usable', async (t) => {
  const api = publisherApiModule.createPublisherApi({ ctx: {} })
  const result = await api.provisionPublisherCatalog({
    publisherId: hex(derivePublisherId(bytes(32, 1))),
    genesisRootKey: bytes(32, 1)
  })
  t.is(result.success, false)
  t.is(result.errorCode, 'PUBLISHER_CATALOG_UNAVAILABLE')
  const malformed = await api.provisionPublisherCatalog({})
  t.is(malformed.publisherId, '', 'required wire fields stay encodable on redacted failure')
})

test('context catalog registry provision is idempotent, publisher-pinned, and restart-safe', async (t) => {
  t.is(typeof publisherApiModule.createPublisherCatalogRegistry, 'function')
  if (typeof publisherApiModule.createPublisherCatalogRegistry !== 'function') return

  const values = new Map()
  const metaDb = {
    async get(key) { return values.has(key) ? { value: values.get(key) } : null },
    async put(key, value) { values.set(key, value) },
    async del(key) { values.delete(key) }
  }
  const genesisRootKey = crypto.keyPair(bytes(32, 9)).publicKey
  const publisherId = derivePublisherId(genesisRootKey)
  const generatedKey = bytes(32, 99)
  const opens = []
  const closes = []
  const catalogFactory = (_store, options) => {
    opens.push(options.key ? b4a.from(options.key) : null)
    return {
      key: options.key ? b4a.from(options.key) : b4a.from(generatedKey),
      localWriterKey: options.key ? b4a.from(options.key) : b4a.from(generatedKey),
      async ready() {},
      async close() { closes.push(true) }
    }
  }
  const ctx = { store: {}, metaDb }
  let registryNow = NOW
  const firstRegistry = publisherApiModule.createPublisherCatalogRegistry(ctx, { catalogFactory, maxOpenCatalogs: 2, now: () => registryNow })
  const first = await firstRegistry.provision(publisherId, genesisRootKey)
  const again = await firstRegistry.provision(publisherId, genesisRootKey)
  t.alike(first.catalogBootstrapKey, generatedKey)
  t.alike(first.genesisRootKey, genesisRootKey)
  t.is(first, again, 'live provision reuses the pinned catalog')
  t.is(opens.length, 1)
  const transitionId = bytes(32, 140)
  const pending = {
    publisherId,
    transitionId,
    unsignedBytes: b4a.from([2, 3, 4]),
    expiresAt: NOW + 60_000,
    signatures: [{ signerKey: genesisRootKey, signature: bytes(64, 170) }]
  }
  await firstRegistry.savePendingTransition(pending)
  await firstRegistry.close()
  t.is(closes.length, 1)

  const restarted = publisherApiModule.createPublisherCatalogRegistry(ctx, { catalogFactory, maxOpenCatalogs: 2, now: () => registryNow })
  const reopened = await restarted.provision(publisherId, genesisRootKey)
  t.alike(reopened.catalogBootstrapKey, generatedKey)
  t.alike(reopened.genesisRootKey, genesisRootKey)
  t.alike(opens[1], generatedKey, 'restart opens the exact durably mapped bootstrap key')
  const resolved = await restarted.resolve(publisherId)
  const restoredPending = await restarted.loadPendingTransition(publisherId, transitionId)
  t.alike(restoredPending.publisherId, pending.publisherId)
  t.alike(restoredPending.transitionId, pending.transitionId)
  t.alike(restoredPending.unsignedBytes, pending.unsignedBytes)
  t.alike(restoredPending.signatures, pending.signatures)
  registryNow = pending.expiresAt
  t.is(await restarted.loadPendingTransition(publisherId, transitionId), null, 'expired durable contribution is purged')
  t.is(resolved, reopened)
  await restarted.close()
})

test('provision skips and replaces a mapped catalog whose persisted local writer is not writable', async (t) => {
  const values = new Map()
  const metaDb = {
    async get(key) { return values.has(key) ? { value: values.get(key) } : null },
    async put(key, value) { values.set(key, value) },
    async * createReadStream() {
      for (const [key, value] of values) yield { key, value }
    }
  }
  const genesisRootKey = crypto.keyPair(bytes(32, 21)).publicKey
  const publisherId = derivePublisherId(genesisRootKey)
  const publisherIdHex = b4a.toString(publisherId, 'hex')
  const mappedKey = bytes(32, 201)
  const staleWriterKey = bytes(32, 203)
  const replacementKey = bytes(32, 202)
  const mappingKey = `publisher-catalog:v1:${publisherIdHex}`
  values.set(mappingKey, {
    version: 1,
    publisherId: publisherIdHex,
    genesisRootKey: b4a.toString(genesisRootKey, 'hex'),
    catalogBootstrapKey: b4a.toString(mappedKey, 'hex')
  })

  const opens = []
  const catalogFactory = (_store, options) => {
    opens.push(options.key ? b4a.from(options.key) : null)
    return {
      key: options.key ? b4a.from(options.key) : b4a.from(replacementKey),
      localWriterKey: b4a.from(replacementKey),
      writable: true,
      async ready() {},
      async close() {}
    }
  }
  const store = {
    namespace() {
      return {
        get({ key }) {
          const bootstrap = b4a.equals(key, mappedKey)
          return {
            writable: bootstrap,
            async ready() {},
            async getUserData(name) {
              return bootstrap && name === 'autobase/local' ? staleWriterKey : null
            }
          }
        }
      }
    }
  }
  const registry = publisherApiModule.createPublisherCatalogRegistry(
    { store, metaDb },
    { catalogFactory, maxOpenCatalogs: 2 }
  )

  t.alike(await registry.getWritableBindings({ skipPublisherId: publisherId }), [])
  t.alike(opens, [], 'the target mapping is not opened as a follower before provision')
  const provisioned = await registry.provision(publisherId, genesisRootKey)

  t.alike(opens, [null], 'provision creates a new local genesis catalog')
  t.alike(provisioned.catalogBootstrapKey, replacementKey)
  t.is(values.get(mappingKey).catalogBootstrapKey, b4a.toString(replacementKey, 'hex'))
  await registry.close()
})

test('publisher catalog provision is registered on shared and mobile handler surfaces', async (t) => {
  t.ok(SHARED_HANDLER_NAMES.includes('ProvisionPublisherCatalog'))
  const calls = []
  const backend = {}
  attachMobileHandlers(backend, {
    api: {
      async provisionPublisherCatalog(request) {
        calls.push(['provision', request])
        return { success: true }
      },
      async preparePublisherRootOperation(request) {
        calls.push(['prepare', request])
        return { success: true }
      },
      async submitPublisherRootOperation(request) {
        calls.push(['submit', request])
        return { success: true }
      }
    },
    identityManager: {},
    uploadManager: {}
  })
  await backend.provisionPublisherCatalog({ publisherId: 'a'.repeat(64) })
  await backend.preparePublisherRootOperation({ intentId: '1'.repeat(32) })
  await backend.submitPublisherRootOperation({ intentId: '1'.repeat(32) })
  t.alike(calls.map(call => call[0]), ['provision', 'prepare', 'submit'])
})

test('listBindingPage paginates persisted bindings and admits/evicts under capacity', async (t) => {
  const values = new Map()
  const metaDb = {
    async get(key) { return values.has(key) ? { value: values.get(key) } : null },
    async put(key, value) { values.set(key, value) },
    async * createReadStream(options = {}) {
      const gte = options.gte || ''
      const lt = options.lt || '\xff'
      const sortedKeys = [...values.keys()].sort()
      for (const key of sortedKeys) {
        if (key >= gte && key < lt) yield { key, value: values.get(key) }
      }
    }
  }

  const closedCatalogs = []
  const catalogFactory = (_store, options) => {
    return {
      key: options.key ? b4a.from(options.key) : b4a.alloc(32, 1),
      localWriterKey: null,
      writable: false,
      async ready() {},
      async close() { closedCatalogs.push(b4a.toString(options.publisherId, 'hex')) }
    }
  }

  const publishers = []
  for (let i = 1; i <= 5; i++) {
    const rootKey = b4a.alloc(32, i)
    const pubId = derivePublisherId(rootKey)
    const pubHex = b4a.toString(pubId, 'hex')
    const bootKey = b4a.alloc(32, 100 + i)
    publishers.push({ pubId, pubHex, rootKey, bootKey })
    values.set(`publisher-catalog:v1:${pubHex}`, {
      version: 1,
      publisherId: pubHex,
      genesisRootKey: b4a.toString(rootKey, 'hex'),
      catalogBootstrapKey: b4a.toString(bootKey, 'hex')
    })
  }

  const registry = publisherApiModule.createPublisherCatalogRegistry(
    { store: {}, metaDb },
    { catalogFactory, maxOpenCatalogs: 2 }
  )

  const page1 = await registry.listBindingPage({ limit: 2 })
  t.is(page1.items.length, 2)
  t.ok(page1.nextCursor)
  await page1.release()

  const page2 = await registry.listBindingPage({ cursor: page1.nextCursor, limit: 2 })
  t.is(page2.items.length, 2)
  t.ok(page2.nextCursor)
  await page2.release()

  const page3 = await registry.listBindingPage({ cursor: page2.nextCursor, limit: 2 })
  t.is(page3.items.length, 1)
  t.is(page3.nextCursor, null)
  await page3.release()

  t.is(closedCatalogs.length, 5, 'all transiently paged catalogs were cleanly released')

  const snapshot = await registry.listBindings()
  t.is(snapshot.length, 0, 'no unowned catalogs remain in admitted-open snapshot')

  await registry.close()
})

test('listBindingPage pins current-page items and returns shorter page when remaining slots are protected', async (t) => {
  const values = new Map()
  const metaDb = {
    async get(key) { return values.has(key) ? { value: values.get(key) } : null },
    async put(key, value) { values.set(key, value) },
    async * createReadStream(options = {}) {
      const gte = options.gte || ''
      const lt = options.lt || '\xff'
      const limit = options.limit || Infinity
      const sortedKeys = [...values.keys()].sort()
      let count = 0
      for (const key of sortedKeys) {
        if (key >= gte && key < lt) {
          yield { key, value: values.get(key) }
          count++
          if (count >= limit) break
        }
      }
    }
  }

  const catalogStates = new Map()
  const writableRoot = b4a.alloc(32, 99)
  const writablePubId = derivePublisherId(writableRoot)
  const writablePubHex = b4a.toString(writablePubId, 'hex')
  const writableBoot = b4a.alloc(32, 199)
  values.set(`publisher-catalog:v1:${writablePubHex}`, {
    version: 1,
    publisherId: writablePubHex,
    genesisRootKey: b4a.toString(writableRoot, 'hex'),
    catalogBootstrapKey: b4a.toString(writableBoot, 'hex')
  })

  for (let i = 1; i <= 3; i++) {
    const rootKey = b4a.alloc(32, i)
    const pubId = derivePublisherId(rootKey)
    const pubHex = b4a.toString(pubId, 'hex')
    const bootKey = b4a.alloc(32, 100 + i)
    values.set(`publisher-catalog:v1:${pubHex}`, {
      version: 1,
      publisherId: pubHex,
      genesisRootKey: b4a.toString(rootKey, 'hex'),
      catalogBootstrapKey: b4a.toString(bootKey, 'hex')
    })
  }

  const registry = publisherApiModule.createPublisherCatalogRegistry(
    { store: {}, metaDb },
    {
      catalogFactory: (_store, options) => {
        const pubHex = b4a.toString(options.publisherId, 'hex')
        const isWritable = pubHex === writablePubHex
        const state = {
          key: options.key ? b4a.from(options.key) : b4a.alloc(32, 1),
          localWriterKey: isWritable ? b4a.alloc(32, 88) : null,
          writable: isWritable,
          closed: false,
          async ready() {},
          async close() { this.closed = true }
        }
        catalogStates.set(pubHex, state)
        return state
      },
      maxOpenCatalogs: 2
    }
  )

  await registry.resolve(writablePubId)

  const page1 = await registry.listBindingPage({ limit: 2, skipPublisherId: writablePubId })
  t.ok(page1.items.length >= 1 && page1.items.length <= 2, 'page returns a scan-bounded batch of items')
  for (const item of page1.items) {
    t.is(item.catalog.closed, false, 'returned catalog is active and not closed')
    t.is(item.transient, true, 'non-owned followers are page-leased')
  }
  t.ok(page1.nextCursor, 'scan budget advances even when skip filters reduce items')
  await page1.release()
  for (const item of page1.items) {
    t.is(item.catalog.closed, true, 'transient catalog is released on page release')
  }
  t.is(catalogStates.get(writablePubHex).closed, false, 'owned live writable catalog was never closed')

  // Walk remaining pages until exhaustion; live writable stays open.
  let cursor = page1.nextCursor
  let pages = 1
  while (cursor) {
    const page = await registry.listBindingPage({ cursor, limit: 2, skipPublisherId: writablePubId })
    pages += 1
    t.ok(pages <= 8, 'follower walk remains finite under skip filtering')
    for (const item of page.items) {
      t.is(item.catalog.closed, false, 'returned catalog on later page is active')
    }
    await page.release()
    for (const item of page.items) {
      t.is(item.catalog.closed, true, 'later-page transient released')
    }
    t.is(catalogStates.get(writablePubHex).closed, false, 'owned live writable catalog remains open')
    cursor = page.nextCursor
  }

  await registry.close()
})

test('failed resolve at capacity does not evict healthy open catalogs and leaves listBindings unchanged', async (t) => {
  const values = new Map()
  const metaDb = {
    async get(key) { return values.has(key) ? { value: values.get(key) } : null },
    async put(key, value) { values.set(key, value) },
    async * createReadStream(options = {}) {
      for (const [key, value] of values) yield { key, value }
    }
  }

  const catalogStates = new Map()
  const catalogFactory = (_store, options) => {
    const pubHex = b4a.toString(options.publisherId, 'hex')
    const state = {
      key: options.key ? b4a.from(options.key) : b4a.alloc(32, 1),
      localWriterKey: null,
      writable: false,
      closed: false,
      async ready() {},
      async close() { this.closed = true }
    }
    catalogStates.set(pubHex, state)
    return state
  }

  const pubIds = []
  for (let i = 1; i <= 2; i++) {
    const rootKey = b4a.alloc(32, i)
    const pubId = derivePublisherId(rootKey)
    const pubHex = b4a.toString(pubId, 'hex')
    const bootKey = b4a.alloc(32, 100 + i)
    pubIds.push(pubId)
    values.set(`publisher-catalog:v1:${pubHex}`, {
      version: 1,
      publisherId: pubHex,
      genesisRootKey: b4a.toString(rootKey, 'hex'),
      catalogBootstrapKey: b4a.toString(bootKey, 'hex')
    })
  }

  const registry = publisherApiModule.createPublisherCatalogRegistry(
    { store: {}, metaDb },
    { catalogFactory, maxOpenCatalogs: 2 }
  )

  await registry.resolve(pubIds[0])
  await registry.resolve(pubIds[1])

  const beforeBindings = await registry.listBindings()
  t.is(beforeBindings.length, 2)
  t.is(beforeBindings[0].catalog.closed, false)
  t.is(beforeBindings[1].catalog.closed, false)

  const unknownPublisherId = b4a.alloc(32, 255)
  await t.exception(
    registry.resolve(unknownPublisherId),
    { code: 'PUBLISHER_CATALOG_UNAVAILABLE' }
  )

  const afterBindings = await registry.listBindings()
  t.is(afterBindings.length, 2)
  t.alike(afterBindings.map(b => b.publisherId), beforeBindings.map(b => b.publisherId))
  t.is(afterBindings[0].catalog.closed, false, 'first catalog was not evicted or closed')
  t.is(afterBindings[1].catalog.closed, false, 'second catalog was not evicted or closed')

  await registry.close()
})

function createMemoryMetaDb(values = new Map()) {
  return {
    async get(key) { return values.has(key) ? { value: values.get(key) } : null },
    async put(key, value) { values.set(key, value) },
    async * createReadStream(options = {}) {
      const gte = options.gte || ''
      const lt = options.lt || '\xff'
      const sortedKeys = [...values.keys()].sort()
      for (const key of sortedKeys) {
        if (key >= gte && key < lt) yield { key, value: values.get(key) }
      }
    }
  }
}

function putCatalogMapping(values, rootSeed, bootSeed) {
  const rootKey = b4a.alloc(32, rootSeed)
  const pubId = derivePublisherId(rootKey)
  const pubHex = b4a.toString(pubId, 'hex')
  const bootKey = b4a.alloc(32, bootSeed)
  values.set(`publisher-catalog:v1:${pubHex}`, {
    version: 1,
    publisherId: pubHex,
    genesisRootKey: b4a.toString(rootKey, 'hex'),
    catalogBootstrapKey: b4a.toString(bootKey, 'hex')
  })
  return { rootKey, pubId, pubHex, bootKey }
}

test('listBindingPage writableOnly bounds scanned mappings and open handles with no matches', async (t) => {
  const values = new Map()
  values.set('publisher-catalog:v1:not-a-valid-hex-key', { version: 1 })
  values.set('publisher-catalog:v1:zzzz', { version: 1 })
  for (let i = 1; i <= 12; i++) putCatalogMapping(values, i, 40 + i)

  let liveOpens = 0
  let peakLiveOpens = 0
  let readyCalls = 0
  const catalogFactory = (_store, options) => {
    liveOpens += 1
    peakLiveOpens = Math.max(peakLiveOpens, liveOpens)
    readyCalls += 1
    return {
      key: options.key ? b4a.from(options.key) : b4a.alloc(32, 1),
      localWriterKey: null,
      writable: false,
      closed: false,
      async ready() {},
      async close() {
        this.closed = true
        liveOpens = Math.max(0, liveOpens - 1)
      }
    }
  }

  const registry = publisherApiModule.createPublisherCatalogRegistry(
    { store: {}, metaDb: createMemoryMetaDb(values) },
    { catalogFactory, maxOpenCatalogs: 3 }
  )

  let cursor = null
  let pages = 0
  let totalItems = 0
  const seenCursors = new Set()
  do {
    if (cursor) {
      t.is(seenCursors.has(cursor), false, 'continuation cursors are unique and forward-only')
      seenCursors.add(cursor)
    }
    const page = await registry.listBindingPage({ cursor, limit: 3, writableOnly: true })
    pages += 1
    totalItems += page.items.length
    t.ok(pages <= 8, 'no-match writableOnly walk stays finite over >cache mappings')
    t.is(page.items.length, 0, 'writableOnly yields no non-writable items')
    t.ok(liveOpens <= 3, 'open handles stay within the scan/page bound during writableOnly miss path')
    await page.release()
    t.is(liveOpens, 0, 'page release leaves no leftover transient opens on miss path')
    cursor = page.nextCursor
  } while (cursor)

  t.is(totalItems, 0)
  t.ok(readyCalls >= 12, 'valid mappings were probed')
  t.ok(peakLiveOpens <= 3, 'peak concurrent opens never exceeded page scan bound')
  t.is((await registry.listBindings()).length, 0, 'miss path did not admit followers into opened')
  await registry.close()
})

test('listBindingPage closes catalogs when ready throws and on reader abort', async (t) => {
  const values = new Map()
  const failing = putCatalogMapping(values, 1, 101)
  putCatalogMapping(values, 2, 102)
  putCatalogMapping(values, 3, 103)

  const states = new Map()
  const catalogFactory = (_store, options) => {
    const pubHex = b4a.toString(options.publisherId, 'hex')
    const state = {
      key: options.key ? b4a.from(options.key) : b4a.alloc(32, 1),
      localWriterKey: null,
      writable: false,
      closed: false,
      async ready() {
        if (pubHex === failing.pubHex) throw new Error('ready failed')
      },
      async close() { this.closed = true }
    }
    states.set(pubHex, state)
    return state
  }

  const registry = publisherApiModule.createPublisherCatalogRegistry(
    { store: {}, metaDb: createMemoryMetaDb(values) },
    { catalogFactory, maxOpenCatalogs: 8 }
  )

  const page = await registry.listBindingPage({ limit: 8 })
  t.is(page.items.length, 2, 'ready failure is skipped while healthy mappings still page')
  t.is(page.errors.length, 1)
  t.is(page.errors[0].key, failing.pubHex)
  t.is(states.get(failing.pubHex).closed, true, 'ready() throw closes the failed candidate')
  for (const item of page.items) t.is(item.catalog.closed, false)
  await page.release()
  for (const item of page.items) t.is(item.catalog.closed, true, 'healthy transients release cleanly after ready-error page')

  const values2 = new Map()
  for (let i = 1; i <= 6; i++) putCatalogMapping(values2, i, 120 + i)

  let openedBeforeAbort = 0
  const abortStates = []
  const ac = new AbortController()
  const abortFactory = (_store, options) => {
    const state = {
      key: options.key ? b4a.from(options.key) : b4a.alloc(32, 1),
      localWriterKey: null,
      writable: false,
      closed: false,
      async ready() {
        openedBeforeAbort += 1
        abortStates.push(state)
        if (openedBeforeAbort >= 2) ac.abort(new Error('reader aborted'))
      },
      async close() { this.closed = true }
    }
    return state
  }

  const abortRegistry = publisherApiModule.createPublisherCatalogRegistry(
    { store: {}, metaDb: createMemoryMetaDb(values2) },
    { catalogFactory: abortFactory, maxOpenCatalogs: 8 }
  )

  await t.exception(abortRegistry.listBindingPage({ limit: 8, signal: ac.signal }))
  t.ok(abortStates.length >= 2, 'abort fired after some catalogs opened')
  t.ok(abortStates.every(state => state.closed === true), 'abort releases already-opened transients')
  t.is((await abortRegistry.listBindings()).length, 0, 'abort did not admit partial opens')

  await registry.close()
  await abortRegistry.close()
})

test('getWritableBindings cold-discovers writable at full follower cache without eviction', async (t) => {
  const values = new Map()
  const followers = []
  for (let i = 1; i <= 3; i++) followers.push(putCatalogMapping(values, i, 50 + i))
  const local = putCatalogMapping(values, 99, 199)

  const states = new Map()
  const catalogFactory = (_store, options) => {
    const pubHex = b4a.toString(options.publisherId, 'hex')
    const isWritable = pubHex === local.pubHex
    const state = {
      key: options.key ? b4a.from(options.key) : b4a.alloc(32, 1),
      localWriterKey: isWritable ? b4a.alloc(32, 88) : null,
      writable: isWritable,
      closed: false,
      async ready() {},
      async close() { this.closed = true }
    }
    states.set(pubHex, state)
    return state
  }

  const registry = publisherApiModule.createPublisherCatalogRegistry(
    { store: {}, metaDb: createMemoryMetaDb(values) },
    { catalogFactory, maxOpenCatalogs: 3 }
  )

  // Fill the entire follower cache with active followers (no eviction allowed).
  for (const follower of followers) {
    const binding = await registry.resolve(follower.pubId)
    t.is(binding.catalog.closed, false)
  }
  t.is((await registry.listBindings()).length, 3, 'follower cache is full')

  // Additional follower resolve must still fail capacity without touching writables.
  const extra = putCatalogMapping(values, 4, 54)
  await t.exception(registry.resolve(extra.pubId), /PUBLISHER_CATALOG_CAPACITY|PUBLISHER_CATALOG_UNAVAILABLE/)

  for (const follower of followers) {
    t.is(states.get(follower.pubHex).closed, false, 'active follower was not evicted for capacity pressure')
  }

  const writables = await registry.getWritableBindings()
  t.is(writables.length, 1, 'cold discovery finds persisted local writable despite full follower cache')
  t.alike(writables[0].publisherId, local.pubId)
  t.is(writables[0].catalog.closed, false, 'returned writable handle is live')
  t.is(writables[0].transient, undefined, 'writable is registry-owned, not page-leased')
  t.is(states.get(local.pubHex).closed, false, 'discovered writable survived page release')

  // resolve must return the retained local writable without evicting followers.
  const resolved = await registry.resolve(local.pubId)
  t.is(resolved.catalog.closed, false)
  t.ok(resolved.catalog.writable || resolved.catalog.localWriterKey != null)
  for (const follower of followers) {
    t.is(states.get(follower.pubHex).closed, false, 'followers remain after writable resolve')
  }

  const admitted = await registry.listBindings()
  t.ok(admitted.some(b => b4a.equals(b.publisherId, local.pubId)))
  t.is(admitted.filter(b => followers.some(f => b4a.equals(f.pubId, b.publisherId))).length, 3)

  await registry.close()
})

test('listBindingPage restores more than active cache via finite pages without closing active follower', async (t) => {
  const values = new Map()
  const pubs = []
  for (let i = 1; i <= 20; i++) pubs.push(putCatalogMapping(values, i, 70 + i))

  const states = new Map()
  const catalogFactory = (_store, options) => {
    const pubHex = b4a.toString(options.publisherId, 'hex')
    const state = {
      key: options.key ? b4a.from(options.key) : b4a.alloc(32, 1),
      localWriterKey: null,
      writable: false,
      closed: false,
      async ready() {},
      async close() { this.closed = true }
    }
    states.set(pubHex, state)
    return state
  }

  const registry = publisherApiModule.createPublisherCatalogRegistry(
    { store: {}, metaDb: createMemoryMetaDb(values) },
    { catalogFactory, maxOpenCatalogs: 3 }
  )

  const active = await registry.resolve(pubs[0].pubId)
  t.is(active.catalog.closed, false)

  let cursor = null
  let seen = 0
  let pages = 0
  do {
    const page = await registry.listBindingPage({ cursor, limit: 3 })
    pages += 1
    seen += page.items.length
    t.ok(pages <= 12, 'full persisted walk stays page-bounded')
    for (const item of page.items) {
      t.is(item.catalog.closed, false, 'page items remain usable until release')
    }
    await page.release()
    t.is(active.catalog.closed, false, 'active follower remains usable across paging')
    cursor = page.nextCursor
  } while (cursor)

  t.is(seen, 20, 'full persisted mapping set is reachable across pages')
  t.is((await registry.listBindings()).length, 1, 'only the actively resolved follower remains admitted')
  t.is(active.catalog.closed, false)

  await registry.close()
})
