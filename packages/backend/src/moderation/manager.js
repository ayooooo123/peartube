import { verifyModerationFeedPage } from './feed-contract.js'

export function enforceModerationDecision(decision = {}, operation = '') {
  if (operation === 'download' && decision.action === 'not-downloaded') return { allowed: false, reason: 'not-downloaded', evidence: decision.evidence || [] }
  if (operation === 'seed' && (decision.action === 'not-seeded' || decision.action === 'not-downloaded')) return { allowed: false, reason: decision.action, evidence: decision.evidence || [] }
  return { allowed: true, reason: null, evidence: decision.evidence || [] }
}

export function createModerationManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const subscribed = new Set()
  const checkpoints = new Map()
  const records = []

  return {
    subscribe(moderatorId) { subscribed.add(String(moderatorId)) },
    unsubscribe(moderatorId) { subscribed.delete(String(moderatorId)); checkpoints.delete(String(moderatorId)) },
    getCheckpoint(moderatorId) { return checkpoints.get(String(moderatorId)) || null },
    getRecords() { return records.slice() },
    async syncFeed({ moderatorId, startCursor = '0', fetchPage } = {}) {
      moderatorId = String(moderatorId || '')
      if (!subscribed.has(moderatorId)) return { status: 'not-subscribed' }
      const page = await fetchPage(startCursor)
      const verified = await verifyModerationFeedPage(page?.envelope, { moderatorId, now: now() })
      if (!verified) return { status: 'quarantined', errorCode: 'INVALID_PAGE' }
      if (verified.body.pageCursor !== startCursor) return { status: 'quarantined', errorCode: 'STALE_OR_FORKED_CURSOR' }
      for (const record of verified.body.records) records.push({ ...record, sourceId: `${moderatorId}:${verified.pageId}` })
      checkpoints.set(moderatorId, { cursor: verified.body.nextCursor, updatedAt: now() })
      return { status: verified.body.nextCursor == null ? 'complete' : 'partial', nextCursor: verified.body.nextCursor }
    },
  }
}
