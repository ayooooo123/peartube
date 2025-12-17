import ReadyResource from 'ready-resource'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import BlindPairing from 'blind-pairing'
import z32 from 'z32'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import { fromHex, toHex, prefixedKey } from './util.js'
import { validateOp } from './op-schemas.js'
import { CommentsChannel } from './comments-channel.js'
import { ReactionsManager } from './reactions.js'
import { WatchEventLogger } from '../recommendations/watch-events.js'
import { applyMigrations } from './migrations.js'

const CURRENT_SCHEMA_VERSION = 1

/**
 * MultiWriterChannel
 *
 * - Metadata is stored in Autobase (multi-writer)
 * - A deterministic Hyperbee view is derived from Autobase.apply()
 * - Each writer/device has its own blob Hyperdrive; videos reference blob locations in metadata.
 */
export class MultiWriterChannel extends ReadyResource {
  /**
   * @param {import('corestore')} store
   * @param {Object} [opts]
   * @param {Buffer|string|null} [opts.key] Autobase bootstrap key (channel key)
   * @param {Buffer|string|null} [opts.encryptionKey] Autobase encryption key
   * @param {import('hyperswarm')|null} [opts.swarm] Hyperswarm instance for replication
   */
  constructor(store, opts = {}) {
    super()

    this.store = store
    this.opts = opts

    this.base = null
    this.view = null

    /** @type {Map<string, import('hyperdrive')>} */
    this.blobDrives = new Map()

    /** @type {import('hyperswarm')|null} */
    this.swarm = opts.swarm || null

    /** @type {BlindPairing|null} */
    this.pairing = null

    /** @type {any} */
    this.pairingMember = null

    /** @type {CommentsChannel|null} */
    this.comments = null

    /** @type {ReactionsManager|null} */
    this.reactions = null

    /** @type {WatchEventLogger|null} */
    this.watchLogger = null

    // Local-only rate limiting (must NOT affect deterministic view application).
    /** @type {Map<string, {count: number, windowStartMs: number}>} */
    this._localRateLimits = new Map()

    this.ready().catch(() => {})
  }

  get key() {
    return this.base?.key || null
  }

  get keyHex() {
    return this.key ? b4a.toString(this.key, 'hex') : null
  }

  get discoveryKey() {
    return this.base?.discoveryKey || null
  }

  get encryptionKey() {
    return this.base?.encryptionKey || null
  }

  get writable() {
    return Boolean(this.base?.writable)
  }

  get localWriterKey() {
    return this.base?.local?.key || null
  }

  get localWriterKeyHex() {
    return this.localWriterKey ? b4a.toString(this.localWriterKey, 'hex') : null
  }

  async _open() {
    const bootstrapKey = this.opts.key ? fromHex(this.opts.key) : null
    const encryptionKey = this.opts.encryptionKey ? fromHex(this.opts.encryptionKey) : null

    console.log('[Channel] _open: bootstrapKey:', bootstrapKey ? toHex(bootstrapKey).slice(0, 16) : 'new')

    console.log('[Channel] _open: creating Autobase instance...')
    this.base = new Autobase(this.store, bootstrapKey, {
      valueEncoding: 'json',
      // Encryption is optional. If you want private channels, pass an encryptionKey (and/or set encrypt: true).
      // Keeping this off by default preserves current PearTube behavior where channels are publicly readable.
      encrypt: Boolean(this.opts.encrypt),
      encryptionKey,
      open: (store) => {
        console.log('[Channel] open callback: creating Hyperbee view...')
        const core = store.get({ name: 'peartube-channel-view' })
        const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
        this.view = bee
        console.log('[Channel] open callback: view created')
        return bee
      },
      apply: async (nodes, view, host) => {
        console.log('[Channel] apply callback: processing', nodes.length, 'nodes')
        // Fully deterministic view updates. Side effects allowed only via `host.*` (Autobase system).
        for (const node of nodes) {
          const value = node.value
          if (!value) continue // ack/no-op
          await this._applyOp(value, view, host, node)
        }
        console.log('[Channel] apply callback: done')
      }
    })
    console.log('[Channel] _open: Autobase instance created')

    console.log('[Channel] _open: waiting for base.ready()...')
    const baseReadyStart = Date.now()
    await this.base.ready()
    console.log('[Channel] _open: base.ready() took', Date.now() - baseReadyStart, 'ms')

    console.log('[Channel] _open: waiting for view.ready()...')
    const viewReadyStart = Date.now()
    await this.view.ready()
    console.log('[Channel] _open: view.ready() took', Date.now() - viewReadyStart, 'ms')

    // Force apply any pending operations to the view
    console.log('[Channel] _open: calling base.update() to apply pending ops...')
    const updateStart = Date.now()
    await this.base.update()
    console.log('[Channel] _open: base.update() took', Date.now() - updateStart, 'ms')

    console.log('[Channel] _open complete: key:', this.keyHex?.slice(0, 16), 'writable:', this.writable, 'local length:', this.base.local?.length, 'view length:', this.view?.core?.length)

    // Initialize comments, reactions, and watch logger
    this.comments = new CommentsChannel(this)
    this.reactions = new ReactionsManager(this)
    this.watchLogger = new WatchEventLogger(this)
  }

  async _close() {
    // Remove connection handler to prevent memory leaks
    if (this._connectionHandler && this.swarm) {
      this.swarm.off('connection', this._connectionHandler)
      this._connectionHandler = null
    }

    // Close pairing resources
    if (this.pairingMember) {
      try { await this.pairingMember.close() } catch {}
      this.pairingMember = null
    }
    if (this.pairing) {
      try { await this.pairing.close() } catch {}
      this.pairing = null
    }

    for (const d of this.blobDrives.values()) {
      try { await d.close() } catch {}
    }
    this.blobDrives.clear()
    if (this.view) await this.view.close()
    if (this.base) await this.base.close()
  }

  async _applyOp(op, view, host, node) {
    // Set default schema version for backward compatibility
    const opSchemaVersion = op.schemaVersion !== undefined && op.schemaVersion !== null
      ? op.schemaVersion
      : 0 // Legacy ops have version 0

    // Migrate op if needed
    if (opSchemaVersion < CURRENT_SCHEMA_VERSION) {
      op = applyMigrations(op, opSchemaVersion, CURRENT_SCHEMA_VERSION)
    }

    // Validate op schema (after migration)
    const validation = validateOp(op)
    if (!validation.valid) {
      console.warn('[Channel] Invalid op:', validation.error, 'op:', op.type, 'skipping')
      return // Skip invalid ops to maintain forward compatibility
    }

    // ACL Enforcement: Verify op is from an authorized writer
    // Autobase already enforces this at the core level, but we can add additional checks
    const writerKeyHex = op.updatedBy || op.uploadedBy || op.authorKeyHex || op.moderatorKeyHex || null
    if (writerKeyHex) {
      const writer = await view.get(prefixedKey('writers', writerKeyHex)).catch(() => null)
      if (!writer?.value && op.type !== 'add-writer') {
        // Allow add-writer ops even if writer doesn't exist yet (for initial setup)
        console.warn('[Channel] Op from unauthorized writer:', writerKeyHex?.slice(0, 16), 'type:', op.type)
        // Note: Autobase will reject ops from non-writers, so this is mostly for logging
      }
    }

    // IMPORTANT: View application must be deterministic with respect to the op stream.
    // Do NOT use Date.now(), Math.random(), or local clocks here, and do NOT skip ops based on local time.
    // Rate limiting must happen on the mutator path (before append) or be derived purely from op data.

    // Content validation: Additional checks beyond schema validation
    if (op.type === 'add-video' || op.type === 'update-video') {
      // Validate blob pointers
      if (op.blobDriveKey && typeof op.blobDriveKey !== 'string') {
        console.warn('[Channel] Invalid blobDriveKey in op:', op.type)
        return
      }
      // Validate metadata size (prevent DoS)
      const metaSize = JSON.stringify(op).length
      if (metaSize > 100 * 1024) { // 100KB max
        console.warn('[Channel] Op metadata too large:', metaSize, 'bytes')
        return
      }
    }

    // Set default logical clock (Lamport timestamp) for conflict resolution
    // Use node index as logical clock (Autobase provides deterministic ordering)
    if (op.logicalClock === undefined || op.logicalClock === null) {
      op.logicalClock = node?.index || 0
    }

    switch (op.type) {
      case 'update-channel': {
        const key = prefixedKey('channel-meta', op.key || 'meta')
        const existing = await view.get(key).catch(() => null)
        const prev = existing?.value || {}

        // Conflict resolution: merge intelligently
        const merged = {
          key: op.key || 'meta',
          name: op.name !== undefined ? op.name : prev.name,
          description: op.description !== undefined ? op.description : (prev.description || ''),
          avatar: op.avatar !== undefined ? op.avatar : prev.avatar,
          updatedAt: op.updatedAt || prev.updatedAt || 0,
          updatedBy: op.updatedBy || prev.updatedBy || null,
          createdAt: prev.createdAt || op.createdAt || op.updatedAt || 0,
          createdBy: prev.createdBy || op.createdBy || op.updatedBy || null,
          logicalClock: op.logicalClock || 0
        }

        // Get writer priorities for conflict resolution
        const prevWriter = prev.updatedBy ? await view.get(prefixedKey('writers', prev.updatedBy)).catch(() => null) : null
        const currentWriter = op.updatedBy ? await view.get(prefixedKey('writers', op.updatedBy)).catch(() => null) : null

        const prevPriority = prevWriter?.value?.role === 'owner' ? 3 : prevWriter?.value?.role === 'moderator' ? 2 : 1
        const currentPriority = currentWriter?.value?.role === 'owner' ? 3 : currentWriter?.value?.role === 'moderator' ? 2 : 1

        // Prefer higher priority writer, then higher logical clock
        const shouldUseNew = currentPriority > prevPriority || 
          (currentPriority === prevPriority && (op.logicalClock || 0) > (prev.logicalClock || 0))

        if (!shouldUseNew && prev.name) {
          merged.name = prev.name
        }
        if (!shouldUseNew && prev.description) {
          merged.description = prev.description
        }
        if (!shouldUseNew && prev.avatar) {
          merged.avatar = prev.avatar
        }

        await view.put(key, merged)
        return
      }

      case 'add-video': {
        const key = prefixedKey('videos', op.id)
        const { type, ...rest } = op
        console.log('[Channel] _applyOp add-video:', op.id, 'blobDriveKey:', op.blobDriveKey?.slice(0, 16), 'key:', key)
        await view.put(key, rest)
        return
      }

      case 'update-video': {
        const key = prefixedKey('videos', op.id)
        const { type, logicalClock, schemaVersion, ...rest } = op
        const existing = await view.get(key).catch(() => null)
        const prev = existing?.value || {}

        // Conflict resolution: merge fields intelligently instead of overwriting
        // Prefer newer values (higher logical clock) but merge arrays/objects
        const merged = { ...prev }

        // Get writer priority for conflict resolution
        const prevWriter = prev.updatedBy ? await view.get(prefixedKey('writers', prev.updatedBy)).catch(() => null) : null
        const currentWriter = op.updatedBy ? await view.get(prefixedKey('writers', op.updatedBy)).catch(() => null) : null

        const prevPriority = prevWriter?.value?.role === 'owner' ? 3 : prevWriter?.value?.role === 'moderator' ? 2 : 1
        const currentPriority = currentWriter?.value?.role === 'owner' ? 3 : currentWriter?.value?.role === 'moderator' ? 2 : 1

        // Merge strategy: prefer higher priority writer, then higher logical clock
        const shouldUseNew = currentPriority > prevPriority || 
          (currentPriority === prevPriority && (op.logicalClock || 0) > (prev.logicalClock || 0))

        if (shouldUseNew) {
          // Use new values, but merge description intelligently
          if (rest.description && prev.description && rest.description !== prev.description) {
            // Keep both descriptions separated (or use newer)
            merged.description = rest.description
          }
          Object.assign(merged, rest)
          merged.logicalClock = op.logicalClock
          merged.updatedAt = op.updatedAt || prev.updatedAt || 0
          merged.updatedBy = op.updatedBy
        } else {
          // Keep existing, but update timestamp
          merged.updatedAt = Math.max(prev.updatedAt || 0, op.updatedAt || 0)
        }

        await view.put(key, merged)
        return
      }

      case 'delete-video': {
        const key = prefixedKey('videos', op.id)
        await view.del(key)
        return
      }

      case 'add-writer': {
        const keyHex = op.keyHex
        if (typeof keyHex === 'string' && host?.internal) {
          // Membership change must go through Autobase system (deterministic, replicated).
          await host.addWriter(fromHex(keyHex), { indexer: true })
        }
        await view.put(prefixedKey('writers', keyHex), {
          keyHex,
          role: op.role || 'device',
          deviceName: op.deviceName || '',
          addedAt: op.addedAt || 0,
          blobDriveKey: op.blobDriveKey || null
        })
        return
      }

      case 'upsert-writer': {
        const keyHex = op.keyHex
        const existing = await view.get(prefixedKey('writers', keyHex)).catch(() => null)
        const prev = existing?.value || null
        await view.put(prefixedKey('writers', keyHex), {
          keyHex,
          role: op.role || prev?.role || 'device',
          deviceName: op.deviceName ?? prev?.deviceName ?? '',
          addedAt: prev?.addedAt || op.addedAt || 0,
          blobDriveKey: op.blobDriveKey ?? prev?.blobDriveKey ?? null
        })
        return
      }

      case 'remove-writer': {
        const keyHex = op.keyHex
        if (typeof keyHex === 'string' && host?.internal) {
          await host.removeWriter(fromHex(keyHex))
        }
        await view.del(prefixedKey('writers', keyHex))
        return
      }

      case 'add-invite': {
        const idHex = op.idHex
        await view.put(prefixedKey('invites', idHex), {
          idHex,
          inviteZ32: op.inviteZ32,
          publicKeyHex: op.publicKeyHex,
          expires: op.expires || 0,
          createdAt: op.createdAt || 0
        })
        // Single active invite pointer (deterministic, derived from log)
        await view.put('invites/current', { idHex })
        return
      }

      case 'delete-invite': {
        const idHex = op.idHex
        await view.del(prefixedKey('invites', idHex))
        const cur = await view.get('invites/current').catch(() => null)
        if (cur?.value?.idHex === idHex) {
          await view.del('invites/current')
        }
        return
      }

      // Placeholder handlers for future phases (will be implemented in later phases)
      case 'add-vector-index': {
        const key = prefixedKey('vectors', op.videoId)
        await view.put(key, {
          videoId: op.videoId,
          vector: op.vector || null, // Base64 encoded vector
          text: op.text || '',
          metadata: op.metadata || null,
          indexedAt: op.indexedAt || 0
        })
        return
      }

      case 'add-comment': {
        const key = prefixedKey('comments', `${op.videoId}/${op.commentId}`)
        await view.put(key, {
          videoId: op.videoId,
          commentId: op.commentId,
          text: op.text,
          authorKeyHex: op.authorKeyHex,
          timestamp: op.timestamp || 0,
          parentId: op.parentId || null,
          hidden: false
        })
        return
      }

      case 'hide-comment': {
        const key = prefixedKey('comments', `${op.videoId}/${op.commentId}`)
        const existing = await view.get(key).catch(() => null)
        if (existing?.value) {
          await view.put(key, {
            ...existing.value,
            hidden: true,
            hiddenBy: op.moderatorKeyHex,
            hiddenAt: op.timestamp || 0
          })
        }
        return
      }

      case 'remove-comment': {
        const key = prefixedKey('comments', `${op.videoId}/${op.commentId}`)
        await view.del(key)
        return
      }

      case 'add-reaction': {
        const key = prefixedKey('reactions', `${op.videoId}/${op.authorKeyHex}`)
        await view.put(key, {
          videoId: op.videoId,
          reactionType: op.reactionType,
          authorKeyHex: op.authorKeyHex,
          timestamp: op.timestamp || 0
        })
        return
      }

      case 'remove-reaction': {
        const key = prefixedKey('reactions', `${op.videoId}/${op.authorKeyHex}`)
        await view.del(key)
        return
      }

      case 'log-watch-event': {
        // Deterministic key derived from op payload. Prefer eventId (unique, generated at append time).
        const eventId = op.eventId || String(op.timestamp || op.logicalClock || node?.index || 0)
        const key = prefixedKey('watch-events', `${op.videoId}/${eventId}`)
        await view.put(key, {
          videoId: op.videoId,
          channelKey: op.channelKey || null,
          watcherKeyHex: op.watcherKeyHex || null, // May be null for privacy
          duration: op.duration || 0,
          completed: op.completed || false,
          timestamp: op.timestamp || 0,
          eventId
        })
        return
      }

      case 'migrate-schema': {
        // Record schema migration in view
        const key = prefixedKey('schema-migrations', `${op.fromVersion}-${op.toVersion}`)
        await view.put(key, {
          fromVersion: op.fromVersion,
          toVersion: op.toVersion,
          migratedAt: op.migratedAt || 0,
          schemaVersion: op.schemaVersion
        })

        // Update current schema version in channel metadata
        const metaKey = prefixedKey('channel-meta', 'meta')
        const meta = await view.get(metaKey).catch(() => null)
        if (meta?.value) {
          await view.put(metaKey, {
            ...meta.value,
            schemaVersion: op.toVersion
          })
        }
        return
      }

      default: {
        // Unknown op: ignore to keep forward-compat. Older peers just skip new ops.
        return
      }
    }
  }

  // ----------------------------
  // Metadata API
  // ----------------------------

  async getMetadata() {
    const res = await this.view.get('channel-meta/meta').catch(() => null)
    const meta = res?.value || null
    // Ensure schema version is set
    if (meta && !meta.schemaVersion) {
      meta.schemaVersion = CURRENT_SCHEMA_VERSION
    }
    return meta
  }

  async updateMetadata({ name, description = '', avatar = null }) {
    // Get current logical clock from view
    const currentMeta = await this.getMetadata().catch(() => null)
    const nextClock = (currentMeta?.logicalClock || 0) + 1

    await this.appendOp({
      type: 'update-channel',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      logicalClock: nextClock,
      key: 'meta',
      name,
      description,
      avatar,
      updatedAt: Date.now(),
      updatedBy: this.localWriterKeyHex
    })
  }

  // ----------------------------
  // Writer / device
  // ----------------------------

  async listWriters() {
    const out = []
    for await (const { value } of this.view.createReadStream({ gt: 'writers/', lt: 'writers/\xff' })) {
      out.push(value)
    }
    return out
  }

  async ensureLocalBlobDrive({ deviceName = '' } = {}) {
    if (!this.localWriterKeyHex) throw new Error('Channel not ready')

    // Try to load existing writer record
    const existing = await this.view.get(prefixedKey('writers', this.localWriterKeyHex)).catch(() => null)
    const prev = existing?.value || null

    if (prev?.blobDriveKey) {
      await this._loadBlobDrive(prev.blobDriveKey)
      return prev.blobDriveKey
    }

    // Create a new per-device blob drive
    const drive = new Hyperdrive(this.store)
    await drive.ready()
    const driveKeyHex = b4a.toString(drive.key, 'hex')
    this.blobDrives.set(driveKeyHex, drive)

    // Persist writer record (does not affect membership, only metadata)
    await this.appendOp({
      type: 'upsert-writer',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      keyHex: this.localWriterKeyHex,
      deviceName,
      blobDriveKey: driveKeyHex
    })

    return driveKeyHex
  }

  async addWriter({ keyHex, role = 'device', deviceName = '' }) {
    // Validate role
    const validRoles = ['device', 'moderator', 'owner']
    if (!validRoles.includes(role)) {
      throw new Error(`Invalid role: ${role}. Must be one of: ${validRoles.join(', ')}`)
    }

    // Only owners can add moderators or other owners
    if (role === 'moderator' || role === 'owner') {
      const localWriter = await this.view.get(prefixedKey('writers', this.localWriterKeyHex)).catch(() => null)
      if (localWriter?.value?.role !== 'owner') {
        throw new Error('Only owners can add moderators or owners')
      }
    }

    await this.appendOp({
      type: 'add-writer',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      keyHex,
      role,
      deviceName,
      addedAt: Date.now()
    })
  }

  async removeWriter({ keyHex, ban = false }) {
    // Only owners can remove writers
    const localWriter = await this.view.get(prefixedKey('writers', this.localWriterKeyHex)).catch(() => null)
    if (localWriter?.value?.role !== 'owner') {
      throw new Error('Only owners can remove writers')
    }

    // Prevent removing yourself
    if (keyHex === this.localWriterKeyHex) {
      throw new Error('Cannot remove yourself')
    }

    await this.appendOp({
      type: 'remove-writer',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      keyHex,
      ban: Boolean(ban)
    })
  }

  // ----------------------------
  // Video operations
  // ----------------------------

  async listVideos() {
    // Ensure the view catches up to any newly replicated Autobase nodes.
    // (Some devices won't call base.update() elsewhere.)
    try {
      await Promise.race([
        this.base.update(),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ])
    } catch {}

    const out = []
    for await (const { value } of this.view.createReadStream({ gt: 'videos/', lt: 'videos/\xff' })) {
      out.push(value)
    }

    // Proactively join blob drives referenced by the latest metadata (helps replication + playback)
    if (this.swarm) {
      const seen = new Set()
      for (const v of out) {
        const dk = v?.blobDriveKey || v?.blobDrive || null
        if (dk && !seen.has(dk)) {
          seen.add(dk)
          this.joinBlobDrive(dk).catch(() => {})
        }
      }
    }

    // Sort newest first, consistent with existing UI expectations
    out.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
    return out
  }

  async getVideo(id) {
    const key = prefixedKey('videos', id)
    console.log('[Channel] getVideo:', id, 'key:', key)
    const res = await this.view.get(key).catch((err) => {
      console.error('[Channel] getVideo error:', err?.message)
      return null
    })
    console.log('[Channel] getVideo result:', res?.value?.id, 'blobDriveKey:', res?.value?.blobDriveKey?.slice(0, 16))
    return res?.value || null
  }

  async addVideo(meta) {
    const id = meta.id
    if (!id) throw new Error('Video id required')
    console.log('[Channel] addVideo:', id, 'blobDriveKey:', meta.blobDriveKey?.slice(0, 16))

    // Get next logical clock
    const videos = await this.listVideos().catch(() => [])
    const maxClock = Math.max(...videos.map(v => v.logicalClock || 0), 0)
    const nextClock = maxClock + 1

    await this.appendOp({
      type: 'add-video',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      logicalClock: nextClock,
      ...meta,
      uploadedAt: meta.uploadedAt || Date.now(),
      uploadedBy: meta.uploadedBy || this.localWriterKeyHex
    })
    // Wait for the view to be updated with our new entry
    await this.base.update()
    console.log('[Channel] addVideo appended and view updated')
  }

  async deleteVideo(id) {
    // Blob deletion is best-effort; the blob store may belong to another device.
    const v = await this.getVideo(id)
    await this.appendOp({
      type: 'delete-video',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id
    })
    if (v?.blobDriveKey && v?.path) {
      const d = await this._loadBlobDrive(v.blobDriveKey).catch(() => null)
      if (d) {
        try { await d.del(v.path) } catch {}
      }
    }
  }

  // ----------------------------
  // Blob resolution
  // ----------------------------

  async _loadBlobDrive(driveKeyHex) {
    if (this.blobDrives.has(driveKeyHex)) return this.blobDrives.get(driveKeyHex)
    const d = new Hyperdrive(this.store, fromHex(driveKeyHex))
    await d.ready()
    this.blobDrives.set(driveKeyHex, d)
    return d
  }

  async getBlobDrive(driveKeyHex) {
    return this._loadBlobDrive(driveKeyHex)
  }

  async getBlobEntry({ blobDriveKey, path }) {
    const drive = await this._loadBlobDrive(blobDriveKey)
    const entry = await drive.entry(path)
    if (!entry || !entry.value?.blob) return null
    const blobs = await drive.getBlobs()
    if (!blobs) return null
    return { entry, blobsKey: blobs.core.key }
  }

  // ----------------------------
  // Pairing / invites
  // ----------------------------

  async createInvite({ expires = 0 } = {}) {
    // Ensure we're listening for pairing requests on the owner device.
    if (this.swarm) {
      this.setupPairing(this.swarm).catch(() => {})
    }

    // One active invite at a time for v1.
    const existing = await this.view.get('invites/current').catch(() => null)
    if (existing?.value?.idHex) {
      const inv = await this.view.get(prefixedKey('invites', existing.value.idHex)).catch(() => null)
      if (inv?.value?.inviteZ32) return inv.value.inviteZ32
    }

    const inv = BlindPairing.createInvite(this.key, { expires })
    const inviteZ32 = z32.encode(inv.invite)

    await this.appendOp({
      type: 'add-invite',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      idHex: b4a.toString(inv.id, 'hex'),
      inviteZ32,
      publicKeyHex: b4a.toString(inv.publicKey, 'hex'),
      expires,
      createdAt: Date.now()
    })
    return inviteZ32
  }

  async clearInvite() {
    // best effort: delete all invites
    for await (const { key, value } of this.view.createReadStream({ gt: 'invites/', lt: 'invites/\xff' })) {
      if (!key.startsWith('invites/')) continue
      const idHex = value?.idHex
      if (idHex) await this.appendOp({
        type: 'delete-invite',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        idHex
      })
    }
  }

  // ----------------------------
  // Replication & Pairing
  // ----------------------------

  /**
   * Set up BlindPairing member to handle incoming device pairing requests.
   * Should be called after channel is ready and swarm is available.
   *
   * @param {import('hyperswarm')} swarm
   */
  async setupPairing(swarm) {
    if (!swarm) return

    // Prevent duplicate setup
    if (this._pairingSetupDone) {
      console.log('[Channel] Pairing already set up, skipping')
      return
    }
    this._pairingSetupDone = true
    this.swarm = swarm

    // ALWAYS join the channel's discovery topic for replication
    // This is critical - even non-writable/paired devices need to find peers to sync data
    if (this.discoveryKey) {
      console.log('[Channel] Joining swarm for discovery key:', this.discoveryKey.toString('hex').slice(0, 16))
      const discovery = swarm.join(this.discoveryKey)
      // IMPORTANT: Do not await flushed() here.
      // On some runtimes (notably mobile/Bare), flushed() can take a long time and would prevent
      // us from wiring replication handlers (base.replicate) early, which makes the channel
      // appear "stuck" and never updating.
      discovery
        .flushed()
        .then(() => {
          console.log('[Channel] Swarm join flushed for discovery key:', this.discoveryKey.toString('hex').slice(0, 16))
        })
        .catch((err) => {
          console.log('[Channel] Swarm join flush warning:', err?.message)
        })
    }

    // CRITICAL: Wire up Autobase replication on peer connections
    // Unlike Hyperdrive, Autobase requires explicit base.replicate(conn) calls
    // Without this, data never syncs between peers!
    this._connectionHandler = (conn) => {
      console.log('[Channel] Peer connected, replicating Autobase for:', this.keyHex?.slice(0, 16))
      if (this.base) {
        this.base.replicate(conn)
      }
    }
    swarm.on('connection', this._connectionHandler)

    // Also replicate on any existing connections (e.g., established during pairing)
    // This is critical for newly paired devices that already have a connection
    if (swarm.connections && swarm.connections.size > 0) {
      console.log('[Channel] Replicating Autobase on', swarm.connections.size, 'existing connections for:', this.keyHex?.slice(0, 16))
      for (const conn of swarm.connections) {
        try {
          this.base.replicate(conn)
        } catch (err) {
          console.log('[Channel] Error replicating on existing connection:', err?.message)
        }
      }
    }

    // Only writable peers should accept pairing requests (owner devices).
    // But we've already joined the swarm above for replication.
    if (!this.writable) {
      console.log('[Channel] Not writable, skipping pairing member setup')
      return
    }

    // Set up BlindPairing to accept incoming pairing requests
    this.pairing = new BlindPairing(swarm)

    this.pairingMember = this.pairing.addMember({
      discoveryKey: this.discoveryKey,
      onadd: async (req) => {
        try {
          // Get current invite
          const currentInv = await this.view.get('invites/current').catch(() => null)
          if (!currentInv?.value?.idHex) {
            console.log('[Channel] No active invite, ignoring pairing request')
            return
          }

          const inv = await this.view.get(prefixedKey('invites', currentInv.value.idHex)).catch(() => null)
          if (!inv?.value) {
            console.log('[Channel] Invite not found')
            return
          }

          // Verify the invite ID matches
          const candidateIdHex = b4a.toString(req.inviteId, 'hex')
          if (candidateIdHex !== inv.value.idHex) {
            console.log('[Channel] Invite ID mismatch')
            return
          }

          console.log('[Channel] Valid pairing request, adding writer...')

          // Open the request with the invite's public key
          const publicKeyBuf = fromHex(inv.value.publicKeyHex)
          const userData = req.open(publicKeyBuf)

          // Add the candidate's key as a writer
          const newWriterKeyHex = b4a.toString(userData, 'hex')

          await this.addWriter({
            keyHex: newWriterKeyHex,
            role: 'device',
            deviceName: ''
          })

          // Ensure the membership change is applied promptly so the new device becomes writable
          await this.base.update()

          // Confirm the pairing - send channel key and encryption key
          req.confirm({
            key: this.key,
            encryptionKey: this.encryptionKey
          })

          // Clear the used invite
          await this.appendOp({
            type: 'delete-invite',
            schemaVersion: CURRENT_SCHEMA_VERSION,
            idHex: inv.value.idHex
          })

          console.log('[Channel] Writer added and pairing confirmed:', newWriterKeyHex.slice(0, 16))
        } catch (err) {
          console.error('[Channel] Pairing error:', err)
        }
      }
    })

    console.log('[Channel] Pairing member set up for channel:', this.keyHex?.slice(0, 16))
  }

  /**
   * Join the swarm for a specific blob drive (to fetch blobs from other devices).
   *
   * @param {string} driveKeyHex
   */
  async joinBlobDrive(driveKeyHex) {
    if (!this.swarm) return

    const drive = await this._loadBlobDrive(driveKeyHex)
    if (drive.discoveryKey) {
      this.swarm.join(drive.discoveryKey)
      console.log('[Channel] Joined swarm for blob drive:', driveKeyHex.slice(0, 16))
    }
  }

  // ----------------------------
  // Sync helpers
  // ----------------------------

  /**
   * Wait for at least one peer connection on the channel's discovery key.
   * This ensures DHT discovery has completed before waiting for data.
   *
   * @param {number} timeoutMs - Maximum time to wait (default 30s)
   * @returns {Promise<boolean>} - true if connected, false if timeout
   */
  async waitForPeerConnection(timeoutMs = 30000) {
    if (!this.swarm) {
      console.log('[Channel] waitForPeerConnection: no swarm available')
      return false
    }

    // Ensure we're announced on the swarm
    if (this.discoveryKey) {
      try {
        const discovery = this.swarm.join(this.discoveryKey)
        await discovery.flushed()
        console.log('[Channel] waitForPeerConnection: discovery flushed')
      } catch (err) {
        console.log('[Channel] waitForPeerConnection: discovery flush error:', err?.message)
      }
    }

    const start = Date.now()

    // Check if we already have connections
    if (this.swarm?.connections?.size > 0) {
      console.log('[Channel] waitForPeerConnection: already have', this.swarm.connections.size, 'connections')
      return true
    }

    // Poll for connections
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const connCount = this.swarm?.connections?.size || 0
        if (connCount > 0) {
          console.log('[Channel] waitForPeerConnection: found', connCount, 'connections after', Date.now() - start, 'ms')
          clearInterval(checkInterval)
          resolve(true)
        } else if (Date.now() - start > timeoutMs) {
          console.log('[Channel] waitForPeerConnection: timeout after', timeoutMs, 'ms')
          clearInterval(checkInterval)
          resolve(false)
        }
      }, 500)
    })
  }

  /**
   * Wait for initial data sync from peers with progress callbacks.
   * This is the main method to call after pairing to ensure data is synced.
   *
   * @param {Object} opts
   * @param {number} opts.peerTimeout - Time to wait for peer connection (default 30s)
   * @param {number} opts.dataTimeout - Time to wait for data after connected (default 20s)
   * @param {(state: string, detail?: object) => void} opts.onProgress - Progress callback
   * @returns {Promise<{success: boolean, videoCount: number, state: string}>}
   */
  async waitForInitialSync(opts = {}) {
    const {
      peerTimeout = 30000,
      dataTimeout = 20000,
      onProgress = () => {}
    } = opts

    console.log('[Channel] waitForInitialSync: starting (peerTimeout:', peerTimeout, 'dataTimeout:', dataTimeout, ')')

    // Step 1: Wait for peer connection
    onProgress('connecting', { message: 'Looking for peers...' })
    const peerConnected = await this.waitForPeerConnection(peerTimeout)

    if (!peerConnected) {
      console.log('[Channel] waitForInitialSync: no peers found')
      onProgress('offline', { message: 'No peers found. Original device may be offline.' })
      return { success: false, videoCount: 0, state: 'offline' }
    }

    // Step 2: Wait for data to arrive
    onProgress('syncing', { message: 'Connected! Syncing data...', peerCount: this.swarm?.connections?.size || 0 })

    const start = Date.now()
    let lastViewLength = this.view?.core?.length || 0

    while (Date.now() - start < dataTimeout) {
      // Try to pull data from peers - use longer timeout (10s) to allow replication to complete
      try {
        await Promise.race([
          this.base.update({ wait: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('update timeout')), 10000))
        ])
      } catch (err) {
        // Timeout on individual update is ok, we'll check progress anyway
      }

      const currentLength = this.view?.core?.length || 0
      const videos = await this.listVideos()

      console.log('[Channel] waitForInitialSync: poll - viewLength:', currentLength, 'videos:', videos.length)

      if (videos.length > 0) {
        console.log('[Channel] waitForInitialSync: synced with', videos.length, 'videos')
        onProgress('synced', { videoCount: videos.length })
        return { success: true, videoCount: videos.length, state: 'synced' }
      }

      // Check if view is growing (data arriving)
      if (currentLength > lastViewLength) {
        lastViewLength = currentLength
        onProgress('syncing', {
          message: 'Receiving data...',
          peerCount: this.swarm?.connections?.size || 0
        })
      }

      // Wait longer between polls to give replication more time
      await new Promise(r => setTimeout(r, 2000))
    }

    // Timeout reached - check final state
    const videos = await this.listVideos()
    if (videos.length > 0) {
      console.log('[Channel] waitForInitialSync: timeout but found', videos.length, 'videos')
      onProgress('synced', { videoCount: videos.length })
      return { success: true, videoCount: videos.length, state: 'synced' }
    }

    console.log('[Channel] waitForInitialSync: timeout with no videos')
    onProgress('failed', { message: 'Sync timeout - no videos received yet' })
    return { success: false, videoCount: 0, state: 'failed' }
  }

  /**
   * Append an op with local-only rate limiting (deterministic view safety).
   * This MUST NOT influence apply() determinism because rejected ops are never appended.
   * @param {any} op
   */
  async appendOp(op) {
    const writerKeyHex =
      op?.updatedBy || op?.uploadedBy || op?.authorKeyHex || op?.moderatorKeyHex || this.localWriterKeyHex || null
    if (writerKeyHex) this._checkLocalRateLimit(writerKeyHex)
    return this.base.append(op)
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
    if (prev.count >= maxOpsPerWindow) {
      throw new Error('Rate limit exceeded (local)')
    }
    prev.count++
  }
}


