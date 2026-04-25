import { join } from 'node:path'
import { createEngine } from '@peartube/engine'

const ENGINE_MAPPING_PREFIX = 'engine-channel:'

export function createEngineAdapter({
  storagePath,
  ctx,
  createEngineImpl = createEngine,
  swarm = null,
  startDiscovery = true
}) {
  if (!storagePath) throw new Error('storagePath is required')
  if (!ctx?.metaDb) throw new Error('ctx.metaDb is required')

  const engines = new Map()
  const mappings = new Map()

  async function readMapping(uiChannelKey) {
    if (!uiChannelKey) return null
    if (mappings.has(uiChannelKey)) return mappings.get(uiChannelKey)

    const stored = await ctx.metaDb.get(mappingKey(uiChannelKey)).catch(() => null)
    const mapping = stored?.value || null
    if (mapping?.engineChannelKey) mappings.set(uiChannelKey, mapping)
    return mapping?.engineChannelKey ? mapping : null
  }

  async function writeMapping(uiChannelKey, mapping) {
    mappings.set(uiChannelKey, mapping)
    await ctx.metaDb.put(mappingKey(uiChannelKey), mapping)
  }

  async function openEngine(uiChannelKey, { name = 'PearTube Channel' } = {}) {
    if (engines.has(uiChannelKey)) return engines.get(uiChannelKey)

    let mapping = await readMapping(uiChannelKey)
    const channelStoragePath = mapping?.storagePath || engineStoragePath(storagePath, uiChannelKey)
    const opts = {
      storagePath: channelStoragePath,
      name
    }
    if (mapping?.engineChannelKey) opts.channelKey = mapping.engineChannelKey

    const engine = await createEngineImpl(opts)
    if (!mapping) {
      mapping = {
        uiChannelKey,
        engineChannelKey: engine.channelKey,
        storagePath: channelStoragePath,
        createdAt: Date.now()
      }
      await writeMapping(uiChannelKey, mapping)
    }

    if (startDiscovery && typeof engine.startDiscovery === 'function') {
      try { engine.startDiscovery({ swarm, announce: true, lookup: true }) } catch {}
    }

    engines.set(uiChannelKey, engine)
    return engine
  }

  return {
    async hasEngineChannel(uiChannelKey) {
      return Boolean(await readMapping(uiChannelKey))
    },

    async ensureEngineForUiChannel(uiChannelKey, opts) {
      if (!uiChannelKey) throw new Error('uiChannelKey is required')
      return openEngine(uiChannelKey, opts)
    },

    async uploadVideo(uiChannelKey, filePath, options = {}) {
      const engine = await openEngine(uiChannelKey, { name: options.channelName })
      const record = await engine.writeVideoFile(filePath, options)
      return { video: adaptEngineVideoRecord(record, uiChannelKey) }
    },

    async listVideos(uiChannelKey) {
      const engine = await openEngine(uiChannelKey)
      const records = await engine.listVideos()
      return records.map((record) => adaptEngineVideoRecord(record, uiChannelKey))
    },

    async getVideoData(uiChannelKey, videoIdOrPath) {
      const engine = await openEngine(uiChannelKey)
      const id = normalizeEngineVideoId(videoIdOrPath)
      const record = id ? await engine.getVideo(id) : null
      return record ? adaptEngineVideoRecord(record, uiChannelKey) : null
    },

    async getVideoUrl(uiChannelKey, videoIdOrPath) {
      const engine = await openEngine(uiChannelKey)
      const id = normalizeEngineVideoId(videoIdOrPath)
      if (!id) throw new Error('video id is required')
      const url = await engine.getVideoUrl(id)
      return { url }
    },

    async preparePlayback(uiChannelKey, videoIdOrPath) {
      const result = await this.getVideoUrl(uiChannelKey, videoIdOrPath)
      return {
        url: result.url,
        stats: { status: 'playable', progress: 1, isComplete: true },
        warmupStarted: false
      }
    },

    async close() {
      const closeTasks = []
      for (const engine of engines.values()) {
        closeTasks.push(Promise.resolve(engine.close?.()).catch(() => {}))
      }
      engines.clear()
      await Promise.all(closeTasks)
    }
  }
}

export function normalizeEngineVideoId(value) {
  if (!value || typeof value !== 'string') return value
  if (!value.startsWith('/videos/')) return value
  const match = value.match(/\/videos\/([^/]+)\/(?:source\.[^/]+|video\.json|thumbnail)$/)
  if (match?.[1]) return match[1]
  const fallback = value.match(/\/videos\/([^/.]+)/)
  return fallback?.[1] || value
}

export function adaptEngineVideoRecord(record, uiChannelKey) {
  const createdAt = record.createdAt || record.uploadedAt || Date.now()
  return {
    id: String(record.id || ''),
    title: record.title || 'Untitled',
    description: record.description || '',
    path: record.filename || `/videos/${record.id}/source.mp4`,
    filename: record.filename || `/videos/${record.id}/source.mp4`,
    duration: record.duration || 0,
    thumbnail: record.thumbnail || null,
    channelKey: uiChannelKey,
    channelName: record.channelName || '',
    createdAt,
    uploadedAt: record.uploadedAt || createdAt,
    views: record.views || 0,
    category: record.category || '',
    mimeType: record.mimeType || 'video/mp4',
    size: record.size || record.byteLength || 0,
    byteLength: record.byteLength || record.size || 0,
    availability: 'playable',
    publicBeeKey: null,
    source: 'engine'
  }
}

function mappingKey(uiChannelKey) {
  return `${ENGINE_MAPPING_PREFIX}${uiChannelKey}`
}

function engineStoragePath(basePath, uiChannelKey) {
  return join(basePath, 'engine-channels', sanitizePathSegment(uiChannelKey))
}

function sanitizePathSegment(value) {
  return String(value || 'channel').replace(/[^a-zA-Z0-9._-]/g, '_')
}
