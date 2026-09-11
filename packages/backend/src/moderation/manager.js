import { createWindowedIngestBudget, normalizeBudgetLimit } from '../bounded-ingest-budget.js'

import { verifyModerationFeedPage } from './feed-contract.js'

export function enforceModerationDecision(decision = {}, operation = '') {
  if (operation === 'download' && decision.action === 'not-downloaded') return { allowed: false, reason: 'not-downloaded', evidence: decision.evidence || [] }
  if (operation === 'seed' && (decision.action === 'not-seeded' || decision.action === 'not-downloaded')) return { allowed: false, reason: decision.action, evidence: decision.evidence || [] }
  return { allowed: true, reason: null, evidence: decision.evidence || [] }
}
function summarizeSyncResult({ ingested, rejected, duplicates, firstRejectionCode, nextCursor }) {
  if (ingested === 0 && rejected > 0) {
    return { status: 'rejected', errorCode: firstRejectionCode, nextCursor, ingested, rejected, duplicates }
  }
  if (ingested === 0 && duplicates > 0) {
    return { status: 'rejected', errorCode: 'DUPLICATE_RECORD', nextCursor, ingested, rejected, duplicates }
  }
  if (rejected === 0 && duplicates === 0) {
    return { status: nextCursor == null ? 'complete' : 'partial', nextCursor }
  }
  return {
    status: nextCursor == null ? 'complete' : 'partial',
    errorCode: firstRejectionCode,
    nextCursor,
    ingested,
    rejected,
    duplicates,
  }
}


export function createModerationManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxRecords = normalizeBudgetLimit(options.maxRecords, 4096)
  const maxRecordsPerSync = normalizeBudgetLimit(options.maxRecordsPerSync, 128)
  const maxPageStates = normalizeBudgetLimit(options.maxPageStates, 2048)
  const maxRecordsPerModeratorPerWindow = normalizeBudgetLimit(options.maxRecordsPerModeratorPerWindow, 1024)
  const maxRecordsPerPublisherPerWindow = normalizeBudgetLimit(options.maxRecordsPerPublisherPerWindow, 512)
  const maxRecordsGlobalPerWindow = normalizeBudgetLimit(options.maxRecordsGlobalPerWindow, 4096)
  const maxRecordsPerAgentPerWindow = normalizeBudgetLimit(options.maxRecordsPerAgentPerWindow, 512)
  const maxRecordsPerCollectionPerWindow = normalizeBudgetLimit(options.maxRecordsPerCollectionPerWindow, 512)
  const acceptRecord = typeof options.acceptRecord === 'function' ? options.acceptRecord : () => true
  const onRecordsChanged = typeof options.onRecordsChanged === 'function' ? options.onRecordsChanged : async () => {}
  const stateRepository = options.stateRepository || null
  const budget = createWindowedIngestBudget({
    now,
    windowMs: options.budgetWindowMs,
    maxTrackedKeys: options.maxBudgetKeys,
  })
  const subscribed = new Set()
  const checkpoints = new Map()
  const pageStates = new Map()
  const records = new Map()

  async function persistState() {
    await stateRepository?.save?.({
      version: 1,
      subscribed: [...subscribed].sort(),
      checkpoints: [...checkpoints.entries()],
      pageStates: [...pageStates.entries()],
      records: [...records.entries()],
      budget: budget.snapshot(),
    })
  }

  async function restoreState() {
    const state = await stateRepository?.load?.()
    if (!state || state.version !== 1) return
    if (!Array.isArray(state.subscribed) || state.subscribed.length > 256 ||
        !Array.isArray(state.checkpoints) || state.checkpoints.length > 256 ||
        !Array.isArray(state.pageStates) || state.pageStates.length > maxPageStates ||
        !Array.isArray(state.records) || state.records.length > maxRecords ||
        !budget.restore(state.budget)) return
    for (const id of state.subscribed) subscribed.add(String(id))
    for (const [id, checkpoint] of state.checkpoints) checkpoints.set(String(id), checkpoint)
    for (const [key, value] of state.pageStates) pageStates.set(String(key), value)
    for (const [key, value] of state.records) records.set(String(key), { ...value })
  }

  const ready = stateRepository?.load ? restoreState() : Promise.resolve()

  function rememberPage(key, pageId) {
    let state = pageStates.get(key)
    if (state) return state
    if (pageStates.size >= maxPageStates) pageStates.delete(pageStates.keys().next().value)
    state = { pageId, nextIndex: 0, nextCursor: null, complete: false }
    pageStates.set(key, state)
    return state
  }

  function reserveRecord(moderatorId, record) {
    const requirements = [
      {
        scope: 'global',
        key: 'all',
        limit: maxRecordsGlobalPerWindow,
        errorCode: 'GLOBAL_WINDOW_BUDGET_EXCEEDED',
      },
      {
        scope: 'moderation-index',
        key: moderatorId,
        limit: maxRecordsPerModeratorPerWindow,
        errorCode: 'MODERATION_INDEX_WINDOW_BUDGET_EXCEEDED',
      },
    ]
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
    ready,
    subscribe(moderatorId) {
      subscribed.add(String(moderatorId))
      return ready.then(persistState)
    },
    async unsubscribe(moderatorId) {
      await ready
      const id = String(moderatorId)
      subscribed.delete(id)
      checkpoints.delete(id)
      for (const key of pageStates.keys()) {
        if (key.startsWith(`${id}\0`)) pageStates.delete(key)
      }
      let removed = 0
      for (const key of records.keys()) {
        if (key.startsWith(`${id}\0`)) {
          records.delete(key)
          removed++
        }
      }
      await persistState()
      if (removed > 0) {
        await onRecordsChanged({ reason: 'records-removed', moderatorId: id, accepted: 0, removed })
      }
    },
    getCheckpoint(moderatorId) {
      return checkpoints.get(String(moderatorId)) || null
    },
    getRecords() {
      return Array.from(records.values())
    },
    async syncFeed({ moderatorId, startCursor = null, fetchPage } = {}) {
      await ready
      moderatorId = String(moderatorId || '')
      if (!subscribed.has(moderatorId)) return { status: 'not-subscribed' }
      let cursor = startCursor ?? checkpoints.get(moderatorId)?.cursor ?? '0'
      if (cursor == null) return { status: 'complete', nextCursor: null, ingested: 0 }
      const counts = {
        ingested: 0,
        rejected: 0,
        duplicates: 0,
        processed: 0,
        firstRejectionCode: null,
        changed: 0,
      }
      async function persistAndNotify() {
        await persistState()
        if (counts.changed === 0) return
        const accepted = counts.changed
        await onRecordsChanged({ reason: 'records-accepted', moderatorId, accepted, removed: 0 })
        counts.changed = 0
      }
      async function validateFeedPage(pageCursor, page) {
        let verified
        try {
          verified = await verifyModerationFeedPage(page?.envelope, {
            moderatorId,
            now: now(),
            supportedCapabilities: options.supportedCapabilities,
          })
        } catch (error) {
          if (typeof error?.code === 'string' && error.code.startsWith('PROTOCOL_')) {
            return { errorResult: { status: 'quarantined', errorCode: error.code } }
          }
          throw error
        }
        if (!verified) return { errorResult: { status: 'quarantined', errorCode: 'INVALID_PAGE' } }
        if (verified.body.pageCursor !== pageCursor) return { errorResult: { status: 'quarantined', errorCode: 'STALE_OR_FORKED_CURSOR' } }

        const pageKey = `${moderatorId}\0${pageCursor}`
        const existing = pageStates.get(pageKey)
        if (existing?.pageId !== undefined && existing.pageId !== verified.pageId) {
          return { errorResult: { status: 'quarantined', errorCode: 'STALE_OR_FORKED_CURSOR' } }
        }
        return { verified, pageKey }
      }
      async function ingestRecord(record, pageId) {
        if (!await acceptRecord(record, { moderatorId, pageId })) {
          return 'rejected'
        }
        const key = recordKey(moderatorId, record)
        const previous = records.get(key)
        const next = { ...record, sourceId: `${moderatorId}:${pageId}` }
        if (previous && previous.action === next.action && previous.label === next.label && previous.reason === next.reason) {
          return 'duplicate'
        }
        if (!previous && records.size >= maxRecords) records.delete(records.keys().next().value)
        records.set(key, next)
        return 'accepted'
      }
      async function processPageRecords(verified, state) {
        for (let index = state.nextIndex; index < verified.body.records.length; index++) {
          if (counts.processed >= maxRecordsPerSync) {
            return { budgetExceeded: true }
          }
          const record = verified.body.records[index]
          const reservation = reserveRecord(moderatorId, record)
          if (!reservation.accepted) {
            return { reservationError: reservation }
          }
          state.nextIndex = index + 1
          counts.processed++
          const outcome = await ingestRecord(record, verified.pageId)
          if (outcome === 'rejected') {
            counts.rejected++
            counts.firstRejectionCode ||= 'LOCAL_POLICY_REJECTED'
          } else if (outcome === 'duplicate') {
            counts.duplicates++
          } else {
            counts.ingested++
            counts.changed++
          }
        }
        return null
      }
      for (;;) {
        const page = await fetchPage(cursor)
        const validated = await validateFeedPage(cursor, page)
        if (validated.errorResult) return validated.errorResult
        const { verified, pageKey } = validated

        const state = rememberPage(pageKey, verified.pageId)
        if (state.complete) {
          cursor = state.nextCursor
          checkpoints.set(moderatorId, { cursor, updatedAt: now() })
          if (cursor == null) {
            await persistAndNotify()
            return { status: 'complete', nextCursor: null, ingested: counts.ingested, rejected: counts.rejected, duplicates: counts.duplicates }
          }
          continue
        }

        const stop = await processPageRecords(verified, state)
        if (stop?.budgetExceeded) {
          checkpoints.set(moderatorId, { cursor, updatedAt: now() })
          await persistAndNotify()
          return { status: 'partial', errorCode: 'SYNC_RECORD_BUDGET_EXCEEDED', nextCursor: cursor, ingested: counts.ingested, rejected: counts.rejected, duplicates: counts.duplicates }
        }
        if (stop?.reservationError) {
          checkpoints.set(moderatorId, { cursor, updatedAt: now() })
          await persistAndNotify()
          return {
            status: 'partial',
            errorCode: stop.reservationError.errorCode,
            nextCursor: cursor,
            resetAt: stop.reservationError.resetAt,
            ingested: counts.ingested,
            rejected: counts.rejected,
            duplicates: counts.duplicates,
          }
        }

        state.complete = true
        state.nextCursor = verified.body.nextCursor
        checkpoints.set(moderatorId, { cursor: state.nextCursor, updatedAt: now() })
        cursor = state.nextCursor
        if (cursor != null) continue
        await persistAndNotify()
        return summarizeSyncResult({
          ingested: counts.ingested,
          rejected: counts.rejected,
          duplicates: counts.duplicates,
          firstRejectionCode: counts.firstRejectionCode,
          nextCursor: state.nextCursor,
        })
      }
    },
  }
}
