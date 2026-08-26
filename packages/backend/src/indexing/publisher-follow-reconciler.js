function followReason(curatorId) {
  return `index:${String(curatorId)}`
}

export function createIndexPublisherFollowReconciler(options = {}) {
  const getScopedNetwork = typeof options.getScopedNetwork === 'function'
    ? options.getScopedNetwork
    : () => null
  const getRecords = typeof options.getRecords === 'function'
    ? options.getRecords
    : () => []

  async function add(record, curatorId = record?.indexId) {
    const scopedNetwork = getScopedNetwork()
    if (!scopedNetwork?.addPublisherFollowReason || !record?.publisherId || !curatorId) return
    await scopedNetwork.addPublisherFollowReason({
      publisherId: record.publisherId,
      reason: followReason(curatorId),
    })
  }

  return Object.freeze({
    async onAcceptedRecord(record, context = {}) {
      await add(record, context.curatorId)
      return true
    },

    async onRecordsRemoved(removed = [], context = {}) {
      const curatorId = String(context.curatorId || '')
      const retained = getRecords()
      const removedPublishers = new Set(removed.map(record => record?.publisherId).filter(Boolean))
      for (const publisherId of removedPublishers) {
        if (retained.some(record =>
          String(record?.indexId) === curatorId &&
          String(record?.publisherId) === String(publisherId)
        )) continue
        await getScopedNetwork()?.removePublisherFollowReason?.({
          publisherId,
          reason: followReason(curatorId),
        })
      }
    },

    async reconcile() {
      const seen = new Set()
      for (const record of getRecords()) {
        const curatorId = String(record?.indexId || '')
        const key = `${curatorId}\0${String(record?.publisherId || '')}`
        if (!curatorId || seen.has(key)) continue
        seen.add(key)
        await add(record, curatorId)
      }
    },
  })
}
