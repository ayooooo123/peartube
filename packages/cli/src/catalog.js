import { existsSync, mkdirSync, readFileSync, writeFileSync } from '#fs'
import { join } from '#path'
import { RELAY_CATALOG_FILENAME } from './constants.js'

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

function readCatalog(path) {
  if (!existsSync(path)) {
    return {
      version: 1,
      updatedAt: Date.now(),
      channels: {}
    }
  }

  return JSON.parse(readFileSync(path, 'utf8'))
}

function buildReviewItem(channel) {
  const moderation = channel?.moderation || {}
  const channelKey = channel.channelKey || channel.driveKey
  const targetType = moderation.targetType || 'channelKey'
  const target = moderation.target || channelKey

  return {
    id: `channel:${channelKey}`,
    targetType,
    target,
    channelKey,
    ownerKey: channel.ownerKey || null,
    publicBeeKey: channel.publicBeeKey || null,
    state: moderation.state || moderation.action || 'review',
    action: moderation.action || null,
    reason: moderation.reason || null,
    source: channel.source || null,
    retentionClass: channel.retentionClass || null,
    bytes: Number(channel.bytes || 0) || 0,
    videoCount: Number(channel.videoCount || channel.videosDownloaded || channel.videosFound || 0) || 0,
    matchedAt: Number(moderation.matchedAt || 0) || null,
    lastSeenAt: Number(channel.lastSeenAt || 0) || null,
    lastDecisionReason: channel.lastDecisionReason || null
  }
}

export class RelayCatalog {
  constructor({ storagePath, catalogPath, data }) {
    this.storagePath = storagePath
    this.catalogPath = catalogPath
    this.data = data
  }

  static async open({ storagePath, catalogPath = join(storagePath, RELAY_CATALOG_FILENAME) }) {
    ensureDir(storagePath)
    ensureParentDir(catalogPath)
    const data = readCatalog(catalogPath)
    return new RelayCatalog({ storagePath, catalogPath, data })
  }

  async persist() {
    this.data.updatedAt = Date.now()
    ensureParentDir(this.catalogPath)
    writeFileSync(this.catalogPath, JSON.stringify(this.data, null, 2))
  }

  getChannel(channelKey) {
    const channel = this.data.channels[channelKey]
    return channel ? clone(channel) : null
  }

  getChannels() {
    return Object.values(this.data.channels).map((channel) => clone(channel))
  }

  getOwnerCounts() {
    const counts = new Map()

    for (const channel of Object.values(this.data.channels)) {
      if (!channel?.ownerKey) continue
      counts.set(channel.ownerKey, (counts.get(channel.ownerKey) || 0) + 1)
    }

    return counts
  }

  async upsertChannel(record) {
    const existing = this.data.channels[record.channelKey] || {}
    this.data.channels[record.channelKey] = {
      ...existing,
      ...record,
      admittedAt: existing.admittedAt || record.admittedAt || Date.now()
    }
    await this.persist()
    return this.getChannel(record.channelKey)
  }

  async removeChannel(channelKey) {
    delete this.data.channels[channelKey]
    await this.persist()
  }

  getSummary() {
    const channels = this.getChannels()
    let usedBytes = 0
    let protectedChannels = 0

    for (const channel of channels) {
      usedBytes += Number(channel.bytes) || 0
      if (channel.retentionClass === 'private' || channel.retentionClass === 'allowlist') {
        protectedChannels += 1
      }
    }

    return {
      totalChannels: channels.length,
      protectedChannels,
      usedBytes
    }
  }

  getModerationSummary() {
    let quarantinedChannels = 0

    for (const channel of Object.values(this.data.channels)) {
      if (channel?.moderation?.state === 'quarantined') {
        quarantinedChannels += 1
      }
    }

    return { quarantinedChannels }
  }

  getReviewQueue() {
    const reviewStates = new Set(['quarantined', 'watched'])
    return Object.values(this.data.channels)
      .filter((channel) => reviewStates.has(channel?.moderation?.state))
      .map(buildReviewItem)
      .sort((left, right) => (left.matchedAt || left.lastSeenAt || 0) - (right.matchedAt || right.lastSeenAt || 0))
      .map((item) => clone(item))
  }
}
