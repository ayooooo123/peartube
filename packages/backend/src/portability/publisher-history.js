import b4a from 'b4a'

import {
  PUBLISHER_RECORD_TYPES,
  createPublisherAuthorizationState,
  createPublisherKeyProvider,
  decodePublisherCatalogFrame,
  decodePublisherNamespaceDescriptor,
  encodePublisherAuthorizationState,
  encodePublisherCatalogFrame,
  reducePublisherOperation
} from '../publisher/index.js'
import {
  MAX_PORTABLE_PUBLISHERS,
  MAX_PORTABLE_ROOT_HISTORY,
  PORTABLE_STATE_ERROR_CODES
} from './constants.js'
import {
  assertExactFields,
  boundedUint,
  denseArray,
  encodeCanonicalPortableJson,
  hex32,
  isPlainObject,
  readOwnDataField,
  sha256Hex
} from './canonical.js'
import { failPortableState } from './errors.js'

function frameBytes (value, name) {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength === 0) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `${name} must not be empty`)
    return b4a.from(value)
  }
  if (typeof value !== 'string' || value.length === 0 || (value.length & 1) !== 0 || !/^[0-9a-f]+$/.test(value)) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `${name} must be canonical lowercase hex`)
  }
  return b4a.from(value, 'hex')
}

function verifyGenesis (value, descriptor, publisherId, catalogBootstrapKey, provider) {
  if (value.transitionId || value.recordType !== PUBLISHER_RECORD_TYPES.NAMESPACE) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'publisher root history must begin with a namespace genesis')
  }
  if (value.schemaMajor !== 1 || value.schemaMinor !== 0 || value.policyEpoch !== 0 || value.issuerSequence !== 0) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'publisher namespace genesis version and sequence are fixed')
  }
  if (hex32(descriptor.publisherId, 'namespace publisherId') !== publisherId ||
      hex32(descriptor.catalogBootstrapKey, 'namespace catalogBootstrapKey') !== catalogBootstrapKey ||
      hex32(value.issuerIdentityKey, 'namespace issuerIdentityKey') !== publisherId ||
      hex32(value.signerKey, 'namespace signerKey') !== hex32(descriptor.publisherRootKey, 'namespace publisherRootKey')) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'publisher namespace genesis does not match its catalog identity')
  }
  try {
    provider.verifySignedEnvelope(value, {
      issuerIdentityKey: descriptor.publisherId,
      policyEpoch: 0,
      authorizeSigner: candidate => b4a.equals(candidate.signerKey, descriptor.publisherRootKey),
      authorizeSequence: candidate => candidate.issuerSequence === 0,
      claimReplay: () => true,
      now: value.signedAt,
      maxClockSkew: 0
    })
  } catch (error) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.SIGNATURE_INVALID, `publisher namespace signature is invalid: ${error?.message || String(error)}`)
  }
}

function derivedRecoveryMetadata (state) {
  return {
    activeRootKey: hex32(state.activeRootKey, 'activeRootKey'),
    catalogEpoch: boundedUint(state.catalogEpoch, 'catalogEpoch'),
    policyEpoch: boundedUint(state.policyEpoch, 'policyEpoch'),
    policySequence: boundedUint(state.policySequence, 'policySequence'),
    recoveryKeys: state.recoveryKeys.map((key, index) => hex32(key, `recoveryKeys[${index}]`)),
    recoveryThreshold: boundedUint(state.recoveryThreshold, 'recoveryThreshold')
  }
}

function normalizeRecoveryMetadata (value) {
  assertExactFields(value, [
    'activeRootKey',
    'catalogEpoch',
    'policyEpoch',
    'policySequence',
    'recoveryKeys',
    'recoveryThreshold'
  ], 'publisher recoveryMetadata')
  const recoveryKeys = denseArray(value.recoveryKeys, 'publisher recoveryMetadata.recoveryKeys', 16)
    .map((key, index) => hex32(key, `publisher recoveryMetadata.recoveryKeys[${index}]`))
  return {
    activeRootKey: hex32(value.activeRootKey, 'publisher recoveryMetadata.activeRootKey'),
    catalogEpoch: boundedUint(value.catalogEpoch, 'publisher recoveryMetadata.catalogEpoch'),
    policyEpoch: boundedUint(value.policyEpoch, 'publisher recoveryMetadata.policyEpoch'),
    policySequence: boundedUint(value.policySequence, 'publisher recoveryMetadata.policySequence'),
    recoveryKeys,
    recoveryThreshold: boundedUint(value.recoveryThreshold, 'publisher recoveryMetadata.recoveryThreshold')
  }
}

function derivedCheckpoint (history, state, provider) {
  return {
    operationCount: history.length,
    historyDigest: sha256Hex(encodeCanonicalPortableJson(history)),
    authorizationStateDigest: b4a.toString(provider.hash(encodePublisherAuthorizationState(state)), 'hex')
  }
}

function normalizeCheckpoint (value) {
  assertExactFields(value, ['operationCount', 'historyDigest', 'authorizationStateDigest'], 'publisher checkpoint')
  return {
    operationCount: boundedUint(value.operationCount, 'publisher checkpoint.operationCount'),
    historyDigest: hex32(value.historyDigest, 'publisher checkpoint.historyDigest'),
    authorizationStateDigest: hex32(value.authorizationStateDigest, 'publisher checkpoint.authorizationStateDigest')
  }
}

function sameCanonicalValue (left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function normalizePublisherCatalog (input, { exact = false } = {}) {
  if (!isPlainObject(input)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'publisher catalog must be an object')
  if (exact) assertExactFields(input, ['publisherId', 'catalogBootstrapKey', 'rootHistory', 'recoveryMetadata', 'checkpoint'], 'publisher catalog')

  const publisherId = hex32(readOwnDataField(input, 'publisherId'), 'publisher catalog.publisherId')
  const catalogBootstrapKey = hex32(readOwnDataField(input, 'catalogBootstrapKey'), 'publisher catalog.catalogBootstrapKey')
  const sourceHistory = denseArray(readOwnDataField(input, 'rootHistory'), 'publisher catalog.rootHistory', MAX_PORTABLE_ROOT_HISTORY)
  if (sourceHistory.length === 0) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'publisher catalog.rootHistory must include genesis')

  const provider = createPublisherKeyProvider()
  const history = []
  const decoded = []
  const operationIds = new Set()
  for (let index = 0; index < sourceHistory.length; index++) {
    const entry = sourceHistory[index]
    if (!isPlainObject(entry)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `publisher rootHistory[${index}] must be an object`)
    if (exact) assertExactFields(entry, ['frame'], `publisher rootHistory[${index}]`)
    const bytes = frameBytes(readOwnDataField(entry, 'frame'), `publisher rootHistory[${index}].frame`)
    let operation
    try {
      operation = decodePublisherCatalogFrame(bytes)
      const canonical = encodePublisherCatalogFrame(operation)
      if (!b4a.equals(bytes, canonical)) failPortableState(PORTABLE_STATE_ERROR_CODES.NONCANONICAL, `publisher rootHistory[${index}] frame is noncanonical`)
    } catch (error) {
      if (error?.code) throw error
      failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `publisher rootHistory[${index}] frame is invalid: ${error?.message || String(error)}`)
    }
    const operationId = hex32(operation.recordId || operation.transitionId, `publisher rootHistory[${index}] operationId`)
    if (operationIds.has(operationId)) failPortableState(PORTABLE_STATE_ERROR_CODES.DUPLICATE_ID, `publisher root history contains duplicate operation ${operationId}`)
    operationIds.add(operationId)
    history.push({ frame: b4a.toString(bytes, 'hex') })
    decoded.push(operation)
  }

  let descriptor
  try {
    descriptor = decodePublisherNamespaceDescriptor(decoded[0].canonicalBody)
  } catch (error) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `publisher namespace descriptor is invalid: ${error?.message || String(error)}`)
  }
  verifyGenesis(decoded[0], descriptor, publisherId, catalogBootstrapKey, provider)

  const state = createPublisherAuthorizationState(descriptor)
  for (let index = 1; index < decoded.length; index++) {
    const operation = decoded[index]
    if (operation.recordType !== PUBLISHER_RECORD_TYPES.ROOT_TRANSITION || !operation.transitionId) {
      failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'publisher public root history may contain only root transitions after genesis')
    }
    const reduced = reducePublisherOperation(state, operation, { keyProvider: provider })
    if (!reduced.accepted) {
      const signatureFailure = /signature|signer|quorum/i.test(`${reduced.code} ${reduced.error || ''}`)
      failPortableState(
        signatureFailure ? PORTABLE_STATE_ERROR_CODES.SIGNATURE_INVALID : PORTABLE_STATE_ERROR_CODES.INVALID_FIELD,
        `publisher root transition is invalid: ${reduced.code}${reduced.error ? ` (${reduced.error})` : ''}`
      )
    }
  }

  const recoveryMetadata = derivedRecoveryMetadata(state)
  const checkpoint = derivedCheckpoint(history, state, provider)
  if (exact) {
    const suppliedRecovery = normalizeRecoveryMetadata(readOwnDataField(input, 'recoveryMetadata'))
    const suppliedCheckpoint = normalizeCheckpoint(readOwnDataField(input, 'checkpoint'))
    if (!sameCanonicalValue(suppliedRecovery, recoveryMetadata)) {
      failPortableState(PORTABLE_STATE_ERROR_CODES.CHECKPOINT_INVALID, 'publisher recovery metadata does not match verified root history')
    }
    if (!sameCanonicalValue(suppliedCheckpoint, checkpoint)) {
      failPortableState(PORTABLE_STATE_ERROR_CODES.CHECKPOINT_INVALID, 'publisher checkpoint does not match verified root history')
    }
  }

  return { publisherId, catalogBootstrapKey, rootHistory: history, recoveryMetadata, checkpoint }
}

export function normalizePublisherCatalogs (value, options = {}) {
  const catalogs = denseArray(value, 'publisherCatalogs', MAX_PORTABLE_PUBLISHERS)
    .map(catalog => normalizePublisherCatalog(catalog, options))
    .sort((left, right) => left.publisherId.localeCompare(right.publisherId))
  const ids = new Set()
  for (const catalog of catalogs) {
    if (ids.has(catalog.publisherId)) failPortableState(PORTABLE_STATE_ERROR_CODES.DUPLICATE_ID, `duplicate publisher catalog ${catalog.publisherId}`)
    ids.add(catalog.publisherId)
  }
  return catalogs
}
