import b4a from 'b4a'

import { DEFAULT_NETWORK_POLICY, normalizeNetworkPolicy } from '../api/policy.js'
import {
  MAX_PORTABLE_ARCHIVE_EVIDENCE,
  MAX_PORTABLE_EVIDENCE_BYTES,
  MAX_PORTABLE_FOLLOWED_FEEDS,
  MAX_PORTABLE_GRAPH_PREFERENCES,
  MAX_PORTABLE_INDEX_PREFERENCES,
  MAX_PORTABLE_ITEMS,
  MAX_PORTABLE_MANIFEST_BYTES,
  PORTABLE_STATE_ERROR_CODES,
  PORTABLE_STATE_SCHEMA,
  PORTABLE_STATE_VERSION
} from './constants.js'
import {
  assertExactFields,
  boundedString,
  boundedUint,
  denseArray,
  encodeCanonicalPortableJson,
  equalBytes,
  hex32,
  isPlainObject,
  readOwnDataField,
  sha256Hex
} from './canonical.js'
import { failPortableState } from './errors.js'
import { normalizePublisherCatalogs } from './publisher-history.js'

const ARCHIVE_EVIDENCE_KINDS = new Set([
  'archive-pledge',
  'archive-challenge-response',
  'archive-observation',
  'offload-assessment',
  'offload-confirmation'
])

const POLICY_FIELDS = Object.freeze([
  'uploadPermission',
  'meteredNetwork',
  'backgroundMode',
  'diskCeilingBytes',
  'uploadCeilingBytes',
  'retentionMode',
  'aiAnalysis'
])

function duplicate (seen, id, name) {
  if (seen.has(id)) failPortableState(PORTABLE_STATE_ERROR_CODES.DUPLICATE_ID, `${name} contains duplicate id ${id}`)
  seen.add(id)
}

function normalizeGraphPreferences (value, { exact = false } = {}) {
  const preferences = denseArray(value, 'graphPreferences', MAX_PORTABLE_GRAPH_PREFERENCES).map((entry, index) => {
    if (!isPlainObject(entry)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `graphPreferences[${index}] must be an object`)
    if (exact) assertExactFields(entry, ['entityId', 'publicationId', 'preferred'], `graphPreferences[${index}]`)
    const preferred = readOwnDataField(entry, 'preferred')
    if (typeof preferred !== 'boolean') failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `graphPreferences[${index}].preferred must be boolean`)
    return {
      entityId: hex32(readOwnDataField(entry, 'entityId'), `graphPreferences[${index}].entityId`),
      publicationId: hex32(readOwnDataField(entry, 'publicationId'), `graphPreferences[${index}].publicationId`),
      preferred
    }
  }).sort((left, right) => left.entityId.localeCompare(right.entityId) || left.publicationId.localeCompare(right.publicationId))
  const ids = new Set()
  for (const entry of preferences) duplicate(ids, `${entry.entityId}:${entry.publicationId}`, 'graphPreferences')
  return preferences
}

function normalizeIndexPreferences (value, { exact = false } = {}) {
  const preferences = denseArray(value, 'indexPreferences', MAX_PORTABLE_INDEX_PREFERENCES).map((entry, index) => {
    if (!isPlainObject(entry)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `indexPreferences[${index}] must be an object`)
    if (exact) assertExactFields(entry, ['indexId', 'enabled', 'priority'], `indexPreferences[${index}]`)
    const enabled = readOwnDataField(entry, 'enabled')
    const priority = readOwnDataField(entry, 'priority')
    if (typeof enabled !== 'boolean') failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `indexPreferences[${index}].enabled must be boolean`)
    if (!Number.isSafeInteger(priority) || priority < 0 || priority > 1000) {
      failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `indexPreferences[${index}].priority is out of bounds`)
    }
    return {
      indexId: hex32(readOwnDataField(entry, 'indexId'), `indexPreferences[${index}].indexId`),
      enabled,
      priority
    }
  }).sort((left, right) => left.indexId.localeCompare(right.indexId))
  const ids = new Set()
  for (const entry of preferences) duplicate(ids, entry.indexId, 'indexPreferences')
  return preferences
}

function normalizeFeedList (value, name) {
  const list = denseArray(value, name, MAX_PORTABLE_FOLLOWED_FEEDS)
    .map((entry, index) => hex32(entry, `${name}[${index}]`))
    .sort()
  const ids = new Set()
  for (const id of list) duplicate(ids, id, name)
  return list
}

function normalizeFollowedFeeds (value, { exact = false, policy = null } = {}) {
  const input = isPlainObject(value) ? value : {}
  if (exact) assertExactFields(input, ['publishers', 'indexes', 'moderation'], 'followedFeeds')
  const publishers = readOwnDataField(input, 'publishers') ?? readOwnDataField(policy, 'followedPublishers') ?? []
  const indexes = readOwnDataField(input, 'indexes') ?? readOwnDataField(policy, 'followedIndexes') ?? []
  const moderation = readOwnDataField(input, 'moderation') ?? readOwnDataField(policy, 'trustedModerationFeeds') ?? []
  return {
    publishers: normalizeFeedList(publishers, 'followedFeeds.publishers'),
    indexes: normalizeFeedList(indexes, 'followedFeeds.indexes'),
    moderation: normalizeFeedList(moderation, 'followedFeeds.moderation')
  }
}

function evidenceBytes (value, name) {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength === 0 || value.byteLength > MAX_PORTABLE_EVIDENCE_BYTES) {
      failPortableState(PORTABLE_STATE_ERROR_CODES.TOO_LARGE, `${name} exceeds its byte limit`)
    }
    return b4a.from(value)
  }
  if (typeof value !== 'string' || value.length === 0 || (value.length & 1) !== 0 || !/^[0-9a-f]+$/.test(value)) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `${name} must be canonical lowercase hex`)
  }
  const bytes = b4a.from(value, 'hex')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PORTABLE_EVIDENCE_BYTES) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.TOO_LARGE, `${name} exceeds its byte limit`)
  }
  return bytes
}

async function normalizeArchiveEvidence (value, { exact = false, verifyArchiveEvidence } = {}) {
  const input = denseArray(value, 'archiveEvidence', MAX_PORTABLE_ARCHIVE_EVIDENCE)
  const evidence = []
  const ids = new Set()
  for (let index = 0; index < input.length; index++) {
    const entry = input[index]
    if (!isPlainObject(entry)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `archiveEvidence[${index}] must be an object`)
    if (exact) assertExactFields(entry, ['id', 'kind', 'envelope', 'checkpoint'], `archiveEvidence[${index}]`)
    const id = hex32(readOwnDataField(entry, 'id'), `archiveEvidence[${index}].id`)
    duplicate(ids, id, 'archiveEvidence')
    const kind = boundedString(readOwnDataField(entry, 'kind'), `archiveEvidence[${index}].kind`, 64)
    if (!ARCHIVE_EVIDENCE_KINDS.has(kind)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `archiveEvidence[${index}].kind is unsupported`)
    const envelope = evidenceBytes(readOwnDataField(entry, 'envelope'), `archiveEvidence[${index}].envelope`)
    const checkpointInput = readOwnDataField(entry, 'checkpoint')
    if (exact) assertExactFields(checkpointInput, ['sequence', 'digest'], `archiveEvidence[${index}].checkpoint`)
    const sequence = checkpointInput === undefined
      ? 0
      : boundedUint(readOwnDataField(checkpointInput, 'sequence'), `archiveEvidence[${index}].checkpoint.sequence`)
    const derivedDigest = sha256Hex(envelope)

    if (typeof verifyArchiveEvidence !== 'function') {
      failPortableState(PORTABLE_STATE_ERROR_CODES.SIGNATURE_INVALID, 'archive evidence requires an explicit signature verifier')
    }
    let verified = false
    try {
      verified = await verifyArchiveEvidence(Object.freeze({ id, kind, envelope: b4a.from(envelope), checkpoint: Object.freeze({ sequence, digest: derivedDigest }) }))
    } catch {
      verified = false
    }
    if (verified !== true) failPortableState(PORTABLE_STATE_ERROR_CODES.SIGNATURE_INVALID, `archive evidence ${id} has an invalid signature`)

    if (exact) {
      const suppliedDigest = hex32(readOwnDataField(checkpointInput, 'digest'), `archiveEvidence[${index}].checkpoint.digest`)
      if (suppliedDigest !== derivedDigest) failPortableState(PORTABLE_STATE_ERROR_CODES.CHECKPOINT_INVALID, `archive evidence ${id} checkpoint does not match its envelope`)
    }
    evidence.push({ id, kind, envelope: b4a.toString(envelope, 'hex'), checkpoint: { sequence, digest: derivedDigest } })
  }
  evidence.sort((left, right) => left.id.localeCompare(right.id))
  return evidence
}

function normalizePolicy (value, { exact = false } = {}) {
  const input = isPlainObject(value) ? value : {}
  if (exact) assertExactFields(input, POLICY_FIELDS, 'policy')
  let policy
  try {
    policy = normalizeNetworkPolicy(input, DEFAULT_NETWORK_POLICY)
  } catch (error) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `portable policy is invalid: ${error?.message || String(error)}`)
  }
  return {
    uploadPermission: policy.uploadPermission,
    meteredNetwork: policy.meteredNetwork,
    backgroundMode: policy.backgroundMode,
    diskCeilingBytes: policy.diskCeilingBytes,
    uploadCeilingBytes: policy.uploadCeilingBytes,
    retentionMode: policy.retentionMode,
    aiAnalysis: policy.aiAnalysis
  }
}

function requireStateObject (value, exact) {
  if (!isPlainObject(value)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'portable state must be an object')
  if (exact) assertExactFields(value, [
    'publisherCatalogs',
    'graphPreferences',
    'indexPreferences',
    'followedFeeds',
    'archiveEvidence',
    'policy'
  ], 'portable state')
  return value
}

function preflightPortableItemCount (state) {
  let count = 1
  const publisherCatalogs = readOwnDataField(state, 'publisherCatalogs')
  if (Array.isArray(publisherCatalogs)) {
    count += publisherCatalogs.length
    for (const catalog of publisherCatalogs) {
      const history = readOwnDataField(catalog, 'rootHistory')
      if (Array.isArray(history)) count += history.length
    }
  }
  for (const field of ['graphPreferences', 'indexPreferences', 'archiveEvidence']) {
    const entries = readOwnDataField(state, field)
    if (Array.isArray(entries)) count += entries.length
  }
  const followedFeeds = readOwnDataField(state, 'followedFeeds')
  for (const field of ['publishers', 'indexes', 'moderation']) {
    const entries = readOwnDataField(followedFeeds, field)
    if (Array.isArray(entries)) count += entries.length
  }
  if (count > MAX_PORTABLE_ITEMS) failPortableState(PORTABLE_STATE_ERROR_CODES.ITEM_LIMIT, 'portable state exceeds its total item limit')
}

export function countPortableStateItems (state) {
  let count = 1
  count += state.publisherCatalogs.length
  for (const catalog of state.publisherCatalogs) count += catalog.rootHistory.length
  count += state.graphPreferences.length
  count += state.indexPreferences.length
  count += state.followedFeeds.publishers.length
  count += state.followedFeeds.indexes.length
  count += state.followedFeeds.moderation.length
  count += state.archiveEvidence.length
  if (count > MAX_PORTABLE_ITEMS) failPortableState(PORTABLE_STATE_ERROR_CODES.ITEM_LIMIT, 'portable state exceeds its total item limit')
  return count
}

async function normalizeState (raw, options) {
  const input = requireStateObject(raw, options.exact)
  preflightPortableItemCount(input)
  const policyInput = readOwnDataField(input, 'policy')
  const state = {
    publisherCatalogs: normalizePublisherCatalogs(readOwnDataField(input, 'publisherCatalogs') ?? [], options),
    graphPreferences: normalizeGraphPreferences(readOwnDataField(input, 'graphPreferences') ?? [], options),
    indexPreferences: normalizeIndexPreferences(readOwnDataField(input, 'indexPreferences') ?? [], options),
    followedFeeds: normalizeFollowedFeeds(readOwnDataField(input, 'followedFeeds'), { ...options, policy: policyInput }),
    archiveEvidence: await normalizeArchiveEvidence(readOwnDataField(input, 'archiveEvidence') ?? [], options),
    policy: normalizePolicy(policyInput, options)
  }
  countPortableStateItems(state)
  return state
}

export async function createPortableStateManifest (rawState, options = {}) {
  const createdAt = boundedUint(options.createdAt, 'createdAt')
  return {
    schema: PORTABLE_STATE_SCHEMA,
    version: PORTABLE_STATE_VERSION,
    createdAt,
    state: await normalizeState(rawState, { exact: false, verifyArchiveEvidence: options.verifyArchiveEvidence })
  }
}

async function normalizePortableManifest (value, options = {}) {
  assertExactFields(value, ['schema', 'version', 'createdAt', 'state'], 'portable-state manifest')
  if (value.schema !== PORTABLE_STATE_SCHEMA) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'portable-state manifest schema is invalid')
  if (value.version !== PORTABLE_STATE_VERSION) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.UNSUPPORTED_VERSION, `portable-state version ${value.version} is unsupported`)
  }
  return {
    schema: PORTABLE_STATE_SCHEMA,
    version: PORTABLE_STATE_VERSION,
    createdAt: boundedUint(value.createdAt, 'portable-state manifest.createdAt'),
    state: await normalizeState(value.state, { exact: true, verifyArchiveEvidence: options.verifyArchiveEvidence })
  }
}

export function digestPortableManifestBytes (manifestBytes) {
  if (!(b4a.isBuffer(manifestBytes) || manifestBytes instanceof Uint8Array)) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_REQUEST, 'manifestBytes must be bytes')
  }
  if (manifestBytes.byteLength === 0 || manifestBytes.byteLength > MAX_PORTABLE_MANIFEST_BYTES) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.TOO_LARGE, 'portable-state manifest exceeds its byte limit')
  }
  return sha256Hex(manifestBytes)
}

export async function encodePortableStateManifest (manifest, options = {}) {
  const normalized = await normalizePortableManifest(manifest, options)
  return encodeCanonicalPortableJson(normalized)
}

export async function decodePortableStateManifest (manifestBytes, options = {}) {
  if (!(b4a.isBuffer(manifestBytes) || manifestBytes instanceof Uint8Array)) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_REQUEST, 'manifestBytes must be bytes')
  }
  if (manifestBytes.byteLength === 0 || manifestBytes.byteLength > MAX_PORTABLE_MANIFEST_BYTES) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.TOO_LARGE, 'portable-state manifest exceeds its byte limit')
  }
  const bytes = b4a.from(manifestBytes)
  const digest = digestPortableManifestBytes(bytes)
  if (options.expectedDigest !== undefined) {
    const expected = hex32(options.expectedDigest, 'manifestDigest')
    if (expected !== digest) failPortableState(PORTABLE_STATE_ERROR_CODES.CHECKSUM_MISMATCH, 'portable-state manifest digest does not match manifestBytes')
  }
  let decoded
  try {
    decoded = JSON.parse(b4a.toString(bytes))
  } catch (error) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `portable-state manifest is not valid JSON: ${error?.message || String(error)}`)
  }
  const canonical = encodeCanonicalPortableJson(decoded)
  if (!equalBytes(bytes, canonical)) failPortableState(PORTABLE_STATE_ERROR_CODES.NONCANONICAL, 'portable-state manifest bytes are noncanonical')
  const manifest = await normalizePortableManifest(decoded, options)
  return { manifest, manifestDigest: digest, itemCount: countPortableStateItems(manifest.state) }
}
