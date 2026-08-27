import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { decodePublicationManifest } from '../assets/index.js'
import { PUBLISHER_LIMITS, PUBLISHER_RECORD_TYPES, decodePublisherCatalogFrame, decodePublisherOperationBody } from '../publisher/index.js'
import { createCatalogIngestor } from './catalog-ingestor.js'
import { mapIndexQueryResult } from './query-dispatcher.js'
import {
  MAX_INDEX_QUERY_CURSOR_BYTES,
  MAX_INDEX_QUERY_DEADLINE_MS,
  MAX_INDEX_QUERY_RESULTS,
  normalizeIndexQuerySelectors,
} from './query-codec.js'
import { createIndexerStore } from './store.js'

const VERIFIED_QUERY_CORE_NAME = 'peartube-local-catalog-index-v3'
const CURSOR_BYTES = 32
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{43}$/
const HEX_32 = /^[0-9a-f]{64}$/

const AGGREGATE_LIMIT = Object.freeze({
  maxRetainedBytes: Number.MAX_SAFE_INTEGER - 1,
  maxRows: Number.MAX_SAFE_INTEGER - 1,
})
const PUBLISHER_LIMIT = Object.freeze({
  maxRetainedBytes: PUBLISHER_LIMITS.maxSnapshotBytes,
  maxRows: PUBLISHER_LIMITS.maxJournalOperations,
})
const VERIFIED_QUERY_LIMITS = Object.freeze({
  global: AGGREGATE_LIMIT,
  shard: AGGREGATE_LIMIT,
  publisher: PUBLISHER_LIMIT,
  trustClasses: Object.freeze({ untrusted: PUBLISHER_LIMIT }),
})

function fail(message, code = 'VERIFIED_QUERY_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

function publisherId(value, name = 'publisherId') {
  const text = b4a.isBuffer(value) || value instanceof Uint8Array
    ? b4a.toString(b4a.from(value), 'hex')
    : value
  if (typeof text !== 'string' || !HEX_32.test(text)) throw new TypeError(`${name} must be a lowercase 32-byte hexadecimal identifier`)
  return text
}

function boundedText(value, name, maximum = MAX_INDEX_QUERY_CURSOR_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || b4a.byteLength(value) > maximum) {
    throw new TypeError(`${name} must be bounded text`)
  }
  return value
}

function cursorToken(bytes) {
  return b4a.toString(bytes, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function isVisibleDecision(decision) {
  if (decision === undefined || decision === null || decision === true) return true
  if (decision === false) return false
  return decision.action === 'visible' || decision.action === 'allow'
}

function findManifestRendition(manifest, renditionId) {
  return manifest?.body?.renditions?.find(candidate => candidate?.renditionId === renditionId) || null
}

export async function createVerifiedQueryView({
  store,
  catalogRegistry,
  moderationPolicy = null,
  onError = null,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  maxCursors = MAX_INDEX_QUERY_RESULTS,
  cursorLifetimeMs = MAX_INDEX_QUERY_DEADLINE_MS,
} = {}) {
  if (!store || typeof store.get !== 'function') throw new TypeError('verified query view requires Corestore')
  if (!catalogRegistry || typeof catalogRegistry.listBindings !== 'function') {
    throw new TypeError('verified query view requires catalogRegistry.listBindings')
  }
  if (moderationPolicy !== null && typeof moderationPolicy !== 'object' && typeof moderationPolicy !== 'function') {
    throw new TypeError('verified query view moderationPolicy must be an object or function')
  }
  if (onError !== null && typeof onError !== 'function') throw new TypeError('verified query view onError must be a function')
  if (typeof now !== 'function' || typeof randomBytes !== 'function') throw new TypeError('verified query view adapters are invalid')
  if (!Number.isSafeInteger(maxCursors) || maxCursors < 1 || maxCursors > MAX_INDEX_QUERY_RESULTS) {
    throw new TypeError('verified query cursor limit is invalid')
  }
  if (!Number.isSafeInteger(cursorLifetimeMs) || cursorLifetimeMs < 1 || cursorLifetimeMs > MAX_INDEX_QUERY_DEADLINE_MS) {
    throw new TypeError('verified query cursor lifetime is invalid')
  }

  const index = await createIndexerStore({
    store,
    limits: VERIFIED_QUERY_LIMITS,
    name: VERIFIED_QUERY_CORE_NAME,
  })
  const ingestor = createCatalogIngestor({ index, now })
  const cursors = new Map()
  let closed = false
  let refreshing = Promise.resolve({ indexed: 0, failed: 0 })

  function assertOpen() {
    if (closed) fail('verified query view is closed', 'VERIFIED_QUERY_CLOSED')
  }

  function currentTime() {
    const value = Number(now())
    if (!Number.isSafeInteger(value) || value < 0) fail('verified query clock is invalid')
    return value
  }

  function pruneCursors(time = currentTime()) {
    for (const [token, record] of cursors) if (record.expiresAt <= time) cursors.delete(token)
  }

  async function moderationRevision(moderation) {
    const source = moderationPolicy?.revision
    const value = typeof source === 'function'
      ? await source.call(moderationPolicy, { moderation })
      : source ?? '0'
    const revision = String(value)
    boundedText(revision, 'moderation revision')
    return revision
  }

  async function visible(record, moderation = 'effective') {
    boundedText(moderation, 'moderation mode', 64)
    const hook = typeof moderationPolicy === 'function'
      ? moderationPolicy
      : moderationPolicy?.isVisible || moderationPolicy?.evaluate
    if (typeof hook !== 'function') return true
    return isVisibleDecision(await hook.call(moderationPolicy, record, { moderation }))
  }

  function queryFingerprint(selectors, moderation) {
    return b4a.toString(crypto.hash(b4a.from(JSON.stringify({ selectors, moderation }))), 'hex')
  }

  function issueCursor(fingerprint, sourceRevision, moderationRevisionValue, continuation) {
    let serialized
    try { serialized = JSON.stringify(continuation) } catch { /* The bounded error below rejects it. */ }
    if (!serialized || b4a.byteLength(serialized) > MAX_INDEX_QUERY_CURSOR_BYTES) {
      fail('verified query continuation exceeds its bound', 'VERIFIED_QUERY_OVERLOADED')
    }
    pruneCursors()
    if (cursors.size >= maxCursors) fail('verified query cursor capacity is exhausted', 'VERIFIED_QUERY_OVERLOADED')
    for (let attempt = 0; attempt < 4; attempt++) {
      const bytes = b4a.from(randomBytes(CURSOR_BYTES))
      if (bytes.byteLength !== CURSOR_BYTES) fail('verified query cursor entropy is invalid')
      const token = cursorToken(bytes)
      if (cursors.has(token)) continue
      cursors.set(token, {
        fingerprint,
        sourceRevision,
        moderationRevision: moderationRevisionValue,
        continuation: JSON.parse(serialized),
        expiresAt: currentTime() + cursorLifetimeMs,
      })
      return token
    }
    fail('verified query cursor allocation failed', 'VERIFIED_QUERY_OVERLOADED')
  }

  function resolveCursor(token, fingerprint, moderationRevisionValue) {
    if (token === null) return null
    pruneCursors()
    if (typeof token !== 'string' || !CURSOR_PATTERN.test(token)) fail('verified query cursor is invalid', 'INVALID_CURSOR')
    const record = cursors.get(token)
    if (!record || record.fingerprint !== fingerprint) fail('verified query cursor is invalid', 'INVALID_CURSOR')
    if (record.moderationRevision !== moderationRevisionValue) fail('verified query cursor is stale', 'STALE_CURSOR')
    return record
  }

  async function bindingsByPublisher(requested = null) {
    const bindings = await catalogRegistry.listBindings()
    if (!Array.isArray(bindings)) throw new TypeError('catalogRegistry.listBindings() must return an array')
    if (bindings.length > PUBLISHER_LIMITS.maxJournalOperations) fail('publisher binding list exceeds its bound')
    const normalized = []
    for (const binding of bindings) {
      let id
      try { id = publisherId(binding?.publisherId) } catch { continue }
      if (requested && !requested.has(id)) continue
      normalized.push({ binding, publisherId: id })
    }
    normalized.sort((left, right) => left.publisherId.localeCompare(right.publisherId))
    return normalized
  }

  async function ingestBinding(binding, id, signal, repairReason = null) {
    const descriptor = await binding?.catalog?.getNamespaceDescriptor?.() || binding?.namespaceDescriptor
    if (!descriptor || !binding?.catalog) throw new Error(`publisher ${id} has no verified catalog binding`)
    const input = { publisherId: id, descriptor, catalog: binding.catalog, ...(signal ? { signal } : {}) }
    return repairReason === null
      ? ingestor.ingest(input)
      : ingestor.repairPublisher({ ...input, reason: repairReason })
  }

  async function performRefresh({ publisherIds = undefined, signal = undefined } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('verified query refresh aborted')
    let requested = null
    if (publisherIds !== undefined) {
      if (!Array.isArray(publisherIds) || publisherIds.length > PUBLISHER_LIMITS.maxJournalOperations) {
        throw new TypeError('publisherIds must be a bounded array')
      }
      requested = new Set(publisherIds.map(value => publisherId(value)))
    }
    const bindings = await bindingsByPublisher(requested)
    let indexed = 0
    let failed = 0
    for (const item of bindings) {
      if (signal?.aborted) throw signal.reason || new Error('verified query refresh aborted')
      try {
        await ingestBinding(item.binding, item.publisherId, signal)
        indexed++
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error
        failed++
        try { onError?.(error, { publisherId: item.publisherId }) } catch { /* Error reporting must not stop other publishers. */ }
      }
    }
    return Object.freeze({ indexed, failed })
  }

  async function publicationRow(publicationIdValue, moderation = 'effective') {
    const id = publisherId(publicationIdValue, 'publicationId')
    const rows = await index.findPublicationRows({ publicationId: id })
    for (const row of rows) {
      const result = mapIndexQueryResult(row)
      if (await visible(result, moderation)) return Object.freeze(result)
    }
    return null
  }

  async function manifestForPublication(publication, moderation = 'effective') {
    if (!publication || !await visible(publication, moderation)) return null
    const source = await index.getSourceRecord({
      publisherId: publication.publisherId,
      sourceRecordRef: publication.sourceRecordRef,
    })
    if (!source || source.recordType !== PUBLISHER_RECORD_TYPES.PUBLICATION) return null
    const frame = decodePublisherCatalogFrame(source.canonicalEnvelope)
    const body = decodePublisherOperationBody(frame.recordType, frame.canonicalBody)
    const manifest = decodePublicationManifest(body.payload)
    if (manifest.publicationId !== publication.publicationId || manifest.body?.manifestId !== publication.manifestId) {
      fail('verified publication projection does not match its canonical manifest')
    }
    return manifest
  }

  const resource = {
    refresh(input = {}) {
      assertOpen()
      const next = refreshing.then(() => performRefresh(input), () => performRefresh(input))
      refreshing = next.catch(() => ({ indexed: 0, failed: 1 }))
      return next
    },
    async repairPublisher({ publisherId: publisherIdValue, reason, signal = undefined } = {}) {
      assertOpen()
      const id = publisherId(publisherIdValue)
      const bindings = await bindingsByPublisher(new Set([id]))
      if (bindings.length !== 1) fail(`publisher ${id} has no unique verified catalog binding`)
      return ingestBinding(bindings[0].binding, id, signal, reason)
    },
    async query({ selectors, limit = 20, cursor = null, sourceRevision: requestedSourceRevision = null, moderation = 'effective', signal = undefined } = {}) {
      assertOpen()
      const normalizedSelectors = normalizeIndexQuerySelectors(selectors)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INDEX_QUERY_RESULTS) {
        throw new TypeError('verified query limit is outside its bound')
      }
      boundedText(moderation, 'moderation mode', 64)
      const revision = await moderationRevision(moderation)
      const fingerprint = queryFingerprint(normalizedSelectors, moderation)
      const stored = resolveCursor(cursor, fingerprint, revision)
      if (stored && requestedSourceRevision !== null && requestedSourceRevision !== stored.sourceRevision) {
        fail('verified query cursor is stale', 'STALE_CURSOR')
      }
      let continuation = stored?.continuation
      let sourceRevision = stored?.sourceRevision ?? requestedSourceRevision ?? undefined
      const results = []
      while (results.length < limit) {
        let page
        try {
          page = await index.queryIndexPage({
            selectors: normalizedSelectors,
            limit: 1,
            continuation,
            sourceRevision,
            signal,
          })
        } catch (error) {
          if (error?.code === 'INDEX_QUERY_STALE_REVISION') fail('verified query cursor is stale', 'STALE_CURSOR')
          throw error
        }
        sourceRevision = page.sourceRevision
        continuation = page.continuation
        if (page.results.length === 1) {
          const result = mapIndexQueryResult(page.results[0])
          if (await visible(result, moderation)) results.push(Object.freeze(result))
        }
        if (continuation === null) break
      }
      return Object.freeze({
        results: Object.freeze(results),
        nextCursor: continuation === null ? null : issueCursor(fingerprint, sourceRevision, revision, continuation),
        sourceRevision,
      })
    },
    async getEntity({ entityKind, entityId, moderation = 'effective' } = {}) {
      assertOpen()
      const rows = await index.findEntityRows({ entityKind, entityId })
      const sources = []
      for (const row of rows) {
        const result = mapIndexQueryResult(row)
        if (await visible(result, moderation)) sources.push(Object.freeze(result))
      }
      return sources.length === 0
        ? null
        : Object.freeze({ entityKind, entityId, sources: Object.freeze(sources) })
    },
    async getPublication({ publicationId, moderation = 'effective' } = {}) {
      assertOpen()
      return publicationRow(publicationId, moderation)
    },
    async getManifest({ publicationId, moderation = 'effective' } = {}) {
      assertOpen()
      const publication = await publicationRow(publicationId, moderation)
      return manifestForPublication(publication, moderation)
    },
    async authorizeRendition({
      publicationId,
      renditionId,
      start = 0,
      end = null,
      operation = 'read',
    } = {}) {
      assertOpen()
      const publication = await publicationRow(publicationId)
      const manifest = await manifestForPublication(publication)
      if (!manifest) return false
      const rendition = findManifestRendition(manifest, renditionId)
      if (!rendition || rendition.blocked || rendition.superseded) return false
      const length = Number(rendition.core?.length)
      if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(start) || start < 0 || start >= length) return false
      if (end !== null && (!Number.isSafeInteger(end) || end <= start || end > length)) return false
      boundedText(operation, 'rendition operation', 64)
      const indexed = await index.findRenditionRows({ renditionId })
      if (!indexed.some(row =>
        row.publisherId === publication.publisherId &&
        row.sourceRecordRef === publication.sourceRecordRef &&
        row.assetId === rendition.core?.assetId
      )) return false
      const uploadRanges = (manifest.body?.provenance || []).filter(candidate =>
        candidate?.type === 'upload' &&
        candidate.renditionId === renditionId &&
        candidate.coreKey === rendition.core?.key &&
        Number.isSafeInteger(candidate.start) &&
        Number.isSafeInteger(candidate.end) &&
        candidate.start >= 0 &&
        candidate.end > candidate.start
      )
      if (uploadRanges.length > 0 && !uploadRanges.some(candidate =>
        start >= candidate.start && end !== null && end <= candidate.end
      )) return false
      const record = {
        publisherId: publication.publisherId,
        publicationId,
        renditionId,
        assetId: rendition.core?.assetId,
        operation,
        start,
        end,
      }
      if (!await visible(record)) return false
      const authorize = moderationPolicy?.authorizeRendition
      return typeof authorize !== 'function' || isVisibleDecision(await authorize.call(moderationPolicy, record))
    },
    async isVisible(input = {}) {
      assertOpen()
      return visible(input)
    },
    sourceState({ publisherId: publisherIdValue } = {}) {
      assertOpen()
      return index.getPublisherSourceCursor({ publisherId: publisherId(publisherIdValue) })
    },
    evictPublisher({ publisherId: publisherIdValue, reason } = {}) {
      assertOpen()
      return index.evictPublisherSlice({ publisherId: publisherId(publisherIdValue), reason })
    },
    async close() {
      if (closed) return false
      closed = true
      await refreshing.catch(() => {})
      cursors.clear()
      await index.close()
      return true
    },
  }
  return Object.freeze(resource)
}
