import b4a from 'b4a'

function invalid (message) {
  throw new Error(`Invalid publisher device status: ${message}`)
}

function bytes32 (value, name) {
  if ((!b4a.isBuffer(value) && !(value instanceof Uint8Array)) || value.byteLength !== 32) invalid(`${name} must be 32 bytes`)
  return b4a.from(value)
}

function uint (value, name) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} is out of bounds`)
  return value
}

function writerForDevice (authorizationState, writerKey) {
  if (!(authorizationState.writers instanceof Map)) invalid('authorizationState.writers must be a Map')
  if (!writerKey) return null
  return authorizationState.writers.get(b4a.toString(writerKey, 'hex')) || null
}

const LEGACY_IMPORT_STATES = new Set([
  'not-required',
  'pending',
  'running',
  'complete',
  'failed',
  'retrying'
])

function normalizeLegacyImportState (legacyImport) {
  if (legacyImport == null) return null
  if (!legacyImport || typeof legacyImport !== 'object' || !LEGACY_IMPORT_STATES.has(legacyImport.state)) {
    invalid('legacyImport.state is invalid')
  }
  return legacyImport.state
}

export function projectPublisherDeviceStatus ({ authorizationState, localDevice, legacyImport } = {}) {
  if (!authorizationState || typeof authorizationState !== 'object') invalid('authorizationState is required')
  if (!localDevice || typeof localDevice !== 'object') invalid('localDevice is required')

  const publisherId = bytes32(authorizationState.publisherId, 'authorizationState.publisherId')
  const devicePublicKey = localDevice.devicePublicKey == null
    ? null
    : bytes32(localDevice.devicePublicKey, 'localDevice.devicePublicKey')
  const writerKey = localDevice.writerKey == null
    ? null
    : bytes32(localDevice.writerKey, 'localDevice.writerKey')
  const catalogEpoch = uint(authorizationState.catalogEpoch, 'authorizationState.catalogEpoch')
  const policyEpoch = uint(authorizationState.policyEpoch, 'authorizationState.policyEpoch')
  const activeRootKey = bytes32(authorizationState.activeRootKey, 'authorizationState.activeRootKey')
  if (typeof localDevice.hasRootAuthority !== 'boolean') invalid('localDevice.hasRootAuthority must be a boolean')
  const localCatalogEpoch = uint(localDevice.catalogEpoch, 'localDevice.catalogEpoch')
  const localPolicyEpoch = uint(localDevice.policyEpoch, 'localDevice.policyEpoch')
  if (localCatalogEpoch > catalogEpoch) invalid('localDevice.catalogEpoch is ahead of the catalog')
  if (localPolicyEpoch > policyEpoch) invalid('localDevice.policyEpoch is ahead of the catalog')
  const legacyImportState = normalizeLegacyImportState(legacyImport)

  let status = 'authority-lost'
  let reasonCode = 'ROOT_AUTHORITY_LOST'
  let rootAuthorityCurrent = false
  if (localDevice.hasRootAuthority) {
    const rootPublicKey = bytes32(localDevice.rootPublicKey, 'localDevice.rootPublicKey')
    if (!b4a.equals(rootPublicKey, activeRootKey)) reasonCode = 'ROOT_AUTHORITY_ROTATED'
    else {
      rootAuthorityCurrent = true
      if (localCatalogEpoch < catalogEpoch) {
        status = 'stale'
        reasonCode = 'LOCAL_CATALOG_STALE'
      } else if (localPolicyEpoch < policyEpoch) {
        status = 'stale'
        reasonCode = 'LOCAL_POLICY_STALE'
      }
    }
  }
  const writer = writerForDevice(authorizationState, writerKey)
  if (rootAuthorityCurrent && localCatalogEpoch === catalogEpoch && localPolicyEpoch === policyEpoch) {
    if (!writerKey) {
      status = 'unable-to-publish'
      reasonCode = 'LOCAL_WRITER_UNAVAILABLE'
    } else if (!writer) {
      status = 'unable-to-publish'
      reasonCode = 'DEVICE_NOT_ADMITTED'
    } else if (!devicePublicKey) {
      status = 'unable-to-publish'
      reasonCode = 'LOCAL_SIGNER_UNAVAILABLE'
    } else if (!b4a.equals(bytes32(writer.signerKey, 'writer.signerKey'), devicePublicKey)) {
      status = 'unable-to-publish'
      reasonCode = 'DEVICE_SIGNER_MISMATCH'
    } else if (writer.revocation) {
      status = 'revoked'
      reasonCode = 'DEVICE_REVOKED'
    } else {
      status = 'authorized'
      reasonCode = null
    }
  }
  if (legacyImportState === 'failed') {
    status = 'unable-to-publish'
    reasonCode = 'LEGACY_IMPORT_FAILED'
  }
  const projected = {
    publisherId,
    status,
    canPublish: status === 'authorized',
    canPlayLocal: true,
    canExportLocal: true,
    canDeleteLocal: true,
    canRootTransition: rootAuthorityCurrent && status !== 'stale' && legacyImportState !== 'failed',
    catalogEpoch,
    policyEpoch
  }
  if (reasonCode) projected.reasonCode = reasonCode
  if (devicePublicKey) projected.devicePublicKey = devicePublicKey
  if (writer) projected.admissionExpiresAt = uint(writer.expiresAt, 'writer.expiresAt')
  if (writer?.revocation) projected.revocationCutoff = uint(writer.revocation.acceptedThroughSequence, 'writer.revocation.acceptedThroughSequence')
  if (legacyImportState) projected.legacyImportState = legacyImportState
  return Object.freeze(projected)
}
