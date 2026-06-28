/**
 * Core API Module - Shared backend API methods
 *
 * These methods are used by both mobile and desktop backends.
 * They operate on the storage context and return results.
 */

import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import HypercoreID from 'hypercore-id-encoding';
import z32 from 'z32';
import c from 'compact-encoding';
import { getVideoUrlFromBlob, loadChannel as storageLoadChannel, loadPublicBee as storageLoadPublicBee, pairDevice as pairChannelDevice, suspendNetworking, resumeNetworking, setPlaybackActive as storageSetPlaybackActive, isPlaybackActive as storageIsPlaybackActive, getNetworkStats, getNetworkStatsReadable, retainSwarmDiscovery } from './storage.js';
import { createBlobPlaybackService } from './blob-playback-service.js';
import { addRelayLink as persistAddRelayLink, removeRelayLink as persistRemoveRelayLink, loadRelayLinks } from './relay-links.js';
import { createLiveBroadcastService, createLivePlaybackService } from './live/index.js';
import { subscribeBlobPlayhead } from './blob-range-priority.js';
import { beginPlaybackTiming, markPlaybackTiming } from './playback-timing.js';
import { SemanticFinder } from './search/semantic-finder.js';
import { buildMetadataEnvelope } from './search/metadata-envelope.js';
import { FederatedSearch } from './search/federated-search.js';
import { Recommender } from './recommendations/recommender.js';
import { getVideoToolboxDecodeSettings, setVideoToolboxDecodeEnabled, setVideoToolboxHwMapEnabled } from './transcode/videotoolbox-settings.mjs';
import { buildBlobRefCacheKey, normalizeBlobsCoreKey, normalizeBlobRefInput, parseBlobRef, stringifyBlobId } from './blob-ref.js';
import { encodeIndexKey } from './index-encoder.js'
import { NETWORK_TOPIC_STRING } from './types.js'
import { SeedingAuthorizationError, fullDownloadFitsQuota } from './seeding.js'
import { collectCorestoreGarbage } from './corestore-gc.js'
import { peerHasFullRange, collectFullCopyPeers, assessOffloadEligibility } from './upload-offload.js'
import { verifySignedChannelRootDescriptor } from './channel-descriptor.js'

/**
 * @typedef {import('./types.js').StorageContext} StorageContext
 * @typedef {import('./types.js').Identity} Identity
 * @typedef {import('./types.js').VideoMetadata} VideoMetadata
 * @typedef {import('./types.js').ChannelMetadata} ChannelMetadata
 */

function isSeedingAuthorizationError(err) {
  return err instanceof SeedingAuthorizationError || err?.name === 'SeedingAuthorizationError'
}

const PLAYBACK_STARTUP_PREFETCH_TIMEOUT_MS = 10000
// If a blob has synced peers but not one block has arrived in this window, the
// connection is almost certainly half-open (handshaked + synced, but unable to
// move data — observed: ~42s of zero data before hyperswarm's own ~56s timeout
// redials and blocks then flow at full speed). Drop the non-delivering
// connection so the swarm redials a fresh one in seconds. One shot per playback.
const PLAYBACK_STALL_RECONNECT_MS = 7000

// Best-effort extraction of a hypercore replication peer's 64-hex public key,
// to match it against a swarm connection's remotePublicKey.
function extractPeerKeyHex(peer) {
  try {
    const key = peer?.remotePublicKey || peer?.stream?.remotePublicKey || peer?.publicKey
    if (!key) return null
    const hex = typeof key === 'string' ? key : b4a.toString(key, 'hex')
    return /^[a-f0-9]{64}$/i.test(hex) ? hex.toLowerCase() : null
  } catch {
    return null
  }
}
const PLAYBACK_STATS_HANDOFF_TIMEOUT_MS = 250
const BLOB_PREFETCH_DISCOVERY_FLUSH_TIMEOUT_MS = 1500
const BLOB_PREFETCH_CORE_UPDATE_TIMEOUT_MS = 2500
const BLOB_PREFETCH_PEER_SYNC_TIMEOUT_MS = 2500

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getCorePeerListForReadiness(core) {
  const peers = core?.peers
  if (Array.isArray(peers)) return peers
  if (peers && typeof peers.values === 'function') return Array.from(peers.values())
  return []
}

function hasBlobPeerRemoteLength(core) {
  const peers = getCorePeerListForReadiness(core)
  return peers.some((peer) => {
    const remoteLength = Number(peer?.remoteLength || 0)
    const remoteContiguousLength = Number(peer?.remoteContiguousLength || 0)
    return peer?.remoteSynced === true || remoteLength > 0 || remoteContiguousLength > 0
  })
}

function summarizeBlobPeerReadiness(core) {
  const peers = getCorePeerListForReadiness(core)
  return {
    peers: peers.length,
    synced: peers.filter(peer => peer?.remoteSynced === true).length,
    remoteLengths: peers.slice(0, 3).map(peer => Number(peer?.remoteLength || 0)),
    remoteContiguousLengths: peers.slice(0, 3).map(peer => Number(peer?.remoteContiguousLength || 0)),
  }
}

async function waitForBlobPrefetchReadiness(core, discoveryHandle, label) {
  if (!core) return
  const initialPeers = Number(core.peers?.length || 0) || 0
  if (initialPeers > 0 && hasBlobPeerRemoteLength(core)) {
    console.log('[API] Blob prefetch peer-ready:', label, JSON.stringify(summarizeBlobPeerReadiness(core)))
    return
  }
  if (initialPeers > 0) {
    console.log('[API] Blob prefetch peer-unsynced:', label, JSON.stringify(summarizeBlobPeerReadiness(core)))
  }

  if (discoveryHandle && typeof discoveryHandle.flushed === 'function') {
    try {
      const flushed = await Promise.race([
        discoveryHandle.flushed().then(() => true),
        delay(BLOB_PREFETCH_DISCOVERY_FLUSH_TIMEOUT_MS).then(() => false)
      ])
      console.log('[API] Blob prefetch discovery flush:', label, flushed ? 'ready' : 'timeout', JSON.stringify(summarizeBlobPeerReadiness(core)))
    } catch (err) {
      console.log('[API] Blob prefetch discovery flush failed:', label, err?.message || err)
    }
  }

  if (hasBlobPeerRemoteLength(core)) return
  if (typeof core.update !== 'function') return

  try {
    const updated = await Promise.race([
      core.update({ wait: true }).then(() => true),
      delay(initialPeers > 0 ? BLOB_PREFETCH_PEER_SYNC_TIMEOUT_MS : BLOB_PREFETCH_CORE_UPDATE_TIMEOUT_MS).then(() => false)
    ])
    console.log('[API] Blob prefetch core update:', label, updated ? 'ready' : 'timeout', JSON.stringify(summarizeBlobPeerReadiness(core)))
    try { core.core?.replicator?.updateAll?.() } catch { /* best effort */ }
  } catch (err) {
    console.log('[API] Blob prefetch core update failed:', label, err?.message || err, JSON.stringify(summarizeBlobPeerReadiness(core)))
  }
}

/**
 * Create the API object with all shared methods
 *
 * @param {Object} deps
 * @param {StorageContext} deps.ctx - Storage context
 * @param {import('./public-feed.js').PublicFeedManager} [deps.publicFeed] - Public feed manager
 * @param {import('./seeding.js').SeedingManager} [deps.seedingManager] - Seeding manager
 * @param {import('./video-stats.js').VideoStatsTracker} [deps.videoStats] - Video stats tracker
 * @returns {Object}
 */
export function createApi({
  ctx,
  publicFeed,
  seedingManager,
  videoStats,
  loadChannel = storageLoadChannel,
  loadPublicBee = storageLoadPublicBee,
}) {
  const blobPlayback = createBlobPlaybackService(ctx)

  // Live services are lazy: most sessions never broadcast or watch live.
  let liveBroadcast = null
  let livePlayback = null
  function getLiveBroadcast() {
    if (!liveBroadcast) liveBroadcast = createLiveBroadcastService(ctx)
    return liveBroadcast
  }
  function getLivePlayback() {
    if (!livePlayback) livePlayback = createLivePlaybackService(ctx)
    return livePlayback
  }

  // Re-announce the channel's full set of active live sessions on the feed
  // (an empty set clears the live badge network-wide). Best-effort: feed
  // gossip must never fail a broadcast lifecycle call.
  function announceChannelLiveStreams(channelKey) {
    if (!channelKey || !liveBroadcast || typeof publicFeed?.setChannelLiveStreams !== 'function') return
    try {
      const liveStreams = []
      for (const session of liveBroadcast.sessions.values()) {
        if (session.state !== 'live') continue
        if ((session.writer?.descriptor?.channelKey || null) !== channelKey) continue
        liveStreams.push({
          videoId: session.videoId,
          liveCoreKey: session.liveCoreKey,
          title: session.writer?.descriptor?.title || null,
          startedAt: session.startedAt,
        })
      }
      publicFeed.setChannelLiveStreams(channelKey, liveStreams)
    } catch (err) {
      console.log('[API] live feed announce skipped:', err?.message || err)
    }
  }

  function toLivestreamStatus(stats) {
    if (!stats) return undefined
    const status = {
      state: stats.state || 'unknown',
      videoId: stats.videoId || undefined,
      liveCoreKey: stats.liveCoreKey || undefined,
      mediaBlocks: Number(stats.mediaBlocks) || 0,
      durationMs: Math.max(0, Math.round((Number(stats.durationS) || 0) * 1000)),
      peerCount: Number(stats.peerCount) || 0,
      startedAt: Number(stats.startedAt) || 0,
    }
    if (stats.endedAt) status.endedAt = Number(stats.endedAt)
    return status
  }

  async function isMultiWriterChannelKey(channelKey) {
    try {
      const res = await ctx.metaSubspaces.channelKinds.get(channelKey)
      return Boolean(res?.value)
    } catch {
      // Fall through to other checks
    }

    // Fallback: if channel is already loaded in-memory, treat it as multi-writer.
    if (ctx.channels && ctx.channels.has(channelKey)) return true

    // Fallback: if this channel key exists in identities as a channelKey, treat as multi-writer.
    try {
      const stored = await ctx.metaDb.get('identities')
      const identities = stored?.value || []
      if (identities.some((i) => i?.channelKey === channelKey || i?.driveKey === channelKey)) {
        // Backfill marker so future checks are fast
        try { await ctx.metaSubspaces.channelKinds.put(channelKey, { kind: 'autobase', backfilledAt: Date.now() }) } catch { /* best effort */ }
        return true
      }
    } catch { /* best effort */ }

    return false
  }

  async function markAsMultiWriterChannel(channelKey) {
    try {
      await ctx.metaSubspaces.channelKinds.put(channelKey, { kind: 'autobase', discoveredAt: Date.now() })
    } catch { /* best effort */ }
  }

  const withTimeout = (promise, timeoutMs, label) => {
    let timeout
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
    })
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
  }

  const listPublicBeeVideosBounded = async ({ publicBee, driveKey, publicBeeKey, timeoutMs = 1500 }) => {
    try {
      return await withTimeout(publicBee.listVideos(), timeoutMs, `PublicBee listVideos ${driveKey?.slice?.(0, 16) || ''} ${publicBeeKey?.slice?.(0, 16) || ''}`)
    } catch (err) {
      console.warn('[API] PublicBee listVideos bounded timeout/failure:', driveKey?.slice?.(0, 16), publicBeeKey?.slice?.(0, 16), err?.message)
      return []
    }
  }

  const loadChannelBounded = async (channelKey, timeoutMs = 2500) => {
    const label = `loadChannel ${channelKey?.slice?.(0, 16) || ''}`
    // Already-loaded channels resolve from the in-memory cache — no timeout needed.
    if (ctx.channels?.has?.(channelKey)) {
      return loadChannel(ctx, channelKey)
    }
    try {
      return await withTimeout(loadChannel(ctx, channelKey), timeoutMs, label)
    } catch (err) {
      if (!/timeout/i.test(err?.message || '')) throw err
      // Slow networks routinely blow the first deadline while the underlying
      // load keeps going (loadChannel dedupes concurrent loads), so retry once
      // with a doubled budget instead of failing hard.
      console.warn(`[API] ${label} timed out after ${timeoutMs}ms, retrying once`)
      return withTimeout(loadChannel(ctx, channelKey), timeoutMs * 2, `${label} retry`)
    }
  }

  /** @type {Map<string, {value: object|null, at: number}>} driveKey → cached signed channel root descriptor (misses retried after 60s) */
  const signedDescriptorCache = new Map()

  /**
   * Recent preparePlayback timing breakdowns (per-stage ms offsets from request
   * start). Surfaced via getSwarmStatus doctor.playback so the on-device
   * diagnostics panel can show where time-to-first-frame goes.
   */
  const recentPlaybackTimings = []
  const trackPlaybackTiming = (record) => {
    recentPlaybackTimings.push(record)
    while (recentPlaybackTimings.length > 8) recentPlaybackTimings.shift()
    return record
  }

  /**
   * Ensure SemanticFinder is initialized with persistence
   * YouTube-Fast: loads persisted index on first use for instant search
   */
  async function ensureSemanticFinder(context) {
    if (!context.semanticFinder) {
      context.semanticFinder = new SemanticFinder({ metaDb: context.metaDb })
      await context.semanticFinder.init()
      await context.semanticFinder.loadIndex()
      console.log('[API] SemanticFinder initialized, index size:', context.semanticFinder.globalSize())
    }
    return context.semanticFinder
  }

  async function buildSearchEnvelope(channelKey, videoId, options = {}) {
    const normalizeVideoId = (value) => {
      if (!value || typeof value !== 'string') return value
      if (value.startsWith('/videos/')) {
        const match = value.match(/\/videos\/([^.]+)/)
        if (match?.[1]) return match[1]
      }
      const base = value.split('/').pop() || value
      return base.replace(/\.[^./]+$/, '') || value
    }

    try {
      const channel = await loadChannelBounded(channelKey, 3000)
      if (!channel) return null
      const normalizedVideoId = normalizeVideoId(videoId)
      const video = await channel.getVideo(normalizedVideoId)
      if (!video) return null

      let channelMeta = null
      try {
        channelMeta = typeof channel.getMetadata === 'function' ? await channel.getMetadata() : null
      } catch { /* best effort */ }

      let comments = []
      if (options.includeComments !== false && channel.comments?.listComments) {
        try {
          comments = await channel.comments.listComments(normalizedVideoId, { page: 0, limit: 200 })
        } catch { /* best effort */ }
      }

      const subtitles = options.includeSubtitles === false
        ? []
        : (video.subtitles ?? video.subtitleText ?? video.transcript ?? video.captions ?? [])

      return buildMetadataEnvelope(video, {
        videoId: normalizedVideoId,
        channelKey,
        publicBeeKey: options.publicBeeKey || null,
        creatorName: options.creatorName || video.creatorName || video.sourceCreatorName || video.originalCreatorName || video.sourceAuthor || video.author || channelMeta?.creatorName || null,
        channelName: video.channelName || video.channel?.name || channelMeta?.name || null,
        comments,
        subtitles,
      })
    } catch (err) {
      console.log('[API] buildSearchEnvelope error:', err?.message)
      return null
    }
  }

  async function refreshSearchIndex(channelKey, videoId, options = {}) {
    try {
      if (!ctx.semanticFinder) return { success: false, skipped: true }
      const envelope = await buildSearchEnvelope(channelKey, videoId, options)
      if (!envelope) return { success: false, skipped: true }
      await ctx.semanticFinder.indexEnvelope(envelope, {
        channelKey,
        publicBeeKey: options.publicBeeKey || null,
      })
      return { success: true }
    } catch (err) {
      console.log('[API] refreshSearchIndex error:', err?.message)
      return { success: false, error: err?.message }
    }
  }

  /**
   * Background index videos for search (non-blocking)
   * YouTube-Fast: proactively indexes videos when they're listed
   */
  function backgroundIndexVideos(videos, channelKey) {
    if (!videos || videos.length === 0) return

    // Run indexing in background (don't await)
    ;(async () => {
      try {
        const finder = await ensureSemanticFinder(ctx)
        let indexed = 0
        for (const video of videos) {
          const needsMetadataRefresh =
            typeof finder.needsMetadataRefresh === 'function'
              ? finder.needsMetadataRefresh(video)
              : false
          if (!finder.hasVideo(video.id) || needsMetadataRefresh) {
            await finder.indexFromMetadata(video, channelKey)
            indexed++
          }
        }
        if (indexed > 0) {
          console.log('[API] Background indexed', indexed, 'videos from channel:', channelKey?.slice(0, 16))
        }
      } catch (err) {
        // Silently fail - indexing is best-effort
        console.log('[API] Background indexing error:', err?.message)
      }
    })()
  }

  // ------------------------------------------------------------
  // Lightweight in-memory caching (worker-local)
  // ------------------------------------------------------------
  // The app UI (home tab) re-mounts on navigation and calls getChannelMeta/listVideos each time.
  // Cache recent results in the backend worker so back-navigation is instant.
  const LIST_VIDEOS_CACHE_TTL_MS = 15_000
  const LIST_VIDEOS_EMPTY_CACHE_TTL_MS = 1_000
  const CHANNEL_META_CACHE_TTL_MS = 30_000
  const VIDEO_AVAILABILITY_CACHE_TTL_MS = 30_000
  const VIDEO_AVAILABILITY_NEGATIVE_CACHE_TTL_MS = 1_500
  /** @type {Map<string, Promise<any>>} */
  const prefetchInFlight = new Map()
  const activeRangeRequests = new Map() // key: `${driveKey}:${videoPath}`, value: { ranges: [], core, onDownload, onUpload }
  const activeOnDemandPlaybackStats = new Map() // key: normalized stats key -> { core, cleanup }

  function cleanupOnDemandPlaybackStats(statsKey) {
    const active = activeOnDemandPlaybackStats.get(statsKey)
    if (!active) return
    try { active.cleanup?.() } catch { /* best effort */ }
    activeOnDemandPlaybackStats.delete(statsKey)
  }

  async function countInitialBlobBlocks(core, startBlock, endBlock, totalBlocks) {
    try {
      if (await core.has(startBlock, endBlock)) return totalBlocks
    } catch { /* best effort */ }

    if (totalBlocks <= 512) {
      let available = 0
      for (let index = startBlock; index < endBlock; index++) {
        try {
          if (await core.has(index)) available++
        } catch { /* best effort */ }
      }
      return available
    }

    const sampleSize = Math.min(totalBlocks, 20)
    const step = Math.max(1, Math.floor(totalBlocks / sampleSize))
    let sampledHits = 0
    let sampledTotal = 0
    for (let index = startBlock; index < endBlock; index += step) {
      try {
        if (await core.has(index)) sampledHits++
      } catch { /* best effort */ }
      sampledTotal++
    }
    return sampledTotal > 0 ? Math.round((sampledHits / sampledTotal) * totalBlocks) : 0
  }

  async function startOnDemandPlaybackStats(driveKey, videoPath, playbackBlobRef) {
    if (!videoStats || !ctx?.store || !playbackBlobRef?.blobsCoreKey || !playbackBlobRef?.blobId) return null

    const blobsCoreKey = normalizeBlobsCoreKey(playbackBlobRef.blobsCoreKey)
    const blob = normalizeBlobRefInput(playbackBlobRef.blobId) || parseBlobRef(playbackBlobRef)?.blob
    if (!blobsCoreKey || !blob) return null

    const statsKey = getStatsKey(driveKey, videoPath)
    if (activeRangeRequests.has(encodeIndexKey(driveKey || '', videoPath || ''))) {
      return typeof videoStats.getStats === 'function' ? videoStats.getStats(driveKey, videoPath) : null
    }

    try {
      cleanupOnDemandPlaybackStats(statsKey)
      try { videoStats.cleanupMonitor(driveKey, videoPath) } catch { /* best effort */ }

      const keyBuf = b4a.from(blobsCoreKey, 'hex')
      const core = ctx.store.get({ key: keyBuf })
      await core.ready()

      const startBlock = blob.blockOffset
      const totalBlocks = blob.blockLength
      const endBlock = startBlock + totalBlocks
      const totalBytes = blob.byteLength || playbackBlobRef.byteLength || 0
      const initialBlocks = await countInitialBlobBlocks(core, startBlock, endBlock, totalBlocks)
      const wasCached = totalBlocks > 0 && initialBlocks >= totalBlocks
      const bytesPerBlock = totalBlocks > 0 ? totalBytes / totalBlocks : 0
      const peerDetails = describeCorePeerDetails(core)

      let downloadedBlocks = 0
      let downloadedBytesTotal = 0
      let downloadSpeed = 0
      let lastSpeedTime = Date.now()
      let lastSpeedBytes = 0
      let uploadedBytesTotal = 0
      let uploadSpeed = 0
      let lastUploadTime = Date.now()
      let lastUploadBytes = 0
      const downloadedIndices = new Set()

      const onDownload = (index, byteLength) => {
        if (typeof index !== 'number') return
        if (index < startBlock || index >= endBlock) return
        if (!downloadedIndices.has(index)) {
          downloadedIndices.add(index)
          downloadedBlocks = downloadedIndices.size
        }

        const chunkBytes =
          typeof byteLength === 'number' && Number.isFinite(byteLength) && byteLength > 0
            ? byteLength
            : bytesPerBlock
        downloadedBytesTotal += chunkBytes
        const now = Date.now()
        const elapsed = (now - lastSpeedTime) / 1000
        if (elapsed >= 0.5) {
          const deltaBytes = downloadedBytesTotal - lastSpeedBytes
          downloadSpeed = elapsed > 0 ? deltaBytes / elapsed : 0
          lastSpeedBytes = downloadedBytesTotal
          lastSpeedTime = now
        }

        const totalDownloaded = initialBlocks + downloadedBlocks
        const isComplete = totalBlocks > 0 && totalDownloaded >= totalBlocks
        videoStats.updateStats(driveKey, videoPath, {
          status: isComplete ? 'complete' : 'downloading',
          downloadedBlocks,
          initialBlocks,
          peerCount: describeCorePeerDetails(core).peerCount,
        })
        videoStats.emitStats(driveKey, videoPath, isComplete)
      }

      const onUpload = (index, byteLength) => {
        if (typeof index !== 'number') return
        if (index < startBlock || index >= endBlock) return
        const chunkBytes =
          typeof byteLength === 'number' && Number.isFinite(byteLength) && byteLength > 0
            ? byteLength
            : bytesPerBlock
        uploadedBytesTotal += chunkBytes
        const now = Date.now()
        const elapsed = (now - lastUploadTime) / 1000
        if (elapsed >= 0.5) {
          const deltaBytes = uploadedBytesTotal - lastUploadBytes
          uploadSpeed = elapsed > 0 ? deltaBytes / elapsed : 0
          lastUploadBytes = uploadedBytesTotal
          lastUploadTime = now
        }

        videoStats.updateStats(driveKey, videoPath, {
          peerCount: describeCorePeerDetails(core).peerCount,
        })
        videoStats.emitStats(driveKey, videoPath)
      }

      videoStats.updateStats(driveKey, videoPath, {
        status: wasCached ? 'complete' : 'downloading',
        startTime: Date.now(),
        totalBlocks,
        totalBytes,
        initialBlocks,
        downloadedBlocks: 0,
        peerCount: peerDetails.peerCount,
      })

      const monitor = {
        downloadSpeed: () => (Date.now() - lastSpeedTime > 2000 ? 0 : downloadSpeed),
        uploadSpeed: () => (Date.now() - lastUploadTime > 2000 ? 0 : uploadSpeed),
      }
      core.on('download', onDownload)
      core.on('upload', onUpload)
      videoStats.registerMonitor(driveKey, videoPath, monitor, () => {
        try { core.off('download', onDownload) } catch { /* best effort */ }
        try { core.off('upload', onUpload) } catch { /* best effort */ }
        activeOnDemandPlaybackStats.delete(statsKey)
      })
      activeOnDemandPlaybackStats.set(statsKey, {
        core,
        cleanup: () => videoStats.cleanupMonitor(driveKey, videoPath),
      })
      videoStats.emitStats(driveKey, videoPath, true)

      return videoStats.getStats(driveKey, videoPath)
    } catch (err) {
      console.log('[API] on-demand playback stats unavailable:', err?.message || err)
      cleanupOnDemandPlaybackStats(statsKey)
      return null
    }
  }

  function getActiveRangeSeedKeys() {
    const keys = new Set()
    for (const request of activeRangeRequests.values()) {
      if (request?.seedKey) keys.add(request.seedKey)
    }
    return keys
  }

  // Storage-quota eviction is deferred while playback is active, then flushed
  // once playback stops. To keep that flush from ever disrupting playback we (a)
  // debounce it so rapid open/close and pause/resume cancel it before it runs,
  // and (b) protect the most-recently-played video so seeking/replaying it never
  // hits an evicted range.
  const QUOTA_SWEEP_AFTER_PLAYBACK_MS =
    Number(globalThis?.process?.env?.PEARTUBE_QUOTA_SWEEP_DELAY_MS) || 1500
  let quotaSweepTimer = null
  let lastPlayedSeedKey = null

  function markVideoPlayed(driveKey, videoPath) {
    if (!driveKey || !videoPath) return
    lastPlayedSeedKey = `${driveKey}:${videoPath}`
  }

  function cancelScheduledQuotaSweep() {
    if (!quotaSweepTimer) return
    clearTimeout(quotaSweepTimer)
    quotaSweepTimer = null
  }

  function runQuotaSweep() {
    quotaSweepTimer = null
    if (!seedingManager?.enforceQuota) return
    // A new playback may have started during the debounce window — never evict
    // while a player or blob-server reader is active.
    if (storageIsPlaybackActive()) return
    const protectedKeys = getActiveRangeSeedKeys()
    if (lastPlayedSeedKey) protectedKeys.add(lastPlayedSeedKey)
    Promise.resolve()
      .then(() => seedingManager.enforceQuota({ protectedKeys }))
      .catch(err => console.log('[API] Deferred quota enforcement failed:', err?.message))
  }

  function scheduleQuotaSweepAfterPlayback() {
    if (!seedingManager?.enforceQuota) return
    cancelScheduledQuotaSweep()
    quotaSweepTimer = setTimeout(runQuotaSweep, QUOTA_SWEEP_AFTER_PLAYBACK_MS)
  }

  /** @type {Map<string, { ts: number, value: any[] }>} */
  const listVideosCache = new Map()
  /** @type {Map<string, { ts: number, value: any }>} */
  const channelMetaCache = new Map()
  /** @type {Map<string, { ts: number, value: any }>} */
  const videoAvailabilityCache = new Map()

  function cloneArrayOfObjects(arr) {
    if (!Array.isArray(arr)) return []
    return arr.map((v) => (v && typeof v === 'object') ? { ...v } : v)
  }

  function cloneObject(obj) {
    if (!obj || typeof obj !== 'object') return obj
    return { ...obj }
  }

  function getVideoAvailabilityCacheTtl(value) {
    return value === 'playable'
      ? VIDEO_AVAILABILITY_CACHE_TTL_MS
      : VIDEO_AVAILABILITY_NEGATIVE_CACHE_TTL_MS
  }

  function isValidHypercoreHex(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
  }

  function invalidateChannelCaches(driveKey) {
    try { listVideosCache.delete(driveKey) } catch { /* best effort */ }
    try { channelMetaCache.delete(driveKey) } catch { /* best effort */ }
    try {
      for (const key of videoAvailabilityCache.keys()) {
        if (key.startsWith(`${driveKey}:`)) videoAvailabilityCache.delete(key)
      }
    } catch { /* best effort */ }
  }


  function normalizeVideoId(value) {
    if (!value || typeof value !== 'string') return value
    if (value.startsWith('/videos/')) {
      const match = value.match(/\/videos\/([^./]+)/)
      if (match?.[1]) return match[1]
    }
    const base = value.split('/').pop() || value
    return base.replace(/\.[^./]+$/, '') || value
  }

  function getPublicFeedEntry(driveKey) {
    try {
      const feed = typeof publicFeed?.getFeed === 'function' ? publicFeed.getFeed() : []
      if (!Array.isArray(feed)) return null
      return feed.find((entry) => (entry?.driveKey || entry?.channelKey) === driveKey) || null
    } catch {
      return null
    }
  }

  function getStatsKey(driveKey, videoPath) {
    return typeof videoStats?.getKey === 'function'
      ? videoStats.getKey(driveKey, videoPath)
      : encodeIndexKey(driveKey || '', normalizeVideoId(videoPath) || videoPath || '')
  }

  function describeCorePeerDetails(core) {
    const peers = core?.peers
    const peerList = Array.isArray(peers)
      ? peers
      : peers && typeof peers.values === 'function'
        ? Array.from(peers.values())
        : []
    const peerCount = Array.isArray(peers)
      ? peers.length
      : typeof peers?.length === 'number'
        ? peers.length
        : typeof peers?.size === 'number'
          ? peers.size
          : peerList.length
    const blobPeerIds = peerList.map((peer) => {
      try {
        const key = peer?.remotePublicKey || peer?.publicKey || peer?.key || peer?.id || peer?.stream?.remotePublicKey
        if (!key) return null
        const hex = typeof key === 'string' ? key : b4a.toString(key, 'hex')
        return /^[a-f0-9]{64}$/i.test(hex) ? hex : null
      } catch {
        return null
      }
    }).filter(Boolean)
    const blobCoreKey = core?.key ? b4a.toString(core.key, 'hex') : null
    return { peerCount, blobPeerIds, blobCoreKey }
  }

  // The raw replicator peer objects for a core (each exposes remoteBitfield /
  // remoteContiguousLength), used to verify who holds a full copy of a blob.
  function getCorePeerObjects(core) {
    const peers = core?.peers
    if (Array.isArray(peers)) return peers
    if (peers && typeof peers.values === 'function') return Array.from(peers.values())
    return []
  }

  function getPeerShortKey(peer) {
    try {
      const key = peer?.remotePublicKey || peer?.publicKey || peer?.key || peer?.id || peer?.stream?.remotePublicKey
      if (!key) return null
      const hex = typeof key === 'string' ? key : b4a.toString(key, 'hex')
      return /^[a-f0-9]{64}$/i.test(hex) ? hex.slice(0, 12) : null
    } catch {
      return null
    }
  }

  function getWireStats(stats) {
    if (!stats || typeof stats !== 'object') return null
    const pick = (name) => ({
      tx: Number(stats?.[name]?.tx || 0),
      rx: Number(stats?.[name]?.rx || 0)
    })
    return {
      sync: pick('wireSync'),
      request: pick('wireRequest'),
      data: pick('wireData'),
      want: pick('wireWant'),
      bitfield: pick('wireBitfield'),
      range: pick('wireRange')
    }
  }

  function getReplicatorDiagnostics(core) {
    const replicator = core?.core?.replicator
    if (!replicator || typeof replicator !== 'object') return null
    return {
      findingPeers: Number(replicator.findingPeers || 0),
      hadPeers: replicator._hadPeers,
      activePeers: Number(replicator._active || 0),
      ifAvailable: Number(replicator._ifAvailable || 0),
      ranges: Number(replicator._ranges?.length || 0),
      blocks: Number(replicator._blocks?.size || 0),
      inflight: Number(replicator._inflight?.length || 0),
      stats: getWireStats(replicator.stats)
    }
  }

  function describeBlobPeerAvailability(core, start, end) {
    const peerList = getCorePeerObjects(core)
    return peerList.slice(0, 4).map((peer) => {
      let remoteContiguousLength = null
      let firstUnset = null
      let hasStart = null
      let hasStartupRange = false
      try {
        remoteContiguousLength = Number(peer?.remoteContiguousLength)
        if (!Number.isFinite(remoteContiguousLength)) remoteContiguousLength = null
      } catch { /* best effort */ }
      try {
        if (typeof peer?.remoteBitfield?.firstUnset === 'function') {
          firstUnset = peer.remoteBitfield.firstUnset(start)
        }
      } catch { /* best effort */ }
      try {
        if (typeof peer?.remoteBitfield?.get === 'function') {
          hasStart = peer.remoteBitfield.get(start) === true
        }
      } catch { /* best effort */ }
      try {
        hasStartupRange = peerHasFullRange(peer, start, end)
      } catch { /* best effort */ }
      return {
        key: getPeerShortKey(peer),
        remoteOpened: peer?.remoteOpened === true,
        remoteSynced: peer?.remoteSynced === true,
        remoteLength: Number(peer?.remoteLength || 0),
        remoteContiguousLength,
        firstUnset,
        hasStart,
        hasStartupRange,
        remoteUploading: peer?.remoteUploading === true,
        remoteDownloading: peer?.remoteDownloading === true,
        remoteCanUpgrade: peer?.remoteCanUpgrade === true,
        canUpgrade: peer?.canUpgrade === true,
        inflight: Number(peer?.inflight || 0),
        syncsProcessing: Number(peer?.syncsProcessing || 0),
        lengthAcked: Number(peer?.lengthAcked || 0),
        stats: getWireStats(peer?.stats)
      }
    })
  }

  function logBlobDownloadDiagnostics(label, core, start, end) {
    try {
      const peers = getCorePeerObjects(core)
      const localHasStart = typeof core?.has === 'function' ? undefined : null
      const summary = {
        label,
        range: `${start}-${end}`,
        peerCount: peers.length,
        localHasStart,
        replicator: getReplicatorDiagnostics(core),
        peers: describeBlobPeerAvailability(core, start, end)
      }
      console.log('[API] Blob download diagnostics:', JSON.stringify(summary))
    } catch (err) {
      console.log('[API] Blob download diagnostics failed:', label, err?.message || err)
    }
  }

  // Swarm public keys of durable full-copy anchors, used to upgrade a generic
  // "live peer has it" into a trusted "the relay / one of your own devices has
  // it".
  //
  // Relay anchor: swarm/Noise keys of always-on relay/blind peers a deployment
  // trusts as a durable full-copy holder. A host can populate ctx.trustedRelayKeys
  // (e.g. from its own config) to enable single-relay offload. Left empty by
  // default — there's no automatic client-side relay-key discovery yet (that
  // needs a feed announcement), so default deployments lean on the
  // independent-live-peers redundancy threshold.
  function getKnownDurableRelayKeys() {
    // Durable relay anchors come from two sources: host-provided config
    // (ctx.trustedRelayKeys) and the live blind-peering mirror set (config +
    // feed-discovered relays). A core mirrored to one of these blind peers is a
    // durable full copy, so it satisfies offload eligibility on its own.
    const sources = [
      ctx?.trustedRelayKeys,
      ctx?.blindPeering?.getActiveMirrorKeys?.(),
    ]
    const keys = new Set()
    for (const raw of sources) {
      if (!Array.isArray(raw)) continue
      for (const k of raw) {
        const hex = typeof k === 'string' ? k.toLowerCase() : null
        if (hex && /^[a-f0-9]{64}$/.test(hex)) keys.add(hex)
      }
    }
    return Array.from(keys)
  }

  // Own-device anchor: each device records the swarm key it replicates under in
  // its channel writer record (ensureLocalBlobDrive). Reading them back lets the
  // offload check recognise when a connected blob peer is one of the user's own
  // devices holding a full copy — the strongest durable anchor.
  async function getOwnDeviceSwarmKeys(driveKey) {
    try {
      const channel = ctx.channels?.get?.(driveKey)
      if (typeof channel?.listWriters !== 'function') return []
      const writers = await channel.listWriters()
      const keys = []
      for (const w of writers || []) {
        if (w?.banned || w?.removedAt) continue
        const k = typeof w?.swarmKeyHex === 'string' ? w.swarmKeyHex.toLowerCase() : null
        if (k && /^[a-f0-9]{64}$/.test(k)) keys.push(k)
      }
      return keys
    } catch {
      return []
    }
  }

  function getVideoCorePeerDetails(driveKey, videoPath) {
    try {
      const channel = ctx.channels?.get?.(driveKey)
      const normalizedId = normalizeVideoId(videoPath)
      const candidates = [
        videoPath,
        normalizedId,
        normalizedId ? `/videos/${normalizedId}.mp4` : null,
        normalizedId ? `videos/${normalizedId}.mp4` : null,
      ].filter(Boolean)

      for (const candidate of candidates) {
        const core = channel?.videoCores?.get?.(candidate) || channel?.cores?.get?.(candidate)
        if (!core) continue
        return describeCorePeerDetails(core)
      }

      const directPlayback = activeOnDemandPlaybackStats.get(getStatsKey(driveKey, videoPath))
      if (directPlayback?.core) return describeCorePeerDetails(directPlayback.core)
    } catch { /* best effort */ }

    return { peerCount: 0, blobPeerIds: [], blobCoreKey: null }
  }

  function getVideoCorePeerCount(driveKey, videoPath) {
    return getVideoCorePeerDetails(driveKey, videoPath).peerCount
  }

  function getFeedEntryVideoCount(driveKey, publicBeeKey = null) {
    const entry = getPublicFeedEntry(driveKey)
    if (!entry) return 0
    const videos = Array.isArray(entry?.videos)
      ? entry.videos
      : Array.isArray(entry?.previewVideos)
        ? entry.previewVideos
        : []
    if (videos.length > 0) return videos.length
    if (
      publicBeeKey &&
      entry.publicBeeKey &&
      entry.publicBeeKey !== publicBeeKey
    ) {
      return 0
    }
    return Number.isFinite(entry.videoCount) ? entry.videoCount : 0
  }

  function previewVideosFromFeedEntry(driveKey, publicBeeKey = null) {
    const entry = getPublicFeedEntry(driveKey)
    const videos = Array.isArray(entry?.videos)
      ? entry.videos
      : Array.isArray(entry?.previewVideos)
        ? entry.previewVideos
        : []
    if (videos.length === 0) return []
    const resolvedPublicBeeKey = publicBeeKey || entry?.publicBeeKey || null
    return videos
      .filter((video) => video?.id || video?.path)
      .map((video) => {
        const id = normalizeVideoId(video.id || video.path)
        const hasByteProof = video?.readyForPlayback === true ||
          (video?.hasHeadBlock === true && (Number(video?.contiguousBlocks || 0) || 0) > 0)
        const videoAvailability = hasByteProof
          ? (video.byteAvailability || video.availability || 'playable')
          : (video.byteAvailability === 'playable' || video.availability === 'playable' ? 'unknown' : (video.byteAvailability || video.availability || null))
        return {
          ...video,
          id,
          path: video.path || `/videos/${id}.mp4`,
          channelKey: driveKey,
          publicBeeKey: resolvedPublicBeeKey,
          relayBacked: Boolean(entry?.relayServing || entry?.relayRole === 'cache' || entry?.source === 'relay-cache'),
          mimeType: video.mimeType || 'video/mp4',
          availability: videoAvailability || video.availability,
          byteAvailability: videoAvailability || video.byteAvailability || video.availability,
          hasHeadBlock: Boolean(video?.hasHeadBlock),
          contiguousBlocks: Number(video?.contiguousBlocks || 0) || 0,
          readyForPlayback: Boolean(video?.readyForPlayback || hasByteProof),
        }
      })
  }

  function getPreviewVideoFromFeed(driveKey, videoId, publicBeeKey = null) {
    const targetId = normalizeVideoId(videoId)
    const previews = previewVideosFromFeedEntry(driveKey, publicBeeKey)
    return previews.find((video) => normalizeVideoId(video?.id || video?.path) === targetId) || null
  }

  function resolvePlaybackBlobRef(driveKey, videoId, publicBeeKey, blobId, blobsCoreKey, mimeType) {
    if (blobId && blobsCoreKey) {
      return { blobId, blobsCoreKey, mimeType: mimeType || 'video/mp4' }
    }

    const previewVideo = getPreviewVideoFromFeed(driveKey, videoId, publicBeeKey)
    if (!previewVideo?.blobId || !previewVideo?.blobsCoreKey) {
      return { blobId, blobsCoreKey, mimeType }
    }

    return {
      blobId: previewVideo.blobId,
      blobsCoreKey: previewVideo.blobsCoreKey,
      mimeType: mimeType || previewVideo.mimeType || 'video/mp4',
    }
  }

  function localSwarmPeerId() {
    try {
      const key = ctx?.swarm?.keyPair?.publicKey
      if (!key) return null
      const hex = typeof key === 'string' ? key : b4a.toString(key, 'hex')
      return /^[a-f0-9]{64}$/i.test(hex) ? hex.toLowerCase() : null
    } catch {
      return null
    }
  }

  function hintMatchesBlobRef(hint, video) {
    if (!hint || !video) return false
    if (hint.id && video.id && normalizeVideoId(hint.id) !== normalizeVideoId(video.id)) return false
    const videoCore = normalizeBlobsCoreKey(video.blobsCoreKey)
    const hintCore = normalizeBlobsCoreKey(hint.blobsCoreKey)
    const videoBlob = normalizeBlobRefInput(video.blobId)
    const hintBlob = normalizeBlobRefInput(hint.blobId)
    if (videoCore && hintCore && videoCore !== hintCore) return false
    if (videoBlob && hintBlob && stringifyBlobId(videoBlob) !== stringifyBlobId(hintBlob)) return false
    return Boolean(videoCore && hintCore && videoBlob && hintBlob)
  }

  function collectAvailabilityHintPeerIds(hints) {
    const ids = new Set()
    const add = (value) => {
      if (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) ids.add(value.toLowerCase())
    }
    for (const hint of hints || []) {
      add(hint?.sourcePeerId)
      add(hint?.sourceFeedPeerId)
      add(hint?.relayPeerId)
      if (Array.isArray(hint?.sourceFeedPeerIds)) for (const id of hint.sourceFeedPeerIds) add(id)
      if (Array.isArray(hint?.sourceRelayPeerIds)) for (const id of hint.sourceRelayPeerIds) add(id)
      if (Array.isArray(hint?.relayHintIds)) for (const id of hint.relayHintIds) add(id)
    }
    return Array.from(ids)
  }

  function hintHasPlaybackBytes(hint) {
    return hint?.availability === 'playable' && (
      hint?.readyForPlayback === true ||
      hint?.hasHeadBlock === true ||
      (Number(hint?.contiguousBlocks || 0) || 0) > 0 ||
      hint?.activelyServing === true
    )
  }

  async function promotePlaybackAvailabilityPeers({ driveKey, videoPath, publicBeeKey, blobsCoreKey, blobId, core }) {
    if (!publicFeed || (!driveKey && !videoPath)) return []
    const id = normalizeVideoId(videoPath)
    const video = { id, blobsCoreKey, blobId }
    const peerIds = new Set()
    const addPeerIds = (ids) => {
      for (const id of ids || []) {
        if (typeof id === 'string' && /^[a-f0-9]{64}$/i.test(id)) peerIds.add(id.toLowerCase())
      }
    }

    try {
      if (driveKey && typeof publicFeed.getEntryFeedPeerIds === 'function') {
        addPeerIds(publicFeed.getEntryFeedPeerIds(driveKey))
      }
    } catch { /* best effort */ }

    let hints = []
    if (
      driveKey &&
      id &&
      blobsCoreKey &&
      blobId &&
      typeof publicFeed.requestAvailabilityHints === 'function'
    ) {
      try {
        const result = await publicFeed.requestAvailabilityHints([{
          driveKey,
          publicBeeKey,
          id,
          blobsCoreKey,
          blobId,
        }], { timeoutMs: 1000, maxPeers: 6 })
        hints = Array.isArray(result) ? result : []
        addPeerIds(collectAvailabilityHintPeerIds(
          hints.filter((hint) => hintMatchesBlobRef(hint, video) && hintHasPlaybackBytes(hint))
        ))
      } catch (err) {
        console.log('[API] Playback availability hint request failed:', err?.message || err)
      }
    }

    const ids = Array.from(peerIds)
    if (ids.length === 0 || typeof publicFeed.promoteAvailabilityHintPeers !== 'function') {
      if (hints.length > 0) {
        console.log('[API] Playback availability peer promotion: no peers', JSON.stringify({
          hints: hints.length,
          playableHints: hints.filter((hint) => hintMatchesBlobRef(hint, video) && hintHasPlaybackBytes(hint)).length,
        }))
      }
      return []
    }

    try {
      const promoted = publicFeed.promoteAvailabilityHintPeers(ids, core?.discoveryKey || null, {
        direct: true,
        reason: 'playback-availability-hint-peer',
      })
      console.log('[API] Playback availability peer promotion:', JSON.stringify({
        feedPeers: ids.length,
        hints: hints.length,
        playableHints: hints.filter((hint) => hintMatchesBlobRef(hint, video) && hintHasPlaybackBytes(hint)).length,
        promoted: Array.isArray(promoted) ? promoted.length : 0,
      }))
      try { core?.core?.replicator?.updateAll?.() } catch { /* best effort */ }
      return promoted || []
    } catch (err) {
      console.log('[API] Playback availability peer promotion failed:', err?.message || err)
      return []
    }
  }

  // ============================================
  // Download Intent Persistence Helpers
  // ============================================

  /**
   * Save a download intent to metaDb
   * @param {StorageContext} ctx
   * @param {Object} intent - Download intent object
   * @param {string} intent.driveKey
   * @param {string} intent.videoPath
   * @param {string} intent.blobsCoreKey
   * @param {string} intent.blobId
   * @param {number} intent.startBlock
   * @param {number} intent.endBlock
   * @param {number} intent.totalBlocks
   * @param {number} intent.totalBytes
   * @param {string} intent.mimeType
   * @param {number} intent.startedAt
   * @returns {Promise<void>}
   */
  async function saveDownloadIntent(ctx, intent) {
    await ctx.metaSubspaces.downloadIntents.put(`${intent.driveKey}:${intent.videoPath}`, intent)
  }

  /**
   * Load a download intent from metaDb
   * @param {StorageContext} ctx
   * @param {string} driveKey
   * @param {string} videoPath
   * @returns {Promise<Object|null>}
   */
  async function loadDownloadIntent(ctx, driveKey, videoPath) {
    const entry = await ctx.metaSubspaces.downloadIntents.get(`${driveKey}:${videoPath}`)
    return entry?.value || null
  }

  /**
   * Delete a download intent from metaDb
   * @param {StorageContext} ctx
   * @param {string} driveKey
   * @param {string} videoPath
   * @returns {Promise<void>}
   */
  async function deleteDownloadIntent(ctx, driveKey, videoPath) {
    await ctx.metaSubspaces.downloadIntents.del(`${driveKey}:${videoPath}`)
  }

  /**
   * Load all download intents from metaDb
   * @param {StorageContext} ctx
   * @returns {Promise<Array<Object>>}
   */
  async function loadAllDownloadIntents(ctx) {
    const intents = []
    for await (const entry of ctx.metaSubspaces.downloadIntents.createReadStream()) {
      if (entry.value) {
        intents.push(entry.value)
      }
    }
    return intents
  }

  return {
    invalidateChannelCaches,
    async getAvailabilityHints(requests = []) {
      const hints = []
      for (const req of requests) {
        const id = req?.id
        if (!id) continue
        const local = await (async () => {
          try {
            const video = {
              id,
              blobsCoreKey: req?.blobsCoreKey,
              blobId: req?.blobId,
            }
            const key = req?.driveKey || 'unknown'
            // Reuse the cheap local-only availability path shape
            const cacheKey = buildBlobRefCacheKey({
              driveKey: key,
              id,
              blobsCoreKey: video.blobsCoreKey,
              blobId: video.blobId,
            })
            const cachedAvailability = videoAvailabilityCache.get(cacheKey)
            if (
              cachedAvailability &&
              cachedAvailability.value !== 'playable' &&
              (Date.now() - cachedAvailability.ts) < getVideoAvailabilityCacheTtl(cachedAvailability.value)
            ) {
              return { availability: cachedAvailability.value, contiguousBlocks: 0, hasHeadBlock: false }
            }
            const keyBuf = normalizeBlobsCoreKey(video?.blobsCoreKey) ? b4a.from(normalizeBlobsCoreKey(video.blobsCoreKey), 'hex') : null
            const blobId = normalizeBlobRefInput(video?.blobId) || parseBlobRef(video)?.blob
            if (!keyBuf || !blobId) return { availability: 'unknown', contiguousBlocks: 0, hasHeadBlock: false }
            const core = ctx.store.get({ key: keyBuf })
            await core.ready()
            const startBlock = blobId?.blockOffset
            const totalBlocks = blobId?.blockLength
            const endBlock = Number.isFinite(startBlock) && Number.isFinite(totalBlocks) ? startBlock + totalBlocks : null
            if (!Number.isFinite(startBlock) || !Number.isFinite(endBlock)) return { availability: 'unknown', contiguousBlocks: 0, hasHeadBlock: false }
            const fullyCached = await core.has(startBlock, endBlock)
            if (fullyCached) return { availability: 'playable', contiguousBlocks: totalBlocks || 0, hasHeadBlock: true }
            const headEnd = Math.min(endBlock, startBlock + Math.max(1, Math.min(32, totalBlocks || 32)))
            let initialAvailable = false
            try { initialAvailable = await core.has(startBlock, headEnd) } catch { /* best effort */ }
            return { availability: initialAvailable ? 'playable' : 'unknown', contiguousBlocks: initialAvailable ? Math.max(1, headEnd - startBlock) : 0, hasHeadBlock: initialAvailable }
          } catch {
            return { availability: 'unknown', contiguousBlocks: 0, hasHeadBlock: false }
          }
        })()
        const localPeerId = localSwarmPeerId()
        hints.push({
          driveKey: req?.driveKey,
          id,
          blobsCoreKey: req?.blobsCoreKey || null,
          blobId: req?.blobId || null,
          availability: local.availability,
          contiguousBlocks: local.contiguousBlocks,
          hasHeadBlock: local.hasHeadBlock,
          lastSeenAt: Date.now(),
          activelyServing: local.availability === 'playable',
          sourcePeerId: localPeerId,
          sourceRelayPeerIds: localPeerId && local.availability === 'playable' ? [localPeerId] : [],
        })
      }
      return hints
    },
    // ============================================
    // Channel Operations
    // ============================================

    /**
     * Get channel metadata
     * @param {string} driveKey
     * @returns {Promise<ChannelMetadata>}
     */
    async getChannel(driveKey) {
      console.log('[API] GET_CHANNEL:', driveKey?.slice(0, 16));
      try {
        const channel = await loadChannel(ctx, driveKey)
        await markAsMultiWriterChannel(driveKey)
        const meta = await channel.getMetadata().catch(() => null)
        return {
          name: meta?.name || 'Channel',
          description: meta?.description || '',
          avatar: meta?.avatar || null,
          createdAt: meta?.createdAt || Date.now(),
          publicKey: meta?.createdBy || null
        }
      } catch (err) {
        console.error('[API] GET_CHANNEL error:', err.message);
        return { name: 'Unknown Channel', error: err.message };
      }
    },

    async updateChannel(driveKey, { name, description, avatar } = {}) {
      console.log('[API] UPDATE_CHANNEL:', driveKey?.slice(0, 16));
      try {
        const channel = await loadChannel(ctx, driveKey)
        const updates = {}
        if (name !== undefined) updates.name = name
        if (description !== undefined) updates.description = description
        if (avatar !== undefined) updates.avatar = avatar
        await channel.updateMetadata(updates)
        invalidateChannelCaches(driveKey)
        const meta = await channel.getMetadata?.() || {}
        return {
          success: true,
          channel: {
            name: meta.name || name,
            description: meta.description || description,
            avatar: meta.avatar || avatar
          }
        }
      } catch (err) {
        console.error('[API] updateChannel error:', err?.message)
        return { success: false, error: err?.message }
      }
    },

    async updateVideoMetadata(channelKey, videoId, { title, description, category } = {}) {
      console.log('[API] UPDATE_VIDEO_METADATA:', channelKey?.slice(0, 16), videoId)
      try {
        const channel = await loadChannel(ctx, channelKey)
        const updates = {}
        if (title !== undefined) updates.title = title
        if (description !== undefined) updates.description = description
        if (category !== undefined) updates.category = category
        await channel.updateVideo(videoId, updates)
        invalidateChannelCaches(channelKey)
        await refreshSearchIndex(channelKey, videoId)
        return { success: true }
      } catch (err) {
        console.error('[API] updateVideoMetadata error:', err?.message)
        return { success: false, error: err?.message }
      }
    },

    async updateChannelAvatar(driveKey, imageBuffer, mimeType) {
      console.log('[API] UPDATE_CHANNEL_AVATAR:', driveKey?.slice(0, 16))
      try {
        const channel = await loadChannel(ctx, driveKey)

        const extensionByMime = {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp'
        }
        const ext = extensionByMime[mimeType] || 'png'
        const avatarPath = `/avatars/channel.${ext}`

        const imageData = b4a.isBuffer(imageBuffer) ? imageBuffer : b4a.from(imageBuffer || [])

        let avatarUrl = null

        if (channel?.drive && typeof channel.drive.put === 'function') {
          await channel.drive.put(avatarPath, imageData)
          if (ctx.blobServer && channel.drive.core?.key) {
            const byteLength = imageData.byteLength || imageData.length || 0
            avatarUrl = ctx.blobServer.getLink(channel.drive.core.key, {
              blob: {
                blockOffset: 0,
                blockLength: channel.drive.core.length || 1,
                byteOffset: 0,
                byteLength
              },
              type: mimeType || 'image/png',
              host: ctx.blobServerHost || '127.0.0.1',
              port: ctx.blobServer?.port || ctx.blobServerPort
            })
          }
        }

        if (!avatarUrl) {
          const blob = await channel.putBlob(imageData)
          avatarUrl = ctx.blobServer.getLink(channel.blobsKey, {
            blob: {
              blockOffset: blob.blockOffset,
              blockLength: blob.blockLength,
              byteOffset: blob.byteOffset,
              byteLength: blob.byteLength
            },
            type: mimeType || 'image/png',
            host: ctx.blobServerHost || '127.0.0.1',
            port: ctx.blobServer?.port || ctx.blobServerPort
          })
        }

        await channel.updateMetadata({ avatar: avatarUrl })
        invalidateChannelCaches(driveKey)
        return { success: true, avatarUrl }
      } catch (err) {
        console.error('[API] updateChannelAvatar error:', err?.message)
        return { success: false, error: err?.message }
      }
    },

    /**
     * Get channel metadata. Keep the default path metadata-only: videoCount is
     * derived from public-feed snapshots/previews when available instead of
     * calling listVideos(), which duplicates expensive PublicBee/channel reads.
     * @param {string} driveKey
     * @returns {Promise<ChannelMetadata>}
     */
    async getChannelMeta(driveKey, publicBeeKey = null) {
      console.log('[API] GET_CHANNEL_META:', driveKey?.slice(0, 16));
      try {
        const cached = channelMetaCache.get(driveKey)
        if (cached && (Date.now() - cached.ts) < CHANNEL_META_CACHE_TTL_MS) {
          return cloneObject(cached.value)
        }
        // Fast/public-feed path: if publicBeeKey is provided, don't load Autobase.
        // Viewers should be able to read metadata via the auto-replicating PublicBee.
        if (publicBeeKey) {
          const publicBee = await loadPublicBee(ctx, publicBeeKey)
          const meta = await withTimeout(publicBee.getMetadata().catch(() => null), 1000, `PublicBee getMetadata ${driveKey?.slice?.(0, 16) || ''}`).catch(() => null)
          const result = {
            driveKey,
            name: meta?.name || 'Channel',
            description: meta?.description || '',
            avatar: meta?.avatar || null,
            createdAt: meta?.createdAt || Date.now(),
            publicKey: meta?.createdBy || null,
            videoCount: getFeedEntryVideoCount(driveKey, publicBeeKey)
          }
          channelMetaCache.set(driveKey, { ts: Date.now(), value: result })
          return cloneObject(result)
        }

        const channel = await loadChannelBounded(driveKey)
        await markAsMultiWriterChannel(driveKey)
        const meta = await channel.getMetadata().catch(() => null)
        const result = {
          driveKey,
          name: meta?.name || 'Channel',
          description: meta?.description || '',
          avatar: meta?.avatar || null,
          createdAt: meta?.createdAt || Date.now(),
          publicKey: meta?.createdBy || null,
          videoCount: getFeedEntryVideoCount(driveKey)
        }
        channelMetaCache.set(driveKey, { ts: Date.now(), value: result })
        return cloneObject(result)
      } catch (err) {
        console.error('[API] GET_CHANNEL_META error:', err.message);
        return {
          driveKey,
          name: 'Unknown Channel',
          description: '',
          videoCount: 0,
          error: err.message
        };
      }
    },

    // ============================================
    // Video Operations
    // ============================================

    /**
     * List videos in a channel
     * @param {string} driveKey
     * @param {string} [publicBeeKey] - Optional PublicBee key for fast viewer access
     * @returns {Promise<VideoMetadata[]>}
     */
    async listVideos(driveKey, publicBeeKey) {
      console.log('[API] LIST_VIDEOS for:', driveKey?.slice(0, 16), 'publicBeeKey:', publicBeeKey?.slice(0, 16));
      try {
        const extractVideoId = (video) => {
          if (!video) return null
          if (video.id) return video.id
          if (video.path && typeof video.path === 'string') {
            const match = video.path.match(/\/videos\/([^./]+)/)
            if (match?.[1]) return match[1]
            const base = video.path.split('/').pop() || ''
            return base.replace(/\.[^./]+$/, '') || null
          }
          return null
        }

        const enrichMissingBlobMeta = async (videos, fetcher) => {
          const missing = (videos || []).filter(v => !v?.blobId || !v?.blobsCoreKey)
          if (missing.length === 0) return videos

          const MAX_ENRICH = 10
          const ids = Array.from(new Set(
            missing
              .slice(0, MAX_ENRICH)
              .map(v => extractVideoId(v))
              .filter(Boolean)
          ))
          if (ids.length === 0) return videos

          const metaById = new Map()
          await Promise.all(ids.map(async (id) => {
            try {
              const meta = await fetcher(id)
              if (meta) metaById.set(id, meta)
            } catch { /* best effort */ }
          }))

          if (metaById.size === 0) return videos

          return (videos || []).map((v) => {
            if (!v || (v.blobId && v.blobsCoreKey)) return v
            const id = extractVideoId(v)
            const meta = id ? metaById.get(id) : null
            if (!meta) return v
            return {
              ...v,
              blobId: v.blobId || meta.blobId,
              blobsCoreKey: v.blobsCoreKey || meta.blobsCoreKey,
              mimeType: v.mimeType || meta.mimeType,
              size: v.size || meta.size,
              byteLength: v.byteLength || meta.byteLength,
            }
          })
        }

        const getLocalVideoAvailabilityHint = async (video) => {
          const id = extractVideoId(video)
          const blobsCoreKey = video?.blobsCoreKey
          const blobIdRaw = video?.blobId
          if (!id || !blobsCoreKey || !blobIdRaw) {
            return { availability: 'unknown', contiguousBlocks: 0, hasHeadBlock: false }
          }

          const cacheKey = buildBlobRefCacheKey({
            driveKey,
            id,
            blobsCoreKey,
            blobId: blobIdRaw,
          })
          const cachedAvailability = videoAvailabilityCache.get(cacheKey)
          if (
            cachedAvailability &&
            cachedAvailability.value !== 'playable' &&
            (Date.now() - cachedAvailability.ts) < getVideoAvailabilityCacheTtl(cachedAvailability.value)
          ) {
            return { availability: cachedAvailability.value, contiguousBlocks: 0, hasHeadBlock: false }
          }

          let availability = 'unknown'
          let contiguousBlocks = 0
          let hasHeadBlock = false
          try {
            const keyBuf = b4a.from(normalizeBlobsCoreKey(blobsCoreKey) || blobsCoreKey, 'hex')
            const core = ctx.store.get({ key: keyBuf })
            await core.ready()

            const blobId = normalizeBlobRefInput(blobIdRaw) || parseBlobRef({ blobsCoreKey, blobId: blobIdRaw })?.blob
            if (!blobId) {
              videoAvailabilityCache.set(cacheKey, { ts: Date.now(), value: availability })
              return { availability, contiguousBlocks, hasHeadBlock }
            }

            const startBlock = blobId?.blockOffset
            const totalBlocks = blobId?.blockLength
            const endBlock = Number.isFinite(startBlock) && Number.isFinite(totalBlocks)
              ? startBlock + totalBlocks
              : null

            if (Number.isFinite(startBlock) && Number.isFinite(endBlock)) {
              const fullyCached = await core.has(startBlock, endBlock)
              if (fullyCached) {
                availability = 'playable'
                contiguousBlocks = totalBlocks || 0
                hasHeadBlock = true
              } else {
                const headEnd = Math.min(endBlock, startBlock + Math.max(1, Math.min(32, totalBlocks || 32)))
                let initialAvailable = false
                try {
                  initialAvailable = await core.has(startBlock, headEnd)
                } catch { /* best effort */ }
                hasHeadBlock = initialAvailable
                contiguousBlocks = initialAvailable ? Math.max(1, headEnd - startBlock) : 0
                availability = initialAvailable ? 'playable' : 'unknown'
              }
            }
          } catch (err) {
            availability = 'unknown'
          }

          videoAvailabilityCache.set(cacheKey, { ts: Date.now(), value: availability })
          return { availability, contiguousBlocks, hasHeadBlock }
        }

        const hasPlayableByteProof = (hint) => hint?.availability === 'playable' &&
          (hint?.readyForPlayback === true ||
            (hint?.hasHeadBlock === true && (Number(hint?.contiguousBlocks || 0) || 0) > 0))

        const hasVideoByteProof = (video) => video?.readyForPlayback === true ||
          (video?.hasHeadBlock === true && (Number(video?.contiguousBlocks || 0) || 0) > 0)

        const resolveExplicitVideoAvailability = ({ localHint, peerHint, video }) => {
          const explicitAvailability = video?.byteAvailability || video?.availability || null
          // A direct blob is watchable only when the selected blob has current
          // byte proof. Feed peers, relay metadata, and stale playable labels are
          // discovery signals, not media readiness.
          if (hasPlayableByteProof(localHint)) return 'playable'
          if (hasPlayableByteProof(peerHint)) return 'playable'
          if (explicitAvailability === 'playable' && hasVideoByteProof(video)) return 'playable'
          if (peerHint?.availability && peerHint.availability !== 'playable' && peerHint.availability !== 'unknown') {
            return peerHint.availability
          }
          if (explicitAvailability && explicitAvailability !== 'playable' && explicitAvailability !== 'unknown') {
            return explicitAvailability
          }

          return explicitAvailability === 'unknown' ? 'unknown' : 'unavailable'
        }

        const attachVideoAvailability = async (videos) => {
          const cloned = cloneArrayOfObjects(videos)
          const localHints = await Promise.all(cloned.map((video) => getLocalVideoAvailabilityHint(video)))

          // One bounded, batched hint round trip for videos that still lack
          // local byte proof — instead of a per-video network RPC (each riding
          // the peer scorer's multi-second timeout) across the whole list.
          const MAX_NETWORK_HINTS = 12
          let peerHints = []
          const hintRequests = cloned
            .filter((video, index) => !hasPlayableByteProof(localHints[index]) &&
              extractVideoId(video) && video?.blobsCoreKey && video?.blobId)
            .slice(0, MAX_NETWORK_HINTS)
            .map((video) => ({
              driveKey,
              publicBeeKey,
              id: extractVideoId(video),
              blobsCoreKey: video.blobsCoreKey,
              blobId: video.blobId,
            }))
          if (hintRequests.length > 0 && publicFeed && typeof publicFeed.requestAvailabilityHints === 'function') {
            try {
              const hints = await publicFeed.requestAvailabilityHints(hintRequests, { timeoutMs: 600, maxPeers: 4 })
              peerHints = Array.isArray(hints) ? hints : []
            } catch { /* best effort */ }
          }

          return cloned.map((video, index) => {
            const localHint = localHints[index]
            const peerHint = peerHints.find((hint) => hintMatchesBlobRef(hint, video)) || null
            const availability = resolveExplicitVideoAvailability({ localHint, peerHint, video })
            const proofHint = hasPlayableByteProof(localHint)
              ? localHint
              : hasPlayableByteProof(peerHint)
                ? peerHint
                : hasVideoByteProof(video)
                  ? video
                  : null
            return {
              ...video,
              availability,
              byteAvailability: availability,
              contiguousBlocks: Number(proofHint?.contiguousBlocks || 0) || 0,
              hasHeadBlock: Boolean(proofHint?.hasHeadBlock),
              readyForPlayback: availability === 'playable' && Boolean(proofHint),
            }
          })
        }

        const cached = listVideosCache.get(driveKey)
        if (cached) {
          const ttl = Array.isArray(cached.value) && cached.value.length === 0
            ? LIST_VIDEOS_EMPTY_CACHE_TTL_MS
            : LIST_VIDEOS_CACHE_TTL_MS
          if ((Date.now() - cached.ts) < ttl) {
            const revalidated = await attachVideoAvailability(cloneArrayOfObjects(cached.value))
            return cloneArrayOfObjects(revalidated)
          }
        }

        // FAST PATH: If publicBeeKey is provided, read directly from PublicBee
        // This is the preferred path for public feed viewers - no Autobase sync needed
        // IMPORTANT: If publicBeeKey is provided, this is definitely a multi-writer channel,
        // so we should not fall back to legacy storage paths.
        if (publicBeeKey) {
          console.log('[API] LIST_VIDEOS: using PublicBee fast path')
          // Mark as multi-writer since PublicBee is only used with multi-writer channels
          await markAsMultiWriterChannel(driveKey)
          try {
            const publicBee = await loadPublicBee(ctx, publicBeeKey)
            const videos = await publicBee.listVideos()
            console.log('[API] LIST_VIDEOS: PublicBee returned', videos?.length, 'videos')
            if ((videos?.length || 0) === 0) {
              const previewVideos = previewVideosFromFeedEntry(driveKey, publicBeeKey)
              if (previewVideos.length > 0) {
                console.log('[API] LIST_VIDEOS: PublicBee empty, using relay/feed preview direct refs')
                const previewWithAvailability = await attachVideoAvailability(previewVideos)
                listVideosCache.set(driveKey, { ts: Date.now(), value: previewWithAvailability })
                backgroundIndexVideos(previewWithAvailability, driveKey)
                return cloneArrayOfObjects(previewWithAvailability)
              }
              console.log('[API] LIST_VIDEOS: PublicBee returned no videos, skipping slow channel fallback')
              return []
            }
            const result = (videos || []).map(v => ({ ...v, channelKey: driveKey, publicBeeKey }))
            const enriched = await enrichMissingBlobMeta(result, (id) => publicBee.getVideo(id))
            const withAvailability = await attachVideoAvailability(enriched)
            listVideosCache.set(driveKey, { ts: Date.now(), value: withAvailability })
            // YouTube-Fast: background index for search
            backgroundIndexVideos(withAvailability, driveKey)
            return cloneArrayOfObjects(withAvailability)
          } catch (err) {
            const previewVideos = previewVideosFromFeedEntry(driveKey, publicBeeKey)
            if (previewVideos.length > 0) {
              console.log('[API] LIST_VIDEOS: PublicBee failed, using relay/feed preview direct refs:', err.message)
              const previewWithAvailability = await attachVideoAvailability(previewVideos)
              listVideosCache.set(driveKey, { ts: Date.now(), value: previewWithAvailability })
              backgroundIndexVideos(previewWithAvailability, driveKey)
              return cloneArrayOfObjects(previewWithAvailability)
            }
            console.log('[API] LIST_VIDEOS: PublicBee fast path failed:', err.message, '- returning preview/cache only')
            return []
          }
        }

        const channel = await loadChannelBounded(driveKey)
        await markAsMultiWriterChannel(driveKey)
        console.log('[API] LIST_VIDEOS channel loaded, calling listVideos...')

        // IMPORTANT: Never block listVideos on network sync.
        // Mobile has a 30s init timeout, and pairing/DHT discovery can exceed that.
        // Return current materialized view immediately; the UI already retries.
        let videos = await channel.listVideos()
        let usedOwnerPublicBeeFallback = false
        let resolvedPublicBeeKey = null
        if ((videos?.length || 0) === 0 && channel?.publicBee && typeof channel.publicBee.listVideos === 'function') {
          try {
            const publicBeeVideos = await listPublicBeeVideosBounded({
              publicBee: channel.publicBee,
              driveKey,
              publicBeeKey: channel.publicBeeKey || null,
              timeoutMs: 1200,
            })
            if ((publicBeeVideos?.length || 0) > 0) {
              videos = publicBeeVideos
              usedOwnerPublicBeeFallback = true
              resolvedPublicBeeKey =
                channel.publicBeeKey ||
                (typeof channel.getPublicBeeKey === 'function'
                  ? await channel.getPublicBeeKey().catch(() => null)
                  : null)
              console.log('[API] LIST_VIDEOS: owner publicBee fallback returned', publicBeeVideos.length, 'videos')
            }
          } catch (fallbackErr) {
            console.log('[API] LIST_VIDEOS: owner publicBee fallback failed:', fallbackErr?.message)
          }
        }
        console.log('[API] LIST_VIDEOS returning', videos?.length, 'videos from channel')
        const result = (videos || []).map(v => ({
          ...v,
          channelKey: driveKey,
          publicBeeKey: v?.publicBeeKey || resolvedPublicBeeKey || null,
        }))
        const enriched = await enrichMissingBlobMeta(
          result,
          (id) => usedOwnerPublicBeeFallback && typeof channel.publicBee?.getVideo === 'function'
            ? channel.publicBee.getVideo(id)
            : channel.getVideo(id)
        )
        const withAvailability = await attachVideoAvailability(enriched)
        listVideosCache.set(driveKey, { ts: Date.now(), value: withAvailability })
        // YouTube-Fast: background index for search
        backgroundIndexVideos(withAvailability, driveKey)
        return cloneArrayOfObjects(withAvailability)
      } catch (err) {
        console.error('[API] LIST_VIDEOS error:', err.message);
        return [];
      }
    },

    /**
     * Get video stream URL
     * @param {string} driveKey
     * @param {string} videoPath
     * @param {string} [publicBeeKey] - PublicBee key for fast viewer access
     * @param {string} [blobId] - Direct blobId (skip metadata fetch if provided)
     * @param {string} [blobsCoreKey] - Direct blobsCoreKey (skip metadata fetch if provided)
     * @param {string} [mimeType] - MIME type
     * @returns {Promise<{url: string}>}
     */
    async getVideoUrl(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType) {
      console.log('[API] getVideoUrl:', driveKey?.slice(0, 16), videoPath);

      const playbackBlobRef = resolvePlaybackBlobRef(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType)
      if (playbackBlobRef?.blobId && playbackBlobRef?.blobsCoreKey) {
        console.log('[API] getVideoUrl: INSTANT - using direct blobId/blobsCoreKey');
        return blobPlayback.resolveDirectBlobUrl({
          blobsCoreKey: playbackBlobRef.blobsCoreKey,
          blobId: playbackBlobRef.blobId,
          mimeType: playbackBlobRef.mimeType || 'video/mp4',
        })
      }

      const meta = await this.getVideoData(driveKey, videoPath, publicBeeKey)
      console.log('[API] getVideoUrl meta:', meta?.id, 'blobId:', meta?.blobId, 'blobsCoreKey:', meta?.blobsCoreKey?.slice(0, 16))

      let channel = null
      if (meta?.blobId && !meta?.blobsCoreKey) {
        console.log('[API] getVideoUrl: loading channel for blob entry (slow path)')
        channel = await loadChannel(ctx, driveKey)
      }

      return blobPlayback.resolveFromMetadata(meta, { channel })
    },

    /**
     * Prepare watch playback by resolving a streamable blob-server URL. The URL
     * handoff must stay fast; playback prefetch runs in the background so sparse
     * P2P ranges do not block the native player from opening.
     * @param {string} driveKey
     * @param {string} videoPath
     * @param {string} [publicBeeKey]
     * @param {string} [blobId]
     * @param {string} [blobsCoreKey]
     * @param {string} [mimeType]
     * @returns {Promise<{url: string, stats: Object}>}
     */
    async preparePlayback(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType) {
      console.log('[API] preparePlayback:', driveKey?.slice(0, 16), videoPath)
      markVideoPlayed(driveKey, videoPath)
      const startedAt = Date.now()
      const playbackBlobRef = resolvePlaybackBlobRef(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType)
      // Lowercase hex so the begin key matches the marks recorded by the blob
      // server (key.toString('hex')) and the prefetch path (blobCoreKeyHex).
      const timingKey = (playbackBlobRef?.blobsCoreKey || (typeof blobsCoreKey === 'string' ? blobsCoreKey : '') || '').toLowerCase() || null
      beginPlaybackTiming(timingKey, videoPath)

      // Resolve the blob-server URL first, then start the playback download
      // session. The direct URL alone is not enough for large/back-index MP4s:
      // native players can issue a plain GET from byte 0 and never surface the
      // tail/index range the blob needs before startup stalls.
      const prepared = await blobPlayback.preparePlayback({
        driveKey,
        videoPath,
        publicBeeKey,
        blobId,
        blobsCoreKey,
        mimeType,
        resolveUrl: (...args) => this.getVideoUrl(...args),
      })
      markPlaybackTiming(timingKey, 'url-resolved')
      let playbackStats = null
      const onDemandStatsPromise = startOnDemandPlaybackStats(driveKey, videoPath, playbackBlobRef)
        .catch((err) => {
          console.log('[API] direct playback stats failed:', err?.message || err)
          return null
        })
      let statsHandoffTimer = null
      try {
        const statsHandoffTimeout = new Promise((resolve) => {
          statsHandoffTimer = setTimeout(() => resolve(null), PLAYBACK_STATS_HANDOFF_TIMEOUT_MS)
        })
        const onDemandStats = await Promise.race([
          onDemandStatsPromise,
          statsHandoffTimeout
        ])
        if (onDemandStats) playbackStats = this.getVideoStats(driveKey, videoPath)
      } catch { /* best effort */ } finally {
        if (statsHandoffTimer) clearTimeout(statsHandoffTimer)
      }

      const prefetchPromise = this.prefetchVideo(driveKey, videoPath, publicBeeKey).then((prefetch) => {
        if (prefetch?.success === false) {
          console.log('[API] playback prefetch unavailable:', prefetch?.error || prefetch?.reason || 'unknown')
        }
        return prefetch
      }).catch((err) => {
        console.log('[API] playback prefetch failed:', err?.message || err)
        return null
      })
      void prefetchPromise

      if (!playbackStats) {
        try { playbackStats = this.getVideoStats(driveKey, videoPath) } catch { /* best effort */ }
      }
      if (playbackStats) prepared.stats = playbackStats

      trackPlaybackTiming({
        at: startedAt,
        driveKey: driveKey ? String(driveKey).slice(0, 16) : null,
        videoId: videoPath || null,
        stages: { totalMs: Date.now() - startedAt },
        readyForPlayback: null,
        peerCount: null,
        hasHeadBlock: null,
      })

      return prepared
    },

    /**
     * Start a live broadcast session on a fresh single-writer core.
     * The fMP4 byte source attaches to the returned session through the
     * broadcast service (platform encoder integrations); this surface only
     * manages lifecycle.
     * @param {{channelKey?: string, title?: string, targetFragmentDurationMs?: number, width?: number, height?: number}} [options]
     * @returns {Promise<{success: boolean, videoId?: string, liveCoreKey?: string, error?: string}>}
     */
    async startLivestream(options = {}) {
      try {
        const targetMs = Number(options.targetFragmentDurationMs)
        const session = await getLiveBroadcast().startBroadcast({
          channelKey: options.channelKey || null,
          title: options.title || null,
          targetFragmentDuration: targetMs > 0 ? targetMs / 1000 : undefined,
          width: Number(options.width) || 0,
          height: Number(options.height) || 0,
        })
        console.log('[API] startLivestream:', session.videoId, 'core:', session.liveCoreKey.slice(0, 16))
        announceChannelLiveStreams(options.channelKey)
        return { success: true, videoId: session.videoId, liveCoreKey: session.liveCoreKey }
      } catch (err) {
        console.error('[API] startLivestream failed:', err?.message || err)
        return { success: false, error: err?.message || String(err) }
      }
    },

    /**
     * Seal a live broadcast: flush the trailing fragment, append the EOS
     * marker, keep seeding the core (it IS the recording).
     * @param {string} videoId
     */
    async stopLivestream(videoId) {
      try {
        const session = getLiveBroadcast().getSession(videoId)
        const stats = await getLiveBroadcast().stopBroadcast(videoId)
        announceChannelLiveStreams(session?.writer?.descriptor?.channelKey)
        return { success: true, status: toLivestreamStatus(stats) }
      } catch (err) {
        return { success: false, error: err?.message || String(err) }
      }
    },

    /**
     * Broadcaster-side status for an active or sealed session.
     * @param {string} videoId
     */
    async getLivestreamStatus(videoId) {
      const session = getLiveBroadcast().getSession(videoId)
      if (!session) return { error: 'No live session: ' + videoId }
      return { status: toLivestreamStatus(session.getStats()) }
    },

    /**
     * Backend-internal (not RPC-exposed): the live session object, for
     * platform encoder integrations to attach a byte source via
     * session.write()/notifyKeyframe().
     * @param {string} videoId
     */
    getLiveBroadcastSession(videoId) {
      return getLiveBroadcast().getSession(videoId)
    },

    /**
     * Resolve a local live-HLS playlist URL for a live core. Works for both
     * in-progress streams (sliding window) and sealed recordings (full DVR).
     * @param {string} liveCoreKey - live core key (hex)
     * @returns {Promise<{url?: string, isLive?: boolean, error?: string}>}
     */
    async prepareLivePlayback(liveCoreKey) {
      try {
        const url = await getLivePlayback().getPlaybackUrl(liveCoreKey)
        return { url, isLive: true }
      } catch (err) {
        return { error: err?.message || String(err) }
      }
    },

    /**
     * Download video to a local file path
     * @param {string} channelKey - Channel key (hex)
     * @param {string} videoId - Video ID
     * @param {string} destPath - Destination file path
     * @param {Object} fsModule - File system module (bare-fs or node:fs)
     * @param {Function} [onProgress] - Progress callback (progress, bytesWritten, totalBytes)
     * @returns {Promise<{success: boolean, filePath?: string, error?: string}>}
     */
    async downloadVideo(channelKey, videoId, destPath, fsModule, onProgress) {
      console.log('[API] downloadVideo:', channelKey?.slice(0, 16), videoId, 'to:', destPath);
      try {
        const meta = await this.getVideoData(channelKey, videoId);
        if (!meta) {
          return { success: false, error: 'Video metadata not found' };
        }

        if (!meta.blobId || !meta.blobsCoreKey) {
          return { success: false, error: 'Video missing blobId or blobsCoreKey' };
        }

        const blob = normalizeBlobRefInput(meta.blobId) || parseBlobRef(meta)?.blob
        if (!blob) {
          return { success: false, error: 'Invalid blob ID format' };
        }

        // Load channel and get blobs core
        const channel = await loadChannel(ctx, channelKey);
        if (!channel) {
          return { success: false, error: 'Failed to load channel' };
        }

        const blobEntry = await channel.getBlobEntry(meta);
        if (!blobEntry?.blobsKey) {
          return { success: false, error: 'Video blob not accessible (not synced yet)' };
        }

        // Load the blobs Hypercore
        const blobsCore = ctx.store.get(blobEntry.blobsKey);
        await blobsCore.ready();

        // Create Hyperblobs reader
        const Hyperblobs = (await import('hyperblobs')).default;
        const blobs = new Hyperblobs(blobsCore);
        await blobs.ready();

        // Stream the blob to the destination file
        const totalBytes = blob.byteLength;
        let bytesWritten = 0;

        console.log('[API] Creating write stream for:', destPath);
        const readStream = blobs.createReadStream(blob);
        const writeStream = fsModule.createWriteStream(destPath);

        await new Promise((resolve, reject) => {
          readStream.on('data', (chunk) => {
            bytesWritten += chunk.length;
            if (onProgress) {
              const progress = Math.round((bytesWritten / totalBytes) * 100);
              onProgress(progress, bytesWritten, totalBytes);
            }
          });
          readStream.on('error', reject);
          writeStream.on('error', reject);
          writeStream.on('close', resolve);
          readStream.pipe(writeStream);
        });

        console.log('[API] downloadVideo complete:', destPath);
        return { success: true, filePath: destPath, size: totalBytes };
      } catch (err) {
        console.error('[API] downloadVideo failed:', err?.message);
        return { success: false, error: err?.message || 'Download failed' };
      }
    },

    /**
     * Get video metadata by ID or path
     * @param {string} driveKey
     * @param {string} videoId - Video ID or full path
     * @param {string} [publicBeeKey] - PublicBee key for fast viewer access
     * @returns {Promise<VideoMetadata|null>}
     */
    async getVideoData(driveKey, videoId, publicBeeKey, blobId, blobsCoreKey, mimeType) {
      console.log('[API] GET_VIDEO_DATA:', driveKey?.slice(0, 16), videoId, 'publicBeeKey:', publicBeeKey?.slice(0, 16));
      try {
        // Parse videoId to extract the actual ID
        let id = videoId
        if (typeof videoId === 'string' && videoId.startsWith('/videos/')) {
          const match = videoId.match(/\/videos\/([^.]+)/)
          if (match) id = match[1]
        }

        if (blobId && blobsCoreKey) {
          console.log('[API] GET_VIDEO_DATA: INSTANT metadata from direct blobId/blobsCoreKey')
          return {
            id,
            path: typeof videoId === 'string' && videoId.startsWith('/videos/') ? videoId : `/videos/${id}.mp4`,
            channelKey: driveKey,
            publicBeeKey: publicBeeKey || null,
            blobId,
            blobsCoreKey,
            mimeType: mimeType || 'video/mp4',
            title: id,
          }
        }

        // Fast path: use PublicBee if we have the key (for viewers)
        if (publicBeeKey) {
          console.log('[API] GET_VIDEO_DATA: using PublicBee fast path')
          const publicBee = await loadPublicBee(ctx, publicBeeKey)
          const v = await publicBee.getVideo(id)
          console.log('[API] GET_VIDEO_DATA PublicBee result:', v?.id, 'blobId:', v?.blobId, 'blobsCoreKey:', v?.blobsCoreKey?.slice(0, 16))
          if (v) return { ...v, channelKey: driveKey }
          // Fall through to feed previews/channel methods if not found
        }

        const previewVideo = getPreviewVideoFromFeed(driveKey, id, publicBeeKey)
        if (previewVideo?.blobId && previewVideo?.blobsCoreKey) {
          console.log('[API] GET_VIDEO_DATA: using relay/feed preview direct refs')
          return {
            ...previewVideo,
            id,
            path: previewVideo.path || `/videos/${id}.mp4`,
            channelKey: driveKey,
            publicBeeKey: previewVideo.publicBeeKey || publicBeeKey || null,
            mimeType: previewVideo.mimeType || mimeType || 'video/mp4',
          }
        }

      const channel = await loadChannel(ctx, driveKey)
      console.log('[API] GET_VIDEO_DATA channel loaded')
      console.log('[API] GET_VIDEO_DATA looking up id:', id)

      const v = await channel.getVideo(id)
      console.log('[API] GET_VIDEO_DATA result:', v?.id, 'blobId:', v?.blobId, 'blobsCoreKey:', v?.blobsCoreKey?.slice(0, 16))
      if (!v) return null
      return { ...v, channelKey: driveKey }
      } catch (err) {
        console.error('[API] GET_VIDEO_DATA error:', err.message);
        return null;
      }
    },

    /**
     * Delete a video from a channel
     * @param {string} channelKey
     * @param {string} videoId - Video ID to delete
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async deleteVideo(channelKey, videoId) {
      console.log('[API] DELETE_VIDEO:', channelKey?.slice(0, 16), videoId);

      if (!channelKey) {
        return { success: false, error: 'Channel key required' };
      }

      try {
        const channel = await loadChannel(ctx, channelKey)
        if (!channel) {
          return { success: false, error: 'Failed to load channel' };
        }
        await channel.deleteVideo(videoId)

        if (ctx.semanticFinder) {
          try { ctx.semanticFinder.removeVideo(videoId) } catch { /* best effort */ }
        }

        return { success: true };
      } catch (err) {
        console.error('[API] DELETE_VIDEO error:', err.message);
        return { success: false, error: err.message };
      }
    },

    /**
     * Get video thumbnail URL
     * @param {string} driveKey
     * @param {string} videoId
     * @param {{ thumbnailBlobId?: string|null, thumbnailBlobsCoreKey?: string|null, thumbnailMimeType?: string|null }} [refs]
     *   Optional blob references from feed previews. When provided, the URL is
     *   resolved directly — discovered channels whose metadata is not loaded
     *   locally (gossip previews) have no resolvable video record, so without
     *   these refs mobile thumbnails never resolved at all.
     * @returns {Promise<{url?: string, exists: boolean}>}
     */
    async getVideoThumbnail(driveKey, videoId, refs = {}, opts = {}) {
      try {
        const normalizeVideoId = (value) => {
          if (!value || typeof value !== 'string') return value
          if (value.startsWith('/videos/')) {
            const match = value.match(/\/videos\/([^./]+)/)
            if (match?.[1]) return match[1]
          }
          return value
        }

        const targetVideoId = normalizeVideoId(videoId)

        const getThumbnailMetaFromCachedList = () => {
          const cached = listVideosCache.get(driveKey)
          const items = Array.isArray(cached?.value) ? cached.value : []
          if (!items.length) return null

          const match = items.find((v) => {
            if (!v || typeof v !== 'object') return false
            const cachedId = normalizeVideoId(v.id || v.videoId || v.path)
            return cachedId === targetVideoId
          })

          if (!match || typeof match !== 'object') return null

          if (match.thumbnailBlobId && match.thumbnailBlobsCoreKey) {
            return {
              thumbnailBlobId: match.thumbnailBlobId,
              thumbnailBlobsCoreKey: match.thumbnailBlobsCoreKey,
              thumbnailMimeType: match.thumbnailMimeType,
              thumbnail: match.thumbnail,
            }
          }

          if (typeof match.thumbnail === 'string' && match.thumbnail.length > 0) {
            return { thumbnail: match.thumbnail }
          }

          return null
        }

        let resolvedPublicBeeKey = null;
        try {
          const feedManager = publicFeed && typeof publicFeed === 'object' ? publicFeed : null;
          const feed = feedManager && typeof feedManager.getFeed === 'function'
            ? feedManager.getFeed()
            : [];
          const entry = Array.isArray(feed)
            ? feed.find((e) => {
                const key = e && typeof e === 'object'
                  ? (e.channelKey || e.driveKey || null)
                  : null;
                return key === driveKey;
              })
            : null;
          resolvedPublicBeeKey = entry && typeof entry === 'object' ? (entry.publicBeeKey || null) : null;
        } catch { /* best effort */ }

        let meta = null;
        if (refs?.thumbnailBlobId && refs?.thumbnailBlobsCoreKey) {
          meta = {
            thumbnailBlobId: refs.thumbnailBlobId,
            thumbnailBlobsCoreKey: refs.thumbnailBlobsCoreKey,
            thumbnailMimeType: refs.thumbnailMimeType || null,
          }
        }
        const cachedMeta = meta ? null : getThumbnailMetaFromCachedList()
        if (cachedMeta) {
          meta = cachedMeta
        }

        if (resolvedPublicBeeKey) {
          meta = meta || await this.getVideoData(driveKey, targetVideoId, resolvedPublicBeeKey);
        }
        if (!meta) {
          meta = await this.getVideoData(driveKey, targetVideoId);
        }
        if (!meta) {
          return { exists: false };
        }

        if (!meta.thumbnailBlobId && !meta.thumbnailBlobsCoreKey && typeof meta.thumbnail === 'string' && meta.thumbnail.length > 0) {
          return { url: meta.thumbnail, exists: true };
        }

        // New Hyperblobs-based thumbnail
        if (meta.thumbnailBlobId && meta.thumbnailBlobsCoreKey) {
          const keyBuffer = b4a.from(meta.thumbnailBlobsCoreKey, 'hex');
          
          let blobsCore;
          try {
            blobsCore = ctx.store.get(keyBuffer);
            await blobsCore.ready();
          } catch (storeErr) {
            console.error('[API] GET_VIDEO_THUMBNAIL: store.get/ready failed:', storeErr.message);
            throw storeErr;
          }

          // Join swarm for thumbnail core
          if (ctx.swarm && blobsCore.discoveryKey) {
            try { ctx.swarm.join(blobsCore.discoveryKey) } catch { /* best effort */ }
          }

          const blob = normalizeBlobRefInput(meta.thumbnailBlobId) || parseBlobRef({
            blobsCoreKey: meta.thumbnailBlobsCoreKey,
            blobId: meta.thumbnailBlobId,
          })?.blob
          if (!blob) {
            return { exists: false, error: 'Invalid thumbnail blob ID format' }
          }

          // The blob server pipes the blob via hypercore-byte-stream, which reads
          // blocks with wait:true — so a plain GET stalls until the blocks
          // replicate. Image loaders (RN <Image>/Fresco, expo-image/Glide) give up
          // or hang on that wait where the video player tolerates it; that's why a
          // thumbnail URL only renders once its bytes are local. URL callers that
          // can't absorb a stalling response (mobile: opts.ensureLocal) actively
          // download the thumbnail blocks first, then only return the URL once the
          // bytes are local — otherwise report a retryable miss.
          const blobStart = blob.blockOffset
          const blobEnd = blob.blockOffset + Math.max(1, blob.blockLength || 1)
          const hasThumbnailBlocks = async () => {
            try { return Boolean(await blobsCore.has(blobStart, blobEnd)) } catch { return false }
          }

          let thumbnailLocal = await hasThumbnailBlocks()
          if (!thumbnailLocal) {
            if (opts?.ensureLocal) {
              if (ctx.swarm && blobsCore.discoveryKey) {
                try { ctx.swarm.join(blobsCore.discoveryKey) } catch { /* best effort */ }
              }
              let range = null
              try {
                range = blobsCore.download({ start: blobStart, end: blobEnd, linear: true })
                await Promise.race([
                  typeof range?.done === 'function' ? range.done() : Promise.resolve(),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('thumbnail download timeout')), 3000))
                ])
              } catch { /* best effort */ } finally {
                try { range?.destroy?.() } catch { /* best effort */ }
              }
              thumbnailLocal = await hasThumbnailBlocks()
              // Only hand back a URL once the bytes are local: the blob server's
              // buffered thumbnail response reads them on the next request, so this
              // keeps that read instant. Otherwise report a retryable miss.
              if (!thumbnailLocal) return { exists: false }
            } else {
              try {
                await Promise.race([
                  blobsCore.update({ wait: true }),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('thumbnail core update timeout')), 1500))
                ]);
              } catch { /* best effort */ }
            }
          }

          // Thumbnails are always encoded as JPEG (the bare-ffmpeg build has no
          // libwebp; see thumbnail.js). Defaulting to image/webp mislabeled the
          // JPEG bytes, which Android's <Image>/Fresco refused to decode while
          // browsers/iOS sniffed past it. Use the stored type when present, else
          // image/jpeg to match the actual bytes.
          const thumbnailMimeType = typeof meta.thumbnailMimeType === 'string' && meta.thumbnailMimeType.length > 0
            ? meta.thumbnailMimeType
            : 'image/jpeg';

          // Tag the URL with pt_thumbnail=1 so the blob server serves it via its
          // buffered thumbnail path (a deterministic 200 + Content-Length +
          // Connection: close response image loaders accept) instead of the
          // streaming pipe. Renders directly in <Image> — no base64. type flows
          // through as the Content-Type.
          const baseUrl = ctx.blobServer.getLink(blobsCore.key, {
            blob,
            type: thumbnailMimeType,
            // Match the blob server bind/default host and the video playback
            // URLs. Android native image loaders can resolve localhost through
            // IPv6 first, while Bare's blob server is bound to IPv4 loopback.
            host: ctx.blobServerHost || '127.0.0.1',
            port: ctx.blobServer?.port || ctx.blobServerPort
          });
          const [blobOrigin, blobQuery = ''] = baseUrl.split('?');
          const thumbnailPathUrl = `${blobOrigin.replace(/\/$/, '')}/__peartube_thumbnail__.jpg${blobQuery ? `?${blobQuery}` : ''}`;
          const url = `${thumbnailPathUrl}${thumbnailPathUrl.includes('?') ? '&' : '?'}pt_thumbnail=1`;

          return { url, exists: true };
        }

        return { exists: false };
      } catch (err) {
        console.error('[API] GET_VIDEO_THUMBNAIL error:', err.message);
        return { exists: false, error: err.message };
      }
    },

    // ============================================
    // Subscription Operations
    // ============================================

    /**
     * Subscribe to a channel
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async subscribeChannel(driveKey) {
      // Don't let loadChannel hang forever - use a 5s timeout
      // If it times out, we still add to subscriptions (data will sync later when peers are found)
      try {
        await Promise.race([
          loadChannel(ctx, driveKey),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Channel load timeout')), 5000))
        ]);
      } catch (err) {
        console.log('[API] subscribeChannel: channel load warning:', err.message, '- continuing anyway');
      }

      // Prefer the synced personal store when available so subscriptions
      // follow the user across devices; fall back to device-local metaDb.
      if (ctx.personal?.writable) {
        await ctx.personal.subscribe(driveKey, {});
        return { success: true };
      }

      const existing = await ctx.metaDb.get('subscriptions');
      const subs = existing?.value || [];

      if (!subs.find(s => s.driveKey === driveKey)) {
        subs.push({
          driveKey,
          subscribedAt: Date.now()
        });
        await ctx.metaDb.put('subscriptions', subs);
      }

      return { success: true };
    },

    /**
     * Unsubscribe from a channel
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async unsubscribeChannel(driveKey) {
      if (ctx.personal?.writable) {
        await ctx.personal.unsubscribe(driveKey);
        return { success: true };
      }

      const existing = await ctx.metaDb.get('subscriptions');
      const subs = existing?.value || [];

      const filtered = subs.filter(s => s.driveKey !== driveKey);
      await ctx.metaDb.put('subscriptions', filtered);

      return { success: true };
    },

    /**
     * Get subscriptions list with channel names
     * @returns {Promise<Array<{driveKey: string, name: string, subscribedAt?: number}>>}
     */
    async getSubscriptions() {
      let subs;
      if (ctx.personal) {
        // Normalize personal-store rows to the legacy { driveKey, subscribedAt } shape.
        subs = (await ctx.personal.listSubscriptions()).map((s) => ({
          driveKey: s.channelKey,
          subscribedAt: s.subscribedAt,
          name: s.name || undefined
        }));
      } else {
        const existing = await ctx.metaDb.get('subscriptions');
        subs = existing?.value || [];
      }

      const enriched = [];
      for (const sub of subs) {
        let name = sub.name || 'Unknown';
        try {
          const channel = await loadChannel(ctx, sub.driveKey)
          const meta = await channel?.getMetadata().catch(() => null)
          if (meta?.name) name = meta.name
        } catch (e) { /* best effort */ }
        enriched.push({ ...sub, name });
      }

      return enriched;
    },

    // ============================================
    // Personal Sync: Playlists / History / Settings
    // (private per-identity multi-writer store, synced across the user's devices)
    //
    // These are registered through the shared HRPC handler table, which calls
    // them as `api.method(request)` with `this` unbound — so they take the
    // decoded request object and return the response envelope directly, and
    // must not rely on `this`.
    // ============================================

    async getPlaylists() {
      if (!ctx.personal) return { playlists: [] };
      return { playlists: await ctx.personal.listPlaylists() };
    },
    async getPlaylistItems(req = {}) {
      if (!ctx.personal) return { items: [] };
      return { items: await ctx.personal.listPlaylistItems(req.playlistId) };
    },
    async createPlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store (create or activate an identity first)');
      const id = await ctx.personal.createPlaylist({ name: req.name || '', description: req.description || '' });
      return { success: true, id };
    },
    async updatePlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      await ctx.personal.updatePlaylist(req.id, { name: req.name, description: req.description });
      return { success: true };
    },
    async deletePlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      await ctx.personal.deletePlaylist(req.id);
      return { success: true };
    },
    async addToPlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      await ctx.personal.addToPlaylist(req.playlistId, { channelKey: req.channelKey, videoId: req.videoId, videoKey: req.videoKey });
      return { success: true };
    },
    async removeFromPlaylist(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      await ctx.personal.removeFromPlaylist(req.playlistId, req.videoKey);
      return { success: true };
    },

    async logWatchHistory(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      const eventId = await ctx.personal.logHistory(req);
      return { success: true, eventId };
    },
    async getWatchHistory(req = {}) {
      if (!ctx.personal) return { entries: [] };
      return { entries: await ctx.personal.listHistory({ limit: req.limit || 100 }) };
    },
    async getResumePosition(req = {}) {
      if (!ctx.personal) return { found: false };
      const resume = await ctx.personal.getResume(req.videoKey);
      return resume ? { found: true, resume } : { found: false };
    },
    async listResumePositions() {
      if (!ctx.personal) return { entries: [] };
      return { entries: await ctx.personal.listResume() };
    },

    async setPersonalSetting(req = {}) {
      if (!ctx.personal?.writable) throw new Error('No writable personal store');
      // Values arrive JSON-encoded over HRPC so a setting can hold any JSON type.
      let value = req.value;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { /* keep raw string */ }
      }
      await ctx.personal.setSetting(req.key, value);
      return { success: true };
    },
    async getPersonalSettings() {
      if (!ctx.personal) return { settings: [] };
      const settings = await ctx.personal.getSettings();
      return { settings: Object.entries(settings).map(([key, value]) => ({ key, value: JSON.stringify(value) })) };
    },

    /**
     * Provision the at-rest encryption secret (from the device's native
     * keychain) for the active identity's personal store, opening it encrypted.
     * The platform reads-or-generates the secret in the keychain and passes it
     * here; when omitted, the backend generates one and returns it so the
     * platform can persist it to the keychain. Must be called before the store
     * first opens to take effect.
     */
    async provisionPersonalEncryption(req = {}) {
      if (!ctx.personalManager) return { success: false, error: 'personal store unavailable' };
      const result = await ctx.personalManager.provisionSecret({ secret: req.secret || undefined });
      return { success: !!result.success, secret: result.secret, encrypted: !!result.encrypted, error: result.error };
    },

    /**
     * Resolve the signed channel root descriptor for a locally available
     * channel by reading `channel/root` from its public bee. The feed gossip
     * layer uses this to announce locally backed entries with the signature
     * strict peers require. Returns null when the channel has no verifiable
     * descriptor bound to this drive key.
     * @param {string} driveKey
     * @returns {Promise<object|null>}
     */
    async getChannelSignedDescriptor(driveKey) {
      if (!driveKey || !/^[a-f0-9]{64}$/i.test(driveKey)) return null
      const cached = signedDescriptorCache.get(driveKey)
      if (cached && (cached.value || Date.now() - cached.at < 60_000)) return cached.value

      let value = null
      try {
        const channel = await loadChannelBounded(driveKey)
        const root = await channel?.publicBee?.bee?.get('channel/root').catch(() => null)
        const signed = root?.value || null
        if (signed) {
          const verified = await verifySignedChannelRootDescriptor(signed)
          if (verified?.valid && verified.descriptor?.channelId === driveKey.toLowerCase()) {
            value = signed
          }
        }
      } catch { /* unavailable channels simply stay unsigned */ }

      signedDescriptorCache.set(driveKey, { value, at: Date.now() })
      return value
    },

    /**
     * Build compact, locally-provable feed snapshots for the provided entries.
     * This is used by the feed gossip protocol so peers can advertise recent,
     * playable videos without forcing the receiver to fan out into N channel reads.
     * @param {Array<{driveKey: string, publicBeeKey?: string | null}>} entries
     * @param {{limitPerChannel?: number}} [options]
     * @returns {Promise<Array<Object>>}
     */
    async getFeedSnapshotEntries(entries = [], { limitPerChannel = 3 } = {}) {
      if (!Array.isArray(entries) || entries.length === 0) return []

      const extractVideoId = (video) => {
        if (!video) return null
        if (video.id) return video.id
        if (video.path && typeof video.path === 'string') {
          const match = video.path.match(/\/videos\/([^./]+)/)
          if (match?.[1]) return match[1]
          const base = video.path.split('/').pop() || ''
          return base.replace(/\.[^./]+$/, '') || null
        }
        return null
      }

      const enrichMissingBlobMeta = async (videos, fetcher) => {
        const missing = (videos || []).filter(v => !v?.blobId || !v?.blobsCoreKey)
        if (missing.length === 0) return videos

        const ids = Array.from(new Set(
          missing
            .slice(0, Math.max(limitPerChannel * 2, limitPerChannel))
            .map(v => extractVideoId(v))
            .filter(Boolean)
        ))
        if (ids.length === 0) return videos

        const metaById = new Map()
        await Promise.all(ids.map(async (id) => {
          try {
            const meta = await fetcher(id)
            if (meta) metaById.set(id, meta)
          } catch { /* best effort */ }
        }))

        if (metaById.size === 0) return videos

        return (videos || []).map((video) => {
          if (!video || (video.blobId && video.blobsCoreKey)) return video
          const id = extractVideoId(video)
          const meta = id ? metaById.get(id) : null
          if (!meta) return video
          return {
            ...video,
            blobId: video.blobId || meta.blobId,
            blobsCoreKey: video.blobsCoreKey || meta.blobsCoreKey,
            mimeType: video.mimeType || meta.mimeType,
            thumbnailBlobId: video.thumbnailBlobId || meta.thumbnailBlobId,
            thumbnailBlobsCoreKey: video.thumbnailBlobsCoreKey || meta.thumbnailBlobsCoreKey,
            thumbnailMimeType: video.thumbnailMimeType || meta.thumbnailMimeType,
          }
        })
      }

      const getStableManifestUpdatedAt = (meta, videos, publicBee) => {
        let ts = 0

        const candidates = [
          meta?.updatedAt,
          meta?.createdAt,
          publicBee?.core?.length ? Number(publicBee.core.length) : 0,
        ]

        for (const video of videos || []) {
          candidates.push(
            video?.syncedAt,
            video?.updatedAt,
            video?.uploadedAt,
          )
        }

        for (const value of candidates) {
          const next = Number(value || 0) || 0
          if (next > ts) ts = next
        }

        return ts
      }

      const snapshots = await Promise.all(entries.map(async (entry) => {
        const driveKey = entry?.driveKey
        const publicBeeKey = entry?.publicBeeKey || null
        if (!driveKey || !publicBeeKey) return null

        try {
          const publicBee = await loadPublicBee(ctx, publicBeeKey)
          const [meta, rawVideos] = await Promise.all([
            publicBee.getMetadata().catch(() => null),
            publicBee.listVideos().catch(() => []),
          ])

          const baseVideos = (rawVideos || []).map((video) => ({
            ...video,
            channelKey: driveKey,
            publicBeeKey,
          }))
          const enrichedVideos = await enrichMissingBlobMeta(baseVideos, (id) => publicBee.getVideo(id))
          const videos = enrichedVideos
            .map((video) => {
              const id = extractVideoId(video)
              if (!id) return null
              return {
                id,
                title: video?.title ? String(video.title) : 'Untitled',
                creatorName: video?.creatorName ? String(video.creatorName) : null,
                uploadedAt: Number(video?.uploadedAt || 0) || 0,
                duration: Number(video?.duration || 0) || 0,
                thumbnail: video?.thumbnail ? String(video.thumbnail) : null,
                blobId: video?.blobId ? String(video.blobId) : null,
                blobsCoreKey: video?.blobsCoreKey ? String(video.blobsCoreKey) : null,
                mimeType: video?.mimeType ? String(video.mimeType) : null,
                playbackSupport: video?.playbackSupport ? String(video.playbackSupport) : null,
                containerSupport: video?.containerSupport ? String(video.containerSupport) : (video?.playbackSupport ? String(video.playbackSupport) : null),
                thumbnailBlobId: video?.thumbnailBlobId ? String(video.thumbnailBlobId) : null,
                thumbnailBlobsCoreKey: video?.thumbnailBlobsCoreKey ? String(video.thumbnailBlobsCoreKey) : null,
                thumbnailMimeType: video?.thumbnailMimeType ? String(video.thumbnailMimeType) : null,
              }
            })
            .filter(Boolean)

          return {
            driveKey,
            publicBeeKey,
            channelName: meta?.name || null,
            videoCount: Array.isArray(rawVideos) ? rawVideos.length : 0,
            manifestUpdatedAt: getStableManifestUpdatedAt(meta, rawVideos, publicBee),
            videos,
            previewVideos: videos,
          }
        } catch {
          return null
        }
      }))
      return snapshots.filter(Boolean)
    },

    // ============================================
    // Public Feed Operations
    // ============================================

    /**
     * Get public feed entries
     * @returns {{entries: Array, stats: Object}}
     */
    getPublicFeed() {
      if (!publicFeed) {
        return { entries: [], stats: { totalEntries: 0, hiddenCount: 0, peerCount: 0 } };
      }
      const rawFeed = publicFeed.getFeed();
      const feed = rawFeed
        .map((entry) => {
          return {
            driveKey: entry?.driveKey || entry?.channelKey || '',
            channelKey: entry?.channelKey || entry?.driveKey || '',
            source: entry?.source || 'peer',
            publicBeeKey: entry?.publicBeeKey || null,
            relayRole: entry?.relayRole || null,
            relayServing: Boolean(entry?.relayServing),
            catalogVersion: entry?.catalogVersion || null,
            previewVideosHash: entry?.previewVideosHash || null,
            channelName: entry?.channelName || null,
            videoCount: entry?.videoCount || 0,
            peerCount: entry?.peerCount || 0,
            discoveryOnly: Boolean(entry?.discoveryOnly),
            restoredFromCache: Boolean(entry?.restoredFromCache),
            restoredFrom: entry?.restoredFrom || null,
            requiresAvailabilityProbe: Boolean(entry?.requiresAvailabilityProbe),
            lastSeen: entry?.lastSeen || entry?.lastSeenAt || entry?.addedAt || 0,
            manifestUpdatedAt: entry?.manifestUpdatedAt || 0,
            videos: Array.isArray(entry?.videos) ? entry.videos : Array.isArray(entry?.previewVideos) ? entry.previewVideos : [],
            previewVideos: Array.isArray(entry?.videos) ? entry.videos : Array.isArray(entry?.previewVideos) ? entry.previewVideos : [],
          }
        })
        .filter((entry) => typeof entry.channelKey === 'string' && entry.channelKey.length > 0)
      const stats = publicFeed.getStats();
      const keyedEntries = feed.filter((e) => typeof e.publicBeeKey === 'string' && e.publicBeeKey.length > 0).length;
      const unkeyedEntries = feed.length - keyedEntries;
      console.log(
        `[API] Returning ${feed.length} feed entries (${stats.peerCount} peers, keyed=${keyedEntries}, fallback=${unkeyedEntries}, raw=${rawFeed.length})`
      );
      return {
        entries: feed,
        stats: {
          ...stats,
          keyedEntries,
          unkeyedEntries,
        },
      };
    },

    /**
     * Refresh feed from peers
     * @returns {{success: boolean, peerCount: number}}
     */
    refreshFeed() {
      console.log('[API] Refreshing feed...');
      let peerCount = 0;
      if (publicFeed) {
        peerCount = publicFeed.requestFeedsFromPeers();
      }
      return { success: true, peerCount };
    },

    /**
     * Submit channel to public feed
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async submitToFeed(driveKey) {
      console.log('[API] Submitting channel to feed:', driveKey?.slice(0, 16));
      if (publicFeed && driveKey) {
        // Get publicBeeKey from the channel for fast viewer access
        let publicBeeKey = null;
        try {
          const channel = await loadChannel(ctx, driveKey);
          publicBeeKey = channel?.publicBeeKey || await channel?.getPublicBeeKey();
          console.log('[API] submitToFeed: got publicBeeKey:', publicBeeKey?.slice(0, 16));

          // Comments are HyperDB-backed in the channel now; publish the channel DB
          // key as the comments DB key for older clients/debug screens.
          const commentsDbKey = channel.keyHex || driveKey
          if (commentsDbKey) {
            console.log('[API] submitToFeed: comments DB key:', commentsDbKey.slice(0, 16));

            if (channel.publicBee?.writable) {
              const pubMeta = await channel.publicBee.getMetadata().catch(() => ({}));
              if (!pubMeta?.commentsDbKey) {
                await channel.publicBee.setMetadata({
                  ...pubMeta,
                  commentsDbKey
                });
                console.log('[API] submitToFeed: synced commentsDbKey to PublicBee');
              }
            }
          }
        } catch (err) {
          console.log('[API] submitToFeed: channel/comments init error:', err?.message);
        }
        if (!isValidHypercoreHex(publicBeeKey)) {
          return {
            success: false,
            error: 'Unable to publish channel: missing publicBeeKey',
          }
        }
        await publicFeed.submitChannel(driveKey, publicBeeKey);
      }
      return { success: true };
    },

    /**
     * Unpublish channel from public feed
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async unpublishFromFeed(driveKey) {
      console.log('[API] Unpublishing channel from feed:', driveKey?.slice(0, 16));
      if (publicFeed && driveKey) {
        await publicFeed.unpublishChannel(driveKey);
      }
      return { success: true };
    },

    /**
     * Check if channel is published to feed
     * @param {string} driveKey
     * @returns {{published: boolean}}
     */
    isChannelPublished(driveKey) {
      if (publicFeed && driveKey) {
        return { published: publicFeed.isChannelPublished(driveKey) };
      }
      return { published: false };
    },

    /**
     * Hide channel from feed
     * @param {string} driveKey
     * @returns {{success: boolean}}
     */
    hideChannel(driveKey) {
      console.log('[API] Hiding channel:', driveKey?.slice(0, 16));
      if (publicFeed && driveKey) {
        publicFeed.hideChannel(driveKey);
      }
      return { success: true };
    },

    // ============================================
    // Prefetch and Stats Operations
    // ============================================

    /**
     * Prefetch a video - download all blocks for smooth seeking
     * @param {string} driveKey
     * @param {string} videoPath
     * @returns {Promise<Object>}
     */
    async prefetchVideo(driveKey, videoPath, publicBeeKey = null) {
      markVideoPlayed(driveKey, videoPath)
      const prefetchKey = encodeIndexKey(driveKey || '', videoPath || '')
      const existing = prefetchInFlight.get(prefetchKey)
      if (existing) return existing

      // Cancel any orphaned range requests from a previous prefetch session
      const existingRanges = activeRangeRequests.get(prefetchKey)
      if (existingRanges) {
        console.log('[API] Cancelling orphaned range requests for:', videoPath)
        try { existingRanges.cancel?.() } catch { /* best effort */ }
        existingRanges.ranges.forEach(r => { try { r?.destroy?.() } catch { /* best effort */ } })
        if (existingRanges.core) {
          try { existingRanges.core.off('download', existingRanges.onDownload) } catch { /* best effort */ }
          try { existingRanges.core.off('upload', existingRanges.onUpload) } catch { /* best effort */ }
        }
        activeRangeRequests.delete(prefetchKey)
      }

      const prefetchPromise = (async () => {
        const prefetchStart = Date.now();

      const getHeadBlockCount = (totalBlocks, totalBytes) => {
        if (!totalBlocks || totalBlocks <= 0) return 0
        if (!totalBytes || totalBytes <= 0) {
          return Math.min(totalBlocks, 16)
        }
        const bytesPerBlock = totalBytes / totalBlocks
        const minHeadBytes = 4 * 1024 * 1024
        const maxHeadBytes = 32 * 1024 * 1024
        const adaptiveBytes = Math.round(totalBytes * 0.02)
        const headTargetBytes = Math.min(maxHeadBytes, Math.max(minHeadBytes, adaptiveBytes))
        const headBlocks = Math.ceil(headTargetBytes / bytesPerBlock)
        return Math.max(1, Math.min(totalBlocks, headBlocks))
      }

      // Some containers (notably MP4 without faststart, MKV cues, etc.) may require reads
      // from the end or middle of the file during demuxer init. If the blob server supports
      // Range requests (or the player seeks), having these blocks available dramatically
      // reduces startup time.
      const getTailBlockCount = (totalBlocks, totalBytes) => {
        if (!totalBlocks || totalBlocks <= 0) return 0
        if (!totalBytes || totalBytes <= 0) {
          return Math.min(totalBlocks, 16)
        }
        const bytesPerBlock = totalBytes / totalBlocks
        const minTailBytes = 2 * 1024 * 1024
        const maxTailBytes = 16 * 1024 * 1024
        const adaptiveBytes = Math.round(totalBytes * 0.01)
        const tailTargetBytes = Math.min(maxTailBytes, Math.max(minTailBytes, adaptiveBytes))
        const tailBlocks = Math.ceil(tailTargetBytes / bytesPerBlock)
        return Math.max(1, Math.min(totalBlocks, tailBlocks))
      }

      const getMidBlockCount = (totalBlocks, totalBytes) => {
        if (!totalBlocks || totalBlocks <= 0) return 0
        if (!totalBytes || totalBytes <= 0) {
          return Math.min(totalBlocks, 8)
        }
        const bytesPerBlock = totalBytes / totalBlocks
        const targetBytes = 2 * 1024 * 1024
        const midBlocks = Math.ceil(targetBytes / bytesPerBlock)
        return Math.max(1, Math.min(totalBlocks, midBlocks))
      }

      console.log('[API] ===== STARTING PREFETCH =====');
      console.log('[API] Channel:', driveKey?.slice(0, 16));
      console.log('[API] Path:', videoPath);
      if (publicBeeKey) {
        console.log('[API] Prefetch publicBeeKey:', publicBeeKey?.slice(0, 16));
      }

      // Check if corestore is still open
      if (ctx.store.closed) {
        console.log('[API] Corestore is closed, skipping prefetch');
        return { success: false, error: 'Corestore is closed' };
      }

      const existingIntent = await loadDownloadIntent(ctx, driveKey, videoPath)
      let blobMeta = null
      let v = null
      let releasePrefetchBlobRef = null
      const releaseProtectedPrefetchBlobRef = () => {
        if (!releasePrefetchBlobRef) return
        const release = releasePrefetchBlobRef
        releasePrefetchBlobRef = null
        release()
      }

      if (existingIntent) {
        console.log('[API] Resuming download from intent:', videoPath)
        blobMeta = {
          blobsCoreKey: existingIntent.blobsCoreKey,
          blobId: existingIntent.blobId,
          byteLength: existingIntent.totalBytes || 0
        }
      } else {
        // Resolve the blob source from metadata
        v = await this.getVideoData(driveKey, videoPath, publicBeeKey)
        console.log('[API] Prefetch video data:', v?.id, 'blobsCoreKey:', v?.blobsCoreKey?.slice(0, 16), 'path:', v?.path)
        if (v?.blobsCoreKey && v?.blobId) {
          blobMeta = {
            blobsCoreKey: v.blobsCoreKey,
            blobId: v.blobId,
            byteLength: v?.size || v?.byteLength || 0
          }
          console.log('[API] Prefetch using blobsCoreKey:', v.blobsCoreKey?.slice(0, 16))
        } else {
          console.log('[API] Prefetch: video missing blobsCoreKey or blobId, v:', JSON.stringify(v)?.slice(0, 200))
        }
      }

      // Clean up any existing monitor
      if (videoStats) {
        videoStats.cleanupMonitor(driveKey, videoPath);
        videoStats.updateStats(driveKey, videoPath, {
          status: 'connecting',
          startTime: prefetchStart
        });
      }

      try {
        // Prefetch directly from blobs core using blobId.
        if (blobMeta?.blobsCoreKey && blobMeta?.blobId) {
          const keyBuf = b4a.from(blobMeta.blobsCoreKey, 'hex')
          const blobCoreKeyHex = String(blobMeta.blobsCoreKey || '').toLowerCase()
          const core = ctx.store.get({ key: keyBuf })
          await core.ready()

          let blobDiscoveryHandle = null
          if (ctx.swarm && core.discoveryKey) {
            try {
              blobDiscoveryHandle = retainSwarmDiscovery(ctx, core.discoveryKey, {
                label: `prefetch:${blobMeta.blobsCoreKey.slice(0, 16)}`
              })
            } catch { /* best effort */ }
          }

          const blobId = normalizeBlobRefInput(blobMeta.blobId) || parseBlobRef(blobMeta)?.blob
          if (!blobId) throw new Error('Invalid blob ID format')

          const startBlock = blobId.blockOffset
          const endBlock = blobId.blockOffset + blobId.blockLength
          const totalBlocks = blobId.blockLength
          const totalBytes = blobId.byteLength || blobMeta.byteLength || 0

          const normalizedBlobId = typeof blobMeta.blobId === 'string'
            ? blobMeta.blobId
            : `${blobId.blockOffset}:${blobId.blockLength}:${blobId.byteOffset}:${blobId.byteLength}`

          await promotePlaybackAvailabilityPeers({
            driveKey,
            videoPath,
            publicBeeKey,
            blobsCoreKey: blobMeta.blobsCoreKey,
            blobId: normalizedBlobId,
            core,
          })

          await waitForBlobPrefetchReadiness(core, blobDiscoveryHandle, blobMeta.blobsCoreKey.slice(0, 16))

          if (seedingManager?.retainBlobRef) {
            releasePrefetchBlobRef = seedingManager.retainBlobRef({
              blobsCoreKey: blobMeta.blobsCoreKey,
              blobId: normalizedBlobId
            })
          }

          if (!existingIntent && blobMeta?.blobsCoreKey) {
            await saveDownloadIntent(ctx, {
              driveKey,
              videoPath,
              blobsCoreKey: blobMeta.blobsCoreKey,
              blobId: normalizedBlobId,
              startBlock,
              endBlock,
              totalBlocks,
              totalBytes,
              mimeType: v?.mimeType || existingIntent?.mimeType || '',
              startedAt: Date.now()
            }).catch(err => console.log('[API] Failed to save download intent:', err?.message))
          }

          // Count initial blocks already available
          // For large videos, use sampling instead of all-or-nothing has(start, end)
          let initialAvailable = 0
          let initialAvailabilityIsExact = false
          const fullyCached = await core.has(startBlock, endBlock)
          if (fullyCached) {
            initialAvailable = totalBlocks
            initialAvailabilityIsExact = true
          } else if (totalBlocks <= 512) {
            // Small video: exact block-by-block count
            for (let i = startBlock; i < endBlock; i++) {
              if (await core.has(i)) initialAvailable++
            }
            initialAvailabilityIsExact = true
          } else {
            // Large video: sample to estimate (same pattern as checkVideoSync)
            const sampleSize = Math.min(totalBlocks, 20)
            const step = Math.max(1, Math.floor(totalBlocks / sampleSize))
            let sampledHits = 0
            let sampledTotal = 0
            for (let i = startBlock; i < endBlock; i += step) {
              if (await core.has(i)) sampledHits++
              sampledTotal++
            }
            initialAvailable = sampledTotal > 0 ? Math.round((sampledHits / sampledTotal) * totalBlocks) : 0
          }
          console.log(`[API] Initial: ${initialAvailable}/${totalBlocks} blocks (${Math.round(initialAvailable/totalBlocks*100)}%)`)

          if (videoStats) {
            videoStats.updateStats(driveKey, videoPath, {
              status: initialAvailable === totalBlocks ? 'complete' : 'downloading',
              totalBlocks,
              totalBytes,
              initialBlocks: initialAvailable,
              downloadedBlocks: 0,
              peerCount: core.peers?.length || 0
            })
            videoStats.emitStats(driveKey, videoPath, true) // force=true for initial stats
          }

          const wasCached = initialAvailable === totalBlocks && totalBlocks > 0
          if (wasCached) {
            console.log('[API] Already fully cached (blobs)')
          }

          const bytesPerBlock = totalBlocks > 0 ? totalBytes / totalBlocks : 0
          const initialCachedBlocksForQuota = initialAvailabilityIsExact ? initialAvailable : 0
          const initialCachedBytes = Math.round(initialCachedBlocksForQuota * bytesPerBlock)
          if (seedingManager) {
            await seedingManager.addSeed(driveKey, videoPath, 'watched', {
              blockLength: totalBlocks,
              byteLength: initialCachedBytes,
              publicBeeKey: publicBeeKey || v?.publicBeeKey || existingIntent?.publicBeeKey || null,
              blobId: normalizedBlobId,
              blobsCoreKey: blobMeta.blobsCoreKey,
              thumbnailBlobId: v?.thumbnailBlobId || existingIntent?.thumbnailBlobId || null,
              thumbnailBlobsCoreKey: v?.thumbnailBlobsCoreKey || existingIntent?.thumbnailBlobsCoreKey || null,
              mimeType: v?.mimeType || existingIntent?.mimeType || null,
              thumbnailMimeType: v?.thumbnailMimeType || existingIntent?.thumbnailMimeType || null
            }, { protectSelf: true, protectedKeys: getActiveRangeSeedKeys() }).catch(err => console.log('[API] Failed to register seed intent:', err?.message))
          }
          const headBlocks = getHeadBlockCount(totalBlocks, totalBytes)
          const tailBlocks = getTailBlockCount(totalBlocks, totalBytes)
          const midBlocks = getMidBlockCount(totalBlocks, totalBytes)
          const startupHeadBlocks = Math.max(0, Math.min(totalBlocks, headBlocks || Math.min(totalBlocks, 16)))
          const startupHeadEnd = startupHeadBlocks > 0
            ? Math.min(endBlock, startBlock + startupHeadBlocks)
            : startBlock
          let startupHeadReady = false
          if (startupHeadBlocks > 0) {
            try {
              startupHeadReady = await core.has(startBlock, startupHeadEnd)
            } catch { /* best effort */ }
          }
          console.log(
            '[API] Startup head availability:',
            startupHeadReady ? 'ready' : 'waiting',
            `${startupHeadBlocks}/${totalBlocks} contiguous startup blocks`
          )
          if (!startupHeadReady && startupHeadBlocks > 0) {
            logBlobDownloadDiagnostics('startup-before-prefetch', core, startBlock, startupHeadEnd)
          }
          let playbackReadyResolved = false
          let playbackReadyTimeout = null
          let resolvePlaybackReady = null
          const playbackReady = new Promise((resolve) => {
            resolvePlaybackReady = () => {
              if (playbackReadyResolved) return
              playbackReadyResolved = true
              if (playbackReadyTimeout) clearTimeout(playbackReadyTimeout)
              resolve()
            }
          })
          playbackReadyTimeout = setTimeout(() => {
            console.log(`[API] Playback startup prefetch timed out after ${PLAYBACK_STARTUP_PREFETCH_TIMEOUT_MS}ms, continuing with current availability`)
            if (!startupHeadReady && startupHeadBlocks > 0) {
              logBlobDownloadDiagnostics('startup-prefetch-timeout', core, startBlock, startupHeadEnd)
            }
            resolvePlaybackReady?.()
          }, PLAYBACK_STARTUP_PREFETCH_TIMEOUT_MS)

          if (startupHeadReady) {
            markPlaybackTiming(blobCoreKeyHex, 'head-local', 'cached')
            resolvePlaybackReady?.()
          }

          let downloadedBlocks = 0
          let downloadedBytesTotal = initialCachedBytes
          let downloadSpeed = 0
          let lastSpeedTime = Date.now()
          let lastSpeedBytes = downloadedBytesTotal
          let uploadSpeed = 0
          let uploadedBytesTotal = 0
          let lastUploadTime = Date.now()
          let lastUploadBytes = 0
          const downloadedIndices = new Set()
          let assumedComplete = wasCached
          let stallReconnectTimer = null
          const clearStallReconnect = () => {
            if (stallReconnectTimer) { clearTimeout(stallReconnectTimer); stallReconnectTimer = null }
          }

          const onDownload = (index, byteLength) => {
            if (typeof index !== 'number') return
            if (index < startBlock || index >= endBlock) return
            // Real data is flowing — the connection is healthy; cancel the
            // half-open-connection failover.
            clearStallReconnect()
            if (assumedComplete) {
              assumedComplete = false
              initialAvailable = 0
              downloadedBytesTotal = 0
              lastSpeedBytes = 0
              if (videoStats) {
                videoStats.updateStats(driveKey, videoPath, { initialBlocks: 0 })
              }
            }
            if (!downloadedIndices.has(index)) {
              downloadedIndices.add(index)
              downloadedBlocks = downloadedIndices.size
              if (downloadedBlocks <= 6 || index < startBlock + Math.min(8, startupHeadBlocks || 8)) {
                console.log(
                  '[API] Blob block downloaded:',
                  index,
                  `${downloadedBlocks}/${totalBlocks}`,
                  'bytes:',
                  byteLength || 0,
                  'peers:',
                  core.peers?.length || 0
                )
              }
            }
            markPlaybackTiming(blobCoreKeyHex, 'first-block', `block ${index}`)
            resolvePlaybackReady?.()
            const chunkBytes =
              typeof byteLength === 'number' && Number.isFinite(byteLength) && byteLength > 0
                ? byteLength
                : bytesPerBlock
            downloadedBytesTotal += chunkBytes
            const totalDownloaded = initialAvailable + downloadedBlocks
            const now = Date.now()
            const elapsed = (now - lastSpeedTime) / 1000
            if (elapsed >= 0.5) {
              const deltaBytes = downloadedBytesTotal - lastSpeedBytes
              downloadSpeed = elapsed > 0 ? deltaBytes / elapsed : 0
              lastSpeedBytes = downloadedBytesTotal
              lastSpeedTime = now
            }

            const isComplete = totalDownloaded >= totalBlocks
            if (seedingManager) {
              seedingManager.updateSeedCachedBytes?.(driveKey, videoPath, Math.min(totalBytes, downloadedBytesTotal)).catch(() => {})
            }
            if (videoStats) {
              videoStats.updateStats(driveKey, videoPath, {
                downloadedBlocks,
                peerCount: core.peers?.length || 0,
                status: isComplete ? 'complete' : 'downloading',
                initialBlocks: initialAvailable
              })
              // Use force=true on completion, otherwise let throttle work
              videoStats.emitStats(driveKey, videoPath, isComplete)
            }
          }

          const onUpload = (index, byteLength) => {
            if (typeof index !== 'number') return
            if (index < startBlock || index >= endBlock) return
            const chunkBytes =
              typeof byteLength === 'number' && Number.isFinite(byteLength) && byteLength > 0
                ? byteLength
                : bytesPerBlock
            uploadedBytesTotal += chunkBytes
            const now = Date.now()
            const elapsed = (now - lastUploadTime) / 1000
            if (elapsed >= 0.5) {
              const deltaBytes = uploadedBytesTotal - lastUploadBytes
              uploadSpeed = elapsed > 0 ? deltaBytes / elapsed : 0
              lastUploadBytes = uploadedBytesTotal
              lastUploadTime = now
            }

            if (videoStats) {
              videoStats.updateStats(driveKey, videoPath, {
                peerCount: core.peers?.length || 0
              })
              videoStats.emitStats(driveKey, videoPath)
            }
          }

          const monitor = {
            downloadSpeed: () => (Date.now() - lastSpeedTime > 2000 ? 0 : downloadSpeed),
            uploadSpeed: () => (Date.now() - lastUploadTime > 2000 ? 0 : uploadSpeed)
          }

          if (!wasCached || videoStats) {
            core.on('download', onDownload)
            core.on('upload', onUpload)
            // Half-open-connection failover. A peer can complete the swarm
            // handshake and report `remoteSynced` (so it looks like a healthy
            // source) yet move zero bytes — the connection is dead in one
            // direction. Hyperswarm only redials after its own ~56s timeout, so
            // the player stalls for ~40s+ before data ever flows. If no block
            // has arrived while synced peers exist, drop those non-delivering
            // connections so the swarm redials a fresh one in seconds. One shot.
            if (!wasCached) {
              stallReconnectTimer = setTimeout(() => {
                stallReconnectTimer = null
                if (downloadedBlocks > 0) return
                try {
                  const syncedKeys = new Set()
                  for (const p of (core.peers || [])) {
                    if (p?.remoteSynced === false) continue
                    const k = extractPeerKeyHex(p)
                    if (k) syncedKeys.add(k)
                  }
                  if (syncedKeys.size === 0) return
                  let dropped = 0
                  for (const conn of (ctx.swarm?.connections || [])) {
                    const ck = conn?.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex').toLowerCase() : null
                    if (ck && syncedKeys.has(ck)) {
                      try { conn.destroy() } catch { /* best effort */ }
                      dropped++
                    }
                  }
                  if (dropped > 0) {
                    console.log(`[API] Playback stall: 0 blob blocks after ${PLAYBACK_STALL_RECONNECT_MS}ms with ${syncedKeys.size} synced peer(s) — dropped ${dropped} stale connection(s) to force redial`)
                  }
                } catch (err) {
                  console.log('[API] Playback stall reconnect error (non-fatal):', err?.message || err)
                }
              }, PLAYBACK_STALL_RECONNECT_MS)
            }
          }
          if (videoStats) {
            videoStats.registerMonitor(driveKey, videoPath, monitor, () => {
              clearStallReconnect()
              core.off('download', onDownload)
              core.off('upload', onUpload)
            })
          }

          // Initialize range tracking entry only for live downloads.
          if (!wasCached) activeRangeRequests.set(prefetchKey, { ranges: [], core, onDownload, onUpload, seedKey: `${driveKey}:${videoPath}` })

          if (!wasCached) {
            let fullDownloadStarted = false
            let fillCancelled = false
            let currentFillRange = null

            // Admission check for the full background download. Streaming a video
            // front-to-back fills the whole file to disk (the playback window
            // cache only trims behind the playhead), so a single watch of a video
            // that doesn't fit the remaining cache quota would breach the storage
            // limit. Evaluate once, up front; default to allowing the download on
            // any uncertainty so playback behaviour is unchanged when the budget
            // can't be measured. Cheap thanks to the cached on-disk measurement.
            const fullDownloadBudgetPromise = (async () => {
              if (!seedingManager?.getQuotaBudget) return true
              try {
                const budget = await seedingManager.getQuotaBudget()
                const remainingBytes = Math.max(0, totalBytes - initialCachedBytes)
                return fullDownloadFitsQuota(budget.headroomBytes, remainingBytes)
              } catch {
                return true
              }
            })()
            const rangeEntry = activeRangeRequests.get(prefetchKey)
            if (rangeEntry) {
              rangeEntry.cancel = () => {
                fillCancelled = true
                clearStallReconnect()
                unsubscribePlayhead()
              }
            }

            const finishFullDownload = async () => {
              console.log('[API] Download complete (blobs)')
              unsubscribePlayhead()
              await deleteDownloadIntent(ctx, driveKey, videoPath).catch(err =>
                console.log('[API] Failed to delete download intent:', err?.message)
              )
              downloadSpeed = 0
              if (videoStats) {
                videoStats.updateStats(driveKey, videoPath, { status: 'complete' })
                videoStats.emitStats(driveKey, videoPath, true) // force=true for completion
                setTimeout(() => videoStats.cleanupMonitor(driveKey, videoPath), 30000)
              }
              activeRangeRequests.delete(prefetchKey)
              // Register completed download as a seed for quota tracking
              if (seedingManager) {
                seedingManager.addSeed(driveKey, videoPath, 'watched', {
                  blockLength: totalBlocks,
                  byteLength: totalBytes,
                  publicBeeKey: publicBeeKey || v?.publicBeeKey || null,
                  blobId: blobMeta.blobId,
                  blobsCoreKey: blobMeta.blobsCoreKey,
                  thumbnailBlobId: v?.thumbnailBlobId || null,
                  thumbnailBlobsCoreKey: v?.thumbnailBlobsCoreKey || null,
                  mimeType: v?.mimeType || existingIntent?.mimeType || null,
                  thumbnailMimeType: v?.thumbnailMimeType || null
                }, { protectSelf: true, protectedKeys: getActiveRangeSeedKeys() })
                  .catch(err => console.log('[API] Failed to register seed:', err?.message))
                  .finally(releaseProtectedPrefetchBlobRef)
              } else {
                releaseProtectedPrefetchBlobRef()
              }
            }

            const failFullDownload = (err) => {
              unsubscribePlayhead()
              if (err.message?.includes('closed') || ctx.store.closed) {
                console.log('[API] Prefetch cancelled (corestore closed)')
              } else {
                console.error('[API] Prefetch error:', err.message)
              }
              if (videoStats) {
                videoStats.updateStats(driveKey, videoPath, { status: 'cancelled' })
                videoStats.emitStats(driveKey, videoPath, true) // force=true for cancellation
                videoStats.cleanupMonitor(driveKey, videoPath)
              }
              activeRangeRequests.delete(prefetchKey)
              releaseProtectedPrefetchBlobRef()
            }

            // Stream the body in play order. Without `linear`, hypercore pulls
            // blocks in rarest/availability order, so the background fill races
            // ahead into the middle/end of the file while the player stalls
            // waiting for the contiguous bytes right after its current position.
            const startFillPass = (anchor) => {
              if (fillCancelled) return
              const fillRange = core.download({ start: anchor, end: endBlock, linear: true })
              currentFillRange = fillRange
              const entry = activeRangeRequests.get(prefetchKey)
              if (entry) entry.ranges.push(fillRange)
              fillRange.done().then((completed) => {
                // hypercore v11 resolves done() with `false` (instead of
                // rejecting) when a range is destroyed or its session closes.
                // Treating any resolution as success marked partially
                // downloaded videos "complete": the UI said "Saved on this
                // device", the resume intent was deleted, and a full-size seed
                // was registered against the cache quota.
                if (completed === false || fillCancelled || currentFillRange !== fillRange) return
                if (anchor > startBlock) {
                  // The fill re-anchored past a seek window at some point —
                  // sweep the skipped stretch. Blocks already present are not
                  // re-requested, so this pass only fetches the holes.
                  startFillPass(startBlock)
                  return
                }
                void finishFullDownload()
              }).catch(failFullDownload)
            }

            let fullDownloadDecided = false
            const startFullDownload = async () => {
              if (fullDownloadStarted || fillCancelled || fullDownloadDecided) return
              logBlobDownloadDiagnostics('startup-before-full-download', core, startBlock, startupHeadEnd || endBlock)
              const fits = await fullDownloadBudgetPromise
              if (fullDownloadStarted || fillCancelled || fullDownloadDecided) return
              fullDownloadDecided = true
              if (!fits) {
                // Over the cache quota: don't background-cache the whole file.
                // Playback keeps streaming on demand and the window cache bounds
                // the on-disk footprint; the partial seed registered at startup
                // stays evictable so the quota is respected. Release the prefetch
                // blob protection (playback-active already guards live reads) and
                // drop the resume intent so we never claim a full cache we won't
                // complete.
                console.log('[API] Skipping full background download — would exceed storage quota; streaming with bounded cache')
                unsubscribePlayhead()
                await deleteDownloadIntent(ctx, driveKey, videoPath).catch(() => {})
                releaseProtectedPrefetchBlobRef()
                return
              }
              fullDownloadStarted = true
              startFillPass(startBlock)
            }

            // Follow the playhead. When the blob server prioritizes a new
            // window (seek, or the window advancing with playback), re-anchor
            // the background fill just past it. Before this, a far seek left
            // the full-file fill competing for peer bandwidth from the front
            // of the file while the player starved at the seek point.
            const unsubscribePlayhead = subscribeBlobPlayhead((event) => {
              if (fillCancelled || !fullDownloadStarted) return
              if (event.coreKeyHex !== blobCoreKeyHex) return
              if (event.windowEnd <= startBlock || event.windowStart >= endBlock) return
              const nextAnchor = Math.max(startBlock, Math.min(event.windowEnd, endBlock - 1))
              const staleRange = currentFillRange
              currentFillRange = null
              if (staleRange) {
                const entry = activeRangeRequests.get(prefetchKey)
                if (entry) {
                  const idx = entry.ranges.indexOf(staleRange)
                  if (idx >= 0) entry.ranges.splice(idx, 1)
                }
                try { staleRange.destroy() } catch { /* best effort */ }
              }
              startFillPass(nextAnchor)
            })

            // Speculative index pre-warm for the END and MIDDLE of the file
            // (back-moov MP4 / MKV cues). Deferred until the front head range is
            // local: on a bandwidth-starved single peer these ~hundreds of
            // far-away blocks otherwise steal delivery slots from the front-moov
            // index the player is actually blocked on, adding many seconds to
            // first frame. Front-moov files (the common case) never need them
            // during startup; back-moov files still get their tail/index via the
            // player's own reactive range request + forward-fill, so deferring is
            // safe — it only stops the pre-warm from competing before the player
            // can start.
            let tailMidStarted = false
            const startTailMidPrefetch = () => {
              if (tailMidStarted || fillCancelled) return
              tailMidStarted = true

              if (tailBlocks > 0 && tailBlocks < totalBlocks) {
                const tailStart = Math.max(startBlock, endBlock - tailBlocks)
                // Avoid duplicating the head range on tiny files.
                if (tailStart > startBlock + Math.max(1, headBlocks)) {
                  console.log('[API] Prefetch tail range (blobs):', (endBlock - tailStart), 'blocks')
                  const tailRange = core.download({ start: tailStart, end: endBlock })
                  activeRangeRequests.get(prefetchKey)?.ranges.push(tailRange)
                  tailRange.done().then((completed) => {
                    if (completed === false) return
                    console.log('[API] Tail prefetch complete (blobs)')
                  }).catch(err => {
                    console.log('[API] Tail prefetch error (blobs):', err?.message)
                  })
                }
              }

              if (midBlocks > 0 && midBlocks < totalBlocks && totalBlocks > (headBlocks + tailBlocks + midBlocks + 4)) {
                const midCenter = startBlock + Math.floor(totalBlocks / 2)
                const midStart = Math.max(startBlock, Math.min(endBlock - 1, midCenter - Math.floor(midBlocks / 2)))
                const midEnd = Math.min(endBlock, midStart + midBlocks)
                const headEnd = Math.min(endBlock, startBlock + headBlocks)
                const tailStart = Math.max(startBlock, endBlock - tailBlocks)
                const overlapsHead = midStart < headEnd && midEnd > startBlock
                const overlapsTail = midStart < endBlock && midEnd > tailStart
                if (!overlapsHead && !overlapsTail && midEnd > midStart) {
                  console.log('[API] Prefetch mid range (blobs):', (midEnd - midStart), 'blocks')
                  const midRange = core.download({ start: midStart, end: midEnd })
                  activeRangeRequests.get(prefetchKey)?.ranges.push(midRange)
                  midRange.done().then((completed) => {
                    if (completed === false) return
                    console.log('[API] Mid prefetch complete (blobs)')
                  }).catch(err => {
                    console.log('[API] Mid prefetch error (blobs):', err?.message)
                  })
                }
              }
            }

            const startInitPrefetch = () => {
              // Head prefetch: prioritize container headers and early samples.
              if (headBlocks > 0 && headBlocks < totalBlocks) {
                const headEnd = Math.min(endBlock, startBlock + headBlocks)
                console.log('[API] Prefetch head range (blobs):', (headEnd - startBlock), 'blocks')
                logBlobDownloadDiagnostics('startup-before-head-download', core, startBlock, headEnd)
                const headRange = core.download({ start: startBlock, end: headEnd, linear: true })
                activeRangeRequests.get(prefetchKey).ranges.push(headRange)
                if (typeof headRange?.ready === 'function') {
                  headRange.ready().then(() => {
                    logBlobDownloadDiagnostics('startup-after-head-download-attached', core, startBlock, headEnd)
                  }).catch((err) => {
                    console.log('[API] Head prefetch attach error (blobs):', err?.message || err)
                  })
                } else {
                  logBlobDownloadDiagnostics('startup-after-head-download-created', core, startBlock, headEnd)
                }
                let headTimeout = null
                headTimeout = setTimeout(() => {
                  console.log('[API] Head prefetch slow, starting full download in parallel')
                  logBlobDownloadDiagnostics('startup-head-download-slow', core, startBlock, headEnd)
                  startFullDownload()
                }, 1500)
                headRange.done().then((completed) => {
                  if (headTimeout) clearTimeout(headTimeout)
                  // Resolved-false means the range was cancelled (session
                  // re-prefetched or closed) — starting the full download here
                  // would resurrect an untracked zombie download that competes
                  // with the replacement session for peer bandwidth.
                  if (completed === false || fillCancelled) return
                  console.log('[API] Head prefetch complete (blobs)')
                  logBlobDownloadDiagnostics('startup-head-download-complete', core, startBlock, headEnd)
                  markPlaybackTiming(blobCoreKeyHex, 'head-local', downloadSpeed > 0 ? `${(downloadSpeed / 1048576).toFixed(2)}MB/s` : '')
                  resolvePlaybackReady?.()
                  startFullDownload()
                  // Front index is local and the player can start — now it is
                  // safe to pre-warm the end/middle without stealing startup
                  // bandwidth.
                  startTailMidPrefetch()
                }).catch(err => {
                  console.log('[API] Head prefetch error (blobs):', err?.message)
                  logBlobDownloadDiagnostics('startup-head-download-error', core, startBlock, headEnd)
                  if (headTimeout) clearTimeout(headTimeout)
                  startFullDownload()
                  startTailMidPrefetch()
                })
              } else {
                startFullDownload()
                startTailMidPrefetch()
              }
            }

            startInitPrefetch()
          } else if (videoStats) {
            // Keep stats fresh for cached videos so upload speeds can update.
            videoStats.emitStats(driveKey, videoPath, true) // force=true for cached videos
            // Clean up any stale download intent and register as seed (video is already fully cached)
            deleteDownloadIntent(ctx, driveKey, videoPath).catch(() => {})
            if (seedingManager) {
              seedingManager.addSeed(driveKey, videoPath, 'watched', {
                blockLength: totalBlocks,
                byteLength: totalBytes,
                publicBeeKey: publicBeeKey || v?.publicBeeKey || null,
                blobId: blobMeta.blobId,
                blobsCoreKey: blobMeta.blobsCoreKey,
                thumbnailBlobId: v?.thumbnailBlobId || null,
                thumbnailBlobsCoreKey: v?.thumbnailBlobsCoreKey || null,
                mimeType: v?.mimeType || existingIntent?.mimeType || null,
                thumbnailMimeType: v?.thumbnailMimeType || null
              }, { protectSelf: true, protectedKeys: getActiveRangeSeedKeys() })
                .catch(() => {})
                .finally(releaseProtectedPrefetchBlobRef)
            } else {
              releaseProtectedPrefetchBlobRef()
            }
          }

          if (wasCached && !videoStats) {
            releaseProtectedPrefetchBlobRef()
          }
          await playbackReady

          return {
            success: true,
            totalBlocks,
            totalBytes,
            peerCount: core.peers?.length || 0,
            initialBlocks: initialAvailable,
            cached: wasCached,
            message: wasCached ? 'Video already fully cached' : 'Prefetch started'
          }
        }

        return { success: false, error: 'Video missing blob metadata' }
      } catch (err) {
        console.error('[API] Prefetch error:', err.message);
        if (videoStats) {
          videoStats.updateStats(driveKey, videoPath, { status: 'error', error: err.message });
          videoStats.cleanupMonitor(driveKey, videoPath);
        }
        releaseProtectedPrefetchBlobRef()
        activeRangeRequests.delete(prefetchKey)
        return { success: false, error: err.message };
      }
      })()

      prefetchInFlight.set(prefetchKey, prefetchPromise)
      try {
        return await prefetchPromise
      } finally {
        prefetchInFlight.delete(prefetchKey)
      }
    },

    /**
     * Prefetch next videos in a channel for smooth playback.
     * Called when a video starts playing to preload upcoming content.
     *
     * @param {string} channelKey - Channel key
     * @param {string} currentVideoId - Current video ID being watched
     * @param {number} [count=3] - Number of next videos to prefetch
     * @returns {Promise<{success: boolean, prefetchedCount?: number, error?: string}>}
     */
    async prefetchNextVideos(channelKey, currentVideoId, count = 3) {
      console.log('[API] prefetchNextVideos: channel:', channelKey?.slice(0, 16), 'current:', currentVideoId, 'count:', count)

      try {
        // Get list of videos for this channel. listVideos returns the
        // normalized video array directly.
        const videos = await this.listVideos(channelKey)

        if (videos.length === 0) {
          console.log('[API] prefetchNextVideos: no videos found')
          return { success: true, prefetchedCount: 0 }
        }

        // Find current video index
        const currentIndex = videos.findIndex(v =>
          v.id === currentVideoId ||
          v.videoId === currentVideoId ||
          v.path?.includes(currentVideoId)
        )

        if (currentIndex === -1) {
          console.log('[API] prefetchNextVideos: current video not found in list')
          // Fall back to prefetching first N videos
          const toPreload = videos.slice(0, count)
          for (const video of toPreload) {
            const videoRef = video.id || video.videoId || video.path
            // Fire and forget - don't wait for each prefetch
            this.prefetchVideo(channelKey, videoRef).catch(() => {})
          }
          return { success: true, prefetchedCount: toPreload.length }
        }

        // Get next N videos after current
        const nextVideos = videos.slice(currentIndex + 1, currentIndex + 1 + count)
        console.log('[API] prefetchNextVideos: found', nextVideos.length, 'videos to prefetch')

        // Start prefetching in background (fire and forget)
        let prefetchedCount = 0
        for (const video of nextVideos) {
          const videoRef = video.id || video.videoId || video.path
          console.log('[API] prefetchNextVideos: starting prefetch for:', videoRef)
          // Don't await - run in background
          this.prefetchVideo(channelKey, videoRef).catch(err => {
            console.log('[API] prefetchNextVideos: prefetch error for', videoRef, ':', err?.message)
          })
          prefetchedCount++
        }

        return { success: true, prefetchedCount }
      } catch (err) {
        console.error('[API] prefetchNextVideos error:', err.message)
        return { success: false, prefetchedCount: 0, error: err.message }
      }
    },

    /**
     * Get video stats
     * @param {string} driveKey
     * @param {string} videoPath
     * @returns {Object}
     */
    getVideoStats(driveKey, videoPath) {
      const videoPeerDetails = getVideoCorePeerDetails(driveKey, videoPath);
      const videoPeerCount = videoPeerDetails.peerCount;
      if (videoStats) {
        const stats = videoStats.getStats(driveKey, videoPath);
        if (stats) {
          stats.swarmConnections = ctx.swarm?.connections?.size || 0;
          stats.peerCount = videoPeerCount || stats.peerCount || 0;
          stats.blobPeerIds = videoPeerDetails.blobPeerIds;
          stats.blobCoreKey = videoPeerDetails.blobCoreKey;
          return stats;
        }
      }

      return {
        status: 'unknown',
        progress: 0,
        totalBlocks: 0,
        downloadedBlocks: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        peerCount: videoPeerCount,
        blobPeerIds: videoPeerDetails.blobPeerIds,
        blobCoreKey: videoPeerDetails.blobCoreKey,
        swarmConnections: ctx.swarm?.connections?.size || 0,
        speedMBps: '0',
        elapsed: 0,
        isComplete: false
      };
    },

    /**
     * Check if a video blob is fully synced (all blocks locally available)
     * @param {string} blobUrl - Full blob server URL
     * @returns {Promise<{isComplete: boolean, progress: number, availableBlocks: number, totalBlocks: number, byteLength: number}>}
     */
    async checkVideoSync(blobUrl) {
      console.log('[API] CHECK_VIDEO_SYNC:', blobUrl?.slice(0, 180));
      try {
        const parsed = new URL(blobUrl);
        const keyParam = parsed.searchParams.get('key');
        const blobParam = parsed.searchParams.get('blob');
        
        console.log('[API] CHECK_VIDEO_SYNC: key param:', keyParam?.slice(0, 16), 'blob param:', blobParam?.slice(0, 30));

        if (!keyParam) {
          console.log('[API] CHECK_VIDEO_SYNC: missing key param, all params:', Array.from(parsed.searchParams.keys()).join(', '));
          // If video is cached in UI, assume it's complete (can't check without key)
          return { isComplete: true, progress: 100, availableBlocks: 0, totalBlocks: 0, byteLength: 0, assumed: true };
        }

        // Parse blob ID - BlobServer uses z32-encoded compact-encoding format
        // blobId codec matches hypercore-blob-server's format
        const blobIdCodec = {
          preencode(state, b) {
            c.uint.preencode(state, b.blockOffset)
            c.uint.preencode(state, b.blockLength)
            c.uint.preencode(state, b.byteOffset)
            c.uint.preencode(state, b.byteLength)
          },
          encode(state, b) {
            c.uint.encode(state, b.blockOffset)
            c.uint.encode(state, b.blockLength)
            c.uint.encode(state, b.byteOffset)
            c.uint.encode(state, b.byteLength)
          },
          decode(state) {
            return {
              blockOffset: c.uint.decode(state),
              blockLength: c.uint.decode(state),
              byteOffset: c.uint.decode(state),
              byteLength: c.uint.decode(state)
            }
          }
        };

        let blob = null;
        if (blobParam) {
          try {
            // Decode z32-encoded blob ID
            const decoded = z32.decode(blobParam);
            blob = c.decode(blobIdCodec, decoded);
            console.log('[API] CHECK_VIDEO_SYNC: decoded blob:', JSON.stringify(blob));
          } catch (decodeErr) {
            console.log('[API] CHECK_VIDEO_SYNC: blob decode failed:', decodeErr?.message);
          }
        }

        if (!blob) {
          console.log('[API] CHECK_VIDEO_SYNC: missing or invalid blob param, all params:', Array.from(parsed.searchParams.keys()).join(', '));
          // If video is cached in UI, assume it's complete (can't check without blob info)
          return { isComplete: true, progress: 100, availableBlocks: 0, totalBlocks: 0, byteLength: 0, assumed: true };
        }

        // Load the blobs core - key is HypercoreID encoded (z32-based), not hex
        let keyBuffer;
        try {
          keyBuffer = HypercoreID.decode(keyParam);
          console.log('[API] CHECK_VIDEO_SYNC: decoded key buffer length:', keyBuffer.length);
        } catch (keyErr) {
          console.log('[API] CHECK_VIDEO_SYNC: key decode failed:', keyErr?.message);
          return { isComplete: true, progress: 100, availableBlocks: 0, totalBlocks: 0, byteLength: 0, assumed: true };
        }

        const blobsCore = ctx.store.get(keyBuffer);
        await blobsCore.ready();

        // Debug: check core state
        console.log('[API] CHECK_VIDEO_SYNC: core ready, length:', blobsCore.length, 'contiguousLength:', blobsCore.contiguousLength);

        // Check how many blocks are locally available
        const startBlock = blob.blockOffset;
        const endBlock = blob.blockOffset + blob.blockLength;
        const totalBlocks = blob.blockLength;
        
        console.log('[API] CHECK_VIDEO_SYNC: checking blocks', startBlock, 'to', endBlock, '(', totalBlocks, 'total)');

        // Quick check: if core.contiguousLength >= endBlock, all blocks are available
        if (blobsCore.contiguousLength >= endBlock) {
          console.log('[API] CHECK_VIDEO_SYNC: contiguousLength covers all blocks - COMPLETE');
          return {
            isComplete: true,
            progress: 100,
            availableBlocks: totalBlocks,
            totalBlocks,
            byteLength: blob.byteLength,
            // Return blob info for direct Hypercore access (HypercoreIOReader)
            blobInfo: blob,
            blobsCoreKey: keyBuffer.toString('hex')
          };
        }

        // IMPORTANT: In Hypercore v10+, has() is async!
        // For large videos, check a sample of blocks instead of all
        let availableBlocks = 0;
        const sampleSize = Math.min(totalBlocks, 20); // Check up to 20 blocks for speed
        const step = Math.max(1, Math.floor(totalBlocks / sampleSize));
        
        for (let i = startBlock; i < endBlock; i += step) {
          try {
            const hasBlock = await blobsCore.has(i);
            if (hasBlock) {
              availableBlocks++;
            }
          } catch (e) {
            console.log('[API] CHECK_VIDEO_SYNC: has() error at block', i, ':', e?.message);
          }
        }

        // Extrapolate from sample
        const sampledBlocks = Math.ceil((endBlock - startBlock) / step);
        const allSampledAvailable = availableBlocks >= sampledBlocks; // All sampled blocks available
        const progress = sampledBlocks > 0 ? Math.round((availableBlocks / sampledBlocks) * 100) : 0;

        // IMPORTANT: Sampling can give false positives!
        // Even if all sampled blocks are available, the video may not be complete
        // because we only check every Nth block. For true completion, contiguousLength must cover all blocks.
        // Only mark as complete if BOTH conditions are met:
        // 1. All sampled blocks are available (sample check passed)
        // 2. Core's contiguousLength is at least at startBlock (data is contiguous from beginning)
        //    AND contiguousLength is close to endBlock (within reasonable margin)
        const contiguousCoversStart = blobsCore.contiguousLength >= startBlock;
        const contiguousNearEnd = blobsCore.contiguousLength >= endBlock - Math.min(100, totalBlocks * 0.01);
        const isComplete = allSampledAvailable && contiguousCoversStart && contiguousNearEnd;

        console.log('[API] CHECK_VIDEO_SYNC: sampled', availableBlocks, '/', sampledBlocks, 'blocks (' + progress + '%)',
          'contiguous:', blobsCore.contiguousLength, 'need:', endBlock,
          isComplete ? 'COMPLETE' : 'INCOMPLETE');

        return {
          isComplete,
          progress,
          availableBlocks,
          totalBlocks,
          byteLength: blob.byteLength,
          // Return blob info for direct Hypercore access (HypercoreIOReader)
          blobInfo: blob,
          // Return hex-encoded key (not z32) for store.get(Buffer.from(key, 'hex'))
          blobsCoreKey: keyBuffer.toString('hex')
        };
      } catch (err) {
        console.error('[API] CHECK_VIDEO_SYNC error:', err?.message);
        return { isComplete: false, progress: 0, availableBlocks: 0, totalBlocks: 0, byteLength: 0, error: err?.message };
      }
    },

    // ============================================
    // Seeding Operations
    // ============================================

    /**
     * Get seeding status
     * @returns {Promise<Object>}
     */
    async getSeedingStatus() {
      if (seedingManager) {
        return seedingManager.getStatus();
      }
      return { error: 'Seeding manager not initialized' };
    },

    // ============================================
    // Transcode Settings
    // ============================================

    /**
     * Get transcoder settings for troubleshooting
     * @returns {Promise<{ settings: { videoToolboxDecodeEnabled: boolean, videoToolboxDecodeLocked: boolean, videoToolboxDecodeDefault: boolean, videoToolboxDecodeSource: string, videoToolboxHwMapEnabled: boolean, videoToolboxHwMapLocked: boolean, videoToolboxHwMapDefault: boolean, videoToolboxHwMapSource: string } }>}
     */
    async getTranscodeSettings() {
      return { settings: getVideoToolboxDecodeSettings() };
    },

    /**
     * Update transcoder settings for troubleshooting
     * @param {Object} req
     * @param {boolean} [req.videoToolboxDecodeEnabled]
     * @param {boolean} [req.videoToolboxHwMapEnabled]
     * @returns {Promise<{ success: boolean, error?: string, settings: object }>}
     */
    async setTranscodeSettings(req) {
      const decodeEnabled = req?.videoToolboxDecodeEnabled;
      const hwMapEnabled = req?.videoToolboxHwMapEnabled;
      const hasDecode = typeof decodeEnabled === 'boolean';
      const hasHwMap = typeof hwMapEnabled === 'boolean';
      if (!hasDecode && !hasHwMap) {
        return { success: false, error: 'Invalid request', settings: getVideoToolboxDecodeSettings() };
      }

      let settings = getVideoToolboxDecodeSettings();
      if (hasDecode) settings = setVideoToolboxDecodeEnabled(decodeEnabled, 'ui');
      if (hasHwMap) settings = setVideoToolboxHwMapEnabled(hwMapEnabled, 'ui');

      if (hasDecode && settings.videoToolboxDecodeLocked) {
        return { success: false, error: 'Locked by PEARTUBE_ENABLE_VT_DECODE', settings };
      }
      if (hasHwMap && settings.videoToolboxHwMapLocked) {
        return { success: false, error: 'Locked by PEARTUBE_ENABLE_VT_HWMAP', settings };
      }

      try {
        await ctx.metaDb.put('transcode-settings', {
          videoToolboxDecodeEnabled: settings.videoToolboxDecodeEnabled,
          videoToolboxHwMapEnabled: settings.videoToolboxHwMapEnabled
        });
      } catch (err) {
        console.log('[API] Failed to persist transcode settings:', err?.message);
      }

      return { success: true, settings };
    },

    /**
     * Set seeding config
     * @param {Object} config
     * @returns {Promise<Object>}
     */
    async setSeedingConfig(config) {
      if (seedingManager) {
        await seedingManager.setConfig(config);
        return { success: true, config: seedingManager.config };
      }
      return { success: false, error: 'Seeding manager not initialized' };
    },

    /**
     * Pin a channel
     * @param {string} driveKey
     * @returns {Promise<Object>}
     */
    async pinChannel(driveKey) {
      console.log('[API] PIN_CHANNEL:', driveKey?.slice(0, 16));
      if (seedingManager && driveKey) {
        try {
          await seedingManager.pinChannel(driveKey);
        } catch (err) {
          if (isSeedingAuthorizationError(err)) return { success: false, error: err.message };
          throw err;
        }
        await loadChannel(ctx, driveKey);
        return { success: true };
      }
      return { success: false, error: 'Invalid request' };
    },

    /**
     * Unpin a channel
     * @param {string} driveKey
     * @returns {Promise<Object>}
     */
    async unpinChannel(driveKey) {
      console.log('[API] UNPIN_CHANNEL:', driveKey?.slice(0, 16));
      if (seedingManager && driveKey) {
        try {
          await seedingManager.unpinChannel(driveKey);
        } catch (err) {
          if (isSeedingAuthorizationError(err)) return { success: false, error: err.message };
          throw err;
        }
        return { success: true };
      }
      return { success: false, error: 'Invalid request' };
    },

    /**
     * Get pinned channels
     * @returns {{channels: string[]}}
     */
    getPinnedChannels() {
      if (seedingManager) {
        return { channels: seedingManager.getPinnedChannels() };
      }
      return { channels: [] };
    },

    // ============================================
    // Storage Management Operations
    // ============================================

    /**
     * Get storage stats for peer content
     * @returns {{ usedBytes: number, maxBytes: number, usedGB: string, maxGB: number, seedCount: number, pinnedCount: number }}
     */
    getStorageStats() {
      if (seedingManager) {
        return seedingManager.getStorageStats();
      }
      return {
        usedBytes: 0,
        maxBytes: 5 * 1024 * 1024 * 1024,
        usedGB: '0.00',
        maxGB: 5,
        seedCount: 0,
        pinnedCount: 0
      };
    },

    /**
     * Set storage limit in GB
     * @param {number} maxGB
     * @returns {Promise<{ success: boolean }>}
     */
    async setStorageLimit(maxGB) {
      console.log('[API] SET_STORAGE_LIMIT:', maxGB, 'GB');
      if (seedingManager) {
        await seedingManager.setMaxStorageGB(maxGB, { authorized: true });
        return { success: true };
      }
      return { success: false };
    },

    /**
     * Link a relay by its blind-peer mirror key. The device delegates its
     * uploads/livestreams to the relay (so they always have a peer) and treats
     * it as a durable offload anchor. Persisted so it survives restarts.
     * @returns {Promise<{ success: boolean, mirrorKey: string, label: string }>}
     */
    async addRelayLink(req = {}) {
      const mirrorKey = typeof req === 'string' ? req : req?.mirrorKey;
      const label = (req && typeof req === 'object') ? (req.label ?? null) : null;
      const record = await persistAddRelayLink(ctx.metaDb, { mirrorKey, label });
      console.log('[API] ADD_RELAY_LINK:', record.mirrorKey.slice(0, 16), record.label || '');
      // Apply live: delegate uploads to the relay and treat it as a durable anchor.
      try { ctx.blindPeering?.addMirrorKeys?.(record.mirrorKey); } catch (err) {
        console.warn('[API] addRelayLink live mirror apply failed:', err?.message || String(err));
      }
      if (!Array.isArray(ctx.trustedRelayKeys)) ctx.trustedRelayKeys = [];
      if (!ctx.trustedRelayKeys.includes(record.mirrorKey)) ctx.trustedRelayKeys.push(record.mirrorKey);
      try { seedingManager?.remirrorAllSeeds?.(); } catch (err) {
        console.warn('[API] addRelayLink remirror failed:', err?.message || String(err));
      }
      return { success: true, mirrorKey: record.mirrorKey, label: record.label || '' };
    },

    /**
     * Unlink a previously-linked relay. Removes it from the persisted list and
     * the durable-anchor set (the live mirror delegation clears on next start).
     * @returns {Promise<{ success: boolean }>}
     */
    async removeRelayLink(req = {}) {
      const mirrorKey = typeof req === 'string' ? req : req?.mirrorKey;
      const removed = await persistRemoveRelayLink(ctx.metaDb, mirrorKey);
      if (removed && Array.isArray(ctx.trustedRelayKeys)) {
        const key = String(mirrorKey || '').toLowerCase();
        ctx.trustedRelayKeys = ctx.trustedRelayKeys.filter((k) => k !== key);
      }
      return { success: Boolean(removed) };
    },

    /**
     * List the relays this device has linked.
     * @returns {Promise<{ links: Array<{ mirrorKey: string, label: string, addedAt: number }> }>}
     */
    async getRelayLinks() {
      const list = await loadRelayLinks(ctx.metaDb);
      return { links: list.map((link) => ({ mirrorKey: link.mirrorKey, label: link.label || '', addedAt: link.addedAt || 0 })) };
    },

    /**
     * Clear all cached peer content (non-pinned)
     * @returns {Promise<{ success: boolean, clearedBytes: number }>}
     */
    async clearCache() {
      console.log('[API] CLEAR_CACHE');
      // Stop live prefetch fills first: clearing blocks under an active linear
      // download immediately re-fetches them, and the clear/download race
      // thrashes storage. Cancelled ranges resolve done() with false, which
      // the completion handlers treat as cancellation.
      for (const [key, request] of Array.from(activeRangeRequests.entries())) {
        try { request.cancel?.() } catch { /* best effort */ }
        request.ranges?.forEach(r => { try { r?.destroy?.() } catch { /* best effort */ } })
        if (request.core) {
          try { request.core.off('download', request.onDownload) } catch { /* best effort */ }
          try { request.core.off('upload', request.onUpload) } catch { /* best effort */ }
        }
        activeRangeRequests.delete(key)
      }
      if (seedingManager) {
        const clearResult = await seedingManager.clearCache({ authorized: true });
        return { success: true, ...clearResult };
      }
      return { success: false, clearedBytes: 0 };
    },

    /**
     * Assess whether a video's local blob can be safely evicted from disk — i.e.
     * a FULL copy is provably held elsewhere right now. Read-only: never deletes.
     * Intended for the user's own uploaded videos (where the local copy is the
     * source), but safe for any video since eligibility requires a remote full
     * copy regardless.
     * @returns {Promise<{ eligible: boolean, fullCopyPeers: number, relayHasFullCopy: boolean, ownDeviceHasFullCopy: boolean, byteLength: number, blobsCoreKey: string | null, reason: string | null }>}
     */
    async assessUploadOffload(driveKey, videoPath) {
      const empty = {
        eligible: false, fullCopyPeers: 0, relayHasFullCopy: false,
        ownDeviceHasFullCopy: false, byteLength: 0, blobsCoreKey: null, reason: null
      }
      try {
        const v = await this.getVideoData(driveKey, videoPath).catch(() => null)
        const blobsCoreKey = normalizeBlobsCoreKey(v?.blobsCoreKey)
        const range = normalizeBlobRefInput(v?.blobId ?? v)
        if (!blobsCoreKey || !range) return { ...empty, reason: 'missing-blob-metadata' }

        const core = ctx.store.get(b4a.from(blobsCoreKey, 'hex'))
        try {
          await core.ready?.()
          const { fullCopyKeys, fullCopyAnonymous } = collectFullCopyPeers(getCorePeerObjects(core), range)
          const assessment = assessOffloadEligibility({
            fullCopyKeys,
            fullCopyAnonymous,
            relayKeys: getKnownDurableRelayKeys(),
            deviceKeys: await getOwnDeviceSwarmKeys(driveKey)
          })
          return {
            ...assessment,
            blobsCoreKey,
            byteLength: Math.max(0, Number(range.byteLength) || 0),
            reason: assessment.eligible ? null : 'not-durably-replicated'
          }
        } finally {
          // store.get() opened a fresh session; release it.
          try { await core.close?.() } catch { /* best effort */ }
        }
      } catch (err) {
        return { ...empty, reason: err?.message || 'assess-failed' }
      }
    },

    /**
     * Free a video's local blob bytes, keeping its metadata so it re-fetches on
     * demand. Refuses unless assessUploadOffload confirms a durable full copy
     * lives elsewhere (re-checked here) and no playback is active — clearing the
     * only copy of an under-replicated upload would lose it permanently.
     * @returns {Promise<{ success: boolean, freedBytes: number, reason: string | null, assessment: object }>}
     */
    async offloadUpload(driveKey, videoPath) {
      const assessment = await this.assessUploadOffload(driveKey, videoPath)
      if (!assessment.eligible) {
        return { success: false, freedBytes: 0, reason: assessment.reason || 'not-durably-replicated', assessment }
      }
      // Never evict while anything is being played/served — re-fetching mid-play
      // would stall, and the playing blob may be this one.
      if (storageIsPlaybackActive()) {
        return { success: false, freedBytes: 0, reason: 'playback-active', assessment }
      }
      const v = await this.getVideoData(driveKey, videoPath).catch(() => null)
      const cleared = seedingManager
        ? await seedingManager.clearSeedBlob({
            driveKey, videoPath, blobsCoreKey: assessment.blobsCoreKey, blobId: v?.blobId
          })
        : false
      if (cleared) {
        await collectCorestoreGarbage(ctx.store, { label: 'upload offload', log: console.log }).catch(() => {})
        console.log('[API] Offloaded upload (full copy seeded elsewhere):', videoPath)
      }
      return {
        success: Boolean(cleared),
        freedBytes: cleared ? assessment.byteLength : 0,
        reason: cleared ? null : 'clear-failed',
        assessment
      }
    },

    // ============================================
    // Status Operations
    // ============================================

    /**
     * Get backend status
     * @returns {Object}
     */
    getStatus() {
      return {
        connected: true,
        peers: ctx.swarm?.connections?.size || 0,
        blobServerPort: ctx.blobServer?.port || ctx.blobServerPort || 0,
        blobServerHost: ctx.blobServerHost || '127.0.0.1',
        version: '0.1.115'
      };
    },

    /**
     * Get swarm status for debugging
     * @returns {Object}
     */
    getSwarmStatus() {
      const topicHex = b4a.toString(crypto.data(b4a.from(NETWORK_TOPIC_STRING, 'utf-8')), 'hex')
      const networkDebug = getNetworkStats()
      const feedStats = publicFeed?.getStats?.() || {}
      // Report what the user can actually SEE. The raw entries map includes
      // hidden/filtered entries, so diagnostics (and the home screen's
      // discovery-state classifier) were fed counts that didn't match the
      // rendered feed.
      const visibleFeedEntries = (() => {
        try { return publicFeed?.getFeed?.()?.length ?? (publicFeed?.entries?.size || 0) } catch { return publicFeed?.entries?.size || 0 }
      })()
      const startupTiming = {
        storage: networkDebug?.startupTiming || null,
        publicFeed: feedStats.startupTiming || null,
      }
      const doctor = {
        dht: {
          bootstrapped: ctx.swarm?.dht?.bootstrapped ?? null,
          firewalled: ctx.swarm?.dht?.firewalled ?? null,
          online: ctx.swarm?.dht?.online ?? null,
          ephemeral: ctx.swarm?.dht?.ephemeral ?? null,
        },
        discovery: {
          peerPoolJoined: Boolean(ctx.peerPoolDiscovery),
          publicFeedDiscoveryJoined: Boolean(publicFeed?.feedDiscovery),
          discoveredPeers: feedStats.directPeerDial?.discoveredPeers || 0,
          recentPeers: networkDebug?.hyperswarm?.recentPeers || [],
        },
        socket: {
          swarmPeers: ctx.swarm?.peers?.size || 0,
          swarmConnections: ctx.swarm?.connections?.size || 0,
          connecting: Number(ctx.swarm?.connecting || 0),
          recentConnections: networkDebug?.hyperswarm?.recentConnections || [],
          peerStates: networkDebug?.hyperswarm?.peerStates || [],
        },
        feed: {
          feedConnections: publicFeed?.feedConnections?.size || 0,
          feedEntries: visibleFeedEntries,
          directPeerDial: feedStats.directPeerDial || null,
          lastHaveFeed: feedStats.lastHaveFeed || null,
        },
        playback: {
          lastPreparePlayback: recentPlaybackTimings[recentPlaybackTimings.length - 1] || null,
          recentPreparePlayback: recentPlaybackTimings.slice(-5),
        },
        recommendedBoundary: null,
      }
      if (doctor.discovery.discoveredPeers === 0 && doctor.dht.bootstrapped === false) doctor.recommendedBoundary = 'dht-bootstrap'
      else if (doctor.discovery.discoveredPeers > 0 && doctor.socket.swarmConnections === 0) doctor.recommendedBoundary = 'transport-socket'
      else if (doctor.socket.swarmConnections > 0 && doctor.feed.feedConnections === 0) doctor.recommendedBoundary = 'protomux-feed-open'
      else if (doctor.feed.feedConnections > 0 && doctor.feed.feedEntries === 0) doctor.recommendedBoundary = 'feed-gossip'
      else doctor.recommendedBoundary = 'content-playback-or-ui'
      return {
        swarmConnections: ctx.swarm?.connections?.size || 0,
        swarmPeers: ctx.swarm?.peers?.size || 0,
        feedConnections: publicFeed?.feedConnections?.size || 0,
        feedEntries: visibleFeedEntries,
        feedTopicHex: topicHex,
        network: networkDebug,
        startupTiming,
        doctor,
        swarmOffline: Boolean(ctx.swarm?._peartubeOffline),
        swarmOfflineReason: ctx.swarm?._peartubeOfflineReason || null,
        swarmListenResolved: Boolean(ctx.swarm?._peartubeListenResolved),
        peerPoolJoined: Boolean(ctx.peerPoolDiscovery),
        publicFeedDiscoveryJoined: Boolean(publicFeed?.feedDiscovery),
        swarmPublicKey: ctx.swarm?.keyPair?.publicKey
          ? b4a.toString(ctx.swarm.keyPair.publicKey, 'hex').slice(0, 32)
          : 'unknown',
        channelsLoaded: Math.max(ctx.channels?.size || 0, visibleFeedEntries),
      };
    }

    ,
    // ============================================
    // Multi-device pairing (Multi-writer channels)
    // ============================================

    /**
     * Create a device invite code for a multi-writer channel.
     * @param {string} channelKey
     * @returns {Promise<{inviteCode: string}>}
     */
    async createDeviceInvite(channelKey) {
      const channel = await loadChannel(ctx, channelKey)
      const inviteCode = await channel.createInvite({})
      return { inviteCode }
    },

    /**
     * Pair this device to an existing channel using an invite code.
     * @param {string} inviteCode
     * @param {string} [deviceName]
     * @returns {Promise<{success: boolean, channelKey: string, syncState?: string, videoCount?: number}>}
     */
    async pairDevice(inviteCode, deviceName = '') {
      const { channel, channelKeyHex } = await pairChannelDevice(ctx, inviteCode, { deviceName })

      // Use smart sync - waits for peer connection first, then polls for data
      console.log('[API] pairDevice: starting smart sync...')
      const syncResult = await channel.waitForInitialSync({
        peerTimeout: 30000,  // 30s for DHT discovery
        dataTimeout: 20000,  // 20s for data sync after connected
        onProgress: (state, detail) => {
          console.log('[API] pairDevice sync progress:', state, detail)
        }
      })

      console.log('[API] pairDevice: sync result:', syncResult)

      return {
        success: true,
        channelKey: channelKeyHex,
        syncState: syncResult.state,
        videoCount: syncResult.videoCount
      }
    },

    /**
     * Retry syncing a channel that may have failed initial sync.
     * @param {string} channelKey
     * @returns {Promise<{success: boolean, state: string, videoCount: number}>}
     */
    async retrySyncChannel(channelKey) {
      const channel = await loadChannel(ctx, channelKey)

      console.log('[API] retrySyncChannel: starting sync for', channelKey?.slice(0, 16))
      const result = await channel.waitForInitialSync({
        peerTimeout: 30000,
        dataTimeout: 20000,
        onProgress: (state, detail) => {
          console.log('[API] retrySyncChannel progress:', state, detail)
        }
      })

      return {
        success: result.success,
        state: result.state,
        videoCount: result.videoCount
      }
    },

    /**
     * List known devices/writers for a channel.
     * @param {string} channelKey
     * @returns {Promise<{devices: Array<{keyHex: string, role?: string, deviceName?: string, addedAt?: number, blobDriveKey?: string|null}>}>}
     */
    async listDevices(channelKey) {
      const channel = await loadChannel(ctx, channelKey)
      const devices = await channel.listWriters()
      return { devices }
    },

    // ============================================
    // Search Operations
    // ============================================

    /**
     * Search videos in a channel using semantic search
     * @param {string} channelKey
     * @param {string} query
     * @param {Object} [options]
     * @param {number} [options.topK=10]
     * @param {boolean} [options.federated=true]
     * @returns {Promise<Array<{id: string, score: number, metadata: any}>>}
     */
    async searchVideos(channelKey, query, options = {}) {
      const { topK = 10, federated = true } = options

      // Ensure semantic finder is initialized with persistence
      await ensureSemanticFinder(ctx)

      // Initialize federated search if not already done
      if (!ctx.federatedSearch && ctx.swarm) {
        ctx.federatedSearch = new FederatedSearch(ctx.swarm, ctx.semanticFinder)
        const channelKeyBuf = b4a.from(channelKey, 'hex')
        ctx.federatedSearch.setupTopic(channelKeyBuf)
      }

      // Use federated search if available, otherwise local only
      if (ctx.federatedSearch && federated) {
        return await ctx.federatedSearch.search(query, { topK, federated, timeout: 5000 })
      } else {
        return await ctx.semanticFinder.search(query, topK)
      }
    },

    /**
     * Global search across ALL discovered channels (YouTube-Fast)
     * Uses pre-built global index for O(1) search instead of iterating channels
     * @param {string} query - Search query
     * @param {Object} [options]
     * @param {number} [options.topK=50] - Max results to return
     * @returns {Promise<Array<{id: string, score: number, metadata: any}>>}
     */
    async globalSearchVideos(query, options = {}) {
      const { topK = 50 } = options

      console.log('[API] globalSearchVideos:', query, 'topK:', topK)

      // Ensure semantic finder is initialized with persistence
      const finder = await ensureSemanticFinder(ctx)

      // Best-effort: import replicated vectors from any loaded channels.
      if (ctx.channels && ctx.channels.size > 0) {
        (async () => {
          for (const [channelKey, channel] of ctx.channels.entries()) {
            try {
              await finder.ensureGlobalIndexedFromChannelView(channelKey, channel)
            } catch { /* best effort */ }
          }
        })()
      }

      // Fast global search - O(1) not O(channels)
      const results = await finder.globalSearch(query, topK)
      console.log('[API] globalSearchVideos: found', results.length, 'results in global index')

      // Validate/enrich results when cheap, but do not prune preview/direct-ref
      // entries just because PublicBee/channel hydration timed out. Search may
      // have a durable preview record while loadChannel/listVideos is currently
      // unproductive over P2P.
      const validated = []
      const staleIds = []
      for (const r of results) {
        const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {})
        const channelKey = meta.channelKey || meta.driveKey
        if (!channelKey) { validated.push(r); continue }
        const hasDirectRefs = Boolean(meta.blobId && meta.blobsCoreKey)
        const previewVideo = getPreviewVideoFromFeed(channelKey, r.id, meta.publicBeeKey)
        if (hasDirectRefs || previewVideo?.blobId) {
          validated.push({
            ...r,
            metadata: {
              ...meta,
              ...(previewVideo || {}),
              channelKey,
              publicBeeKey: meta.publicBeeKey || previewVideo?.publicBeeKey || null,
              blobId: meta.blobId || previewVideo?.blobId || null,
              blobsCoreKey: meta.blobsCoreKey || previewVideo?.blobsCoreKey || null,
            },
          })
          continue
        }
        try {
          const video = await this.getVideoData(channelKey, r.id, meta.publicBeeKey)
          if (video) { validated.push(r); continue }
        } catch { /* best effort */ }
        staleIds.push(r.id)
      }

      if (staleIds.length > 0) {
        console.log('[API] globalSearchVideos: pruning', staleIds.length, 'stale entries')
        for (const id of staleIds) {
          try { finder.removeVideo(id) } catch { /* best effort */ }
        }
      }

      return validated
    },

    /**
     * Index a video for semantic search (YouTube-Fast)
     * Uses global index with persistence for instant search
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{success: boolean}>}
     */
    async indexVideoVectors(channelKey, videoId) {
      try {
        const envelope = await buildSearchEnvelope(channelKey, videoId, { includeComments: true, includeSubtitles: true })
        if (!envelope) {
          return { success: false, error: 'Video not found' }
        }

        const finder = await ensureSemanticFinder(ctx)
        const needsMetadataRefresh =
          typeof finder.needsMetadataRefresh === 'function'
            ? finder.needsMetadataRefresh(envelope)
            : false

        if (finder.hasVideo(envelope.videoId) && !needsMetadataRefresh) {
          return { success: true, alreadyIndexed: true }
        }

        await finder.indexEnvelope(envelope, {
          channelKey,
          publicBeeKey: envelope.publicBeeKey || null,
        })

        const isMW = await isMultiWriterChannelKey(channelKey)
        if (isMW) {
          const channel = await loadChannel(ctx, channelKey)
          const text = envelope.searchText || `${envelope.title || ''} ${envelope.description || ''}`
          const embedding = await finder.embed(text)
          const vectorBase64 = b4a.toString(
            b4a.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
            'base64'
          )

          await channel.base.append({
            type: 'add-vector-index',
            schemaVersion: 1,
            videoId: envelope.videoId,
            vector: vectorBase64,
            text,
            metadata: JSON.stringify({
              channelKey,
              title: envelope.title,
              creatorName: envelope.creatorName || null,
              channelName: envelope.channelName || null,
              sources: envelope.sourceFields
            }),
            indexedAt: Date.now()
          })
        }

        return { success: true }
      } catch (err) {
        console.error('[API] indexVideoVectors error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ============================================
    // Comments Operations (HyperDB channel-backed)
    // ============================================

    /**
     * Compatibility helper retained for older API callers. Comments were folded
     * into the HyperDB multi-writer channel; the old separate CommentsAutobase
     * module no longer exists and must not be imported by mobile bundles.
     * @param {string} channelKey
     * @returns {Promise<import('./channel/multi-writer-channel.js').MultiWriterChannel>}
     */
    async _getCommentsAutobase(channelKey, publicBeeKey = null) {
      console.log('[API] _getCommentsAutobase compat: loading HyperDB channel:', channelKey?.slice(0, 16), 'publicBeeKey:', publicBeeKey?.slice(0, 16) || 'null')
      return loadChannelBounded(channelKey, 3000)
    },


    /**
     * Add a comment to a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} text
     * @param {string} [parentId]
     * @param {string} [publicBeeKey]
     * @returns {Promise<{success: boolean, commentId?: string, error?: string}>}
     */
    async addComment(channelKey, videoId, text, parentId = null, publicBeeKey = null) {
      // SYNC LOG - this should ALWAYS appear immediately
      console.log('[API] ====== addComment ENTERED ======')
      console.log('[API] addComment: channelKey:', channelKey?.slice(0, 16), 'videoId:', videoId?.slice(0, 16), 'publicBeeKey:', publicBeeKey?.slice(0, 16) || 'null')

      try {
        console.log('[API] addComment: loading HyperDB channel comments...')
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.comments) throw new Error('Comments not initialized')
        const result = await channel.comments.addComment(videoId, text, parentId)
        console.log('[API] addComment: comment added:', result.commentId?.slice(0, 8))
        await refreshSearchIndex(channelKey, videoId, { publicBeeKey })
        return { success: true, commentId: result.commentId, queued: false }
      } catch (err) {
        console.error('[API] addComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * List comments for a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {Object} [options]
     * @param {number} [options.page=0]
     * @param {number} [options.limit=50]
     * @param {string} [options.publicBeeKey]
     * @returns {Promise<{comments: Array, success: boolean, error?: string}>}
     */
    async listComments(channelKey, videoId, options = {}) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, options.publicBeeKey)
        if (!channel?.comments) throw new Error('Comments not initialized')
        const comments = await channel.comments.listComments(videoId, options)
        return { success: true, comments }
      } catch (err) {
        console.error('[API] listComments error:', err.message)
        return { success: false, comments: [], error: err.message }
      }
    },

    /**
     * Hide a comment (moderator action)
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} commentId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async hideComment(channelKey, videoId, commentId, publicBeeKey = null) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.comments) throw new Error('Comments not initialized')
        await channel.comments.hideComment(videoId, commentId)
        await refreshSearchIndex(channelKey, videoId, { publicBeeKey })
        return { success: true }
      } catch (err) {
        console.error('[API] hideComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Remove a comment (moderator or author)
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} commentId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async removeComment(channelKey, videoId, commentId, publicBeeKey = null) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.comments) throw new Error('Comments not initialized')
        await channel.comments.removeComment(videoId, commentId)
        await refreshSearchIndex(channelKey, videoId, { publicBeeKey })
        return { success: true }
      } catch (err) {
        console.error('[API] removeComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ============================================
    // Reactions Operations (HyperDB channel-backed)
    // ============================================

    /**
     * Add a reaction to a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} reactionType
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async addReaction(channelKey, videoId, reactionType, publicBeeKey = null) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.reactions) throw new Error('Reactions not initialized')
        await channel.reactions.addReaction(videoId, reactionType)
        return { success: true }
      } catch (err) {
        console.error('[API] addReaction error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Remove a reaction from a video
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async removeReaction(channelKey, videoId, publicBeeKey = null) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.reactions) throw new Error('Reactions not initialized')
        await channel.reactions.removeReaction(videoId)
        return { success: true }
      } catch (err) {
        console.error('[API] removeReaction error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Get reactions for a video
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{counts: Record<string, number>, userReaction: string|null, success: boolean, error?: string}>}
     */
    async getReactions(channelKey, videoId, publicBeeKey = null) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.reactions) throw new Error('Reactions not initialized')
        const result = await channel.reactions.getReactions(videoId)
        return { success: true, counts: result.counts || {}, userReaction: result.userReaction || null }
      } catch (err) {
        console.error('[API] getReactions error:', err.message)
        return { success: false, counts: {}, userReaction: null, error: err.message }
      }
    },

    /**
     * Get debug info about the comments system for a channel
     * @param {string} channelKey
     * @param {string} [publicBeeKey]
     * @returns {Promise<Object>}
     */
    async getCommentsDebugInfo(channelKey, publicBeeKey = null) {
      const debugInfo = {
        success: false,
        // Connection
        swarmPeers: ctx.swarm?.connections?.size || 0,
        commentsConnected: false,

        // CommentsAutobase
        commentsAutobaseKey: null,
        isWriter: false,
        isChannelOwner: false,
        localWriterKey: null,

        // Channel info
        channelKey: channelKey?.slice(0, 16) || null,
        publicBeeKey: publicBeeKey?.slice(0, 16) || null,
        hasPublicBee: false,
        publicBeeHasCommentsKey: false,

        // Data
        viewLength: 0,

        // Errors
        lastError: null
      }

      try {
        // Try to load channel first
        let channel = null
        try {
          channel = await loadChannelBounded(channelKey, 3000)
          debugInfo.hasChannel = true
          debugInfo.channelWritable = channel.writable

          // Check if channel has PublicBee
          if (channel.publicBee) {
            debugInfo.hasPublicBee = true
            const pubMeta = await channel.publicBee.getMetadata().catch(() => ({}))
            debugInfo.publicBeeHasCommentsKey = Boolean(pubMeta?.commentsDbKey || pubMeta?.commentsAutobaseKey)
          }

          if (channel.comments) {
            debugInfo.commentsAutobaseKey = channel.keyHex?.slice(0, 16) || channelKey?.slice(0, 16) || null
            debugInfo.isWriter = channel.writable || false
            debugInfo.isChannelOwner = Boolean(channel.writable)
            debugInfo.localWriterKey = channel.localWriterKeyHex?.slice(0, 16) || null
            debugInfo.viewLength = channel.core?.length || channel.db?.core?.length || 0
            debugInfo.commentsConnected = true
            debugInfo.success = true
            return debugInfo
          }
        } catch (err) {
          debugInfo.channelError = err?.message
        }

        throw new Error('Comments not initialized')
      } catch (err) {
        debugInfo.lastError = err?.message || 'Unknown error'
      }

      return debugInfo
    },

    // ============================================
    // Recommendations Operations
    // ============================================

    /**
     * Log a watch event for recommendations
     * @param {string} channelKey
     * @param {string} videoId
     * @param {Object} [options]
     * @param {number} [options.duration]
     * @param {boolean} [options.completed]
     * @param {boolean} [options.share=false]
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async logWatchEvent(channelKey, videoId, options = {}) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, error: 'Watch events only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.watchLogger) {
          return { success: false, error: 'Watch logger not initialized' }
        }

        await channel.watchLogger.logWatchEvent(videoId, options)
        return { success: true }
      } catch (err) {
        console.error('[API] logWatchEvent error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Get video recommendations
     * @param {string} channelKey
     * @param {Object} [options]
     * @param {number} [options.limit=10]
     * @param {string[]} [options.excludeVideoIds]
     * @returns {Promise<{recommendations: Array, success: boolean, error?: string}>}
     */
    async getRecommendations(channelKey, options = {}) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, recommendations: [], error: 'Recommendations only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.watchLogger) {
          return { success: false, recommendations: [], error: 'Watch logger not initialized' }
        }

        // Ensure semantic finder is initialized with persistence
        await ensureSemanticFinder(ctx)

        // Initialize recommender
        const recommender = new Recommender(channel, ctx.semanticFinder, channel.watchLogger)
        const recommendations = await recommender.generateRecommendations(options)

        return { success: true, recommendations }
      } catch (err) {
        console.error('[API] getRecommendations error:', err.message)
        return { success: false, recommendations: [], error: err.message }
      }
    },

    /**
     * Get recommendations for a specific video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {number} [limit=5]
     * @returns {Promise<{recommendations: Array, success: boolean, error?: string}>}
     */
    async getVideoRecommendations(channelKey, videoId, limit = 5) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, recommendations: [], error: 'Recommendations only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)

        // Ensure semantic finder is initialized with persistence
        await ensureSemanticFinder(ctx)

        // Initialize recommender (watch logger may be null, that's ok)
        const watchLogger = channel.watchLogger || null
        const recommender = new Recommender(channel, ctx.semanticFinder, watchLogger)
        const recommendations = await recommender.getVideoRecommendations(videoId, limit)

        return { success: true, recommendations }
      } catch (err) {
        console.error('[API] getVideoRecommendations error:', err.message)
        return { success: false, recommendations: [], error: err.message }
      }
    },

    // ============================================
    // Network Lifecycle Management
    // ============================================

    /**
     * Suspend networking for mobile background state.
     * Call this when the app goes to background to save battery.
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async suspendNetwork() {
      try {
        await suspendNetworking()
        return { success: true }
      } catch (err) {
        console.error('[API] suspendNetwork error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Resume networking when app returns to foreground.
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async resumeNetwork() {
      try {
        await resumeNetworking()
        return { success: true }
      } catch (err) {
        console.error('[API] resumeNetwork error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Mirror app playback state into the backend so cache cleanup does not
     * clear blob ranges while a player or blob-server reader is active.
     * @param {{active?: boolean, ttlMs?: number}} [options]
     * @returns {{success: boolean, active: boolean, updatedAt: number, expiresAt: number}}
     */
    setPlaybackActive(options = {}) {
      const state = storageSetPlaybackActive(Boolean(options.active), { ttlMs: options.ttlMs })
      // Flush deferred cache eviction when playback ends. enforceQuota() skips
      // every clear while playback is active (isCacheClearBlocked), and its only
      // other trigger — addSeed — fires *during* playback, so the over-quota
      // evictions get deferred and nothing ever re-runs them. Without this hook
      // the seed cache grows unbounded past maxStorageGB.
      //
      // The sweep is debounced and cancelled the moment playback resumes, so
      // rapid open/close, seeking, and pause/resume never trigger eviction.
      if (state.active) {
        cancelScheduledQuotaSweep()
      } else {
        scheduleQuotaSweepAfterPlayback()
      }
      return { success: true, ...state }
    },

    /**
     * Get network stats for debugging.
     * @returns {{stats: Object|null, readable: string}}
     */
    getNetworkDebugStats() {
      return {
        stats: getNetworkStats(),
        readable: getNetworkStatsReadable()
      }
    }
  };
}
