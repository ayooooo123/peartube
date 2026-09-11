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

function validatePublisherDeviceInputs (authorizationState, localDevice) {
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

  return {
    publisherId,
    devicePublicKey,
    writerKey,
    catalogEpoch,
    policyEpoch,
    activeRootKey,
    localCatalogEpoch,
    localPolicyEpoch
  }
}

function evaluateWriterStatus (writerKey, writer, devicePublicKey) {
  if (!writerKey) {
    return { status: 'unable-to-publish', reasonCode: 'LOCAL_WRITER_UNAVAILABLE' }
  }
  if (!writer) {
    return { status: 'unable-to-publish', reasonCode: 'DEVICE_NOT_ADMITTED' }
  }
  if (!devicePublicKey) {
    return { status: 'unable-to-publish', reasonCode: 'LOCAL_SIGNER_UNAVAILABLE' }
  }
  if (!b4a.equals(bytes32(writer.signerKey, 'writer.signerKey'), devicePublicKey)) {
    return { status: 'unable-to-publish', reasonCode: 'DEVICE_SIGNER_MISMATCH' }
  }
  if (writer.revocation) {
    return { status: 'revoked', reasonCode: 'DEVICE_REVOKED' }
  }
  return { status: 'authorized', reasonCode: null }
}

function determineDeviceStatusAndReason ({
  localDevice,
  activeRootKey,
  catalogEpoch,
  policyEpoch,
  localCatalogEpoch,
  localPolicyEpoch,
  writerKey,
  writer,
  devicePublicKey,
  legacyImportState
}) {
  let status = 'authority-lost'
  let reasonCode = 'ROOT_AUTHORITY_LOST'
  let rootAuthorityCurrent = false

  if (localDevice.hasRootAuthority) {
    const rootPublicKey = bytes32(localDevice.rootPublicKey, 'localDevice.rootPublicKey')
    if (!b4a.equals(rootPublicKey, activeRootKey)) {
      reasonCode = 'ROOT_AUTHORITY_ROTATED'
    } else {
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

  if (rootAuthorityCurrent && localCatalogEpoch === catalogEpoch && localPolicyEpoch === policyEpoch) {
    const writerEval = evaluateWriterStatus(writerKey, writer, devicePublicKey)
    status = writerEval.status
    reasonCode = writerEval.reasonCode
  }

  if (legacyImportState === 'failed') {
    status = 'unable-to-publish'
    reasonCode = 'LEGACY_IMPORT_FAILED'
  }

  return { status, reasonCode, rootAuthorityCurrent }
}

export function projectPublisherDeviceStatus ({ authorizationState, localDevice, legacyImport } = {}) {
  const inputs = validatePublisherDeviceInputs(authorizationState, localDevice)
  const legacyImportState = normalizeLegacyImportState(legacyImport)
  const writer = writerForDevice(authorizationState, inputs.writerKey)
  const { status, reasonCode, rootAuthorityCurrent } = determineDeviceStatusAndReason({
    localDevice,
    activeRootKey: inputs.activeRootKey,
    catalogEpoch: inputs.catalogEpoch,
    policyEpoch: inputs.policyEpoch,
    localCatalogEpoch: inputs.localCatalogEpoch,
    localPolicyEpoch: inputs.localPolicyEpoch,
    writerKey: inputs.writerKey,
    writer,
    devicePublicKey: inputs.devicePublicKey,
    legacyImportState
  })

  const projected = {
    publisherId: inputs.publisherId,
    status,
    canPublish: status === 'authorized',
    canPlayLocal: true,
    canExportLocal: true,
    canDeleteLocal: true,
    canRootTransition: rootAuthorityCurrent && status !== 'stale' && legacyImportState !== 'failed',
    catalogEpoch: inputs.catalogEpoch,
    policyEpoch: inputs.policyEpoch
  }
  if (reasonCode) projected.reasonCode = reasonCode
  if (inputs.devicePublicKey) projected.devicePublicKey = inputs.devicePublicKey
  if (writer) projected.admissionExpiresAt = uint(writer.expiresAt, 'writer.expiresAt')
  if (writer?.revocation) projected.revocationCutoff = uint(writer.revocation.acceptedThroughSequence, 'writer.revocation.acceptedThroughSequence')
  if (legacyImportState) projected.legacyImportState = legacyImportState
  return Object.freeze(projected)
}
