import { createWindowedIngestBudget, normalizeBudgetLimit } from '../bounded-ingest-budget.js'

import { verifyModerationFeedPage } from './feed-contract.js'

export function enforceModerationDecision(decision = {}, operation = '') {
  if (operation === 'download' && decision.action === 'not-downloaded') return { allowed: false, reason: 'not-downloaded', evidence: decision.evidence || [] }
  if (operation === 'seed' && (decision.action === 'not-seeded' || decision.action === 'not-downloaded')) return { allowed: false, reason: decision.action, evidence: decision.evidence || [] }
  return { allowed: true, reason: null, evidence: decision.evidence || [] }
}

export function createModerationManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxRecords = normalizeBudgetLimit(options.maxRecords, 4096)
  const maxRecordsPerSync = normalizeBudgetLimit(options.maxRecordsPerSync, 128)
  const maxPageStates = normalizeBudgetLimit(options.maxPageStates, 2048)
  const maxRecordsPerModeratorPerWindow = normalizeBudgetLimit(options.maxRecordsPerModeratorPerWindow, 1024)
  const maxRecordsPerPublisherPerWindow = normalizeBudgetLimit(options.maxRecordsPerPublisherPerWindow, 512)
  const maxRecordsPerAgentPerWindow = normalizeBudgetLimit(options.maxRecordsPerAgentPerWindow, 512)
  const maxRecordsPerCollectionPerWindow = normalizeBudgetLimit(options.maxRecordsPerCollectionPerWindow, 512)
  const acceptRecord = typeof options.acceptRecord === 'function' ? options.acceptRecord : () => true
  const budget = createWindowedIngestBudget({
    now,
    windowMs: options.budgetWindowMs,
    maxTrackedKeys: options.maxBudgetKeys,
  })
  const subscribed = new Set()
  const checkpoints = new Map()
  const pageStates = new Map()
  const records = new Map()

  function rememberPage(key, pageId) {
    let state = pageStates.get(key)
    if (state) return state
    if (pageStates.size >= maxPageStates) pageStates.delete(pageStates.keys().next().value)
    state = { pageId, nextIndex: 0, nextCursor: null, complete: false }
    pageStates.set(key, state)
    return state
  }

  function reserveRecord(moderatorId, record) {
    const requirements = [{
      scope: 'moderation-index',
      key: moderatorId,
      limit: maxRecordsPerModeratorPerWindow,
      errorCode: 'MODERATION_INDEX_WINDOW_BUDGET_EXCEEDED',
    }]
    const targetBudgets = {
      publisher: [maxRecordsPerPublisherPerWindow, 'PUBLISHER_WINDOW_BUDGET_EXCEEDED'],
      agent: [maxRecordsPerAgentPerWindow, 'AGENT_WINDOW_BUDGET_EXCEEDED'],
      collection: [maxRecordsPerCollectionPerWindow, 'COLLECTION_WINDOW_BUDGET_EXCEEDED'],
    }
    const target = targetBudgets[record.targetType]
    if (target) {
      requirements.push({
        scope: record.targetType,
        key: record.targetId,
        limit: target[0],
        errorCode: target[1],
      })
    }
    return budget.reserve(requirements)
  }

  function recordKey(moderatorId, record) {
    return `${moderatorId}\0${record.targetType}\0${record.targetId}`
  }

  return {
    subscribe(moderatorId) {
      subscribed.add(String(moderatorId))
    },
    unsubscribe(moderatorId) {
      const id = String(moderatorId)
      subscribed.delete(id)
      checkpoints.delete(id)
      for (const key of pageStates.keys()) {
        if (key.startsWith(`${id}\0`)) pageStates.delete(key)
      }
    },
    getCheckpoint(moderatorId) {
      return checkpoints.get(String(moderatorId)) || null
    },
    getRecords() {
      return Array.from(records.values())
    },
    async syncFeed({ moderatorId, startCursor = '0', fetchPage } = {}) {
      moderatorId = String(moderatorId || '')
      if (!subscribed.has(moderatorId)) return { status: 'not-subscribed' }
      const page = await fetchPage(startCursor)
      const verified = await verifyModerationFeedPage(page?.envelope, { moderatorId, now: now() })
      if (!verified) return { status: 'quarantined', errorCode: 'INVALID_PAGE' }
      if (verified.body.pageCursor !== startCursor) return { status: 'quarantined', errorCode: 'STALE_OR_FORKED_CURSOR' }

      const pageKey = `${moderatorId}\0${startCursor}`
      const existing = pageStates.get(pageKey)
      if (existing?.pageId !== undefined && existing.pageId !== verified.pageId) {
        return { status: 'quarantined', errorCode: 'STALE_OR_FORKED_CURSOR' }
      }
      const state = rememberPage(pageKey, verified.pageId)
      if (state.complete) {
        return { status: 'rejected', errorCode: 'DUPLICATE_PAGE', nextCursor: state.nextCursor }
      }

      let ingested = 0
      let rejected = 0
      let duplicates = 0
      let firstRejectionCode = null
      for (let index = state.nextIndex; index < verified.body.records.length; index++) {
        if (ingested >= maxRecordsPerSync) {
          checkpoints.set(moderatorId, { cursor: startCursor, updatedAt: now() })
          return { status: 'partial', errorCode: 'SYNC_RECORD_BUDGET_EXCEEDED', nextCursor: startCursor, ingested, rejected, duplicates }
        }
        const record = verified.body.records[index]
        const reservation = reserveRecord(moderatorId, record)
        if (!reservation.accepted) {
          checkpoints.set(moderatorId, { cursor: startCursor, updatedAt: now() })
          return {
            status: 'partial',
            errorCode: reservation.errorCode,
            nextCursor: startCursor,
            resetAt: reservation.resetAt,
            ingested,
            rejected,
            duplicates,
          }
        }
        state.nextIndex = index + 1
        if (!await acceptRecord(record, { moderatorId, pageId: verified.pageId })) {
          rejected++
          firstRejectionCode ||= 'LOCAL_POLICY_REJECTED'
          continue
        }
        const key = recordKey(moderatorId, record)
        const previous = records.get(key)
        const next = { ...record, sourceId: `${moderatorId}:${verified.pageId}` }
        if (previous && previous.action === next.action && previous.label === next.label && previous.reason === next.reason) {
          duplicates++
          continue
        }
        if (!previous && records.size >= maxRecords) records.delete(records.keys().next().value)
        records.set(key, next)
        ingested++
      }

      state.complete = true
      state.nextCursor = verified.body.nextCursor
      checkpoints.set(moderatorId, { cursor: state.nextCursor, updatedAt: now() })
      if (ingested === 0 && rejected > 0) {
        return { status: 'rejected', errorCode: firstRejectionCode, nextCursor: state.nextCursor, ingested, rejected, duplicates }
      }
      if (ingested === 0 && duplicates > 0) {
        return { status: 'rejected', errorCode: 'DUPLICATE_RECORD', nextCursor: state.nextCursor, ingested, rejected, duplicates }
      }
      if (rejected === 0 && duplicates === 0) {
        return { status: state.nextCursor == null ? 'complete' : 'partial', nextCursor: state.nextCursor }
      }
      return {
        status: state.nextCursor == null ? 'complete' : 'partial',
        errorCode: firstRejectionCode,
        nextCursor: state.nextCursor,
        ingested,
        rejected,
        duplicates,
      }
    },
  }
}
