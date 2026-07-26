import { createWindowedIngestBudget, normalizeBudgetLimit } from '../bounded-ingest-budget.js'

import { verifyIndexFeedPage } from './feed-contract.js'

export function createIndexFeedManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxRecordsPerSync = normalizeBudgetLimit(options.maxRecordsPerSync, 1024)
  const maxStoredRecords = normalizeBudgetLimit(options.maxStoredRecords, 10_000)
  const maxPageStates = normalizeBudgetLimit(options.maxPageStates, 4096)
  const maxRecordsPerIndexPerWindow = normalizeBudgetLimit(options.maxRecordsPerIndexPerWindow, 2048)
  const maxRecordsPerPublisherPerWindow = normalizeBudgetLimit(options.maxRecordsPerPublisherPerWindow, 512)
  const maxRecordsPerAgentPerWindow = normalizeBudgetLimit(options.maxRecordsPerAgentPerWindow, 512)
  const maxRecordsPerCollectionPerWindow = normalizeBudgetLimit(options.maxRecordsPerCollectionPerWindow, 512)
  const acceptRecord = typeof options.acceptRecord === 'function' ? options.acceptRecord : () => true
  const onAcceptedRecord = typeof options.onAcceptedRecord === 'function' ? options.onAcceptedRecord : () => true
  const supportedCapabilities = options.supportedCapabilities
  const budget = createWindowedIngestBudget({
    now,
    windowMs: options.budgetWindowMs,
    maxTrackedKeys: options.maxBudgetKeys,
  })
  const subscribed = new Set()
  const checkpoints = new Map()
  const pageStates = new Map()
  const records = []
  let oldestRecord = 0

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
    subscribe(curatorId) {
      subscribed.add(String(curatorId))
    },
    unsubscribe(curatorId) {
      const id = String(curatorId)
      subscribed.delete(id)
      checkpoints.delete(id)
      for (const key of pageStates.keys()) {
        if (key.startsWith(`${id}\0`)) pageStates.delete(key)
      }
    },
    getCheckpoint(curatorId) {
      return checkpoints.get(String(curatorId)) || null
    },
    getRecords() {
      return snapshotRecords()
    },
    async syncFeed({ curatorId, startCursor = '0', fetchPage } = {}) {
      curatorId = String(curatorId || '')
      if (!subscribed.has(curatorId)) return { status: 'not-subscribed' }
      let cursor = startCursor
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
            return { status: 'quarantined', errorCode: error.code }
          }
          throw error
        }
        if (!verified) return { status: 'quarantined', errorCode: 'INVALID_PAGE' }
        if (verified.body.pageCursor !== cursor) return { status: 'quarantined', errorCode: 'STALE_OR_FORKED_CURSOR' }

        const pageKey = `${curatorId}\0${cursor}`
        const existing = pageStates.get(pageKey)
        if (existing?.pageId !== undefined && existing.pageId !== verified.pageId) {
          return { status: 'quarantined', errorCode: 'STALE_OR_FORKED_CURSOR' }
        }
        const state = rememberPage(pageKey, verified.pageId)
        if (state.complete) {
          return {
            status: 'rejected',
            errorCode: 'DUPLICATE_PAGE',
            nextCursor: state.nextCursor,
            ingested,
            rejected,
          }
        }

        for (let index = state.nextIndex; index < verified.body.records.length; index++) {
          if (processed >= maxRecordsPerSync) {
            checkpoints.set(curatorId, { cursor, updatedAt: now() })
            return { status: 'partial', errorCode: 'SYNC_RECORD_BUDGET_EXCEEDED', nextCursor: cursor, ingested, rejected }
          }
          const record = verified.body.records[index]
          const reservation = reserveRecord(curatorId, record)
          if (!reservation.accepted) {
            checkpoints.set(curatorId, { cursor, updatedAt: now() })
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
          if (ingested === 0 && rejected > 0) {
            return { status: 'rejected', errorCode: firstRejectionCode, nextCursor: null, ingested, rejected }
          }
          if (rejected > 0) return { status: 'complete', nextCursor: null, ingested, rejected, errorCode: firstRejectionCode }
          return { status: 'complete', nextCursor: null, ingested }
        }
        if (processed >= maxRecordsPerSync) {
          return { status: 'partial', errorCode: 'SYNC_RECORD_BUDGET_EXCEEDED', nextCursor: cursor, ingested, rejected }
        }
      }
    },
  }
}
