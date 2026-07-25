import test from 'brittle'
import b4a from 'b4a'

import { projectPublisherDeviceStatus } from '../src/publisher/device-status.js'

const key = seed => b4a.alloc(32, seed)
const hex = value => b4a.toString(value, 'hex')

function fixture () {
  const publisherId = key(1)
  const activeRootKey = key(2)
  const writerKey = key(3)
  const devicePublicKey = key(4)
  const writer = {
    writerKey,
    signerKey: devicePublicKey,
    capabilities: ['publish'],
    firstAcceptedSequence: 0,
    lastAcceptedSequence: 3,
    expiresAt: 1_900_000_000_000,
    admissionPolicyEpoch: 2,
    revocation: null
  }
  const authorizationState = {
    publisherId,
    activeRootKey,
    catalogEpoch: 5,
    policyEpoch: 2,
    writers: new Map([[hex(writerKey), writer]])
  }
  const localDevice = {
    writerKey,
    devicePublicKey,
    rootPublicKey: activeRootKey,
    hasRootAuthority: true,
    catalogEpoch: 5,
    policyEpoch: 2
  }
  return { publisherId, activeRootKey, writerKey, devicePublicKey, authorizationState, localDevice }
}

test('lost publisher root preserves local media operations but denies authority operations', (t) => {
  const { publisherId, devicePublicKey, authorizationState, localDevice } = fixture()
  const projected = projectPublisherDeviceStatus({
    authorizationState,
    localDevice: { ...localDevice, hasRootAuthority: false, rootPublicKey: undefined }
  })

  t.alike(projected.publisherId, publisherId)
  t.alike(projected.devicePublicKey, devicePublicKey)
  t.is(projected.status, 'authority-lost')
  t.is(projected.reasonCode, 'ROOT_AUTHORITY_LOST')
  t.is(projected.canPublish, false)
  t.is(projected.canRootTransition, false)
  t.is(projected.canPlayLocal, true)
  t.is(projected.canExportLocal, true)
  t.is(projected.canDeleteLocal, true)
  t.is(projected.catalogEpoch, 5)
  t.is(projected.policyEpoch, 2)
  t.is(projected.admissionExpiresAt, 1_900_000_000_000)
})

test('rotated publisher root makes the old-root device authority-lost', (t) => {
  const { authorizationState, localDevice } = fixture()
  const projected = projectPublisherDeviceStatus({
    authorizationState,
    localDevice: { ...localDevice, rootPublicKey: key(99) }
  })

  t.is(projected.status, 'authority-lost')
  t.is(projected.reasonCode, 'ROOT_AUTHORITY_ROTATED')
  t.is(projected.canPublish, false)
  t.is(projected.canRootTransition, false)
})

test('devices behind either catalog or policy epoch are stale', (t) => {
  const { authorizationState, localDevice } = fixture()
  const cases = [
    [{ ...localDevice, catalogEpoch: 4 }, 'LOCAL_CATALOG_STALE'],
    [{ ...localDevice, policyEpoch: 1 }, 'LOCAL_POLICY_STALE']
  ]

  for (const [device, reasonCode] of cases) {
    const projected = projectPublisherDeviceStatus({ authorizationState, localDevice: device })
    t.is(projected.status, 'stale')
    t.is(projected.reasonCode, reasonCode)
    t.is(projected.canPublish, false)
    t.is(projected.canRootTransition, false)
  }
})

test('revoked device exposes the exact accepted-through cutoff and cannot publish', (t) => {
  const { authorizationState, localDevice, writerKey } = fixture()
  const writer = authorizationState.writers.get(hex(writerKey))
  writer.revocation = {
    revokedFromEpoch: 2,
    revokedAtEpoch: 3,
    acceptedThroughSequence: writer.lastAcceptedSequence
  }
  authorizationState.policyEpoch = 3
  localDevice.policyEpoch = 3

  const projected = projectPublisherDeviceStatus({ authorizationState, localDevice })
  t.is(projected.status, 'revoked')
  t.is(projected.reasonCode, 'DEVICE_REVOKED')
  t.is(projected.revocationCutoff, writer.lastAcceptedSequence, 'cutoff equality is preserved exactly')
  t.is(projected.canPublish, false)
  t.is(projected.canRootTransition, true, 'current root authority can still transition a revoked writer')
})

test('revocation cutoff accepts the maximum safe value and rejects overflow', (t) => {
  const { authorizationState, localDevice, writerKey } = fixture()
  const writer = authorizationState.writers.get(hex(writerKey))
  writer.revocation = {
    revokedFromEpoch: 2,
    revokedAtEpoch: 3,
    acceptedThroughSequence: Number.MAX_SAFE_INTEGER
  }
  authorizationState.policyEpoch = 3
  localDevice.policyEpoch = 3

  const maximum = projectPublisherDeviceStatus({ authorizationState, localDevice })
  t.is(maximum.revocationCutoff, Number.MAX_SAFE_INTEGER)

  writer.revocation.acceptedThroughSequence = Number.MAX_SAFE_INTEGER + 1
  t.exception(
    () => projectPublisherDeviceStatus({ authorizationState, localDevice }),
    /acceptedThroughSequence is out of bounds/
  )
})

test('missing local writer is unable to publish without disabling current root transitions', (t) => {
  const { authorizationState, localDevice } = fixture()
  const projected = projectPublisherDeviceStatus({
    authorizationState,
    localDevice: { ...localDevice, writerKey: undefined }
  })

  t.is(projected.status, 'unable-to-publish')
  t.is(projected.reasonCode, 'LOCAL_WRITER_UNAVAILABLE')
  t.alike(projected.devicePublicKey, localDevice.devicePublicKey)
  t.is(projected.admissionExpiresAt, undefined)
  t.is(projected.canPublish, false)
  t.is(projected.canRootTransition, true)
  t.is(projected.canPlayLocal, true)
  t.is(projected.canExportLocal, true)
  t.is(projected.canDeleteLocal, true)
})

test('current admitted device is authorized to publish and transition', (t) => {
  const { authorizationState, localDevice } = fixture()
  const projected = projectPublisherDeviceStatus({ authorizationState, localDevice })

  t.is(projected.status, 'authorized')
  t.absent(projected.reasonCode)
  t.is(projected.canPublish, true)
  t.is(projected.canRootTransition, true)
  t.is(projected.admissionExpiresAt, 1_900_000_000_000)
})

test('failed halfway legacy import maps to a secret-free unable state', (t) => {
  const { authorizationState, localDevice } = fixture()
  const legacyImport = {
    state: 'failed',
    phase: 'root-imported-before-writer-admission',
    errorCode: 'RAW_BACKEND_FAILURE',
    secretKey: key(200)
  }
  const projected = projectPublisherDeviceStatus({ authorizationState, localDevice, legacyImport })

  t.is(projected.status, 'unable-to-publish')
  t.is(projected.reasonCode, 'LEGACY_IMPORT_FAILED')
  t.is(projected.legacyImportState, 'failed')
  t.is(projected.canPublish, false)
  t.is(projected.canRootTransition, false)
  t.is(projected.canPlayLocal, true)
  t.is(projected.canExportLocal, true)
  t.is(projected.canDeleteLocal, true)
  t.is(Object.keys(projected).length <= 13, true, 'status response has a fixed scalar-field bound')
  t.absent(projected.secretKey)
  t.absent(projected.errorCode)
  t.absent(projected.phase)
  t.absent(projected.rootPublicKey)
  t.absent(projected.activeRootKey)
  const repeated = projectPublisherDeviceStatus({
    authorizationState,
    localDevice,
    legacyImport: { ...legacyImport, errorCode: 'DIFFERENT_FAILURE', secretKey: key(201) }
  })
  t.alike(repeated, projected, 'ignored secret and diagnostic material cannot affect projection')
  t.ok(Object.isFrozen(projected), 'bounded response shape cannot be extended')
})

test('catalog admission matches the local writer while reporting the device signer public key', (t) => {
  const { authorizationState, localDevice, writerKey, devicePublicKey } = fixture()
  const projected = projectPublisherDeviceStatus({
    authorizationState,
    localDevice
  })

  t.is(projected.status, 'authorized')
  t.alike(projected.devicePublicKey, devicePublicKey)
  t.unlike(projected.devicePublicKey, writerKey, 'Autobase writer feed key is not exposed as device identity')
})
