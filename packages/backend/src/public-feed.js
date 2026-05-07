/* eslint-disable no-empty */
/**
 * PublicFeedManager - P2P channel discovery over Hyperswarm
 *
 * Architecture:
 * 1. Hyperswarm DHT - Only for peer discovery on the feed topic
 * 2. Secret-stream connections - Encrypted P2P pipes between discovered peers
 * 3. Protomux protocol - Run feed exchange over the secret-stream
 * 4. Keep connections open - Maintain peer connections for real-time gossip
 *
 * Protocol Flow:
 * - On connection: immediately send HAVE_FEED with all known channel keys
 * - Receive HAVE_FEED: merge new keys into local feed
 * - On publish: send SUBMIT_CHANNEL to all peers, they re-gossip
 */

import Protomux from 'protomux';
import c from 'compact-encoding';
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { NETWORK_TOPIC_STRING, PROTOCOL_NAME } from './types.js';
import { logger } from './logger.js'
import { hashFeedEntries, hashPreviewVideos } from './hash-utils.js'

const log = logger('PublicFeed')

/**
 * @typedef {import('./types.js').PublicFeedEntry} PublicFeedEntry
 */

export class PublicFeedManager {
  /**
   * @param {import('hyperswarm')} swarm - Hyperswarm instance
   * @param {import('hyperbee')} [metaDb] - Metadata database for persistence
   */
  constructor(swarm, metaDb) {
    this.swarm = swarm;
    this.metaDb = metaDb;
    /** @type {boolean} */
    this.started = false;
    /** @type {Map<string, PublicFeedEntry>} */
    this.entries = new Map();
    /** @type {Set<string>} */
    this.hiddenKeys = new Set();
    /** @type {Set<string>} Channels the user has published (persisted) */
    this.publishedChannels = new Set();
    /** @type {Map<any, any>} conn → protomux channel */
    this.peerChannels = new Map();
    /** @type {Map<any, Set<string>>} conn → announced driveKeys */
    this.peerFeedKeys = new Map();
    /** @type {Map<string, number>} driveKey → live announcing peer count */
    this.entryPeerCounts = new Map();
    /** @type {Set<any>} Active feed connections */
    this.feedConnections = new Set();
    /** @type {Set<any>} Connections already wired for the feed protocol */
    this.wiredConnections = new Set();
    /** @type {((requests: any[], conn?: any) => Promise<any[]>) | null} */
    this.availabilityHintProvider = null;
    /** @type {((entries: any[], conn?: any) => Promise<any[]>) | null} */
    this.feedSnapshotProvider = null;
    /** @type {number} */
    this._nextAvailabilityRequestId = 1;
    /** @type {Map<string, { resolve: Function, timeout: any }>} */
    this.pendingAvailabilityRequests = new Map();
    /** @type {Map<string, number>} */
    this._directPeerRetryCounts = new Map();
    /** @type {Map<string, any>} */
    this._discoveredPeers = new Map();
    /** @type {number} */
    this._maxDirectPeerRetries = 3;
    /** @type {number} */
    this._maxDirectPeers = 16;
    /** @type {() => number} */
    this._now = () => Date.now();
    /** @type {any | null} */
    this.feedDiscovery = null;
    /** @type {any | null} */
    this._gossipInterval = null;
    /** @type {number} */
    this._gossipIntervalMs = 30000;
    /** @type {(() => void) | null} */
    this.onFeedUpdate = null;
    /** @type {((conn: any) => void) | null} */
    this.onFeedConnectionOpen = null;
    /** @type {((event: { type: string, added: number, received: number }) => void) | null} */
    this.onFeedSync = null;

    // Persist discovered feed entries so UIs don't come up empty on restart.
    /** @type {any | null} */
    this._persistTimer = null
    /** @type {number} */
    this._persistDebounceMs = 1500
    /** @type {number} */
    this._persistMaxEntries = 500

    log.info('Initialized')
  }

  /**
   * Set callback for when feed updates occur
   * @param {() => void} callback
   */
  setOnFeedUpdate(callback) {
    this.onFeedUpdate = callback;
  }

  /**
   * Set callback for when a feed protocol channel opens
   * @param {(conn: any) => void} callback
   */
  setOnFeedConnectionOpen(callback) {
    this.onFeedConnectionOpen = callback;
  }

  /**
   * Set callback for when a feed sync message is received
   * @param {(event: { type: string, added: number, received: number }) => void} callback
   */
  setOnFeedSync(callback) {
    this.onFeedSync = callback;
  }

  /**
   * Set local provider for availability hints served over the feed channel.
   * Provider must be cheap/local-only; no network waits.
   * @param {(requests: any[], conn?: any) => Promise<any[]>} callback
   */
  setAvailabilityHintProvider(callback) {
    this.availabilityHintProvider = callback;
  }

  /**
   * Set local provider for compact feed snapshots served over the feed channel.
   * Provider must be cheap/local-only; no network waits.
   * @param {(entries: any[], conn?: any) => Promise<any[]>} callback
   */
  setFeedSnapshotProvider(callback) {
    this.feedSnapshotProvider = callback;
  }

  _sanitizePreviewVideos(videos) {
    if (!Array.isArray(videos)) return []
    return videos
      .filter((video) => video && typeof video === 'object' && typeof video.id === 'string' && video.id.length > 0)
      .slice(0, 3)
      .map((video) => ({
        id: String(video.id),
        title: video?.title ? String(video.title) : 'Untitled',
        uploadedAt: Number(video?.uploadedAt || 0) || 0,
        duration: Number(video?.duration || 0) || 0,
        thumbnail: video?.thumbnail ? String(video.thumbnail) : null,
        blobId: video?.blobId ? String(video.blobId) : null,
        blobsCoreKey: video?.blobsCoreKey ? String(video.blobsCoreKey) : null,
        mimeType: video?.mimeType ? String(video.mimeType) : null,
        availability: video?.availability === 'playable' ? 'playable' : 'unavailable',
        thumbnailBlobId: video?.thumbnailBlobId ? String(video.thumbnailBlobId) : null,
        thumbnailBlobsCoreKey: video?.thumbnailBlobsCoreKey ? String(video.thumbnailBlobsCoreKey) : null,
        thumbnailMimeType: video?.thumbnailMimeType ? String(video.thumbnailMimeType) : null,
      }))
  }

  _serializeEntry(entry) {
    const serialized = {
      driveKey: entry.driveKey,
      publicBeeKey: entry.publicBeeKey || null,
      version: Number(entry.version || 0) || 0,
    }
    if (entry.channelName) serialized.channelName = entry.channelName
    if (Number(entry.videoCount || 0) > 0) serialized.videoCount = Number(entry.videoCount || 0)
    if (Number(entry.manifestUpdatedAt || 0) > 0) serialized.manifestUpdatedAt = Number(entry.manifestUpdatedAt || 0)
    const previewVideos = this._sanitizePreviewVideos(entry.previewVideos)
    if (previewVideos.length > 0) serialized.previewVideos = previewVideos
    const previewVideosHash = entry.previewVideosHash || hashPreviewVideos(previewVideos)
    if (previewVideosHash) serialized.previewVideosHash = previewVideosHash
    return serialized
  }

  _applyEntrySnapshot(driveKey, snapshot = {}) {
    const entry = this.entries.get(driveKey)
    if (!entry) return false

    let changed = false

    if (typeof snapshot.publicBeeKey === 'string' && snapshot.publicBeeKey && snapshot.publicBeeKey !== entry.publicBeeKey) {
      entry.publicBeeKey = snapshot.publicBeeKey
      changed = true
    }
    if (typeof snapshot.channelName === 'string' && snapshot.channelName && snapshot.channelName !== entry.channelName) {
      entry.channelName = snapshot.channelName
      changed = true
    }
    if (Number.isFinite(snapshot.videoCount) && Number(snapshot.videoCount) !== Number(entry.videoCount || 0)) {
      entry.videoCount = Number(snapshot.videoCount)
      changed = true
    }

    const nextManifestUpdatedAt = Number(snapshot.manifestUpdatedAt || 0) || 0
    const incomingPreviewVideos = Array.isArray(snapshot.previewVideos)
      ? this._sanitizePreviewVideos(snapshot.previewVideos)
      : null
    const canApplyManifest =
      incomingPreviewVideos &&
      (
        nextManifestUpdatedAt === 0 ||
        Number(entry.manifestUpdatedAt || 0) === 0 ||
        nextManifestUpdatedAt >= Number(entry.manifestUpdatedAt || 0)
      )

    if (canApplyManifest) {
      const currentPreviewVideosHash = entry.previewVideosHash || hashPreviewVideos(this._sanitizePreviewVideos(entry.previewVideos))
      const nextPreviewVideosHash = hashPreviewVideos(incomingPreviewVideos)
      if (currentPreviewVideosHash !== nextPreviewVideosHash) {
        entry.previewVideos = incomingPreviewVideos
        entry.previewVideosHash = nextPreviewVideosHash
        changed = true
      }
      if (nextManifestUpdatedAt && nextManifestUpdatedAt !== Number(entry.manifestUpdatedAt || 0)) {
        entry.manifestUpdatedAt = nextManifestUpdatedAt
        changed = true
      } else if (!entry.manifestUpdatedAt && incomingPreviewVideos.length > 0) {
        entry.manifestUpdatedAt = Date.now()
        changed = true
      }
    }

    if (changed) {
      entry.version = Number(entry.version || 0) + 1
    }

    return changed
  }

  async _resolveFeedSnapshots(entries, conn) {
    if (!this.feedSnapshotProvider || !Array.isArray(entries) || entries.length === 0) return entries
    try {
      const snapshots = await this.feedSnapshotProvider(entries, conn)
      if (!Array.isArray(snapshots) || snapshots.length === 0) return entries

      const byKey = new Map(entries.map((entry) => [entry.driveKey, { ...entry }]))
      for (const snapshot of snapshots) {
        const driveKey = snapshot?.driveKey
        if (!driveKey || !byKey.has(driveKey)) continue

        const merged = {
          ...byKey.get(driveKey),
          publicBeeKey: snapshot.publicBeeKey || byKey.get(driveKey)?.publicBeeKey || null,
          channelName: snapshot.channelName || byKey.get(driveKey)?.channelName || null,
          videoCount: Number(snapshot.videoCount || byKey.get(driveKey)?.videoCount || 0) || 0,
          manifestUpdatedAt: Number(snapshot.manifestUpdatedAt || byKey.get(driveKey)?.manifestUpdatedAt || 0) || 0,
          previewVideos: this._sanitizePreviewVideos(snapshot.previewVideos || byKey.get(driveKey)?.previewVideos),
        }
        byKey.set(driveKey, merged)
        this._applyEntrySnapshot(driveKey, merged)
      }

      return Array.from(byKey.values())
    } catch {
      return entries
    }
  }

  async requestAvailabilityHints(requests, { timeoutMs = 250, maxPeers = 4 } = {}) {
    const peers = Array.from(this.feedConnections).slice(0, maxPeers)
    if (!Array.isArray(requests) || requests.length === 0 || peers.length === 0) return []

    const perPeer = peers.map((conn) => new Promise((resolve) => {
      const channel = this.peerChannels.get(conn)
      if (!channel) return resolve([])
      const requestId = `${Date.now()}:${this._nextAvailabilityRequestId++}`
      const timeout = setTimeout(() => {
        this.pendingAvailabilityRequests.delete(requestId)
        resolve([])
      }, timeoutMs)
      this.pendingAvailabilityRequests.set(requestId, {
        resolve: (hints) => {
          clearTimeout(timeout)
          resolve(Array.isArray(hints) ? hints : [])
        },
        timeout,
      })
      try {
        channel.messages[0].send({
          type: 'AVAILABILITY_HINT_REQUEST',
          requestId,
          requests,
        })
      } catch {
        clearTimeout(timeout)
        this.pendingAvailabilityRequests.delete(requestId)
        resolve([])
      }
    }))

    const settled = await Promise.allSettled(perPeer)
    const merged = new Map()
    for (const res of settled) {
      if (res.status !== 'fulfilled') continue
      for (const hint of res.value || []) {
        const key = `${hint?.driveKey || ''}:${hint?.id || ''}`
        if (!hint?.driveKey || !hint?.id) continue
        const prev = merged.get(key)
        if (!prev || prev.availability !== 'playable') {
          if (hint.availability === 'playable' || !prev) merged.set(key, hint)
        }
      }
    }
    return Array.from(merged.values())
  }

  _swarmPeerEntries() {
    const peers = this.swarm?.peers
    if (!peers) return []
    if (typeof peers.values === 'function') return Array.from(peers.values())
    if (typeof peers[Symbol.iterator] === 'function') return Array.from(peers)
    return []
  }

  _peerEntryMatchesKey(entry, keyHex) {
    if (!entry) return false
    if (typeof entry === 'string') return entry === keyHex
    if (b4a.isBuffer(entry) || entry instanceof Uint8Array) {
      return b4a.toString(entry, 'hex') === keyHex
    }
    const publicKey = entry.publicKey || entry.remotePublicKey || entry.key
    if (publicKey && (b4a.isBuffer(publicKey) || publicKey instanceof Uint8Array)) {
      return b4a.toString(publicKey, 'hex') === keyHex
    }
    return false
  }

  _hasKnownPeer(keyHex) {
    const peers = this.swarm?.peers
    if (!peers) return false
    if (typeof peers.has === 'function' && peers.has(keyHex)) return true
    for (const entry of this._swarmPeerEntries()) {
      if (this._peerEntryMatchesKey(entry, keyHex)) return true
    }
    return false
  }

  /**
   * Remember a discovered peer and explicitly dial it when the shared topic has
   * found peers but Hyperswarm has not promoted them into connections yet.
   * This keeps the hard-cutover architecture on one topic while making the
   * Protomux feed channel less dependent on passive connection timing.
   * @param {any} peer
   * @returns {boolean}
   */
  handleDiscoveredPeer(peer) {
    const publicKey = peer?.publicKey
    if (!publicKey || !this.swarm || typeof this.swarm.joinPeer !== 'function') return false

    const keyHex = b4a.toString(publicKey, 'hex')
    if (!keyHex || keyHex === b4a.toString(this.swarm.keyPair?.publicKey || [], 'hex')) return false
    this._discoveredPeers.set(keyHex, publicKey)
    if (this._hasKnownPeer(keyHex)) return false

    return this._dialDiscoveredPeer(keyHex, publicKey)
  }

  _dialDiscoveredPeer(keyHex, publicKey, attempts = this._directPeerRetryCounts.get(keyHex) || 0, { force = false } = {}) {
    if (!publicKey || !this.swarm || typeof this.swarm.joinPeer !== 'function') return false
    if (!keyHex || keyHex === b4a.toString(this.swarm.keyPair?.publicKey || [], 'hex')) return false
    if (this._hasKnownPeer(keyHex)) return false
    if ((this.swarm.connections?.size || 0) >= this._maxDirectPeers) return false
    if (!force && attempts >= this._maxDirectPeerRetries) return false

    try {
      this.swarm.joinPeer(publicKey)
      this._directPeerRetryCounts.set(keyHex, attempts + 1)
      console.log('[PublicFeed] Direct peer dial queued from shared topic:', keyHex.slice(0, 16), 'attempt=', attempts + 1)
      return true
    } catch (err) {
      console.log('[PublicFeed] Direct peer dial failed:', keyHex.slice(0, 16), err?.message)
      return false
    }
  }

  _redialDiscoveredPeers({ force = false } = {}) {
    if (!this._discoveredPeers.size || !this.swarm || typeof this.swarm.joinPeer !== 'function') return 0
    let dialed = 0
    for (const [keyHex, publicKey] of this._discoveredPeers) {
      if ((this.swarm.connections?.size || 0) >= this._maxDirectPeers) break
      const attempts = this._directPeerRetryCounts.get(keyHex) || 0
      if (this._dialDiscoveredPeer(keyHex, publicKey, attempts, { force })) dialed++
    }
    return dialed
  }

  /**
   * Start the public feed manager - restore cache and wire current connections
   */
  async start() {
    if (this.started) return;
    this.started = true;
    console.log('[PublicFeed] ===== STARTING PUBLIC FEED =====');

    // Load persisted published channels from database
    // Try new format first (with publicBeeKey), fall back to legacy format
    if (this.metaDb) {
      try {
        // Try new format: array of {driveKey, publicBeeKey} objects
        const dataV2 = await this.metaDb.get('published-channels-v2').catch(() => null);
        if (dataV2?.value && Array.isArray(dataV2.value) && dataV2.value.length) {
          for (const item of dataV2.value) {
            const key = typeof item === 'string' ? item : item.driveKey;
            const publicBeeKey = typeof item === 'object' ? item.publicBeeKey : null;
            if (key) {
              this.publishedChannels.add(key);
              // Add to entries WITH publicBeeKey so HAVE_FEED includes it
              this.addEntry(key, 'local', publicBeeKey, item);
            }
          }
          console.log('[PublicFeed] Loaded', this.publishedChannels.size, 'published channels from db (v2 format)');
        } else {
          // Fall back to legacy format: array of keys
          const data = await this.metaDb.get('published-channels').catch(() => null);
          if (data?.value) {
            for (const key of data.value) {
              this.publishedChannels.add(key);
              // Add to entries (no publicBeeKey - will be updated when channel is loaded)
              this.addEntry(key, 'local');
            }
            console.log('[PublicFeed] Loaded', this.publishedChannels.size, 'published channels from db (legacy format)');
          }
        }
      } catch (err) {
        console.error('[PublicFeed] Failed to load published channels:', err.message);
      }
    }

    // Restore cached discovered feed entries (best-effort).
    // Prefer new format (discovered-channels-v2) which includes publicBeeKey.
    if (this.metaDb) {
      try {
        let restored = 0

        // Try new format first (with publicBeeKey)
        const cachedV2 = await this.metaDb.get('discovered-channels-v2').catch(() => null)
        if (cachedV2?.value && Array.isArray(cachedV2.value) && cachedV2.value.length) {
          for (const entry of cachedV2.value) {
            if (entry.driveKey && this.addEntry(entry.driveKey, 'peer', entry.publicBeeKey, entry)) {
              restored++
            }
          }
          if (restored > 0) {
            console.log('[PublicFeed] Restored', restored, 'cached discovered channels (v2 format with publicBeeKey)')
          }
        } else {
          // Fallback to legacy formats
          const cached =
            (await this.metaDb.get('discovered-channels').catch(() => null)) ||
            (await this.metaDb.get('public-feed-cache').catch(() => null))
          const keys = cached?.value || []
          if (Array.isArray(keys) && keys.length) {
            for (const key of keys) {
              if (this.addEntry(key, 'peer')) restored++
            }
            if (restored > 0) {
              console.log('[PublicFeed] Restored', restored, 'cached discovered channels (legacy format)')
            }
          }
        }
      } catch (err) {
        console.log('[PublicFeed] Discovered-channel cache restore skipped:', err?.message)
      }
    }

    // If we loaded any entries from disk, notify listeners so UIs don't stay empty until the first peer message arrives.
    if (this.entries.size > 0) {
      console.log('[PublicFeed] Notifying listeners of', this.entries.size, 'restored entries');
      try { this.onFeedUpdate?.(); } catch {}
    }

    const feedTopic = crypto.data(b4a.from(NETWORK_TOPIC_STRING, 'utf-8'))
    try {
      this.feedDiscovery = this.swarm.join(feedTopic, { server: true, client: true })
      this.feedDiscovery?.flushed?.().then(() => {
        console.log('[PublicFeed] Shared network feed discovery flushed, connections:', this.swarm.connections?.size || 0)
      }).catch(() => {})
      console.log('[PublicFeed] Joined shared network feed topic:', b4a.toString(feedTopic, 'hex').slice(0, 16))
    } catch (err) {
      console.log('[PublicFeed] Shared network feed topic join failed:', err?.message)
      this.feedDiscovery = null
    }

    // Set up feed protocol on any existing connections.
    const existingConns = this.swarm.connections?.size || 0;
    console.log('[PublicFeed] Setting up feed protocol on', existingConns, 'existing connections');
    for (const conn of this.swarm.connections) {
      this.handleConnection(conn, {});
    }
    this._startGossipLoop()
    console.log('[PublicFeed] ===== PUBLIC FEED STARTED =====');
  }

  _startGossipLoop() {
    if (this._gossipInterval) return
    try {
      this._gossipInterval = setInterval(() => {
        if (!this.started) return
        const redialed = this._redialDiscoveredPeers()
        if (this.peerChannels.size === 0) {
          if (redialed) {
            console.log('[PublicFeed] Periodic feed gossip announced= 0 requested= 0 redialed=', redialed)
          }
          return
        }
        let announced = 0
        for (const conn of this.peerChannels.keys()) {
          try {
            this.sendHaveFeed(conn)
            announced++
          } catch (err) {
            console.log('[PublicFeed] periodic HAVE_FEED failed:', err?.message)
          }
        }
        const requested = this.requestFeedsFromPeers()
        if (announced || requested || redialed) {
          console.log('[PublicFeed] Periodic feed gossip announced=', announced, 'requested=', requested, 'redialed=', redialed)
        }
      }, this._gossipIntervalMs)
      if (typeof this._gossipInterval?.unref === 'function') this._gossipInterval.unref()
    } catch (err) {
      console.log('[PublicFeed] Periodic feed gossip setup failed:', err?.message)
    }
  }

  /**
   * Stop public feed discovery (best-effort).
   * Not currently used by the app, but helpful for tests / future lifecycle hooks.
   */
  stop() {
    this.started = false;
    this.wiredConnections.clear();
    this.peerChannels.clear();
    this.peerFeedKeys.clear();
    this.entryPeerCounts.clear();
    this.feedConnections.clear();
    try {
      for (const pending of this.pendingAvailabilityRequests.values()) {
        try { clearTimeout(pending.timeout) } catch {}
        try { pending.resolve([]) } catch {}
      }
      this.pendingAvailabilityRequests.clear()
      this._directPeerRetryCounts.clear()
      this._discoveredPeers.clear()
      if (this._persistTimer) clearTimeout(this._persistTimer)
      if (this._gossipInterval) clearInterval(this._gossipInterval)
      this.feedDiscovery?.destroy?.()
    } catch {}
    this._persistTimer = null
    this._gossipInterval = null
    this.feedDiscovery = null
  }

  /**
   * Debounced persistence of discovered feed keys.
   * This is best-effort and should never block UI/replication.
   */
  _schedulePersistDiscovered() {
    if (!this.metaDb) return
    try {
      if (this._persistTimer) clearTimeout(this._persistTimer)
      this._persistTimer = setTimeout(() => {
        this._persistTimer = null
        this._persistDiscoveredNow().catch(() => {})
      }, this._persistDebounceMs)
    } catch {}
  }

  async _persistDiscoveredNow() {
    if (!this.metaDb) return
    try {
      const isValidKey = (k) => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)
      // Persist only live peer-discovered channels plus all local/published channels.
      const entries = this.getFeed()
        .filter((e) => e.source === 'local' || (e.peerCount || 0) > 0 || isValidKey(e.publicBeeKey))
        .slice(0, this._persistMaxEntries)
        .map(e => ({
          driveKey: e.driveKey,
          publicBeeKey: e.publicBeeKey || null,
          channelName: e.channelName || null,
          videoCount: Number(e.videoCount || 0) || 0,
          manifestUpdatedAt: Number(e.manifestUpdatedAt || 0) || 0,
          previewVideos: this._sanitizePreviewVideos(e.previewVideos),
        }))
      await this.metaDb.put('discovered-channels-v2', entries)

      // Also keep legacy keys array for backward compatibility
      const keys = entries.map(e => e.driveKey)
      await this.metaDb.put('discovered-channels', keys)
      await this.metaDb.put('public-feed-cache', keys)
    } catch (err) {
      console.log('[PublicFeed] Discovered-channel cache persist skipped:', err?.message)
    }
  }

  /**
   * Handle a new connection - called from main swarm connection handler
   * This ensures all connections get the feed protocol, not just those after start()
   * @param {any} conn - Connection
   * @param {any} info - Connection info
   */
  handleConnection(conn, info) {
    if (!conn || this.wiredConnections.has(conn)) {
      console.log('[PublicFeed] handleConnection: already wired for this connection');
      return;
    }

    console.log('[PublicFeed] handleConnection: setting up feed protocol on new connection');
    this.wiredConnections.add(conn);

    let mux;
    try {
      mux = Protomux.from(conn);
    } catch (err) {
      this.wiredConnections.delete(conn);
      console.log('[PublicFeed] Protomux.from failed (non-fatal):', err?.message);
      return;
    }

    mux.pair({ protocol: PROTOCOL_NAME }, () => {
      this.createFeedChannel(mux, conn);
    });

    this.setupFeedProtocol(conn, mux);
  }

  setupFeedProtocol(conn, mux) {
    console.log('[PublicFeed] setupFeedProtocol: creating feed channel from our side');
    this.createFeedChannel(mux, conn);

    // Clean up on connection close
    conn.on('close', () => {
      console.log('[PublicFeed] Connection closed');
      this._clearPeerFeedKeys(conn);
      this.wiredConnections.delete(conn);
      this.peerChannels.delete(conn);
      this.feedConnections.delete(conn);
    });

    conn.on('error', (err) => {
      console.error('[PublicFeed] Connection error:', err.message);
      this._clearPeerFeedKeys(conn);
      this.wiredConnections.delete(conn);
      this.peerChannels.delete(conn);
      this.feedConnections.delete(conn);
    });
  }

  /**
   * Create a feed channel on the mux
   * @param {any} mux
   * @param {any} conn
   */
  createFeedChannel(mux, conn) {
    // Check if we already have a channel for this connection
    if (this.peerChannels.has(conn)) {
      console.log('[PublicFeed] createFeedChannel: already have channel for this connection');
      return;
    }

    console.log('[PublicFeed] createFeedChannel: creating channel with protocol:', PROTOCOL_NAME);

    // Create channel with messages defined in options
    let channel;
    try {
      channel = mux.createChannel({
      protocol: PROTOCOL_NAME,
      messages: [{
        encoding: c.json,
      onmessage: (msg) => {
        log.debug('Received message', { type: msg?.type, keys: msg?.keys?.length || 0 })
        try {
          this.handleMessage(msg, conn);
        } catch (err) {
          console.log('[PublicFeed] handleMessage failed (non-fatal):', err?.message);
        }
      }
      }],
      onopen: () => {
        console.log('[PublicFeed] Feed channel opened! Total feed connections:', this.feedConnections.size + 1);
        this.feedConnections.add(conn);
        try {
          this.onFeedConnectionOpen?.(conn);
        } catch {}
        // Immediately send our feed when channel opens.
        try {
          this.sendHaveFeed(conn);
        } catch (err) {
          console.log('[PublicFeed] sendHaveFeed failed on open (non-fatal):', err?.message);
        }
        // Also immediately request the peer's current feed snapshot so discovery
        // does not wait for the next periodic refresh cycle.
        try {
          channel.messages[0].send({ type: 'NEED_FEED' })
          console.log('[PublicFeed] Sent NEED_FEED on channel open')
        } catch (err) {
          console.log('[PublicFeed] NEED_FEED on open failed (non-fatal):', err?.message)
        }
      },
      onclose: () => {
        console.log('[PublicFeed] Feed channel closed');
        this._clearPeerFeedKeys(conn);
        this.peerChannels.delete(conn);
        this.feedConnections.delete(conn);
      }
    });
    } catch (err) {
      console.log('[PublicFeed] createChannel failed (non-fatal):', err?.message);
      return;
    }

    if (!channel) {
      console.log('[PublicFeed] Channel already exists or failed to create');
      return;
    }

    console.log('[PublicFeed] createFeedChannel: channel created, storing and opening');

    // Store the channel
    this.peerChannels.set(conn, channel);

    // Open the channel
    try {
      channel.open();
      console.log('[PublicFeed] createFeedChannel: channel.open() called');
    } catch (err) {
      console.log('[PublicFeed] channel.open failed (non-fatal):', err?.message);
      this.peerChannels.delete(conn);
    }
  }

  /**
   * Send HAVE_FEED with all our known entries (including publicBeeKey)
   * @param {any} conn
   */
  sendHaveFeed(conn) {
    const channel = this.peerChannels.get(conn);
    if (!channel) {
      console.log('[PublicFeed] No channel for connection, cannot send HAVE_FEED');
      return;
    }

    const isValidKey = (k) => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)

    // Pre-alpha: the public feed is PublicBee-only. We only advertise entries
    // that include a valid publicBeeKey so viewers can fetch instantly without Autobase.
    const baseEntries = Array.from(this.entries.values())
      .filter(e => isValidKey(e.publicBeeKey))
      .map((entry) => this._serializeEntry(entry))

    const sendEntries = (entries) => {
      const keys = entries.map(e => e.driveKey)
      const msg = { type: 'HAVE_FEED', keys, entries }

      console.log('[PublicFeed] Sending HAVE_FEED with', keys.length, 'entries');
      try {
        channel.messages[0].send(msg);
        console.log('[PublicFeed] HAVE_FEED sent successfully');
      } catch (err) {
        console.error('[PublicFeed] Failed to send HAVE_FEED:', err.message);
      }
    }

    sendEntries(baseEntries)
    if (!this.feedSnapshotProvider) return

    const baseEntriesHash = hashFeedEntries(baseEntries)
    void this._resolveFeedSnapshots(baseEntries, conn)
      .then((entries) => {
        if (hashFeedEntries(entries) !== baseEntriesHash) {
          sendEntries(entries)
        }
      })
      .catch(() => {})
  }

  _setPeerFeedKeys(conn, keys) {
    const nextKeys = new Set((keys || []).filter(Boolean))
    const prevKeys = this.peerFeedKeys.get(conn) || new Set()
    const changed = nextKeys.size !== prevKeys.size || Array.from(nextKeys).some((key) => !prevKeys.has(key))

    if (!changed) return false

    for (const key of prevKeys) {
      const nextCount = Math.max(0, (this.entryPeerCounts.get(key) || 0) - 1)
      if (nextCount > 0) this.entryPeerCounts.set(key, nextCount)
      else this.entryPeerCounts.delete(key)
    }

    for (const key of nextKeys) {
      this.entryPeerCounts.set(key, (this.entryPeerCounts.get(key) || 0) + 1)
    }

    this.peerFeedKeys.set(conn, nextKeys)
    return true
  }

  _clearPeerFeedKeys(conn) {
    const prevKeys = this.peerFeedKeys.get(conn)
    if (!prevKeys) return false

    let pruned = false
    let changed = false
    for (const key of prevKeys) {
      changed = true
      const nextCount = Math.max(0, (this.entryPeerCounts.get(key) || 0) - 1)
      if (nextCount > 0) {
        this.entryPeerCounts.set(key, nextCount)
      } else {
        this.entryPeerCounts.delete(key)
        const entry = this.entries.get(key)
        // Keep cached peer-discovered channels if they have a valid publicBeeKey.
        // This lets discovery/feed hydration continue to show cached channels and
        // videos even when no live peer is currently connected.
        const keepCachedPeerEntry =
          entry?.source === 'peer' &&
          typeof entry?.publicBeeKey === 'string' &&
          /^[a-f0-9]{64}$/i.test(entry.publicBeeKey)

        if (entry?.source === 'peer' && !keepCachedPeerEntry) {
          this.entries.delete(key)
          pruned = true
        }
      }
    }

    this.peerFeedKeys.delete(conn)
    if (pruned) this._schedulePersistDiscovered()
    if (changed) {
      try { this.onFeedUpdate?.() } catch {}
    }
    return changed
  }

  /**
   * Handle incoming feed protocol messages
   * @param {Object} msg
   * @param {any} conn
   */
  handleMessage(msg, conn) {
    log.debug('handleMessage', { type: msg?.type })

    // Handle HAVE_FEED - peer is sharing their known channels
    if (msg.type === 'HAVE_FEED') {
      let added = 0;
      let updated = 0;
      const isValidKey = (k) => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)
      let announcedKeys = []
      let receivedCount = 0

      // Prefer new entries format (with publicBeeKey)
      if (msg.entries && Array.isArray(msg.entries)) {
      log.debug('HAVE_FEED received (entries)', { count: msg.entries.length })
        receivedCount = msg.entries.length
        for (const entry of msg.entries) {
          if (!entry?.driveKey || !isValidKey(entry.publicBeeKey)) continue
          announcedKeys.push(entry.driveKey)
          if (this.addEntry(entry.driveKey, 'peer', entry.publicBeeKey, entry)) {
            added++;
          } else if (this._applyEntrySnapshot(entry.driveKey, entry)) {
            updated++;
          }
        }
      }
      // Fallback to legacy keys array
      else if (msg.keys && Array.isArray(msg.keys)) {
      log.debug('HAVE_FEED received (legacy keys)', { count: msg.keys.length })
        receivedCount = msg.keys.length
        for (const key of msg.keys) {
          if (!key) continue
          announcedKeys.push(key)
          if (this.addEntry(key, 'peer')) {
            added++;
          }
        }
      }

      const peerSetChanged = this._setPeerFeedKeys(conn, announcedKeys)
      try {
        this.onFeedSync?.({ type: 'HAVE_FEED', added, received: receivedCount });
      } catch {}

    log.debug('Merged feed entries', { added, total: this.entries.size })
      if (added > 0 || updated > 0 || peerSetChanged) {
        this.onFeedUpdate?.();
        this._schedulePersistDiscovered()
      }
    }
    // Handle SUBMIT_CHANNEL - peer is broadcasting a new channel
    else if (msg.type === 'SUBMIT_CHANNEL' && msg.key) {
      console.log('[PublicFeed] SUBMIT_CHANNEL received:', msg.key?.slice(0, 16), 'publicBee:', msg.publicBeeKey?.slice(0, 16) || 'none');
      const isValidKey = (k) => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)
      if (!isValidKey(msg.publicBeeKey)) return
      if (this.addEntry(msg.key, 'peer', msg.publicBeeKey, msg)) {
        this.onFeedUpdate?.();
        this._schedulePersistDiscovered()
        // Re-gossip to other peers (exclude sender, include publicBeeKey)
        this.broadcastSubmitChannel(msg.key, conn, msg.publicBeeKey, msg);
      } else if (this._applyEntrySnapshot(msg.key, msg)) {
        this.onFeedUpdate?.()
        this._schedulePersistDiscovered()
      }
    }
    // Handle legacy NEED_FEED/FEED_RESPONSE for backwards compat
    else if (msg.type === 'NEED_FEED') {
      console.log('[PublicFeed] NEED_FEED received, sending our feed');
      this.sendHaveFeed(conn);
    }
    else if (msg.type === 'FEED_RESPONSE' && msg.keys) {
      console.log('[PublicFeed] FEED_RESPONSE received with', msg.keys?.length || 0, 'keys');
      let added = 0;
      for (const key of msg.keys) {
        if (this.addEntry(key, 'peer')) {
          added++;
        }
      }
      try {
        this.onFeedSync?.({ type: 'FEED_RESPONSE', added, received: msg.keys.length });
      } catch {}
      if (added > 0) {
        this.onFeedUpdate?.();
        this._schedulePersistDiscovered()
      }
    }
    else if (msg.type === 'AVAILABILITY_HINT_REQUEST' && msg.requestId && Array.isArray(msg.requests)) {
      (async () => {
        try {
          const hints = this.availabilityHintProvider
            ? await this.availabilityHintProvider(msg.requests, conn)
            : []
          const channel = this.peerChannels.get(conn)
          if (!channel) return
          channel.messages[0].send({
            type: 'AVAILABILITY_HINT_RESPONSE',
            requestId: msg.requestId,
            hints: Array.isArray(hints) ? hints : [],
          })
        } catch {}
      })()
    }
    else if (msg.type === 'AVAILABILITY_HINT_RESPONSE' && msg.requestId) {
      const pending = this.pendingAvailabilityRequests.get(msg.requestId)
      if (!pending) return
      this.pendingAvailabilityRequests.delete(msg.requestId)
      try { clearTimeout(pending.timeout) } catch {}
      pending.resolve(msg.hints || [])
    }
    else {
      console.log('[PublicFeed] Unknown message type:', msg?.type);
    }
  }

  /**
   * Add an entry to the feed (returns true if new)
   * @param {string} driveKey
   * @param {'peer'|'local'} source
   * @param {string} [publicBeeKey] - The public Hyperbee key (for viewers to load)
   * @returns {boolean}
   */
  addEntry(driveKey, source, publicBeeKey = null, snapshot = null) {
    const isValidKey = (k) => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)

    // Accept legacy peer entries even if they don't include a PublicBee key yet.
    // Prefer keyed entries when available, but do not drop the channel entirely —
    // older peers may still announce only drive keys, and we can hydrate via
    // channel/autobase fallback once the feed entry is visible.

    // Skip if already exists or hidden
    if (this.entries.has(driveKey) || this.hiddenKeys.has(driveKey)) {
      // Update publicBeeKey if we didn't have it before
      const existing = this.entries.get(driveKey)
      if (existing && !existing.publicBeeKey && isValidKey(publicBeeKey)) {
        existing.publicBeeKey = publicBeeKey
        this._schedulePersistDiscovered()
      }
      if (existing && snapshot && this._applyEntrySnapshot(driveKey, {
        ...snapshot,
        publicBeeKey: isValidKey(publicBeeKey) ? publicBeeKey : existing.publicBeeKey || null,
      })) {
        this._schedulePersistDiscovered()
      }
      return false;
    }

    // Validate key format (should be 64 char hex)
    if (!/^[a-f0-9]{64}$/i.test(driveKey)) {
      console.warn('[PublicFeed] Invalid driveKey format:', driveKey.slice(0, 16));
      return false;
    }

    this.entries.set(driveKey, {
      driveKey,
      publicBeeKey: isValidKey(publicBeeKey) ? publicBeeKey : null, // Key for viewers to use (auto-replicating Hyperbee)
      addedAt: Date.now(),
      source,
      peerCount: source === 'local' ? 1 : 0,
      channelName: snapshot?.channelName || null,
      videoCount: Number(snapshot?.videoCount || 0) || 0,
      manifestUpdatedAt: Number(snapshot?.manifestUpdatedAt || 0) || 0,
      previewVideos: this._sanitizePreviewVideos(snapshot?.previewVideos),
    });

    // Persist (debounced) so restarts retain discovered keys.
    this._schedulePersistDiscovered()

    return true;
  }

  /**
   * Submit a channel to the public feed
   * @param {string} driveKey - The Autobase channel key
   * @param {string} [publicBeeKey] - The public Hyperbee key (for viewers)
   */
  async submitChannel(driveKey, publicBeeKey = null) {
    if (this.addEntry(driveKey, 'local', publicBeeKey)) {
      console.log('[PublicFeed] Submitted local channel:', driveKey.slice(0, 16), 'publicBee:', publicBeeKey?.slice(0, 16) || 'none');
      this.onFeedUpdate?.();
    } else if (publicBeeKey) {
      // Entry existed but we're adding publicBeeKey
      const entry = this.entries.get(driveKey)
      if (entry && !entry.publicBeeKey) {
        entry.publicBeeKey = publicBeeKey
        console.log('[PublicFeed] Updated existing entry with publicBeeKey:', publicBeeKey.slice(0, 16));
      }
    }

    let snapshot = null
    if (this.feedSnapshotProvider) {
      const resolved = await this._resolveFeedSnapshots([{ driveKey, publicBeeKey }], null).catch(() => null)
      snapshot = Array.isArray(resolved) ? resolved[0] || null : null
    }

    // Persist to database so it survives restart (use v2 format with publicBeeKey)
    if (!this.publishedChannels.has(driveKey)) {
      this.publishedChannels.add(driveKey);
    }
    await this._persistPublishedChannels();

    // Broadcast to all peers (include publicBeeKey)
    this.broadcastSubmitChannel(driveKey, null, publicBeeKey, snapshot);
    this._schedulePersistDiscovered()
  }

  /**
   * Persist published channels to database in v2 format (with publicBeeKey)
   * @private
   */
  async _persistPublishedChannels() {
    if (!this.metaDb) return;
    try {
      // Build v2 format: array of {driveKey, publicBeeKey} objects
      const publishedArray = [];
      for (const driveKey of this.publishedChannels) {
        const entry = this.entries.get(driveKey);
        publishedArray.push({
          driveKey,
          publicBeeKey: entry?.publicBeeKey || null,
          channelName: entry?.channelName || null,
          videoCount: Number(entry?.videoCount || 0) || 0,
          manifestUpdatedAt: Number(entry?.manifestUpdatedAt || 0) || 0,
          previewVideos: this._sanitizePreviewVideos(entry?.previewVideos),
        });
      }
      await this.metaDb.put('published-channels-v2', publishedArray);
      // Also update legacy format for backwards compatibility
      await this.metaDb.put('published-channels', Array.from(this.publishedChannels));
      console.log('[PublicFeed] Persisted', publishedArray.length, 'published channels to db (v2 format)');
    } catch (err) {
      console.error('[PublicFeed] Failed to persist published channels:', err.message);
    }
  }

  /**
   * Unpublish a channel from the public feed
   * @param {string} driveKey
   */
  async unpublishChannel(driveKey) {
    // Remove from published set
    this.publishedChannels.delete(driveKey);

    // Remove from entries (so it doesn't appear in local feed)
    this.entries.delete(driveKey);

    // Persist to database (v2 format)
    await this._persistPublishedChannels();
    console.log('[PublicFeed] Unpublished channel:', driveKey.slice(0, 16));

    this.onFeedUpdate?.();
    this._schedulePersistDiscovered()
  }

  /**
   * Check if a channel is published by the user
   * @param {string} driveKey
   * @returns {boolean}
   */
  isChannelPublished(driveKey) {
    return this.publishedChannels.has(driveKey);
  }

  /**
   * Broadcast SUBMIT_CHANNEL to peers (optionally excluding one)
   * @param {string} driveKey
   * @param {any} [excludeConn]
   * @param {string} [publicBeeKey] - The public Hyperbee key for viewers
   */
  broadcastSubmitChannel(driveKey, excludeConn, publicBeeKey = null, snapshot = null) {
    const msg = {
      type: 'SUBMIT_CHANNEL',
      key: driveKey,
      publicBeeKey: publicBeeKey || null,
      channelName: snapshot?.channelName || null,
      videoCount: Number(snapshot?.videoCount || 0) || 0,
      manifestUpdatedAt: Number(snapshot?.manifestUpdatedAt || 0) || 0,
      previewVideos: this._sanitizePreviewVideos(snapshot?.previewVideos),
    };

    let sent = 0;
    for (const [conn, channel] of this.peerChannels) {
      if (conn === excludeConn) continue;
      try {
        channel.messages[0].send(msg);
        sent++;
      } catch (err) {
        console.error('[PublicFeed] Failed to broadcast channel:', err.message);
      }
    }

    console.log('[PublicFeed] Broadcast SUBMIT_CHANNEL to', sent, 'peers (publicBee:', publicBeeKey?.slice(0, 16) || 'none', ')');
  }

  /**
   * Request feeds from all connected peers by re-sending our HAVE_FEED
   * This triggers peers to respond with their current feeds
   * @returns {number} Number of peers contacted
   */
  requestFeedsFromPeers() {
    console.log('[PublicFeed] ===== REQUESTING FEEDS FROM PEERS =====');
    let sent = 0;
    for (const [conn, channel] of this.peerChannels) {
      try {
        // Request the peer's current feed snapshot. Re-sending our own HAVE_FEED
        // here does not make the peer reply; NEED_FEED does.
        channel.messages[0].send({ type: 'NEED_FEED' })
        sent++;
      } catch (err) {
        console.log('[PublicFeed] NEED_FEED request failed:', err?.message)
      }
    }
    console.log('[PublicFeed] Sent NEED_FEED to', sent, 'peers');
    return sent;
  }

  /**
   * Hide a channel locally
   * @param {string} driveKey
   */
  hideChannel(driveKey) {
    this.hiddenKeys.add(driveKey);
    this.entries.delete(driveKey);
    console.log('[PublicFeed] Hidden channel:', driveKey.slice(0, 16));
    this._schedulePersistDiscovered()
  }

  /**
   * Get the current feed (filtered by hidden)
   * @returns {PublicFeedEntry[]}
   */
  getFeed() {
    return Array.from(this.entries.values())
      .filter(e => !this.hiddenKeys.has(e.driveKey))
      .map((entry) => ({
        ...entry,
        peerCount: entry.source === 'local'
          ? Math.max(1, this.entryPeerCounts.get(entry.driveKey) || 0)
          : (this.entryPeerCounts.get(entry.driveKey) || 0)
      }))
      .filter((entry) => {
        // Local channels always stay visible.
        if (entry.source === 'local') return true
        // Peer-discovered channels with live peers are visible.
        if ((entry.peerCount || 0) > 0) return true
        // IMPORTANT: keep cached peer-discovered channels visible if they carry
        // a valid publicBeeKey. This is what allows the app to hydrate/feed-load
        // instantly on restart instead of coming up empty until a live gossip peer
        // is connected again.
        return typeof entry.publicBeeKey === 'string' && /^[a-f0-9]{64}$/i.test(entry.publicBeeKey)
      })
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  /**
   * Get feed statistics
   * @returns {{totalEntries: number, hiddenCount: number, peerCount: number}}
   */
  getStats() {
    return {
      totalEntries: this.entries.size,
      hiddenCount: this.hiddenKeys.size,
      peerCount: this.peerChannels.size
    };
  }
}
