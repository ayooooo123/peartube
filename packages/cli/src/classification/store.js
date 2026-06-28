import { existsSync, mkdirSync, readFileSync, writeFileSync } from '#fs'
import { join } from '#path'
import { RELAY_CLASSIFICATION_FILENAME } from '../constants.js'
import { parseTitleForTmdb } from './tmdb.js'

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function ensureParentDir(path) {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (separatorIndex > 0) ensureDir(path.slice(0, separatorIndex))
}

/** Stable cache key so the same title is never classified twice. */
export function classificationKey({ videoId, title } = {}) {
  if (videoId) return `id:${videoId}`
  const { query, year } = parseTitleForTmdb(title)
  return `title:${query.toLowerCase()}:${year || ''}`
}

function readStore(path) {
  if (!existsSync(path)) return { version: 1, updatedAt: Date.now(), entries: {} }
  return JSON.parse(readFileSync(path, 'utf8'))
}

export class RelayClassificationStore {
  constructor({ storagePath, classificationPath, data }) {
    this.storagePath = storagePath
    this.classificationPath = classificationPath
    this.data = data
  }

  static async open({ storagePath, classificationPath = join(storagePath, RELAY_CLASSIFICATION_FILENAME) }) {
    ensureDir(storagePath)
    ensureParentDir(classificationPath)
    return new RelayClassificationStore({ storagePath, classificationPath, data: readStore(classificationPath) })
  }

  async persist() {
    this.data.updatedAt = Date.now()
    ensureParentDir(this.classificationPath)
    writeFileSync(this.classificationPath, JSON.stringify(this.data, null, 2))
  }

  get(input) {
    const entry = this.data.entries[classificationKey(input)]
    return entry ? { ...entry } : null
  }

  async set(input, result) {
    this.data.entries[classificationKey(input)] = { ...result }
    await this.persist()
    return result
  }

  /**
   * Classify a single video, using the cache first. Returns the classification
   * result, or null when the classifier is disabled. Never throws — archiving
   * must not depend on TMDB availability.
   */
  async classifyVideo({ classifier, videoId, title, year }) {
    const cached = this.get({ videoId, title })
    if (cached) return cached
    if (!classifier?.enabled) return null
    try {
      const result = await classifier.classify({ title, year })
      if (result) await this.set({ videoId, title }, result)
      return result
    } catch {
      return null
    }
  }
}
