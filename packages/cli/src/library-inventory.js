import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from '#fs'
import { LIBRARY_ITEM_STATES } from './constants.js'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function ensureParentDir(path) {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (separatorIndex > 0) mkdirSync(path.slice(0, separatorIndex), { recursive: true })
}

function emptyInventory() {
  return {
    version: 1,
    updatedAt: 0,
    items: {},
    confirmedFolders: {}
  }
}

function readInventory(path) {
  if (!existsSync(path)) return emptyInventory()

  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // File vanished / permission race between existsSync and read.
    return emptyInventory()
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    // Corrupt (e.g. torn write from a crash). Quarantine it for forensics
    // rather than crash-looping startup, and start from a clean slate.
    try { renameSync(path, `${path}.corrupt-${raw.length}`) } catch { /* best effort */ }
    return emptyInventory()
  }

  if (!data || typeof data !== 'object') return emptyInventory()
  if (!data.items || typeof data.items !== 'object') data.items = {}
  if (!data.confirmedFolders || typeof data.confirmedFolders !== 'object') data.confirmedFolders = {}
  return data
}

function readConfirmedFolders(path) {
  if (!existsSync(path)) return {}
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return data && typeof data.confirmedFolders === 'object' && data.confirmedFolders ? data.confirmedFolders : {}
  } catch {
    return {}
  }
}

export class LibraryInventory {
  constructor({ inventoryPath, data, nowFn = Date.now }) {
    this.inventoryPath = inventoryPath
    this.data = data
    this.nowFn = nowFn
  }

  static async open({ inventoryPath, nowFn = Date.now }) {
    ensureParentDir(inventoryPath)
    const data = readInventory(inventoryPath)
    return new LibraryInventory({ inventoryPath, data, nowFn })
  }

  async persist() {
    this.data.updatedAt = this.nowFn()
    ensureParentDir(this.inventoryPath)
    // Confirmations may have been written by a separate process (the CLI
    // `library confirm` command opens its own instance). Merge the on-disk
    // set in before we overwrite, so a running service never erases an
    // out-of-band confirmation. Confirmations are add-only, so union is safe.
    const onDisk = readConfirmedFolders(this.inventoryPath)
    this.data.confirmedFolders = { ...onDisk, ...this.data.confirmedFolders }
    // Atomic write: serialize to a temp sibling then rename over the target so
    // a crash mid-write can never leave a half-written (unparseable) file.
    const tmpPath = `${this.inventoryPath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(this.data, null, 2))
    renameSync(tmpPath, this.inventoryPath)
  }

  // Re-read just the confirmation set from disk so a long-running service
  // picks up an out-of-band `library confirm` on its next scan without a
  // restart.
  reloadConfirmedFolders() {
    this.data.confirmedFolders = { ...this.data.confirmedFolders, ...readConfirmedFolders(this.inventoryPath) }
    return this.data.confirmedFolders
  }

  getItem(filePath) {
    const item = this.data.items[filePath]
    return item ? clone(item) : null
  }

  getItems() {
    return Object.values(this.data.items).map((item) => clone(item))
  }

  getItemsForChannel(channelKey) {
    return this.getItems().filter((item) => item.channelKey === channelKey)
  }

  findItems(target) {
    const value = String(target || '').trim()
    if (!value) return []
    return this.getItems().filter((item) =>
      item.videoId === value ||
      item.channelKey === value ||
      item.path === value ||
      (value.endsWith('/') ? item.path.startsWith(value) : item.path.startsWith(`${value}/`))
    )
  }

  async upsertItem(record) {
    if (!record?.path) throw new Error('inventory items require a path')
    const existing = this.data.items[record.path] || {}
    const state = record.state || existing.state || 'imported'
    if (!LIBRARY_ITEM_STATES.includes(state)) {
      throw new Error(`Invalid library item state "${state}"`)
    }
    this.data.items[record.path] = {
      ...existing,
      ...record,
      state,
      updatedAt: this.nowFn()
    }
    await this.persist()
    return this.getItem(record.path)
  }

  async setState(filePath, state, extra = {}) {
    const existing = this.data.items[filePath]
    if (!existing) return null
    return this.upsertItem({ ...existing, ...extra, path: filePath, state })
  }

  // Seed for createLocalDriveMirrorState(): every known item (including
  // unseeded ones) keeps its fingerprint so a rescan never silently
  // re-imports something the operator deliberately withdrew.
  seenEntries() {
    return Object.values(this.data.items)
      .filter((item) => item.fingerprint)
      .map((item) => [item.path, {
        fingerprint: item.fingerprint,
        previewVideo: item.state === 'unseeded' || item.state === 'unseeding' ? null : (item.previewVideo || null),
        channelKey: item.channelKey || null,
        publicBeeKey: item.publicBeeKey || null,
        sourceIdentity: item.sourceIdentity || null
      }])
  }

  isFolderConfirmed(folderPath) {
    return Boolean(this.data.confirmedFolders[folderPath])
  }

  async confirmFolder(folderPath) {
    const path = String(folderPath || '').trim()
    if (!path) throw new Error('folder path is required')
    this.data.confirmedFolders[path] = { confirmedAt: this.nowFn() }
    await this.persist()
    return { path, ...this.data.confirmedFolders[path] }
  }

  summary() {
    const counts = {}
    for (const state of LIBRARY_ITEM_STATES) counts[state] = 0
    let totalBytes = 0
    for (const item of Object.values(this.data.items)) {
      if (counts[item.state] !== undefined) counts[item.state] += 1
      if (item.state !== 'unseeded') totalBytes += Number(item.bytes) || 0
    }
    return {
      total: Object.keys(this.data.items).length,
      counts,
      totalBytes
    }
  }
}
