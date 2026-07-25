import b4a from 'b4a'

import { encodeCanonical, hashCanonical, toHex } from '../publisher/canonical.js'
import { createApplicationEnvelope, verifyApplicationEnvelope } from '../records/application-envelope.js'
import { describeScopedTopic } from '../network/topics.js'

export const LIVE_EVENT_RECORD_TYPE = 'peartube.live.event.v1'
export const LIVE_EPOCH_RECORD_TYPE = 'peartube.live.epoch.v1'

function hex32(value, name) { return toHex(value, 32, name) }
function boundedString(value, name, max = 512, required = true) {
  if (value == null && !required) return null
  const next = String(value || '')
  if ((required && !next) || next.length > max) throw new Error(`${name} must be bounded string`)
  return next
}
function digest(body, domain) { return b4a.toString(hashCanonical(domain, body), 'hex') }

export function createLiveEventDescriptor(input = {}) {
  const seed = { publisherId: hex32(input.publisherId, 'publisherId'), deviceId: hex32(input.deviceId, 'deviceId'), nonce: boundedString(input.nonce, 'nonce', 128) }
  const body = { version: 1, ...seed, eventId: digest(seed, 'peartube.live.event-id.v1'), title: boundedString(input.title, 'title', 256, false), issuedAt: Number(input.issuedAt || 0) }
  const envelope = createApplicationEnvelope({ recordType: LIVE_EVENT_RECORD_TYPE, body: encodeCanonical(body), keyPair: input.keyPair, issuedAt: input.issuedAt, expiresAt: input.expiresAt })
  return { eventId: body.eventId, body, envelope }
}

export async function verifyLiveEventDescriptor(envelope, options = {}) {
  let body
  try { body = JSON.parse(b4a.toString(envelope.body)) } catch { return false }
  if (options.publisherId && body.publisherId !== hex32(options.publisherId, 'publisherId')) return false
  if (body.eventId !== digest({ publisherId: body.publisherId, deviceId: body.deviceId, nonce: body.nonce }, 'peartube.live.event-id.v1')) return false
  const ok = await verifyApplicationEnvelope(envelope, { recordType: LIVE_EVENT_RECORD_TYPE, allowedSigners: [b4a.from(body.publisherId, 'hex')], now: options.now })
  return ok ? { body, envelope } : false
}

export function createLiveEpochDescriptor(input = {}) {
  const body = {
    version: 1,
    eventId: hex32(input.eventId, 'eventId'),
    epoch: Number(input.epoch),
    previousEpochDigest: input.previousEpochDigest == null ? null : boundedString(input.previousEpochDigest, 'previousEpochDigest', 64),
    writableCoreKey: hex32(input.writableCoreKey, 'writableCoreKey'),
    startsAt: Number(input.startsAt || 0),
    expiresAt: Number(input.expiresAt || 0),
    codec: boundedString(input.codec, 'codec', 64),
    dvrWindowBlocks: Number(input.dvrWindowBlocks || 0),
    terminalState: input.terminalState == null ? null : boundedString(input.terminalState, 'terminalState', 16),
  }
  if (!Number.isSafeInteger(body.epoch) || body.epoch < 0) throw new Error('invalid live epoch')
  if (body.expiresAt <= body.startsAt) throw new Error('invalid live epoch window')
  if (body.terminalState && !['ended', 'aborted'].includes(body.terminalState)) throw new Error('invalid terminal state')
  const epochDigest = digest(body, 'peartube.live.epoch-digest.v1')
  const envelope = createApplicationEnvelope({ recordType: LIVE_EPOCH_RECORD_TYPE, body: encodeCanonical({ ...body, epochDigest }), keyPair: input.keyPair, issuedAt: input.issuedAt, expiresAt: input.expiresAt })
  return { epochDigest, body: { ...body, epochDigest }, envelope }
}

export async function verifyLiveEpochDescriptor(envelope, options = {}) {
  let body
  try { body = JSON.parse(b4a.toString(envelope.body)) } catch { return false }
  if (options.eventId && body.eventId !== hex32(options.eventId, 'eventId')) return false
  if (body.epochDigest !== digest({ ...body, epochDigest: undefined }, 'peartube.live.epoch-digest.v1')) return false
  if (Number.isFinite(options.now) && (options.now < body.startsAt || options.now > body.expiresAt)) return false
  const signer = options.deviceId ? [b4a.from(hex32(options.deviceId, 'deviceId'), 'hex')] : undefined
  const ok = await verifyApplicationEnvelope(envelope, { recordType: LIVE_EPOCH_RECORD_TYPE, allowedSigners: signer, now: options.now })
  return ok ? { body, envelope } : false
}

export async function verifyLiveEpochChain(envelopes = [], options = {}) {
  let previous = null
  let terminal = false
  for (let index = 0; index < envelopes.length; index++) {
    const verified = await verifyLiveEpochDescriptor(envelopes[index], { ...options, now: undefined })
    if (!verified) return false
    const body = verified.body
    if (terminal) return false
    if (body.epoch !== index) return false
    if ((previous?.epochDigest || null) !== body.previousEpochDigest) return false
    if (body.terminalState) terminal = true
    previous = body
  }
  if (Number.isFinite(options.now) && previous && (options.now < previous.startsAt || options.now > previous.expiresAt)) return false
  return { epochs: envelopes.length, head: previous, terminalState: previous?.terminalState || null }
}

export function deriveLiveEventTopic({ eventId, protocolMajor = 1 } = {}) {
  return describeScopedTopic('live', { eventId: hex32(eventId, 'eventId'), epoch: -1, protocolMajor })
}

export function deriveLiveEpochTopic({ eventId, epoch, protocolMajor = 1 } = {}) {
  return describeScopedTopic('live', { eventId: hex32(eventId, 'eventId'), epoch: Number(epoch), protocolMajor })
}
