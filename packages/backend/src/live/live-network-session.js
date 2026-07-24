import { verifyLiveEventDescriptor, verifyLiveEpochChain } from './live-descriptor.js'

export async function createLiveNetworkSession(options = {}) {
  const event = await verifyLiveEventDescriptor(options.eventEnvelope, { publisherId: options.publisherId, now: options.now })
  if (!event) return null
  if (options.catalogEventId && options.catalogEventId !== event.body.eventId) return null
  const chain = await verifyLiveEpochChain(options.epochEnvelopes || [], { eventId: event.body.eventId, deviceId: options.deviceId, now: options.now })
  if (!chain) return null
  const head = chain.head
  return {
    eventId: event.body.eventId,
    publisherId: event.body.publisherId,
    deviceId: event.body.deviceId,
    headEpoch: head?.epoch ?? null,
    terminalState: chain.terminalState,
    acceptAppend(frame = {}) {
      if (chain.terminalState) return { accepted: false, reason: 'terminal-live-event' }
      if (frame.eventId !== event.body.eventId) return { accepted: false, reason: 'event-mismatch' }
      if (frame.epoch !== head?.epoch) return { accepted: false, reason: 'epoch-mismatch' }
      if (frame.writerId !== event.body.deviceId) return { accepted: false, reason: 'unauthorized-writer' }
      if (!Number.isSafeInteger(frame.segmentIndex) || frame.segmentIndex < 0) return { accepted: false, reason: 'invalid-segment' }
      return { accepted: true, reason: null }
    },
  }
}
