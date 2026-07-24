import { verifyIndexFeedPage } from './feed-contract.js'

export function createIndexFeedManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxRecordsPerSync = Number.isSafeInteger(options.maxRecordsPerSync) ? options.maxRecordsPerSync : 1024
  const subscribed = new Set()
  const checkpoints = new Map()
  const records = []

  return {
    subscribe(curatorId) { subscribed.add(String(curatorId)) },
    unsubscribe(curatorId) { subscribed.delete(String(curatorId)); checkpoints.delete(String(curatorId)) },
    getCheckpoint(curatorId) { return checkpoints.get(String(curatorId)) || null },
    getRecords() { return records.slice() },
    async syncFeed({ curatorId, startCursor = '0', fetchPage } = {}) {
      curatorId = String(curatorId || '')
      if (!subscribed.has(curatorId)) return { status: 'not-subscribed' }
      let cursor = startCursor
      let ingested = 0
      while (true) {
        const page = await fetchPage(cursor)
        const verified = await verifyIndexFeedPage(page?.envelope, { curatorId, now: now() })
        if (!verified) return { status: 'quarantined', errorCode: 'INVALID_PAGE' }
        if (verified.body.pageCursor !== cursor) return { status: 'quarantined', errorCode: 'STALE_OR_FORKED_CURSOR' }
        for (const record of verified.body.records) {
          if (ingested >= maxRecordsPerSync) {
            checkpoints.set(curatorId, { cursor, updatedAt: now() })
            return { status: 'partial', nextCursor: cursor }
          }
          records.push({ ...record, sourceId: `${curatorId}:${verified.pageId}` })
          ingested++
        }
        cursor = verified.body.nextCursor
        checkpoints.set(curatorId, { cursor, updatedAt: now() })
        if (cursor != null && ingested >= maxRecordsPerSync) return { status: 'partial', nextCursor: cursor, ingested }
        if (cursor == null) return { status: 'complete', nextCursor: null, ingested }
      }
    },
  }
}
