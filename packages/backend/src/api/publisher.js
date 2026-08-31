import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  attachMultiSignedEnvelopeSignatures,
  attachSignedEnvelopeSignature,
  decodeUnsignedMultiSignedEnvelope,
  decodeUnsignedSignedEnvelope,
  encodeUnsignedMultiSignedEnvelope,
  encodeUnsignedSignedEnvelope,
  multiSignedRecordSignaturePreimage,
  signedRecordSignaturePreimage,
  verifyMultiSignedEnvelope
} from '../records/index.js'
import {
  PUBLISHER_RECORD_TYPES,
  decodePublisherOperationBody
} from '../publisher/canonical.js'
import { PublisherCatalog } from '../publisher/catalog.js'
import {
  decodePublisherNamespaceDescriptor,
  derivePublisherId,
  encodePublisherNamespaceDescriptor,
  verifyPublisherNamespaceDescriptor
} from '../publisher/namespace.js'
import { verifyPublisherNamespaceProof } from '../publisher/namespace-proof.js'

const MAX_INTENT_TTL_MS = 5 * 60_000
const DEFAULT_MAX_INTENTS = 128
const MAX_INTENTS_LIMIT = 1_024
const DEFAULT_MAX_OPEN_CATALOGS = 32
const MAX_OPEN_CATALOGS_LIMIT = 64
const MAX_PENDING_TRANSITIONS = 32
const MAX_PENDING_UNSIGNED_BYTES = 1_048_576
const MAX_PENDING_SIGNATURES = 16
const PENDING_TRANSITION_TTL_MS = 10 * 60_000
const MAX_DISPLAY_SUMMARY_BYTES = 4_096
const CATALOG_MAPPING_PREFIX = 'publisher-catalog:v1:'
const PENDING_TRANSITIONS_KEY = 'publisher-root-transitions:v1'

class PublisherApiError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function fail(code) {
  throw new PublisherApiError(code)
}

function stableCode(error, fallback) {
  return error instanceof PublisherApiError ? error.code : fallback
}

function isBytes(value) {
  return b4a.isBuffer(value) || value instanceof Uint8Array
}

function exactBytes(value, length, code = 'PUBLISHER_REQUEST_INVALID') {
  if (!isBytes(value) || value.byteLength !== length) fail(code)
  return b4a.from(value)
}

function variableBytes(value, code = 'PUBLISHER_REQUEST_INVALID') {
  if (!isBytes(value)) fail(code)
  return b4a.from(value)
}

function equalBytes(left, right) {
  return isBytes(left) && isBytes(right) && b4a.equals(left, right)
}

function publisherHex(publisherId) {
  return b4a.toString(publisherId, 'hex')
}

function parsePublisherId(value, code = 'PUBLISHER_REQUEST_INVALID') {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(code)
  return b4a.from(value, 'hex')
}

function parseIntentId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) fail('PUBLISHER_INTENT_INVALID')
  return value
}

function safeUint(value, code = 'PUBLISHER_REQUEST_INVALID') {
  if (!Number.isSafeInteger(value) || value < 0) fail(code)
  return value
}

function normalizeDisplaySummaryJson(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || b4a.byteLength(value) > MAX_DISPLAY_SUMMARY_BYTES) fail('PUBLISHER_SUMMARY_INVALID')
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    fail('PUBLISHER_SUMMARY_INVALID')
  }
  const normalized = JSON.stringify(parsed)
  if (typeof normalized !== 'string' || b4a.byteLength(normalized) > MAX_DISPLAY_SUMMARY_BYTES) fail('PUBLISHER_SUMMARY_INVALID')
  return normalized
}

function clonePolicy(policy) {
  if (!policy || !Array.isArray(policy.requiredSignerKeys) || !Array.isArray(policy.quorumSignerKeys)) {
    fail('PUBLISHER_ROOT_AUTHORIZATION_INVALID')
  }
  const quorum = safeUint(policy.quorum, 'PUBLISHER_ROOT_AUTHORIZATION_INVALID')
  const requiredSignerKeys = policy.requiredSignerKeys.map(value => exactBytes(value, 32, 'PUBLISHER_ROOT_AUTHORIZATION_INVALID'))
  const quorumSignerKeys = policy.quorumSignerKeys.map(value => exactBytes(value, 32, 'PUBLISHER_ROOT_AUTHORIZATION_INVALID'))
  if (requiredSignerKeys.length + quorumSignerKeys.length > MAX_PENDING_SIGNATURES || quorum > quorumSignerKeys.length) {
    fail('PUBLISHER_ROOT_AUTHORIZATION_INVALID')
  }
  const seen = new Set()
  for (const signerKey of [...requiredSignerKeys, ...quorumSignerKeys]) {
    const id = publisherHex(signerKey)
    if (seen.has(id)) fail('PUBLISHER_ROOT_AUTHORIZATION_INVALID')
    seen.add(id)
  }
  return { requiredSignerKeys, quorumSignerKeys, quorum }
}

function cloneRootAuthorization(value) {
  if (!value || typeof value !== 'object') fail('PUBLISHER_ROOT_AUTHORIZATION_INVALID')
  return {
    publisherId: exactBytes(value.publisherId, 32, 'PUBLISHER_ROOT_AUTHORIZATION_INVALID'),
    activeRootKey: exactBytes(value.activeRootKey, 32, 'PUBLISHER_ROOT_AUTHORIZATION_INVALID'),
    policyEpoch: safeUint(value.policyEpoch, 'PUBLISHER_ROOT_AUTHORIZATION_INVALID'),
    expectedSequence: safeUint(value.expectedSequence, 'PUBLISHER_ROOT_AUTHORIZATION_INVALID'),
    catalogEpoch: safeUint(value.catalogEpoch, 'PUBLISHER_ROOT_AUTHORIZATION_INVALID'),
    signerPolicy: clonePolicy(value.signerPolicy)
  }
}

function sortedHexKeys(values) {
  return values.map(publisherHex).sort()
}

function equalRootAuthorization(left, right) {
  if (!left || !right) return false
  return equalBytes(left.publisherId, right.publisherId) &&
    equalBytes(left.activeRootKey, right.activeRootKey) &&
    left.policyEpoch === right.policyEpoch &&
    left.expectedSequence === right.expectedSequence &&
    left.catalogEpoch === right.catalogEpoch &&
    left.signerPolicy.quorum === right.signerPolicy.quorum &&
    JSON.stringify(sortedHexKeys(left.signerPolicy.requiredSignerKeys)) === JSON.stringify(sortedHexKeys(right.signerPolicy.requiredSignerKeys)) &&
    JSON.stringify(sortedHexKeys(left.signerPolicy.quorumSignerKeys)) === JSON.stringify(sortedHexKeys(right.signerPolicy.quorumSignerKeys))
}

function policySignerKind(policy, signerKey) {
  if (policy.requiredSignerKeys.some(value => equalBytes(value, signerKey))) return 'required'
  if (policy.quorumSignerKeys.some(value => equalBytes(value, signerKey))) return 'quorum'
  return null
}

function policyIsComplete(policy, signatures) {
  const present = new Set(signatures.map(entry => publisherHex(entry.signerKey)))
  if (!policy.requiredSignerKeys.every(value => present.has(publisherHex(value)))) return false
  let quorumCount = 0
  for (const value of policy.quorumSignerKeys) if (present.has(publisherHex(value))) quorumCount++
  return quorumCount === policy.quorum
}

function cloneBinding(binding, expectedPublisherId = null) {
  if (!binding || typeof binding !== 'object' || !binding.catalog) fail('PUBLISHER_CATALOG_UNAVAILABLE')
  const publisherId = exactBytes(binding.publisherId, 32, 'PUBLISHER_CATALOG_UNAVAILABLE')
  const genesisRootKey = exactBytes(binding.genesisRootKey, 32, 'PUBLISHER_CATALOG_UNAVAILABLE')
  const catalogBootstrapKey = exactBytes(binding.catalogBootstrapKey || binding.catalog?.key, 32, 'PUBLISHER_CATALOG_UNAVAILABLE')
  if (expectedPublisherId && !equalBytes(publisherId, expectedPublisherId)) fail('PUBLISHER_CATALOG_MISMATCH')
  if (!equalBytes(binding.catalog?.key, catalogBootstrapKey)) fail('PUBLISHER_CATALOG_MISMATCH')
  return { ...binding, publisherId, genesisRootKey, catalogBootstrapKey }
}

function catalogMappingKey(publisherId) {
  return `${CATALOG_MAPPING_PREFIX}${publisherHex(publisherId)}`
}

function decodeCatalogMapping(value, expectedPublisherId) {
  if (!value || value.version !== 1 || value.publisherId !== publisherHex(expectedPublisherId) ||
      typeof value.genesisRootKey !== 'string' || !/^[0-9a-f]{64}$/.test(value.genesisRootKey) ||
      typeof value.catalogBootstrapKey !== 'string' || !/^[0-9a-f]{64}$/.test(value.catalogBootstrapKey)) {
    fail('PUBLISHER_CATALOG_MAPPING_INVALID')
  }
  const genesisRootKey = b4a.from(value.genesisRootKey, 'hex')
  if (!equalBytes(derivePublisherId(genesisRootKey), expectedPublisherId)) fail('PUBLISHER_CATALOG_MAPPING_INVALID')
  return {
    publisherId: b4a.from(expectedPublisherId),
    genesisRootKey,
    catalogBootstrapKey: b4a.from(value.catalogBootstrapKey, 'hex')
  }
}

function assertSortedPendingSignatures(signatures) {
  let previous = null
  for (const entry of signatures) {
    if (previous && previous >= entry.signerKey) fail('PUBLISHER_PENDING_INVALID')
    previous = entry.signerKey
  }
}

function serializePendingTransition(value) {
  const publisherId = exactBytes(value.publisherId, 32, 'PUBLISHER_PENDING_INVALID')
  const transitionId = exactBytes(value.transitionId, 32, 'PUBLISHER_PENDING_INVALID')
  const unsignedBytes = variableBytes(value.unsignedBytes, 'PUBLISHER_PENDING_INVALID')
  const expiresAt = safeUint(value.expiresAt, 'PUBLISHER_PENDING_INVALID')
  if (unsignedBytes.byteLength === 0 || unsignedBytes.byteLength > MAX_PENDING_UNSIGNED_BYTES ||
      !Array.isArray(value.signatures) || value.signatures.length < 1 || value.signatures.length > MAX_PENDING_SIGNATURES) {
    fail('PUBLISHER_PENDING_INVALID')
  }
  const signatures = value.signatures.map(entry => ({
    signerKey: publisherHex(exactBytes(entry?.signerKey, 32, 'PUBLISHER_PENDING_INVALID')),
    signature: b4a.toString(exactBytes(entry?.signature, 64, 'PUBLISHER_PENDING_INVALID'), 'hex')
  }))
  assertSortedPendingSignatures(signatures)
  return {
    publisherId: publisherHex(publisherId),
    transitionId: publisherHex(transitionId),
    unsignedBytes: b4a.toString(unsignedBytes, 'hex'),
    expiresAt,
    signatures
  }
}

function deserializePendingTransition(value) {
  if (!value || typeof value.publisherId !== 'string' || !/^[0-9a-f]{64}$/.test(value.publisherId) ||
      typeof value.transitionId !== 'string' || !/^[0-9a-f]{64}$/.test(value.transitionId) ||
      typeof value.unsignedBytes !== 'string' || value.unsignedBytes.length === 0 ||
      value.unsignedBytes.length > MAX_PENDING_UNSIGNED_BYTES * 2 || !/^(?:[0-9a-f]{2})*$/.test(value.unsignedBytes) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0 || !Array.isArray(value.signatures) ||
      value.signatures.length < 1 || value.signatures.length > MAX_PENDING_SIGNATURES) {
    fail('PUBLISHER_PENDING_INVALID')
  }
  const signatures = value.signatures.map(entry => {
    if (!entry || typeof entry.signerKey !== 'string' || !/^[0-9a-f]{64}$/.test(entry.signerKey) ||
        typeof entry.signature !== 'string' || !/^[0-9a-f]{128}$/.test(entry.signature)) {
      fail('PUBLISHER_PENDING_INVALID')
    }
    return { signerKey: b4a.from(entry.signerKey, 'hex'), signature: b4a.from(entry.signature, 'hex') }
  })
  assertSortedPendingSignatures(value.signatures)
  return {
    publisherId: b4a.from(value.publisherId, 'hex'),
    transitionId: b4a.from(value.transitionId, 'hex'),
    unsignedBytes: b4a.from(value.unsignedBytes, 'hex'),
    expiresAt: value.expiresAt,
    signatures
  }
}

function clonePendingTransition(value) {
  return {
    publisherId: b4a.from(value.publisherId),
    transitionId: b4a.from(value.transitionId),
    unsignedBytes: b4a.from(value.unsignedBytes),
    expiresAt: value.expiresAt,
    signatures: value.signatures.map(entry => ({ signerKey: b4a.from(entry.signerKey), signature: b4a.from(entry.signature) }))
  }
}

/**
 * Durable, publisher-pinned catalog discovery plus bounded transition state.
 * Catalog root secrets never enter this registry.
 */
export function createPublisherCatalogRegistry(ctx, options = {}) {
  if (!ctx?.store || typeof ctx?.metaDb?.get !== 'function' || typeof ctx?.metaDb?.put !== 'function') {
    fail('PUBLISHER_CATALOG_REGISTRY_UNAVAILABLE')
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxOpenCatalogs = options.maxOpenCatalogs ?? DEFAULT_MAX_OPEN_CATALOGS
  if (!Number.isSafeInteger(maxOpenCatalogs) || maxOpenCatalogs < 1 || maxOpenCatalogs > MAX_OPEN_CATALOGS_LIMIT) {
    fail('PUBLISHER_CATALOG_REGISTRY_INVALID')
  }
  const catalogFactory = typeof options.catalogFactory === 'function'
    ? options.catalogFactory
    : (store, catalogOptions) => new PublisherCatalog(store, catalogOptions)
  const deviceSigner = options.deviceSigner || null
  const opened = new Map()
  const opening = new Map()
  let closed = false
  let pendingMutation = Promise.resolve()

  async function openCatalog(publisherId, { genesisRootKey = null, create = false, catalogBootstrapKey = null, namespaceDescriptor = null } = {}) {
    if (closed) fail('PUBLISHER_CATALOG_REGISTRY_CLOSED')
    const id = publisherHex(publisherId)
    const requestedKey = catalogBootstrapKey ? exactBytes(catalogBootstrapKey, 32, 'PUBLISHER_CATALOG_MISMATCH') : null
    const cached = opened.get(id)
    if (cached) {
      if (genesisRootKey && !equalBytes(cached.genesisRootKey, genesisRootKey)) fail('PUBLISHER_CATALOG_MISMATCH')
      if (requestedKey && !equalBytes(cached.catalogBootstrapKey, requestedKey)) fail('PUBLISHER_CATALOG_MISMATCH')
      return cached
    }
    if (opening.has(id)) {
      const binding = await opening.get(id)
      if (genesisRootKey && !equalBytes(binding.genesisRootKey, genesisRootKey)) fail('PUBLISHER_CATALOG_MISMATCH')
      if (requestedKey && !equalBytes(binding.catalogBootstrapKey, requestedKey)) fail('PUBLISHER_CATALOG_MISMATCH')
      return binding
    }
    if (opened.size + opening.size >= maxOpenCatalogs) fail('PUBLISHER_CATALOG_CAPACITY')

    const task = (async () => {
      const mappingEntry = await ctx.metaDb.get(catalogMappingKey(publisherId))
      let mapping = mappingEntry?.value ? decodeCatalogMapping(mappingEntry.value, publisherId) : null
      if (!mapping && !create) fail('PUBLISHER_CATALOG_UNAVAILABLE')
      if (mapping && genesisRootKey && !equalBytes(mapping.genesisRootKey, genesisRootKey)) fail('PUBLISHER_CATALOG_MISMATCH')
      if (mapping && requestedKey && !equalBytes(mapping.catalogBootstrapKey, requestedKey)) fail('PUBLISHER_CATALOG_MISMATCH')
      if (!mapping) {
        if (!genesisRootKey || !equalBytes(derivePublisherId(genesisRootKey), publisherId)) fail('PUBLISHER_ID_MISMATCH')
        mapping = {
          publisherId: b4a.from(publisherId),
          genesisRootKey: b4a.from(genesisRootKey),
          catalogBootstrapKey: requestedKey ? b4a.from(requestedKey) : null
        }
      }

      const catalogOptions = { publisherId: b4a.from(publisherId) }
      if (deviceSigner) catalogOptions.deviceSigner = deviceSigner
      if (mapping.catalogBootstrapKey) catalogOptions.key = b4a.from(mapping.catalogBootstrapKey)
      const catalog = catalogFactory(ctx.store, catalogOptions)
      try {
        if (!catalog || typeof catalog.ready !== 'function') fail('PUBLISHER_CATALOG_UNAVAILABLE')
        await catalog.ready()
        const openedKey = exactBytes(catalog.key, 32, 'PUBLISHER_CATALOG_UNAVAILABLE')
        if (mapping.catalogBootstrapKey && !equalBytes(mapping.catalogBootstrapKey, openedKey)) {
          fail('PUBLISHER_CATALOG_MISMATCH')
        }
        if (!mapping.catalogBootstrapKey) mapping.catalogBootstrapKey = b4a.from(openedKey)
        if (!mappingEntry?.value) {
          await ctx.metaDb.put(catalogMappingKey(publisherId), {
            version: 1,
            publisherId: id,
            genesisRootKey: publisherHex(mapping.genesisRootKey),
            catalogBootstrapKey: publisherHex(mapping.catalogBootstrapKey)
          })
        }
        const binding = {
          catalog,
          publisherId: b4a.from(publisherId),
          genesisRootKey: b4a.from(mapping.genesisRootKey),
          catalogBootstrapKey: b4a.from(mapping.catalogBootstrapKey),
          ...(namespaceDescriptor ? { namespaceDescriptor } : {})
        }
        opened.set(id, binding)
        return binding
      } catch (error) {
        try { await catalog?.close?.() } catch { /* preserve the stable original failure */ }
        throw error
      }
    })()
    opening.set(id, task)
    try {
      return await task
    } finally {
      opening.delete(id)
    }
  }

  function mutatePending(operation) {
    const result = pendingMutation.then(operation, operation)
    pendingMutation = result.catch(() => {})
    return result
  }

  async function loadPendingList() {
    const entry = await ctx.metaDb.get(PENDING_TRANSITIONS_KEY)
    const raw = entry?.value
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw) || raw.length > MAX_PENDING_TRANSITIONS) fail('PUBLISHER_PENDING_INVALID')
    return raw.map(deserializePendingTransition)
  }

  async function storePendingList(values) {
    await ctx.metaDb.put(PENDING_TRANSITIONS_KEY, values.map(serializePendingTransition))
  }

  async function purgePending(values) {
    const currentTime = safeUint(now(), 'PUBLISHER_PENDING_INVALID')
    return values.filter(value => value.expiresAt > currentTime)
  }

  return {
    async provision(publisherIdValue, genesisRootKeyValue) {
      const publisherId = exactBytes(publisherIdValue, 32, 'PUBLISHER_REQUEST_INVALID')
      const genesisRootKey = exactBytes(genesisRootKeyValue, 32, 'PUBLISHER_REQUEST_INVALID')
      if (!equalBytes(derivePublisherId(genesisRootKey), publisherId)) fail('PUBLISHER_ID_MISMATCH')
      return openCatalog(publisherId, { genesisRootKey, create: true })
    },
    async bindNamespace(descriptorValue, { verifiedNamespaceProof = null } = {}) {
      let descriptor
      try {
        descriptor = verifyPublisherNamespaceDescriptor(descriptorValue).descriptor
      } catch {
        fail('PUBLISHER_NAMESPACE_INVALID')
      }
      const publisherId = exactBytes(descriptor.publisherId, 32, 'PUBLISHER_NAMESPACE_INVALID')
      const catalogBootstrapKey = exactBytes(descriptor.catalogBootstrapKey, 32, 'PUBLISHER_NAMESPACE_INVALID')
      let genesisRootKey = descriptor.publisherRootKey
      if (descriptor.catalogEpoch > 0) {
        if (!verifiedNamespaceProof) fail('PUBLISHER_NAMESPACE_TRANSITION_UNVERIFIED')
        try {
          const verified = verifyPublisherNamespaceProof({
            locator: {
              publisherId: publisherHex(publisherId),
              catalogBootstrapKey: publisherHex(catalogBootstrapKey),
              catalogEpoch: descriptor.catalogEpoch,
            },
            descriptor,
            ...verifiedNamespaceProof,
          })
          const genesisDescriptor = decodePublisherNamespaceDescriptor(verified.genesis?.canonicalBody || verifiedNamespaceProof.genesis.canonicalBody)
          genesisRootKey = genesisDescriptor.publisherRootKey
        } catch {
          fail('PUBLISHER_NAMESPACE_TRANSITION_UNVERIFIED')
        }
      }
      genesisRootKey = exactBytes(genesisRootKey, 32, 'PUBLISHER_NAMESPACE_INVALID')
      const binding = await openCatalog(publisherId, {
        genesisRootKey,
        create: true,
        catalogBootstrapKey,
      })
      const current = binding.namespaceDescriptor || null
      if (current) {
        if (descriptor.catalogEpoch < current.catalogEpoch) fail('PUBLISHER_NAMESPACE_EPOCH_STALE')
        if (descriptor.catalogEpoch === current.catalogEpoch &&
            !equalBytes(encodePublisherNamespaceDescriptor(descriptor), encodePublisherNamespaceDescriptor(current))) {
          fail('PUBLISHER_NAMESPACE_EPOCH_CONFLICT')
        }
        if (descriptor.catalogEpoch > current.catalogEpoch + 1) fail('PUBLISHER_NAMESPACE_EPOCH_SKIP')
      }
      binding.namespaceDescriptor = descriptor
      return binding
    },


    async resolve(publisherIdValue) {
      const publisherId = exactBytes(publisherIdValue, 32, 'PUBLISHER_REQUEST_INVALID')
      return openCatalog(publisherId)
    },
    async release(publisherIdValue) {
      const publisherId = exactBytes(publisherIdValue, 32, 'PUBLISHER_REQUEST_INVALID')
      const id = publisherHex(publisherId)
      if (opening.has(id)) await opening.get(id)
      const binding = opened.get(id)
      if (!binding) return false
      opened.delete(id)
      await binding.catalog?.close?.()
      return true
    },


    async loadPendingTransition(publisherIdValue, transitionIdValue) {
      const publisherId = exactBytes(publisherIdValue, 32, 'PUBLISHER_REQUEST_INVALID')
      const transitionId = exactBytes(transitionIdValue, 32, 'PUBLISHER_REQUEST_INVALID')
      return mutatePending(async () => {
        const original = await loadPendingList()
        const values = await purgePending(original)
        if (values.length !== original.length) await storePendingList(values)
        const found = values.find(value => equalBytes(value.publisherId, publisherId) && equalBytes(value.transitionId, transitionId))
        return found ? clonePendingTransition(found) : null
      })
    },

    async savePendingTransition(value) {
      const pending = deserializePendingTransition(serializePendingTransition(value))
      const currentTime = safeUint(now(), 'PUBLISHER_PENDING_INVALID')
      if (pending.expiresAt <= currentTime ||
          currentTime > Number.MAX_SAFE_INTEGER - PENDING_TRANSITION_TTL_MS ||
          pending.expiresAt > currentTime + PENDING_TRANSITION_TTL_MS) {
        fail('PUBLISHER_PENDING_INVALID')
      }
      return mutatePending(async () => {
        let values = await purgePending(await loadPendingList())
        const index = values.findIndex(entry => equalBytes(entry.publisherId, pending.publisherId) && equalBytes(entry.transitionId, pending.transitionId))
        if (index === -1) {
          if (values.length >= MAX_PENDING_TRANSITIONS) fail('PUBLISHER_PENDING_CAPACITY')
          values.push(pending)
        } else {
          values[index] = pending
        }
        values.sort((left, right) => {
          const publisherOrder = b4a.compare(left.publisherId, right.publisherId)
          return publisherOrder || b4a.compare(left.transitionId, right.transitionId)
        })
        await storePendingList(values)
        return clonePendingTransition(pending)
      })
    },

    async deletePendingTransition(publisherIdValue, transitionIdValue) {
      const publisherId = exactBytes(publisherIdValue, 32, 'PUBLISHER_REQUEST_INVALID')
      const transitionId = exactBytes(transitionIdValue, 32, 'PUBLISHER_REQUEST_INVALID')
      return mutatePending(async () => {
        const values = (await purgePending(await loadPendingList()))
          .filter(value => !equalBytes(value.publisherId, publisherId) || !equalBytes(value.transitionId, transitionId))
        await storePendingList(values)
      })
    },

    async listBindings() {
      if (closed) fail('PUBLISHER_CATALOG_REGISTRY_CLOSED')
      if (typeof ctx.metaDb.createReadStream === 'function') {
        const tasks = []
        for await (const entry of ctx.metaDb.createReadStream({
          gte: CATALOG_MAPPING_PREFIX,
          lt: `${CATALOG_MAPPING_PREFIX}\xff`,
          limit: maxOpenCatalogs + 1
        })) {
          if (tasks.length >= maxOpenCatalogs) fail('PUBLISHER_CATALOG_CAPACITY')
          const id = String(entry.key).slice(CATALOG_MAPPING_PREFIX.length)
          if (!/^[0-9a-f]{64}$/.test(id)) fail('PUBLISHER_CATALOG_MAPPING_INVALID')
          const publisherId = b4a.from(id, 'hex')
          const mapping = decodeCatalogMapping(entry.value, publisherId)
          tasks.push(openCatalog(publisherId, {
            genesisRootKey: mapping.genesisRootKey,
            catalogBootstrapKey: mapping.catalogBootstrapKey
          }))
        }
        await Promise.all(tasks)
      }
      return [...opened.values()]
        .sort((left, right) => b4a.compare(left.publisherId, right.publisherId))
        .map(binding => ({ ...binding }))
    },

    async getWritableBindings() {
      const bindings = await this.listBindings()
      return bindings.filter(binding => binding.catalog?.writable || binding.catalog?.localWriterKey != null)
    },

    async close() {
      if (closed) return
      closed = true
      await Promise.allSettled([...opening.values()])
      const bindings = [...opened.values()]
      opened.clear()
      for (const binding of bindings) {
        try { await binding.catalog?.close?.() } catch { /* close every catalog */ }
      }
    }
  }
}

function emptyPrepareResponse(request, code) {
  return {
    intentId: typeof request?.intentId === 'string' ? request.intentId : '',
    success: false,
    publisherId: typeof request?.publisherId === 'string' ? request.publisherId : null,
    recordType: typeof request?.recordType === 'string' ? request.recordType : null,
    unsignedBytes: b4a.alloc(0),
    candidateRecordId: b4a.alloc(0),
    signerPublicKey: b4a.alloc(0),
    bodyLength: 0,
    issuedAt: 0,
    expiresAt: 0,
    intentExpiresAt: 0,
    displaySummaryJson: null,
    error: code
  }
}

function emptySubmitResponse(request, reason, valid = false, extra = {}) {
  return {
    intentId: typeof request?.intentId === 'string' ? request.intentId : '',
    success: false,
    valid,
    complete: false,
    reason,
    publisherId: typeof request?.publisherId === 'string' ? request.publisherId : null,
    recordType: typeof request?.recordType === 'string' ? request.recordType : null,
    recordId: b4a.alloc(0),
    signer: b4a.alloc(0),
    signerPublicKey: b4a.alloc(0),
    signature: b4a.alloc(0),
    ...extra
  }
}

function validateReceipt(receipt, candidateRecordId) {
  if (!receipt || !equalBytes(receipt.operationId, candidateRecordId)) fail('PUBLISHER_CATALOG_RECEIPT_INVALID')
  if (receipt.accepted !== true) fail('PUBLISHER_CATALOG_REJECTED')
}

async function getExistingReceipt(catalog, candidateRecordId) {
  if (typeof catalog?.getOperationReceipt !== 'function') fail('PUBLISHER_CATALOG_RECEIPT_UNAVAILABLE')
  const receipt = await catalog.getOperationReceipt(candidateRecordId)
  if (!receipt || typeof receipt.accepted !== 'boolean') fail('PUBLISHER_CATALOG_RECEIPT_INVALID')
  if (receipt.operationId !== undefined && !equalBytes(receipt.operationId, candidateRecordId)) {
    fail('PUBLISHER_CATALOG_RECEIPT_INVALID')
  }
  return receipt.accepted === true || typeof receipt.rejectionCode === 'string' ? receipt : null
}

async function appendAndConfirm(catalog, envelope, candidateRecordId, options = {}) {
  if (typeof catalog?.appendAndConfirm !== 'function') fail('PUBLISHER_CATALOG_RECEIPT_UNAVAILABLE')
  const receipt = await catalog.appendAndConfirm(envelope, options)
  validateReceipt(receipt, candidateRecordId)
}

function validateRootTransitionBody(body, authorization, publisherId) {
  if (!equalBytes(authorization.publisherId, publisherId) ||
      !equalBytes(body.previousRootKey, authorization.activeRootKey) ||
      body.newCatalogEpoch !== authorization.catalogEpoch + 1) {
    fail('PUBLISHER_ROOT_AUTHORIZATION_STALE')
  }
}

async function getRootAuthorization(binding, recordType, body) {
  let value
  try {
    if (recordType === PUBLISHER_RECORD_TYPES.ROOT_TRANSITION) {
      if (typeof binding.catalog?.getRootTransitionAuthorization !== 'function') fail('PUBLISHER_ROOT_AUTHORIZATION_UNAVAILABLE')
      value = await binding.catalog.getRootTransitionAuthorization({ mode: body.mode, newRootKey: b4a.from(body.newRootKey) })
    } else {
      if (typeof binding.catalog?.getRootOperationAuthorization !== 'function') fail('PUBLISHER_ROOT_AUTHORIZATION_UNAVAILABLE')
      value = await binding.catalog.getRootOperationAuthorization({ recordType, body })
    }
  } catch (error) {
    if (error instanceof PublisherApiError) throw error
    fail('PUBLISHER_ROOT_AUTHORIZATION_UNAVAILABLE')
  }
  const authorization = cloneRootAuthorization(value)
  if (!equalBytes(authorization.publisherId, binding.publisherId)) fail('PUBLISHER_ROOT_AUTHORIZATION_STALE')
  if (recordType === PUBLISHER_RECORD_TYPES.ROOT_TRANSITION) {
    validateRootTransitionBody(body, authorization, binding.publisherId)
  } else if (authorization.signerPolicy.requiredSignerKeys.length !== 1 ||
      !equalBytes(authorization.signerPolicy.requiredSignerKeys[0], authorization.activeRootKey) ||
      authorization.signerPolicy.quorumSignerKeys.length !== 0 ||
      authorization.signerPolicy.quorum !== 0) {
    fail('PUBLISHER_ROOT_AUTHORIZATION_INVALID')
  }
  return authorization
}

export function createPublisherApi(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ctx = options.ctx || null
  const maxIntents = options.maxIntents ?? DEFAULT_MAX_INTENTS
  if (!Number.isSafeInteger(maxIntents) || maxIntents < 1 || maxIntents > MAX_INTENTS_LIMIT) {
    throw new TypeError('publisher API maxIntents is out of bounds')
  }
  let catalogRegistry = options.catalogRegistry || null
  let registryOwned = false
  const intents = new Map()
  const activeSubmissions = new Set()

  function consumeIntent(value) {
    let id
    try {
      id = parseIntentId(value)
    } catch {
      return null
    }
    const intent = intents.get(id) || null
    if (intent) intents.delete(id)
    return intent
  }

  function purgeExpiredIntents(currentTime) {
    for (const [id, intent] of intents) if (currentTime >= intent.intentExpiresAt) intents.delete(id)
  }

  function activeCatalogRegistry() {
    if (catalogRegistry) return catalogRegistry
    if (!options.ctx?.store || !options.ctx?.metaDb) fail('PUBLISHER_CATALOG_UNAVAILABLE')
    try {
      catalogRegistry = createPublisherCatalogRegistry(options.ctx, { now, maxOpenCatalogs: options.maxOpenCatalogs })
    } catch {
      fail('PUBLISHER_CATALOG_UNAVAILABLE')
    }
    if (!registryOwned) {
      registryOwned = true
      options.ctx?.ownResource?.('publisher catalog registry', catalogRegistry, 'close', 5_000)
        || options.ctx?.lifecycle?.ownResource?.('publisher catalog registry', catalogRegistry, 'close', 5_000)
    }
    return catalogRegistry
  }

  async function resolveBinding(publisherId) {
    const registry = activeCatalogRegistry()
    if (typeof registry.resolve !== 'function') fail('PUBLISHER_CATALOG_UNAVAILABLE')
    let binding
    try {
      binding = await registry.resolve(publisherId)
    } catch (error) {
      if (error instanceof PublisherApiError) throw error
      fail('PUBLISHER_CATALOG_UNAVAILABLE')
    }
    return cloneBinding(binding, publisherId)
  }

  async function localCatalogState(binding, publisherId) {
    const catalog = binding?.catalog
    if (!catalog || typeof catalog.getAuthorizationState !== 'function') {
      fail('PUBLISHER_CATALOG_UNAVAILABLE')
    }
    if (typeof catalog.waitForWritable === 'function') {
      await catalog.waitForWritable(1000).catch(() => {})
    }
    const localWriterKey = exactBytes(catalog.localWriterKey, 32, 'PUBLISHER_LOCAL_WRITER_UNAVAILABLE')
    const localSignerKey = exactBytes(catalog.localSignerKey, 32, 'PUBLISHER_LOCAL_SIGNER_UNAVAILABLE')
    const authorization = await catalog.getAuthorizationState()
    const writerKeyHex = publisherHex(localWriterKey)
    const signerKeyHex = publisherHex(localSignerKey)
    const writer = authorization?.writers?.find(candidate =>
      candidate?.key === writerKeyHex && candidate?.signerKey === signerKeyHex
    )
    const capabilities = writer?.capabilities
    const admitted = Boolean(
      writer &&
      !writer.revocation &&
      Number.isSafeInteger(writer.expiresAt) &&
      writer.expiresAt >= safeUint(now()) &&
      Array.isArray(capabilities) &&
      capabilities.includes('publish') &&
      capabilities.includes('claim')
    )
    return {
      publisherId: b4a.from(publisherId),
      localWriterKey,
      localSignerKey,
      writable: true,
      namespaceInitialized: Boolean(authorization),
      admitted
    }
  }

  async function assertOnlyWritableBinding(registry, publisherId) {
    if (typeof registry.getWritableBindings !== 'function') fail('PUBLISHER_CATALOG_UNAVAILABLE')
    const bindings = await registry.getWritableBindings()
    if (!Array.isArray(bindings) || !bindings.some(candidate => equalBytes(candidate?.publisherId, publisherId))) {
      fail('PUBLISHER_CATALOG_NOT_WRITABLE')
    }
  }

  async function completeAdmissionLifecycle(binding) {
    const completeMigration = options.ctx?.completePublicationV1Migration
    if (typeof completeMigration !== 'function') return
    if (typeof binding?.catalog?.waitForWritable !== 'function' ||
        await binding.catalog.waitForWritable() !== true ||
        binding.catalog.writable !== true) {
      fail('PUBLISHER_CATALOG_NOT_WRITABLE')
    }
    const result = await completeMigration()
    if (result?.status !== 'complete') fail('PUBLISHER_MIGRATION_PENDING')
  }


  return {
    async provisionPublisherCatalog(request = {}) {
      try {
        const registry = activeCatalogRegistry()
        if (typeof registry.provision !== 'function' || typeof registry.getWritableBindings !== 'function') {
          fail('PUBLISHER_CATALOG_UNAVAILABLE')
        }
        const publisherId = parsePublisherId(request.publisherId)
        const genesisRootKey = exactBytes(request.genesisRootKey, 32)
        if (!equalBytes(derivePublisherId(genesisRootKey), publisherId)) fail('PUBLISHER_ID_MISMATCH')
        const existingWritable = await registry.getWritableBindings()
        if (Array.isArray(existingWritable) && existingWritable.length > 0 &&
            !existingWritable.some(candidate => equalBytes(candidate?.publisherId, publisherId))) {
          const hasAdmittedOther = existingWritable.some(candidate => candidate?.namespaceDescriptor != null || candidate?.admitted === true)
          if (hasAdmittedOther) fail('PUBLISHER_CATALOG_AMBIGUOUS')
        }
        const binding = cloneBinding(await registry.provision(publisherId, genesisRootKey), publisherId)
        if (!equalBytes(binding.genesisRootKey, genesisRootKey)) fail('PUBLISHER_CATALOG_MISMATCH')
        const state = await localCatalogState(binding, publisherId)
        await assertOnlyWritableBinding(registry, publisherId)
        if (state.admitted) await completeAdmissionLifecycle(binding)
        return {
          success: true,
          publisherId: publisherHex(publisherId),
          catalogBootstrapKey: b4a.from(binding.catalogBootstrapKey),
          localWriterKey: b4a.from(state.localWriterKey),
          localSignerKey: b4a.from(state.localSignerKey),
          writable: state.writable,
          namespaceInitialized: state.namespaceInitialized,
          admitted: state.admitted,
          errorCode: null
        }
      } catch (error) {
        return {
          success: false,
          publisherId: typeof request.publisherId === 'string' ? request.publisherId : '',
          catalogBootstrapKey: b4a.alloc(0),
          localWriterKey: b4a.alloc(0),
          localSignerKey: b4a.alloc(0),
          writable: false,
          namespaceInitialized: false,
          admitted: false,
          errorCode: stableCode(error, 'PUBLISHER_CATALOG_PROVISION_FAILED')
        }
      }
    },

    async preparePublisherRootOperation(request = {}) {
      try {
        const currentTime = safeUint(now())
        purgeExpiredIntents(currentTime)
        const id = parseIntentId(request.intentId)
        if (intents.has(id)) fail('PUBLISHER_INTENT_DUPLICATE')
        if (intents.size >= maxIntents) fail('PUBLISHER_INTENT_CAPACITY')

        const publisherId = parsePublisherId(request.publisherId)
        const signerPublicKey = exactBytes(request.signerPublicKey, 32)
        const recordType = request.recordType
        if (![PUBLISHER_RECORD_TYPES.NAMESPACE,
          PUBLISHER_RECORD_TYPES.ROOT_TRANSITION,
          PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
          PUBLISHER_RECORD_TYPES.WRITER_REVOCATION].includes(recordType)) {
          fail('PUBLISHER_RECORD_TYPE_UNSUPPORTED')
        }
        const canonicalBody = variableBytes(request.body)
        const displaySummaryJson = normalizeDisplaySummaryJson(request.displaySummaryJson)
        const signedAt = request.issuedAt === undefined || request.issuedAt === null || request.issuedAt === 0
          ? currentTime
          : safeUint(request.issuedAt)
        const intentExpiresAt = safeUint(request.intentExpiresAt, 'PUBLISHER_INTENT_EXPIRY_INVALID')
        if (intentExpiresAt <= currentTime || intentExpiresAt - currentTime > MAX_INTENT_TTL_MS) {
          fail('PUBLISHER_INTENT_EXPIRY_INVALID')
        }
        if (request.expiresInMs !== undefined && request.expiresInMs !== null && request.expiresInMs !== 0) {
          const expiresInMs = safeUint(request.expiresInMs, 'PUBLISHER_INTENT_EXPIRY_INVALID')
          if (expiresInMs < 1 || expiresInMs > MAX_INTENT_TTL_MS) fail('PUBLISHER_INTENT_EXPIRY_INVALID')
        }
        const binding = await resolveBinding(publisherId)

        let unsignedBytes
        let candidateRecordId
        let rootAuthorization = null
        let recordExpiresAt = 0
        if (recordType === PUBLISHER_RECORD_TYPES.NAMESPACE) {
          const descriptor = decodePublisherNamespaceDescriptor(canonicalBody)
          if (!equalBytes(descriptor.publisherId, publisherId) ||
              !equalBytes(descriptor.publisherRootKey, binding.genesisRootKey) ||
              !equalBytes(descriptor.publisherRootKey, signerPublicKey) ||
              !equalBytes(descriptor.catalogBootstrapKey, binding.catalogBootstrapKey) ||
              descriptor.catalogEpoch !== 0 || descriptor.policySequence !== 0 ||
              descriptor.previousRootKey !== undefined || descriptor.rootTransitionProof !== undefined) {
            fail('PUBLISHER_CATALOG_MISMATCH')
          }
          const envelopeExpiresAt = request.expiresAt === undefined || request.expiresAt === null || request.expiresAt === 0
            ? undefined
            : safeUint(request.expiresAt)
          if (envelopeExpiresAt !== undefined && envelopeExpiresAt < signedAt) fail('PUBLISHER_RECORD_EXPIRY_INVALID')
          recordExpiresAt = envelopeExpiresAt || 0
          const unsigned = {
            recordType,
            schemaMajor: 1,
            schemaMinor: 0,
            issuerIdentityKey: publisherId,
            signerKey: signerPublicKey,
            policyEpoch: 0,
            issuerSequence: 0,
            signedAt,
            expiresAt: envelopeExpiresAt,
            canonicalBody
          }
          unsignedBytes = encodeUnsignedSignedEnvelope(unsigned)
          const decoded = decodeUnsignedSignedEnvelope(unsignedBytes)
          if (!equalBytes(decoded.canonicalBody, canonicalBody) || !equalBytes(decoded.signerKey, signerPublicKey)) {
            fail('PUBLISHER_CANONICAL_MISMATCH')
          }
          candidateRecordId = crypto.hash(unsignedBytes)
        } else {
          if (request.expiresAt !== undefined && request.expiresAt !== null && request.expiresAt !== 0) {
            fail('PUBLISHER_RECORD_EXPIRY_UNSUPPORTED')
          }
          const body = decodePublisherOperationBody(recordType, canonicalBody)
          rootAuthorization = await getRootAuthorization(binding, recordType, body)
          if (!policySignerKind(rootAuthorization.signerPolicy, signerPublicKey)) fail('PUBLISHER_SIGNER_UNAUTHORIZED')
          const unsigned = {
            recordType,
            schemaMajor: 1,
            schemaMinor: 0,
            issuerIdentityKey: publisherId,
            policyEpoch: rootAuthorization.policyEpoch,
            issuerSequence: rootAuthorization.expectedSequence,
            signedAt,
            canonicalBody
          }
          if (recordType === PUBLISHER_RECORD_TYPES.ROOT_TRANSITION) {
            unsignedBytes = encodeUnsignedMultiSignedEnvelope(unsigned)
            const decoded = decodeUnsignedMultiSignedEnvelope(unsignedBytes)
            if (!equalBytes(decoded.canonicalBody, canonicalBody)) fail('PUBLISHER_CANONICAL_MISMATCH')
          } else {
            unsigned.signerKey = signerPublicKey
            unsignedBytes = encodeUnsignedSignedEnvelope(unsigned)
            const decoded = decodeUnsignedSignedEnvelope(unsignedBytes)
            if (!equalBytes(decoded.canonicalBody, canonicalBody) || !equalBytes(decoded.signerKey, signerPublicKey)) {
              fail('PUBLISHER_CANONICAL_MISMATCH')
            }
          }
          candidateRecordId = crypto.hash(unsignedBytes)
        }
        candidateRecordId = exactBytes(candidateRecordId, 32, 'PUBLISHER_CANONICAL_MISMATCH')

        intents.set(id, {
          intentId: id,
          publisherId: publisherHex(publisherId),
          publisherIdBytes: b4a.from(publisherId),
          recordType,
          signerPublicKey: b4a.from(signerPublicKey),
          unsignedBytes: b4a.from(unsignedBytes),
          candidateRecordId: b4a.from(candidateRecordId),
          catalogBootstrapKey: b4a.from(binding.catalogBootstrapKey),
          displaySummaryJson,
          issuedAt: signedAt,
          intentExpiresAt,
          rootAuthorization
        })

        return {
          intentId: id,
          success: true,
          publisherId: publisherHex(publisherId),
          recordType,
          unsignedBytes: b4a.from(unsignedBytes),
          candidateRecordId: b4a.from(candidateRecordId),
          signerPublicKey: b4a.from(signerPublicKey),
          bodyLength: canonicalBody.byteLength,
          issuedAt: signedAt,
          expiresAt: recordExpiresAt,
          intentExpiresAt,
          displaySummaryJson,
          error: null
        }
      } catch (error) {
        return emptyPrepareResponse(request, stableCode(error, 'PUBLISHER_PREPARE_FAILED'))
      }
    },

    async submitPublisherRootOperation(request = {}) {
      const intent = consumeIntent(request.intentId)
      if (!intent) return emptySubmitResponse(request, 'PUBLISHER_INTENT_UNKNOWN')
      let submissionKey = null

      try {
        const currentTime = safeUint(now())
        if (currentTime >= intent.intentExpiresAt) fail('PUBLISHER_INTENT_EXPIRED')
        const displaySummaryJson = normalizeDisplaySummaryJson(request.displaySummaryJson)
        const unsignedBytes = variableBytes(request.unsignedBytes, 'PUBLISHER_INTENT_MISMATCH')
        const candidateRecordId = exactBytes(request.candidateRecordId, 32, 'PUBLISHER_INTENT_MISMATCH')
        if (request.publisherId !== intent.publisherId || request.recordType !== intent.recordType ||
            displaySummaryJson !== intent.displaySummaryJson ||
            !equalBytes(unsignedBytes, intent.unsignedBytes) ||
            !equalBytes(candidateRecordId, intent.candidateRecordId)) {
          fail('PUBLISHER_INTENT_MISMATCH')
        }
        const signer = exactBytes(request.signer, 32, 'PUBLISHER_SIGNER_MISMATCH')
        const signerPublicKey = exactBytes(request.signerPublicKey, 32, 'PUBLISHER_SIGNER_MISMATCH')
        if (!equalBytes(signer, signerPublicKey) || !equalBytes(signer, intent.signerPublicKey)) {
          fail('PUBLISHER_SIGNER_MISMATCH')
        }
        const signature = exactBytes(request.signature, 64, 'PUBLISHER_SIGNATURE_INVALID')
        if (!equalBytes(crypto.hash(unsignedBytes), candidateRecordId)) fail('PUBLISHER_INTENT_MISMATCH')

        const isTransition = intent.recordType === PUBLISHER_RECORD_TYPES.ROOT_TRANSITION
        const decoded = isTransition
          ? decodeUnsignedMultiSignedEnvelope(unsignedBytes)
          : decodeUnsignedSignedEnvelope(unsignedBytes)
        if (decoded.recordType !== intent.recordType || !equalBytes(decoded.issuerIdentityKey, intent.publisherIdBytes)) {
          fail('PUBLISHER_INTENT_MISMATCH')
        }
        const preimage = isTransition
          ? multiSignedRecordSignaturePreimage({ recordType: intent.recordType, transitionId: candidateRecordId })
          : signedRecordSignaturePreimage({ recordType: intent.recordType, recordId: candidateRecordId })
        if (crypto.verify(preimage, signature, signer) !== true) fail('PUBLISHER_SIGNATURE_INVALID')
        submissionKey = `${intent.publisherId}:${publisherHex(candidateRecordId)}`
        if (activeSubmissions.has(submissionKey)) fail('PUBLISHER_RECORD_REPLAY')
        if (activeSubmissions.size >= maxIntents) fail('PUBLISHER_INTENT_CAPACITY')
        activeSubmissions.add(submissionKey)

        const binding = await resolveBinding(intent.publisherIdBytes)
        if (!equalBytes(binding.catalogBootstrapKey, intent.catalogBootstrapKey)) fail('PUBLISHER_CATALOG_MISMATCH')
        let existingReceipt
        try {
          existingReceipt = await getExistingReceipt(binding.catalog, candidateRecordId)
        } catch (error) {
          if (error instanceof PublisherApiError) throw error
          fail('PUBLISHER_CATALOG_RECEIPT_FAILED')
        }
        if (existingReceipt) fail(existingReceipt.accepted === true ? 'PUBLISHER_RECORD_REPLAY' : 'PUBLISHER_RECORD_REJECTED')

        if (!isTransition) {
          if (intent.recordType !== PUBLISHER_RECORD_TYPES.NAMESPACE) {
            const body = decodePublisherOperationBody(intent.recordType, decoded.canonicalBody)
            const authorization = await getRootAuthorization(binding, intent.recordType, body)
            if (!equalRootAuthorization(authorization, intent.rootAuthorization)) fail('PUBLISHER_ROOT_AUTHORIZATION_STALE')
            if (!policySignerKind(authorization.signerPolicy, signer)) fail('PUBLISHER_SIGNER_UNAUTHORIZED')
          }
          const envelope = attachSignedEnvelopeSignature({ ...decoded, recordId: candidateRecordId }, signature)
          try {
            await appendAndConfirm(binding.catalog, envelope, candidateRecordId, { allowAuthorityBootstrap: true })
          } catch (error) {
            fail('PUBLISHER_CATALOG_APPEND_FAILED')
          }
          if (intent.recordType === PUBLISHER_RECORD_TYPES.WRITER_ADMISSION) {
            await completeAdmissionLifecycle(binding)
          }
          return {
            intentId: intent.intentId,
            success: true,
            valid: true,
            complete: true,
            reason: null,
            publisherId: intent.publisherId,
            recordType: intent.recordType,
            recordId: b4a.from(candidateRecordId),
            signer: b4a.from(signer),
            signerPublicKey: b4a.from(signerPublicKey),
            signature: b4a.from(signature)
          }
        }

        const body = decodePublisherOperationBody(intent.recordType, decoded.canonicalBody)
        const authorization = await getRootAuthorization(binding, intent.recordType, body)
        if (!equalRootAuthorization(authorization, intent.rootAuthorization)) fail('PUBLISHER_ROOT_AUTHORIZATION_STALE')
        const signerKind = policySignerKind(authorization.signerPolicy, signer)
        if (!signerKind) fail('PUBLISHER_SIGNER_UNAUTHORIZED')
        const registry = activeCatalogRegistry()
        if (typeof registry.loadPendingTransition !== 'function' ||
            typeof registry.savePendingTransition !== 'function' ||
            typeof registry.deletePendingTransition !== 'function') {
          fail('PUBLISHER_PENDING_STORE_UNAVAILABLE')
        }

        let pending = await registry.loadPendingTransition(intent.publisherIdBytes, candidateRecordId)
        if (pending && (!equalBytes(pending.unsignedBytes, unsignedBytes) || !equalBytes(pending.publisherId, intent.publisherIdBytes))) {
          fail('PUBLISHER_PENDING_MISMATCH')
        }
        if (!pending) {
          if (currentTime > Number.MAX_SAFE_INTEGER - PENDING_TRANSITION_TTL_MS) fail('PUBLISHER_PENDING_INVALID')
          pending = {
            publisherId: b4a.from(intent.publisherIdBytes),
            transitionId: b4a.from(candidateRecordId),
            unsignedBytes: b4a.from(unsignedBytes),
            expiresAt: currentTime + PENDING_TRANSITION_TTL_MS,
            signatures: []
          }
        }
        const existingSignature = pending.signatures.find(entry => equalBytes(entry.signerKey, signer))
        if (existingSignature) {
          if (!equalBytes(existingSignature.signature, signature)) fail('PUBLISHER_SIGNATURE_DUPLICATE')
        } else {
          if (pending.signatures.length >= MAX_PENDING_SIGNATURES) fail('PUBLISHER_PENDING_SIGNATURE_CAPACITY')
          if (signerKind === 'quorum') {
            const quorumPresent = pending.signatures.filter(entry => authorization.signerPolicy.quorumSignerKeys.some(key => equalBytes(key, entry.signerKey))).length
            if (quorumPresent >= authorization.signerPolicy.quorum) fail('PUBLISHER_SIGNER_QUORUM_COMPLETE')
          }
          pending.signatures.push({ signerKey: b4a.from(signer), signature: b4a.from(signature) })
          pending.signatures.sort((left, right) => b4a.compare(left.signerKey, right.signerKey))
        }
        await registry.savePendingTransition(pending)

        if (!policyIsComplete(authorization.signerPolicy, pending.signatures)) {
          return emptySubmitResponse(request, 'PUBLISHER_ROOT_TRANSITION_PENDING', true, {
            recordId: b4a.from(candidateRecordId),
            signer: b4a.from(signer),
            signerPublicKey: b4a.from(signerPublicKey),
            signature: b4a.from(signature),
            pendingSignatureCount: pending.signatures.length,
            pendingExpiresAt: pending.expiresAt
          })
        }

        const envelope = attachMultiSignedEnvelopeSignatures({ ...decoded, transitionId: candidateRecordId }, pending.signatures)
        verifyMultiSignedEnvelope(envelope, {
          hash: crypto.hash,
          verifySignature: (candidateSignature, candidatePreimage, publicKey) => crypto.verify(candidatePreimage, candidateSignature, publicKey),
          authorization: {
            issuerIdentityKey: authorization.publisherId,
            policyEpoch: authorization.policyEpoch,
            expectedSequence: authorization.expectedSequence,
            signerPolicy: authorization.signerPolicy,
            claimReplay: () => true
          }
        })
        try {
          await appendAndConfirm(binding.catalog, envelope, candidateRecordId, { allowAuthorityBootstrap: true })
        } catch (error) {
          fail('PUBLISHER_CATALOG_APPEND_FAILED')
        }
        await registry.deletePendingTransition(intent.publisherIdBytes, candidateRecordId)
        try {
          await ctx?.scopedNetwork?.rebindLocalPublisherCatalog?.({
            publisherId: intent.publisherId,
          })
        } catch (error) {
          console.warn('[PublisherApi] Accepted root transition network rebind failed:', error?.message || error)
        }
        return {
          intentId: intent.intentId,
          success: true,
          valid: true,
          complete: true,
          reason: null,
          publisherId: intent.publisherId,
          recordType: intent.recordType,
          recordId: b4a.from(candidateRecordId),
          signer: b4a.from(signer),
          signerPublicKey: b4a.from(signerPublicKey),
          signature: b4a.from(signature),
          pendingSignatureCount: pending.signatures.length
        }
      } catch (error) {
        const valid = error instanceof PublisherApiError && [
          'PUBLISHER_CATALOG_APPEND_FAILED',
          'PUBLISHER_CATALOG_REJECTED',
          'PUBLISHER_CATALOG_RECEIPT_INVALID',
          'PUBLISHER_ROOT_TRANSITION_PENDING'
        ].includes(error.code)
        return emptySubmitResponse(request, stableCode(error, 'PUBLISHER_SUBMIT_FAILED'), valid)
      } finally {
        if (submissionKey !== null) activeSubmissions.delete(submissionKey)
      }
    }
  }
}
