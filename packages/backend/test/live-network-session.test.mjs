import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createLiveEventDescriptor, createLiveEpochDescriptor } from '../src/live/live-descriptor.js'
import { createLiveNetworkSession } from '../src/live/live-network-session.js'

const publisher = crypto.keyPair(Buffer.alloc(32, 1))
const device = crypto.keyPair(Buffer.alloc(32, 2))
const other = crypto.keyPair(Buffer.alloc(32, 3))
const publisherId = Buffer.from(publisher.publicKey).toString('hex')
const deviceId = Buffer.from(device.publicKey).toString('hex')

test('live network session accepts appends only from authorized epoch writer and catalog event', async (t) => {
  const event = createLiveEventDescriptor({ publisherId, deviceId, nonce: 'n1', keyPair: publisher })
  const epoch = createLiveEpochDescriptor({ eventId: event.body.eventId, epoch: 0, previousEpochDigest: null, writableCoreKey: 'a'.repeat(64), startsAt: 0, expiresAt: 100, codec: 'video/mp4', keyPair: device })
  const session = await createLiveNetworkSession({ eventEnvelope: event.envelope, epochEnvelopes: [epoch.envelope], publisherId, deviceId, catalogEventId: event.body.eventId, now: 10 })
  t.is(session.acceptAppend({ eventId: event.body.eventId, epoch: 0, writerId: deviceId, segmentIndex: 0 }).accepted, true)
  t.is(session.acceptAppend({ eventId: event.body.eventId, epoch: 0, writerId: Buffer.from(other.publicKey).toString('hex'), segmentIndex: 1 }).accepted, false)
  t.alike(await createLiveNetworkSession({ eventEnvelope: event.envelope, epochEnvelopes: [epoch.envelope], publisherId, deviceId, catalogEventId: 'f'.repeat(64), now: 10 }), null)
})

test('live network session rejects later epoch traffic after ended or aborted terminal records', async (t) => {
  const event = createLiveEventDescriptor({ publisherId, deviceId, nonce: 'n1', keyPair: publisher })
  const epoch0 = createLiveEpochDescriptor({ eventId: event.body.eventId, epoch: 0, previousEpochDigest: null, writableCoreKey: 'a'.repeat(64), startsAt: 0, expiresAt: 50, codec: 'video/mp4', terminalState: 'aborted', keyPair: device })
  const session = await createLiveNetworkSession({ eventEnvelope: event.envelope, epochEnvelopes: [epoch0.envelope], publisherId, deviceId, catalogEventId: event.body.eventId, now: 10 })
  t.is(session.acceptAppend({ eventId: event.body.eventId, epoch: 1, writerId: deviceId, segmentIndex: 0 }).accepted, false)
  t.is(session.terminalState, 'aborted')
})
