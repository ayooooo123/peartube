/**
 * PublicChannelBee - legacy local channel projection
 *
 * This typed HyperDB projection remains readable for local migration and
 * compatibility paths. It does not own discovery or replication; network
 * access is authorized by the scoped publisher and asset runtime.
 */

import HyperDB from 'hyperdb'
import b4a from 'b4a'
import ReadyResource from 'ready-resource'

import publicDbDefinition from './public-hyperdb-spec/hyperdb/index.js'
import { resolveClaimWinner } from './structured-content.js'
import {
  compareSignedChannelRootDescriptors,
  verifySignedChannelRootDescriptor
} from '../channel-descriptor.js'

const PUBLIC_METADATA_INTERNAL_FIELDS = new Set(['key'])
const PUBLIC_METADATA_FIELDS = [
  'name',
  'description',
  'avatar',
  'publicBeeKey',
  'commentsDbKey',
  'createdAt',
  'createdBy',
  'updatedAt'
]
const PUBLIC_VIDEO_FIELDS = [
  'title',
  'description',
  'path',
  'duration',
  'thumbnail',
  'thumbnailBlobId',
  'thumbnailBlobsCoreKey',
  'thumbnailMimeType',
  'blobId',
  'blobsCoreKey',
  'blobDriveKey',
  'mimeType',
  'size',
  'category',
  'views',
  'uploadedAt',
  'uploadedBy',
  'updatedAt',
  'updatedBy'
]
const CHANNEL_PROFILE_FIELDS = [
  'id',
  'profileKind',
  'mediaProvider',
  'mediaId',
  'originalLanguage',
  'releaseDate',
  'releaseYear',
  'canonicalRevision'
]
const CHANNEL_SOURCE_FIELDS = [
  'provider',
  'identityKey',
  'sourceId',
  'identityUrl',
  'handle',
  'displayName',
  'createdAt',
  'updatedAt'
]
const CHANNEL_ARTWORK_FIELDS = [
  'role',
  'blobId',
  'blobsCoreKey',
  'mimeType',
  'remoteUrl',
  'updatedAt'
]
const CONTENT_DETAIL_FIELDS = [
  'id',
  'contentKind',
  'sourceProvider',
  'sourceVideoId',
  'identityUrl',
  'sourceCreatorId',
  'sourceCreatorUrl',
  'sourcePublishedAt',
  'mediaProvider',
  'mediaId',
  'seasonNumber',
  'episodeNumber',
  'originalAirDate',
  'thumbnailUrl',
  'artwork',
  'provenanceVersion',
  'publicationState',
  'contentFingerprint',
  'importIdentityKey',
  'importClaimantId',
  'canonicalVisibility',
  'duplicateOfClaimantId'
]
const CHANNEL_PROFILE_STORAGE_DEFAULTS = {
  releaseDate: Number.MAX_SAFE_INTEGER,
  releaseYear: Number.MAX_SAFE_INTEGER
}
const CHANNEL_SOURCE_STORAGE_DEFAULTS = {
  createdAt: Number.MAX_SAFE_INTEGER,
  updatedAt: Number.MAX_SAFE_INTEGER
}
const CHANNEL_ARTWORK_STORAGE_DEFAULTS = {
  updatedAt: Number.MAX_SAFE_INTEGER
}
const CONTENT_STORAGE_DEFAULTS = {
  contentKind: '',
  sourceProvider: '',
  sourceVideoId: '',
  sourcePublishedAt: Number.MAX_SAFE_INTEGER,
  seasonNumber: Number.MAX_SAFE_INTEGER,
  episodeNumber: Number.MAX_SAFE_INTEGER,
  originalAirDate: Number.MAX_SAFE_INTEGER
}
const ROOT_DESCRIPTOR_KEY = b4a.from('channel/root')
const PROJECTION_FORMAT_KEY = b4a.from('channel/projection-format')
const CANONICAL_RECONCILIATION_REVISION_KEY = b4a.from('channel/canonical-reconciliation-revision')
const PROJECTION_FORMATS = new Set(['legacy', 'modern'])
function projectionClaimKey(videoId) {
  return b4a.from(`channel/projection-claim/${b4a.toString(b4a.from(videoId), 'hex')}`)
}

const DEFAULT_LIST_VIDEOS_SYNC_TIMEOUT_MS = 1500
const DEFAULT_LIST_VIDEOS_STREAM_TIMEOUT_MS = 1200
const DEFAULT_CATALOG_READ_TIMEOUT_MS = 1200
const MAX_CATALOG_READ_TIMEOUT_MS = 5000
const MAX_CATALOG_CHANNEL_SOURCES = 64
const MAX_CATALOG_CHANNEL_ARTWORK = 16

function normalizeTimeoutMs(value, fallback) {
  const timeout = Number(value)
  return Number.isFinite(timeout) && timeout >= 0 ? timeout : fallback
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
        timeout.unref?.()
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function normalizeCatalogReadOptions(options = {}, maxItems = null) {
  const requestedTimeout = Number(options?.timeoutMs)
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, MAX_CATALOG_READ_TIMEOUT_MS)
    : DEFAULT_CATALOG_READ_TIMEOUT_MS
  if (maxItems === null) return { timeoutMs }

  const requestedLimit = options?.limit
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, maxItems)
    : maxItems
  return { timeoutMs, limit }
}

function pickDefinedFields(value, fields) {
  const out = {}
  if (!value || typeof value !== 'object') return out
  for (const field of fields) {
    if (value[field] !== undefined) out[field] = value[field]
  }
  return out
}

function encodeStoredRecord(record, defaults = {}) {
  return { ...defaults, ...record }
}

function decodeStoredRecord(record, fields, defaults = {}) {
  if (!record) return null
  const decoded = pickDefinedFields(record, fields)
  for (const field of fields) {
    if (decoded[field] === null) delete decoded[field]
  }
  for (const [field, sentinel] of Object.entries(defaults)) {
    if (decoded[field] === sentinel) delete decoded[field]
  }
  return decoded
}

function mergeRevisionedRecord(existing, incoming, fields) {
  const current = pickDefinedFields(existing, fields)
  const candidate = pickDefinedFields(incoming, fields)
  const currentUpdatedAt = Number.isFinite(current.updatedAt) ? current.updatedAt : -1
  const candidateUpdatedAt = Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : -1
  const candidateIsNewer = candidateUpdatedAt > currentUpdatedAt
  const currentIsNewer = currentUpdatedAt > candidateUpdatedAt
  const merged = {}
  for (const field of fields) {
    const currentValue = current[field]
    const candidateValue = candidate[field]
    if (currentValue === undefined) {
      if (candidateValue !== undefined) merged[field] = candidateValue
      continue
    }
    if (candidateValue === undefined) {
      merged[field] = currentValue
      continue
    }
    if (candidateIsNewer) {
      merged[field] = candidateValue
    } else if (currentIsNewer) {
      merged[field] = currentValue
    } else {
      const currentOrder = JSON.stringify(currentValue)
      const candidateOrder = JSON.stringify(candidateValue)
      merged[field] = candidateOrder > currentOrder ? candidateValue : currentValue
    }
  }
  return merged
}

function splitPublicVideo(video) {
  if (!video || typeof video !== 'object' || !video.id) {
    return { video: null, details: null }
  }
  const compact = { id: video.id, ...pickDefinedFields(video, PUBLIC_VIDEO_FIELDS) }
  const details = pickDefinedFields(video, CONTENT_DETAIL_FIELDS)
  details.id = video.id
  return {
    video: compact,
    details: Object.keys(details).length > 1 ? details : null
  }
}

function groupClaimsByIdentity(claims) {
  const grouped = new Map()
  for (const claim of claims || []) {
    if (!claim || typeof claim.identityKey !== 'string' || !claim.identityKey) continue
    const entries = grouped.get(claim.identityKey) || []
    entries.push(claim)
    grouped.set(claim.identityKey, entries)
  }
  return grouped
}

export function isPubliclyProjectable(video, claimWinner = null) {
  const durable = !video?.publicationState ||
    video.publicationState === 'durabilityVerified' ||
    video.publicationState === 'published'
  const winsClaim = !video?.importIdentityKey || (
    claimWinner?.identityKey === video.importIdentityKey &&
    claimWinner.claimantId === video.importClaimantId &&
    claimWinner.videoId === video.id
  )
  return durable && winsClaim
}

export class PublicChannelBee extends ReadyResource {
  /**
   * @param {import('corestore')} store
   * @param {Object} opts
   * @param {Buffer|string} [opts.key] - Hypercore key (for loading existing)
   * @param {string} [opts.name] - Core name (for creating new)
   */
  constructor(store, opts = {}) {
    super()
    this.store = store
    this.opts = opts
    this.db = null
    // Kept for legacy tests/callers that verify the raw Hyperbee path is gone.
    this.bee = null
    this.core = null
    this._explicitlyDeletedVideoIds = new Set()
    this._onCanonicalClaimsSynchronized = null

    this.ready().catch(() => {})
  }

  _enqueueSerialized(field, task) {
    const previous = this[field] || Promise.resolve()
    const operation = previous.then(task, task)
    this[field] = operation.catch(() => {})
    return operation
  }

  _enqueueKeyed(field, key, task) {
    if (!this[field]) this[field] = new Map()
    const operations = this[field]
    const previous = operations.get(key) || Promise.resolve()
    const operation = previous.then(task, task)
    const tail = operation.catch(() => {})
    operations.set(key, tail)
    tail.finally(() => {
      if (operations.get(key) === tail) operations.delete(key)
    })
    return operation
  }

  async _open() {
    if (this.opts.key) {
      const keyBuf = typeof this.opts.key === 'string'
        ? b4a.from(this.opts.key, 'hex')
        : this.opts.key
      this.core = this.store.get({ key: keyBuf })
    } else if (this.opts.name) {
      this.core = this.store.get({ name: this.opts.name })
    } else {
      throw new Error('PublicChannelBee requires either key or name')
    }

    await this.core.ready()
    this.db = HyperDB.bee(this.core, publicDbDefinition, {
      autoUpdate: true,
      writable: this.core.writable !== false,
      extension: false
    })
    await this.db.ready()

    console.log('[PublicBee] Ready:', this.keyHex?.slice(0, 16), 'writable:', this.writable, 'length:', this.core.length)
  }

  async _close() {
    this._onCanonicalClaimsSynchronized = null
    if (this.db) await this.db.close()
  }

  setOnCanonicalClaimsSynchronized(callback) {
    this._onCanonicalClaimsSynchronized = typeof callback === 'function' ? callback : null
  }

  get key() {
    return this.core?.key || null
  }

  get keyHex() {
    return this.key ? b4a.toString(this.key, 'hex') : null
  }

  get discoveryKey() {
    return this.core?.discoveryKey || null
  }

  get writable() {
    return this.core?.writable || false
  }

  async waitForSync(timeoutMs = 1500) {
    if (!this.core || this.writable) return
    try {
      await this.core.update({ wait: true, timeout: timeoutMs })
    } catch {
      // Non-fatal: use the local materialized view.
    }
  }

  _sanitizePublicMetadata(meta) {
    if (!meta || typeof meta !== 'object') return null
    const out = { ...meta }
    delete out.commentsAdminKey
    delete out.commentsAutobaseKey
    for (const key of Object.keys(out)) {
      if (PUBLIC_METADATA_INTERNAL_FIELDS.has(key)) delete out[key]
    }
    return out
  }

  _sanitizePublicVideo(video) {
    if (!video || typeof video !== 'object') return null
    const out = { ...video }
    delete out.commentsAdminKey
    return out
  }

  _openCatalogReadSnapshot() {
    if (!this.db || typeof this.db.snapshot !== 'function') {
      throw new Error('PublicBee bounded catalog snapshot is unavailable')
    }
    this.db.update?.()
    const snapshot = this.db.snapshot()
    if (!snapshot || typeof snapshot.close !== 'function') {
      throw new Error('PublicBee bounded catalog snapshot is unavailable')
    }
    return snapshot
  }

  async _withBoundedCatalogSnapshot(operation, { timeoutMs, label, onFailure = null }) {
    const snapshot = this._openCatalogReadSnapshot()
    try {
      const read = Promise.resolve().then(async () => {
        await snapshot.ready?.()
        return operation(snapshot)
      })
      return await withTimeout(read, timeoutMs, `${label} timed out after ${timeoutMs}ms`)
    } catch (error) {
      onFailure?.(error)
      throw error
    } finally {
      await snapshot.close()
    }
  }

  async _getBoundedCatalogRecord(collection, key, options, label) {
    const { timeoutMs } = normalizeCatalogReadOptions(options)
    return this._withBoundedCatalogSnapshot(
      (snapshot) => snapshot.get(collection, key),
      { timeoutMs, label },
    )
  }

  async _listBoundedCatalogRecords(collection, fields, defaults, options, maxItems, label) {
    const { timeoutMs, limit } = normalizeCatalogReadOptions(options, maxItems)
    let stream = null
    let streamDestroyed = false
    const destroyStreamOnce = (error) => {
      if (streamDestroyed || !stream || typeof stream.destroy !== 'function') return
      streamDestroyed = true
      try {
        stream.destroy(error)
      } catch {
        // The request-owned snapshot close below is the final cancellation boundary.
      }
    }

    return this._withBoundedCatalogSnapshot(async (snapshot) => {
      stream = snapshot.find(collection, {})
      const records = []
      for await (const entry of stream) {
        records.push(entry?.value ?? entry)
        if (records.length > limit) {
          const error = new Error(`${label} exceeds limit ${limit}`)
          destroyStreamOnce(error)
          throw error
        }
      }
      return records.map((record) => decodeStoredRecord(record, fields, defaults))
    }, {
      timeoutMs,
      label,
      onFailure: destroyStreamOnce,
    })
  }

  async getMetadata(options = {}) {
    if (options?.bounded === true) {
      const { timeoutMs } = normalizeCatalogReadOptions(options)
      const deadline = Date.now() + timeoutMs
      await this.waitForSync(Math.min(timeoutMs, DEFAULT_LIST_VIDEOS_SYNC_TIMEOUT_MS))
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        throw new Error(`PublicBee catalog metadata timed out after ${timeoutMs}ms`)
      }
      const meta = await this._getBoundedCatalogRecord(
        '@peartubePublic/metadata',
        { key: 'meta' },
        { ...options, timeoutMs: remainingMs },
        'PublicBee catalog metadata',
      )
      return this._sanitizePublicMetadata(meta || null)
    }

    await this.waitForSync(1500)
    if (!this.db) return null
    this.db.update?.()
    const meta = await this.db.get('@peartubePublic/metadata', { key: 'meta' })
    return this._sanitizePublicMetadata(meta || null)
  }

  _toStoredPublicMetadata(meta) {
    return {
      ...pickDefinedFields(this._sanitizePublicMetadata(meta), PUBLIC_METADATA_FIELDS),
      key: 'meta'
    }
  }

  async setMetadata(meta) {
    if (!this.writable) throw new Error('Not writable')
    if (!this.db) return
    const prev = this._sanitizePublicMetadata(await this.getMetadata()) || {}
    const patch = this._sanitizePublicMetadata(meta) || {}
    await this.db.insert('@peartubePublic/metadata', this._toStoredPublicMetadata({
      ...prev,
      ...patch,
      updatedAt: patch.updatedAt ?? Date.now()
    }))
    await this.db.flush()
    console.log('[PublicBee] Metadata updated')
  }

  async setRootDescriptor(signedDescriptor) {
    return this._enqueueSerialized(
      '_descriptorWriteTail',
      () => this._setRootDescriptorUnlocked(signedDescriptor)
    )
  }

  async _setRootDescriptorUnlocked(signedDescriptor) {
    if (!this.writable) throw new Error('Not writable')
    if (!this.db) throw new Error('Public HyperDB not ready')
    if (!signedDescriptor || typeof signedDescriptor !== 'object') {
      throw new Error('Signed channel root descriptor required')
    }
    const current = await this.getRootDescriptor()
    if (
      current &&
      compareSignedChannelRootDescriptors(signedDescriptor, current) <= 0
    ) {
      return current
    }
    await this.db.flush()
    await this.db.db.put(ROOT_DESCRIPTOR_KEY, b4a.from(JSON.stringify(signedDescriptor)))
    this.db.update?.()
    return signedDescriptor
  }

  async getRootDescriptor() {
    await this.waitForSync(1500)
    if (!this.db?.db) return null
    const node = await this.db.db.get(ROOT_DESCRIPTOR_KEY)
    if (!node?.value) return null
    try {
      return JSON.parse(b4a.toString(node.value))
    } catch {
      return null
    }
  }
  async getVerifiedRootDescriptor({ channelKey, publicBeeKey } = {}) {
    const signed = await this.getRootDescriptor()
    const verification = await verifySignedChannelRootDescriptor(signed)
    if (!verification?.valid) {
      throw new Error(`Public projection root descriptor is invalid: ${verification?.error || 'missing descriptor'}`)
    }
    const expectedChannelKey = typeof channelKey === 'string' ? channelKey.toLowerCase() : ''
    const expectedPublicBeeKey = typeof publicBeeKey === 'string' ? publicBeeKey.toLowerCase() : ''
    if (verification.descriptor?.channelId !== expectedChannelKey) {
      throw new Error('Public projection root descriptor channel binding mismatch')
    }
    if (verification.descriptor?.metadataKey !== expectedPublicBeeKey) {
      throw new Error('Public projection root descriptor metadata binding mismatch')
    }
    return { ...signed, descriptor: verification.descriptor }
  }


  async getProjectionFormat() {
    await this.waitForSync(1500)
    if (!this.db?.db || typeof this.db.db.get !== 'function') return null
    const node = await this.db.db.get(PROJECTION_FORMAT_KEY)
    if (!node?.value) return null
    const format = b4a.toString(node.value)
    return PROJECTION_FORMATS.has(format) ? format : null
  }

  async setProjectionFormat(format) {
    if (!PROJECTION_FORMATS.has(format)) {
      throw new Error(`Invalid public projection format: ${format}`)
    }
    return this._enqueueSerialized(
      '_projectionFormatWriteTail',
      () => this._setProjectionFormatUnlocked(format)
    )
  }

  async _setProjectionFormatUnlocked(format) {
    if (!this.writable) throw new Error('Not writable')
    if (!this.db?.db) throw new Error('Public HyperDB not ready')
    const current = await this.getProjectionFormat()
    if (current === format) return current
    if (current === 'modern' && format !== 'modern') {
      throw new Error('Cannot downgrade modern public projection format')
    }
    await this.db.db.put(PROJECTION_FORMAT_KEY, b4a.from(format))
    this.db.update?.()
    return format
  }

  async _writeProjectionClaimIndex(video) {
    if (!video?.id || !this.db?.db) return
    const key = projectionClaimKey(video.id)
    if (video.importIdentityKey && video.importClaimantId) {
      await this.db.db.put(key, b4a.from(JSON.stringify({
        importIdentityKey: video.importIdentityKey,
        importClaimantId: video.importClaimantId
      })))
    } else {
      await this.db.db.del(key)
    }
    this.db.update?.()
  }

  async _readProjectionClaimIndex(videoId) {
    if (!videoId || !this.db?.db) return null
    const node = await this.db.db.get(projectionClaimKey(videoId))
    if (!node?.value) return null
    try {
      const record = JSON.parse(b4a.toString(node.value))
      if (!record?.importIdentityKey || !record?.importClaimantId) return null
      return {
        importIdentityKey: record.importIdentityKey,
        importClaimantId: record.importClaimantId
      }
    } catch {
      throw new Error(`Invalid public projection claim index for ${videoId}`)
    }
  }

  async putChannelProfile(profile, options = {}) {
    if (!profile || typeof profile !== 'object') return
    return this._enqueueSerialized(
      '_profileWriteTail',
      () => this._putChannelProfileUnlocked(profile, options)
    )
  }

  async _contentDetailsRequired() {
    const format = await this.getProjectionFormat()
    if (format === 'modern') return true
    if (format === 'legacy') return false
    if (!this.db?.db || typeof this.db.db.get !== 'function') {
      throw new Error('Public projection format evidence is unavailable')
    }
    const [profile, root] = await Promise.all([
      this.getChannelProfile(),
      this.getRootDescriptor()
    ])
    if (!root) throw new Error('Public projection format evidence is unavailable')
    const verified = await verifySignedChannelRootDescriptor(root)
    if (!verified?.valid) throw new Error('Public projection root descriptor is invalid')
    const rootRevision = root.descriptor?.profile?.canonicalRevision
    if (!rootRevision) return false
    if (profile?.canonicalRevision !== rootRevision) {
      throw new Error('Public projection profile revision evidence is incomplete')
    }
    return true
  }

  async _putChannelProfileUnlocked(profile, { descriptor = null } = {}) {
    if (!this.writable) throw new Error('Not writable')
    const existing = await this.getChannelProfile()
    const patch = pickDefinedFields(profile, CHANNEL_PROFILE_FIELDS)
    if (patch.canonicalRevision !== undefined) {
      const root = descriptor || await this.getRootDescriptor()
      const rootRevision = root?.descriptor?.profile?.canonicalRevision
      const existingRevision = existing?.canonicalRevision
      if (
        (rootRevision && patch.canonicalRevision !== rootRevision) ||
        (!rootRevision && existingRevision && patch.canonicalRevision !== existingRevision)
      ) {
        delete patch.canonicalRevision
      }
    }
    const record = {
      ...(existing || {}),
      ...patch,
      id: 'profile'
    }
    await this.db.insert(
      '@peartubePublic/channelProfiles',
      encodeStoredRecord(record, CHANNEL_PROFILE_STORAGE_DEFAULTS)
    )
    await this.db.flush()
  }

  async getChannelProfile(options = {}) {
    if (options?.bounded === true) {
      const record = await this._getBoundedCatalogRecord(
        '@peartubePublic/channelProfiles',
        { id: 'profile' },
        options,
        'PublicBee catalog profile',
      )
      return decodeStoredRecord(record, CHANNEL_PROFILE_FIELDS, CHANNEL_PROFILE_STORAGE_DEFAULTS)
    }

    if (!this.db) return null
    this.db.update?.()
    const record = await this.db.get('@peartubePublic/channelProfiles', { id: 'profile' })
    return decodeStoredRecord(record, CHANNEL_PROFILE_FIELDS, CHANNEL_PROFILE_STORAGE_DEFAULTS)
  }

  async putChannelSource(source) {
    if (!source?.provider || !source?.identityKey) return
    const key = `${source.provider}\u0000${source.identityKey}`
    return this._enqueueKeyed(
      '_sourceWriteTails',
      key,
      () => this._putChannelSourceUnlocked(source)
    )
  }

  async _putChannelSourceUnlocked(source) {
    if (!this.writable) throw new Error('Not writable')
    const existing = await this.db.get('@peartubePublic/channelSources', {
      provider: source.provider,
      identityKey: source.identityKey
    })
    const record = mergeRevisionedRecord(
      decodeStoredRecord(existing, CHANNEL_SOURCE_FIELDS, CHANNEL_SOURCE_STORAGE_DEFAULTS),
      source,
      CHANNEL_SOURCE_FIELDS
    )
    await this.db.insert(
      '@peartubePublic/channelSources',
      encodeStoredRecord(record, CHANNEL_SOURCE_STORAGE_DEFAULTS)
    )
    await this.db.flush()
  }

  async listChannelSources(options = {}) {
    if (options?.bounded === true) {
      return this._listBoundedCatalogRecords(
        '@peartubePublic/channelSources',
        CHANNEL_SOURCE_FIELDS,
        CHANNEL_SOURCE_STORAGE_DEFAULTS,
        options,
        MAX_CATALOG_CHANNEL_SOURCES,
        'PublicBee catalog sources',
      )
    }

    if (!this.db) return []
    this.db.update?.()
    const records = await this.db.find('@peartubePublic/channelSources', {}).toArray()
    return records.map((record) =>
      decodeStoredRecord(record, CHANNEL_SOURCE_FIELDS, CHANNEL_SOURCE_STORAGE_DEFAULTS))
  }

  async putChannelArtwork(artwork) {
    if (!artwork?.role) return
    return this._enqueueKeyed(
      '_artworkWriteTails',
      artwork.role,
      () => this._putChannelArtworkUnlocked(artwork)
    )
  }

  async _putChannelArtworkUnlocked(artwork) {
    if (!this.writable) throw new Error('Not writable')
    const existing = await this.db.get('@peartubePublic/channelArtwork', { role: artwork.role })
    const record = mergeRevisionedRecord(
      decodeStoredRecord(existing, CHANNEL_ARTWORK_FIELDS, CHANNEL_ARTWORK_STORAGE_DEFAULTS),
      artwork,
      CHANNEL_ARTWORK_FIELDS
    )
    await this.db.insert(
      '@peartubePublic/channelArtwork',
      encodeStoredRecord(record, CHANNEL_ARTWORK_STORAGE_DEFAULTS)
    )
    await this.db.flush()
  }

  async listChannelArtwork(options = {}) {
    if (options?.bounded === true) {
      return this._listBoundedCatalogRecords(
        '@peartubePublic/channelArtwork',
        CHANNEL_ARTWORK_FIELDS,
        CHANNEL_ARTWORK_STORAGE_DEFAULTS,
        options,
        MAX_CATALOG_CHANNEL_ARTWORK,
        'PublicBee catalog artwork',
      )
    }

    if (!this.db) return []
    this.db.update?.()
    const records = await this.db.find('@peartubePublic/channelArtwork', {}).toArray()
    return records.map((record) =>
      decodeStoredRecord(record, CHANNEL_ARTWORK_FIELDS, CHANNEL_ARTWORK_STORAGE_DEFAULTS))
  }

  async putContentDetails(videoId, details, { merge = false } = {}) {
    if (!this.writable) throw new Error('Not writable')
    if (!videoId) throw new Error('Video id required')
    await this.setProjectionFormat('modern')
    if (details?.importIdentityKey && details?.importClaimantId) {
      await this._writeProjectionClaimIndex({ id: videoId, ...details })
    }
    let existing = null
    if (merge) {
      existing = decodeStoredRecord(
        await this.db.get('@peartubePublic/contentDetails', { id: videoId }),
        CONTENT_DETAIL_FIELDS,
        CONTENT_STORAGE_DEFAULTS
      )
    }
    const record = {
      ...(existing || {}),
      ...pickDefinedFields(details, CONTENT_DETAIL_FIELDS),
      id: videoId
    }
    await this.db.insert(
      '@peartubePublic/contentDetails',
      encodeStoredRecord(record, CONTENT_STORAGE_DEFAULTS)
    )
    await this.db.flush()
  }

  async getContentDetails(videoId) {
    if (!this.db || !videoId) return null
    this.db.update?.()
    const record = await this.db.get('@peartubePublic/contentDetails', { id: videoId })
    return decodeStoredRecord(record, CONTENT_DETAIL_FIELDS, CONTENT_STORAGE_DEFAULTS)
  }

  async listVideos(options = {}) {
    const syncTimeoutMs = normalizeTimeoutMs(options?.syncTimeoutMs, DEFAULT_LIST_VIDEOS_SYNC_TIMEOUT_MS)
    const streamTimeoutMs = normalizeTimeoutMs(options?.timeoutMs, DEFAULT_LIST_VIDEOS_STREAM_TIMEOUT_MS)
    const result = (videos, status = 'authoritative', filteredCount = 0) =>
      options?.returnStatus
        ? { status, videos, filteredCount }
        : videos
    await this.waitForSync(syncTimeoutMs)

    if (!this.db) {
      const collected = await this._collectVideoStream(undefined, streamTimeoutMs)
      if (options?.reconciliationStatus && typeof options.reconciliationStatus === 'object') {
        options.reconciliationStatus.scanComplete = collected.status === 'authoritative'
      }
      return result(collected.videos, collected.status)
    }
    this.db.update?.()
    const deadline = streamTimeoutMs > 0 ? Date.now() + streamTimeoutMs : null
    const stream = this.db.find('@peartubePublic/videos-by-uploaded-at', {}, { reverse: true })
    const collected = await this._collectVideoStream(stream, streamTimeoutMs)
    if (options?.reconciliationStatus && typeof options.reconciliationStatus === 'object') {
      options.reconciliationStatus.scanComplete = collected.status === 'authoritative'
    }
    const videos = collected.videos
    if (typeof this.db.get !== 'function') return result(videos, collected.status)

    const detailsById = new Map()
    const unavailableContentDetails = new Set()
    const missingContentDetails = new Set()
    const markUnavailable = (videoId) => {
      unavailableContentDetails.add(videoId)
      options?.unavailableContentDetails?.add?.(videoId)
    }
    for (let index = 0; index < videos.length; index++) {
      const video = videos[index]
      try {
        let sidecar
        if (deadline === null) {
          sidecar = await this.getContentDetails(video.id)
        } else {
          const remainingMs = deadline - Date.now()
          if (remainingMs <= 0) {
            for (let remaining = index; remaining < videos.length; remaining++) {
              markUnavailable(videos[remaining].id)
            }
            break
          }
          sidecar = await withTimeout(
            this.getContentDetails(video.id),
            remainingMs,
            `PublicBee content details timed out after ${streamTimeoutMs}ms`
          )
        }
        if (sidecar) detailsById.set(video.id, sidecar)
        else missingContentDetails.add(video.id)
      } catch (err) {
        markUnavailable(video.id)
        console.warn('[PublicBee] content details unavailable:', video.id, err?.message || err)
      }
    }
    if (missingContentDetails.size > 0) {
      try {
        let required
        if (deadline === null) {
          required = await this._contentDetailsRequired()
        } else {
          const remainingMs = deadline - Date.now()
          if (remainingMs <= 0) throw new Error('PublicBee capability read timed out')
          required = await withTimeout(
            this._contentDetailsRequired(),
            remainingMs,
            `PublicBee capability read timed out after ${streamTimeoutMs}ms`
          )
        }
        if (required) {
          for (const videoId of missingContentDetails) markUnavailable(videoId)
        }
      } catch (err) {
        for (const videoId of missingContentDetails) markUnavailable(videoId)
        console.warn('[PublicBee] content-details capability unavailable:', err?.message || err)
      }
    }
    const logical = videos.map((video) => {
      const sidecar = detailsById.get(video.id)
      return sidecar ? { ...video, ...sidecar } : video
    })
    const canonical = logical.filter((video) =>
      !unavailableContentDetails.has(video.id) &&
      video.canonicalVisibility !== 'suppressed')
    const visible = options?.includeSuppressed ? logical : canonical
    visible.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
    return result(
      visible,
      unavailableContentDetails.size > 0 || collected.status === 'uncertain'
        ? 'uncertain'
        : 'authoritative',
      logical.length - canonical.length
    )
  }

  async listVideosWithStatus(options = {}) {
    return this.listVideos({ ...options, returnStatus: true })
  }

  async _collectVideoStream(stream, streamTimeoutMs) {
    const videos = []
    let timeout = null
    let incomplete = false
    let timedOut = false
    const destroyStream = (err) => {
      try {
        stream?.destroy?.(err)
      } catch (destroyError) {
        console.warn('[PublicBee] listVideos stream destroy failed:', destroyError?.message || destroyError)
      }
    }

    if (streamTimeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true
        destroyStream(new Error(`PublicBee listVideos timed out after ${streamTimeoutMs}ms`))
      }, streamTimeoutMs)
      timeout.unref?.()
    }

    try {
      for await (const item of stream || []) {
        const video = item?.value || item
        if (video) videos.push(this._sanitizePublicVideo(video))
      }
    } catch (error) {
      incomplete = true
      if (!timedOut) {
        destroyStream(error)
        console.warn('[PublicBee] listVideos stream failed:', error?.message || error)
      } else {
        console.log('[PublicBee] listVideos stream timed out; returning partial results:', error?.message || error)
      }
    } finally {
      clearTimeout(timeout)
    }

    videos.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
    return { videos, status: incomplete ? 'uncertain' : 'authoritative' }
  }

  async getVideo(videoId, options = {}) {
    const result = await this.getVideoWithStatus(videoId, options)
    return result.video
  }

  async getVideoWithStatus(videoId, options = {}) {
    if (!videoId || !this.db) return { status: 'notFound', video: null }
    this.db.update?.()
    let video
    try {
      video = await this.db.get('@peartubePublic/videos', { id: videoId })
    } catch {
      return { status: 'uncertain', video: null }
    }
    if (!video) return { status: 'notFound', video: null }

    let details
    try {
      details = await this.db.get('@peartubePublic/contentDetails', { id: videoId })
    } catch {
      return {
        status: 'uncertain',
        video: options?.includeSuppressed ? this._sanitizePublicVideo(video) : null
      }
    }
    const logicalDetails = decodeStoredRecord(details, CONTENT_DETAIL_FIELDS, CONTENT_STORAGE_DEFAULTS)
    if (!logicalDetails) {
      try {
        if (await this._contentDetailsRequired()) {
          return {
            status: 'uncertain',
            video: options?.includeSuppressed ? this._sanitizePublicVideo(video) : null
          }
        }
      } catch {
        return {
          status: 'uncertain',
          video: options?.includeSuppressed ? this._sanitizePublicVideo(video) : null
        }
      }
    }
    const logical = this._sanitizePublicVideo(logicalDetails ? { ...video, ...logicalDetails } : video)
    if (logical?.canonicalVisibility === 'suppressed') {
      return {
        status: 'suppressed',
        video: options?.includeSuppressed ? logical : null
      }
    }
    return { status: 'found', video: logical }
  }

  async putVideo(videoId, metadata) {
    if (!this.writable) throw new Error('Not writable')
    if (!this.db) throw new Error('Public HyperDB not ready')
    const { video, details } = splitPublicVideo({ ...(metadata || {}), id: videoId })
    let format = await this.getProjectionFormat()
    if (details) format = await this.setProjectionFormat('modern')
    else if (!format) format = await this.setProjectionFormat('legacy')
    await this._writeProjectionClaimIndex({ ...(metadata || {}), id: videoId })
    this._explicitlyDeletedVideoIds?.delete(videoId)
    await this.db.insert('@peartubePublic/videos', this._sanitizePublicVideo({
      ...video,
      syncedAt: Date.now()
    }))
    if (details || format === 'modern') {
      await this.db.insert(
        '@peartubePublic/contentDetails',
        encodeStoredRecord(details || { id: videoId }, CONTENT_STORAGE_DEFAULTS)
      )
    }
    await this.db.flush()
    console.log('[PublicBee] Video added/updated:', videoId)
  }

  async deleteVideo(videoId) {
    if (!this.writable) throw new Error('Not writable')
    if (!this.db) throw new Error('Public HyperDB not ready')
    await this._writeProjectionClaimIndex({ id: videoId })
    await this.db.delete('@peartubePublic/videos', { id: videoId })
    this._explicitlyDeletedVideoIds?.add(videoId)
    await this.db.delete('@peartubePublic/contentDetails', { id: videoId })
    await this.db.flush()
    console.log('[PublicBee] Video deleted:', videoId)
  }

  async applyVideoChanges(changes) {
    if (!this.writable) throw new Error('Not writable')
    if (!Array.isArray(changes) || changes.length === 0) return
    const putChanges = changes.filter((change) =>
      change?.type === 'put' && typeof change.id === 'string' && change.id.length > 0)
    let format = await this.getProjectionFormat()
    if (putChanges.some((change) => splitPublicVideo({
      ...(change.value || {}),
      id: change.id
    }).details)) {
      format = await this.setProjectionFormat('modern')
    } else if (putChanges.length > 0 && !format) {
      format = await this.setProjectionFormat('legacy')
    }
    const batch = []
    const now = Date.now()

    for (const change of changes) {
      if (!change || typeof change.id !== 'string' || change.id.length === 0) continue
      if (change.type === 'del') {
        this._explicitlyDeletedVideoIds?.add(change.id)
        await this._writeProjectionClaimIndex({ id: change.id })
        batch.push(['@peartubePublic/videos', { id: change.id }, { type: 'delete' }])
        batch.push(['@peartubePublic/contentDetails', { id: change.id }, { type: 'delete' }])
      } else if (change.type === 'put') {
        this._explicitlyDeletedVideoIds?.delete(change.id)
        const { video, details } = splitPublicVideo({ ...(change.value || {}), id: change.id })
        await this._writeProjectionClaimIndex({ ...(change.value || {}), id: change.id })
        batch.push(['@peartubePublic/videos', this._sanitizePublicVideo({
          ...video,
          syncedAt: now
        })])
        if (details || format === 'modern') {
          batch.push([
            '@peartubePublic/contentDetails',
            encodeStoredRecord(details || { id: change.id }, CONTENT_STORAGE_DEFAULTS)
          ])
        }
      }
    }

    if (batch.length > 0) {
      await this.db.insertAll(batch)
      await this.db.flush()
    }
    console.log('[PublicBee] Applied', changes.length, 'video change(s)')
  }

  async syncVideos(videos, opts = {}) {
    if (!this.writable) throw new Error('Not writable')
    if (!this.db) throw new Error('Public HyperDB not ready')

    const destructive = opts.destructive !== false
    const claimWinners = opts.claimWinners instanceof Map ? opts.claimWinners : new Map()
    let materializeContentDetails = opts.materializeContentDetails === true
    const hasStructuredProjection = (videos || []).some((candidate) => {
      if (!candidate?.id || candidate.publicationState === 'replicationPending') return false
      const winner = candidate.importIdentityKey
        ? claimWinners.get(candidate.importIdentityKey) || null
        : null
      return isPubliclyProjectable(candidate, winner) && Boolean(splitPublicVideo(candidate).details)
    })
    let format = await this.getProjectionFormat()
    const hasImmutableBindingMismatch = (videos || []).some((candidate) => {
      if (!candidate?.importIdentityKey || !candidate.importClaimantId) return false
      const winner = claimWinners.get(candidate.importIdentityKey)
      return Boolean(
        winner?.identityKey === candidate.importIdentityKey &&
        winner.claimantId === candidate.importClaimantId &&
        winner.videoId &&
        winner.videoId !== candidate.id
      )
    })
    if (materializeContentDetails || hasStructuredProjection || hasImmutableBindingMismatch) {
      format = await this.setProjectionFormat('modern')
    } else if (!format && (videos || []).length > 0) {
      format = await this.setProjectionFormat('legacy')
    }
    if (format === 'modern') materializeContentDetails = true
    const batch = []
    const existing = new Set()
    if (destructive) {
      const existingVideos = await this.listVideos({ includeSuppressed: true })
      for (const video of existingVideos) existing.add(video.id)
    }

    const sourceIds = new Set()
    const explicitlyPendingIds = new Set()
    const now = Date.now()
    for (const candidate of videos || []) {
      if (!candidate?.id) continue
      if (candidate.publicationState === 'replicationPending') {
        explicitlyPendingIds.add(candidate.id)
        this._explicitlyDeletedVideoIds?.add(candidate.id)
        await this._writeProjectionClaimIndex({ id: candidate.id })
        batch.push(['@peartubePublic/videos', { id: candidate.id }, { type: 'delete' }])
        batch.push(['@peartubePublic/contentDetails', { id: candidate.id }, { type: 'delete' }])
        continue
      }
      const winner = candidate.importIdentityKey
        ? claimWinners.get(candidate.importIdentityKey) || null
        : null
      if (!isPubliclyProjectable(candidate, winner)) {
        const immutableBindingMismatch = Boolean(
          winner?.identityKey === candidate.importIdentityKey &&
          winner.claimantId === candidate.importClaimantId &&
          winner.videoId &&
          winner.videoId !== candidate.id
        )
        if (
          immutableBindingMismatch &&
          await this.db.get('@peartubePublic/videos', { id: candidate.id })
        ) {
          const existingDetails = await this.getContentDetails(candidate.id).catch(() => null)
          batch.push([
            '@peartubePublic/contentDetails',
            encodeStoredRecord({
              ...(existingDetails || {}),
              ...pickDefinedFields(candidate, CONTENT_DETAIL_FIELDS),
              id: candidate.id,
              canonicalVisibility: 'suppressed',
              duplicateOfClaimantId: winner.claimantId
            }, CONTENT_STORAGE_DEFAULTS)
          ])
        }
        continue
      }

      sourceIds.add(candidate.id)
      await this._writeProjectionClaimIndex(candidate)
      this._explicitlyDeletedVideoIds?.delete(candidate.id)
      const { video, details } = splitPublicVideo(candidate)
      batch.push(['@peartubePublic/videos', this._sanitizePublicVideo({
        ...video,
        syncedAt: now
      })])
      if (details || materializeContentDetails) {
        batch.push([
          '@peartubePublic/contentDetails',
          encodeStoredRecord(details || { id: candidate.id }, CONTENT_STORAGE_DEFAULTS)
        ])
      }
    }

    if (destructive) {
      for (const id of existing) {
        if (!sourceIds.has(id) && !explicitlyPendingIds.has(id)) {
          this._explicitlyDeletedVideoIds?.add(id)
          batch.push(['@peartubePublic/videos', { id }, { type: 'delete' }])
          await this._writeProjectionClaimIndex({ id })
          batch.push(['@peartubePublic/contentDetails', { id }, { type: 'delete' }])
        }
      }
    }

    if (batch.length > 0) {
      await this.db.insertAll(batch)
      await this.db.flush()
    }
    console.log('[PublicBee] Synced', videos?.length || 0, 'videos', destructive ? '(destructive)' : '(non-destructive)')
  }

  async _readProjectionClaims(channel, videos, publicCandidates) {
    if (typeof channel?.listImportClaims !== 'function') return []

    const identityKeys = new Set()
    for (const video of [...(videos || []), ...(publicCandidates || [])]) {
      if (typeof video?.importIdentityKey === 'string' && video.importIdentityKey) {
        identityKeys.add(video.importIdentityKey)
      }
    }
    const claims = []
    for (const identityKey of identityKeys) {
      const records = await channel.listImportClaims(identityKey)
      if (Array.isArray(records)) claims.push(...records)
    }
    return claims
  }

  async _suppressResolvedLosers(videos, publicCandidates, groupedClaims, claimWinners) {
    const privateByIdentity = new Map()
    for (const video of videos || []) {
      if (!video?.importIdentityKey || !video?.importClaimantId) continue
      let contenders = privateByIdentity.get(video.importIdentityKey)
      if (!contenders) {
        contenders = new Map()
        privateByIdentity.set(video.importIdentityKey, contenders)
      }
      contenders.set(video.importClaimantId, { videoId: video.id, video })
    }

    const publicByIdentity = new Map()
    for (const details of publicCandidates) {
      if (!details?.importIdentityKey || !details?.importClaimantId) continue
      let contenders = publicByIdentity.get(details.importIdentityKey)
      if (!contenders) {
        contenders = new Map()
        publicByIdentity.set(details.importIdentityKey, contenders)
      }
      contenders.set(details.importClaimantId, { videoId: details.id, video: details })
    }

    for (const [identityKey, claims] of groupedClaims) {
      const winner = claimWinners.get(identityKey)
      const contenders = new Map()
      for (const claim of claims) {
        if (!claim?.claimantId) continue
        if (!winner && claim.state !== 'released') continue
        const matchingContender =
          privateByIdentity.get(identityKey)?.get(claim.claimantId) ||
          publicByIdentity.get(identityKey)?.get(claim.claimantId)
        contenders.set(claim.claimantId, {
          ...(matchingContender || {}),
          videoId: claim.videoId || matchingContender?.videoId
        })
      }
      if (winner) {
        for (const [claimantId, contender] of publicByIdentity.get(identityKey) || []) {
          if (
            !contenders.has(claimantId) &&
            contender.video?.canonicalVisibility === 'suppressed'
          ) {
            contenders.set(claimantId, contender)
          }
        }
      }

      for (const [claimantId, contender] of contenders) {
        if (winner && claimantId === winner.claimantId) continue
        const videoId = contender.videoId
        if (!videoId) continue
        const existingVideo = await this.db.get('@peartubePublic/videos', { id: videoId })
        if (!existingVideo) continue
        const existingDetails = await this.getContentDetails(videoId)
        await this.putContentDetails(videoId, {
          ...(existingDetails || {}),
          ...(contender.video ? pickDefinedFields(contender.video, CONTENT_DETAIL_FIELDS) : {}),
          canonicalVisibility: 'suppressed',
          duplicateOfClaimantId: winner?.claimantId
        })
      }
    }
  }

  async _stabilizeClaimWinners(
    videos,
    publicCandidates,
    unavailableContentDetails,
    groupedClaims,
    claimWinners
  ) {
    const publicIds = new Set((publicCandidates || []).map((candidate) => candidate?.id))
    for (const video of videos || []) {
      if (
        !unavailableContentDetails?.has(video?.id) ||
        !video?.importIdentityKey ||
        !video?.importClaimantId
      ) {
        continue
      }
      const proposedWinner = claimWinners.get(video.importIdentityKey)
      const observedClaims = groupedClaims.get(video.importIdentityKey) || []
      const claimantObserved = observedClaims.some(
        (claim) => claim?.claimantId === video.importClaimantId
      )
      if (
        proposedWinner?.claimantId === video.importClaimantId ||
        (
          publicIds.has(video.id) &&
          proposedWinner &&
          proposedWinner.claimantId !== video.importClaimantId &&
          !claimantObserved
        )
      ) {
        claimWinners.set(video.importIdentityKey, null)
      }
    }
    for (const [identityKey, proposedWinner] of claimWinners) {
      if (!proposedWinner) continue
      const observedClaims = groupedClaims.get(identityKey) || []
      const observedClaimants = new Set(
        observedClaims.map((claim) => claim?.claimantId).filter(Boolean)
      )
      const establishedCandidates = (publicCandidates || [])
        .filter((candidate) =>
          candidate?.importIdentityKey === identityKey &&
          candidate.importClaimantId &&
          candidate.importClaimantId !== proposedWinner.claimantId &&
          candidate.canonicalVisibility !== 'suppressed' &&
          !this._explicitlyDeletedVideoIds?.has(candidate.id) &&
          !observedClaimants.has(candidate.importClaimantId))
        .sort((left, right) => left.importClaimantId.localeCompare(right.importClaimantId))
      let established = null
      for (const candidate of establishedCandidates) {
        try {
          if (await this.db.get('@peartubePublic/videos', { id: candidate.id })) {
            established = candidate
            break
          }
        } catch {
          claimWinners.set(identityKey, null)
          established = null
          break
        }
      }
      if (established) {
        claimWinners.set(identityKey, {
          identityKey,
          claimantId: established.importClaimantId,
          videoId: established.id
        })
      }
    }
    for (const candidate of publicCandidates || []) {
      if (
        candidate?.canonicalVisibility !== 'suppressed' ||
        !candidate.importIdentityKey ||
        !candidate.importClaimantId ||
        !candidate.duplicateOfClaimantId
      ) {
        continue
      }
      const proposedWinner = claimWinners.get(candidate.importIdentityKey)
      if (proposedWinner?.claimantId !== candidate.importClaimantId) continue
      const observedClaims = groupedClaims.get(candidate.importIdentityKey) || []
      const priorWinnerObserved = observedClaims.some(
        (claim) => claim?.claimantId === candidate.duplicateOfClaimantId
      )
      const priorWinner = (publicCandidates || []).find((contender) =>
        contender?.importIdentityKey === candidate.importIdentityKey &&
        contender.importClaimantId === candidate.duplicateOfClaimantId &&
        !this._explicitlyDeletedVideoIds?.has(contender.id))
      if (!priorWinnerObserved && priorWinner) {
        claimWinners.set(candidate.importIdentityKey, {
          identityKey: candidate.importIdentityKey,
          claimantId: priorWinner.importClaimantId,
          videoId: priorWinner.id
        })
      }
    }
  }

  async syncFromChannel(channel, options = {}) {
    const result = await this._enqueueSerialized(
      '_projectionWriteTail',
      () => this._syncFromChannelUnlocked(channel, options)
    )
    if (this._onCanonicalClaimsSynchronized && options.notifyCanonicalSync !== false) {
      try {
        await this._onCanonicalClaimsSynchronized(channel)
      } catch (err) {
        console.warn('[PublicBee] Post-sync canonical reconciliation failed:', err?.message || err)
      }
    }
    return result
  }

  async _syncFromChannelUnlocked(channel, { throwOnError = false } = {}) {
    if (!this.writable) {
      console.log('[PublicBee] Not writable, skipping sync')
      return
    }

    try {
      const [meta, videos, profile, sources, artwork] = await Promise.all([
        channel.getMetadata?.() || null,
        channel.listVideos?.() || [],
        channel.getChannelProfile?.() || null,
        channel.listChannelSources?.() || [],
        channel.listChannelArtwork?.() || []
      ])
      if (meta) await this.setMetadata(meta)
      const logicalProfile = profile || pickDefinedFields(meta, CHANNEL_PROFILE_FIELDS)
      if (logicalProfile && Object.keys(logicalProfile).length > 0) {
        await this.putChannelProfile(logicalProfile)
      }
      for (const source of sources || []) await this.putChannelSource(source)
      for (const record of artwork || []) await this.putChannelArtwork(record)
      const unavailableContentDetails = new Set()
      const reconciliationStatus = {}
      const publicListing = await this.listVideosWithStatus({
        includeSuppressed: true,
        unavailableContentDetails,
        reconciliationStatus
      })
      const publicCandidates = publicListing.videos
      const publicCandidatesById = new Map(
        publicCandidates.map((candidate) => [candidate.id, candidate])
      )
      let blockAllClaimPromotions = reconciliationStatus.scanComplete === false
      for (const videoId of unavailableContentDetails) {
        const candidate = publicCandidatesById.get(videoId)
        if (!candidate) {
          blockAllClaimPromotions = true
          continue
        }
        if (candidate.importIdentityKey && candidate.importClaimantId) continue
        const claimIndex = await this._readProjectionClaimIndex(videoId)
        if (claimIndex) Object.assign(candidate, claimIndex)
        else blockAllClaimPromotions = true
      }
      let projectionFormat = await this.getProjectionFormat()
      if (!projectionFormat) {
        const root = await this.getRootDescriptor()
        if (root) {
          const verified = await verifySignedChannelRootDescriptor(root)
          if (!verified?.valid) {
            throw new Error('Public projection root descriptor is invalid')
          }
          const rootRevision = root.descriptor?.profile?.canonicalRevision
          if (rootRevision) {
            const publicProfile = await this.getChannelProfile()
            if (publicProfile?.canonicalRevision !== rootRevision) {
              throw new Error('Public projection profile revision evidence is incomplete')
            }
            projectionFormat = await this.setProjectionFormat('modern')
          } else {
            projectionFormat = await this.setProjectionFormat('legacy')
          }
        } else if (
          publicListing.status === 'authoritative' &&
          publicCandidates.length === 0 &&
          !logicalProfile?.canonicalRevision
        ) {
          projectionFormat = await this.setProjectionFormat('legacy')
        } else if (
          !logicalProfile?.canonicalRevision &&
          !(videos || []).some((candidate) => Boolean(splitPublicVideo(candidate).details)) &&
          reconciliationStatus.scanComplete !== false
        ) {
          // Non-empty pre-durability projection: public rows already exist but
          // predate the projection-format marker and no durable root descriptor
          // was ever written. The authoritative local source channel carries no
          // structured (modern) projection evidence, so this is a genuine legacy
          // channel. Establish the legacy format from local channel truth to keep
          // its videos publicly readable instead of failing closed forever.
          // Sparse viewer replicas never reach this path: they are non-writable
          // and return early. A completed local scan (scanComplete) gates against
          // treating a timed-out partial read as authoritative.
          projectionFormat = await this.setProjectionFormat('legacy')
        } else {
          throw new Error('Public projection format evidence is unavailable')
        }
      }
      const materializeContentDetails = projectionFormat === 'modern'
      const claims = await this._readProjectionClaims(channel, videos, publicCandidates)
      const groupedClaims = groupClaimsByIdentity(claims)
      const claimWinners = new Map()
      for (const [identityKey, identityClaims] of groupedClaims) {
        claimWinners.set(identityKey, resolveClaimWinner(identityClaims))
      }
      if (blockAllClaimPromotions) {
        for (const identityKey of claimWinners.keys()) claimWinners.set(identityKey, null)
      }
      await this._stabilizeClaimWinners(
        videos,
        publicCandidates,
        unavailableContentDetails,
        groupedClaims,
        claimWinners
      )

      await this.syncVideos(videos || [], {
        destructive: false,
        claimWinners,
        materializeContentDetails
      })
      await this._suppressResolvedLosers(videos, publicCandidates, groupedClaims, claimWinners)
      console.log('[PublicBee] Synced from channel:', channel.keyHex?.slice(0, 16))
      return { claims, blockAllClaimPromotions }
    } catch (err) {
      console.error('[PublicBee] Sync error:', err.message)
      if (throwOnError) throw err
    }
  }

  async getCanonicalReconciliationRevision() {
    await this.waitForSync(1500)
    if (!this.db?.db || typeof this.db.db.get !== 'function') return null
    const node = await this.db.db.get(CANONICAL_RECONCILIATION_REVISION_KEY)
    if (!node?.value) return null
    const revision = b4a.toString(node.value)
    return /^sha256:[0-9a-f]{64}$/.test(revision) ? revision : null
  }

  async _setCanonicalReconciliationRevisionUnlocked(revision) {
    if (!this.writable) throw new Error('Not writable')
    if (!this.db?.db) throw new Error('Public HyperDB not ready')
    if (!/^sha256:[0-9a-f]{64}$/.test(revision || '')) {
      throw new Error('Canonical reconciliation revision must be a lowercase SHA-256 revision')
    }
    const current = await this.getCanonicalReconciliationRevision()
    if (current === revision) return false
    await this.db.db.put(CANONICAL_RECONCILIATION_REVISION_KEY, b4a.from(revision))
    this.db.update?.()
    return true
  }

  async reconcileCanonicalClaims(channel, { revisionForVideos } = {}) {
    if (typeof revisionForVideos !== 'function') {
      throw new Error('revisionForVideos must be a function')
    }
    return this._enqueueSerialized('_projectionWriteTail', async () => {
      const evidence = await this._syncFromChannelUnlocked(channel, { throwOnError: true })
      const listing = await this.listVideosWithStatus()
      let claimsAuthoritative = Boolean(evidence) && evidence.blockAllClaimPromotions !== true
      const claimsByIdentity = groupClaimsByIdentity(evidence?.claims || [])
      const visibleByIdentity = new Set()
      for (const video of listing.videos || []) {
        const hasIdentity = typeof video?.importIdentityKey === 'string' && video.importIdentityKey.length > 0
        const hasClaimant = typeof video?.importClaimantId === 'string' && video.importClaimantId.length > 0
        if (hasIdentity !== hasClaimant) {
          claimsAuthoritative = false
          continue
        }
        if (!hasIdentity) continue
        if (visibleByIdentity.has(video.importIdentityKey)) {
          claimsAuthoritative = false
          continue
        }
        visibleByIdentity.add(video.importIdentityKey)
        const winner = resolveClaimWinner(claimsByIdentity.get(video.importIdentityKey) || [])
        if (
          !winner ||
          winner.claimantId !== video.importClaimantId ||
          winner.videoId !== video.id
        ) {
          claimsAuthoritative = false
        }
      }
      if (listing.status !== 'authoritative' || !claimsAuthoritative) {
        return {
          status: 'uncertain',
          videos: listing.videos || [],
          revision: await this.getCanonicalReconciliationRevision(),
          revisionChanged: false
        }
      }
      const revision = revisionForVideos(listing.videos)
      const revisionChanged = await this._setCanonicalReconciliationRevisionUnlocked(revision)
      return {
        status: 'authoritative',
        videos: listing.videos,
        revision,
        revisionChanged
      }
    })
  }

  async activatePublicProjection(options = {}) {
    return this._enqueueSerialized(
      '_projectionWriteTail',
      () => this._activatePublicProjectionUnlocked(options)
    )
  }

  async _activatePublicProjectionUnlocked({
    channel,
    stagedDescriptor,
    stagedProfile,
    stagedSources = [],
    stagedArtwork = []
  } = {}) {
    if (!this.writable) throw new Error('Not writable')
    const expectedChannelId = channel?.keyHex?.toLowerCase?.() || null
    let stagedDescriptorValid = false
    if (stagedDescriptor) {
      const stagedCheck = await verifySignedChannelRootDescriptor(stagedDescriptor)
      stagedDescriptorValid = Boolean(
        stagedCheck?.valid &&
        (!expectedChannelId || stagedCheck.descriptor?.channelId === expectedChannelId)
      )
      if (stagedDescriptorValid) await this.setRootDescriptor(stagedDescriptor)
    }

    const acceptedDescriptor = await this.getRootDescriptor()
    const acceptedCheck = await verifySignedChannelRootDescriptor(acceptedDescriptor)
    if (
      !acceptedCheck?.valid ||
      (expectedChannelId && acceptedCheck.descriptor?.channelId !== expectedChannelId)
    ) {
      throw new Error('A valid signed channel root descriptor is required for public activation')
    }
    const stagedDescriptorAccepted = stagedDescriptorValid &&
      compareSignedChannelRootDescriptors(stagedDescriptor, acceptedDescriptor) === 0
    await this.setProjectionFormat('modern')

    if (stagedProfile) {
      const metadata = pickDefinedFields(stagedProfile, PUBLIC_METADATA_FIELDS)
      if (Object.keys(metadata).length > 0) await this.setMetadata(metadata)
      const profile = pickDefinedFields(stagedProfile, CHANNEL_PROFILE_FIELDS)
      if (!stagedDescriptorAccepted) delete profile.canonicalRevision
      if (Object.keys(profile).length > 0) {
        await this.putChannelProfile(profile, { descriptor: acceptedDescriptor })
      }
    }
    for (const source of stagedSources || []) await this.putChannelSource(source)
    for (const artwork of stagedArtwork || []) await this.putChannelArtwork(artwork)
    // Reconcile last so committed private records supersede stale staged bootstrap
    // values while staged records absent from the private snapshot remain public.
    if (channel) await this._syncFromChannelUnlocked(channel, { throwOnError: true })
    return this.keyHex
  }
}
