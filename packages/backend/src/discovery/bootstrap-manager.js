import { createWindowedIngestBudget, normalizeBudgetLimit } from '../bounded-ingest-budget.js'

import { verifyBootstrapLocator } from './bootstrap-protocol.js'
import b4a from 'b4a'

async function verifyLocatorEnvelope(envelope, options, currentTime) {
  try {
    const verified = await verifyBootstrapLocator(envelope, { ...options, now: currentTime })
    if (!verified) return { quarantined: true, errorCode: 'INVALID_LOCATOR' }
    return { verified }
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('PROTOCOL_')) {
      return { quarantined: true, errorCode: error.code }
    }
    throw error
  }
}

function checkExistingLocator(current, body, envelope, maxPublishers, currentPublishersCount) {
  if (current && (body.issuedAt < current.issuedAt || (body.issuedAt === current.issuedAt && body.catalogEpoch < current.catalogEpoch))) {
    return { status: 'rejected', errorCode: 'STALE_LOCATOR' }
  }
  // Identical re-delivery (a gossip cycle re-forwarding the same signed
  // locator) must not re-announce as fresh: the accepted status is what
  // triggers re-gossip, so classifying it as a replay is what terminates
  // the flood in a cyclic topology.
  if (current && current.envelope && b4a.isBuffer(current.envelope) && b4a.isBuffer(envelope) && b4a.equals(current.envelope, envelope)) {
    return { status: 'replay', errorCode: 'DUPLICATE_LOCATOR', publisherId: body.publisherId }
  }
  if (!current && currentPublishersCount >= maxPublishers) {
    return { status: 'rejected', errorCode: 'PUBLISHER_PROJECTION_BUDGET_EXCEEDED' }
  }
  return null
}
export function createBootstrapManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const budgetWindowMs = normalizeBudgetLimit(options.budgetWindowMs, 60_000)
  const maxLocatorsPerPeer = normalizeBudgetLimit(options.maxLocatorsPerPeer, 128)
  const maxLocatorsPerPublisherPerWindow = normalizeBudgetLimit(options.maxLocatorsPerPublisherPerWindow, 32)
  const maxPublishers = normalizeBudgetLimit(options.maxPublishers, 4096)
  const maxSeenLocators = normalizeBudgetLimit(options.maxSeenLocators, 4096)
  const acceptLocator = typeof options.acceptLocator === 'function' ? options.acceptLocator : () => true
  const onAcceptedLocator = typeof options.onAcceptedLocator === 'function' ? options.onAcceptedLocator : () => true
  const budget = createWindowedIngestBudget({
    now,
    windowMs: budgetWindowMs,
    maxTrackedKeys: options.maxBudgetKeys,
  })
  const locatorsByPublisher = new Map()
  const seen = new Map()

  function pruneExpired(current = Number(now())) {
    for (const [publisherId, locator] of locatorsByPublisher) {
      if (locator.expiresAt < current) locatorsByPublisher.delete(publisherId)
    }
  }

  function pruneSeen(current) {
    for (const [key, seenAt] of seen) {
      if (current < seenAt || current - seenAt >= budgetWindowMs) seen.delete(key)
    }
  }

  function rememberReplay(key, current) {
    pruneSeen(current)
    if (seen.has(key)) return true
    if (seen.size >= maxSeenLocators) seen.delete(seen.keys().next().value)
    seen.set(key, current)
    return false
  }

  return {
    async ingestLocator(peerId, envelope) {
      const currentTime = Number(now())
      pruneExpired(currentTime)
      const peerReservation = budget.reserve([{
        scope: 'bootstrap-peer',
        key: String(peerId),
        limit: maxLocatorsPerPeer,
        errorCode: 'PEER_LOCATOR_WINDOW_BUDGET_EXCEEDED',
      }])
      if (!peerReservation.accepted) {
        return {
          status: 'quota-exceeded',
          errorCode: peerReservation.errorCode,
          resetAt: peerReservation.resetAt,
        }
      }

      const verification = await verifyLocatorEnvelope(envelope, options, currentTime)
      if (verification.quarantined) {
        return { status: 'quarantined', errorCode: verification.errorCode }
      }
      const verified = verification.verified
      const body = verified.body
      const replayKey = `${String(peerId)}\0${body.publisherId}\0${body.catalogHead}\0${body.issuedAt}`
      pruneSeen(currentTime)
      if (seen.has(replayKey)) return { status: 'replay', errorCode: 'DUPLICATE_LOCATOR' }

      const publisherReservation = budget.reserve([{
        scope: 'bootstrap-publisher',
        key: body.publisherId,
        limit: maxLocatorsPerPublisherPerWindow,
        errorCode: 'PUBLISHER_LOCATOR_WINDOW_BUDGET_EXCEEDED',
      }])
      if (!publisherReservation.accepted) {
        return {
          status: 'rejected',
          errorCode: publisherReservation.errorCode,
          resetAt: publisherReservation.resetAt,
        }
      }
      rememberReplay(replayKey, currentTime)

      if (!await acceptLocator(body, {
        peerId: String(peerId),
        trusted: verified.trusted,
        catalogChainVerified: verified.catalogChainVerified,
      })) {
        return { status: 'rejected', errorCode: 'LOCAL_POLICY_REJECTED' }
      }

      const current = locatorsByPublisher.get(body.publisherId)
      const existingCheck = checkExistingLocator(current, body, envelope, maxPublishers, locatorsByPublisher.size)
      if (existingCheck) return existingCheck

      const locator = {
        ...body,
        signerId: verified.signerId,
        trusted: verified.trusted,
        catalogChainVerified: verified.catalogChainVerified,
        // The origin-signed envelope is retained so a gossiper can forward
        // the locator verbatim on later session activations without
        // re-signing it; every hop re-verifies signature and TTL.
        envelope,
      }
      if (!await onAcceptedLocator(locator, { peerId: String(peerId) })) {
        return { status: 'rejected', errorCode: 'LOCAL_PROJECTION_REJECTED' }
      }
      locatorsByPublisher.set(body.publisherId, locator)
      return { status: 'accepted', publisherId: body.publisherId }
    },
    getLocator(publisherId) {
      pruneExpired()
      return locatorsByPublisher.get(String(publisherId).toLowerCase()) || null
    },
    listLocators() {
      pruneExpired()
      return Array.from(locatorsByPublisher.values()).sort((a, b) => a.publisherId.localeCompare(b.publisherId))
    },
    getIntroducedPublisherIds() {
      pruneExpired()
      return Array.from(locatorsByPublisher.keys()).sort()
    },
  }
}
