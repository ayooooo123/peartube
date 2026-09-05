import b4a from 'b4a'

import { encodePeerFrame } from './frame.js'
import { deriveBootstrapTopic } from './topics.js'
import { BOOTSTRAP_LOCATOR_CAPABILITY, createBootstrapLocator } from '../discovery/bootstrap-protocol.js'
import { createBootstrapManager } from '../discovery/bootstrap-manager.js'
import { DEFAULT_CLOCK_DRIFT_MS } from '../validators.js'
import { decodeApplicationEnvelope, encodeApplicationEnvelope } from '../records/application-envelope.js'

function fail (message, code = 'SCOPED_NETWORK_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}


export function createBootstrapLocatorRuntime (context) {
  const {
    options, protocolMajor, networkId, now, bootstrapLocatorKeyPair, bootstrapLocatorTtlMs,
    bootstrapLocatorRefreshMs, scheduleBootstrapLocatorRefresh, cancelBootstrapLocatorRefresh,
    localPublishers, localBootstrapLocators, sendScopedFrame, findScope, recordProtocolError,
    addPublisherFollowReason, isPeerConnected, getStatus, isNetworkEnabled, canPublish,
    allocateRequestId, counters, hex32,
  } = context
  const bootstrapManager = options.bootstrapManager || createBootstrapManager({
    now: options.now,
    trustedSigners: options.trustedBootstrapSigners || [],
    trustedRootIds: options.trustedBootstrapRootIds || [],
    protocolMajor,
    supportedCapabilities: [BOOTSTRAP_LOCATOR_CAPABILITY],
    verifyCatalogChain: options.verifyCatalogChain,
    maxClockSkewMs: options.maxClockSkewMs ?? DEFAULT_CLOCK_DRIFT_MS,
  })

  function sendBootstrapLocatorToSession(tracked, locator) {
    return sendScopedFrame(
      tracked,
      'bootstrap',
      'locator',
      encodeApplicationEnvelope(locator.envelope),
    )
  }

  // A bootstrap session sends everything in localBootstrapLocators the moment
  // it activates, so a publisher that never records one is invisible to every
  // consumer while still reporting a healthy catalog. The early returns below
  // are the difference between "discoverable" and "silently unreachable", so
  // they say which one happened instead of returning a bare 'unavailable'.
  async function refreshLocalBootstrapLocator(publisherId) {
    const local = localPublishers.get(publisherId)
    if (!local || !bootstrapLocatorKeyPair) {
      const reason = !local ? 'no-local-publisher-scope' : 'no-bootstrap-locator-keypair'
      console.log('[ScopedNetwork] bootstrap locator unavailable:', reason, publisherId.slice(0, 16))
      return { status: 'unavailable', reason }
    }
    const catalog = local.scope?.binding?.catalog
    if (typeof catalog?.getViewHead !== 'function' ||
        typeof catalog?.getAuthorizationState !== 'function') {
      console.log('[ScopedNetwork] bootstrap locator unavailable: catalog-not-inspectable', publisherId.slice(0, 16))
      return { status: 'unavailable', reason: 'catalog-not-inspectable' }
    }
    const issuedAt = Number(now())
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 ||
        issuedAt > Number.MAX_SAFE_INTEGER - bootstrapLocatorTtlMs) {
      fail('bootstrap locator clock is invalid')
    }
    const signerId = b4a.toString(bootstrapLocatorKeyPair.publicKey, 'hex')
    const localWriterId = catalog.localWriterKey
      ? b4a.toString(b4a.from(catalog.localWriterKey), 'hex')
      : null
    const [head, authorization] = await Promise.all([
      catalog.getViewHead(),
      catalog.getAuthorizationState(),
    ])
    const writer = authorization?.writers?.find(candidate =>
      candidate?.key === localWriterId &&
      candidate?.signerKey === signerId
    )
    if (!writer || writer.revocation || writer.expiresAt < issuedAt ||
        !writer.capabilities?.includes('announce')) {
      const reason = !writer ? 'writer-not-found' : (writer.revocation ? 'writer-revoked' : (writer.expiresAt < issuedAt ? 'writer-expired' : 'announce-capability-missing'))
      console.log('[ScopedNetwork] bootstrap locator unavailable:', reason, publisherId.slice(0, 16))
      return { status: 'unavailable', reason: 'signer-unauthorized', detail: reason }
    }
    const descriptor = local.scope.descriptor
    const locator = createBootstrapLocator({
      publisherId,
      catalogBootstrapKey: b4a.toString(descriptor.catalogBootstrapKey, 'hex'),
      catalogHead: hex32(head?.digest, 'catalogHead'),
      catalogEpoch: descriptor.catalogEpoch,
      authorizationChainDigest: hex32(head?.authorizationStateDigest, 'authorizationChainDigest'),
      rootSignerId: b4a.toString(descriptor.publisherRootKey, 'hex'),
      issuedAt,
      expiresAt: issuedAt + bootstrapLocatorTtlMs,
      keyPair: bootstrapLocatorKeyPair,
    })
    const previous = localBootstrapLocators.get(publisherId)
    if (previous?.timer) cancelBootstrapLocatorRefresh(previous.timer)
    const record = { locator, timer: null }
    localBootstrapLocators.set(publisherId, record)
    const delivery = isNetworkEnabled() ? await publishBootstrapLocator({ locator }) : null
    console.log('[ScopedNetwork] bootstrap locator recorded for', publisherId.slice(0, 16),
      'networkEnabled:', isNetworkEnabled(), 'deliveredToSessions:', delivery?.delivered ?? 0)
    if (getStatus() === 'active') {
      record.timer = scheduleBootstrapLocatorRefresh(() => {
        void refreshLocalBootstrapLocator(publisherId).catch(error => {
          const scope = localPublishers.get(publisherId)?.scope
          if (scope) recordProtocolError(scope, 'local', error)
        })
      }, bootstrapLocatorRefreshMs)
      record.timer.unref?.()
    }
    return { status: 'refreshed', locator }
  }

  async function handleBootstrapFrame (frame, context) {
    if (frame.type !== 'locator') return { status: 'rejected', reason: 'bootstrap-metadata-only' }
    const envelope = decodeApplicationEnvelope(frame.payload)
    const result = await bootstrapManager.ingestLocator(context.peerId, envelope)
    console.log('[ScopedNetwork] bootstrap locator received from', String(context.peerId).slice(0, 16),
      '- status:', result?.status, 'errorCode:', result?.errorCode || result?.reason || 'none')
    // Only real scoped sessions promote and gossip. The inspect path (tracked
    // absent) must stay inert: it feeds fixtures and diagnostics, never live
    // discovery. Promotion runs after ingestLocator has retained the locator,
    // so the scheduled follow can find it. The announcing peer need not host
    // the catalog — on a relay mesh the locator arrives through an
    // intermediate hop, and the publisher topic is dialed directly once named.
    // Only real scoped sessions promote and gossip. The inspect path (tracked
    // absent) must stay inert: it feeds fixtures and diagnostics, never live
    // discovery. Promotion runs after ingestLocator has retained the locator,
    // so the scheduled follow can find it — and fires for replays too, since
    // a replay still names a verified retained locator. Gossip is gated to
    // first-accept only: forwarding an identical locator again is what a
    // gossip cycle needs suppressed.
    if ((result.status === 'accepted' || result.status === 'replay') && result.publisherId && context.tracked && !localPublishers.has(result.publisherId)) {
      void addPublisherFollowReason({
        publisherId: result.publisherId,
        reason: 'bootstrap:auto',
      }).catch(error => console.log('[ScopedNetwork] follow-reason FAILED:', error?.message || error))
    }
    if (result.status === 'accepted' && context.tracked) {
      // Transitive discovery: re-gossip the origin-signed envelope to every
      // other live bootstrap session, excluding the one it arrived on.
      try { gossipLocator(envelope, context.tracked) } catch { /* best-effort gossip */ }
    }
    counters.acceptedFrames++
    return result
  }
  async function publishBootstrapLocator ({ locator, envelope } = {}) {
    if (!canPublish()) fail('explicit contribution upload permission is required')
    const bootstrapScope = findScope('bootstrap', deriveBootstrapTopic({ protocolMajor, networkId }))
    if (!bootstrapScope) fail('bootstrap discovery is disabled')
    const value = envelope || locator?.envelope || locator
    const payload = encodeApplicationEnvelope(value)
    let delivered = 0
    for (const session of bootstrapScope.sessions.values()) {
      if (session.closed || session.state !== 'active') continue
      const frame = encodePeerFrame({ purpose: 'bootstrap', type: 'locator', requestId: allocateRequestId(), payload })
      const sender = session.channel?.messages?.[0] || session.message
      if (sender?.send?.(frame, session.channel) !== false) delivered++
    }
    return { status: 'published', delivered }
  }

  function listBootstrapLocators () {
    return bootstrapManager.listLocators()
  }
  // Session activation is also the moment a relay re-gossips every locator it
  // has verified but does not publish itself. The origin-signed envelope is
  // forwarded verbatim, so each hop re-verifies signature, TTL, and replay
  // before accepting - gossip carries candidates, never authority.
  function sendLocatorsToSession (tracked) {
    for (const { locator } of localBootstrapLocators.values()) sendBootstrapLocatorToSession(tracked, locator)
    for (const locator of bootstrapManager.listLocators()) {
      if (localBootstrapLocators.has(locator.publisherId)) continue
      sendBootstrapLocatorToSession(tracked, locator)
    }
  }
  // Forward a freshly ingested locator envelope to every other live bootstrap
  // session.
  function gossipLocator (envelope, excludeSession = null) {
    const scope = findScope('bootstrap', deriveBootstrapTopic({ protocolMajor, networkId }))
    if (!scope) return 0
    let delivered = 0
    for (const session of scope.sessions.values()) {
      if (session === excludeSession || session.closed || session.state !== 'active') continue
      if (sendBootstrapLocatorToSession(session, { envelope })) delivered++
    }
    return delivered
  }

  function removeLocalLocator (publisherId) {
    const record = localBootstrapLocators.get(publisherId)
    if (record?.timer) cancelBootstrapLocatorRefresh(record.timer)
    return localBootstrapLocators.delete(publisherId)
  }

  function close () {
    for (const value of localBootstrapLocators.values()) {
      if (value.timer) cancelBootstrapLocatorRefresh(value.timer)
    }
    localBootstrapLocators.clear()
  }

  return {
    bootstrapManager, handleBootstrapFrame, refreshLocalBootstrapLocator, sendLocatorsToSession, gossipLocator,
    removeLocalLocator, publishBootstrapLocator, listBootstrapLocators, close,
  }
}
