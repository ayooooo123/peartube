import test from 'brittle'
import crypto from 'hypercore-crypto'

import { encodePeerFrame, decodePeerFrame } from '../src/network/frame.js'
import { createLiveEventDescriptor, createLiveEpochDescriptor, verifyLiveEpochChain } from '../src/live/live-descriptor.js'

const publisher = crypto.keyPair(Buffer.alloc(32, 1))
const device = crypto.keyPair(Buffer.alloc(32, 2))
const publisherId = Buffer.from(publisher.publicKey).toString('hex')
const deviceId = Buffer.from(device.publicKey).toString('hex')

test('protocol version skew rejects cross-major peer frames', (t) => {
  const frame = encodePeerFrame({ type: 'catalog', body: Buffer.from('hello'), protocolMajor: 2, protocolMinor: 0 })
  t.exception(() => decodePeerFrame(frame), /unsupported protocol major/)
})

test('live epoch chain rejects not-yet-valid and expired heads under skewed clocks', async (t) => {
  const event = createLiveEventDescriptor({ publisherId, deviceId, nonce: 'n', keyPair: publisher })
  const epoch = createLiveEpochDescriptor({ eventId: event.body.eventId, epoch: 0, previousEpochDigest: null, writableCoreKey: 'a'.repeat(64), startsAt: 100, expiresAt: 200, codec: 'video/mp4', keyPair: device })
  t.absent(await verifyLiveEpochChain([epoch.envelope], { eventId: event.body.eventId, deviceId, now: 50 }))
  t.absent(await verifyLiveEpochChain([epoch.envelope], { eventId: event.body.eventId, deviceId, now: 250 }))
  t.ok(await verifyLiveEpochChain([epoch.envelope], { eventId: event.body.eventId, deviceId, now: 150 }))
})
