import test from 'brittle'
import crypto from 'hypercore-crypto'

import {
  ASSET_RENDITION_CAPABILITY,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_MAJOR,
  assertProtocolCompatibility,
  createProtocolAdvertisement,
  decodePeerFrame,
  encodePeerFrame,
} from '../src/network/index.js'
import { createLiveEventDescriptor, createLiveEpochDescriptor, verifyLiveEpochChain } from '../src/live/live-descriptor.js'
import { createStatusApi } from '../src/api/status.js'
import { deriveBootstrapTopic } from '../src/network/topics.js'

const publisher = crypto.keyPair(Buffer.alloc(32, 1))
const device = crypto.keyPair(Buffer.alloc(32, 2))
const publisherId = Buffer.from(publisher.publicKey).toString('hex')
const deviceId = Buffer.from(device.publicKey).toString('hex')

test('protocol major 3 isolates causal catalog sync while retaining the v2 asset capability', (t) => {
  t.is(PROTOCOL_MAJOR, 3)
  t.is(ASSET_RENDITION_CAPABILITY, 'asset-rendition:v2')
  const advertisement = createProtocolAdvertisement({ requiredCapabilities: [ASSET_RENDITION_CAPABILITY] })
  t.is(advertisement.minimumProtocolMajor, 3)
  t.alike(advertisement.requiredCapabilities, ['asset-rendition:v2'])
  t.alike(assertProtocolCompatibility(advertisement, {
    mandatoryCapabilities: [ASSET_RENDITION_CAPABILITY],
    supportedCapabilities: [ASSET_RENDITION_CAPABILITY],
  }), advertisement)
})

test('status fallback advertises the exported current protocol-major topic', (t) => {
  const networkId = 'status-major-parity'
  const status = createStatusApi({ ctx: { networkId } }).getSwarmStatus()
  t.is(status.scopedTopics.length, 1)
  t.is(status.scopedTopics[0].protocolMajor, PROTOCOL_MAJOR)
  t.is(
    status.scopedTopics[0].topicHex,
    Buffer.from(deriveBootstrapTopic({ networkId, protocolMajor: PROTOCOL_MAJOR })).toString('hex'),
  )
})

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
    { minimumProtocolMajor: '2', protocolMinor: 0, requiredCapabilities: [] },
    { minimumProtocolMajor: null, protocolMinor: 0, requiredCapabilities: [] },
    { minimumProtocolMajor: 2, protocolMinor: false, requiredCapabilities: [] },
    { minimumProtocolMajor: 2, protocolMinor: 0, requiredCapabilities: ['z:v1', 'a:v1'] },
    { minimumProtocolMajor: 2, protocolMinor: 0, requiredCapabilities: ['a:v1', 'a:v1'] },
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
  const mismatch = createProtocolAdvertisement({ minimumProtocolMajor: 1 })
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
    assertProtocolCompatibility(createProtocolAdvertisement({ requiredCapabilities: ['asset-rendition:v1'] }), {
      mandatoryCapabilities: [ASSET_RENDITION_CAPABILITY],
      supportedCapabilities: [ASSET_RENDITION_CAPABILITY],
    })
    t.fail('v1 asset capability must not be accepted as a v2 alias')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED)
  }
  try {
    assertProtocolCompatibility({})
    t.fail('omitted compatibility fields must be rejected by default')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED)
  }
  const acceptedLegacy = assertProtocolCompatibility({}, {
    legacyCompatibility: {
      minimumProtocolMajor: 3,
      protocolMinor: 0,
      requiredCapabilities: [],
    },
  })
  t.is(acceptedLegacy.minimumProtocolMajor, 3)
  try {
    assertProtocolCompatibility({}, {
      legacyCompatibility: {
        minimumProtocolMajor: 1,
        protocolMinor: 0,
        requiredCapabilities: [],
      },
    })
    t.fail('explicit legacy metadata must still match the local major')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.MAJOR_UNSUPPORTED)
  }
})

test('protocol version skew rejects v1 peer frames with the stable compatibility code', (t) => {
  const frame = encodePeerFrame({ type: 'catalog', payload: Buffer.from('hello'), protocolMajor: 1, protocolMinor: 0 })
  try {
    decodePeerFrame(frame)
    t.fail('v1 peer frame must be rejected')
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
