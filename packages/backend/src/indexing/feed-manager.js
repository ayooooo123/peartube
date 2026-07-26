import { createWindowedIngestBudget, normalizeBudgetLimit } from '../bounded-ingest-budget.js'

import { verifyIndexFeedPage } from './feed-contract.js'

export function createIndexFeedManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxRecordsPerSync = normalizeBudgetLimit(options.maxRecordsPerSync, 1024)
  const maxStoredRecords = normalizeBudgetLimit(options.maxStoredRecords, 10_000)
  const maxPageStates = normalizeBudgetLimit(options.maxPageStates, 4096)
  const maxRecordsPerIndexPerWindow = normalizeBudgetLimit(options.maxRecordsPerIndexPerWindow, 2048)
  const maxRecordsPerPublisherPerWindow = normalizeBudgetLimit(options.maxRecordsPerPublisherPerWindow, 512)
  const maxRecordsGlobalPerWindow = normalizeBudgetLimit(options.maxRecordsGlobalPerWindow, 8192)
  const maxRecordsPerAgentPerWindow = normalizeBudgetLimit(options.maxRecordsPerAgentPerWindow, 512)
  const maxRecordsPerCollectionPerWindow = normalizeBudgetLimit(options.maxRecordsPerCollectionPerWindow, 512)
  const acceptRecord = typeof options.acceptRecord === 'function' ? options.acceptRecord : () => true
  const onAcceptedRecord = typeof options.onAcceptedRecord === 'function' ? options.onAcceptedRecord : () => true
  const onRecordsRemoved = typeof options.onRecordsRemoved === 'function' ? options.onRecordsRemoved : () => {}
  const stateRepository = options.stateRepository || null
  const supportedCapabilities = options.supportedCapabilities
  const budget = createWindowedIngestBudget({
    now,
    windowMs: options.budgetWindowMs,
    maxTrackedKeys: options.maxBudgetKeys,
  })
  const subscribed = new Set()
  const checkpoints = new Map()
  const pageStates = new Map()
  let records = []
  let oldestRecord = 0

  async function persistState() {
    await stateRepository?.save?.({
      version: 1,
      subscribed: [...subscribed].sort(),
      checkpoints: [...checkpoints.entries()],
      pageStates: [...pageStates.entries()],
      records: snapshotRecords(),
      budget: budget.snapshot(),
    })
  }

  async function restoreState() {
    const state = await stateRepository?.load?.()
    if (!state || state.version !== 1) return
    if (!Array.isArray(state.subscribed) || state.subscribed.length > 256 ||
        !Array.isArray(state.checkpoints) || state.checkpoints.length > 256 ||
        !Array.isArray(state.pageStates) || state.pageStates.length > maxPageStates ||
        !Array.isArray(state.records) || state.records.length > maxStoredRecords ||
        !budget.restore(state.budget)) return
    for (const id of state.subscribed) subscribed.add(String(id))
    for (const [id, checkpoint] of state.checkpoints) checkpoints.set(String(id), checkpoint)
    for (const [key, value] of state.pageStates) pageStates.set(String(key), value)
    records = state.records.map(record => ({ ...record }))
    oldestRecord = 0
  }

  const ready = stateRepository?.load ? restoreState() : Promise.resolve()

  function appendRecord(record) {
    if (records.length < maxStoredRecords) {
      records.push(record)
      return
    }
    records[oldestRecord] = record
    oldestRecord = (oldestRecord + 1) % maxStoredRecords
  }

  function snapshotRecords() {
    if (records.length < maxStoredRecords || oldestRecord === 0) return records.slice()
    return records.slice(oldestRecord).concat(records.slice(0, oldestRecord))
  }

  async function removeCuratorRecords(curatorId) {
    const id = String(curatorId)
    const removed = snapshotRecords().filter(record => String(record.indexId) === id)
    if (removed.length === 0) return
    records = snapshotRecords().filter(record => String(record.indexId) !== id)
    oldestRecord = 0
    await onRecordsRemoved(removed, { curatorId: id })
  }

  async function quarantineCurator(curatorId, errorCode) {
    await removeCuratorRecords(curatorId)
    await persistState()
    return { status: 'quarantined', errorCode }
  }

  function rememberPage(key, pageId) {
    let state = pageStates.get(key)
    if (state) return state
    if (pageStates.size >= maxPageStates) pageStates.delete(pageStates.keys().next().value)
    state = { pageId, nextIndex: 0, nextCursor: null, complete: false }
    pageStates.set(key, state)
    return state
  }

  function reserveRecord(curatorId, record) {
    return budget.reserve([
      {
        scope: 'global',
        key: 'all',
        limit: maxRecordsGlobalPerWindow,
        errorCode: 'GLOBAL_WINDOW_BUDGET_EXCEEDED',
      },
      {
        scope: 'index',
        key: curatorId,
        limit: maxRecordsPerIndexPerWindow,
        errorCode: 'INDEX_WINDOW_BUDGET_EXCEEDED',
      },
      {
        scope: 'publisher',
        key: record.publisherId,
        limit: maxRecordsPerPublisherPerWindow,
        errorCode: 'PUBLISHER_WINDOW_BUDGET_EXCEEDED',
      },
      {
        scope: 'agent',
        key: record.creator,
        limit: maxRecordsPerAgentPerWindow,
        errorCode: 'AGENT_WINDOW_BUDGET_EXCEEDED',
      },
      {
        scope: 'collection',
        key: record.collectionId,
        limit: maxRecordsPerCollectionPerWindow,
        errorCode: 'COLLECTION_WINDOW_BUDGET_EXCEEDED',
      },
    ])
  }

  return {
    ready,
    subscribe(curatorId) {
      subscribed.add(String(curatorId))
      return ready.then(persistState)
    },
    async unsubscribe(curatorId) {
      await ready
      const id = String(curatorId)
      subscribed.delete(id)
      checkpoints.delete(id)
      for (const key of pageStates.keys()) {
        if (key.startsWith(`${id}\0`)) pageStates.delete(key)
      }
      await removeCuratorRecords(id)
      await persistState()
    },
    getCheckpoint(curatorId) {
      return checkpoints.get(String(curatorId)) || null
    },
    getRecords() {
      // Accepted page data is owned by its curator subscription. Retained
      // bytes may remain in the bounded ring, but an unfollow immediately
      // removes every curator effect from the local projection.
      return snapshotRecords().filter(record => subscribed.has(String(record.indexId)))
    },
    async syncFeed({ curatorId, startCursor = null, fetchPage } = {}) {
      await ready
      curatorId = String(curatorId || '')
      if (!subscribed.has(curatorId)) return { status: 'not-subscribed' }
      let cursor = startCursor ?? checkpoints.get(curatorId)?.cursor ?? '0'
      if (cursor == null) return { status: 'complete', nextCursor: null, ingested: 0 }
      let ingested = 0
      let rejected = 0
      let processed = 0
      let firstRejectionCode = null
      while (true) {
        const page = await fetchPage(cursor)
        let verified
        try {
          verified = await verifyIndexFeedPage(page?.envelope, {
            curatorId,
            now: now(),
            supportedCapabilities,
          })
        } catch (error) {
          if (typeof error?.code === 'string' && error.code.startsWith('PROTOCOL_')) {
            return quarantineCurator(curatorId, error.code)
          }
          throw error
        }
        if (!verified) return quarantineCurator(curatorId, 'INVALID_PAGE')
        if (verified.body.pageCursor !== cursor) return quarantineCurator(curatorId, 'STALE_OR_FORKED_CURSOR')

        const pageKey = `${curatorId}\0${cursor}`
        const existing = pageStates.get(pageKey)
        if (existing?.pageId !== undefined && existing.pageId !== verified.pageId) {
          return quarantineCurator(curatorId, 'STALE_OR_FORKED_CURSOR')
        }
        const state = rememberPage(pageKey, verified.pageId)
        if (state.complete) {
          cursor = state.nextCursor
          checkpoints.set(curatorId, { cursor, updatedAt: now() })
          if (cursor == null) {
            await persistState()
            return { status: 'complete', nextCursor: null, ingested, rejected }
          }
          continue
        }

        for (let index = state.nextIndex; index < verified.body.records.length; index++) {
          if (processed >= maxRecordsPerSync) {
            checkpoints.set(curatorId, { cursor, updatedAt: now() })
            await persistState()
            return { status: 'partial', errorCode: 'SYNC_RECORD_BUDGET_EXCEEDED', nextCursor: cursor, ingested, rejected }
          }
          const record = verified.body.records[index]
          const reservation = reserveRecord(curatorId, record)
          if (!reservation.accepted) {
            checkpoints.set(curatorId, { cursor, updatedAt: now() })
            await persistState()
            return {
              status: 'partial',
              errorCode: reservation.errorCode,
              nextCursor: cursor,
              resetAt: reservation.resetAt,
              ingested,
              rejected,
            }
          }
          state.nextIndex = index + 1
          processed++
          if (!await acceptRecord(record, { curatorId, pageId: verified.pageId })) {
            rejected++
            if (!firstRejectionCode) firstRejectionCode = 'LOCAL_POLICY_REJECTED'
            continue
          }
          const acceptedRecord = { ...record, indexId: curatorId, sourceId: `${curatorId}:${verified.pageId}` }
          if (!await onAcceptedRecord(acceptedRecord, { curatorId, pageId: verified.pageId })) {
            rejected++
            if (!firstRejectionCode) firstRejectionCode = 'LOCAL_PROJECTION_REJECTED'
            continue
          }
          appendRecord(acceptedRecord)
          ingested++
        }

        state.complete = true
        state.nextCursor = verified.body.nextCursor
        cursor = verified.body.nextCursor
        checkpoints.set(curatorId, { cursor, updatedAt: now() })
        if (cursor == null) {
          await persistState()
          if (ingested === 0 && rejected > 0) {
            return { status: 'rejected', errorCode: firstRejectionCode, nextCursor: null, ingested, rejected }
          }
          if (rejected > 0) return { status: 'complete', nextCursor: null, ingested, rejected, errorCode: firstRejectionCode }
          return { status: 'complete', nextCursor: null, ingested }
        }
        if (processed >= maxRecordsPerSync) {
          await persistState()
          return { status: 'partial', errorCode: 'SYNC_RECORD_BUDGET_EXCEEDED', nextCursor: cursor, ingested, rejected }
        }
      }
    },
  }
}
