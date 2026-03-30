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
import { PROTOCOL_NAME } from './types.js';
import { logger } from './logger.js'

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
    /** @type {Set<any>} Active feed connections */
    this.feedConnections = new Set();
    /** @type {Set<any>} Connections already wired for the feed protocol */
    this.wiredConnections = new Set();
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
              this.addEntry(key, 'local', publicBeeKey);
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
            if (entry.driveKey && this.addEntry(entry.driveKey, 'peer', entry.publicBeeKey)) {
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

    // Set up feed protocol on any existing connections.
    const existingConns = this.swarm.connections?.size || 0;
    console.log('[PublicFeed] Setting up feed protocol on', existingConns, 'existing connections');
    for (const conn of this.swarm.connections) {
      this.handleConnection(conn, {});
    }
    console.log('[PublicFeed] ===== PUBLIC FEED STARTED =====');
  }

  /**
   * Stop public feed discovery (best-effort).
   * Not currently used by the app, but helpful for tests / future lifecycle hooks.
   */
  stop() {
    this.started = false;
    this.wiredConnections.clear();
    this.peerChannels.clear();
    this.feedConnections.clear();
    try {
      if (this._persistTimer) clearTimeout(this._persistTimer)
    } catch {}
    this._persistTimer = null
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
      // Store entries with publicBeeKey (new format)
      const entries = Array.from(this.entries.values())
        .slice(0, this._persistMaxEntries)
        .map(e => ({
          driveKey: e.driveKey,
          publicBeeKey: e.publicBeeKey || null
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
      this.wiredConnections.delete(conn);
      this.peerChannels.delete(conn);
      this.feedConnections.delete(conn);
    });

    conn.on('error', (err) => {
      console.error('[PublicFeed] Connection error:', err.message);
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
        // Immediately send our feed when channel opens
        try {
          this.sendHaveFeed(conn);
        } catch (err) {
          console.log('[PublicFeed] sendHaveFeed failed on open (non-fatal):', err?.message);
        }
      },
      onclose: () => {
        console.log('[PublicFeed] Feed channel closed');
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
    const values = Array.from(this.entries.values()).filter(e => isValidKey(e.publicBeeKey))
    const keys = values.map(e => e.driveKey)
    const entries = values.map(e => ({
      driveKey: e.driveKey,
      publicBeeKey: e.publicBeeKey
    }))
    const msg = { type: 'HAVE_FEED', keys, entries };

    console.log('[PublicFeed] Sending HAVE_FEED with', keys.length, 'entries');
    try {
      channel.messages[0].send(msg);
      console.log('[PublicFeed] HAVE_FEED sent successfully');
    } catch (err) {
      console.error('[PublicFeed] Failed to send HAVE_FEED:', err.message);
    }
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
      const isValidKey = (k) => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)

      // Prefer new entries format (with publicBeeKey)
      if (msg.entries && Array.isArray(msg.entries)) {
      log.debug('HAVE_FEED received (entries)', { count: msg.entries.length })
        for (const entry of msg.entries) {
          if (entry.driveKey && isValidKey(entry.publicBeeKey) && this.addEntry(entry.driveKey, 'peer', entry.publicBeeKey)) {
            added++;
          }
        }
        try {
          this.onFeedSync?.({ type: 'HAVE_FEED', added, received: msg.entries.length });
        } catch {}
      }
      // Fallback to legacy keys array
      else if (msg.keys && Array.isArray(msg.keys)) {
      log.debug('HAVE_FEED received (legacy keys)', { count: msg.keys.length })
        for (const key of msg.keys) {
          if (this.addEntry(key, 'peer')) {
            added++;
          }
        }
        try {
          this.onFeedSync?.({ type: 'HAVE_FEED', added, received: msg.keys.length });
        } catch {}
      }

    log.debug('Merged feed entries', { added, total: this.entries.size })
      if (added > 0) {
        this.onFeedUpdate?.();
        this._schedulePersistDiscovered()
      }
    }
    // Handle SUBMIT_CHANNEL - peer is broadcasting a new channel
    else if (msg.type === 'SUBMIT_CHANNEL' && msg.key) {
      console.log('[PublicFeed] SUBMIT_CHANNEL received:', msg.key?.slice(0, 16), 'publicBee:', msg.publicBeeKey?.slice(0, 16) || 'none');
      const isValidKey = (k) => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)
      if (!isValidKey(msg.publicBeeKey)) return
      if (this.addEntry(msg.key, 'peer', msg.publicBeeKey)) {
        this.onFeedUpdate?.();
        this._schedulePersistDiscovered()
        // Re-gossip to other peers (exclude sender, include publicBeeKey)
        this.broadcastSubmitChannel(msg.key, conn, msg.publicBeeKey);
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
  addEntry(driveKey, source, publicBeeKey = null) {
    const isValidKey = (k) => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)

    // Pre-alpha: peer entries must include a PublicBee key.
    if (source === 'peer' && !isValidKey(publicBeeKey)) {
      return false
    }

    // Skip if already exists or hidden
    if (this.entries.has(driveKey) || this.hiddenKeys.has(driveKey)) {
      // Update publicBeeKey if we didn't have it before
      const existing = this.entries.get(driveKey)
      if (existing && !existing.publicBeeKey && isValidKey(publicBeeKey)) {
        existing.publicBeeKey = publicBeeKey
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
      source
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

    // Persist to database so it survives restart (use v2 format with publicBeeKey)
    if (!this.publishedChannels.has(driveKey)) {
      this.publishedChannels.add(driveKey);
    }
    await this._persistPublishedChannels();

    // Broadcast to all peers (include publicBeeKey)
    this.broadcastSubmitChannel(driveKey, null, publicBeeKey);
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
          publicBeeKey: entry?.publicBeeKey || null
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
  broadcastSubmitChannel(driveKey, excludeConn, publicBeeKey = null) {
    const msg = {
      type: 'SUBMIT_CHANNEL',
      key: driveKey,
      publicBeeKey: publicBeeKey || null
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
    for (const [conn] of this.peerChannels) {
      this.sendHaveFeed(conn);
      sent++;
    }
    console.log('[PublicFeed] Sent HAVE_FEED to', sent, 'peers');
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
