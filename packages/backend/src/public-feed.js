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
import { swarmHasConnection } from './swarm-peer-dial.js'
import {
  SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
  CHANNEL_ROOT_DESCRIPTOR_SCHEMA
} from './channel-descriptor.js'

const log = logger('PublicFeed')
const PUBLIC_FEED_CATALOG_VERSION = 1
const PUBLIC_FEED_RELAY_CATALOG_KEY = 'public-feed-relay-catalog-v1'
const NETWORK_TOPIC = crypto.data(b4a.from(NETWORK_TOPIC_STRING, 'utf-8'))
const NETWORK_TOPIC_HEX = b4a.toString(NETWORK_TOPIC, 'hex')

/**
 * @typedef {import('./types.js').PublicFeedEntry} PublicFeedEntry
 */

export class PublicFeed {
  /**
   * @param {import('hyperswarm')} swarm - Hyperswarm instance
   * @param {import('hyperbee')} [metaDb] - Metadata database for persistence
   */
  constructor(swarm, metaDb, options = {}) {
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
    /** @type {Set<any>} Active/open feed connections */
    this.feedConnections = new Set();
    /** @type {Map<any, string>} conn → short diagnostic id */
    this._connectionIds = new Map();
    /** @type {Map<any, number>} conn → first seen timestamp */
    this._connectionStartedAt = new Map();
    /** @type {number} */
    this._nextConnectionId = 1;
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
    /** @type {Map<string, any>} Remembered Hyperswarm peer candidates for diagnostics/recovery. */
    this._discoveredPeers = new Map();
    /** @type {Map<string, any>} Remembered discovered peer objects with relay-address hints. */
    this._discoveredPeerHints = new Map();
    /** @type {Array<{at: number, action: string, reason?: string, discoveredPeers: number, connections: number, queued: number}>} */
    this._recoveryEvents = [];
    /** @type {number} */
    this._lastRecoveryAt = 0;
    /** @type {number} */
    this._recoveryCooldownMs = 30000;
    /** @type {Map<string, number>} */
    this._directPeerLastDialedAt = new Map();
    /** @type {Map<string, string>} */
    this._directPeerLastDialError = new Map();
    /** @type {Map<string, string>} */
    this._directPeerLastDialErrorStack = new Map();
    /** @type {{attempted: number, queued: number, skipped: number, failed: number, connected: number, lastReason: string | null, lastDialedAt: number | null}} */
    this._directPeerDialStats = {
      attempted: 0,
      queued: 0,
      skipped: 0,
      failed: 0,
      connected: 0,
      lastReason: null,
      lastDialedAt: null,
    };
    /** @type {() => number} */
    this._now = () => Date.now();
    /** @type {any | null} */
    this.feedDiscovery = null;
    /** @type {any | null} */
    this._gossipInterval = null;
    /** @type {number} */
    this._gossipIntervalMs = 30000;
    /** @type {Array<{name: string, at: number, sinceStartMs: number, [key: string]: any}>} */
    this._startupEvents = [];
    /** @type {number} */
    this._startupStartedAt = this._now();
    this._recordStartupEvent('manager-created');

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

    /** @type {number} */
    this.maxPeers = Math.max(1, Number(options.maxPeers || this.swarm?.maxPeers || 48) || 48)
    /** @type {Map<string, {publicKey: any, score: number, firstSeenAt: number, lastSeenAt: number, joined: boolean, demoted: boolean, joinAttempts: number, lastJoinedAt: number | null, lastConnectionAt: number | null, relayHints: number, topics?: Set<string>, lastJoinError?: string | null}>} */
    this._peerDirectory = new Map()
    /** @type {Map<any, any>} */
    this._connectionPeerKeys = new Map()
    /** @type {number} */
    this._peerJoinCooldownMs = 30000

    log.info('Initialized')
  }

  _recordStartupEvent(name, details = {}) {
    const at = this._now()
    const event = {
      name,
      at,
      sinceStartMs: Math.max(0, at - this._startupStartedAt),
      ...details
    }
    this._startupEvents.push(event)
    while (this._startupEvents.length > 80) this._startupEvents.shift()
    return event
  }

  getStartupTiming() {
    return {
      startedAt: this._startupStartedAt,
      elapsedMs: Math.max(0, this._now() - this._startupStartedAt),
      events: this._startupEvents.slice(-40)
    }
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
      .map((video) => {
        const availability = video?.byteAvailability || video?.availability
        const containerSupport = video?.containerSupport || video?.playbackSupport
        return {
          id: String(video.id),
          title: video?.title ? String(video.title) : 'Untitled',
          uploadedAt: Number(video?.uploadedAt || 0) || 0,
          duration: Number(video?.duration || 0) || 0,
          thumbnail: video?.thumbnail ? String(video.thumbnail) : null,
          blobId: video?.blobId ? String(video.blobId) : null,
          blobsCoreKey: video?.blobsCoreKey ? String(video.blobsCoreKey) : null,
          mimeType: video?.mimeType ? String(video.mimeType) : null,
          availability: availability === 'playable' ? 'playable' : (availability === 'unknown' ? 'unknown' : 'unavailable'),
          byteAvailability: availability === 'playable' ? 'playable' : (availability === 'unknown' ? 'unknown' : 'unavailable'),
          playbackSupport: video?.playbackSupport ? String(video.playbackSupport) : null,
          containerSupport: containerSupport ? String(containerSupport) : null,
          thumbnailBlobId: video?.thumbnailBlobId ? String(video.thumbnailBlobId) : null,
          thumbnailBlobsCoreKey: video?.thumbnailBlobsCoreKey ? String(video.thumbnailBlobsCoreKey) : null,
          thumbnailMimeType: video?.thumbnailMimeType ? String(video.thumbnailMimeType) : null,
          discoveryOnly: Boolean(video?.discoveryOnly),
          restoredFromCache: Boolean(video?.restoredFromCache),
          requiresAvailabilityProbe: Boolean(video?.requiresAvailabilityProbe),
        }
      })
  }

  _markRestoredDiscoveryOnly(entry, restoredFrom) {
    if (!entry || typeof entry !== 'object') return entry
    const marked = {
      ...entry,
      discoveryOnly: true,
      restoredFromCache: true,
      restoredFrom,
      requiresAvailabilityProbe: true,
    }
    if (Array.isArray(marked.previewVideos)) {
      marked.previewVideos = marked.previewVideos.map((video) => ({
        ...video,
        availability: video?.availability === 'playable' ? 'unknown' : (video?.availability || 'unknown'),
        byteAvailability: video?.byteAvailability === 'playable' ? 'unknown' : (video?.byteAvailability || 'unknown'),
        discoveryOnly: true,
        restoredFromCache: true,
        requiresAvailabilityProbe: true,
      }))
    }
    return marked
  }

  _normalizeSignedDescriptor(signed) {
    if (!signed || typeof signed !== 'object') return null
    if (signed.schema !== SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA) return null
    const descriptor = signed.descriptor
    if (!descriptor || descriptor.schema !== CHANNEL_ROOT_DESCRIPTOR_SCHEMA) return null
    const isValidKey = (k) => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)
    if (!isValidKey(descriptor.channelId)) return null
    if (!isValidKey(descriptor.identityPublicKey)) return null
    if (!isValidKey(descriptor.metadataKey)) return null
    if (!isValidKey(descriptor.mediaKey)) return null
    const seq = Number(descriptor.seq || 0)
    if (!Number.isSafeInteger(seq) || seq < 0) return null
    return {
      schema: SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
      descriptor: {
        ...descriptor,
        channelId: descriptor.channelId.toLowerCase(),
        identityPublicKey: descriptor.identityPublicKey.toLowerCase(),
        metadataKey: descriptor.metadataKey.toLowerCase(),
        mediaKey: descriptor.mediaKey.toLowerCase(),
        seq,
      },
      proof: typeof signed.proof === 'string' ? signed.proof : null,
      attestation: typeof signed.attestation === 'string' ? signed.attestation : null,
    }
  }

  _shouldApplySignedDescriptor(current, next) {
    if (!next) return false
    if (!current) return true
    const currentSeq = Number(current?.descriptor?.seq || 0)
    const nextSeq = Number(next?.descriptor?.seq || 0)
    return nextSeq >= currentSeq
  }

  _resolvePublicBeeKey(entry) {
    const isValidKey = (k) => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)
    const direct = typeof entry?.publicBeeKey === 'string' ? entry.publicBeeKey : null
    if (isValidKey(direct)) return direct.toLowerCase()

    const metadataKey = typeof entry?.metadataKey === 'string'
      ? entry.metadataKey
      : typeof entry?.signedDescriptor?.descriptor?.metadataKey === 'string'
        ? entry.signedDescriptor.descriptor.metadataKey
        : typeof entry?.descriptor?.metadataKey === 'string'
          ? entry.descriptor.metadataKey
          : null

    if (isValidKey(metadataKey)) return metadataKey.toLowerCase()
    return null
  }

  _serializeEntry(entry) {
    const publicBeeKey = this._resolvePublicBeeKey(entry)
    const serialized = {
      schema: 'peartube.relayCatalog',
      catalogVersion: entry.catalogVersion || PUBLIC_FEED_CATALOG_VERSION,
      driveKey: entry.driveKey,
      publicBeeKey,
      relayRole: entry.relayRole || (entry.source === 'relay-cache' ? 'cache' : 'publisher'),
      relayServing: Boolean(entry.relayServing || entry.source === 'relay-cache' || entry.source === 'local'),
      discoveryOnly: Boolean(entry.discoveryOnly),
      restoredFromCache: Boolean(entry.restoredFromCache),
      restoredFrom: entry.restoredFrom || null,
      requiresAvailabilityProbe: Boolean(entry.requiresAvailabilityProbe),
      lastSeenAt: entry.lastSeenAt || entry.addedAt || Date.now(),
      version: Number(entry.version || 0) || 0,
    }
    if (entry.channelName) serialized.channelName = entry.channelName
    if (Number(entry.videoCount || 0) > 0) serialized.videoCount = Number(entry.videoCount || 0)
    if (Number(entry.manifestUpdatedAt || 0) > 0) serialized.manifestUpdatedAt = Number(entry.manifestUpdatedAt || 0)
    const previewVideos = this._sanitizePreviewVideos(entry.previewVideos)
    if (previewVideos.length > 0) serialized.previewVideos = previewVideos
    const previewVideosHash = entry.previewVideosHash || hashPreviewVideos(previewVideos)
    if (previewVideosHash) serialized.previewVideosHash = previewVideosHash
    const signedDescriptor = this._normalizeSignedDescriptor(entry.signedDescriptor)
    if (signedDescriptor) serialized.signedDescriptor = signedDescriptor
    return serialized
  }

  _applyEntrySnapshot(driveKey, snapshot = {}) {
    const entry = this.entries.get(driveKey)
    if (!entry) return false

    let changed = false

    const nextPublicBeeKey = this._resolvePublicBeeKey(snapshot)
    if (typeof nextPublicBeeKey === 'string' && nextPublicBeeKey && nextPublicBeeKey !== entry.publicBeeKey) {
      entry.publicBeeKey = nextPublicBeeKey
      changed = true
    }
    if (typeof snapshot.channelName === 'string' && snapshot.channelName && snapshot.channelName !== entry.channelName) {
      entry.channelName = snapshot.channelName
      changed = true
    }
    if (typeof snapshot.relayRole === 'string' && snapshot.relayRole && snapshot.relayRole !== entry.relayRole) {
      entry.relayRole = snapshot.relayRole
      changed = true
    }
    if (typeof snapshot.catalogVersion !== 'undefined' && snapshot.catalogVersion !== entry.catalogVersion) {
      entry.catalogVersion = Number(snapshot.catalogVersion || PUBLIC_FEED_CATALOG_VERSION) || PUBLIC_FEED_CATALOG_VERSION
      changed = true
    }
    if (typeof snapshot.relayServing !== 'undefined' && Boolean(snapshot.relayServing) !== Boolean(entry.relayServing)) {
      entry.relayServing = Boolean(snapshot.relayServing)
      changed = true
    }
    if (Number(snapshot.lastSeenAt || 0) > Number(entry.lastSeenAt || 0)) {
      entry.lastSeenAt = Number(snapshot.lastSeenAt)
      changed = true
    }
    for (const flag of ['discoveryOnly', 'restoredFromCache', 'requiresAvailabilityProbe']) {
      if (typeof snapshot[flag] !== 'undefined' && Boolean(snapshot[flag]) !== Boolean(entry[flag])) {
        entry[flag] = Boolean(snapshot[flag])
        changed = true
      }
    }
    if (typeof snapshot.restoredFrom === 'string' && snapshot.restoredFrom !== entry.restoredFrom) {
      entry.restoredFrom = snapshot.restoredFrom
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

    const nextSignedDescriptor = this._normalizeSignedDescriptor(snapshot.signedDescriptor)
    if (this._shouldApplySignedDescriptor(entry.signedDescriptor, nextSignedDescriptor)) {
      const currentSeq = Number(entry.signedDescriptor?.descriptor?.seq || -1)
      const nextSeq = Number(nextSignedDescriptor?.descriptor?.seq || -1)
      if (nextSeq !== currentSeq || JSON.stringify(entry.signedDescriptor) !== JSON.stringify(nextSignedDescriptor)) {
        entry.signedDescriptor = nextSignedDescriptor
        const resolvedPublicBeeKey = this._resolvePublicBeeKey(nextSignedDescriptor)
        if (resolvedPublicBeeKey && resolvedPublicBeeKey !== entry.publicBeeKey) {
          entry.publicBeeKey = resolvedPublicBeeKey
        }
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
          publicBeeKey: this._resolvePublicBeeKey(snapshot) || byKey.get(driveKey)?.publicBeeKey || null,
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
