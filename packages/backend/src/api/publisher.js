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
const MAX_LOCAL_WRITABLE_CATALOGS = 64
const MAX_PENDING_TRANSITIONS = 32
const MAX_PENDING_UNSIGNED_BYTES = 1_048_576
const MAX_PENDING_SIGNATURES = 16
const PENDING_TRANSITION_TTL_MS = 10 * 60_000
const MAX_DISPLAY_SUMMARY_BYTES = 4_096
const CATALOG_MAPPING_PREFIX = 'publisher-catalog:v1:'
const PENDING_TRANSITIONS_KEY = 'publisher-root-transitions:v1'
const LEGACY_CATALOG_NAMESPACE = 'peartube-publisher'
const CATALOG_NAMESPACE_PATTERN = /^peartube-publisher(?:-[0-9a-f]{32})?$/

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
  if (!value || (value.version !== 1 && value.version !== 2) ||
      value.publisherId !== publisherHex(expectedPublisherId) ||
      typeof value.genesisRootKey !== 'string' || !/^[0-9a-f]{64}$/.test(value.genesisRootKey) ||
      typeof value.catalogBootstrapKey !== 'string' || !/^[0-9a-f]{64}$/.test(value.catalogBootstrapKey) ||
      (value.version === 2 && (typeof value.catalogNamespace !== 'string' ||
        !CATALOG_NAMESPACE_PATTERN.test(value.catalogNamespace)))) {
    fail('PUBLISHER_CATALOG_MAPPING_INVALID')
  }
  const genesisRootKey = b4a.from(value.genesisRootKey, 'hex')
  if (!equalBytes(derivePublisherId(genesisRootKey), expectedPublisherId)) fail('PUBLISHER_CATALOG_MAPPING_INVALID')
  return {
    publisherId: b4a.from(expectedPublisherId),
    genesisRootKey,
    catalogBootstrapKey: b4a.from(value.catalogBootstrapKey, 'hex'),
    catalogNamespace: value.version === 2 ? value.catalogNamespace : LEGACY_CATALOG_NAMESPACE
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
  const localWritables = new Map()
  const opening = new Map()
  /** @type {Map<string, { binding: object, refs: number, closing: Promise<void>|null }>} */
  const writableLeases = new Map()
  /** @type {Map<string, Promise<{ kind: 'retained', binding: object } | { kind: 'lease', entry: object }>>} */
  const openingLeases = new Map()
  let closed = false
  let writableDiscoveryComplete = false
  let pendingMutation = Promise.resolve()
  const maxLocalWritables = Math.min(MAX_LOCAL_WRITABLE_CATALOGS, Math.max(maxOpenCatalogs, 1))

  function getOwnedBinding(id) {
    return opened.get(id) || localWritables.get(id) || null
  }

  function ownedSnapshot() {
    return [...opened.values(), ...localWritables.values()]
  }

  function isCatalogWritable(catalog) {
    return catalog?.writable === true
  }

  function retainOwnedBinding(id, binding) {
    const writable = isCatalogWritable(binding?.catalog)
    if (writable) {
      opened.delete(id)
      localWritables.set(id, binding)
    } else {
      localWritables.delete(id)
      opened.set(id, binding)
    }
    return binding
  }

  async function disposeOwned(id) {
    const binding = getOwnedBinding(id)
    if (!binding) return null
    opened.delete(id)
    localWritables.delete(id)
    return binding
  }

  function validateExistingBinding (binding, genesisRootKey, requestedKey) {
    if (genesisRootKey && !equalBytes(binding.genesisRootKey, genesisRootKey)) fail('PUBLISHER_CATALOG_MISMATCH')
    if (requestedKey && !equalBytes(binding.catalogBootstrapKey, requestedKey)) fail('PUBLISHER_CATALOG_MISMATCH')
  }

  function shouldReuseBinding (binding, create, requestedKey) {
    return !create || requestedKey || binding.catalog?.localWriterKey != null
  }

  async function resolveCatalogMapping ({ publisherId, providedMapping, create, genesisRootKey, requestedKey, replaceLocalGenesis }) {
    let mapping = providedMapping
    let mappingEntry = null
    if (!mapping) {
      mappingEntry = await ctx.metaDb.get(catalogMappingKey(publisherId))
      mapping = mappingEntry?.value ? decodeCatalogMapping(mappingEntry.value, publisherId) : null
    }
    if (!mapping && !create) fail('PUBLISHER_CATALOG_UNAVAILABLE')
    if (mapping && genesisRootKey && !equalBytes(mapping.genesisRootKey, genesisRootKey)) fail('PUBLISHER_CATALOG_MISMATCH')
    if (mapping && requestedKey && !equalBytes(mapping.catalogBootstrapKey, requestedKey)) fail('PUBLISHER_CATALOG_MISMATCH')
    if (!mapping) {
      if (!genesisRootKey || !equalBytes(derivePublisherId(genesisRootKey), publisherId)) fail('PUBLISHER_ID_MISMATCH')
      mapping = {
        publisherId: b4a.from(publisherId),
        genesisRootKey: b4a.from(genesisRootKey),
        catalogBootstrapKey: requestedKey ? b4a.from(requestedKey) : null,
        catalogNamespace: `${LEGACY_CATALOG_NAMESPACE}-${publisherHex(crypto.randomBytes(16))}`
      }
    }
    if (replaceLocalGenesis) {
      mapping.catalogBootstrapKey = null
      mapping.catalogNamespace = `${LEGACY_CATALOG_NAMESPACE}-${publisherHex(crypto.randomBytes(16))}`
    }
    return { mapping, mappingEntry }
  }

  async function verifyBootstrapWritable (mapping, create, requestedKey) {
    if (!create || requestedKey || !mapping.catalogBootstrapKey || !ctx.store) return
    const namespacedStore = typeof ctx.store.namespace === 'function'
      ? ctx.store.namespace(mapping.catalogNamespace)
      : ctx.store
    if (typeof namespacedStore?.get !== 'function') return
    try {
      const bootstrapCore = namespacedStore.get({ key: mapping.catalogBootstrapKey })
      await bootstrapCore.ready?.()
      let writable = bootstrapCore.writable === true
      const localWriterKey = await bootstrapCore.getUserData?.('autobase/local')
      if (writable && localWriterKey) {
        const localWriterCore = namespacedStore.get({ key: localWriterKey })
        await localWriterCore.ready?.()
        writable = localWriterCore.writable === true
      }
      if (!writable) {
        mapping.catalogBootstrapKey = null
        mapping.catalogNamespace = `${LEGACY_CATALOG_NAMESPACE}-${publisherHex(crypto.randomBytes(16))}`
      }
    } catch {
      // Opening the mapped catalog reports the stable failure.
    }
  }

  async function persistCatalogMappingIfNeeded (publisherId, id, mapping, mappingEntry) {
    const storedNamespace = mappingEntry?.value?.version === 2
      ? mappingEntry.value.catalogNamespace
      : LEGACY_CATALOG_NAMESPACE
    if (!mappingEntry?.value ||
        mappingEntry.value.catalogBootstrapKey !== publisherHex(mapping.catalogBootstrapKey) ||
        storedNamespace !== mapping.catalogNamespace) {
      await ctx.metaDb.put(catalogMappingKey(publisherId), {
        version: 2,
        publisherId: id,
        genesisRootKey: publisherHex(mapping.genesisRootKey),
        catalogBootstrapKey: publisherHex(mapping.catalogBootstrapKey),
        catalogNamespace: mapping.catalogNamespace
      })
    }
  }

  function checkCatalogCapacity (id, catalog) {
    const writable = isCatalogWritable(catalog)
    if (writable) {
      if (localWritables.size >= maxLocalWritables && !localWritables.has(id)) {
        fail('PUBLISHER_CATALOG_CAPACITY')
      }
    } else if (opened.size >= maxOpenCatalogs && !opened.has(id)) {
      fail('PUBLISHER_CATALOG_CAPACITY')
    }
  }

  async function openCatalog(publisherId, { genesisRootKey = null, create = false, catalogBootstrapKey = null, namespaceDescriptor = null, mapping: providedMapping = null, replaceLocalGenesis = false } = {}) {
    if (closed) fail('PUBLISHER_CATALOG_REGISTRY_CLOSED')
    const id = publisherHex(publisherId)
    const requestedKey = catalogBootstrapKey ? exactBytes(catalogBootstrapKey, 32, 'PUBLISHER_CATALOG_MISMATCH') : null
    const cached = getOwnedBinding(id)
    if (cached) {
      validateExistingBinding(cached, genesisRootKey, requestedKey)
      if (shouldReuseBinding(cached, create, requestedKey)) return cached
      await disposeOwned(id)
      replaceLocalGenesis = true
      Promise.resolve(cached.catalog?.close?.()).catch(() => {})
    }
    if (opening.has(id)) {
      const binding = await opening.get(id)
      validateExistingBinding(binding, genesisRootKey, requestedKey)
      if (shouldReuseBinding(binding, create, requestedKey)) return binding
      if (getOwnedBinding(id) === binding) await disposeOwned(id)
      Promise.resolve(binding.catalog?.close?.()).catch(() => {})
      return openCatalog(publisherId, { genesisRootKey, create, catalogBootstrapKey, namespaceDescriptor, mapping: providedMapping, replaceLocalGenesis: true })
    }

    // Absolute bound only here. Follower vs local-writable slot checks happen after ready()
    // so a cold local publisher can still open when the follower cache is full.
    if (opened.size + localWritables.size + opening.size >= maxOpenCatalogs + maxLocalWritables) {
      fail('PUBLISHER_CATALOG_CAPACITY')
    }

    const task = (async () => {
      const { mapping, mappingEntry } = await resolveCatalogMapping({
        publisherId, providedMapping, create, genesisRootKey, requestedKey, replaceLocalGenesis
      })
      await verifyBootstrapWritable(mapping, create, requestedKey)

      const syncStateEntry = await ctx.metaDb.get(`consumer-publisher-sync-state:v1:${id}`).catch(() => null)
      const syncState = syncStateEntry?.value || null
      const catalogOptions = {
        publisherId: b4a.from(publisherId),
        namespace: mapping.catalogNamespace,
        syncState,
      }
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
        await persistCatalogMappingIfNeeded(publisherId, id, mapping, mappingEntry)
        const binding = {
          catalog,
          publisherId: b4a.from(publisherId),
          genesisRootKey: b4a.from(mapping.genesisRootKey),
          catalogBootstrapKey: b4a.from(mapping.catalogBootstrapKey),
          ...(namespaceDescriptor ? { namespaceDescriptor } : {})
        }
        checkCatalogCapacity(id, catalog)
        return retainOwnedBinding(id, binding)
      } catch (error) {
        await closeFailedCatalog(catalog)
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

  function listBindingPageFallback ({ cursor, pageLimit, writableOnly, skipPublisherId }) {
    const admitted = ownedSnapshot()
      .filter(binding => !skipPublisherId || !equalBytes(binding.publisherId, skipPublisherId))
      .filter(binding => !writableOnly || isCatalogWritable(binding.catalog))
      .sort((left, right) => b4a.compare(left.publisherId, right.publisherId))
    let startIndex = 0
    if (cursor) {
      const cursorBytes = typeof cursor === 'string' ? b4a.from(cursor, 'hex') : cursor
      const idx = admitted.findIndex(b => b4a.compare(b.publisherId, cursorBytes) > 0)
      startIndex = idx === -1 ? admitted.length : idx
    }
    const items = admitted.slice(startIndex, startIndex + pageLimit).map(b => ({ ...b }))
    const hasMore = startIndex + pageLimit < admitted.length
    const nextCursor = hasMore && items.length > 0 ? publisherHex(items.at(-1).publisherId) : null
    return { items, nextCursor, errors: [], release: async () => {} }
  }

  async function createCandidateCatalogForPage (entryValue, publisherId, id, throwIfAborted) {
    const mapping = decodeCatalogMapping(entryValue, publisherId)
    throwIfAborted()
    const syncStateEntry = await ctx.metaDb.get(`consumer-publisher-sync-state:v1:${id}`).catch(() => null)
    throwIfAborted()
    const syncState = syncStateEntry?.value || null
    const catalogOptions = {
      publisherId: b4a.from(publisherId),
      namespace: mapping.catalogNamespace,
      syncState,
    }
    if (deviceSigner) catalogOptions.deviceSigner = deviceSigner
    if (mapping.catalogBootstrapKey) catalogOptions.key = b4a.from(mapping.catalogBootstrapKey)
    const candidateCatalog = catalogFactory(ctx.store, catalogOptions)
    try {
      if (!candidateCatalog || typeof candidateCatalog.ready !== 'function') {
        fail('PUBLISHER_CATALOG_UNAVAILABLE')
      }
      await candidateCatalog.ready()
      throwIfAborted()
    } catch (error) {
      await closeFailedCatalog(candidateCatalog)
      throw error
    }
    return { candidateCatalog, mapping }
  }

  async function attachCandidateCatalogToPage ({
    candidateCatalog, mapping, id, publisherId, writableOnly, items, transientCatalogs
  }) {
    const isWritable = isCatalogWritable(candidateCatalog)
    if (isWritable) {
      const canRetain = localWritables.has(id) || localWritables.size < maxLocalWritables
      const binding = {
        catalog: candidateCatalog,
        publisherId: b4a.from(publisherId),
        genesisRootKey: b4a.from(mapping.genesisRootKey),
        catalogBootstrapKey: b4a.from(mapping.catalogBootstrapKey),
      }
      if (canRetain) {
        retainOwnedBinding(id, binding)
        items.push({ ...binding })
      } else {
        binding.transient = true
        transientCatalogs.push(candidateCatalog)
        items.push(binding)
      }
      return
    }

    if (writableOnly) {
      try { await candidateCatalog.close?.() } catch { /* best-effort */ }
      return
    }

    const binding = {
      catalog: candidateCatalog,
      publisherId: b4a.from(publisherId),
      genesisRootKey: b4a.from(mapping.genesisRootKey),
      catalogBootstrapKey: b4a.from(mapping.catalogBootstrapKey),
      transient: true,
    }
    transientCatalogs.push(candidateCatalog)
    items.push(binding)
  }

  function isAbortException (error, signal) {
    return signal?.aborted || (error && (error === signal?.reason || error?.name === 'AbortError' || error?.message === 'Aborted'))
  }

  function adoptRetainedBinding (binding) {
    if (!isCatalogWritable(binding.catalog)) fail('PUBLISHER_CATALOG_NOT_WRITABLE')
    return { binding: { ...binding }, release: async () => {} }
  }

  function adoptLeaseEntry (id, entry) {
    if (!entry || entry.closing || writableLeases.get(id) !== entry) {
      fail('PUBLISHER_CATALOG_UNAVAILABLE')
    }
    entry.refs += 1
    return {
      binding: { ...entry.binding, transient: true },
      release: createLeaseReleaser(id, entry),
    }
  }

  function adoptOpenResult (id, result) {
    if (!result) fail('PUBLISHER_CATALOG_UNAVAILABLE')
    if (result.kind === 'retained') return adoptRetainedBinding(result.binding)
    return adoptLeaseEntry(id, result.entry)
  }

  async function closeFailedCatalog (catalog) {
    try { await catalog?.close?.() } catch { /* preserve the original failure */ }
  }

  async function loadWritableMappingAndCatalog (id, publisherId, signal) {
    const mappingEntry = await ctx.metaDb.get(catalogMappingKey(publisherId))
    if (signal?.aborted) throw signal.reason || new Error('Aborted')
    const mapping = mappingEntry?.value ? decodeCatalogMapping(mappingEntry.value, publisherId) : null
    if (!mapping) fail('PUBLISHER_CATALOG_UNAVAILABLE')

    const syncStateEntry = await ctx.metaDb.get(`consumer-publisher-sync-state:v1:${id}`).catch(() => null)
    if (signal?.aborted) throw signal.reason || new Error('Aborted')
    const catalogOptions = {
      publisherId: b4a.from(publisherId),
      namespace: mapping.catalogNamespace,
      syncState: syncStateEntry?.value || null,
    }
    if (deviceSigner) catalogOptions.deviceSigner = deviceSigner
    if (mapping.catalogBootstrapKey) catalogOptions.key = b4a.from(mapping.catalogBootstrapKey)
    const catalog = catalogFactory(ctx.store, catalogOptions)
    // Own every catalog created here until the successful return transfers it
    // to openWritableLeaseTask; a post-factory throw must close it exactly once.
    try {
      if (!catalog || typeof catalog.ready !== 'function') fail('PUBLISHER_CATALOG_UNAVAILABLE')
      await catalog.ready()
      if (signal?.aborted) throw signal.reason || new Error('Aborted')
    } catch (error) {
      await closeFailedCatalog(catalog)
      throw error
    }
    return { mapping, catalog }
  }

  function resolveWritableAfterReady (id, publisherId, catalog, mapping) {
    if (!isCatalogWritable(catalog)) {
      try { void catalog.close?.() } catch { /* not writable */ }
      fail('PUBLISHER_CATALOG_NOT_WRITABLE')
    }

    const ownedRace = getOwnedBinding(id)
    if (ownedRace) {
      try { void catalog.close?.() } catch { /* discard duplicate */ }
      if (!isCatalogWritable(ownedRace.catalog)) fail('PUBLISHER_CATALOG_NOT_WRITABLE')
      return { kind: 'retained', binding: ownedRace }
    }
    const leaseRace = writableLeases.get(id)
    if (leaseRace && !leaseRace.closing) {
      try { void catalog.close?.() } catch { /* discard duplicate */ }
      return { kind: 'lease', entry: leaseRace }
    }

    const binding = {
      catalog,
      publisherId: b4a.from(publisherId),
      genesisRootKey: b4a.from(mapping.genesisRootKey),
      catalogBootstrapKey: b4a.from(mapping.catalogBootstrapKey),
    }

    if (localWritables.size < maxLocalWritables || localWritables.has(id)) {
      retainOwnedBinding(id, binding)
      return { kind: 'retained', binding }
    }

    binding.transient = true
    const entry = { binding, refs: 0, closing: null }
    writableLeases.set(id, entry)
    return { kind: 'lease', entry }
  }

  function throwIfAbortedSignal(signal) {
    if (signal?.aborted) throw signal.reason || new Error('Aborted')
  }

  function bindingPageReadOptions(cursor) {
    return {
      gte: cursor ? `${CATALOG_MAPPING_PREFIX}${cursor}\u0000` : CATALOG_MAPPING_PREFIX,
      lt: `${CATALOG_MAPPING_PREFIX}\xff`,
    }
  }

  function bindingPageEntryId(key) {
    if (!key.startsWith(CATALOG_MAPPING_PREFIX)) return null
    const id = key.slice(CATALOG_MAPPING_PREFIX.length)
    return /^[0-9a-f]{64}$/.test(id) ? id : null
  }

  function createTransientRelease(transientCatalogs) {
    let released = false
    return async () => {
      if (released) return
      released = true
      const pending = transientCatalogs.splice(0, transientCatalogs.length)
      for (const cat of pending) {
        try { await cat.close?.() } catch { /* best-effort transient disposal */ }
      }
    }
  }

  // Opens the mapped candidate and attaches it to the page. Returns the stable
  // error code on failure (after closing the candidate), or null on success;
  // abort exceptions are rethrown so the scan stops on cancellation.
  async function attachBindingPageCatalog ({ entryValue, publisherId, id, throwIfAborted, signal, writableOnly, items, transientCatalogs }) {
    let candidateCatalog = null
    try {
      const created = await createCandidateCatalogForPage(entryValue, publisherId, id, throwIfAborted)
      candidateCatalog = created.candidateCatalog
      await attachCandidateCatalogToPage({
        candidateCatalog, mapping: created.mapping, id, publisherId, writableOnly, items, transientCatalogs
      })
      return null
    } catch (error) {
      if (candidateCatalog) {
        try { await candidateCatalog.close?.() } catch { /* preserve failure */ }
      }
      if (isAbortException(error, signal)) throw error
      return stableCode(error, 'PUBLISHER_CATALOG_UNAVAILABLE')
    }
  }

  async function scanBindingPages ({ stream, pageLimit, skipPublisherId, writableOnly, signal, items, errors, transientCatalogs }) {
    let lastScannedId = null
    let scanned = 0
    let hasMore = false

    const throwIfAborted = () => throwIfAbortedSignal(signal)

    for await (const entry of stream) {
      throwIfAborted()
      const id = bindingPageEntryId(String(entry.key))
      if (!id) continue
      if (scanned >= pageLimit) {
        hasMore = true
        break
      }
      scanned += 1
      lastScannedId = id
      const publisherId = b4a.from(id, 'hex')
      if (skipPublisherId && equalBytes(publisherId, skipPublisherId)) continue
      const binding = getOwnedBinding(id)
      if (binding) {
        if (!writableOnly || isCatalogWritable(binding.catalog)) {
          items.push({ ...binding })
        }
        continue
      }
      const errorCode = await attachBindingPageCatalog({
        entryValue: entry.value, publisherId, id, throwIfAborted, signal, writableOnly, items, transientCatalogs
      })
      if (errorCode) {
        errors.push({ publisherId: b4a.from(publisherId), key: id, error: errorCode })
      }
    }
    throwIfAborted()
    return { hasMore, lastScannedId }
  }

  // Waits out a concurrent writable open. A failed open (or a stale adoption)
  // restarts the acquisition so the caller re-arbitrates under current state.
  async function awaitOpeningLease(id, signal, retry) {
    let opened
    try {
      opened = await openingLeases.get(id)
    } catch {
      throwIfAbortedSignal(signal)
      return retry()
    }
    throwIfAbortedSignal(signal)
    if (closed) fail('PUBLISHER_CATALOG_REGISTRY_CLOSED')
    try {
      return adoptOpenResult(id, opened)
    } catch {
      return retry()
    }
  }

  async function openWritableLeaseTask(id, publisherId, signal) {
    const ownedNow = getOwnedBinding(id)
    if (ownedNow) {
      if (!isCatalogWritable(ownedNow.catalog)) fail('PUBLISHER_CATALOG_NOT_WRITABLE')
      return { kind: 'retained', binding: ownedNow }
    }
    const liveLease = writableLeases.get(id)
    if (liveLease && !liveLease.closing) {
      return { kind: 'lease', entry: liveLease }
    }

    let catalog = null
    try {
      const loaded = await loadWritableMappingAndCatalog(id, publisherId, signal)
      catalog = loaded.catalog
      return resolveWritableAfterReady(id, publisherId, catalog, loaded.mapping)
    } catch (error) {
      try { await catalog?.close?.() } catch { /* preserve original failure */ }
      throw error
    }
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
      const binding = await disposeOwned(id)
      if (!binding) return false
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

    async listBindingPage({ cursor = null, limit = 16, writableOnly = false, skipPublisherId: skipPublisherIdValue = null, signal = undefined } = {}) {
      if (closed) fail('PUBLISHER_CATALOG_REGISTRY_CLOSED')
      throwIfAbortedSignal(signal)
      const maxLimit = Math.min(maxOpenCatalogs, 32)
      const pageLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, maxLimit) : maxLimit
      const skipPublisherId = skipPublisherIdValue
        ? exactBytes(skipPublisherIdValue, 32, 'PUBLISHER_REQUEST_INVALID')
        : null

      if (typeof ctx.metaDb.createReadStream !== 'function') {
        return listBindingPageFallback({ cursor, pageLimit, writableOnly, skipPublisherId })
      }

      const items = []
      const errors = []
      const transientCatalogs = []
      const release = createTransientRelease(transientCatalogs)

      try {
        const { hasMore, lastScannedId } = await scanBindingPages({
          stream: ctx.metaDb.createReadStream(bindingPageReadOptions(cursor)),
          pageLimit,
          skipPublisherId,
          writableOnly,
          signal,
          items,
          errors,
          transientCatalogs,
        })
        const nextCursor = hasMore && lastScannedId ? lastScannedId : null
        return { items, nextCursor, errors, release }
      } catch (error) {
        await release()
        throw error
      }
    },

    async listBindings({ skipPublisherId: skipPublisherIdValue = null } = {}) {
      if (closed) fail('PUBLISHER_CATALOG_REGISTRY_CLOSED')
      const skipPublisherId = skipPublisherIdValue
        ? exactBytes(skipPublisherIdValue, 32, 'PUBLISHER_REQUEST_INVALID')
        : null
      return ownedSnapshot()
        .filter(binding => !skipPublisherId || !equalBytes(binding.publisherId, skipPublisherId))
        .sort((left, right) => b4a.compare(left.publisherId, right.publisherId))
        .map(binding => ({ ...binding }))
    },

    /**
     * Targeted writable open that never grows the retained warm set past the soft cap.
     * Under-cap / already-retained bindings return with a no-op release.
     * Over-cap opens are refcounted leases closed on final release of that exact entry.
     * Full cold restore and upload-by-id must use this (or listBindingPage), not resolve().
     */
    async acquireWritableBinding(publisherIdValue, { signal = undefined } = {}) {
      if (closed) fail('PUBLISHER_CATALOG_REGISTRY_CLOSED')
      throwIfAbortedSignal(signal)
      const publisherId = exactBytes(publisherIdValue, 32, 'PUBLISHER_REQUEST_INVALID')
      const id = publisherHex(publisherId)
      const retry = () => this.acquireWritableBinding(publisherIdValue, { signal })

      const owned = getOwnedBinding(id)
      if (owned) return adoptRetainedBinding(owned)

      if (openingLeases.has(id)) {
        return awaitOpeningLease(id, signal, retry)
      }

      const existingLease = writableLeases.get(id)
      if (existingLease) {
        if (existingLease.closing) await existingLease.closing
        const live = writableLeases.get(id)
        if (live) return adoptLeaseEntry(id, live)
      }

      if (opening.has(id)) {
        try {
          await opening.get(id)
        } catch {
          // openCatalog failed; continue to mapping open below.
        }
        const after = getOwnedBinding(id)
        if (after) return adoptRetainedBinding(after)
      }

      const openTask = openWritableLeaseTask(id, publisherId, signal)
      openingLeases.set(id, openTask)
      try {
        const opened = await openTask
        return adoptOpenResult(id, opened)
      } finally {
        if (openingLeases.get(id) === openTask) openingLeases.delete(id)
      }
    },

    async getWritableBindings(options = {}) {
      if (closed) fail('PUBLISHER_CATALOG_REGISTRY_CLOSED')
      const skipPublisherId = options.skipPublisherId
        ? exactBytes(options.skipPublisherId, 32, 'PUBLISHER_REQUEST_INVALID')
        : null
      const signal = options.signal

      // Warm retained localWritables only (≤ soft cap). Cold discovery pages the
      // full writable set so under-cap entries are retained; excess are page-leased
      // and released — never CAPACITY fail-closed, never a full retained-all scan API.
      // Callers needing every persisted writable must listBindingPage + acquireWritableBinding.
      if (!writableDiscoveryComplete) {
        let cursor = null
        do {
          if (signal?.aborted) throw signal.reason || new Error('Aborted')
          const page = await this.listBindingPage({
            cursor,
            limit: Math.min(maxOpenCatalogs, 32),
            writableOnly: true,
            skipPublisherId,
            signal,
          })
          try {
            const pageErrors = page.errors || []
            if (Array.isArray(pageErrors) && pageErrors.length > 0) {
              const first = pageErrors[0]
              const err = new Error(first?.error || 'PUBLISHER_WRITABLE_DISCOVERY_INCOMPLETE')
              err.code = first?.error || 'PUBLISHER_WRITABLE_DISCOVERY_INCOMPLETE'
              err.errors = pageErrors
              throw err
            }
          } finally {
            await page.release?.()
          }
          cursor = page.nextCursor
        } while (cursor)
        if (!skipPublisherId) writableDiscoveryComplete = true
      }

      return [...localWritables.values()]
        .filter(binding => !skipPublisherId || !equalBytes(binding.publisherId, skipPublisherId))
        .filter(binding => isCatalogWritable(binding.catalog))
        .sort((left, right) => b4a.compare(left.publisherId, right.publisherId))
        .map(binding => ({ ...binding }))
    },

    async close() {
      if (closed) return
      closed = true
      writableDiscoveryComplete = false
      await Promise.allSettled([...opening.values()])
      await Promise.allSettled([...openingLeases.values()])
      openingLeases.clear()
      const leased = [...writableLeases.values()]
      writableLeases.clear()
      for (const entry of leased) {
        try { await entry.binding?.catalog?.close?.() } catch { /* close every lease */ }
      }
      const bindings = ownedSnapshot()
      opened.clear()
      localWritables.clear()
      for (const binding of bindings) {
        try { await binding.catalog?.close?.() } catch { /* close every catalog */ }
      }
    }


  }

  function createLeaseReleaser(id, entry) {
    let released = false
    return async () => {
      // Idempotent per returned handle; ABA-safe across lease generations.
      if (released) return
      released = true
      if (writableLeases.get(id) !== entry) return
      entry.refs -= 1
      if (entry.refs > 0) return
      if (entry.closing) {
        await entry.closing
        return
      }
      entry.closing = (async () => {
        if (writableLeases.get(id) === entry) writableLeases.delete(id)
        try { await entry.binding?.catalog?.close?.() } catch { /* best-effort lease close */ }
      })()
      await entry.closing
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
      const registered = options.ctx?.ownResource?.('publisher catalog registry', catalogRegistry, 'close', 5_000) || null
      if (!registered && typeof options.ctx?.lifecycle?.ownResource === 'function') {
        options.ctx.lifecycle.ownResource('publisher catalog registry', catalogRegistry, 'close', 5_000)
      }
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
    const localWriterKey = exactBytes(catalog.localWriterKey || catalog.key, 32, 'PUBLISHER_LOCAL_WRITER_UNAVAILABLE')
    const localSignerKey = exactBytes(catalog.localSignerKey || catalog.localWriterKey || catalog.key, 32, 'PUBLISHER_LOCAL_SIGNER_UNAVAILABLE')
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

  async function pageHasAdmittedOtherWritable(registry, skipPublisherId) {
    if (typeof registry.listBindingPage !== 'function') fail('PUBLISHER_CATALOG_UNAVAILABLE')
    let cursor = null
    do {
      const page = await registry.listBindingPage({
        cursor,
        limit: 16,
        writableOnly: true,
        skipPublisherId,
      })
      try {
        const pageErrors = page?.errors || []
        if (Array.isArray(pageErrors) && pageErrors.length > 0) {
          fail(pageErrors[0]?.error || 'PUBLISHER_CATALOG_UNAVAILABLE')
        }
        for (const candidate of page?.items || []) {
          const publisherId = exactBytes(candidate?.publisherId, 32, 'PUBLISHER_REQUEST_INVALID')
          if (equalBytes(publisherId, skipPublisherId)) continue
          const state = await localCatalogState(candidate, publisherId)
          if (state.namespaceInitialized) return true
        }
      } finally {
        await page?.release?.()
      }
      cursor = page?.nextCursor || null
    } while (cursor)
    return false
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


  function validatePrepareIntentRequest (request, currentTime, intents, maxIntents) {
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
    return { id, publisherId, signerPublicKey, recordType, canonicalBody, displaySummaryJson, signedAt, intentExpiresAt }
  }

  function buildUnsignedNamespaceEnvelope ({ canonicalBody, publisherId, binding, signerPublicKey, signedAt, rawExpiresAt }) {
    const descriptor = decodePublisherNamespaceDescriptor(canonicalBody)
    if (!equalBytes(descriptor.publisherId, publisherId) ||
        !equalBytes(descriptor.publisherRootKey, binding.genesisRootKey) ||
        !equalBytes(descriptor.publisherRootKey, signerPublicKey) ||
        !equalBytes(descriptor.catalogBootstrapKey, binding.catalogBootstrapKey) ||
        descriptor.catalogEpoch !== 0 || descriptor.policySequence !== 0 ||
        descriptor.previousRootKey !== undefined || descriptor.rootTransitionProof !== undefined) {
      fail('PUBLISHER_CATALOG_MISMATCH')
    }
    const envelopeExpiresAt = rawExpiresAt === undefined || rawExpiresAt === null || rawExpiresAt === 0
      ? undefined
      : safeUint(rawExpiresAt)
    if (envelopeExpiresAt !== undefined && envelopeExpiresAt < signedAt) fail('PUBLISHER_RECORD_EXPIRY_INVALID')
    const unsigned = {
      recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
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
    const unsignedBytes = encodeUnsignedSignedEnvelope(unsigned)
    const decoded = decodeUnsignedSignedEnvelope(unsignedBytes)
    if (!equalBytes(decoded.canonicalBody, canonicalBody) || !equalBytes(decoded.signerKey, signerPublicKey)) {
      fail('PUBLISHER_CANONICAL_MISMATCH')
    }
    const candidateRecordId = exactBytes(crypto.hash(unsignedBytes), 32, 'PUBLISHER_CANONICAL_MISMATCH')
    return { unsignedBytes, candidateRecordId, recordExpiresAt: envelopeExpiresAt || 0 }
  }

  async function buildUnsignedRootOperationEnvelope ({ recordType, canonicalBody, publisherId, binding, signerPublicKey, signedAt, rawExpiresAt }) {
    if (rawExpiresAt !== undefined && rawExpiresAt !== null && rawExpiresAt !== 0) {
      fail('PUBLISHER_RECORD_EXPIRY_UNSUPPORTED')
    }
    const body = decodePublisherOperationBody(recordType, canonicalBody)
    const rootAuthorization = await getRootAuthorization(binding, recordType, body)
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
    let unsignedBytes
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
    const candidateRecordId = exactBytes(crypto.hash(unsignedBytes), 32, 'PUBLISHER_CANONICAL_MISMATCH')
    return { unsignedBytes, candidateRecordId, rootAuthorization }
  }

  function validateSubmitRequest (request, intent, currentTime) {
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

    return { unsignedBytes, candidateRecordId, signer, signerPublicKey, signature, isTransition, decoded }
  }

  async function submitStandardRootOp ({ intent, decoded, candidateRecordId, signer, signature, binding }) {
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
      if (error instanceof PublisherApiError) throw error
      fail('PUBLISHER_CATALOG_APPEND_FAILED')
    }
    if (intent.recordType === PUBLISHER_RECORD_TYPES.WRITER_ADMISSION) {
      await completeAdmissionLifecycle(binding)
    }
  }

  async function updatePendingTransitionRecord ({ intent, candidateRecordId, unsignedBytes, signer, signature, signerKind, authorization, currentTime, registry }) {
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
    return pending
  }

  async function submitTransitionRootOp ({ intent, decoded, candidateRecordId, unsignedBytes, signer, signature, binding, currentTime, request, signerPublicKey }) {
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

    const pending = await updatePendingTransitionRecord({
      intent, candidateRecordId, unsignedBytes, signer, signature, signerKind, authorization, currentTime, registry
    })

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
      if (error instanceof PublisherApiError) throw error
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
  }

  return {
    async provisionPublisherCatalog(request = {}) {
      try {
        const publisherId = parsePublisherId(request.publisherId)
        const genesisRootKey = exactBytes(request.genesisRootKey, 32)
        if (!equalBytes(derivePublisherId(genesisRootKey), publisherId)) fail('PUBLISHER_ID_MISMATCH')
        const registry = activeCatalogRegistry()
        if (typeof registry.provision !== 'function' || typeof registry.listBindingPage !== 'function') {
          fail('PUBLISHER_CATALOG_UNAVAILABLE')
        }
        // Page every persisted writable (not warm getWritableBindings) so cold
        // admitted others beyond the soft retain cap still refuse provision.
        if (await pageHasAdmittedOtherWritable(registry, publisherId)) {
          fail('PUBLISHER_CATALOG_AMBIGUOUS')
        }
        const binding = cloneBinding(await registry.provision(publisherId, genesisRootKey), publisherId)
        if (!equalBytes(binding.genesisRootKey, genesisRootKey)) fail('PUBLISHER_CATALOG_MISMATCH')
        const state = await localCatalogState(binding, publisherId)
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
        const prep = validatePrepareIntentRequest(request, currentTime, intents, maxIntents)
        const binding = await resolveBinding(prep.publisherId)

        let unsignedBytes
        let candidateRecordId
        let rootAuthorization = null
        let recordExpiresAt = 0

        if (prep.recordType === PUBLISHER_RECORD_TYPES.NAMESPACE) {
          const res = buildUnsignedNamespaceEnvelope({
            canonicalBody: prep.canonicalBody,
            publisherId: prep.publisherId,
            binding,
            signerPublicKey: prep.signerPublicKey,
            signedAt: prep.signedAt,
            rawExpiresAt: request.expiresAt
          })
          unsignedBytes = res.unsignedBytes
          candidateRecordId = res.candidateRecordId
          recordExpiresAt = res.recordExpiresAt
        } else {
          const res = await buildUnsignedRootOperationEnvelope({
            recordType: prep.recordType,
            canonicalBody: prep.canonicalBody,
            publisherId: prep.publisherId,
            binding,
            signerPublicKey: prep.signerPublicKey,
            signedAt: prep.signedAt,
            rawExpiresAt: request.expiresAt
          })
          unsignedBytes = res.unsignedBytes
          candidateRecordId = res.candidateRecordId
          rootAuthorization = res.rootAuthorization
        }

        intents.set(prep.id, {
          intentId: prep.id,
          publisherId: publisherHex(prep.publisherId),
          publisherIdBytes: b4a.from(prep.publisherId),
          recordType: prep.recordType,
          signerPublicKey: b4a.from(prep.signerPublicKey),
          unsignedBytes: b4a.from(unsignedBytes),
          candidateRecordId: b4a.from(candidateRecordId),
          catalogBootstrapKey: b4a.from(binding.catalogBootstrapKey),
          displaySummaryJson: prep.displaySummaryJson,
          issuedAt: prep.signedAt,
          intentExpiresAt: prep.intentExpiresAt,
          rootAuthorization
        })

        return {
          intentId: prep.id,
          success: true,
          publisherId: publisherHex(prep.publisherId),
          recordType: prep.recordType,
          unsignedBytes: b4a.from(unsignedBytes),
          candidateRecordId: b4a.from(candidateRecordId),
          signerPublicKey: b4a.from(prep.signerPublicKey),
          bodyLength: prep.canonicalBody.byteLength,
          issuedAt: prep.signedAt,
          expiresAt: recordExpiresAt,
          intentExpiresAt: prep.intentExpiresAt,
          displaySummaryJson: prep.displaySummaryJson,
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
        const validated = validateSubmitRequest(request, intent, currentTime)
        const { candidateRecordId, signer, signerPublicKey, signature, isTransition, decoded, unsignedBytes } = validated

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
          await submitStandardRootOp({ intent, decoded, candidateRecordId, signer, signature, binding })
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

        return await submitTransitionRootOp({
          intent, decoded, candidateRecordId, unsignedBytes, signer, signature, binding, currentTime, request, signerPublicKey
        })
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
