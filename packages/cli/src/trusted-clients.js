import { existsSync, mkdirSync, readFileSync, writeFileSync } from '#fs'
import { join } from '#path'
import { RELAY_TRUSTED_CLIENTS_FILENAME } from './constants.js'

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function ensureParentDir(path) {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (separatorIndex > 0) ensureDir(path.slice(0, separatorIndex))
}

/** A blind-peer client key is a 64-char hex (the device's noise/swarm key). */
export function normalizeClientKey(value) {
  const raw = String(value || '').trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(raw) ? raw : null
}

function readStore(path) {
  if (!existsSync(path)) return { version: 1, updatedAt: Date.now(), clients: {} }
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Persisted allow-list of client device keys the relay trusts to delegate
 * uploads to its blind peer. This is the operator-facing "link my device" list:
 * a creator's phone publishes its device key, the operator authorizes it here,
 * and the relay then mirrors that device's uploads/livestreams so they always
 * have at least one peer.
 *
 * The store is the source of truth shared by the CLI (which edits it directly)
 * and the running relay (which merges it into its blind-peer trusted set at
 * startup, and best-effort live-applies new keys).
 */
export class TrustedClients {
  constructor({ storagePath, trustedClientsPath, data }) {
    this.storagePath = storagePath
    this.trustedClientsPath = trustedClientsPath
    this.data = data
  }

  static async open({ storagePath, trustedClientsPath = join(storagePath, 'db', RELAY_TRUSTED_CLIENTS_FILENAME) }) {
    ensureDir(storagePath)
    ensureParentDir(trustedClientsPath)
    return new TrustedClients({ storagePath, trustedClientsPath, data: readStore(trustedClientsPath) })
  }

  async persist() {
    this.data.updatedAt = Date.now()
    ensureParentDir(this.trustedClientsPath)
    writeFileSync(this.trustedClientsPath, JSON.stringify(this.data, null, 2))
  }

  has(key) {
    const normalized = normalizeClientKey(key)
    return Boolean(normalized && this.data.clients[normalized])
  }

  /** All authorized client key hex strings. */
  keys() {
    return Object.keys(this.data.clients)
  }

  list() {
    return Object.values(this.data.clients).map((client) => ({ ...client }))
  }

  async add({ key, label = null } = {}) {
    const normalized = normalizeClientKey(key)
    if (!normalized) throw new Error('Trusted client key must be 64-char hex')
    const existing = this.data.clients[normalized]
    this.data.clients[normalized] = {
      key: normalized,
      label: (typeof label === 'string' && label.trim()) ? label.trim() : (existing?.label || null),
      addedAt: existing?.addedAt || Date.now()
    }
    await this.persist()
    return { ...this.data.clients[normalized] }
  }

  async remove(key) {
    const normalized = normalizeClientKey(key)
    if (!normalized || !this.data.clients[normalized]) return false
    delete this.data.clients[normalized]
    await this.persist()
    return true
  }
}

/**
 * Union of statically-configured trusted client keys and the persisted
 * allow-list. Used when the relay builds its blind-peer trusted set.
 */
export function mergeTrustedClientKeys(configuredKeys = [], persistedKeys = []) {
  const set = new Set()
  for (const key of [...(configuredKeys || []), ...(persistedKeys || [])]) {
    const normalized = normalizeClientKey(key)
    if (normalized) set.add(normalized)
  }
  return Array.from(set)
}
