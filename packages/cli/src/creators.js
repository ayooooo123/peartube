import { existsSync, mkdirSync, readFileSync, writeFileSync } from '#fs'
import { join } from '#path'
import { RELAY_CREATORS_FILENAME } from './constants.js'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function ensureParentDir(path) {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (separatorIndex > 0) ensureDir(path.slice(0, separatorIndex))
}

export function slugifyCreator(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/**
 * Normalize any creator/source identifier into the canonical scheme used across
 * the relay: `youtube:channel:<id>`, `youtube:handle:<@handle>`, or
 * `youtube:creator:<slug>`. Accepts the looser archive `sourceId` form
 * (`youtube:<identifier>`) and upgrades it.
 */
export function normalizeCreatorId(raw) {
  const value = String(raw || '').trim()
  if (!value) return null

  // Already canonical (`type:kind:id`).
  if (/^[a-z0-9-]+:(channel|handle|creator|user|custom|playlist|video|rumble-[a-z]+):/i.test(value)) {
    return value
  }
  // Owner/channel fallbacks are already canonical two-part ids.
  if (/^(owner|channel):/i.test(value)) return value

  const parts = value.split(':')
  if (parts.length >= 2) {
    const type = parts[0]
    const identifier = parts.slice(1).join(':')
    if (identifier.startsWith('@')) return `${type}:handle:${identifier}`
    if (/^UC[0-9A-Za-z_-]{20,}$/.test(identifier)) return `${type}:channel:${identifier}`
    return `${type}:creator:${slugifyCreator(identifier)}`
  }

  return `creator:${slugifyCreator(value)}`
}

/**
 * Build a canonical creator id from a classified source URL
 * (see archive/source-id.js classifySourceUrl()).
 */
export function creatorIdFromClassifiedSource(classified) {
  if (!classified?.type || !classified?.identifier) return null
  const { type, identifier, kind } = classified
  if (kind === 'handle' || identifier.startsWith('@')) return `${type}:handle:${identifier}`
  if (kind === 'channel') return `${type}:channel:${identifier}`
  if (kind && kind.startsWith('rumble-')) return `${type}:${kind}:${identifier}`
  if (/^UC[0-9A-Za-z_-]{20,}$/.test(identifier)) return `${type}:channel:${identifier}`
  return normalizeCreatorId(`${type}:${identifier}`)
}

/**
 * Derive a stable creator identity from an archived video record (and the
 * channel that hosts it). Always returns an id so every archived video maps to
 * exactly one creator bucket, even when the source did not carry a creatorId.
 */
export function deriveCreatorFromVideo(video = {}, channel = {}) {
  const name = (typeof video.creatorName === 'string' && video.creatorName.trim())
    || (typeof channel.creatorName === 'string' && channel.creatorName.trim())
    || (typeof channel.channelName === 'string' && channel.channelName.trim())
    || null
  const handle = (typeof video.creatorHandle === 'string' && video.creatorHandle.trim()) || null

  let creatorId = null
  if (video.creatorSourceId) creatorId = normalizeCreatorId(video.creatorSourceId)
  else if (handle) creatorId = `youtube:handle:${handle}`
  else if (name) creatorId = `youtube:creator:${slugifyCreator(name)}`
  else if (channel.ownerKey) creatorId = `owner:${channel.ownerKey}`
  else if (channel.channelKey || channel.driveKey) creatorId = `channel:${channel.channelKey || channel.driveKey}`

  return {
    creatorId,
    name: name || handle || creatorId,
    handle,
    sourceType: video.sourceType || channel.sourceType || (creatorId ? creatorId.split(':')[0] : null)
  }
}

export function videoIsUnseeded(video = {}) {
  const playable = video.availability === 'playable' || video.byteAvailability === 'playable'
  return !playable
}

function emptyCreator(creatorId) {
  return {
    creatorId,
    name: null,
    handle: null,
    sourceType: null,
    sourceUrls: [],
    channelKeys: [],
    videosArchived: 0,
    videosUnseeded: 0,
    classification: { movie: 0, tv: 0, unknown: 0 },
    lastArchivedAt: 0
  }
}

/**
 * Aggregate catalog channel records into per-creator stats. Each channel record
 * carries `previewVideos` and `unavailableVideos`; we de-duplicate videos by id
 * so a creator spread across several relay channels is counted once.
 */
export function summarizeCreatorsFromCatalog(channels = []) {
  const byCreator = new Map()
  const seenVideos = new Map() // creatorId -> Set(videoId)

  for (const channel of Array.isArray(channels) ? channels : []) {
    const channelKey = channel?.channelKey || channel?.driveKey || null
    const videos = [
      ...(Array.isArray(channel?.previewVideos) ? channel.previewVideos : []),
      ...(Array.isArray(channel?.unavailableVideos) ? channel.unavailableVideos : [])
    ]

    for (const video of videos) {
      if (!video) continue
      const { creatorId, name, handle, sourceType } = deriveCreatorFromVideo(video, channel)
      if (!creatorId) continue

      const record = byCreator.get(creatorId) || emptyCreator(creatorId)
      if (!record.name && name) record.name = name
      if (!record.handle && handle) record.handle = handle
      if (!record.sourceType && sourceType) record.sourceType = sourceType
      if (channelKey && !record.channelKeys.includes(channelKey)) record.channelKeys.push(channelKey)

      const videoId = video.id || `${channelKey}:${video.blobId || video.path || ''}`
      let seen = seenVideos.get(creatorId)
      if (!seen) { seen = new Set(); seenVideos.set(creatorId, seen) }
      if (!seen.has(videoId)) {
        seen.add(videoId)
        record.videosArchived += 1
        if (videoIsUnseeded(video)) record.videosUnseeded += 1
        const type = video.classification?.type
        if (type === 'movie') record.classification.movie += 1
        else if (type === 'tv') record.classification.tv += 1
        else record.classification.unknown += 1
      }

      const uploadedAt = Number(video.uploadedAt || 0) || 0
      if (uploadedAt > record.lastArchivedAt) record.lastArchivedAt = uploadedAt

      byCreator.set(creatorId, record)
    }
  }

  return Array.from(byCreator.values()).sort((a, b) => (b.videosArchived - a.videosArchived))
}

/**
 * Rank creators by how much of their content still needs a seeder, so an
 * operator can target the most under-replicated creators first.
 */
export function rankUnseededTargets(creators = [], { limit = 0 } = {}) {
  const ranked = (Array.isArray(creators) ? creators : [])
    .filter((creator) => Number(creator?.videosUnseeded || 0) > 0)
    .map((creator) => ({
      creatorId: creator.creatorId,
      name: creator.name || creator.creatorId,
      handle: creator.handle || null,
      channelKeys: creator.channelKeys || [],
      videosArchived: Number(creator.videosArchived || 0) || 0,
      videosUnseeded: Number(creator.videosUnseeded || 0) || 0,
      unseededRatio: Number(creator.videosArchived || 0) > 0
        ? Number((creator.videosUnseeded / creator.videosArchived).toFixed(3))
        : 1
    }))
    .sort((a, b) => (b.videosUnseeded - a.videosUnseeded) || (b.unseededRatio - a.unseededRatio))

  return limit > 0 ? ranked.slice(0, limit) : ranked
}

function mergeCreatorRecord(existing, derived) {
  const base = existing || emptyCreator(derived.creatorId)
  const sourceUrls = Array.from(new Set([...(base.sourceUrls || []), ...(derived.sourceUrls || [])]))
  const channelKeys = Array.from(new Set([...(base.channelKeys || []), ...(derived.channelKeys || [])]))
  return {
    ...base,
    ...derived,
    name: derived.name || base.name || derived.creatorId,
    handle: derived.handle || base.handle || null,
    sourceType: derived.sourceType || base.sourceType || null,
    sourceUrls,
    channelKeys,
    label: derived.label || base.label || null,
    addedAt: base.addedAt || derived.addedAt || Date.now(),
    lastArchivedAt: Math.max(Number(base.lastArchivedAt || 0), Number(derived.lastArchivedAt || 0))
  }
}

function readStore(path) {
  if (!existsSync(path)) {
    return { version: 1, updatedAt: Date.now(), creators: {} }
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

export class RelayCreators {
  constructor({ storagePath, creatorsPath, data }) {
    this.storagePath = storagePath
    this.creatorsPath = creatorsPath
    this.data = data
  }

  static async open({ storagePath, creatorsPath = join(storagePath, RELAY_CREATORS_FILENAME) }) {
    ensureDir(storagePath)
    ensureParentDir(creatorsPath)
    return new RelayCreators({ storagePath, creatorsPath, data: readStore(creatorsPath) })
  }

  async persist() {
    this.data.updatedAt = Date.now()
    ensureParentDir(this.creatorsPath)
    writeFileSync(this.creatorsPath, JSON.stringify(this.data, null, 2))
  }

  getCreator(creatorId) {
    const id = normalizeCreatorId(creatorId)
    const creator = id ? this.data.creators[id] : null
    return creator ? clone(creator) : null
  }

  getCreators() {
    return Object.values(this.data.creators).map((creator) => clone(creator))
  }

  /** Upsert a manually-registered creator (e.g. "add creator by URL"). */
  async upsertCreator(record) {
    const creatorId = normalizeCreatorId(record?.creatorId)
    if (!creatorId) throw new Error('creatorId is required')
    const merged = mergeCreatorRecord(this.data.creators[creatorId], { ...record, creatorId })
    this.data.creators[creatorId] = merged
    await this.persist()
    return clone(merged)
  }

  /**
   * Recompute per-creator archive/unseeded stats from the catalog while
   * preserving durable fields (source URLs, added timestamp, label).
   */
  async syncFromCatalog(channels = []) {
    const derived = summarizeCreatorsFromCatalog(channels)
    const next = {}

    for (const creator of derived) {
      next[creator.creatorId] = mergeCreatorRecord(this.data.creators[creator.creatorId], creator)
    }
    // Keep manually-registered creators that have no archived videos yet.
    for (const [creatorId, creator] of Object.entries(this.data.creators)) {
      if (next[creatorId]) continue
      if ((creator.sourceUrls || []).length === 0 && !creator.manual) continue
      next[creatorId] = { ...creator, videosArchived: 0, videosUnseeded: 0 }
    }

    this.data.creators = next
    await this.persist()
    return this.getCreators()
  }

  getTargets({ limit = 0 } = {}) {
    return rankUnseededTargets(this.getCreators(), { limit })
  }

  getSummary() {
    const creators = this.getCreators()
    let videosArchived = 0
    let videosUnseeded = 0
    let classifiedMovies = 0
    let classifiedTv = 0
    for (const creator of creators) {
      videosArchived += Number(creator.videosArchived || 0) || 0
      videosUnseeded += Number(creator.videosUnseeded || 0) || 0
      classifiedMovies += Number(creator.classification?.movie || 0) || 0
      classifiedTv += Number(creator.classification?.tv || 0) || 0
    }
    return {
      totalCreators: creators.length,
      videosArchived,
      videosUnseeded,
      classifiedMovies,
      classifiedTv
    }
  }
}
