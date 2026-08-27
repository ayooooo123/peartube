import b4a from 'b4a'
import c from 'compact-encoding'

import { MAX_PEER_FRAME_BYTES } from './frame.js'
import { assertProtocolCompatibility, createProtocolAdvertisement, MAX_PROTOCOL_CAPABILITIES } from './version.js'
import { INDEX_FEED_CAPABILITY } from '../indexing/feed-contract.js'
import { createIndexFeedManager } from '../indexing/feed-manager.js'
import { createModerationManager } from '../moderation/manager.js'
import { decodeApplicationEnvelope, encodeApplicationEnvelope } from '../records/application-envelope.js'
import { deriveIndexTopic, deriveModerationTopic } from './topics.js'

export const MODERATION_FEED_CAPABILITY = 'moderation-feed:v1'

function fail (message, code = 'SCOPED_NETWORK_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

function capabilityForPurpose (purpose) {
  if (purpose === 'index') return INDEX_FEED_CAPABILITY
  if (purpose === 'moderation') return MODERATION_FEED_CAPABILITY
  fail('feed frame purpose is invalid')
}

const FEED_PAGE_FRAME_VERSION = 1
const MAX_FEED_CURSOR_BYTES = 256
const MAX_FEED_REQUEST_BYTES = 4096
const MAX_FEED_PAGE_ENVELOPE_BYTES = MAX_PEER_FRAME_BYTES - 1024
const FEED_FRAME_INPUT_FIELDS = Object.freeze([
  'purpose', 'cursor', 'minimumProtocolMajor', 'protocolMinor', 'requiredCapabilities',
])

function exactFeedFrameFields (value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('feed frame input is invalid')
  const actual = Object.keys(value).sort()
  const allowed = [...fields].sort()
  if (actual.some(field => !allowed.includes(field))) fail('feed frame input fields are invalid')
}

function normalizeFeedCursor (value) {
  if (typeof value !== 'string' || !value || b4a.byteLength(value) > MAX_FEED_CURSOR_BYTES) {
    fail('feed cursor is invalid')
  }
  return value
}

function normalizeFeedFramePurpose (value) {
  const purpose = String(value || '')
  if (purpose !== 'index' && purpose !== 'moderation') fail('feed frame purpose is invalid')
  return purpose
}

function encodeFeedFrameHeader (value) {
  const chunks = [
    c.encode(c.uint, FEED_PAGE_FRAME_VERSION),
    c.encode(c.uint, value.minimumProtocolMajor),
    c.encode(c.uint, value.protocolMinor),
    c.encode(c.uint, value.requiredCapabilities.length),
  ]
  for (const capability of value.requiredCapabilities) chunks.push(c.encode(c.string, capability))
  chunks.push(c.encode(c.string, value.cursor))
  return b4a.concat(chunks)
}

function normalizeFeedFrameInput (input, { response = false } = {}) {
  exactFeedFrameFields(input, response
    ? [...FEED_FRAME_INPUT_FIELDS, 'envelope']
    : FEED_FRAME_INPUT_FIELDS)
  const purpose = normalizeFeedFramePurpose(input.purpose)
  return {
    purpose,
    cursor: normalizeFeedCursor(input.cursor),
    ...createProtocolAdvertisement(input, {
      requiredCapabilities: [capabilityForPurpose(purpose)],
    }),
  }
}

function decodeFeedFrameHeader (state, options = {}) {
  const purpose = normalizeFeedFramePurpose(options.purpose)
  if (c.uint.decode(state) !== FEED_PAGE_FRAME_VERSION) fail('feed frame version is unsupported')
  const minimumProtocolMajor = c.uint.decode(state)
  const protocolMinor = c.uint.decode(state)
  const capabilityCount = c.uint.decode(state)
  if (capabilityCount > MAX_PROTOCOL_CAPABILITIES) fail('feed frame capabilities exceed bounded limit')
  const requiredCapabilities = new Array(capabilityCount)
  for (let index = 0; index < capabilityCount; index++) {
    requiredCapabilities[index] = c.string.decode(state)
  }
  const cursor = normalizeFeedCursor(c.string.decode(state))
  const advertisement = assertProtocolCompatibility({
    minimumProtocolMajor,
    protocolMinor,
    requiredCapabilities,
  }, {
    protocolMajor: options.protocolMajor,
    supportedCapabilities: options.supportedCapabilities || [capabilityForPurpose(purpose)],
    mandatoryCapabilities: [capabilityForPurpose(purpose)],
  })
  return { purpose, cursor, ...advertisement }
}

export function encodeFeedPageRequest (input = {}) {
  const normalized = normalizeFeedFrameInput(input)
  const payload = encodeFeedFrameHeader(normalized)
  if (payload.byteLength > MAX_FEED_REQUEST_BYTES) fail('feed request exceeds bounded limit')
  return payload
}

export function decodeFeedPageRequest (input, options = {}) {
  const payload = b4a.from(input || [])
  if (!payload.byteLength || payload.byteLength > MAX_FEED_REQUEST_BYTES) fail('feed request exceeds bounded limit')
  const state = c.state(0, payload.byteLength, payload)
  const decoded = decodeFeedFrameHeader(state, options)
  if (state.start !== state.end) fail('feed request has trailing bytes')
  if (!b4a.equals(encodeFeedFrameHeader(decoded), payload)) fail('feed request is noncanonical')
  const { purpose, ...result } = decoded
  return result
}

export function encodeFeedPageResponse (input = {}) {
  const normalized = normalizeFeedFrameInput(input, { response: true })
  const envelope = encodeApplicationEnvelope(input.envelope)
  if (envelope.byteLength > MAX_FEED_PAGE_ENVELOPE_BYTES) fail('feed page exceeds bounded limit')
  return b4a.concat([
    encodeFeedFrameHeader(normalized),
    c.encode(c.buffer, envelope),
  ])
}

export function decodeFeedPageResponse (input, options = {}) {
  const payload = b4a.from(input || [])
  if (!payload.byteLength || payload.byteLength > MAX_PEER_FRAME_BYTES) fail('feed response exceeds bounded limit')
  const state = c.state(0, payload.byteLength, payload)
  const decoded = decodeFeedFrameHeader(state, options)
  const envelopeBytes = c.buffer.decode(state)
  if (envelopeBytes.byteLength > MAX_FEED_PAGE_ENVELOPE_BYTES) fail('feed page exceeds bounded limit')
  if (state.start !== state.end) fail('feed response has trailing bytes')
  const canonical = b4a.concat([
    encodeFeedFrameHeader(decoded),
    c.encode(c.buffer, envelopeBytes),
  ])
  if (!b4a.equals(canonical, payload)) fail('feed response is noncanonical')
  const { purpose, ...result } = decoded
  return {
    ...result,
    envelope: decodeApplicationEnvelope(envelopeBytes),
  }
}
export function createScopedFeedRuntime (context) {
  const {
    options, protocolMajor, sendScopedFrame, joinScope, findScope, leaveScope, stableScopeDiagnostic, hex32,
  } = context
  const indexFeedManager = options.indexFeedManager || createIndexFeedManager({ now: options.now })
  const moderationManager = options.moderationManager || createModerationManager({ now: options.now })
  const indexFeedProviders = new Map()
  const moderationFeedProviders = new Map()

  async function handleFeedFrame(scope, tracked, frame) {
    const providers = scope.feedKind === 'index' ? indexFeedProviders : moderationFeedProviders
    if (frame.type === 'feed-page-request') {
      const { cursor } = decodeFeedPageRequest(frame.payload, {
        purpose: scope.purpose,
        protocolMajor,
      })
      const fetchPage = providers.get(scope.feedId)
      if (!fetchPage) return { status: 'rejected', reason: 'feed-not-provided' }
      const page = await fetchPage(cursor)
      if (!page?.envelope) return { status: 'rejected', reason: 'feed-page-unavailable' }
      if (!sendScopedFrame(tracked, scope.purpose, 'feed-page-response', encodeFeedPageResponse({
        purpose: scope.purpose,
        cursor,
        envelope: page.envelope,
      }))) return { status: 'rejected', reason: 'feed-response-send-failed' }
      return { status: 'sent' }
    }
    if (frame.type === 'feed-page-response') {
      const response = decodeFeedPageResponse(frame.payload, {
        purpose: scope.purpose,
        protocolMajor,
      })
      const pending = scope.feedPending?.get(response.cursor)
      if (!pending) return { status: 'rejected', reason: 'unexpected-feed-page' }
      clearTimeout(pending.timer)
      scope.feedPending.delete(response.cursor)
      pending.resolve({ envelope: response.envelope })
      return { status: 'accepted' }
    }
    return { status: 'rejected', reason: 'feed-frame-type-not-allowed' }
  }

  function requestFeedPage(scope, cursor) {
    const key = String(cursor || '0')
    if (scope.feedPending?.has(key)) return scope.feedPending.get(key).promise
    const tracked = [...scope.sessions.values()].find(session => !session.closed && session.state === 'active')
    if (!tracked) return Promise.reject(Object.assign(new Error('feed peer unavailable'), { code: 'FEED_PEER_UNAVAILABLE' }))
    let resolve, reject
    const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
    const timer = setTimeout(() => {
      scope.feedPending.delete(key)
      reject(Object.assign(new Error('feed page timed out'), { code: 'FEED_PAGE_TIMEOUT' }))
    }, 10_000)
    timer.unref?.()
    scope.feedPending.set(key, { promise, resolve, reject, timer })
    if (!sendScopedFrame(tracked, scope.purpose, 'feed-page-request', encodeFeedPageRequest({
      purpose: scope.purpose,
      cursor: key,
    }))) {
      clearTimeout(timer)
      scope.feedPending.delete(key)
      reject(Object.assign(new Error('feed page request failed'), { code: 'FEED_REQUEST_FAILED' }))
    }
    return promise
  }

  async function syncFollowedFeed (scope) {
    if (!scope || scope.closed || !scope.modes.has('subscribed')) return { status: 'not-subscribed' }
    try {
      if (scope.feedKind === 'index') {
        return await indexFeedManager.syncFeed({
          curatorId: scope.feedId,
          fetchPage: cursor => requestFeedPage(scope, cursor),
        })
      }
      return await moderationManager.syncFeed({
        moderatorId: scope.feedId,
        fetchPage: cursor => requestFeedPage(scope, cursor),
      })
    } catch (error) {
      // Discovery is intentionally opportunistic: retaining a local subscription
      // must not make a policy transition fail merely because no peer currently
      // serves its bounded signed pages.
      return { status: 'deferred', errorCode: error?.code || 'FEED_SYNC_DEFERRED' }
    }
  }
  async function provideIndexFeed ({ curatorId, fetchPage } = {}) {
    const id = hex32(curatorId, 'curatorId')
    if (typeof fetchPage !== 'function') fail('index feed provider requires fetchPage')
    indexFeedProviders.set(id, fetchPage)
    joinScope({ purpose: 'index', topic: deriveIndexTopic({ protocolMajor, curatorId: id }), scopeId: id, mode: 'provided', feedId: id, feedKind: 'index', feedPending: new Map() })
    return { status: 'provided', curatorId: id }
  }

  async function subscribeIndexFeed ({ curatorId } = {}) {
    const id = hex32(curatorId, 'curatorId')
    await indexFeedManager.ready
    await indexFeedManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'index', topic: deriveIndexTopic({ protocolMajor, curatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'index', feedPending: new Map() })
    return syncFollowedFeed(scope)
  }

  async function followIndexFeed ({ curatorId } = {}) {
    const id = hex32(curatorId, 'curatorId')
    await indexFeedManager.ready
    await indexFeedManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'index', topic: deriveIndexTopic({ protocolMajor, curatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'index', feedPending: new Map() })
    return { status: 'following', curatorId: id, topic: stableScopeDiagnostic(scope) }
  }

  async function unfollowIndexFeed ({ curatorId } = {}) {
    const id = hex32(curatorId, 'curatorId')
    await indexFeedManager.ready
    await indexFeedManager.unsubscribe(id)
    const scope = findScope('index', deriveIndexTopic({ protocolMajor, curatorId: id }))
    const released = scope ? await leaveScope(scope, 'subscribed') : false
    return { status: 'unfollowed', curatorId: id, released }
  }

  async function provideModerationFeed ({ moderatorId, fetchPage } = {}) {
    const id = hex32(moderatorId, 'moderatorId')
    if (typeof fetchPage !== 'function') fail('moderation feed provider requires fetchPage')
    moderationFeedProviders.set(id, fetchPage)
    joinScope({ purpose: 'moderation', topic: deriveModerationTopic({ protocolMajor, moderatorId: id }), scopeId: id, mode: 'provided', feedId: id, feedKind: 'moderation', feedPending: new Map() })
    return { status: 'provided', moderatorId: id }
  }

  async function subscribeModerationFeed ({ moderatorId } = {}) {
    const id = hex32(moderatorId, 'moderatorId')
    await moderationManager.ready
    await moderationManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'moderation', topic: deriveModerationTopic({ protocolMajor, moderatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'moderation', feedPending: new Map() })
    return syncFollowedFeed(scope)
  }

  async function followModerationFeed ({ moderatorId } = {}) {
    const id = hex32(moderatorId, 'moderatorId')
    await moderationManager.ready
    await moderationManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'moderation', topic: deriveModerationTopic({ protocolMajor, moderatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'moderation', feedPending: new Map() })
    return { status: 'following', moderatorId: id, topic: stableScopeDiagnostic(scope) }
  }

  async function unfollowModerationFeed ({ moderatorId } = {}) {
    const id = hex32(moderatorId, 'moderatorId')
    await moderationManager.ready
    await moderationManager.unsubscribe(id)
    const scope = findScope('moderation', deriveModerationTopic({ protocolMajor, moderatorId: id }))
    const released = scope ? await leaveScope(scope, 'subscribed') : false
    return { status: 'unfollowed', moderatorId: id, released }
  }

  return {
    handleFeedFrame, syncFollowedFeed, provideIndexFeed, subscribeIndexFeed, followIndexFeed,
    unfollowIndexFeed, provideModerationFeed, subscribeModerationFeed, followModerationFeed,
    unfollowModerationFeed, getIndexFeedRecords: () => indexFeedManager.getRecords(),
    getModerationFeedRecords: () => moderationManager.getRecords(),
  }
}
