import { randomBytes } from 'node:crypto'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import HypercoreBlobServer from 'hypercore-blob-server'

import {
  createProfileRecord,
  createVideoRecord,
  videoRecordPath,
  videoSourcePath,
  videoThumbnailPath
} from './schema.mjs'
import { createDriveDiscoveryNetwork } from './network.mjs'

export async function createEngine({ storagePath, name = 'PearTube User', channelKey = null }) {
  if (!storagePath) throw new Error('storagePath is required')

  const store = new Corestore(storagePath)
  const key = channelKey ? Buffer.from(channelKey, 'hex') : undefined
  const drive = key ? new Hyperdrive(store, key) : new Hyperdrive(store)
  await drive.ready()

  const resolvedChannelKey = b4a.toString(drive.key, 'hex')
  if (!channelKey) {
    const existingProfile = await readJsonFromDrive(drive, '/profile.json')
    if (!existingProfile) {
      await putJson(drive, '/profile.json', createProfileRecord({ channelKey: resolvedChannelKey, name }))
    }
  }

  return new PearTubeEngine({ store, drive, channelKey: resolvedChannelKey })
}

export class PearTubeEngine {
  constructor({ store, drive, channelKey }) {
    this.store = store
    this.drive = drive
    this.channelKey = channelKey
    this.blobServer = null
    this.network = null
  }

  async readJson(filename) {
    return readJsonFromDrive(this.drive, filename)
  }

  async writeVideo({
    id = createVideoId(),
    title,
    description = '',
    bytes,
    mimeType = 'video/mp4',
    category = '',
    duration = 0,
    width = 0,
    height = 0,
    thumbnail = null,
    createdAt = Date.now()
  }) {
    if (!bytes) throw new Error('bytes are required')

    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const filename = videoSourcePath(id)
    const record = createVideoRecord({
      channelKey: this.channelKey,
      id,
      title,
      description,
      filename,
      byteLength: buffer.length,
      mimeType,
      category,
      duration,
      width,
      height,
      thumbnail,
      createdAt
    })

    await this.drive.put(filename, buffer)
    await putJson(this.drive, videoRecordPath(id), record)
    return record
  }

  async writeVideoFile(filePath, options = {}) {
    const { readFile } = await import('node:fs/promises')
    const bytes = await readFile(filePath)
    return this.writeVideo({
      ...options,
      bytes,
      mimeType: options.mimeType || detectMimeType(bytes)
    })
  }

  async getVideo(id) {
    return this.readJson(videoRecordPath(id))
  }

  async updateVideo(id, updates = {}) {
    const existing = await this.getVideo(id)
    if (!existing) throw new Error(`video not found: ${id}`)

    const next = {
      ...existing,
      ...updates,
      id: existing.id,
      channelKey: existing.channelKey,
      filename: existing.filename,
      byteLength: existing.byteLength,
      size: existing.byteLength,
      mimeType: updates.mimeType || existing.mimeType,
      createdAt: existing.createdAt,
      uploadedAt: existing.uploadedAt
    }

    await putJson(this.drive, videoRecordPath(id), next)
    return next
  }

  async deleteVideo(id) {
    const existing = await this.getVideo(id)
    if (!existing) return false
    await this.drive.del(videoRecordPath(id))
    return true
  }

  async setVideoThumbnail(id, { bytes, mimeType = 'image/jpeg' }) {
    if (!bytes) throw new Error('thumbnail bytes are required')
    const existing = await this.getVideo(id)
    if (!existing) throw new Error(`video not found: ${id}`)

    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const thumbnail = videoThumbnailPath(id)
    await this.drive.put(thumbnail, buffer, { metadata: { mimeType } })

    return this.updateVideo(id, {
      thumbnail,
      thumbnailMimeType: mimeType,
      thumbnailByteLength: buffer.length
    })
  }

  async thumbnailUrl(id) {
    const record = await this.getVideo(id)
    if (!record?.thumbnail) throw new Error(`thumbnail not found: ${id}`)
    const server = await this.getBlobServer()
    return server.getLink(this.drive.key, {
      filename: record.thumbnail,
      type: record.thumbnailMimeType || 'application/octet-stream'
    })
  }

  async listVideos() {
    const records = []

    for await (const entry of this.drive.list('/videos')) {
      if (!entry.key.endsWith('/video.json')) continue
      const record = await this.readJson(entry.key)
      if (record) records.push(record)
    }

    return records.sort((a, b) => b.createdAt - a.createdAt)
  }

  async readVideoBytes(id) {
    const bytes = await this.drive.get(videoSourcePath(id))
    if (!bytes) throw new Error('video source not found')
    return bytes
  }

  async getBlobServer() {
    if (!this.blobServer) {
      this.blobServer = new HypercoreBlobServer(this.store, { port: 0, host: '127.0.0.1' })
      await this.blobServer.listen()
    }
    return this.blobServer
  }

  async getVideoUrl(id) {
    const server = await this.getBlobServer()
    return server.getLink(this.drive.key, {
      filename: videoSourcePath(id),
      type: 'video/mp4'
    })
  }

  startDiscovery({ swarm, announce = false, lookup = true, onConnectionError = null } = {}) {
    if (this.network) return this.network
    this.network = createDriveDiscoveryNetwork({
      store: this.store,
      channelKey: this.channelKey,
      swarm,
      announce,
      lookup,
      onConnectionError
    })
    return this.network
  }

  async close() {
    if (this.network) {
      await this.network.close().catch(() => {})
      this.network = null
    }
    if (this.blobServer) await this.blobServer.close().catch(() => {})
    await this.drive.close().catch(() => {})
    await this.store.close().catch(() => {})
  }
}

async function readJsonFromDrive(drive, filename, opts) {
  const node = await drive.get(filename, opts)
  if (!node) return null
  return JSON.parse(Buffer.from(node).toString('utf8'))
}

function createVideoId() {
  return randomBytes(16).toString('hex')
}

function detectMimeType(bytes) {
  if (!bytes || bytes.length < 12) return 'video/mp4'

  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = Buffer.from(bytes.subarray(8, 12)).toString('utf8')
    if (brand.startsWith('qt')) return 'video/quicktime'
    if (brand.startsWith('3g')) return 'video/3gpp'
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') return 'video/x-m4v'
    return 'video/mp4'
  }

  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const header = Buffer.from(bytes.subarray(0, Math.min(64, bytes.length))).toString('utf8')
    if (header.includes('webm')) return 'video/webm'
    return 'video/x-matroska'
  }

  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'video/ogg'
  if (bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56) return 'video/x-flv'
  return 'video/mp4'
}

async function putJson(drive, filename, value) {
  await drive.put(filename, Buffer.from(JSON.stringify(value, null, 2)))
}
