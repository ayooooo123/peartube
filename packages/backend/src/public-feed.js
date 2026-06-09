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
import { encodeIndexKey } from './index-encoder.js'
import { swarmHasConnection, swarmRememberPeer } from './swarm-peer-dial.js'
import {
  SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
  CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
  verifySignedChannelRootDescriptor
} from './channel-descriptor.js'

const log = logger('PublicFeed')
const PUBLIC_FEED_CATALOG_VERSION = 1
const PUBLIC_FEED_RELAY_CATALOG_KEY = 'public-feed-relay-catalog-v1'
const PUBLIC_FEED_HIDDEN_CHANNELS_KEY = 'hidden-channels-v1'
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
    /** @type {{ requestTimeout?: (peer: any) => number } | null} */
    this.peerScorer = options.peerScorer || null;
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
    /** @type {boolean} */
    this._ownsFeedDiscovery = false;
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
    this._persistMaxEntries = Math.max(1, Number(options.maxFeedEntries || 500) || 500)
    /** @type {boolean} */
    this.requireSignedPeerEntries = options.requireSignedPeerEntries !== false

    /** @type {number} */
    this.maxPeers = Math.max(1, Number(options.maxDiscoveredPeers || options.maxPeers || this.swarm?.maxPeers || 48) || 48)
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
          thumbnailUrl: video?.thumbnailUrl ? String(video.thumbnailUrl) : null,
          blobId: video?.blobId ? String(video.blobId) : null,
          blobsCoreKey: video?.blobsCoreKey ? String(video.blobsCoreKey) : null,
          mimeType: video?.mimeType ? String(video.mimeType) : null,
          availability: availability === 'playable' ? 'playable' : (availability === 'unknown' ? 'unknown' : 'unavailable'),
          byteAvailability: availability === 'playable' ? 'playable' : (availability === 'unknown' ? 'unknown' : 'unavailable'),
          hasHeadBlock: Boolean(video?.hasHeadBlock),
          contiguousBlocks: Number(video?.contiguousBlocks || 0) || 0,
          readyForPlayback: Boolean(video?.readyForPlayback),
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
        hasHeadBlock: false,
        contiguousBlocks: 0,
        readyForPlayback: false,
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

  async _verifyPeerFeedSnapshot(driveKey, source, snapshot = {}, publicBeeKey = null) {
    if (source !== 'peer') return { ok: true, signedDescriptor: this._normalizeSignedDescriptor(snapshot?.signedDescriptor) }

    const signedDescriptor = this._normalizeSignedDescriptor(snapshot?.signedDescriptor)
    if (!signedDescriptor) {
      if (this.requireSignedPeerEntries) return { ok: false, reason: 'missing-signed-descriptor' }
      return { ok: true, signedDescriptor: null }
    }

    const verified = await verifySignedChannelRootDescriptor(signedDescriptor)
    if (!verified?.valid) return { ok: false, reason: verified?.error || 'invalid-signed-descriptor' }

    const expectedDriveKey = typeof driveKey === 'string' ? driveKey.toLowerCase() : ''
    const expectedPublicBeeKey = this._resolvePublicBeeKey({ publicBeeKey, ...(snapshot || {}) })
    const descriptor = verified.descriptor || signedDescriptor.descriptor
    if (descriptor.channelId !== expectedDriveKey) return { ok: false, reason: 'descriptor-channel-mismatch' }
    if (expectedPublicBeeKey && descriptor.metadataKey !== expectedPublicBeeKey) return { ok: false, reason: 'descriptor-metadata-mismatch' }

    return {
      ok: true,
      signedDescriptor: {
        ...signedDescriptor,
        descriptor
      }
    }
  }

  async _ingestVerifiedPeerEntry(driveKey, source, publicBeeKey, snapshot) {
    const verification = await this._verifyPeerFeedSnapshot(driveKey, source, snapshot, publicBeeKey)
    if (!verification.ok) {
      log.debug('Rejected feed entry', { driveKey: String(driveKey || '').slice(0, 16), source, reason: verification.reason })
      return { added: false, updated: false, accepted: false }
    }
    const verifiedSnapshot = verification.signedDescriptor
      ? { ...(snapshot || {}), signedDescriptor: verification.signedDescriptor }
      : snapshot
    const resolvedPublicBeeKey = this._resolvePublicBeeKey({ publicBeeKey, ...(verifiedSnapshot || {}) })
    if (this.addEntry(driveKey, source, resolvedPublicBeeKey, verifiedSnapshot)) {
      return { added: true, updated: false, accepted: true }
    }
    if (this._applyEntrySnapshot(driveKey, verifiedSnapshot)) {
      return { added: false, updated: true, accepted: true }
    }
    return { added: false, updated: false, accepted: true }
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

  _entryHasPlayablePreview(entry) {
    const videos = this._sanitizePreviewVideos(entry?.previewVideos)
    return videos.some((video) => {
      const availability = video?.byteAvailability || video?.availability
      const hasByteProof = video?.readyForPlayback === true ||
        (video?.hasHeadBlock === true && (Number(video?.contiguousBlocks || 0) || 0) > 0)
      return availability === 'playable' && hasByteProof
    })
  }

  _isLocallyBackedEntry(entry) {
    if (!entry || typeof entry !== 'object') return false
    const driveKey = entry.driveKey || entry.channelKey
    return (
      entry.source === 'local' ||
      entry.source === 'relay-cache' ||
      (driveKey && this.publishedChannels.has(driveKey)) ||
      this._entryHasPlayablePreview(entry)
    )
  }

  _serializeEntry(entry) {
    const publicBeeKey = this._resolvePublicBeeKey(entry)
    const serialized = {
      schema: 'peartube.relayCatalog',
      catalogVersion: entry.catalogVersion || PUBLIC_FEED_CATALOG_VERSION,
      driveKey: entry.driveKey,
      publicBeeKey,
      relayRole: entry.relayRole || (entry.source === 'relay-cache' ? 'cache' : 'publisher'),
      relayServing: Boolean(entry.relayServing || entry.source === 'relay-cache' || entry.source === 'local' || this._entryHasPlayablePreview(entry)),
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

    const nextSignedDescriptor = this._normalizeSignedDescriptor(snapshot.signedDescriptor)
    if (snapshot?.signedDescriptor && !this._shouldApplySignedDescriptor(entry.signedDescriptor, nextSignedDescriptor)) {
      return false
    }

    let changed = false

    const nextPublicBeeKey = this._resolvePublicBeeKey(nextSignedDescriptor || snapshot)
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


  _connectionPeerKeyHex(conn) {
    const key = this._connectionPeerKeys.get(conn) || conn?.remotePublicKey || conn?.publicKey || null
    return this._peerKeyHex(key)
  }

  _sourcePeerIdsForHint(conn, hint = {}) {
    const sourceFeedPeerId = this._connectionPeerKeyHex(conn)
    const ids = new Set()
    const add = (value) => {
      if (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) ids.add(value.toLowerCase())
    }
    add(hint.sourcePeerId)
    add(hint.sourceFeedPeerId)
    add(hint.relayPeerId)
    if (Array.isArray(hint.sourceFeedPeerIds)) for (const id of hint.sourceFeedPeerIds) add(id)
    if (Array.isArray(hint.sourceRelayPeerIds)) for (const id of hint.sourceRelayPeerIds) add(id)
    if (Array.isArray(hint.relayHintIds)) for (const id of hint.relayHintIds) add(id)
    if (sourceFeedPeerId) ids.add(sourceFeedPeerId)
    return {
      sourceFeedPeerId,
      sourceFeedPeerIds: sourceFeedPeerId ? [sourceFeedPeerId] : [],
      sourceRelayPeerIds: Array.from(ids),
    }
  }

  _annotateAvailabilityHint(hint, request, conn) {
    if (!hint || typeof hint !== 'object') return null
    const peerIds = this._sourcePeerIdsForHint(conn, hint)
    return {
      ...hint,
      driveKey: hint.driveKey || request?.driveKey || null,
      id: hint.id || request?.id || null,
      blobsCoreKey: hint.blobsCoreKey || request?.blobsCoreKey || null,
      blobId: hint.blobId || request?.blobId || null,
      ...peerIds,
    }
  }

  _availabilityHintMergeKey(hint) {
    return [
      encodeIndexKey(hint?.driveKey || '', hint?.id || ''),
      hint?.blobsCoreKey || '',
      hint?.blobId || '',
    ].join(':')
  }
  async requestAvailabilityHints(requests, { timeoutMs = null, maxPeers = 4 } = {}) {
    const peers = Array.from(this.feedConnections).slice(0, maxPeers)
    if (!Array.isArray(requests) || requests.length === 0 || peers.length === 0) return []

    const perPeer = peers.map((conn) => new Promise((resolve) => {
      const channel = this.peerChannels.get(conn)
      if (!channel) return resolve([])
      const peerKey = this._connectionPeerKeys.get(conn) || this._connectionIds.get(conn) || conn
      const peerTimeoutMs = Number.isFinite(timeoutMs)
        ? timeoutMs
        : this.peerScorer?.requestTimeout
          ? Math.max(300, Math.min(5000, Number(this.peerScorer.requestTimeout(peerKey) || 3000)))
          : 250
      const requestId = `${Date.now()}:${this._nextAvailabilityRequestId++}`
      const timeout = setTimeout(() => {
        this.pendingAvailabilityRequests.delete(requestId)
        resolve([])
      }, peerTimeoutMs)
      this.pendingAvailabilityRequests.set(requestId, {
        resolve: (hints) => {
          clearTimeout(timeout)
          const byRequest = new Map(requests.map((req) => [encodeIndexKey(req?.driveKey || '', req?.id || ''), req]))
          const annotated = Array.isArray(hints)
            ? hints.map((hint) => this._annotateAvailabilityHint(
              hint,
              byRequest.get(encodeIndexKey(hint?.driveKey || '', hint?.id || '')),
              conn
            )).filter(Boolean)
            : []
          resolve(annotated)
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
        if (!hint?.driveKey || !hint?.id) continue
        const key = this._availabilityHintMergeKey(hint)
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
    if (peers instanceof Map) return Array.from(peers, ([key, value]) => ({ key, value }))
    if (typeof peers.values === 'function') return Array.from(peers.values())
    if (typeof peers[Symbol.iterator] === 'function') return Array.from(peers)
    return []
  }

  _topicToHex(topic) {
    if (!topic) return null
    if (typeof topic === 'string') return /^[a-f0-9]{64}$/i.test(topic) ? topic.toLowerCase() : null
    if (b4a.isBuffer(topic) || topic instanceof Uint8Array) return b4a.toString(topic, 'hex')
    return null
  }

  _isNetworkTopic(topic) {
    const topicHex = this._topicToHex(topic)
    return topicHex === NETWORK_TOPIC_HEX
  }

  _peerEntryHasNetworkTopic(peer) {
    if (!peer || typeof peer !== 'object') return false
    const nestedPeer = peer.value || peer.peer || peer[1]
    const topics = [
      peer.topic,
      ...(Array.isArray(peer.topics) ? peer.topics : []),
      nestedPeer?.topic,
      ...(Array.isArray(nestedPeer?.topics) ? nestedPeer.topics : []),
    ].filter(Boolean)
    if (topics.length === 0) return false
    return topics.some((topic) => this._isNetworkTopic(topic))
  }

  _peerEntryPublicKey(peer) {
    if (!peer) return null
    if (typeof peer === 'string' && /^[a-f0-9]{64}$/i.test(peer)) return b4a.from(peer, 'hex')
    if (b4a.isBuffer(peer) || peer instanceof Uint8Array) return peer

    const publicKey =
      peer.publicKey ||
      peer.remotePublicKey ||
      peer.key ||
      peer.value?.publicKey ||
      peer.value?.remotePublicKey ||
      peer.value?.key ||
      peer.peer?.publicKey ||
      peer.peer?.remotePublicKey ||
      peer[1]?.publicKey ||
      peer[1]?.remotePublicKey ||
      peer[1]?.key

    if (typeof publicKey === 'string' && /^[a-f0-9]{64}$/i.test(publicKey)) return b4a.from(publicKey, 'hex')
    if (publicKey && (b4a.isBuffer(publicKey) || publicKey instanceof Uint8Array)) return publicKey
    return null
  }

  _peerEntryIsConnected(entry) {
    if (!entry || typeof entry !== 'object') return false
    const nestedPeer = entry.value || entry.peer || entry[1]
    return (
      entry.connected === true ||
      entry.opened === true ||
      (Number.isFinite(entry.connectedTime) && entry.connectedTime >= 0) ||
      nestedPeer?.connected === true ||
      nestedPeer?.opened === true ||
      (Number.isFinite(nestedPeer?.connectedTime) && nestedPeer.connectedTime >= 0) ||
      Boolean(entry.stream || nestedPeer?.stream)
    )
  }

  _activeSwarmConnectionEntries() {
    const allConnections = this.swarm?._allConnections
    if (!allConnections || typeof allConnections[Symbol.iterator] !== 'function') return []
    return Array.from(allConnections).filter((entry) => (
      entry &&
      typeof entry === 'object' &&
      !b4a.isBuffer(entry) &&
      !(entry instanceof Uint8Array)
    ))
  }

  _peerEntryMatchesKey(entry, keyHex, { requireConnected = false } = {}) {
    const publicKey = this._peerEntryPublicKey(entry)
    if (!publicKey) return false
    if (b4a.toString(publicKey, 'hex') !== keyHex) return false
    return !requireConnected || this._peerEntryIsConnected(entry)
  }

  _hasActivePeerConnection(keyHex, publicKey = null) {
    return swarmHasConnection(this.swarm, keyHex, publicKey)
  }

  _markPeerConnected(publicKey) {
    const remembered = this._rememberPeerPublicKey(publicKey)
    if (!remembered) return
    this._directPeerLastDialError.delete(remembered.keyHex)
    this._directPeerLastDialErrorStack.delete(remembered.keyHex)
    this._directPeerDialStats.connected++
    this._directPeerDialStats.lastReason = 'connected'
  }

  _connectionLabel(conn, info = null) {
    if (!conn) return 'conn:unknown'
    let label = this._connectionIds.get(conn)
    if (!label) {
      const remoteKey = info?.publicKey || conn.remotePublicKey || conn.publicKey
      const remote = remoteKey && (b4a.isBuffer(remoteKey) || remoteKey instanceof Uint8Array)
        ? b4a.toString(remoteKey, 'hex').slice(0, 16)
        : 'unknown'
      label = `conn:${this._nextConnectionId++}:${remote}`
      this._connectionIds.set(conn, label)
      this._connectionStartedAt.set(conn, Date.now())
    }
    return label
  }

  _connectionAgeMs(conn) {
    const startedAt = this._connectionStartedAt.get(conn)
    return startedAt ? Date.now() - startedAt : 0
  }

  _forgetConnection(conn) {
    const hadRemoteKey = this._connectionPeerKeys.has(conn)
    this._clearPeerFeedKeys(conn)
    this.wiredConnections.delete(conn)
    this.peerChannels.delete(conn)
    this.feedConnections.delete(conn)
    if (hadRemoteKey && this._directPeerDialStats.connected > 0) {
      this._directPeerDialStats.connected = Math.max(0, this._directPeerDialStats.connected - 1)
    }
    this._connectionPeerKeys.delete(conn)
    this._connectionIds.delete(conn)
    this._connectionStartedAt.delete(conn)
  }

  _rememberPeerPublicKey(publicKey, peer = null, topic = null) {
    if (!publicKey) return null
    const keyHex = b4a.toString(publicKey, 'hex')
    if (!keyHex || keyHex === b4a.toString(this.swarm?.keyPair?.publicKey || [], 'hex')) return null
    this._discoveredPeers.set(keyHex, publicKey)
    while (this._discoveredPeers.size > this.maxPeers) {
      const oldestKey = this._discoveredPeers.keys().next().value
      if (!oldestKey) break
      this._discoveredPeers.delete(oldestKey)
      this._discoveredPeerHints.delete(oldestKey)
    }
    if (peer && typeof peer === 'object' && this._discoveredPeers.has(keyHex)) {
      const relayAddresses = Array.isArray(peer.relayAddresses) ? peer.relayAddresses : []
      const existing = this._discoveredPeerHints.get(keyHex) || {}
      this._discoveredPeerHints.set(keyHex, {
        peer,
        topic,
        relayAddresses,
        relayAddressesSeen: Math.max(Number(existing.relayAddressesSeen || 0), relayAddresses.length),
        firstSeenAt: existing.firstSeenAt || this._now(),
        lastSeenAt: this._now(),
      })
    }
    return this._discoveredPeers.has(keyHex) ? { keyHex, publicKey } : null
  }

  _peerKeyHex(publicKey) {
    if (!publicKey) return null
    if (typeof publicKey === 'string' && /^[a-f0-9]{64}$/i.test(publicKey)) return publicKey.toLowerCase()
    if (b4a.isBuffer(publicKey) || publicKey instanceof Uint8Array) return b4a.toString(publicKey, 'hex')
    return null
  }

  _lowestScoringPeer(excludeKeyHex = null) {
    let lowest = null
    for (const record of this._peerDirectory.values()) {
      if (!record || record.keyHex === excludeKeyHex) continue
      if (!lowest) {
        lowest = record
        continue
      }
      if (record.score < lowest.score) {
        lowest = record
        continue
      }
      if (record.score === lowest.score && record.lastSeenAt < lowest.lastSeenAt) {
        lowest = record
      }
    }
    return lowest
  }

  _enforceFeedEntryLimit() {
    if (this.entries.size <= this._persistMaxEntries) return
    // Evict oldest non-local entries. Local entries are skipped (never break:
    // a local entry at the head of the Map must not disable eviction entirely,
    // or peer-discovered entries grow unbounded).
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this._persistMaxEntries) break
      const entry = this.entries.get(key)
      if (entry?.source === 'local') continue
      this.entries.delete(key)
      this.entryPeerCounts.delete(key)
      for (const peerKeys of this.peerFeedKeys.values()) {
        peerKeys.delete(key)
      }
    }
  }

  _enforcePeerDirectoryLimit() {
    while (this._peerDirectory.size > this.maxPeers) {
      const victim = this._lowestScoringPeer()
      if (!victim) break
      victim.demoted = true
      victim.demotedAt = this._now()
      this._peerDirectory.delete(victim.keyHex)
      log.info('Demoted low-scoring peer', { key: victim.keyHex.slice(0, 16), score: victim.score, maxPeers: this.maxPeers })
    }
  }

  _scorePeerRecord(record, peer = null, { connectionAgeMs = 0, connected = false, reason = 'seen' } = {}) {
    if (!record) return null
    let delta = 0
    const relayCount = Array.isArray(peer?.relayAddresses) ? peer.relayAddresses.length : Number(record.relayHints || 0)
    if (relayCount > 0) delta += Math.min(1.5, relayCount * 0.15)
    if (peer?.client === true) delta -= 0.1
    if (peer?.queued === true) delta += 0.05
    if (reason === 'connected') delta += 0.2
    if (connected && connectionAgeMs > 0) {
      delta += Math.min(5, connectionAgeMs / 60000)
    }
    if (reason === 'transient-client' || (peer?.client === true && connectionAgeMs < 30000)) {
      delta -= 0.05
    }
    record.score = Number(record.score || 0) + delta
    record.lastScoredAt = this._now()
    record.lastSeenAt = record.lastSeenAt || record.lastScoredAt
    return record
  }

  _registerPeerCandidate(publicKey, peer = null, topic = null, scoreOptions = {}) {
    const keyHex = this._peerKeyHex(publicKey)
    if (!keyHex) return null
    if (keyHex === b4a.toString(this.swarm?.keyPair?.publicKey || [], 'hex')) return null

    let record = this._peerDirectory.get(keyHex)
    if (!record) {
      record = {
        keyHex,
        publicKey,
        score: 0,
        firstSeenAt: this._now(),
        lastSeenAt: this._now(),
        joined: false,
        demoted: false,
        joinAttempts: 0,
        lastJoinedAt: null,
        lastConnectionAt: null,
        relayHints: Array.isArray(peer?.relayAddresses) ? peer.relayAddresses.length : 0,
        topics: new Set(),
        lastJoinError: null,
      }
    } else {
      record.publicKey = publicKey || record.publicKey
      record.lastSeenAt = this._now()
      if (Array.isArray(peer?.relayAddresses)) {
        record.relayHints = Math.max(Number(record.relayHints || 0), peer.relayAddresses.length)
      }
    }

    if (topic) {
      const topicHex = this._topicToHex(topic)
      if (topicHex) record.topics.add(topicHex)
    }

    this._scorePeerRecord(record, peer, scoreOptions)
    this._peerDirectory.set(keyHex, record)
    this._enforcePeerDirectoryLimit()
    return this._peerDirectory.get(keyHex) || null
  }

  _recordPeerConnectionOutcome(conn, reason = 'closed') {
    // A failing connection emits both 'error' and 'close'. _forgetConnection
    // clears the conn maps after the first event, so bail here to avoid
    // scoring the same connection outcome twice (the connected-stat decrement
    // is owned by _forgetConnection).
    if (!this._connectionPeerKeys.has(conn)) return
    const remoteKey = this._connectionPeerKeys.get(conn) || conn?.remotePublicKey || conn?.publicKey || null
    const keyHex = this._peerKeyHex(remoteKey)
    const record = keyHex ? this._peerDirectory.get(keyHex) : null
    if (!record) return
    const ageMs = this._connectionAgeMs(conn)
    const swarmState = this._swarmDialState(keyHex, remoteKey)
    record.lastConnectionAt = this._now()
    this._scorePeerRecord(record, { relayAddresses: Array.from({ length: Number(record.relayHints || 0) }, () => null), client: swarmState?.client }, { connectionAgeMs: ageMs, connected: true, reason: swarmState?.client ? 'transient-client' : reason })
  }

  /**
   * Remember a shared-topic peer candidate. Hyperswarm owns dialing and retry
   * lifecycle after discovery; PublicFeedManager only uses opened sockets.
   * @param {any} peer
   * @param {Buffer | Uint8Array | string | null} [topic]
   * @returns {boolean}
   */
  handleDiscoveredPeer(peer, topic = null) {
    if (topic && !this._isNetworkTopic(topic)) return false
    if (!this.swarm) return false
    const publicKey = this._peerEntryPublicKey(peer)
    const remembered = this._rememberPeerPublicKey(publicKey, peer, topic)
    if (remembered) {
      this._recordStartupEvent('feed-peer-discovered', { key: remembered.keyHex.slice(0, 16), topic: topic ? (this._isNetworkTopic(topic) ? 'peartube-network' : 'other') : 'unknown', relayAddresses: Array.isArray(peer?.relayAddresses) ? peer.relayAddresses.length : 0 })
    }
    if (!remembered) {
      this._directPeerDialStats.skipped++
      this._directPeerDialStats.lastReason = 'self-or-missing-key'
      return false
    }

    const record = this._registerPeerCandidate(remembered.publicKey, peer, topic, { reason: 'discovered' })
    if (!record) {
      this._directPeerDialStats.skipped++
      this._directPeerDialStats.lastReason = 'peer-demoted'
      return false
    }

    this._directPeerDialStats.skipped++
    this._directPeerDialStats.lastReason = 'hyperswarm-owned-dialing'
    const rememberedHint = this._rememberDiscoveredPeerInSwarm(peer, topic, remembered.keyHex)
    const queued = rememberedHint?.peerInfo?.queued === true || rememberedHint?.peerInfo?.waiting === true
    if (queued && rememberedHint?.explicit !== true) {
      try {
        rememberedHint.peerInfo.explicit = true
        let requeued = false
        if (typeof rememberedHint.peerInfo._requeue === 'function') {
          requeued = rememberedHint.peerInfo._requeue() !== false
        }
        if (requeued) this._directPeerDialStats.lastReason = 'queued-discovered-peer'
      } catch (err) {
        this._directPeerLastDialError.set(remembered.keyHex, err?.message || String(err))

        if (err?.stack) this._directPeerLastDialErrorStack.set(remembered.keyHex, err.stack)
      }
    }
    if (this._hasActivePeerConnection(remembered.keyHex, remembered.publicKey)) {
      this._directPeerDialStats.skipped++
      this._directPeerDialStats.lastReason = 'already-connected-peer'
    }
    return true
  }

  promoteAvailabilityHintPeers(peerIds = [], topic = null) {
    const ids = Array.isArray(peerIds) ? peerIds : [peerIds]
    const promoted = []
    for (const id of ids) {
      const keyHex = typeof id === 'string' && /^[a-f0-9]{64}$/i.test(id) ? id.toLowerCase() : null
      if (!keyHex) continue
      const publicKey = this._discoveredPeers.get(keyHex) || b4a.from(keyHex, 'hex')
      const hint = this._discoveredPeerHints.get(keyHex)
      const peer = hint?.peer || { publicKey, relayAddresses: hint?.relayAddresses || [] }
      let peerInfo = null
      try {
        peerInfo = swarmRememberPeer(this.swarm, peer, topic)
      } catch (err) {
        this._directPeerLastDialError.set(keyHex, err?.message || String(err))
        if (err?.stack) this._directPeerLastDialErrorStack.set(keyHex, err.stack)
      }
      if (peerInfo && typeof peerInfo === 'object') {
        try {
          peerInfo.explicit = true
          if (typeof peerInfo._updatePriority === 'function') peerInfo._updatePriority()
          if (typeof peerInfo._requeue === 'function') peerInfo._requeue()
        } catch (err) {
          this._directPeerLastDialError.set(keyHex, err?.message || String(err))
          if (err?.stack) this._directPeerLastDialErrorStack.set(keyHex, err.stack)
        }
      }
      this._directPeerDialStats.attempted++
      this._directPeerDialStats.lastDialedAt = this._now()
      this._directPeerDialStats.lastReason = this._hasActivePeerConnection(keyHex, publicKey)
        ? 'already-connected-peer'
        : 'promoted-availability-hint-peer'
      promoted.push({
        key: keyHex,
        connected: this._hasActivePeerConnection(keyHex, publicKey),
        relayAddresses: Array.isArray(peer?.relayAddresses) ? peer.relayAddresses.length : 0,
        explicit: Boolean(peerInfo?.explicit),
        synthetic: Boolean(peerInfo?.synthetic),
      })
    }
    return promoted
  }

  _rememberDiscoveredPeerInSwarm(peer, topic, keyHex) {
    if (!this.swarm || !peer || typeof peer !== 'object') return null
    try {
      const publicKey = this._peerEntryPublicKey(peer)
      const peers = this.swarm?.peers
      let peerInfo = peers && typeof peers.get === 'function' ? peers.get(keyHex) : null
      if (!peerInfo && peers && typeof peers.get === 'function' && publicKey) {
        try { peerInfo = peers.get(publicKey) } catch { peerInfo = null }
      }

      if (peerInfo && typeof peerInfo === 'object') {
        peerInfo.publicKey = peerInfo.publicKey || publicKey
        const relayAddresses = Array.isArray(peer?.relayAddresses) ? peer.relayAddresses : []
        if (relayAddresses.length > 0 && (!Array.isArray(peerInfo.relayAddresses) || peerInfo.relayAddresses.length === 0)) {
          peerInfo.relayAddresses = relayAddresses
        }
        if (topic) {
          if (typeof peerInfo._topic === 'function') peerInfo._topic(topic)
          else {
            if (!Array.isArray(peerInfo.topics)) peerInfo.topics = []
            if (!peerInfo.topics.some((seen) => b4a.equals(seen, topic))) peerInfo.topics.push(topic)
          }
        }
        const wasQueued = peerInfo.queued === true || peerInfo.waiting === true
        const wasExplicit = peerInfo.explicit === true
        const remembered = this._discoveredPeerHints.get(keyHex) || {}
        const nextHint = {
          ...remembered,
          peerInfo,
          queued: wasQueued,
          explicit: wasExplicit,
        }
        if (wasQueued && peerInfo.explicit !== true) {
          peerInfo.explicit = true
          if (typeof peerInfo._updatePriority === 'function') peerInfo._updatePriority()
          this._directPeerDialStats.lastReason = 'dial-already-pending-promoted'
        }
        this._discoveredPeerHints.set(keyHex, nextHint)
        return nextHint
      }

      return this._discoveredPeerHints.get(keyHex) || null
    } catch (err) {
      this._directPeerLastDialError.set(keyHex, err?.message || String(err))
      if (err?.stack) this._directPeerLastDialErrorStack.set(keyHex, err.stack)
      return null
    }
  }

  _swarmDialState(keyHex, publicKey = null) {
    const peers = this.swarm?.peers
    let peerInfo = peers && typeof peers.get === 'function' ? peers.get(keyHex) : null
    if (!peerInfo && peers && typeof peers.get === 'function' && publicKey) {
      try { peerInfo = peers.get(publicKey) } catch { peerInfo = null }
    }
    if (!peerInfo || typeof peerInfo !== 'object') return null

    const relayAddresses = Array.isArray(peerInfo.relayAddresses) ? peerInfo.relayAddresses : []
    const topics = Array.isArray(peerInfo.topics) ? peerInfo.topics : []
    return {
      attempts: Number(peerInfo.attempts || 0),
      queued: Boolean(peerInfo.queued),
      waiting: Boolean(peerInfo.waiting),
      explicit: Boolean(peerInfo.explicit),
      banned: Boolean(peerInfo.banned),
      proven: Boolean(peerInfo.proven),
      client: Boolean(peerInfo.client),
      connectedTime: Number(peerInfo.connectedTime ?? -1),
      disconnectedTime: Number(peerInfo.disconnectedTime || 0),
      relayAddresses: relayAddresses.length,
      topics: topics.length,
    }
  }

  getDirectPeerDialStats() {
    const peers = []
    for (const [keyHex] of this._discoveredPeers) {
      const publicKey = this._discoveredPeers.get(keyHex)
      const swarm = this._swarmDialState(keyHex, publicKey)
      const hint = this._discoveredPeerHints.get(keyHex)
      peers.push({
        key: keyHex.slice(0, 16),
        attempts: swarm?.attempts || 0,
        discoveredRelayAddresses: Number(hint?.relayAddressesSeen || 0),
        lastSeenAt: hint?.lastSeenAt || null,
        lastDialedAt: this._directPeerLastDialedAt.get(keyHex) || null,
        lastQueuedAt: null,
        lastError: this._directPeerLastDialError.get(keyHex) || null,
        lastErrorStack: this._directPeerLastDialErrorStack.get(keyHex) || null,
        pending: Boolean(swarm?.queued || swarm?.waiting),
        connected: this._hasActivePeerConnection(keyHex, publicKey),
        score: Number(this._peerDirectory.get(keyHex)?.score || 0),
        joined: Boolean(this._peerDirectory.get(keyHex)?.joined),
        demoted: Boolean(this._peerDirectory.get(keyHex)?.demoted),
        swarm,
      })
    }

    return {
      ...this._directPeerDialStats,
      discoveredPeers: this._discoveredPeers.size,
      pending: peers.filter((peer) => peer.pending).length,
      maxDirectPeers: null,
      maxDirectPeerRetries: null,
      swarmPeers: this.swarm?.peers?.size || 0,
      swarmConnections: this.swarm?.connections?.size || 0,
      swarmAllConnections: this.swarm?._allConnections?.size || 0,
      swarmConnecting: Number(this.swarm?.connecting || 0),
      swarmExplicitPeers: this.swarm?.explicitPeers?.size || 0,
      swarmQueueSize: this.swarm?._queue?.length || 0,
      recoveryEvents: this._recoveryEvents.slice(-5),
      recoveryCooldownMs: this._recoveryCooldownMs,
      lastRecoveryAt: this._lastRecoveryAt || null,
      peers,
    }
  }

  /**
   * Start the public feed manager - restore cache and wire current connections
   */
  async start() {
    if (this.started) return;
    this.started = true;
    this._recordStartupEvent('public-feed-start-called')
    console.log('[PublicFeed] ===== STARTING PUBLIC FEED =====');

    // Reuse the storage-owned peartube-network discovery handle when present.
    // Storage joins the topic immediately at startup/resume; the feed catalog
    // layer should not create a second app-level join path.
    if (this.swarm.peerPoolDiscovery) {
      this.feedDiscovery = this.swarm.peerPoolDiscovery
      this._ownsFeedDiscovery = false
      this._recordStartupEvent('public-feed-topic-owned-by-storage', { topicHex: NETWORK_TOPIC_HEX })
      try { this.swarm.status?.(NETWORK_TOPIC) } catch { /* diagnostic only */ }
    } else {
      try {
        this.feedDiscovery = this.swarm.join(NETWORK_TOPIC, { server: true, client: true })
        this._ownsFeedDiscovery = true
        this._recordStartupEvent('public-feed-topic-owned-by-storage', { topicHex: NETWORK_TOPIC_HEX, fallbackJoin: true })
        this._recordStartupEvent('public-feed-topic-join-called', { topicHex: NETWORK_TOPIC_HEX })
        this.feedDiscovery?.flushed?.().then(() => {
          this._recordStartupEvent('public-feed-topic-flushed', { peers: this.swarm.peers?.size || 0, connections: this.swarm.connections?.size || 0 })
          console.log('[PublicFeed] Shared network feed discovery flushed, connections:', this.swarm.connections?.size || 0)
        }).catch(() => {})
        console.log('[PublicFeed] Joined shared network feed topic:', NETWORK_TOPIC_HEX.slice(0, 16))
      } catch (err) {
        console.log('[PublicFeed] Shared network feed topic join failed:', err?.message)
        this.feedDiscovery = null
      }
    }

    // Wire existing connections before cache restore reads.
    // Set up feed protocol on any existing connections.
    const existingConns = this.swarm.connections?.size || 0;
    console.log('[PublicFeed] Setting up feed protocol on', existingConns, 'existing connections');
    for (const conn of this.swarm.connections) {
      this.handleConnection(conn, {});
    }

    // Restore hidden channels before any cached entries so addEntry() filters
    // them out — otherwise channels the user hid reappear on every restart.
    if (this.metaDb) {
      try {
        const hidden = await this.metaDb.get(PUBLIC_FEED_HIDDEN_CHANNELS_KEY).catch(() => null)
        if (Array.isArray(hidden?.value)) {
          for (const key of hidden.value) {
            if (typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key)) this.hiddenKeys.add(key)
          }
          if (this.hiddenKeys.size > 0) {
            console.log('[PublicFeed] Restored', this.hiddenKeys.size, 'hidden channels from db')
          }
        }
      } catch (err) {
        console.log('[PublicFeed] Hidden-channel restore skipped:', err?.message)
      }
    }

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
            const restoredEntry = this._markRestoredDiscoveryOnly(entry, 'discovered-channels-v2')
            if (entry.driveKey && this.addEntry(entry.driveKey, 'peer', entry.publicBeeKey, restoredEntry)) {
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
              if (this.addEntry(key, 'peer', null, this._markRestoredDiscoveryOnly({ driveKey: key }, 'legacy-discovered-channels'))) restored++
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

    // Restore first-class relay catalog entries after legacy feed entries so richer
    // relay-serving metadata wins on restart.
    if (this.metaDb) {
      try {
        const catalog = await this.metaDb.get(PUBLIC_FEED_RELAY_CATALOG_KEY).catch(() => null)
        const entries = Array.isArray(catalog?.value?.entries) ? catalog.value.entries : []
        let restoredCatalog = 0
        for (const entry of entries) {
          const restoredEntry = this._markRestoredDiscoveryOnly(entry, PUBLIC_FEED_RELAY_CATALOG_KEY)
          if (entry?.driveKey && this.addEntry(entry.driveKey, entry.source || 'relay-cache', entry.publicBeeKey, restoredEntry)) {
            restoredCatalog++
          } else if (entry?.driveKey && this._applyEntrySnapshot(entry.driveKey, restoredEntry)) {
            restoredCatalog++
          }
        }
        if (restoredCatalog > 0) console.log('[PublicFeed] Restored', restoredCatalog, 'relay catalog entries')
      } catch (err) {
        console.log('[PublicFeed] Relay catalog restore skipped:', err?.message)
      }
    }

    // If we loaded any entries from disk, notify listeners so UIs don't stay empty until the first peer message arrives.
    if (this.entries.size > 0) {
      console.log('[PublicFeed] Notifying listeners of', this.entries.size, 'restored entries');
      try { this.onFeedUpdate?.(); } catch {}
    }

    console.log('[PublicFeed] ===== PUBLIC FEED STARTED =====');
  }

  _openFeedConnections() {
    return Array.from(this.feedConnections)
      .filter((conn) => this.peerChannels.has(conn))
  }

  _feedConnectionStats() {
    const openConnections = this._openFeedConnections().length
    return {
      openConnections,
      channelCandidates: this.peerChannels.size,
      candidateConnections: this.peerChannels.size,
      rememberedPeerCandidates: this._discoveredPeers.size,
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
    this._connectionIds.clear();
    this._connectionStartedAt.clear();
    try {
      for (const pending of this.pendingAvailabilityRequests.values()) {
        try { clearTimeout(pending.timeout) } catch {}
        try { pending.resolve([]) } catch {}
      }
      this.pendingAvailabilityRequests.clear()
      this._discoveredPeers.clear()
      this._discoveredPeerHints.clear()
      this._peerDirectory.clear()
      this._connectionPeerKeys.clear()
      this._recoveryEvents.length = 0
      this._directPeerLastDialedAt.clear()
      this._directPeerLastDialError.clear()
      this._directPeerLastDialErrorStack.clear()
      if (this._persistTimer) clearTimeout(this._persistTimer)
      if (this._ownsFeedDiscovery) this.feedDiscovery?.destroy?.()
    } catch {}
    this._persistTimer = null
    this.feedDiscovery = null
    this._ownsFeedDiscovery = false
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
        .filter((e) => e.source === 'local' || (e.peerCount || 0) > 0 || isValidKey(this._resolvePublicBeeKey(e)))
        .slice(0, this._persistMaxEntries)
        .map(e => ({
          driveKey: e.driveKey,
          publicBeeKey: this._resolvePublicBeeKey(e) || null,
          source: e.source || 'peer',
          schema: e.schema || 'peartube.relayCatalog',
          catalogVersion: Number(e.catalogVersion || PUBLIC_FEED_CATALOG_VERSION) || PUBLIC_FEED_CATALOG_VERSION,
          relayRole: e.relayRole || null,
          relayServing: Boolean(e.relayServing),
          discoveryOnly: Boolean(e.discoveryOnly),
          restoredFromCache: Boolean(e.restoredFromCache),
          restoredFrom: e.restoredFrom || null,
          requiresAvailabilityProbe: Boolean(e.requiresAvailabilityProbe),
          lastSeenAt: e.lastSeenAt || e.addedAt || Date.now(),
          channelName: e.channelName || null,
          videoCount: Number(e.videoCount || 0) || 0,
          manifestUpdatedAt: Number(e.manifestUpdatedAt || 0) || 0,
          previewVideos: this._sanitizePreviewVideos(e.previewVideos),
          signedDescriptor: this._normalizeSignedDescriptor(e.signedDescriptor),
        }))
      await this.metaDb.put('discovered-channels-v2', entries)

      // Also keep legacy keys array for backward compatibility
      const keys = entries.map(e => e.driveKey)
      await this.metaDb.put('discovered-channels', keys)
      await this.metaDb.put('public-feed-cache', keys)
      const relayCatalogEntries = entries
        .filter(e => e.relayServing || e.source === 'relay-cache' || e.relayRole === 'cache')
        .map(e => ({
          ...e,
          schema: 'peartube.relayCatalog',
          catalogVersion: PUBLIC_FEED_CATALOG_VERSION,
          relayRole: e.relayRole || 'cache',
          relayServing: Boolean(e.relayServing || e.source === 'relay-cache' || e.relayRole === 'cache'),
          lastSeenAt: e.lastSeenAt || Date.now(),
        }))
      await this.metaDb.put(PUBLIC_FEED_RELAY_CATALOG_KEY, {
        schema: 'peartube.relayCatalog',
        version: PUBLIC_FEED_CATALOG_VERSION,
        entries: relayCatalogEntries,
        updatedAt: Date.now(),
      })
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

    const label = this._connectionLabel(conn, info)
    const remoteKey = info?.publicKey || conn.remotePublicKey || conn.publicKey
    this._connectionPeerKeys.set(conn, remoteKey)
    this._markPeerConnected(remoteKey)
    console.log('[PublicFeed] handleConnection:', label, 'setting up feed protocol on new connection');
    this._recordStartupEvent('feed-socket-connected', { connection: label })
    this.wiredConnections.add(conn);

    let mux;
    try {
      mux = Protomux.from(conn);
    } catch (err) {
      this._forgetConnection(conn);
      console.error('[PublicFeed] Protomux.from failed during handshake:', label, err?.message || err, err?.stack || '')
      return;
    }

    try {
      mux.pair({ protocol: PROTOCOL_NAME }, () => {
        try {
          this.createFeedChannel(mux, conn);
        } catch (err) {
          console.error('[PublicFeed] mux.pair createFeedChannel failed:', label, err?.message || err, err?.stack || '')
        }
      });
    } catch (err) {
      this._forgetConnection(conn);
      console.error('[PublicFeed] mux.pair failed during handshake:', label, err?.message || err, err?.stack || '')
      return
    }

    try {
      this.setupFeedProtocol(conn, mux);
    } catch (err) {
      this._forgetConnection(conn);
      console.error('[PublicFeed] setupFeedProtocol failed during handshake:', label, err?.message || err, err?.stack || '')
    }
  }

  setupFeedProtocol(conn, mux) {
    const label = this._connectionLabel(conn)
    console.log('[PublicFeed] setupFeedProtocol:', label, 'creating feed channel from our side');
    this.createFeedChannel(mux, conn);

    // Clean up on connection close
    conn.on('close', () => {
      console.log('[PublicFeed] Connection closed:', label, 'ageMs=', this._connectionAgeMs(conn));
      this._recordPeerConnectionOutcome(conn, 'closed');
      this._forgetConnection(conn);
    });

    conn.on('error', (err) => {
      console.error('[PublicFeed] Connection error:', label, err.message, 'ageMs=', this._connectionAgeMs(conn));
      this._recordPeerConnectionOutcome(conn, 'error');
      this._forgetConnection(conn);
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

    const label = this._connectionLabel(conn)
    console.log('[PublicFeed] createFeedChannel:', label, 'creating channel with protocol:', PROTOCOL_NAME);

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
        console.log('[PublicFeed] Feed channel opened:', label, 'Total feed connections:', this.feedConnections.size + 1, 'ageMs=', this._connectionAgeMs(conn));
        this._recordStartupEvent('protomux-feed-open', { connection: label, ageMs: this._connectionAgeMs(conn), feedConnections: this.feedConnections.size + 1 })
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
      },
      onclose: () => {
        console.log('[PublicFeed] Feed channel closed:', label, 'ageMs=', this._connectionAgeMs(conn));
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

    console.log('[PublicFeed] createFeedChannel:', label, 'channel created, storing and opening');

    // Store the channel
    this.peerChannels.set(conn, channel);

    // Open the channel
    try {
      channel.open();
      console.log('[PublicFeed] createFeedChannel:', label, 'channel.open() called');
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

    // Advertise entries that can resolve to a usable PublicBee key, including
    // migrated / verification-path entries that only expose the key via the
    // signed descriptor metadata.
    const baseEntries = Array.from(this.entries.values())
      .filter((entry) => isValidKey(this._resolvePublicBeeKey(entry)))
      // Do not re-gossip every stale peer-discovered channel. Android peers were
      // OOMing after relays reset because old cached feeds ballooned to 100+
      // mostly-unavailable entries. A relay should advertise what it can serve
      // or has explicitly published, not every historical key it heard about.
      .filter((entry) => this._isLocallyBackedEntry(entry))
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

  _applyPeerFeedKeys(conn, keys) {
    const nextKeys = (keys || []).filter(Boolean)
    if (nextKeys.length === 0) return false

    let peerKeys = this.peerFeedKeys.get(conn)
    if (!peerKeys) {
      peerKeys = new Set()
      this.peerFeedKeys.set(conn, peerKeys)
    }

    let changed = false
    for (const key of nextKeys) {
      if (peerKeys.has(key)) continue
      peerKeys.add(key)
      this.entryPeerCounts.set(key, (this.entryPeerCounts.get(key) || 0) + 1)
      changed = true
    }

    return changed
  }


  _prunePeerFeedKeysToEntries(conn) {
    const peerKeys = this.peerFeedKeys.get(conn)
    if (!peerKeys) return false
    let changed = false
    for (const key of Array.from(peerKeys)) {
      if (this.entries.has(key)) continue
      peerKeys.delete(key)
      this.entryPeerCounts.delete(key)
      changed = true
    }
    if (peerKeys.size === 0) this.peerFeedKeys.delete(conn)
    return changed
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
        // Keep cached peer-discovered channels if they have a resolvable PublicBee key.
        // This lets discovery/feed hydration continue to show cached channels and
        // videos even when no live peer is currently connected.
        const keepCachedPeerEntry =
          entry?.source === 'peer' &&
          /^[a-f0-9]{64}$/i.test(this._resolvePublicBeeKey(entry))

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
      void (async () => {
        let added = 0;
        let updated = 0;
        let announcedKeys = []
        let receivedCount = 0

        // Prefer new entries format (with publicBeeKey).
        // Cap processed entries per message: each verified entry costs a
        // signature check, and a hostile peer must not be able to pin the CPU
        // or balloon memory with one oversized HAVE_FEED.
        if (msg.entries && Array.isArray(msg.entries)) {
          log.debug('HAVE_FEED received (entries)', { count: msg.entries.length })
          receivedCount = msg.entries.length
          for (const entry of msg.entries.slice(0, this._persistMaxEntries)) {
            if (!entry?.driveKey) continue
            const entrySource = 'peer'
            const resolvedPublicBeeKey = this._resolvePublicBeeKey(entry)
            const result = await this._ingestVerifiedPeerEntry(entry.driveKey, entrySource, resolvedPublicBeeKey, entry)
            if (!result.accepted) continue
            announcedKeys.push(entry.driveKey)
            if (result.added) added++
            else if (result.updated) updated++
          }
        }
        // Fallback to legacy keys array. Legacy drive-key-only gossip is not authoritative enough
        // to create new public feed entries, but still records what this peer claims to know.
        else if (msg.keys && Array.isArray(msg.keys)) {
          log.debug('HAVE_FEED received (legacy keys)', { count: msg.keys.length })
          receivedCount = msg.keys.length
          announcedKeys = msg.keys
            .filter((key) => typeof key === 'string' && key.length > 0)
            .slice(0, this._persistMaxEntries)
        }

        let peerSetChanged = this._applyPeerFeedKeys(conn, announcedKeys)
        this._enforceFeedEntryLimit()
        peerSetChanged = this._prunePeerFeedKeysToEntries(conn) || peerSetChanged
        if (!this._startupEvents.some((event) => event.name === 'first-have-feed-received')) {
          this._recordStartupEvent('first-have-feed-received', { keys: announcedKeys.length, entries: receivedCount })
        }
        try {
          this.onFeedSync?.({ type: 'HAVE_FEED', added, received: receivedCount });
        } catch {}

        log.debug('Merged feed entries', { added, total: this.entries.size })
        if (added > 0 || updated > 0 || peerSetChanged) {
          this.onFeedUpdate?.();
          this._schedulePersistDiscovered()
        }
      })().catch((error) => {
        log.warn('HAVE_FEED ingest failed', { error: error?.message || String(error) })
      })
    }
    // Handle SUBMIT_CHANNEL - peer is broadcasting a new channel
    else if (msg.type === 'SUBMIT_CHANNEL' && msg.key) {
      void (async () => {
        console.log('[PublicFeed] SUBMIT_CHANNEL received:', msg.key?.slice(0, 16), 'publicBee:', msg.publicBeeKey?.slice(0, 16) || 'none');
        const resolvedPublicBeeKey = this._resolvePublicBeeKey(msg)
        const result = await this._ingestVerifiedPeerEntry(msg.key, 'peer', resolvedPublicBeeKey, msg)
        if (!result.accepted) return
        const peerSetChanged = this._applyPeerFeedKeys(conn, [msg.key])
        if (result.added) {
          this.onFeedUpdate?.();
          this._schedulePersistDiscovered()
          // Re-gossip to other peers (exclude sender, include publicBeeKey)
          this.broadcastSubmitChannel(msg.key, conn, msg.publicBeeKey, msg);
        } else if (result.updated) {
          this.onFeedUpdate?.()
          this._schedulePersistDiscovered()
        } else if (peerSetChanged) {
          this.onFeedUpdate?.()
        }
      })().catch((error) => {
        log.warn('SUBMIT_CHANNEL ingest failed', { key: String(msg.key || '').slice(0, 16), error: error?.message || String(error) })
      })
    }
    // Handle legacy NEED_FEED/FEED_RESPONSE for backwards compat
    else if (msg.type === 'NEED_FEED') {
      console.log('[PublicFeed] NEED_FEED received, sending our feed');
      this.sendHaveFeed(conn);
    }
    else if (msg.type === 'FEED_RESPONSE' && msg.keys) {
      console.log('[PublicFeed] FEED_RESPONSE received with', msg.keys?.length || 0, 'keys');
      let added = 0;
      const announcedKeys = Array.isArray(msg.keys)
        ? msg.keys.filter((key) => typeof key === 'string' && key.length > 0).slice(0, this._persistMaxEntries)
        : []
      const peerSetChanged = this._applyPeerFeedKeys(conn, announcedKeys)
      try {
        this.onFeedSync?.({ type: 'FEED_RESPONSE', added, received: msg.keys.length });
      } catch {}
      if (added > 0 || peerSetChanged) {
        this.onFeedUpdate?.();
        if (added > 0) this._schedulePersistDiscovered()
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
    const resolvedPublicBeeKey = this._resolvePublicBeeKey({ publicBeeKey, ...(snapshot || {}) })

    // Accept legacy peer entries even if they don't include a PublicBee key yet.
    // Prefer keyed entries when available, but do not drop the channel entirely —
    // older peers may still announce only drive keys, and we can hydrate via
    // channel/autobase fallback once the feed entry is visible.

    // Skip if already exists or hidden
    if (this.entries.has(driveKey) || this.hiddenKeys.has(driveKey)) {
      // Update publicBeeKey if we didn't have it before
      const existing = this.entries.get(driveKey)
      if (existing && !existing.publicBeeKey && isValidKey(resolvedPublicBeeKey)) {
        existing.publicBeeKey = resolvedPublicBeeKey
        this._schedulePersistDiscovered()
      }
      if (existing && snapshot && this._applyEntrySnapshot(driveKey, {
        ...snapshot,
        publicBeeKey: isValidKey(resolvedPublicBeeKey) ? resolvedPublicBeeKey : existing.publicBeeKey || null,
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
      publicBeeKey: isValidKey(resolvedPublicBeeKey) ? resolvedPublicBeeKey : null, // Key for viewers to use (auto-replicating Hyperbee)
      addedAt: Date.now(),
      source,
      peerCount: source === 'local' ? 1 : 0,
      schema: snapshot?.schema || 'peartube.relayCatalog',
      catalogVersion: Number(snapshot?.catalogVersion || PUBLIC_FEED_CATALOG_VERSION) || PUBLIC_FEED_CATALOG_VERSION,
      relayRole: snapshot?.relayRole || (source === 'relay-cache' ? 'cache' : source === 'local' ? 'publisher' : null),
      relayServing: Boolean(snapshot?.relayServing || source === 'relay-cache' || source === 'local'),
      discoveryOnly: Boolean(snapshot?.discoveryOnly),
      restoredFromCache: Boolean(snapshot?.restoredFromCache),
      restoredFrom: typeof snapshot?.restoredFrom === 'string' ? snapshot.restoredFrom : null,
      requiresAvailabilityProbe: Boolean(snapshot?.requiresAvailabilityProbe),
      lastSeenAt: Number(snapshot?.lastSeenAt || Date.now()) || Date.now(),
      channelName: snapshot?.channelName || null,
      videoCount: Number(snapshot?.videoCount || 0) || 0,
      manifestUpdatedAt: Number(snapshot?.manifestUpdatedAt || 0) || 0,
      previewVideos: this._sanitizePreviewVideos(snapshot?.previewVideos),
      signedDescriptor: this._normalizeSignedDescriptor(snapshot?.signedDescriptor),
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
  async submitChannel(driveKey, publicBeeKey = null, options = {}) {
    let snapshot = null
    if (this.feedSnapshotProvider) {
      const resolved = await this._resolveFeedSnapshots([{ driveKey, publicBeeKey }], null).catch(() => null)
      snapshot = Array.isArray(resolved) ? resolved[0] || null : null
    }
    const resolvedPublicBeeKey = this._resolvePublicBeeKey({ publicBeeKey, ...(snapshot || {}) })

    const explicitSnapshot = options && typeof options === 'object'
      ? {
          channelName: typeof options.channelName === 'string' ? options.channelName.trim() : null,
          videoCount: Number.isFinite(options.videoCount) ? Number(options.videoCount) : undefined,
          manifestUpdatedAt: Number.isFinite(options.manifestUpdatedAt) ? Number(options.manifestUpdatedAt) : undefined,
          previewVideos: Array.isArray(options.previewVideos) ? this._sanitizePreviewVideos(options.previewVideos) : undefined,
        }
      : null

    snapshot = {
      ...(explicitSnapshot || {}),
      ...(snapshot || {}),
    }

    if (this.addEntry(driveKey, 'local', resolvedPublicBeeKey, snapshot)) {
      console.log('[PublicFeed] Submitted local channel:', driveKey.slice(0, 16), 'publicBee:', resolvedPublicBeeKey?.slice(0, 16) || 'none');
      this.onFeedUpdate?.();
    } else if (resolvedPublicBeeKey) {
      // Entry existed but we're adding publicBeeKey
      const entry = this.entries.get(driveKey)
      let changed = false
      if (entry && !entry.publicBeeKey) {
        entry.publicBeeKey = resolvedPublicBeeKey
        changed = true
        console.log('[PublicFeed] Updated existing entry with publicBeeKey:', resolvedPublicBeeKey.slice(0, 16));
      }
      if (entry && this._applyEntrySnapshot(driveKey, { ...snapshot, publicBeeKey: entry.publicBeeKey || resolvedPublicBeeKey })) {
        changed = true
      }
      if (changed) this.onFeedUpdate?.();
    }

    // Persist to database so it survives restart (use v2 format with publicBeeKey)
    if (!this.publishedChannels.has(driveKey)) {
      this.publishedChannels.add(driveKey);
    }
    await this._persistPublishedChannels();

    // Broadcast to all peers (include publicBeeKey)
    this.broadcastSubmitChannel(driveKey, null, resolvedPublicBeeKey, snapshot);
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
          publicBeeKey: this._resolvePublicBeeKey(entry) || null,
          channelName: entry?.channelName || null,
          videoCount: Number(entry?.videoCount || 0) || 0,
          manifestUpdatedAt: Number(entry?.manifestUpdatedAt || 0) || 0,
          previewVideos: this._sanitizePreviewVideos(entry?.previewVideos),
          signedDescriptor: this._normalizeSignedDescriptor(entry?.signedDescriptor),
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
   * Submit relay-owned/cache-serving catalog inventory without marking it as a
   * user-published channel.
   * @param {Object} entry
   */
  async submitRelayCatalogEntry(entry = {}) {
    const driveKey = entry.driveKey || entry.channelKey
    const publicBeeKey = this._resolvePublicBeeKey(entry)
    if (!driveKey || !publicBeeKey) return false

    const snapshot = {
      ...entry,
      schema: 'peartube.relayCatalog',
      catalogVersion: PUBLIC_FEED_CATALOG_VERSION,
      source: 'relay-cache',
      relayRole: entry.relayRole || 'cache',
      relayServing: true,
      lastSeenAt: Date.now(),
      previewVideos: this._sanitizePreviewVideos(entry.previewVideos),
    }

    const added = this.addEntry(driveKey, 'relay-cache', publicBeeKey, snapshot)
    const updated = !added && this._applyEntrySnapshot(driveKey, snapshot)
    if (added || updated) {
      console.log('[PublicFeed] Submitted relay catalog entry:', driveKey.slice(0, 16), 'videos=', snapshot.previewVideos.length)
      this.onFeedUpdate?.()
    }
    this.broadcastSubmitChannel(driveKey, null, publicBeeKey, snapshot)
    this._schedulePersistDiscovered()
    await this._persistDiscoveredNow().catch(() => {})
    return true
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
      schema: snapshot?.schema || 'peartube.relayCatalog',
      catalogVersion: Number(snapshot?.catalogVersion || PUBLIC_FEED_CATALOG_VERSION) || PUBLIC_FEED_CATALOG_VERSION,
      source: snapshot?.source || null,
      relayRole: snapshot?.relayRole || null,
      relayServing: Boolean(snapshot?.relayServing),
      discoveryOnly: Boolean(snapshot?.discoveryOnly),
      restoredFromCache: Boolean(snapshot?.restoredFromCache),
      restoredFrom: snapshot?.restoredFrom || null,
      requiresAvailabilityProbe: Boolean(snapshot?.requiresAvailabilityProbe),
      lastSeenAt: snapshot?.lastSeenAt || Date.now(),
      channelName: snapshot?.channelName || null,
      videoCount: Number(snapshot?.videoCount || 0) || 0,
      manifestUpdatedAt: Number(snapshot?.manifestUpdatedAt || 0) || 0,
      previewVideos: this._sanitizePreviewVideos(snapshot?.previewVideos),
      signedDescriptor: this._normalizeSignedDescriptor(snapshot?.signedDescriptor),
    };

    const openConns = this._openFeedConnections()
    console.log(
      '[PublicFeed] Broadcast SUBMIT_CHANNEL open feed connections=',
      openConns.length,
      'channelCandidates=',
      this.peerChannels.size
    )

    let sent = 0;
    for (const conn of openConns) {
      if (conn === excludeConn) continue;
      const channel = this.peerChannels.get(conn)
      if (!channel) continue
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
   * Legacy feed polling has been retired; retained for compatibility.
   * @returns {number} Number of peers contacted
   */
  requestFeedsFromPeers() {
    return 0;
  }

  /**
   * Hide a channel locally
   * @param {string} driveKey
   */
  hideChannel(driveKey) {
    this.hiddenKeys.add(driveKey);
    this.entries.delete(driveKey);
    console.log('[PublicFeed] Hidden channel:', driveKey.slice(0, 16));
    this._persistHiddenChannels().catch(() => {})
    this._schedulePersistDiscovered()
  }

  async _persistHiddenChannels() {
    if (!this.metaDb) return
    try {
      await this.metaDb.put(PUBLIC_FEED_HIDDEN_CHANNELS_KEY, Array.from(this.hiddenKeys))
    } catch (err) {
      console.log('[PublicFeed] Failed to persist hidden channels:', err?.message)
    }
  }

  /**
   * Get the current feed (filtered by hidden)
   * @returns {PublicFeedEntry[]}
   */
  getFeed() {
    const isValidKey = (k) => typeof k === 'string' && /^[a-f0-9]{64}$/i.test(k)
    return Array.from(this.entries.values())
      .filter(e => !this.hiddenKeys.has(e.driveKey))
      .map((entry) => ({
        ...entry,
        publicBeeKey: this._resolvePublicBeeKey(entry) || null,
        peerCount: entry.source === 'local'
          ? Math.max(1, this.entryPeerCounts.get(entry.driveKey) || 0)
          : (this.entryPeerCounts.get(entry.driveKey) || 0)
      }))
      .filter((entry) => {
        // Local channels always stay visible.
        if (entry.source === 'local') return true
        // Peer-discovered channels with live peers are visible.
        if ((entry.peerCount || 0) > 0) return true
        // Relay catalog entries are explicit cache-serving inventory and must
        // remain visible even when no live feed socket is currently open.
        if (entry.relayServing && (isValidKey(this._resolvePublicBeeKey(entry)) || this._sanitizePreviewVideos(entry.previewVideos).some(v => v.blobId && v.blobsCoreKey))) return true
        // IMPORTANT: keep cached peer-discovered channels visible if they carry
        // a valid publicBeeKey. This is what allows the app to hydrate/feed-load
        // instantly on restart instead of coming up empty until a live gossip peer
        // is connected again.
        return /^[a-f0-9]{64}$/i.test(this._resolvePublicBeeKey(entry))
      })
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  /**
   * Get feed statistics
   * @returns {{totalEntries: number, hiddenCount: number, peerCount: number}}
   */
  getStats() {
    const feed = this._feedConnectionStats()
    return {
      totalEntries: this.entries.size,
      hiddenCount: this.hiddenKeys.size,
      peerCount: feed.openConnections,
      feedConnections: feed.openConnections,
      feedChannelCandidates: feed.channelCandidates,
      candidateConnections: feed.candidateConnections,
      rememberedPeerCandidates: feed.rememberedPeerCandidates,
      directPeerDial: this.getDirectPeerDialStats(),
      startupTiming: this.getStartupTiming(),
    };
  }

}

export const PublicFeedManager = PublicFeed
