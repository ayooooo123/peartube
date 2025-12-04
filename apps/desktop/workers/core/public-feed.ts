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

// Feed message types
interface FeedMessage {
  type: 'HAVE_FEED' | 'SUBMIT_CHANNEL';
  keys?: string[];  // For HAVE_FEED - list of all known channel keys
  key?: string;     // For SUBMIT_CHANNEL - single new channel key
}

export interface PublicFeedEntry {
  driveKey: string;
  addedAt: number;
  source: 'peer' | 'local';
}

// Hardcoded topic for public feed discovery
const FEED_TOPIC_STRING = 'peartube-public-feed-v1';

// Protocol identifier for Protomux
const PROTOCOL_NAME = 'peartube-feed';

export class PublicFeedManager {
  private swarm: any;
  private feedTopic: Buffer;
  private entries: Map<string, PublicFeedEntry>;
  private hiddenKeys: Set<string>;
  private peerChannels: Map<any, any>; // conn → protomux channel
  private onFeedUpdate: (() => void) | null = null;

  constructor(swarm: any) {
    this.swarm = swarm;
    // Generate deterministic topic from string
    this.feedTopic = crypto.data(b4a.from(FEED_TOPIC_STRING, 'utf-8'));
    this.entries = new Map();
    this.hiddenKeys = new Set();
    this.peerChannels = new Map();

    console.log('[PublicFeed] Topic:', b4a.toString(this.feedTopic, 'hex').slice(0, 16) + '...');
  }

  /**
   * Set callback for when feed updates occur
   */
  setOnFeedUpdate(callback: () => void) {
    this.onFeedUpdate = callback;
  }

  /**
   * Start the public feed manager - join the topic
   * NOTE: Connection handling is done via handleConnection() called from main swarm handler
   */
  async start() {
    console.log('[PublicFeed] Starting...');

    // Join the public feed topic for discovery
    const discovery = this.swarm.join(this.feedTopic, { server: true, client: true });
    await discovery.flushed();

    console.log('[PublicFeed] Joined topic, waiting for peers...');
  }

  /**
   * Handle a new connection - called from main swarm connection handler
   * This ensures all connections get the feed protocol, not just those after start()
   */
  handleConnection(conn: any, info: any) {
    const remoteKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 8) : 'unknown';
    console.log('[PublicFeed] New connection from peer:', remoteKey);

    this.setupFeedProtocol(conn);
  }

  /**
   * Set up the feed protocol on a connection using mux.pair() pattern
   */
  private setupFeedProtocol(conn: any) {
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
    });

    conn.on('error', (err: any) => {
      console.error('[PublicFeed] Connection error:', err.message);
      this.peerChannels.delete(conn);
    });
  }

  /**
   * Create a feed channel on the mux
   */
  private createFeedChannel(mux: any, conn: any) {
    // Check if we already have a channel for this connection
    if (this.peerChannels.has(conn)) {
      return;
    }

    // Create channel with messages defined in options
    const channel = mux.createChannel({
      protocol: PROTOCOL_NAME,
      messages: [{
        encoding: c.json,
        onmessage: (msg: FeedMessage) => {
          this.handleMessage(msg, conn);
        }
      }],
      onopen: () => {
        console.log('[PublicFeed] Feed channel opened');
        // Immediately send our feed when channel opens
        this.sendHaveFeed(conn);
      },
      onclose: () => {
        console.log('[PublicFeed] Feed channel closed');
        this.peerChannels.delete(conn);
      }
    });

    if (!channel) {
      console.log('[PublicFeed] Channel already exists');
      return;
    }

    // Store the channel
    this.peerChannels.set(conn, channel);

    // Open the channel
    channel.open();
    console.log('[PublicFeed] Feed channel created');
  }

  /**
   * Send HAVE_FEED with all our known keys
   */
  private sendHaveFeed(conn: any) {
    const channel = this.peerChannels.get(conn);
    if (!channel) return;

    const keys = Array.from(this.entries.keys());
    const msg: FeedMessage = { type: 'HAVE_FEED', keys };

    try {
      channel.messages[0].send(msg);
      console.log('[PublicFeed] Sent HAVE_FEED with', keys.length, 'keys');
    } catch (err: any) {
      console.error('[PublicFeed] Failed to send HAVE_FEED:', err.message);
    }
  }

  /**
   * Handle incoming feed protocol messages
   */
  private handleMessage(msg: FeedMessage, conn: any) {
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
    } else if (msg.type === 'SUBMIT_CHANNEL' && msg.key) {
      console.log('[PublicFeed] Received SUBMIT_CHANNEL:', msg.key.slice(0, 8));
      if (this.addEntry(msg.key, 'peer')) {
        console.log('[PublicFeed] Added new channel, re-gossiping');
        this.onFeedUpdate?.();
        // Re-gossip to other peers (exclude sender)
        this.broadcastSubmitChannel(msg.key, conn);
      }
    }
  }

  /**
   * Add an entry to the feed (returns true if new)
   */
  private addEntry(driveKey: string, source: 'peer' | 'local'): boolean {
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
   */
  submitChannel(driveKey: string) {
    if (this.addEntry(driveKey, 'local')) {
      console.log('[PublicFeed] Submitted channel:', driveKey.slice(0, 16));
      this.onFeedUpdate?.();
    }

    // Broadcast to all peers
    this.broadcastSubmitChannel(driveKey);
  }

  /**
   * Broadcast SUBMIT_CHANNEL to peers (optionally excluding one)
   */
  private broadcastSubmitChannel(driveKey: string, excludeConn?: any) {
    const msg: FeedMessage = { type: 'SUBMIT_CHANNEL', key: driveKey };

    let sent = 0;
    for (const [conn, channel] of this.peerChannels) {
      if (conn === excludeConn) continue;
      try {
        channel.messages[0].send(msg);
        sent++;
      } catch (err: any) {
        console.error('[PublicFeed] Failed to broadcast:', err.message);
      }
    }

    console.log('[PublicFeed] Broadcast SUBMIT_CHANNEL to', sent, 'peers');
  }

  /**
   * Request feeds from all connected peers by re-sending our HAVE_FEED
   * This triggers peers to respond with their current feeds
   */
  requestFeedsFromPeers() {
    let sent = 0;
    for (const [conn] of this.peerChannels) {
      this.sendHaveFeed(conn);
      sent++;
    }
    console.log('[PublicFeed] Requested feeds from', sent, 'peers');
    return sent;
  }

  /**
   * Hide a channel locally
   */
  hideChannel(driveKey: string) {
    this.hiddenKeys.add(driveKey);
    this.entries.delete(driveKey);
    console.log('[PublicFeed] Hidden channel:', driveKey.slice(0, 16));
  }

  /**
   * Get the current feed (filtered by hidden)
   */
  getFeed(): PublicFeedEntry[] {
    return Array.from(this.entries.values())
      .filter(e => !this.hiddenKeys.has(e.driveKey))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  /**
   * Get feed statistics
   */
  getStats() {
    return {
      totalEntries: this.entries.size,
      hiddenCount: this.hiddenKeys.size,
      peerCount: this.peerChannels.size
    };
  }
}
