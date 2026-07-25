import b4a from 'b4a'

import { createWindowedIngestBudget, normalizeBudgetLimit } from '../bounded-ingest-budget.js'

export function createLocalMediaIndex(options = {}) {
  const maxRecords = normalizeBudgetLimit(options.maxRecords, 10_000)
  const maxRecordsPerIndex = normalizeBudgetLimit(options.maxRecordsPerIndex, maxRecords)
  const maxRecordsPerPublisher = normalizeBudgetLimit(options.maxRecordsPerPublisher, maxRecords)
  const maxRecordsPerAgent = normalizeBudgetLimit(options.maxRecordsPerAgent, maxRecords)
  const maxRecordsPerCollection = normalizeBudgetLimit(options.maxRecordsPerCollection, Math.min(maxRecords, 1000))
  const maxRecordsPerEntity = normalizeBudgetLimit(options.maxRecordsPerEntity, 128)
  const maxRecordsPerIndexPerWindow = normalizeBudgetLimit(options.maxRecordsPerIndexPerWindow, 2048)
  const maxRecordsPerPublisherPerWindow = normalizeBudgetLimit(options.maxRecordsPerPublisherPerWindow, 512)
  const maxRecordsPerAgentPerWindow = normalizeBudgetLimit(options.maxRecordsPerAgentPerWindow, 512)
  const maxRecordsPerCollectionPerWindow = normalizeBudgetLimit(options.maxRecordsPerCollectionPerWindow, 512)
  const maxMetadataChangesPerEntityPerWindow = normalizeBudgetLimit(options.maxMetadataChangesPerEntityPerWindow, 16)
  const maxMetadataBytes = normalizeBudgetLimit(options.maxMetadataBytes, 8192)
  const maxPublicationsPerEntity = normalizeBudgetLimit(options.maxPublicationsPerEntity, 64)
  const maxTagsPerEntity = normalizeBudgetLimit(options.maxTagsPerEntity, 64)
  const maxProvenancePerEntity = normalizeBudgetLimit(options.maxProvenancePerEntity, 64)
  const acceptRecord = typeof options.acceptRecord === 'function' ? options.acceptRecord : () => true
  const budget = createWindowedIngestBudget({
    now: options.now,
    windowMs: options.budgetWindowMs,
    maxTrackedKeys: options.maxBudgetKeys,
  })
  const records = new Map()
  const counts = {
    index: new Map(),
    publisher: new Map(),
    agent: new Map(),
    collection: new Map(),
    entity: new Map(),
  }

  function dimensionKeys(record) {
    return {
      index: record.indexId || record.sourceId || 'local',
      publisher: record.publisherId || null,
      agent: record.agentId || record.creator || null,
      collection: record.collectionId || null,
      entity: record.entityRef,
    }
  }

  function logicalKey(record, dimensions) {
    return `${dimensions.index}\0${record.publisherId || ''}\0${record.publicationId}`
  }

  function adjustCounts(record, delta) {
    if (!record) return
    const dimensions = dimensionKeys(record)
    for (const [scope, key] of Object.entries(dimensions)) {
      if (key == null) continue
      const map = counts[scope]
      const next = (map.get(key) || 0) + delta
      if (next > 0) map.set(key, next)
      else map.delete(key)
    }
  }

  function projectedCount(scope, key, previous, evicted) {
    if (key == null) return 0
    let count = counts[scope].get(key) || 0
    if (previous && dimensionKeys(previous)[scope] === key) count--
    if (evicted && dimensionKeys(evicted)[scope] === key) count--
    return count + 1
  }

  function projectionLimitError(dimensions, previous, evicted) {
    const limits = [
      ['index', dimensions.index, maxRecordsPerIndex, 'INDEX_PROJECTION_BUDGET_EXCEEDED'],
      ['publisher', dimensions.publisher, maxRecordsPerPublisher, 'PUBLISHER_PROJECTION_BUDGET_EXCEEDED'],
      ['agent', dimensions.agent, maxRecordsPerAgent, 'AGENT_PROJECTION_BUDGET_EXCEEDED'],
      ['collection', dimensions.collection, maxRecordsPerCollection, 'COLLECTION_PROJECTION_BUDGET_EXCEEDED'],
      ['entity', dimensions.entity, maxRecordsPerEntity, 'ENTITY_PROJECTION_BUDGET_EXCEEDED'],
    ]
    for (const [scope, key, limit, errorCode] of limits) {
      if (projectedCount(scope, key, previous, evicted) > limit) return errorCode
    }
    return null
  }

  function metadataFingerprint(record) {
    return JSON.stringify([
      record.entityRef,
      record.title || null,
      record.creator || null,
      record.collectionId || null,
      Array.isArray(record.tags) ? record.tags : [],
      record.playable === true,
    ])
  }

  function metadataByteLength(record) {
    return b4a.byteLength(JSON.stringify([
      record.title || null,
      record.creator || null,
      record.collectionId || null,
      Array.isArray(record.tags) ? record.tags : [],
      record.artwork || null,
    ]))
  }

  function reserveWindow(dimensions, isMetadataChange) {
    const requirements = []
    if (isMetadataChange) {
      requirements.push({
        scope: 'metadata',
        key: dimensions.entity,
        limit: maxMetadataChangesPerEntityPerWindow,
        errorCode: 'METADATA_WINDOW_BUDGET_EXCEEDED',
      })
    }
    requirements.push(
      {
        scope: 'index',
        key: dimensions.index,
        limit: maxRecordsPerIndexPerWindow,
        errorCode: 'INDEX_WINDOW_BUDGET_EXCEEDED',
      },
      {
        scope: 'publisher',
        key: dimensions.publisher,
        limit: maxRecordsPerPublisherPerWindow,
        errorCode: 'PUBLISHER_WINDOW_BUDGET_EXCEEDED',
      },
      {
        scope: 'agent',
        key: dimensions.agent,
        limit: maxRecordsPerAgentPerWindow,
        errorCode: 'AGENT_WINDOW_BUDGET_EXCEEDED',
      },
      {
        scope: 'collection',
        key: dimensions.collection,
        limit: maxRecordsPerCollectionPerWindow,
        errorCode: 'COLLECTION_WINDOW_BUDGET_EXCEEDED',
      },
    )
    return budget.reserve(requirements)
  }

  function normalizeRecord(record) {
    return {
      kind: record.kind || null,
      entityRef: record.entityRef,
      publicationId: record.publicationId,
      publisherId: record.publisherId || null,
      catalogBlockHint: Number.isSafeInteger(record.catalogBlockHint) ? record.catalogBlockHint : null,
      rootTransitionProofDigest: record.rootTransitionProofDigest || null,
      title: record.title || null,
      creator: record.creator || null,
      collectionId: record.collectionId || null,
      tags: Array.isArray(record.tags) ? record.tags.slice(0, maxTagsPerEntity) : [],
      ranking: Number.isFinite(record.ranking) ? record.ranking : null,
      model: typeof record.model === 'string' ? record.model : null,
      sourceId: record.sourceId || null,
      indexId: record.indexId || null,
      agentId: record.agentId || null,
      playable: record.playable === true,
    }
  }

  function boundedString(value, max, required = false) {
    if (value == null && !required) return true
    return typeof value === 'string' && (!required || value.length > 0) && b4a.byteLength(value) <= max
  }

  function validRecordInput(record) {
    if (!record || !boundedString(record.entityRef, 512, true) || !boundedString(record.publicationId, 512, true)) return false
    for (const [value, max] of [
      [record.kind, 128],
      [record.publisherId, 128],
      [record.rootTransitionProofDigest, 128],
      [record.title, 512],
      [record.creator, 512],
      [record.collectionId, 512],
      [record.sourceId, 1024],
      [record.indexId, 512],
      [record.agentId, 512],
      [record.model, 512],
    ]) {
      if (!boundedString(value, max)) return false
    }
    if (record.tags != null && (!Array.isArray(record.tags) || record.tags.length > 64)) return false
    for (const tag of record.tags || []) {
      if (!boundedString(tag, 128, true)) return false
    }
    if (record.ranking != null && !Number.isFinite(record.ranking)) return false
    return true
  }

  function project(recordGroup) {
    const first = recordGroup[0]
    const publications = new Map()
    const provenance = new Set()
    const tags = new Set()
    for (const record of recordGroup) {
      if (record.sourceId && provenance.size < maxProvenancePerEntity) provenance.add(record.sourceId)
      for (const tag of record.tags || []) {
        if (tags.size >= maxTagsPerEntity) break
        tags.add(tag)
      }
      const publicationKey = `${record.publisherId || ''}\0${record.publicationId}`
      if (!publications.has(publicationKey) && publications.size < maxPublicationsPerEntity) {
        publications.set(publicationKey, {
          publicationId: record.publicationId,
          publisherId: record.publisherId,
          title: record.title || null,
          playable: record.playable === true,
        })
      }
    }
    const projectedPublications = Array.from(publications.values())
    return {
      entityRef: first.entityRef,
      title: first.title || projectedPublications.find(publication => publication.title)?.title || null,
      creator: first.creator || null,
      collectionId: first.collectionId || null,
      tags: Array.from(tags).sort(),
      publications: projectedPublications,
      provenance: Array.from(provenance).sort(),
      playable: projectedPublications.some(publication => publication.playable),
    }
  }

  return {
    ingestRecords(nextRecords = []) {
      let accepted = 0
      let duplicates = 0
      let rejected = 0
      let firstErrorCode = null
      const results = []

      for (const input of nextRecords || []) {
        if (!validRecordInput(input)) {
          rejected++
          firstErrorCode ||= 'INVALID_INDEX_RECORD'
          results.push({ status: 'rejected', errorCode: 'INVALID_INDEX_RECORD' })
          continue
        }
        const record = normalizeRecord(input)
        const dimensions = dimensionKeys(record)
        const key = logicalKey(record, dimensions)
        const previous = records.get(key) || null
        const fingerprint = metadataFingerprint(record)
        if (previous && metadataFingerprint(previous) === fingerprint) {
          duplicates++
          results.push({ status: 'duplicate', errorCode: 'DUPLICATE_INDEX_RECORD' })
          continue
        }
        if (previous && previous.entityRef !== record.entityRef) {
          rejected++
          firstErrorCode ||= 'INDEX_RECORD_FORK'
          results.push({ status: 'rejected', errorCode: 'INDEX_RECORD_FORK' })
          continue
        }
        if (metadataByteLength(record) > maxMetadataBytes) {
          rejected++
          firstErrorCode ||= 'METADATA_TOO_LARGE'
          results.push({ status: 'rejected', errorCode: 'METADATA_TOO_LARGE' })
          continue
        }
        if (!acceptRecord(record, { previous })) {
          rejected++
          firstErrorCode ||= 'LOCAL_POLICY_REJECTED'
          results.push({ status: 'rejected', errorCode: 'LOCAL_POLICY_REJECTED' })
          continue
        }

        const evictedKey = !previous && records.size >= maxRecords ? records.keys().next().value : null
        const evicted = evictedKey == null ? null : records.get(evictedKey)
        const projectionError = projectionLimitError(dimensions, previous, evicted)
        if (projectionError) {
          rejected++
          firstErrorCode ||= projectionError
          results.push({ status: 'rejected', errorCode: projectionError })
          continue
        }
        const reservation = reserveWindow(dimensions, Boolean(previous))
        if (!reservation.accepted) {
          rejected++
          firstErrorCode ||= reservation.errorCode
          results.push({ status: 'rejected', errorCode: reservation.errorCode, resetAt: reservation.resetAt })
          continue
        }

        if (previous) adjustCounts(previous, -1)
        if (evicted) {
          records.delete(evictedKey)
          adjustCounts(evicted, -1)
        }
        records.set(key, record)
        adjustCounts(record, 1)
        accepted++
        results.push({ status: 'accepted' })
      }

      let status = 'rejected'
      if (accepted > 0 && rejected > 0) status = 'partial'
      else if (accepted > 0) status = 'accepted'
      else if (duplicates > 0 && rejected === 0) status = 'duplicate'
      return { status, errorCode: firstErrorCode, accepted, duplicates, rejected, results }
    },
    search(query = '') {
      const q = String(query).toLowerCase()
      const byEntity = new Map()
      for (const record of records.values()) {
        const haystack = `${record.entityRef} ${record.title || ''} ${record.creator || ''} ${(record.tags || []).join(' ')}`.toLowerCase()
        if (q && !haystack.includes(q)) continue
        const list = byEntity.get(record.entityRef) || []
        list.push(record)
        byEntity.set(record.entityRef, list)
      }
      return Array.from(byEntity.values()).map(project)
    },
    records() {
      return Array.from(records.values())
    },
  }
}
