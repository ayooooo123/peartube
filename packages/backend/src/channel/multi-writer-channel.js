import ReadyResource from 'ready-resource'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Hyperblobs from 'hyperblobs'
import BeeDiffStreamImport from 'hyperbee-diff-stream'
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
import { PublicChannelBee } from './public-channel-bee.js'

const BeeDiffStream = BeeDiffStreamImport?.default || BeeDiffStreamImport
const CURRENT_SCHEMA_VERSION = 1

/**
 * MultiWriterChannel
 *
 * Unified Autobase + Hyperblobs architecture:
 * - Metadata is stored in Autobase (multi-writer, linearized view)
 * - Video blobs are stored in a shared Hyperblobs instance (same Corestore)
 * - Single discovery key, single replication stream
 * - Blob pointers (4 numbers) stored in Autobase metadata
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

    /** @type {Hyperblobs|null} Shared blob storage for all videos in this channel */
    this.blobs = null
    /** @type {any} The Hypercore backing the blobs */
    this._blobsCore = null

    // Keep strong ref to swarm.join() discovery handle so it isn't GC'd on mobile/Bare.
    /** @type {any | null} */
    this._channelDiscovery = null

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

    /** @type {import('./comments-autobase.js').CommentsAutobase|null} */
    this.commentsAutobase = null

    /**
     * Public Hyperbee for auto-replicating channel data to viewers.
     * This is the simple, instant-sync layer that public feed uses.
     * Owner syncs Autobase changes here; viewers only load this.
     * @type {PublicChannelBee|null}
     */
    this.publicBee = null

    /** @type {WeakSet<any>} Track connections we've already replicated to prevent duplicates */
    this._replicatedConns = new WeakSet()

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

  /** @returns {Buffer|null} The key of the blobs Hypercore */
  get blobsKey() {
    return this._blobsCore?.key || null
  }

  /** @returns {string|null} The hex-encoded key of the blobs Hypercore */
  get blobsKeyHex() {
    return this.blobsKey ? b4a.toString(this.blobsKey, 'hex') : null
  }

  /** @returns {string|null} The public Hyperbee key (for public feed discovery) */
  get publicBeeKey() {
    return this.publicBee?.keyHex || null
  }

  /**
   * Get the public bee key from metadata (for paired devices that don't have the bee loaded)
   * @returns {Promise<string|null>}
   */
  async getPublicBeeKey() {
    if (this.publicBee?.keyHex) return this.publicBee.keyHex
    const meta = await this.getMetadata()
    return meta?.publicBeeKey || null
  }

  /**
   * Sync all Autobase data to the public Hyperbee.
   * Call this to backfill existing videos that were added before public sync was implemented.
   */
  async syncToPublicBee() {
    if (!this.publicBee?.writable) {
      console.log('[Channel] syncToPublicBee: not writable, skipping')
      return
    }

    try {
      console.log('[Channel] syncToPublicBee: starting full sync...')
      await this.publicBee.syncFromChannel(this)
      console.log('[Channel] syncToPublicBee: complete')
    } catch (err) {
      console.error('[Channel] syncToPublicBee error:', err.message)
    }
  }

  async _safeUpdate(opts = {}) {
    const { syncPublicBee = true, ...updateOpts } = opts || {}
    const channelId = this.keyHex?.slice(0, 16) || 'unknown'
    const connsBefore = this.swarm?.connections?.size || 0

    // Wait for channel discovery to flush if we just joined the topic.
    // This gives time for peers with this channel's data to connect.
    if (this._channelDiscovery && !this._discoveryFlushed) {
      console.log(`[Channel:${channelId}] _safeUpdate: waiting for discovery flush... (conns=${connsBefore})`)
      try {
        await Promise.race([
          this._channelDiscovery.flushed(),
          new Promise(resolve => setTimeout(resolve, 5000))  // 5s max wait
        ])
        this._discoveryFlushed = true
        const connsAfter = this.swarm?.connections?.size || 0
        console.log(`[Channel:${channelId}] _safeUpdate: discovery flushed (conns: ${connsBefore} -> ${connsAfter})`)
      } catch (err) {
        console.log(`[Channel:${channelId}] _safeUpdate: discovery flush timeout (continuing)`)
      }
    }

    // Wait briefly for peer connections if swarm is available but no peers yet.
    if (this.swarm && this.swarm.connections?.size === 0) {
      console.log(`[Channel:${channelId}] _safeUpdate: no connections, waiting 2s...`)
      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    // If we can, snapshot the view so we can diff after update and cheaply sync PublicBee.
    // This is especially useful when OTHER writers changed the Autobase while this device was offline.
    const shouldDiffSyncPublicBee = Boolean(
      syncPublicBee &&
      this.publicBee?.writable &&
      BeeDiffStream &&
      typeof this.view?.snapshot === 'function'
    )
    const beforeSnapshot = shouldDiffSyncPublicBee ? this.view.snapshot() : null

    // Log Autobase state before update
    const localLen = this.base?.local?.length || 0
    const viewLen = this.view?.core?.length || 0
    console.log(`[Channel:${channelId}] _safeUpdate: calling base.update (local=${localLen}, view=${viewLen}, writable=${this.writable})`)

    try {
      // Use wait: true to wait for any pending replication data
      // This is critical for read-only peers - without it, update() returns immediately
      // even if data is being replicated from peers
      const result = await this.base.update({ wait: true, ...updateOpts })
      const viewLenAfter = this.view?.core?.length || 0
      console.log(`[Channel:${channelId}] _safeUpdate: base.update done (view: ${viewLen} -> ${viewLenAfter})`)

      if (beforeSnapshot && shouldDiffSyncPublicBee) {
        try {
          const afterSnapshot = this.view.snapshot()
          await this._syncPublicBeeFromViewDiff(beforeSnapshot, afterSnapshot)
        } catch (err) {
          console.log(`[Channel:${channelId}] _safeUpdate: PublicBee diff sync error (non-fatal):`, err?.message)
        }
      }
      return result
    } catch (err) {
      console.log(`[Channel:${channelId}] _safeUpdate: error, retrying... ${err?.message}`)
      if (this.base?._applyState?.views) {
        this.base._applyState.views = this.base._applyState.views.map((v) => v || { core: { download: () => {} } })
      }
      const result = await this.base.update({ wait: true, ...updateOpts })
      if (beforeSnapshot && shouldDiffSyncPublicBee) {
        try {
          const afterSnapshot = this.view.snapshot()
          await this._syncPublicBeeFromViewDiff(beforeSnapshot, afterSnapshot)
        } catch (err2) {
          console.log(`[Channel:${channelId}] _safeUpdate: PublicBee diff sync error (non-fatal):`, err2?.message)
        }
      }
      return result
    }
  }

  _toPublicVideoMeta(value) {
    if (!value || typeof value !== 'object') return {}
    // Keep PublicBee values aligned with existing write paths:
    // - addVideo() strips { type, schemaVersion, logicalClock }
    // - view entries contain schemaVersion/logicalClock but not type
    const { type, schemaVersion, logicalClock, ...rest } = value
    return rest
  }

  async _syncPublicBeeFromViewDiff(beforeSnapshot, afterSnapshot) {
    if (!this.publicBee?.writable) return
    if (!BeeDiffStream) return

    // 1) Sync channel metadata (only `meta` key, and only public fields)
    try {
      const metaDiff = new BeeDiffStream(afterSnapshot, beforeSnapshot, {
        gte: 'channel-meta/',
        lt: 'channel-meta0',
        keyEncoding: 'utf-8',
        valueEncoding: 'json'
      })

      for await (const d of metaDiff) {
        const key = d?.left?.key ?? d?.right?.key
        if (key !== 'channel-meta/meta') continue
        const v = d?.left?.value || null
        if (v) {
          const { name, description, avatar } = v
          await this.publicBee.setMetadata({
            name: typeof name === 'string' ? name : '',
            description: typeof description === 'string' ? description : '',
            avatar: avatar ?? null
          })
        }
      }
    } catch (err) {
      console.log('[Channel] _syncPublicBeeFromViewDiff meta error (non-fatal):', err?.message)
    }

    // 2) Sync video index changes (put/del only for changed keys)
    const videoChanges = []
    try {
      const videosDiff = new BeeDiffStream(afterSnapshot, beforeSnapshot, {
        gte: 'videos/',
        lt: 'videos0',
        keyEncoding: 'utf-8',
        valueEncoding: 'json'
      })

      for await (const d of videosDiff) {
        const key = d?.left?.key ?? d?.right?.key
        if (typeof key !== 'string' || !key.startsWith('videos/')) continue
        const id = key.slice('videos/'.length)
        if (!id) continue

        if (d.left === null) {
          videoChanges.push({ type: 'del', id })
        } else if (d.left?.value) {
          videoChanges.push({ type: 'put', id, value: this._toPublicVideoMeta(d.left.value) })
        }
      }
    } catch (err) {
      console.log('[Channel] _syncPublicBeeFromViewDiff videos error (non-fatal):', err?.message)
    }

    if (videoChanges.length > 0) {
      await this.publicBee.applyVideoChanges(videoChanges)
    }
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
        // NOTE: Autobase may call open() multiple times during replication.
        // The store here is namespaced per-Autobase, so using a shared name is safe.
        console.log('[Channel] open callback: creating Hyperbee view...')
        const core = store.get({ name: 'view' })
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

    // CRITICAL: Set up Autobase replication BEFORE base.update()
    // Without this, base.update() can't receive data from peers
    if (this.swarm && this.swarm.connections?.size > 0) {
      console.log('[Channel] _open: setting up replication on', this.swarm.connections.size, 'existing connections BEFORE update')
      for (const conn of this.swarm.connections) {
        if (!this._replicatedConns.has(conn)) {
          this._replicatedConns.add(conn)
          try {
            this.base.replicate(conn)
            console.log('[Channel] _open: replicated on connection for:', this.keyHex?.slice(0, 16))
          } catch (err) {
            console.log('[Channel] _open: replicate error:', err?.message)
          }
        }
      }
    }

    // Force apply any pending operations to the view
    console.log('[Channel] _open: calling base.update() to apply pending ops...')
    const updateStart = Date.now()
    await this._safeUpdate()
    console.log('[Channel] _open: base.update() took', Date.now() - updateStart, 'ms')

    // Debug Autobase internals
    const inputs = this.base.inputs || []
    const activeWriters = this.base.activeWriters || []
    console.log('[Channel] _open complete: key:', this.keyHex?.slice(0, 16),
      'writable:', this.writable,
      'local length:', this.base.local?.length,
      'view length:', this.view?.core?.length,
      'inputs:', inputs.length,
      'activeWriters:', activeWriters.length,
      'linearizer:', this.base.linearizer ? 'yes' : 'no'
    )

    // Initialize per-device Hyperblobs for video storage
    // Each device needs its own writable blobs core (Hypercore is single-writer)
    // The blobs core key is stored in video metadata so other devices can fetch
    const localWriterKey = this.localWriterKeyHex || 'default'
    const blobsCoreName = `peartube-blobs-${this.keyHex?.slice(0, 16)}-${localWriterKey.slice(0, 16)}`
    console.log('[Channel] _open: initializing Hyperblobs with core:', blobsCoreName)
    this._blobsCore = this.store.get({ name: blobsCoreName })
    await this._blobsCore.ready()
    this.blobs = new Hyperblobs(this._blobsCore)
    console.log('[Channel] _open: Hyperblobs ready, key:', this.blobsKeyHex?.slice(0, 16), 'writable:', this._blobsCore.writable)

    // Initialize public Hyperbee for auto-replicating channel data
    // This is what public feed viewers load - it auto-replicates via store.replicate()
    // Only the owner (writable) creates and syncs to this; viewers load it separately
    if (this.writable) {
      const existingMeta = await this.getMetadata().catch(() => null)
      const existingPublicBeeKey = existingMeta?.publicBeeKey || null

      // IMPORTANT:
      // - If `publicBeeKey` is already in channel metadata, ALWAYS load by key.
      //   Creating by `{ name }` is only deterministic within a single Corestore seed; across devices it can fork.
      // - Only create by `{ name }` when no key exists yet (first-time owner bootstrap).
      const isValidPublicBeeKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k)

      if (isValidPublicBeeKey(existingPublicBeeKey)) {
        console.log('[Channel] _open: loading public Hyperbee by key:', existingPublicBeeKey.slice(0, 16))
        this.publicBee = new PublicChannelBee(this.store, { key: existingPublicBeeKey })
      } else {
      const publicBeeName = `peartube-public-${this.keyHex}`
        console.log('[Channel] _open: creating public Hyperbee by name:', publicBeeName.slice(0, 40))
      this.publicBee = new PublicChannelBee(this.store, { name: publicBeeName })
      }

      await this.publicBee.ready()
      console.log('[Channel] _open: public Hyperbee ready, key:', this.publicBee.keyHex?.slice(0, 16))

      // CRITICAL: Ensure other peers can FIND the PublicBee seeders.
      // Viewers join the PublicBee discoveryKey to discover/replicate it. If the publisher/owner never joins,
      // then viewers may connect only to "gossip peers" (public-feed topic) that don't actually seed the bee,
      // leading to permanent empty reads on mobile.
      if (this.swarm && this.publicBee.discoveryKey) {
        try {
          const d = this.swarm.join(this.publicBee.discoveryKey)
          // Best-effort; do not block startup if it hangs on mobile networks.
          d?.flushed?.().catch(() => {})
          console.log('[Channel] _open: joined swarm for public bee discovery:', this.publicBee.keyHex?.slice(0, 16))
        } catch (err) {
          console.log('[Channel] _open: failed to join swarm for public bee (non-fatal):', err?.message)
        }
      }

      // Store the public bee key in Autobase metadata so paired devices know about it
      // and so it can be retrieved for publishing to the public feed.
      // If there was a bogus key in metadata, overwrite it with the actual key we opened.
      if ((!isValidPublicBeeKey(existingPublicBeeKey) || !existingPublicBeeKey) && this.publicBee.keyHex) {
        await this.updateMetadata({
          ...(existingMeta || {}),
          publicBeeKey: this.publicBee.keyHex
        })
        console.log('[Channel] _open: stored public bee key in metadata')
      }

      // Backfill existing videos to the public Hyperbee
      // This ensures channels created before PublicBee was added get their content synced
      await this.syncToPublicBee()
    }

    // Initialize comments, reactions, and watch logger
    this.comments = new CommentsChannel(this)
    this.reactions = new ReactionsManager(this)
    this.watchLogger = new WatchEventLogger(this)

    // Initialize CommentsAutobase (separate Autobase for open comment participation)
    await this._initCommentsAutobase()
  }

  /**
   * Initialize or load the CommentsAutobase for this channel.
   * The key is stored in channel metadata so all devices can discover it.
   */
  async _initCommentsAutobase() {
    try {
      const { getOrCreateCommentsAutobase } = await import('./comments-autobase.js')

      // Check if commentsAutobaseKey already exists in metadata
      const meta = await this.getMetadata().catch(() => null)
      let existingKey = meta?.commentsAutobaseKey || null

      // If metadata doesn't have it yet, try the PublicBee metadata (viewers/paired devices rely on this).
      if (!existingKey && this.publicBee) {
        try {
          const pubMeta = await this.publicBee.getMetadata().catch(() => null)
          existingKey = pubMeta?.commentsAutobaseKey || null
        } catch {}
      }

      const isPublishingDevice = Boolean(this.publicBee?.writable)
      console.log('[Channel] _initCommentsAutobase: existingKey:', existingKey?.slice(0, 16) || 'none', 'publisher:', isPublishingDevice)

      // IMPORTANT: Non-publishing devices must never create a new CommentsAutobase by `{ name }`,
      // because that derivation is deterministic per-device and will fork comments.
      if (!isPublishingDevice && !existingKey) {
        console.log('[Channel] _initCommentsAutobase: skipping (no published key yet)')
        return
      }

      // Create or load CommentsAutobase
      this.commentsAutobase = await getOrCreateCommentsAutobase(this.store, {
        channelKey: this.keyHex,
        commentsAutobaseKey: existingKey,
        isChannelOwner: isPublishingDevice, // Only the PublicBee writer can publish/ack reliably
        swarm: this.swarm
      })
      console.log('[Channel] _initCommentsAutobase: ready, key:', this.commentsAutobase.keyHex?.slice(0, 16))

      // Publishing device: ensure the canonical key is persisted + published.
      if (isPublishingDevice && this.commentsAutobase.keyHex) {
        try {
          if (!existingKey) {
            console.log('[Channel] _initCommentsAutobase: storing commentsAutobaseKey in metadata')
            await this.updateMetadata({ commentsAutobaseKey: this.commentsAutobase.keyHex })
          }

          const pubMeta = await this.publicBee.getMetadata().catch(() => ({}))
          if (pubMeta?.commentsAutobaseKey !== this.commentsAutobase.keyHex) {
            await this.publicBee.setMetadata({ commentsAutobaseKey: this.commentsAutobase.keyHex })
            console.log('[Channel] _initCommentsAutobase: synced commentsAutobaseKey to PublicBee')
          }
        } catch (err) {
          console.log('[Channel] _initCommentsAutobase: publish error (non-fatal):', err?.message)
        }
      }
    } catch (err) {
      console.log('[Channel] _initCommentsAutobase error:', err?.message)
      // Non-fatal: comments may not work but channel still loads
    }
  }

  /**
   * Get the CommentsAutobase for this channel.
   * Lazily initializes if not already done.
   * @returns {Promise<import('./comments-autobase.js').CommentsAutobase>}
   */
  async getCommentsAutobase() {
    if (!this.commentsAutobase) {
      await this._initCommentsAutobase()
    }
    return this.commentsAutobase
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

    // Close blobs core
    if (this._blobsCore) {
      try { await this._blobsCore.close() } catch {}
      this._blobsCore = null
      this.blobs = null
    }
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
          // Persist public bee key across updates so viewers/paired devices can use the fast path.
          // If the op does not include it, keep the previous value.
          publicBeeKey: op.publicBeeKey !== undefined ? op.publicBeeKey : (prev.publicBeeKey ?? null),
          // Persist the canonical CommentsAutobase key so all devices can discover the shared comments log.
          commentsAutobaseKey: op.commentsAutobaseKey !== undefined ? op.commentsAutobaseKey : (prev.commentsAutobaseKey ?? null),
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
        // Only accept a new publicBeeKey when the update "wins"; otherwise preserve the previous value.
        // If no previous key exists yet, allow it to be introduced regardless.
        if (!shouldUseNew && prev.publicBeeKey) {
          merged.publicBeeKey = prev.publicBeeKey
        }
        if (!shouldUseNew && prev.commentsAutobaseKey) {
          merged.commentsAutobaseKey = prev.commentsAutobaseKey
        }

        await view.put(key, merged)
        return
      }

      case 'add-video': {
        const key = prefixedKey('videos', op.id)
        const { type, ...rest } = op
        // Coerce schema fields to safe strings to avoid rejecting historical ops
        const safe = {
          ...rest,
          title: typeof rest.title === 'string' ? rest.title : String(rest.title ?? ''),
          description: typeof rest.description === 'string' ? rest.description : '',
          category: typeof rest.category === 'string' ? rest.category : '',
          mimeType: typeof rest.mimeType === 'string' ? rest.mimeType : '',
        }
        console.log('[Channel] _applyOp add-video:', op.id, 'blobId:', op.blobId, 'blobsCoreKey:', op.blobsCoreKey?.slice(0, 16), 'keyLen:', op.blobsCoreKey?.length, 'key:', key)
        await view.put(key, safe)
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

  /**
   * Update channel metadata.
   *
   * Important: only fields present on `updates` are written into the op so we don't
   * accidentally clear existing metadata (e.g. `avatar`).
   *
   * @param {Object} updates
   * @param {string} [updates.name]
   * @param {string} [updates.description]
   * @param {string|null} [updates.avatar]
   * @param {string|null} [updates.publicBeeKey]
   * @param {string|null} [updates.commentsAutobaseKey]
   */
  async updateMetadata(updates = {}) {
    const patch = updates && typeof updates === 'object' ? updates : {}

    // Get current logical clock from view
    const currentMeta = await this.getMetadata().catch(() => null)
    const nextClock = (currentMeta?.logicalClock || 0) + 1

    // Preserve existing publicBeeKey if not provided
    const finalPublicBeeKey =
      (typeof patch.publicBeeKey === 'string' && patch.publicBeeKey.length > 0 ? patch.publicBeeKey : null) ||
      currentMeta?.publicBeeKey ||
      this.publicBee?.keyHex ||
      null

    /** @type {any} */
    const op = {
      type: 'update-channel',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      logicalClock: nextClock,
      key: 'meta',
      publicBeeKey: finalPublicBeeKey,
      updatedAt: Date.now(),
      updatedBy: this.localWriterKeyHex
    }

    if ('name' in patch) op.name = patch.name
    if ('description' in patch) op.description = patch.description
    if ('avatar' in patch) op.avatar = patch.avatar
    if ('createdAt' in patch) op.createdAt = patch.createdAt
    if ('createdBy' in patch) op.createdBy = patch.createdBy
    if ('commentsAutobaseKey' in patch) op.commentsAutobaseKey = patch.commentsAutobaseKey

    await this.appendOp(op)

    // Sync public-facing metadata to the public Hyperbee (viewers read this, not the Autobase).
    if (this.publicBee?.writable) {
      try {
        /** @type {any} */
        const publicPatch = {}
        if ('name' in patch) publicPatch.name = patch.name
        if ('description' in patch) publicPatch.description = patch.description
        if ('avatar' in patch) publicPatch.avatar = patch.avatar
        if ('commentsAutobaseKey' in patch) publicPatch.commentsAutobaseKey = patch.commentsAutobaseKey

        if (Object.keys(publicPatch).length > 0) {
          await this.publicBee.setMetadata(publicPatch)
          console.log('[Channel] updateMetadata synced to public bee')
        }
      } catch (err) {
        console.log('[Channel] updateMetadata public sync error (non-fatal):', err?.message)
      }
    }
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

  /**
   * Ensure the local writer is registered in the channel.
   * In the unified architecture, all writers share the same Hyperblobs.
   * @deprecated Use channel.blobs directly for blob operations
   */
  async ensureLocalBlobDrive({ deviceName = '' } = {}) {
    if (!this.localWriterKeyHex) throw new Error('Channel not ready')
    if (!this.blobs) throw new Error('Blobs not initialized')

    // Check if writer is already registered
    const existing = await this.view.get(prefixedKey('writers', this.localWriterKeyHex)).catch(() => null)
    if (existing?.value) {
      return this.blobsKeyHex // Return shared blobs key for compatibility
    }

    // Register the writer (all writers share the same Hyperblobs)
    await this.appendOp({
      type: 'upsert-writer',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      keyHex: this.localWriterKeyHex,
      deviceName,
      blobDriveKey: this.blobsKeyHex // Point to shared blobs
    })

    return this.blobsKeyHex
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
    // Ensure the view catches up to any newly replicated nodes.
    // This is critical for ALL channels - both writable and read-only.
    // Read-only peers viewing others' channels need the view to be updated
    // with replicated Autobase data, otherwise they'll see empty video lists.
    try {
      await Promise.race([
        this._safeUpdate(),
        new Promise((resolve) => setTimeout(resolve, 10000))  // 10s timeout for initial sync (includes discovery flush)
      ])
    } catch (err) {
      console.log('[Channel] listVideos update error (non-fatal):', err?.message)
    }

    const out = []
    for await (const { value } of this.view.createReadStream({ gt: 'videos/', lt: 'videos/\xff' })) {
      out.push(value)
    }

    // Note: In the unified architecture, all blobs are in a single Hyperblobs instance
    // that's already part of the channel's Corestore. No need to join separate blob drives.

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
    const bck = res?.value?.blobsCoreKey
    console.log('[Channel] getVideo result:', res?.value?.id, 'blobId:', res?.value?.blobId, 'blobsCoreKey:', bck?.slice(0, 16), 'keyLen:', bck?.length)
    if (bck && bck.length !== 64) {
      console.error('[Channel] WARNING: blobsCoreKey is TRUNCATED! Length:', bck.length, 'Full value:', bck)
    }
    return res?.value || null
  }

  async addVideo(meta) {
    const id = meta.id
    if (!id) throw new Error('Video id required')
    console.log('[Channel] addVideo:', id, 'blobId:', meta.blobId, 'blobsCoreKey:', meta.blobsCoreKey?.slice(0, 16), 'keyLen:', meta.blobsCoreKey?.length)

    // Get next logical clock
    const videos = await this.listVideos().catch(() => [])
    const maxClock = Math.max(...videos.map(v => v.logicalClock || 0), 0)
    const nextClock = maxClock + 1

    const videoMeta = {
      type: 'add-video',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      logicalClock: nextClock,
      ...meta,
      uploadedAt: meta.uploadedAt || Date.now(),
      uploadedBy: meta.uploadedBy || this.localWriterKeyHex
    }

    await this.appendOp(videoMeta)
    // Wait for the view to be updated with our new entry
    await this._safeUpdate()
    console.log('[Channel] addVideo appended and view updated')

    // Sync to public Hyperbee for instant public feed replication
    if (this.publicBee?.writable) {
      try {
        const { type, schemaVersion, logicalClock, ...publicMeta } = videoMeta
        await this.publicBee.putVideo(id, publicMeta)
        console.log('[Channel] addVideo synced to public bee')
      } catch (err) {
        console.log('[Channel] addVideo public sync error (non-fatal):', err?.message)
      }
    }
  }

  async updateVideo(id, updates) {
    if (!id) throw new Error('Video id required')
    console.log('[Channel] updateVideo:', id, 'updates:', JSON.stringify(updates))

    // Get existing video
    const existing = await this.getVideo(id)
    if (!existing) throw new Error('Video not found: ' + id)

    // Get next logical clock
    const videos = await this.listVideos().catch(() => [])
    const maxClock = Math.max(...videos.map(v => v.logicalClock || 0), 0)
    const nextClock = maxClock + 1

    const videoMeta = {
      type: 'update-video',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      logicalClock: nextClock,
      id,
      ...updates,
      updatedAt: Date.now(),
      updatedBy: this.localWriterKeyHex
    }

    await this.appendOp(videoMeta)
    await this._safeUpdate()
    console.log('[Channel] updateVideo appended and view updated')

    // Sync to public Hyperbee
    if (this.publicBee?.writable) {
      try {
        const merged = { ...existing, ...updates }
        const { type, schemaVersion, logicalClock, ...publicMeta } = merged
        await this.publicBee.putVideo(id, publicMeta)
        console.log('[Channel] updateVideo synced to public bee')
      } catch (err) {
        console.log('[Channel] updateVideo public sync error (non-fatal):', err?.message)
      }
    }
  }

  async deleteVideo(id) {
    // Note: In Hyperblobs, blobs are content-addressed and immutable.
    // We can't delete individual blobs, but removing the video metadata
    // makes the blob unreferenced and it won't be served.
    console.log('[Channel] deleteVideo:', id)
    await this.appendOp({
      type: 'delete-video',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id
    })
    // Wait for the view to be updated with the deletion
    await this._safeUpdate()
    console.log('[Channel] deleteVideo appended and view updated')

    // Sync deletion to public Hyperbee
    if (this.publicBee?.writable) {
      try {
        await this.publicBee.deleteVideo(id)
        console.log('[Channel] deleteVideo synced to public bee')
      } catch (err) {
        console.log('[Channel] deleteVideo public sync error (non-fatal):', err?.message)
      }
    }
  }

  // ----------------------------
  // Blob operations (Hyperblobs)
  // ----------------------------

  /**
   * Store a blob in the shared Hyperblobs instance.
   * @param {Buffer|Uint8Array} data - The blob data to store
   * @returns {Promise<{id: string, blockOffset: number, blockLength: number, byteOffset: number, byteLength: number}>}
   */
  async putBlob(data) {
    if (!this.blobs) throw new Error('Blobs not initialized')
    const id = await this.blobs.put(data)
    // Hyperblobs.put() returns a blob ID object with: { blockOffset, blockLength, byteOffset, byteLength }
    return {
      id: `${id.blockOffset}:${id.blockLength}:${id.byteOffset}:${id.byteLength}`,
      ...id
    }
  }

  /**
   * Get a blob from the shared Hyperblobs instance.
   * @param {string|{blockOffset: number, blockLength: number, byteOffset: number, byteLength: number}} blobId
   * @returns {Promise<Buffer|null>}
   */
  async getBlob(blobId) {
    if (!this.blobs) throw new Error('Blobs not initialized')

    // Parse string ID if needed
    let id = blobId
    if (typeof blobId === 'string') {
      const parts = blobId.split(':').map(Number)
      if (parts.length !== 4) throw new Error('Invalid blob ID format')
      id = {
        blockOffset: parts[0],
        blockLength: parts[1],
        byteOffset: parts[2],
        byteLength: parts[3]
      }
    }

    try {
      return await this.blobs.get(id)
    } catch (err) {
      console.log('[Channel] getBlob error:', err?.message)
      return null
    }
  }

  /**
   * Create a read stream for a blob.
   * @param {string|{blockOffset: number, blockLength: number, byteOffset: number, byteLength: number}} blobId
   * @param {Object} [opts] - Stream options (start, end, etc.)
   * @returns {ReadableStream}
   */
  createBlobReadStream(blobId, opts = {}) {
    if (!this.blobs) throw new Error('Blobs not initialized')

    // Parse string ID if needed
    let id = blobId
    if (typeof blobId === 'string') {
      const parts = blobId.split(':').map(Number)
      if (parts.length !== 4) throw new Error('Invalid blob ID format')
      id = {
        blockOffset: parts[0],
        blockLength: parts[1],
        byteOffset: parts[2],
        byteLength: parts[3]
      }
    }

    return this.blobs.createReadStream(id, opts)
  }

  /**
   * Get blob entry info for playback (compatible with existing API).
   * @param {Object} video - Video metadata with blobId
   * @returns {Promise<{blobId: Object, blobsKey: Buffer, byteLength: number}|null>}
   */
  async getBlobEntry(video) {
    if (!video?.blobId) return null

    // Parse the blobId
    let id = video.blobId
    if (typeof id === 'string') {
      const parts = id.split(':').map(Number)
      if (parts.length !== 4) return null
      id = {
        blockOffset: parts[0],
        blockLength: parts[1],
        byteOffset: parts[2],
        byteLength: parts[3]
      }
    }

    // Determine which blobs core has this video
    let blobsKey = this._blobsCore?.key

    // If video specifies a different blobs core (uploaded by another device), load it
    if (video.blobsCoreKey && video.blobsCoreKey !== this.blobsKeyHex) {
      try {
        const remoteBlobsCore = this.store.get(b4a.from(video.blobsCoreKey, 'hex'))
        await remoteBlobsCore.ready()
        blobsKey = remoteBlobsCore.key
        console.log('[Channel] getBlobEntry: using remote blobs core:', video.blobsCoreKey.slice(0, 16))
      } catch (err) {
        console.log('[Channel] getBlobEntry: failed to load remote blobs core:', err?.message)
        return null
      }
    }

    if (!blobsKey) return null

    return {
      blobId: id,
      blobsKey,
      byteLength: id.byteLength
    }
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

    // IMPORTANT: replication idempotency must be per-channel (per Autobase instance).
    // Using a global per-connection WeakSet prevents other channels from replicating on the same
    // peer connection, which makes public-feed channels appear "empty" (no videos).
    const replicatedConns = this._replicatedConns

    // ALWAYS join the channel's discovery topic for replication
    // This is critical - even non-writable/paired devices need to find peers to sync data
    if (this.discoveryKey) {
      console.log('[Channel] Joining swarm for discovery key:', this.discoveryKey.toString('hex').slice(0, 16))
      // Retain the discovery handle; otherwise it can be GC'd on some runtimes and discovery stops.
      const discovery = swarm.join(this.discoveryKey)
      this._channelDiscovery = discovery
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
    // IMPORTANT: Use idempotency check - calling replicate() twice on the same Autobase+connection can corrupt state
    this._connectionHandler = (conn) => {
      if (replicatedConns.has(conn)) {
        console.log('[Channel] Already replicated on this connection, skipping:', this.keyHex?.slice(0, 16))
        return
      }
      replicatedConns.add(conn)
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
      let replicated = 0
      let skipped = 0
      for (const conn of swarm.connections) {
        if (replicatedConns.has(conn)) {
          skipped++
          continue  // Already replicated
        }
        replicatedConns.add(conn)
        try {
          this.base.replicate(conn)
          replicated++
        } catch (err) {
          console.log('[Channel] Error replicating on existing connection:', err?.message)
        }
      }
      console.log('[Channel] setupPairing: replicated on', replicated, 'connections, skipped', skipped, 'for:', this.keyHex?.slice(0, 16))
    } else {
      console.log('[Channel] setupPairing: no existing connections for:', this.keyHex?.slice(0, 16))
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
          await this._safeUpdate()

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

  // Note: joinBlobDrive() removed - in the unified architecture, all blobs are in
  // the shared Hyperblobs instance that's part of the channel's Corestore.
  // No separate discovery/replication needed for blobs.

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
        this._channelDiscovery = discovery
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
