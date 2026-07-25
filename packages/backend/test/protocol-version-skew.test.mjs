import test from 'brittle'
import crypto from 'hypercore-crypto'

import {
  PROTOCOL_ERROR_CODES,
  assertProtocolCompatibility,
  createProtocolAdvertisement,
  decodePeerFrame,
  encodePeerFrame
} from '../src/network/index.js'
import { createLiveEventDescriptor, createLiveEpochDescriptor, verifyLiveEpochChain } from '../src/live/live-descriptor.js'

const publisher = crypto.keyPair(Buffer.alloc(32, 1))
const device = crypto.keyPair(Buffer.alloc(32, 2))
const publisherId = Buffer.from(publisher.publicKey).toString('hex')
const deviceId = Buffer.from(device.publicKey).toString('hex')

test('protocol advertisements tolerate compatible minor changes and canonicalize bounded capabilities', (t) => {
  const advertisement = createProtocolAdvertisement({
    protocolMinor: 7,
    requiredCapabilities: ['publisher-catalog:v1', 'index-feed:v1', 'publisher-catalog:v1'],
  })
  t.alike(advertisement.requiredCapabilities, ['index-feed:v1', 'publisher-catalog:v1'])
  t.is(assertProtocolCompatibility(advertisement, {
    supportedCapabilities: ['publisher-catalog:v1', 'index-feed:v1'],
  }).protocolMinor, 7)
})

test('signed compatibility validation rejects coerced, noncanonical, and incomplete advertisements with a stable code', (t) => {
  const malformed = [
    { minimumProtocolMajor: '1', protocolMinor: 0, requiredCapabilities: [] },
    { minimumProtocolMajor: null, protocolMinor: 0, requiredCapabilities: [] },
    { minimumProtocolMajor: 1, protocolMinor: false, requiredCapabilities: [] },
    { minimumProtocolMajor: 1, protocolMinor: 0, requiredCapabilities: ['z:v1', 'a:v1'] },
    { minimumProtocolMajor: 1, protocolMinor: 0, requiredCapabilities: ['a:v1', 'a:v1'] },
  ]
  for (const advertisement of malformed) {
    try {
      assertProtocolCompatibility(advertisement)
      t.fail('malformed signed advertisement must be rejected')
    } catch (error) {
      t.is(error.code, PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED)
    }
  }

  try {
    assertProtocolCompatibility(createProtocolAdvertisement(), {
      mandatoryCapabilities: ['publisher-catalog:v1'],
      supportedCapabilities: ['publisher-catalog:v1'],
    })
    t.fail('a mandatory surface capability cannot be omitted')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED)
  }
})
test('protocol compatibility fails closed with stable major, capability, and omission codes', (t) => {
  const mismatch = createProtocolAdvertisement({ minimumProtocolMajor: 2 })
  try {
    assertProtocolCompatibility(mismatch)
    t.fail('cross-major advertisement must be rejected')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.MAJOR_UNSUPPORTED)
  }
  const unknown = createProtocolAdvertisement({ requiredCapabilities: ['future-projection:v1'] })
  try {
    assertProtocolCompatibility(unknown)
    t.fail('unknown required capability must be rejected')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.CAPABILITY_UNSUPPORTED)
    t.is(error.capability, 'future-projection:v1')
  }
  try {
    assertProtocolCompatibility({})
    t.fail('omitted compatibility fields must be rejected by default')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED)
  }
  const acceptedLegacy = assertProtocolCompatibility({}, {
    legacyCompatibility: {
      minimumProtocolMajor: 1,
      protocolMinor: 0,
      requiredCapabilities: [],
    },
  })
  t.is(acceptedLegacy.minimumProtocolMajor, 1)
  try {
    assertProtocolCompatibility({}, {
      legacyCompatibility: {
        minimumProtocolMajor: 2,
        protocolMinor: 0,
        requiredCapabilities: [],
      },
    })
    t.fail('explicit legacy metadata must still match the local major')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.MAJOR_UNSUPPORTED)
  }
})

test('protocol version skew rejects cross-major peer frames with the stable compatibility code', (t) => {
  const frame = encodePeerFrame({ type: 'catalog', body: Buffer.from('hello'), protocolMajor: 2, protocolMinor: 0 })
  try {
    decodePeerFrame(frame)
    t.fail('cross-major peer frame must be rejected')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.MAJOR_UNSUPPORTED)
    t.ok(/unsupported protocol major/.test(error.message))
  }
})

test('live epoch chain rejects not-yet-valid and expired heads under skewed clocks', async (t) => {
  const event = createLiveEventDescriptor({ publisherId, deviceId, nonce: 'n', keyPair: publisher })
  const epoch = createLiveEpochDescriptor({ eventId: event.body.eventId, epoch: 0, previousEpochDigest: null, writableCoreKey: 'a'.repeat(64), startsAt: 100, expiresAt: 200, codec: 'video/mp4', keyPair: device })
  t.absent(await verifyLiveEpochChain([epoch.envelope], { eventId: event.body.eventId, deviceId, now: 50 }))
  t.absent(await verifyLiveEpochChain([epoch.envelope], { eventId: event.body.eventId, deviceId, now: 250 }))
  t.ok(await verifyLiveEpochChain([epoch.envelope], { eventId: event.body.eventId, deviceId, now: 150 }))
})
