import { verifyPublisherCatalogPage } from './publisher-protocol.js'

export function createPublisherManager(options = {}) {
  const following = new Set()
  const checkpoints = new Map()
  const quarantined = []
  const maxPagesPerSync = Number(options.maxPagesPerSync || 32)
  const maxBatchesPerSync = Number(options.maxBatchesPerSync || 256)
  const ingestBatch = options.ingestBatch || (async () => {})

  return {
    async followPublisher(publisherId) {
      following.add(String(publisherId).toLowerCase())
      return { status: 'following' }
    },
    async unfollowPublisher(publisherId) {
      following.delete(String(publisherId).toLowerCase())
      return { status: 'unfollowed' }
    },
    isFollowing(publisherId) {
      return following.has(String(publisherId).toLowerCase())
    },
    getCheckpoint(publisherId) {
      return checkpoints.get(String(publisherId).toLowerCase()) || null
    },
    getQuarantined() {
      return quarantined.slice()
    },
    async syncPublisher({ publisherId, startCursor = '0', fetchPage }) {
      const id = String(publisherId).toLowerCase()
      let cursor = startCursor
      let pages = 0
      let batches = 0
      while (true) {
        if (pages >= maxPagesPerSync || batches >= maxBatchesPerSync) {
          checkpoints.set(id, { cursor })
          return { status: 'partial', nextCursor: cursor }
        }
        const page = await fetchPage(cursor)
        const verified = await verifyPublisherCatalogPage(page?.envelope || page, { publisherId: id })
        if (!verified) {
          quarantined.push({ publisherId: id, cursor, reason: 'invalid-page' })
          return { status: 'quarantined', errorCode: 'INVALID_PAGE' }
        }
        if (verified.body.pageCursor !== cursor) {
          quarantined.push({ publisherId: id, cursor, reason: 'stale-or-forked-cursor' })
          return { status: 'quarantined', errorCode: 'STALE_OR_FORKED_CURSOR' }
        }
        for (const batch of verified.body.batches || []) {
          if (batches >= maxBatchesPerSync) {
            checkpoints.set(id, { cursor })
            return { status: 'partial', nextCursor: cursor }
          }
          await ingestBatch(batch, { publisherId: id, cursor })
          batches++
        }
        pages++
        cursor = verified.body.nextCursor
        checkpoints.set(id, { cursor, catalogHead: verified.body.catalogHead })
        if (!cursor) return { status: 'complete', nextCursor: null, pages, batches }
      }
    },
  }
}
