import ReadyResource from 'ready-resource'
import HyperDB from 'hyperdb'
import Hyperblobs from 'hyperblobs'
import BlindPairing from 'blind-pairing'
import z32 from 'z32'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { fromHex } from './util.js'
import { CommentsChannel } from './comments-channel.js'
import { ReactionsManager } from './reactions.js'
import { WatchEventLogger } from '../recommendations/watch-events.js'
import { PublicChannelBee } from './public-channel-bee.js'
import { normalizeBlobRefInput } from '../blob-ref.js'
import channelDbDefinition from './channel-hyperdb-spec/hyperdb/index.js'

const CURRENT_SCHEMA_VERSION = 1
const VALID_WRITER_ROLES = new Set(['device', 'moderator', 'owner'])
const MAX_SAFE_RANGE = Number.MAX_SAFE_INTEGER

function toBuffer(value) {
  if (!value) return null
  if (b4a.isBuffer(value)) return value
  if (typeof value === 'string') return b4a.from(value, 'hex')
  return value
}

function cloneWithoutInternalVideoFields(value) {
  if (!value || typeof value !== 'object') return {}
  const { type, ...rest } = value
  return rest
}

function stripUndefined(obj) {
  const out = {}
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function makeCoreName(keyHex) {
  return `peartube-channel-hyperdb-${keyHex || 'default'}`
}

export class MultiWriterChannel extends ReadyResource {
  constructor(store, opts = {}) {
    super()
    this.store = store
    this.opts = opts
    this.swarm = opts.swarm || null


    this.blobs = null
    this._blobsCore = null
    this._channelDiscovery = null
    this.pairing = null
    this.pairingMember = null
    this.publicBee = null
    this.comments = null
    this.reactions = null
    this.watchLogger = null
    this.wakeupSession = null

    this._localWriterKey = null
    this._localWriterKeyHex = null
    this._lastVideoLogicalClock = 0
    this._localRateLimits = new Map()
    this._pairingSetupDone = false

    this.ready().catch(() => {})
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

  get encryptionKey() {
    return this.core?.encryptionKey || this.opts.encryptionKey || null
  }

  get writable() {
    return Boolean(this.core?.writable && this.db?.writable)
  }

  get localWriterKey() {
    return this._localWriterKey || this.key
  }

  get localWriterKeyHex() {
    return this._localWriterKeyHex || this.keyHex
  }

  get blobsKey() {
    return this._blobsCore?.key || null
  }

  get blobsKeyHex() {
    return this.blobsKey ? b4a.toString(this.blobsKey, 'hex') : null
  }

  get publicBeeKey() {
    return this.publicBee?.keyHex || null
  }

  async _open() {
    const bootstrapKey = toBuffer(this.opts.key)
    const keyPair = this.opts.keyPair || null
    const coreOpts = bootstrapKey
      ? { key: bootstrapKey, encryptionKey: toBuffer(this.opts.encryptionKey) }
      : keyPair
        ? { keyPair, encryptionKey: toBuffer(this.opts.encryptionKey) }
        : { name: makeCoreName(this.opts.name || 'default'), encryptionKey: toBuffer(this.opts.encryptionKey) }

    this.core = this.store.get(coreOpts)
    await this.core.ready()

    this.db = HyperDB.bee(this.core, channelDbDefinition, {
      autoUpdate: true,
      writable: this.core.writable !== false,
      extension: false
    })
    await this.db.ready()

    const writerKeyPair = keyPair || (typeof this.store.createKeyPair === 'function'
      ? await this.store.createKeyPair(`peartube-channel-writer-${this.keyHex}`)
      : null)
    this._localWriterKey = writerKeyPair?.publicKey || this.core.key
    this._localWriterKeyHex = this._localWriterKey ? b4a.toString(this._localWriterKey, 'hex') : this.keyHex

    await this._ensureBootstrapRecords()
    await this._openBlobs()
    await this._openPublicDb()

    this.comments = new CommentsChannel(this)
    this.reactions = new ReactionsManager(this)
    this.watchLogger = new WatchEventLogger(this)
  }

  async _ensureBootstrapRecords() {
    const now = Date.now()
    const meta = await this.getMetadata().catch(() => null)
    if (!meta) {
      await this.db.insert('@peartubeChannel/metadata', {
        key: 'meta',
        name: '',
        description: '',
        createdAt: now,
        createdBy: this.localWriterKeyHex,
        updatedAt: now,
        updatedBy: this.localWriterKeyHex,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        logicalClock: 0
      })
    }

    if (this.localWriterKeyHex) {
      const writer = await this.db.get('@peartubeChannel/writers', { keyHex: this.localWriterKeyHex })
      if (!writer) {
        await this.db.insert('@peartubeChannel/writers', {
          keyHex: this.localWriterKeyHex,
          role: 'owner',
          deviceName: '',
          addedAt: now,
          blobDriveKey: ''
        })
      }
    }

    await this.db.flush()
  }

  async _openBlobs() {
    const localWriterKey = this.localWriterKeyHex || 'default'
    const blobsCoreName = `peartube-blobs-${this.keyHex?.slice(0, 16)}-${localWriterKey.slice(0, 16)}`
    this._blobsCore = this.store.get({ name: blobsCoreName })
    await this._blobsCore.ready()
    this.blobs = new Hyperblobs(this._blobsCore)
  }

  async _openPublicDb() {
    if (!this.writable) return
    const existingMeta = await this.getMetadata().catch(() => null)
    const existingPublicBeeKey = existingMeta?.publicBeeKey || null
    const isValidPublicBeeKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k)

    this.publicBee = isValidPublicBeeKey(existingPublicBeeKey)
      ? new PublicChannelBee(this.store, { key: existingPublicBeeKey })
      : new PublicChannelBee(this.store, { name: `peartube-public-${this.keyHex}` })

    await this.publicBee.ready()

    if (this.swarm && this.publicBee.discoveryKey) {
      try {
        this.swarm.join(this.publicBee.discoveryKey)?.flushed?.().catch(() => {})
      } catch {
        // best effort
      }
    }

    if (this.publicBee.keyHex && existingMeta?.publicBeeKey !== this.publicBee.keyHex) {
      await this.updateMetadata({ publicBeeKey: this.publicBee.keyHex })
    }
    await this.syncToPublicBee()
  }

  async _close() {
    const closeResource = async (resource) => {
      if (!resource || typeof resource.close !== 'function') return
      try {
        await resource.close()
      } catch {
        // best effort
      }
    }
    const destroyResource = async (resource) => {
      if (!resource || typeof resource.destroy !== 'function') return
      try {
        await resource.destroy()
      } catch {
        // best effort
      }
    }

    if (this.wakeupSession) {
      await destroyResource(this.wakeupSession)
      await closeResource(this.wakeupSession)
      this.wakeupSession = null
    }
    if (this._channelDiscovery) {
      await destroyResource(this._channelDiscovery)
      await closeResource(this._channelDiscovery)
      this._channelDiscovery = null
    }
    if (this.publicBee) {
      await closeResource(this.publicBee)
      this.publicBee = null
    }
    if (this.pairingMember) {
      await closeResource(this.pairingMember)
      this.pairingMember = null
    }
    if (this.pairing) {
      await closeResource(this.pairing)
      this.pairing = null
    }
    if (this.blobs) this.blobs = null
    if (this._blobsCore) {
      await closeResource(this._blobsCore)
      this._blobsCore = null
    }
    if (this.db) {
      await closeResource(this.db)
      this.db = null
    }
    this.core = null
  }

  async _flush() {
    await this.db.flush()
  }

  async _update() {
    this.db?.update?.()
  }

  _checkLocalRateLimit(writerKeyHex) {
    const now = Date.now()
    const windowMs = 60 * 1000
    const maxOpsPerWindow = 100
    const prev = this._localRateLimits.get(writerKeyHex)
    if (!prev || now - prev.windowStartMs >= windowMs) {
      this._localRateLimits.set(writerKeyHex, { count: 1, windowStartMs: now })
      return
    }
    if (prev.count >= maxOpsPerWindow) throw new Error('Rate limit exceeded (local)')
    prev.count++
  }

  async appendOp(op) {
    if (!op?.type) return null
    switch (op.type) {
      case 'update-channel': return this.updateMetadata(op)
      case 'add-video': return this.addVideo(op)
      case 'update-video': return this.updateVideo(op.id, op)
      case 'delete-video': return this.deleteVideo(op.id)
      case 'add-writer': return this.addWriter(op)
      case 'upsert-writer': return this.ensureLocalBlobDrive({ deviceName: op.deviceName || '' })
      case 'remove-writer': return this.removeWriter(op)
      case 'add-comment': return this.comments.addComment(op.videoId, op.text, op.parentId, op)
      case 'hide-comment': return this.comments.hideComment(op.videoId, op.commentId, op)
      case 'remove-comment': return this.comments.removeComment(op.videoId, op.commentId, op)
      case 'add-reaction': return this.reactions.addReaction(op.videoId, op.reactionType, op)
      case 'remove-reaction': return this.reactions.removeReaction(op.videoId, op)
      case 'log-watch-event': return this.addWatchEvent(op)
      case 'add-vector-index': return this.addVectorIndex(op)
      default: return null
    }
  }

  async getMetadata() {
    await this._update()
    const meta = await this.db.get('@peartubeChannel/metadata', { key: 'meta' })
    if (meta && !meta.schemaVersion) meta.schemaVersion = CURRENT_SCHEMA_VERSION
    return meta || null
  }

  async updateMetadata(updates = {}) {
    if (!this.writable) throw new Error('Channel is not writable')
    const patch = updates && typeof updates === 'object' ? updates : {}
    const currentMeta = await this.getMetadata().catch(() => null)
    const nextClock = Math.max((currentMeta?.logicalClock || 0) + 1, patch.logicalClock || 0)
    const now = Date.now()
    const meta = stripUndefined({
      ...(currentMeta || {}),
      key: 'meta',
      name: 'name' in patch ? patch.name : currentMeta?.name || '',
      description: 'description' in patch ? patch.description : currentMeta?.description || '',
      avatar: 'avatar' in patch ? patch.avatar : currentMeta?.avatar || null,
      publicBeeKey: patch.publicBeeKey || currentMeta?.publicBeeKey || this.publicBee?.keyHex || null,
      commentsDbKey: patch.commentsDbKey || currentMeta?.commentsDbKey || this.keyHex || null,
      commentsAdminKey: patch.commentsAdminKey || currentMeta?.commentsAdminKey || null,
      createdAt: 'createdAt' in patch ? patch.createdAt : (currentMeta?.createdAt || now),
      createdBy: 'createdBy' in patch ? patch.createdBy : (currentMeta?.createdBy || this.localWriterKeyHex),
      updatedAt: patch.updatedAt || now,
      updatedBy: patch.updatedBy || this.localWriterKeyHex,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      logicalClock: nextClock
    })
    await this.db.insert('@peartubeChannel/metadata', meta)
    await this._flush()

    if (this.publicBee?.writable) {
      const publicPatch = {}
      for (const key of ['name', 'description', 'avatar', 'createdAt', 'createdBy', 'commentsDbKey']) {
        if (key in meta) publicPatch[key] = meta[key]
      }
      await this.publicBee.setMetadata(publicPatch).catch((err) => {
        console.log('[Channel] updateMetadata public sync error (non-fatal):', err?.message)
      })
    }
  }

  async listWriters() {
    await this._update()
    return this.db.find('@peartubeChannel/writers', {}).toArray()
  }

  async _getWriter(keyHex) {
    if (!keyHex) return null
    await this._update()
    return this.db.get('@peartubeChannel/writers', { keyHex })
  }

  async _isLocalPrivileged() {
    const writer = await this._getWriter(this.localWriterKeyHex)
    return !writer || writer.role === 'owner' || writer.role === 'moderator'
  }

  async ensureLocalBlobDrive({ deviceName = '' } = {}) {
    if (!this.localWriterKeyHex) throw new Error('Channel not ready')
    if (!this.blobs) throw new Error('Blobs not initialized')
    const existing = await this._getWriter(this.localWriterKeyHex)
    await this.db.insert('@peartubeChannel/writers', {
      ...(existing || {}),
      keyHex: this.localWriterKeyHex,
      role: existing?.role || 'owner',
      deviceName: deviceName || existing?.deviceName || '',
      addedAt: existing?.addedAt || Date.now(),
      updatedAt: Date.now(),
      blobDriveKey: this.blobsKeyHex || existing?.blobDriveKey || ''
    })
    await this._flush()
    return this.blobsKeyHex
  }

  async addWriter({ keyHex, role = 'device', deviceName = '' }) {
    if (!keyHex) throw new Error('Writer key required')
    if (!VALID_WRITER_ROLES.has(role)) throw new Error(`Invalid role: ${role}. Must be one of: ${[...VALID_WRITER_ROLES].join(', ')}`)
    const localWriter = await this._getWriter(this.localWriterKeyHex)
    if (localWriter && localWriter.role !== 'owner') throw new Error('Only owners can add writers')
    await this.db.insert('@peartubeChannel/writers', {
      keyHex,
      role,
      deviceName,
      addedAt: Date.now(),
      blobDriveKey: ''
    })
    await this._flush()
  }

  async removeWriter({ keyHex, ban = false }) {
    const localWriter = await this._getWriter(this.localWriterKeyHex)
    if (localWriter && localWriter.role !== 'owner') throw new Error('Only owners can remove writers')
    if (keyHex === this.localWriterKeyHex) throw new Error('Cannot remove yourself')
    if (ban) {
      const existing = await this._getWriter(keyHex)
      await this.db.insert('@peartubeChannel/writers', {
        ...(existing || { keyHex }),
        removedAt: Date.now(),
        banned: true
      })
    } else {
      await this.db.delete('@peartubeChannel/writers', { keyHex })
    }
    await this._flush()
  }

  _toPublicVideoMeta(value) {
    const { schemaVersion, logicalClock, ...rest } = cloneWithoutInternalVideoFields(value)
    return rest
  }

  _nextVideoLogicalClock() {
    const now = Date.now()
    const next = Math.max(this._lastVideoLogicalClock + 1, now)
    this._lastVideoLogicalClock = next
    return next
  }

  async listVideos() {
    await this._update()
    return this.db.find('@peartubeChannel/videos-by-uploaded-at', {}, { reverse: true }).toArray()
  }

  async getVideo(id) {
    if (!id) return null
    await this._update()
    return this.db.get('@peartubeChannel/videos', { id })
  }

  async addVideo(meta) {
    const id = meta.id
    if (!id) throw new Error('Video id required')
    const nextClock = this._nextVideoLogicalClock()
    const videoMeta = stripUndefined({
      ...cloneWithoutInternalVideoFields(meta),
      id,
      title: typeof meta.title === 'string' ? meta.title : String(meta.title ?? ''),
      description: typeof meta.description === 'string' ? meta.description : '',
      uploadedAt: meta.uploadedAt || Date.now(),
      uploadedBy: meta.uploadedBy || this.localWriterKeyHex,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      logicalClock: nextClock
    })
    await this.db.insert('@peartubeChannel/videos', videoMeta)
    await this._flush()
    if (this.publicBee?.writable) await this.publicBee.putVideo(id, this._toPublicVideoMeta(videoMeta)).catch(() => {})
  }

  async updateVideo(id, updates) {
    if (!id) throw new Error('Video id required')
    const existing = await this.getVideo(id)
    if (!existing) throw new Error('Video not found: ' + id)
    const nextClock = this._nextVideoLogicalClock()
    const videoMeta = stripUndefined({
      ...existing,
      ...cloneWithoutInternalVideoFields(updates),
      id,
      updatedAt: updates.updatedAt || Date.now(),
      updatedBy: updates.updatedBy || this.localWriterKeyHex,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      logicalClock: nextClock
    })
    await this.db.insert('@peartubeChannel/videos', videoMeta)
    await this._flush()
    if (this.publicBee?.writable) await this.publicBee.putVideo(id, this._toPublicVideoMeta(videoMeta)).catch(() => {})
  }

  async deleteVideo(id) {
    if (!this.writable) throw new Error('Channel is not writable')
    await this.db.delete('@peartubeChannel/videos', { id })
    await this._flush()
    if (this.publicBee?.writable) await this.publicBee.deleteVideo(id).catch(() => {})
  }

  async syncToPublicBee() {
    if (!this.publicBee?.writable) return
    await this.publicBee.syncFromChannel(this)
  }

  async putBlob(data) {
    if (!this.blobs) throw new Error('Blobs not initialized')
    const id = await this.blobs.put(data)
    return { id: `${id.blockOffset}:${id.blockLength}:${id.byteOffset}:${id.byteLength}`, ...id }
  }

  async getBlob(blobId) {
    if (!this.blobs) throw new Error('Blobs not initialized')
    const id = normalizeBlobRefInput(blobId)
    if (!id) throw new Error('Invalid blob ID format')
    try { return await this.blobs.get(id) } catch { return null }
  }

  createBlobReadStream(blobId, opts = {}) {
    if (!this.blobs) throw new Error('Blobs not initialized')
    const id = normalizeBlobRefInput(blobId)
    if (!id) throw new Error('Invalid blob ID format')
    return this.blobs.createReadStream(id, opts)
  }

  async getBlobEntry(video) {
    if (!video?.blobId) return null
    const id = normalizeBlobRefInput(video.blobId)
    if (!id) return null
    let blobsKey = this._blobsCore?.key
    if (video.blobsCoreKey && video.blobsCoreKey !== this.blobsKeyHex) {
      try {
        const remoteBlobsCore = this.store.get(b4a.from(video.blobsCoreKey, 'hex'))
        await remoteBlobsCore.ready()
        blobsKey = remoteBlobsCore.key
      } catch { return null }
    }
    if (!blobsKey) return null
    return { blobId: id, blobsKey, byteLength: id.byteLength }
  }

  async createInvite({ expires = 0 } = {}) {
    if (this.swarm) this.setupPairing(this.swarm).catch(() => {})
    await this._update()
    const current = await this.db.findOne('@peartubeChannel/invites', { gte: { idHex: '' } })
    if (current?.current && current?.inviteZ32) return current.inviteZ32
    const inv = BlindPairing.createInvite(this.key, { expires })
    const invite = {
      idHex: b4a.toString(inv.id, 'hex'),
      inviteZ32: z32.encode(inv.invite),
      publicKeyHex: b4a.toString(inv.publicKey, 'hex'),
      expires,
      createdAt: Date.now(),
      current: true
    }
    await this.db.insert('@peartubeChannel/invites', invite)
    await this._flush()
    return invite.inviteZ32
  }

  async clearInvite() {
    const invites = await this.db.find('@peartubeChannel/invites', {}).toArray()
    for (const inv of invites) await this.db.delete('@peartubeChannel/invites', { idHex: inv.idHex })
    await this._flush()
  }

  async setupPairing(swarm) {
    if (!swarm || this._pairingSetupDone) return
    this._pairingSetupDone = true
    this.swarm = swarm
    if (this.discoveryKey) {
      try {
        this._channelDiscovery = swarm.join(this.discoveryKey)
        this._channelDiscovery?.flushed?.().catch(() => {})
      } catch {
        // best effort
      }
    }
    if (!this.writable) return
    this.pairing = new BlindPairing(swarm)
    this.pairingMember = this.pairing.addMember({
      discoveryKey: this.discoveryKey,
      onadd: async (req) => {
        try {
          const invites = await this.db.find('@peartubeChannel/invites', {}).toArray()
          const inv = invites.find((candidate) => candidate.current)
          if (!inv) return
          if (inv.expires > 0 && Date.now() > inv.expires) {
            await this.db.delete('@peartubeChannel/invites', { idHex: inv.idHex })
            await this._flush()
            return
          }
          const candidateIdHex = b4a.toString(req.inviteId, 'hex')
          if (candidateIdHex !== inv.idHex) return
          const userData = req.open(fromHex(inv.publicKeyHex))
          const newWriterKeyHex = b4a.toString(userData, 'hex')
          await this.addWriter({ keyHex: newWriterKeyHex, role: 'device', deviceName: '' })
          req.confirm({ key: this.key, encryptionKey: this.encryptionKey })
          await this.db.delete('@peartubeChannel/invites', { idHex: inv.idHex })
          await this._flush()
        } catch (err) {
          console.error('[Channel] Pairing error:', err)
        }
      }
    })
  }

  async waitForPeerConnection(timeoutMs = 30000) {
    if (!this.swarm) return false
    if (this.discoveryKey) {
      try {
        const discovery = this.swarm.join(this.discoveryKey)
        this._channelDiscovery = discovery
        await discovery.flushed()
      } catch {
        // best effort
      }
    }
    if (this.swarm?.connections?.size > 0) return true
    return new Promise((resolve) => {
      const start = Date.now()
      const checkInterval = setInterval(() => {
        const connCount = this.swarm?.connections?.size || 0
        if (connCount > 0) {
          clearInterval(checkInterval)
          resolve(true)
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(checkInterval)
          resolve(false)
        }
      }, 500)
    })
  }

  async waitForInitialSync(opts = {}) {
    const { peerTimeout = 30000, dataTimeout = 20000, onProgress = () => {} } = opts
    onProgress('connecting', { message: 'Looking for peers...' })
    const peerConnected = await this.waitForPeerConnection(peerTimeout)
    if (!peerConnected) {
      onProgress('offline', { message: 'No peers found. Original device may be offline.' })
      return { success: false, videoCount: 0, state: 'offline' }
    }
    onProgress('syncing', { message: 'Connected! Syncing data...', peerCount: this.swarm?.connections?.size || 0 })
    const start = Date.now()
    while (Date.now() - start < dataTimeout) {
      await this.core.update({ wait: true, timeout: 2000 }).catch(() => {})
      this.db.update?.()
      const videos = await this.listVideos()
      if (videos.length > 0) {
        onProgress('synced', { videoCount: videos.length })
        return { success: true, videoCount: videos.length, state: 'synced' }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    const videos = await this.listVideos()
    if (videos.length > 0) return { success: true, videoCount: videos.length, state: 'synced' }
    onProgress('failed', { message: 'Sync timeout - no videos received yet' })
    return { success: false, videoCount: 0, state: 'failed' }
  }

  async addWatchEvent(event) {
    const eventId = event.eventId || b4a.toString(crypto.randomBytes(16), 'hex')
    await this.db.insert('@peartubeChannel/watchEvents', stripUndefined({
      ...event,
      eventId,
      videoId: event.videoId,
      channelKey: event.channelKey || this.keyHex,
      timestamp: event.timestamp || Date.now()
    }))
    await this._flush()
    return { success: true, eventId }
  }

  async listWatchEvents(videoId = null) {
    await this._update()
    if (!videoId) return this.db.find('@peartubeChannel/watchEvents', {}).toArray()
    return this.db.find('@peartubeChannel/watch-events-by-video-timestamp', {
      gte: { videoId },
      lte: { videoId, timestamp: MAX_SAFE_RANGE }
    }).toArray()
  }

  async addVectorIndex(record) {
    if (!record?.videoId) throw new Error('videoId required')
    await this.db.insert('@peartubeChannel/vectorIndexes', {
      videoId: record.videoId,
      vector: record.vector || '',
      text: record.text || '',
      metadata: record.metadata || '',
      indexedAt: record.indexedAt || Date.now()
    })
    await this._flush()
    return { success: true }
  }
}
