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

import crypto from 'hypercore-crypto';
import b4a from 'b4a';
import Protomux from 'protomux';
import c from 'compact-encoding';
import { FEED_TOPIC_STRING, PROTOCOL_NAME } from './types.js';

/**
 * @typedef {import('./types.js').PublicFeedEntry} PublicFeedEntry
 */

export class PublicFeedManager {
  /**
   * @param {import('hyperswarm')} swarm - Hyperswarm instance
   */
  constructor(swarm) {
    this.swarm = swarm;
    // Generate deterministic topic from string
    this.feedTopic = crypto.data(b4a.from(FEED_TOPIC_STRING, 'utf-8'));
    /** @type {Map<string, PublicFeedEntry>} */
    this.entries = new Map();
    /** @type {Set<string>} */
    this.hiddenKeys = new Set();
    /** @type {Map<any, any>} conn → protomux channel */
    this.peerChannels = new Map();
    /** @type {Set<any>} Active feed connections */
    this.feedConnections = new Set();
    /** @type {(() => void) | null} */
    this.onFeedUpdate = null;

    console.log('[PublicFeed] ===== INITIALIZED =====');
    console.log('[PublicFeed] Topic hex:', b4a.toString(this.feedTopic, 'hex'));
  }

  /**
   * Set callback for when feed updates occur
   * @param {() => void} callback
   */
  setOnFeedUpdate(callback) {
    this.onFeedUpdate = callback;
  }

  /**
   * Start the public feed manager - join the topic
   * NOTE: Connection handling is done via handleConnection() called from main swarm handler
   */
  async start() {
    console.log('[PublicFeed] ===== STARTING FEED DISCOVERY =====');
    console.log('[PublicFeed] Topic hex:', b4a.toString(this.feedTopic, 'hex'));
    console.log('[PublicFeed] Swarm connections before join:', this.swarm.connections.size);

    // Join the public feed topic for discovery
    const discovery = this.swarm.join(this.feedTopic, { server: true, client: true });
    console.log('[PublicFeed] Waiting for topic flush...');
    await discovery.flushed();

    console.log('[PublicFeed] ===== TOPIC JOINED =====');
    console.log('[PublicFeed] Swarm connections after join:', this.swarm.connections.size);

    // Log status periodically for debugging
    setInterval(() => {
      console.log('[PublicFeed] Status: connections=', this.swarm.connections.size,
        'feedPeers=', this.feedConnections.size,
        'entries=', this.entries.size);
    }, 10000);

    // Also set up feed protocol on any EXISTING connections
    // (connections that came in before start() was called)
    console.log('[PublicFeed] Checking existing connections:', this.swarm.connections.size);
    for (const conn of this.swarm.connections) {
      console.log('[PublicFeed] Setting up feed on existing connection');
      this.handleConnection(conn, {});
    }
  }

  /**
   * Handle a new connection - called from main swarm connection handler
   * This ensures all connections get the feed protocol, not just those after start()
   * @param {any} conn - Connection
   * @param {any} info - Connection info
   */
  handleConnection(conn, info) {
    // Skip if we're already handling this connection
    if (this.peerChannels.has(conn)) {
      console.log('[PublicFeed] Connection already being handled, skipping');
      return;
    }

    const remoteKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : 'unknown';
    console.log('[PublicFeed] ===== SETTING UP PROTOMUX FEED PROTOCOL =====');
    console.log('[PublicFeed] Remote peer:', remoteKey);
    console.log('[PublicFeed] Current entries:', this.entries.size);

    this.setupFeedProtocol(conn);
  }

  /**
   * Set up the feed protocol on a connection using mux.pair() pattern
   * @param {any} conn
   */
  setupFeedProtocol(conn) {
    // Get or create Protomux instance for this connection
    const mux = Protomux.from(conn);

    // Use mux.pair() to handle when remote opens this protocol
    mux.pair({ protocol: PROTOCOL_NAME }, () => {
      console.log('[PublicFeed] Remote peer opening feed protocol');
      this.createFeedChannel(mux, conn);
    });

    // Also try to open from our side (one side will succeed first)
    this.createFeedChannel(mux, conn);

    // Clean up on connection close
    conn.on('close', () => {
      console.log('[PublicFeed] Connection closed');
      this.peerChannels.delete(conn);
      this.feedConnections.delete(conn);
    });

    conn.on('error', (err) => {
      console.error('[PublicFeed] Connection error:', err.message);
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
      return;
    }

    // Create channel with messages defined in options
    const channel = mux.createChannel({
      protocol: PROTOCOL_NAME,
      messages: [{
        encoding: c.json,
        onmessage: (msg) => {
          this.handleMessage(msg, conn);
        }
      }],
      onopen: () => {
        console.log('[PublicFeed] Feed channel opened!');
        this.feedConnections.add(conn);
        // Immediately send our feed when channel opens
        this.sendHaveFeed(conn);
      },
      onclose: () => {
        console.log('[PublicFeed] Feed channel closed');
        this.peerChannels.delete(conn);
        this.feedConnections.delete(conn);
      }
    });

    if (!channel) {
      console.log('[PublicFeed] Channel already exists or failed to create');
      return;
    }

    // Store the channel
    this.peerChannels.set(conn, channel);

    // Open the channel
    channel.open();
    console.log('[PublicFeed] Feed channel created and opening...');
  }

  /**
   * Send HAVE_FEED with all our known keys
   * @param {any} conn
   */
  sendHaveFeed(conn) {
    const channel = this.peerChannels.get(conn);
    if (!channel) {
      console.log('[PublicFeed] No channel for connection, cannot send HAVE_FEED');
      return;
    }

    const keys = Array.from(this.entries.keys());
    const msg = { type: 'HAVE_FEED', keys };

    try {
      channel.messages[0].send(msg);
      console.log('[PublicFeed] Sent HAVE_FEED with', keys.length, 'keys');
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
    // Handle HAVE_FEED - peer is sharing their known channels
    if (msg.type === 'HAVE_FEED' && msg.keys) {
      console.log('[PublicFeed] Received HAVE_FEED with', msg.keys.length, 'keys');
      let added = 0;
      for (const key of msg.keys) {
        if (this.addEntry(key, 'peer')) {
          added++;
        }
      }
      if (added > 0) {
        console.log('[PublicFeed] Added', added, 'new channels from peer');
        this.onFeedUpdate?.();
      }
    }
    // Handle SUBMIT_CHANNEL - peer is broadcasting a new channel
    else if (msg.type === 'SUBMIT_CHANNEL' && msg.key) {
      console.log('[PublicFeed] Received SUBMIT_CHANNEL:', msg.key.slice(0, 16));
      if (this.addEntry(msg.key, 'peer')) {
        console.log('[PublicFeed] Added new channel, re-gossiping...');
        this.onFeedUpdate?.();
        // Re-gossip to other peers (exclude sender)
        this.broadcastSubmitChannel(msg.key, conn);
      }
    }
    // Handle legacy NEED_FEED/FEED_RESPONSE for backwards compat
    else if (msg.type === 'NEED_FEED') {
      console.log('[PublicFeed] Received legacy NEED_FEED, sending HAVE_FEED');
      this.sendHaveFeed(conn);
    }
    else if (msg.type === 'FEED_RESPONSE' && msg.keys) {
      console.log('[PublicFeed] Received legacy FEED_RESPONSE with', msg.keys.length, 'keys');
      let added = 0;
      for (const key of msg.keys) {
        if (this.addEntry(key, 'peer')) {
          added++;
        }
      }
      if (added > 0) {
        console.log('[PublicFeed] Added', added, 'new channels');
        this.onFeedUpdate?.();
      }
    }
  }

  /**
   * Add an entry to the feed (returns true if new)
   * @param {string} driveKey
   * @param {'peer'|'local'} source
   * @returns {boolean}
   */
  addEntry(driveKey, source) {
    // Skip if already exists or hidden
    if (this.entries.has(driveKey) || this.hiddenKeys.has(driveKey)) {
      return false;
    }

    // Validate key format (should be 64 char hex)
    if (!/^[a-f0-9]{64}$/i.test(driveKey)) {
      console.warn('[PublicFeed] Invalid driveKey format:', driveKey.slice(0, 16));
      return false;
    }

    this.entries.set(driveKey, {
      driveKey,
      addedAt: Date.now(),
      source
    });

    return true;
  }

  /**
   * Submit a channel to the public feed
   * @param {string} driveKey
   */
  submitChannel(driveKey) {
    if (this.addEntry(driveKey, 'local')) {
      console.log('[PublicFeed] Submitted local channel:', driveKey.slice(0, 16));
      this.onFeedUpdate?.();
    }

    // Broadcast to all peers
    this.broadcastSubmitChannel(driveKey);
  }

  /**
   * Broadcast SUBMIT_CHANNEL to peers (optionally excluding one)
   * @param {string} driveKey
   * @param {any} [excludeConn]
   */
  broadcastSubmitChannel(driveKey, excludeConn) {
    const msg = { type: 'SUBMIT_CHANNEL', key: driveKey };

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

    console.log('[PublicFeed] Broadcast SUBMIT_CHANNEL to', sent, 'peers');
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
