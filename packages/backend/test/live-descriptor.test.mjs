import test from 'brittle'
import crypto from 'hypercore-crypto'

import {
  createLiveEventDescriptor,
  verifyLiveEventDescriptor,
  createLiveEpochDescriptor,
  verifyLiveEpochChain,
  deriveLiveEventTopic,
  deriveLiveEpochTopic,
} from '../src/live/live-descriptor.js'

const publisher = crypto.keyPair(Buffer.alloc(32, 1))
const device = crypto.keyPair(Buffer.alloc(32, 2))
const other = crypto.keyPair(Buffer.alloc(32, 3))
const publisherId = Buffer.from(publisher.publicKey).toString('hex')
const deviceId = Buffer.from(device.publicKey).toString('hex')

test('live event descriptor signs a stable event id and rejects wrong publisher signer', async (t) => {
  const event = createLiveEventDescriptor({ publisherId, deviceId, nonce: 'n1', title: 'Live', keyPair: publisher, issuedAt: 10, expiresAt: 100 })
  const verified = await verifyLiveEventDescriptor(event.envelope, { publisherId, now: 20 })
  t.ok(verified)
  t.is(verified.body.eventId, event.body.eventId)
  const wrong = createLiveEventDescriptor({ publisherId, deviceId, nonce: 'n1', keyPair: other })
  t.absent(await verifyLiveEventDescriptor(wrong.envelope, { publisherId }))
})

test('live epoch chain rejects regressions, gaps, bad previous digests, invalid windows, and terminal continuation', async (t) => {
  const event = createLiveEventDescriptor({ publisherId, deviceId, nonce: 'n1', keyPair: publisher, issuedAt: 10, expiresAt: 100 })
  const epoch0 = createLiveEpochDescriptor({ eventId: event.body.eventId, epoch: 0, previousEpochDigest: null, writableCoreKey: 'a'.repeat(64), startsAt: 10, expiresAt: 50, codec: 'video/mp4', dvrWindowBlocks: 3, keyPair: device })
  const epoch1 = createLiveEpochDescriptor({ eventId: event.body.eventId, epoch: 1, previousEpochDigest: epoch0.epochDigest, writableCoreKey: 'b'.repeat(64), startsAt: 50, expiresAt: 90, codec: 'video/mp4', dvrWindowBlocks: 3, terminalState: 'ended', keyPair: device })
  t.ok(await verifyLiveEpochChain([epoch0.envelope, epoch1.envelope], { eventId: event.body.eventId, deviceId, now: 55 }))
  const badGap = createLiveEpochDescriptor({ eventId: event.body.eventId, epoch: 2, previousEpochDigest: epoch0.epochDigest, writableCoreKey: 'c'.repeat(64), startsAt: 90, expiresAt: 100, codec: 'video/mp4', keyPair: device })
  t.absent(await verifyLiveEpochChain([epoch0.envelope, badGap.envelope], { eventId: event.body.eventId, deviceId, now: 55 }))
  const afterEnded = createLiveEpochDescriptor({ eventId: event.body.eventId, epoch: 2, previousEpochDigest: epoch1.epochDigest, writableCoreKey: 'd'.repeat(64), startsAt: 90, expiresAt: 100, codec: 'video/mp4', keyPair: device })
  t.absent(await verifyLiveEpochChain([epoch0.envelope, epoch1.envelope, afterEnded.envelope], { eventId: event.body.eventId, deviceId, now: 55 }))
})

test('live event and epoch topics are separated by event id, epoch, and protocol major', (t) => {
  const eventTopic = deriveLiveEventTopic({ eventId: 'e'.repeat(64), protocolMajor: 1 })
  const epochTopic = deriveLiveEpochTopic({ eventId: 'e'.repeat(64), epoch: 0, protocolMajor: 1 })
  const nextEpochTopic = deriveLiveEpochTopic({ eventId: 'e'.repeat(64), epoch: 1, protocolMajor: 1 })
  t.not(eventTopic.topicHex, epochTopic.topicHex)
  t.not(epochTopic.topicHex, nextEpochTopic.topicHex)
})
