import { createWindowedIngestBudget, normalizeBudgetLimit } from '../bounded-ingest-budget.js'

import { verifyBootstrapLocator } from './bootstrap-protocol.js'

export function createBootstrapManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const budgetWindowMs = normalizeBudgetLimit(options.budgetWindowMs, 60_000)
  const maxLocatorsPerPeer = normalizeBudgetLimit(options.maxLocatorsPerPeer, 128)
  const maxLocatorsPerPublisherPerWindow = normalizeBudgetLimit(options.maxLocatorsPerPublisherPerWindow, 32)
  const maxPublishers = normalizeBudgetLimit(options.maxPublishers, 4096)
  const maxSeenLocators = normalizeBudgetLimit(options.maxSeenLocators, 4096)
  const acceptLocator = typeof options.acceptLocator === 'function' ? options.acceptLocator : () => true
  const budget = createWindowedIngestBudget({
    now,
    windowMs: budgetWindowMs,
    maxTrackedKeys: options.maxBudgetKeys,
  })
  const locatorsByPublisher = new Map()
  const seen = new Map()

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

      let verified
      try {
        verified = await verifyBootstrapLocator(envelope, { ...options, now: currentTime })
      } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('PROTOCOL_')) {
          return { status: 'quarantined', errorCode: error.code }
        }
        throw error
      }
      if (!verified) return { status: 'quarantined', errorCode: 'INVALID_LOCATOR' }
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
      if (current && (body.issuedAt < current.issuedAt || (body.issuedAt === current.issuedAt && body.catalogEpoch < current.catalogEpoch))) {
        return { status: 'rejected', errorCode: 'STALE_LOCATOR' }
      }
      if (!current && locatorsByPublisher.size >= maxPublishers) {
        return { status: 'rejected', errorCode: 'PUBLISHER_PROJECTION_BUDGET_EXCEEDED' }
      }
      if (!current || body.issuedAt > current.issuedAt || (body.issuedAt === current.issuedAt && body.catalogEpoch >= current.catalogEpoch)) {
        locatorsByPublisher.set(body.publisherId, {
          ...body,
          trusted: verified.trusted,
          catalogChainVerified: verified.catalogChainVerified,
        })
      }
      return { status: 'accepted', publisherId: body.publisherId }
    },
    getLocator(publisherId) {
      return locatorsByPublisher.get(String(publisherId).toLowerCase()) || null
    },
    listLocators() {
      return Array.from(locatorsByPublisher.values()).sort((a, b) => a.publisherId.localeCompare(b.publisherId))
    },
  }
}
