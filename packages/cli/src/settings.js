import { existsSync, mkdirSync, readFileSync, writeFileSync } from '#fs'
import { join } from '#path'
import { RELAY_SETTINGS_FILENAME } from './constants.js'

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function ensureParentDir(path) {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (separatorIndex > 0) ensureDir(path.slice(0, separatorIndex))
}

function readStore(path) {
  if (!existsSync(path)) return { version: 1, updatedAt: Date.now(), values: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      if (!parsed.values || typeof parsed.values !== 'object') parsed.values = {}
      return parsed
    }
  } catch {}
  return { version: 1, updatedAt: Date.now(), values: {} }
}

/**
 * Small runtime-mutable settings store for values an operator may want to set
 * from the console without editing the YAML config (e.g. a TMDB API key).
 * Settings override the static config when present.
 */
export class RelaySettings {
  constructor({ storagePath, settingsPath, data }) {
    this.storagePath = storagePath
    this.settingsPath = settingsPath
    this.data = data
  }

  static async open({ storagePath, settingsPath = join(storagePath, 'db', RELAY_SETTINGS_FILENAME) }) {
    ensureDir(storagePath)
    ensureParentDir(settingsPath)
    return new RelaySettings({ storagePath, settingsPath, data: readStore(settingsPath) })
  }

  get(key, fallback = null) {
    try {
      if (existsSync(this.settingsPath)) {
        this.data = readStore(this.settingsPath)
      }
    } catch {}
    if (!this.data || typeof this.data !== 'object') this.data = { version: 1, updatedAt: Date.now(), values: {} }
    if (!this.data.values || typeof this.data.values !== 'object') this.data.values = {}
    const value = this.data.values[key]
    return value === undefined ? fallback : value
  }

  async set(key, value) {
    try {
      if (existsSync(this.settingsPath)) {
        this.data = readStore(this.settingsPath)
      }
    } catch {}
    if (!this.data || typeof this.data !== 'object') this.data = { version: 1, updatedAt: Date.now(), values: {} }
    if (!this.data.values || typeof this.data.values !== 'object') this.data.values = {}
    this.data.values[key] = value
    this.data.updatedAt = Date.now()
    ensureParentDir(this.settingsPath)
    writeFileSync(this.settingsPath, JSON.stringify(this.data, null, 2))
    return value
  }
}
/**
 * Resolve effective TMDB classifier options from config plus any runtime
 * settings overrides. Settings win so a console-entered key takes effect
 * without a restart.
 */
export function resolveTmdbOptions(config = {}, settings = null) {
  const tmdb = config?.classification?.tmdb || {}
  const settingsApiKey = settings?.get?.('tmdbApiKey', null)
  const settingsEnabled = settings?.get?.('tmdbEnabled', null)
  const apiKey = settingsApiKey || tmdb.apiKey || ''
  return {
    apiKey,
    baseUrl: tmdb.baseUrl,
    language: tmdb.language,
    enabled: (settingsEnabled === null ? Boolean(tmdb.enabled) : Boolean(settingsEnabled)) && Boolean(apiKey)
  }
}
