import b4a from 'b4a';
import hypercoreWants from 'hypercore/lib/wants.js';
/**
 * Core API Module - Shared backend API methods
 *
 * These methods are used by both mobile and desktop backends.
 * They operate on the storage context and return results.
 */

import HypercoreID from 'hypercore-id-encoding';
import z32 from 'z32';
import c from 'compact-encoding';
import { getVideoUrlFromBlob, loadChannel as storageLoadChannel, loadPublicBee as storageLoadPublicBee, pairDevice as pairChannelDevice, isPlaybackActive as storageIsPlaybackActive, retainSwarmDiscovery } from './storage.js';
import { createBlobPlaybackService } from './blob-playback-service.js';
import { subscribeBlobPlayhead } from './blob-range-priority.js';
import { beginPlaybackTiming, markPlaybackTiming } from './playback-timing.js';
import { SemanticFinder } from './search/semantic-finder.js';
import { buildMetadataEnvelope } from './search/metadata-envelope.js';
import { buildBlobRefCacheKey, normalizeBlobsCoreKey, normalizeBlobRefInput, parseBlobRef, stringifyBlobId } from './blob-ref.js';
import { redactCapabilityUrl } from './capability-url.js'
import { encodeIndexKey } from './index-encoder.js'
import { SeedingAuthorizationError, fullDownloadFitsQuota } from './seeding.js'
import { collectCorestoreGarbage } from './corestore-gc.js'
import { peerHasFullRange } from './upload-offload.js'
import {
  canonicalizeDurabilityRefs,
  evaluateDurabilityPolicy
} from './durability/aggregate-assessment.js'
import {
  compareSignedChannelRootDescriptors,
  verifySignedChannelRootDescriptor
} from './channel-descriptor.js'
import { createCommentsApi } from './api/comments.js'
import { createPersonalApi } from './api/personal.js'
import { createTranscodeApi } from './api/transcode.js'
import { createSearchApi } from './api/search.js'
import { createPairingApi } from './api/pairing.js'
import { createSeedingApi } from './api/seeding.js'
import { createRecommendationsApi } from './api/recommendations.js'
import { createSubscriptionsApi } from './api/subscriptions.js'
import { createLiveApi } from './api/live.js'
import { createStatusApi } from './api/status.js'
import { createNetworkLifecycleApi } from './api/network-lifecycle.js'
import { createPublisherApi } from './api/publisher.js'
import { createArchiveParticipationApi } from './api/archive-participation.js'
import { createMediaGraphApi } from './api/media-graph.js'
import { createPolicyApi } from './api/policy.js'
import { createOperabilityApi } from './api/operability.js'
import { createScopedNetworkApi } from './network/scoped-runtime.js'
import { createArchiveManager } from './archive/manager.js'
import { buildCatalogGroupPage, buildChannelCatalog } from './catalog/channel-catalog.js'
import { normalizeAssetCoreRefV2 } from './assets/rendition.js'
import { createStaticAssetManifest } from './assets/static-core.js'

function assertApiContextRunning(ctx) {
  if (ctx?.lifecycle?.signal?.aborted) throw new Error('Backend is shutting down')
}

function ownApiResource(ctx, label, resource, methods, timeoutMs) {
  const ownership = typeof ctx?.ownResource === 'function'
    ? ctx.ownResource(label, resource, methods, timeoutMs)
    : ctx?.lifecycle?.ownResource?.(label, resource, methods, timeoutMs)
  if (ownership) return ownership
  const candidates = Array.isArray(methods) ? methods : [methods]
  let cleanupPromise = null
  return {
    release() {},
    cleanup() {
      if (cleanupPromise) return cleanupPromise
      cleanupPromise = (async () => {
        for (const method of candidates) {
          if (typeof resource?.[method] !== 'function') continue
          await resource[method]()
          return
        }
      })()
      return cleanupPromise
    },
  }
}

const CATALOG_PROFILE_FIELDS = Object.freeze([
  'name',
  'description',
  'profileKind',
  'mediaProvider',
  'mediaId',
  'originalLanguage',
  'releaseDate',
  'releaseYear',
  'createdAt',
  'updatedAt',
])
const CATALOG_SOURCE_FIELDS = Object.freeze([
  'provider',
  'identityKey',
  'sourceId',
  'identityUrl',
  'handle',
  'displayName',
])
const CATALOG_ARTWORK_FIELDS = Object.freeze([
  'role',
  'blobId',
  'blobsCoreKey',
  'mimeType',
  'remoteUrl',
])
const CATALOG_ITEM_FIELDS = Object.freeze([
  'id',
  'title',
  'description',
  'contentKind',
  'sourceProvider',
  'sourceVideoId',
  'identityUrl',
  'sourceCreatorId',
  'sourceCreatorUrl',
  'sourcePublishedAt',
  'mediaProvider',
  'mediaId',
  'seasonNumber',
  'episodeNumber',
  'originalAirDate',
  'duration',
  'uploadedAt',
  'blobId',
  'blobsCoreKey',
  'mimeType',
  'thumbnailUrl',
  'thumbnailBlobId',
  'thumbnailBlobsCoreKey',
  'thumbnailMimeType',
  'provenanceVersion',
  'contentFingerprint',
  'publicationState',
])
const CATALOG_ERROR_CODES = new Set([
  'INVALID_CURSOR',
  'INVALID_LIMIT',
  'INVALID_CATALOG_INPUT',
  'UNKNOWN_CATALOG_GROUP',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_MISMATCH',
  'CATALOG_UNAVAILABLE',
])
const CATALOG_PUBLIC_READ_TIMEOUT_MS = 1200
const CATALOG_REQUEST_READ_TIMEOUT_MS = 3500
const MAX_CATALOG_CHANNEL_SOURCES = 64
const MAX_CATALOG_CHANNEL_ARTWORK = 16

function snapshotCatalogRecord(record, fields) {
  if (record === undefined || record === null) return {}
  if (typeof record !== 'object' || Array.isArray(record)) return record
  const snapshot = {}
  for (const field of fields) {
    const value = record[field]
    if (value !== undefined && value !== null) snapshot[field] = value
  }
  return snapshot
}

function snapshotCatalogRecords(records, fields) {
  if (records === undefined || records === null) return []
  if (!Array.isArray(records)) return records
  const snapshots = new Array(records.length)
  for (let index = 0; index < records.length; index++) {
    snapshots[index] = snapshotCatalogRecord(records[index], fields)
  }
  return snapshots
}

function isCatalogStorageKey(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function isCatalogKey(value) {
  if (typeof value !== 'string' || value.length === 0 || b4a.byteLength(value) > 256) return false
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++index >= value.length) return false
      const low = value.charCodeAt(index)
      if (low < 0xdc00 || low > 0xdfff) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

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

const MAX_DURABILITY_REFS = 256
const MAX_DURABILITY_PEERS_PER_CORE = 1024
const MAX_DURABILITY_BITFIELD_REFRESHES = 2048
const DEFAULT_DURABILITY_BITFIELD_REFRESH_TIMEOUT_MS = 250
const MAX_DURABILITY_BITFIELD_REFRESH_TIMEOUT_MS = 5_000
const MAX_DURABILITY_BITFIELD_REFRESH_DEADLINE_MS = 5_000
const MIN_DURABILITY_WANT_PROBE = 32
const MAX_CONCURRENT_DURABILITY_REFRESHES = 16
const durabilityAvailabilityRefreshes = new WeakMap()

function failClosedDurabilityAssessment(error = null) {
  return {
    eligible: false,
    trusted: [],
    paired: [],
    ordinary: [],
    status: error === null ? 'ok' : 'error',
    error
  }
}

function completedDurabilityAssessment(assessment) {
  return { ...assessment, status: 'ok', error: null }
}

function durabilityErrorMessage(error) {
  return error?.message || String(error || 'assess-failed')
}

function authenticatedPeerKeyHex(peer) {
  const key = peer?.remotePublicKey
  const isBytes =
    key instanceof Uint8Array ||
    (typeof b4a.isBuffer === 'function' && b4a.isBuffer(key))
  if (!isBytes || key.byteLength !== 32) return null
  return b4a.toString(key, 'hex')
}

function peerBitfieldHasFullRange(peer, start, end) {
  const firstUnset = peer?.remoteBitfield?.firstUnset
  if (typeof firstUnset !== 'function') return false
  const missing = firstUnset.call(peer.remoteBitfield, start)
  return Number.isSafeInteger(missing) && missing >= end
}

function peerBitfieldHasBatchRefs(peer, refs, batchStart, batchEnd) {
  for (const ref of refs) {
    const start = Math.max(ref.start, batchStart)
    const end = Math.min(ref.end, batchEnd)
    if (start < end && !peerBitfieldHasFullRange(peer, start, end)) return false
  }
  return true
}

function peerHasRefAvailability(peer, ref, refreshEvidence) {
  if (peerBitfieldHasFullRange(peer, ref.start, ref.end)) return true
  const batchLength = refreshEvidence?.batchLength
  const rangeBatches = refreshEvidence?.rangeBatches?.get(peer)
  if (!Number.isSafeInteger(batchLength) || !rangeBatches) return false
  let batchStart = Math.floor(ref.start / batchLength) * batchLength
  while (batchStart < ref.end) {
    const batchEnd = batchStart + batchLength
    const start = Math.max(ref.start, batchStart)
    const end = Math.min(ref.end, batchEnd)
    if (!peerBitfieldHasFullRange(peer, start, end) && !rangeBatches.has(batchStart)) return false
    if (!Number.isSafeInteger(batchEnd) || batchEnd >= ref.end) break
    batchStart = batchEnd
  }
  return true
}

function messageCoversBatchRefs(message, refs, batchStart, batchEnd) {
  if (!message || message.drop === true ||
      !Number.isSafeInteger(message.start) || !Number.isSafeInteger(message.length) ||
      message.start < 0 || message.length < 0) return false
  const messageEnd = message.start + message.length
  if (!Number.isSafeInteger(messageEnd)) return false
  for (const ref of refs) {
    const start = Math.max(ref.start, batchStart)
    const end = Math.min(ref.end, batchEnd)
    if (start < end && (message.start > start || messageEnd < end)) return false
  }
  return true
}

function bitfieldMessageCoversBatchRefs(message, refs, batchStart, batchEnd) {
  const bitfieldLength = message?.bitfield?.byteLength
  if (!Number.isSafeInteger(bitfieldLength)) return false
  return messageCoversBatchRefs({
    drop: false,
    start: message.start,
    length: bitfieldLength * 8,
  }, refs, batchStart, batchEnd)
}

function finishAvailabilityEntry(state, entry, evidence) {
  if (entry.settled) return
  entry.settled = true
  clearTimeout(entry.timer)
  state.inflight.delete(entry.batchStart)
  if (entry.sent) {
    try { state.peer.wireUnwant.send(entry.want) } catch {}
  }
  entry.resolve(evidence)
  if (state.inflight.size !== 0) return
  if (state.peer.onrange === state.wrappedOnRange) state.peer.onrange = state.originalOnRange
  if (state.peer.onbitfield === state.wrappedOnBitfield) state.peer.onbitfield = state.originalOnBitfield
  durabilityAvailabilityRefreshes.delete(state.peer)
}

function routeAvailabilityRange(state, message) {
  if (!message || message.drop === true ||
      !Number.isSafeInteger(message.start) || !Number.isSafeInteger(message.length) ||
      message.start < 0 || message.length < 0) return
  const end = message.start + message.length
  if (!Number.isSafeInteger(end)) return
  for (const entry of [...state.inflight.values()]) {
    if (!entry.coverages.some(range => message.start < range.end && end > range.start)) continue
    finishAvailabilityEntry(state, entry, {
      type: 'range',
      range: { drop: false, start: message.start, length: message.length },
    })
  }
}

function routeAvailabilityBitfield(state, message) {
  const length = message?.bitfield?.byteLength
  if (!Number.isSafeInteger(message?.start) || !Number.isSafeInteger(length)) return
  const end = message.start + length * 8
  if (!Number.isSafeInteger(end)) return
  for (const entry of [...state.inflight.values()]) {
    if (message.start > entry.batchStart || end < entry.batchEnd) continue
    finishAvailabilityEntry(state, entry, { type: 'bitfield' })
  }
}

function createAvailabilityState(peer) {
  // Hypercore 11 has no public availability refresh API. Wire callbacks use
  // c.userData dynamically, so one guarded broker observes fresh responses
  // while preserving Hypercore's original handlers.
  if (typeof peer?.onrange !== 'function' ||
      typeof peer?.onbitfield !== 'function' ||
      typeof peer?.wireWant?.send !== 'function' ||
      typeof peer?.wireUnwant?.send !== 'function') {
    return null
  }
  const state = {
    peer,
    inflight: new Map(),
    originalOnRange: peer.onrange,
    originalOnBitfield: peer.onbitfield,
    wrappedOnRange: null,
    wrappedOnBitfield: null,
  }
  state.wrappedOnRange = async function (message) {
    const result = await state.originalOnRange.call(this, message)
    routeAvailabilityRange(state, message)
    return result
  }
  state.wrappedOnBitfield = async function (message) {
    const result = await state.originalOnBitfield.call(this, message)
    routeAvailabilityBitfield(state, message)
    return result
  }
  peer.onrange = state.wrappedOnRange
  peer.onbitfield = state.wrappedOnBitfield
  durabilityAvailabilityRefreshes.set(peer, state)
  return state
}

function requestPeerAvailability(peer, refs, batchStart, batchEnd, timeout) {
  let state = durabilityAvailabilityRefreshes.get(peer)
  if (!state) state = createAvailabilityState(peer)
  if (!state) return Promise.resolve(null)

  const coverages = refs.map(ref => ({
    start: Math.max(ref.start, batchStart),
    end: Math.min(ref.end, batchEnd),
  })).filter(range => range.start < range.end)
  const existing = state.inflight.get(batchStart)
  if (existing) {
    existing.coverages.push(...coverages)
    return existing.promise
  }

  const want = { start: batchStart, length: batchEnd - batchStart, any: false }
  let resolveEntry = null
  const promise = new Promise(resolve => { resolveEntry = resolve })
  const entry = {
    batchStart,
    batchEnd,
    coverages,
    promise,
    resolve: resolveEntry,
    want,
    sent: false,
    timer: null,
    settled: false,
  }
  state.inflight.set(batchStart, entry)
  entry.timer = setTimeout(() => finishAvailabilityEntry(state, entry, null), timeout)
  try {
    peer.wireWant.send(want)
    entry.sent = true
  } catch {
    finishAvailabilityEntry(state, entry, null)
  }
  return promise
}

async function refreshPeerBitfieldBatch(peer, refs, batchStart, batchEnd, timeout) {
  if (peerBitfieldHasBatchRefs(peer, refs, batchStart, batchEnd)) {
    return { type: 'bitfield' }
  }
  return requestPeerAvailability(peer, refs, batchStart, batchEnd, timeout)
}

async function refreshPeerBitfieldRanges(peers, refs, deps, refreshBudget) {
  const configuredTimeout = deps?.bitfieldRefreshTimeoutMs
  const timeout = configuredTimeout === undefined
    ? DEFAULT_DURABILITY_BITFIELD_REFRESH_TIMEOUT_MS
    : configuredTimeout
  if (!Number.isSafeInteger(timeout) || timeout <= 0 ||
      timeout > MAX_DURABILITY_BITFIELD_REFRESH_TIMEOUT_MS) {
    throw new RangeError(
      `bitfieldRefreshTimeoutMs must be between 1 and ${MAX_DURABILITY_BITFIELD_REFRESH_TIMEOUT_MS}`
    )
  }
  const configuredDeadline = deps?.bitfieldRefreshDeadlineMs
  const deadlineMs = configuredDeadline === undefined
    ? MAX_DURABILITY_BITFIELD_REFRESH_DEADLINE_MS
    : configuredDeadline
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 ||
      deadlineMs > MAX_DURABILITY_BITFIELD_REFRESH_DEADLINE_MS) {
    throw new RangeError(
      `bitfieldRefreshDeadlineMs must be between 1 and ${MAX_DURABILITY_BITFIELD_REFRESH_DEADLINE_MS}`
    )
  }
  if (refreshBudget.deadline === null) refreshBudget.deadline = Date.now() + deadlineMs

  const incompletePeers = peers.filter(peer =>
    refs.some(ref => !peerBitfieldHasFullRange(peer, ref.start, ref.end))
  )
  const rangeBatches = new Map()
  if (incompletePeers.length === 0) return { batchLength: null, rangeBatches }

  const batchLength = hypercoreWants?.WANT_BATCH
  const probeLength = batchLength / 2
  const minRange = MIN_DURABILITY_WANT_PROBE
  if (!Number.isSafeInteger(batchLength) ||
      !Number.isSafeInteger(probeLength) ||
      !Number.isSafeInteger(minRange) ||
      probeLength < minRange ||
      (probeLength & (probeLength - 1)) !== 0) {
    throw new Error('unsupported Hypercore isolated WANT probe length')
  }

  const batchStarts = new Set()
  for (const ref of refs) {
    let batchStart = Math.floor(ref.start / probeLength) * probeLength
    while (batchStart < ref.end) {
      batchStarts.add(batchStart)
      if (batchStarts.size > MAX_DURABILITY_BITFIELD_REFRESHES) {
        throw new RangeError(`durability bitfield refreshes exceed maximum of ${MAX_DURABILITY_BITFIELD_REFRESHES}`)
      }
      const batchEnd = batchStart + probeLength
      if (!Number.isSafeInteger(batchEnd) || batchEnd >= ref.end) break
      batchStart = batchEnd
    }
  }

  const pending = []
  for (const peer of incompletePeers) {
    for (const batchStart of batchStarts) {
      const batchEnd = batchStart + probeLength
      if (peerBitfieldHasBatchRefs(peer, refs, batchStart, batchEnd)) continue
      if (refreshBudget.used >= MAX_DURABILITY_BITFIELD_REFRESHES) {
        throw new RangeError(`durability bitfield refreshes exceed maximum of ${MAX_DURABILITY_BITFIELD_REFRESHES}`)
      }
      refreshBudget.used++
      pending.push({ peer, batchStart, batchEnd })
    }
  }

  let cursor = 0
  const runNext = async () => {
    while (cursor < pending.length) {
      const current = pending[cursor++]
      const remaining = refreshBudget.deadline - Date.now()
      if (remaining <= 0) return
      const evidence = await refreshPeerBitfieldBatch(
        current.peer,
        refs,
        current.batchStart,
        current.batchEnd,
        Math.min(timeout, remaining),
      )
      if (!evidence || peerBitfieldHasBatchRefs(
        current.peer,
        refs,
        current.batchStart,
        current.batchEnd,
      )) continue
      if (evidence.type !== 'range' || !messageCoversBatchRefs(
        evidence.range,
        refs,
        current.batchStart,
        current.batchEnd,
      )) continue
      let batches = rangeBatches.get(current.peer)
      if (!batches) rangeBatches.set(current.peer, batches = new Map())
      batches.set(current.batchStart, evidence.range)
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_DURABILITY_REFRESHES, pending.length) },
    runNext,
  ))
  return { batchLength: probeLength, rangeBatches }
}

function durabilityPeerIterable(core, getCorePeers) {
  const peers = typeof getCorePeers === 'function' ? getCorePeers(core) : core?.peers
  if (!peers || typeof peers[Symbol.iterator] !== 'function') return null
  return peers
}

async function openDurabilityCore(coreKey, deps) {
  if (typeof deps?.openCore === 'function') return deps.openCore(coreKey)
  if (typeof deps?.store?.get === 'function') {
    return deps.store.get(b4a.from(coreKey, 'hex'))
  }
  return null
}

/**
 * Verify that the same authenticated peer holds every required Hypercore range,
 * then evaluate that complete-item holder set under the durability policy.
 * Missing or malformed runtime evidence always fails closed.
 */
export async function assessDurableManifest(refs, trust = {}, deps = {}) {
  if (!Array.isArray(refs)) {
    return failClosedDurabilityAssessment('refs must be an array')
  }
  if (refs.length > MAX_DURABILITY_REFS) {
    return failClosedDurabilityAssessment(`refs exceeds maximum of ${MAX_DURABILITY_REFS}`)
  }
  if (refs.length === 0) return failClosedDurabilityAssessment()

  let canonicalRefs
  try {
    canonicalRefs = canonicalizeDurabilityRefs(refs)
    if (!trust || typeof trust !== 'object') {
      return failClosedDurabilityAssessment('trust must be an object')
    }
    // Validate trust keys and the threshold before opening any sessions.
    evaluateDurabilityPolicy({
      holderKeys: [],
      trustedRelayKeys: trust.trustedRelayKeys,
      pairedDeviceKeys: trust.pairedDeviceKeys,
      ordinaryRequired: trust.ordinaryRequired
    })
  } catch (error) {
    return failClosedDurabilityAssessment(durabilityErrorMessage(error))
  }

  const refsByCore = new Map()
  for (const durabilityRef of canonicalRefs) {
    const coreRefs = refsByCore.get(durabilityRef.coreKey)
    if (coreRefs) coreRefs.push(durabilityRef)
    else refsByCore.set(durabilityRef.coreKey, [durabilityRef])
  }
  const refreshBudget = { used: 0, deadline: null }
  let holderKeys = null
  try {
    for (const [coreKey, coreRefs] of refsByCore) {
      let core = null
      try {
        core = await openDurabilityCore(coreKey, deps)
        if (!core) throw new Error('durability core unavailable')
        if (typeof core.ready === 'function') await core.ready()

        const iterable = durabilityPeerIterable(core, deps?.getCorePeers)
        if (!iterable) return failClosedDurabilityAssessment()

        const peers = []
        for (const peer of iterable) {
          peers.push(peer)
          if (peers.length > MAX_DURABILITY_PEERS_PER_CORE) {
            throw new Error(`peer count exceeds maximum of ${MAX_DURABILITY_PEERS_PER_CORE}`)
          }
        }
        const candidatePeers = peers.filter(peer => {
          const holderKey = authenticatedPeerKeyHex(peer)
          return holderKey !== null && (holderKeys === null || holderKeys.has(holderKey))
        })
        const refreshEvidence = await refreshPeerBitfieldRanges(
          candidatePeers,
          coreRefs,
          deps,
          refreshBudget,
        )

        for (const durabilityRef of coreRefs) {
          const holders = new Set()
          for (const peer of peers) {
            const holderKey = authenticatedPeerKeyHex(peer)
            if (!holderKey || (holderKeys !== null && !holderKeys.has(holderKey))) continue
            if (peerHasRefAvailability(peer, durabilityRef, refreshEvidence)) {
              holders.add(holderKey)
            }
          }

          if (holderKeys === null) {
            holderKeys = holders
          } else {
            for (const holderKey of holderKeys) {
              if (!holders.has(holderKey)) holderKeys.delete(holderKey)
            }
          }

          // Returning here still executes the current core's finally block.
          if (holderKeys.size === 0) return failClosedDurabilityAssessment()
        }
      } finally {
        try { await core?.close?.() } catch { /* session release is best effort */ }
      }
    }

    if (holderKeys === null || holderKeys.size === 0) {
      return failClosedDurabilityAssessment()
    }
    return completedDurabilityAssessment(evaluateDurabilityPolicy({
      holderKeys,
      trustedRelayKeys: trust.trustedRelayKeys,
      pairedDeviceKeys: trust.pairedDeviceKeys,
      ordinaryRequired: trust.ordinaryRequired
    }))
  } catch (error) {
    return failClosedDurabilityAssessment(durabilityErrorMessage(error))
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
 * @param {import('./seeding.js').SeedingManager} [deps.seedingManager] - Seeding manager
 * @param {import('./video-stats.js').VideoStatsTracker} [deps.videoStats] - Video stats tracker
 * @returns {Object}
 */
export function createApi({
  ctx,
  seedingManager,
  videoStats,
  operability,
  catalogRegistry,
  scopedNetwork,
  permissionlessArchiveNetwork = ctx?.permissionlessArchiveNetwork,
  policyApi = null,
  networkPolicyRuntime = ctx?.networkPolicyRuntime || null,
  sourceOffload = {},
  loadChannel = storageLoadChannel,
  loadPublicBee = storageLoadPublicBee,
}) {
  const blobPlayback = createBlobPlaybackService(ctx)
  const publisherApi = createPublisherApi({ ctx, catalogRegistry, now: () => Date.now() })
  const mediaGraphApi = createMediaGraphApi({ ctx })
  const scopedNetworkApi = scopedNetwork ? createScopedNetworkApi(scopedNetwork) : {}
  const archiveParticipationApi = createArchiveParticipationApi({
    archiveNetwork: permissionlessArchiveNetwork,
    manifestStore: ctx.assetManifestStore,
  })
  const operabilityApi = createOperabilityApi({
    ctx,
    seedingManager,
    ...(operability || {})
  })
  const localPolicyApi = policyApi || createPolicyApi({
    store: ctx.networkPolicyStore || ctx.metaDb || new Map(),
    onPolicyChange: ctx.onNetworkPolicyChange,
  })

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
      const operation = typeof publicBee.listVideosWithStatus === 'function'
        ? publicBee.listVideosWithStatus()
        : publicBee.listVideos().then((videos) => ({ status: 'authoritative', videos }))
      return await withTimeout(operation, timeoutMs, `PublicBee listVideos ${driveKey?.slice?.(0, 16) || ''} ${publicBeeKey?.slice?.(0, 16) || ''}`)
    } catch (err) {
      console.warn('[API] PublicBee listVideos bounded timeout/failure:', driveKey?.slice?.(0, 16), publicBeeKey?.slice?.(0, 16), err?.message)
      return { status: 'uncertain', videos: [] }
    }
  }

  const getPublicBeeVideoWithStatus = async (publicBee, videoId) => {
    if (typeof publicBee?.getVideoWithStatus === 'function') {
      return publicBee.getVideoWithStatus(videoId)
    }
    const video = await publicBee.getVideo(videoId)
    return { status: video ? 'found' : 'notFound', video }
  }

  const loadChannelBounded = async (channelKey, timeoutMs = 2500, options = undefined) => {
    const label = `loadChannel ${channelKey?.slice?.(0, 16) || ''}`
    // Already-loaded channels resolve from the in-memory cache — no timeout needed.
    if (ctx.channels?.has?.(channelKey)) {
      return loadChannel(ctx, channelKey, options)
    }
    try {
      return await withTimeout(loadChannel(ctx, channelKey, options), timeoutMs, label)
    } catch (err) {
      if (!/timeout/i.test(err?.message || '')) throw err
      // Slow networks routinely blow the first deadline while the underlying
      // load keeps going (loadChannel dedupes concurrent loads), so retry once
      // with a doubled budget instead of failing hard.
      console.warn(`[API] ${label} timed out after ${timeoutMs}ms, retrying once`)
      return withTimeout(loadChannel(ctx, channelKey, options), timeoutMs * 2, `${label} retry`)
    }
  }

  function throwCatalogError(code, message) {
    const error = new Error(message)
    error.code = code
    throw error
  }

  function assertBoundedCatalogCollection(records, limit, label) {
    if (Array.isArray(records) && records.length > limit) {
      throwCatalogError('CATALOG_UNAVAILABLE', `${label} exceeds limit ${limit}`)
    }
    return records
  }

  function readCatalogRequestKey(request, field) {
    const value = request?.[field]
    if (value === undefined || value === null || value === '') return null
    if (!isCatalogStorageKey(value)) {
      throwCatalogError('INVALID_CATALOG_INPUT', `Catalog request.${field} is invalid`)
    }
    return value.toLowerCase()
  }

  function normalizeCatalogRequestLimit(request) {
    const hasLimit = Object.hasOwn(request, 'limit')
    if (request.limitProvided === true) return hasLimit ? request.limit : undefined
    if (request.limitProvided === false) return request.limit > 0 ? request.limit : undefined
    return hasLimit ? request.limit : undefined
  }

  async function verifiedPublicCatalogDescriptor(publicBee, publicBeeKey) {
    if (typeof publicBee?.getRootDescriptor !== 'function') {
      throwCatalogError('CHANNEL_NOT_FOUND', 'Channel not found')
    }
    const signed = await withTimeout(
      Promise.resolve(publicBee.getRootDescriptor()),
      1500,
      `PublicBee root descriptor ${publicBeeKey.slice(0, 16)}`,
    )
    if (!signed) throwCatalogError('CHANNEL_NOT_FOUND', 'Channel not found')

    const verification = await verifySignedChannelRootDescriptor(signed)
    if (!verification?.valid) {
      throwCatalogError('CATALOG_UNAVAILABLE', 'Catalog unavailable')
    }
    if (verification.descriptor?.metadataKey !== publicBeeKey.toLowerCase()) {
      throwCatalogError('CHANNEL_MISMATCH', 'Public catalog descriptor does not match publicBeeKey')
    }
    return verification.descriptor
  }

  async function resolveCatalogChannel(request = {}) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throwCatalogError('INVALID_CATALOG_INPUT', 'Catalog request must be an object')
    }

    const requestedChannelKey = readCatalogRequestKey(request, 'channelKey')
    const publicBeeKey = readCatalogRequestKey(request, 'publicBeeKey')
    if (!requestedChannelKey && !publicBeeKey) {
      throwCatalogError('INVALID_CATALOG_INPUT', 'Catalog request requires channelKey or publicBeeKey')
    }

    if (publicBeeKey) {
      const publicBee = await withTimeout(
        Promise.resolve(loadPublicBee(ctx, publicBeeKey)),
        5000,
        `loadPublicBee ${publicBeeKey.slice(0, 16)}`,
      )
      if (!publicBee) throwCatalogError('CHANNEL_NOT_FOUND', 'Channel not found')

      const descriptor = await verifiedPublicCatalogDescriptor(publicBee, publicBeeKey)
      const channelKey = descriptor.channelId.toLowerCase()
      if (requestedChannelKey && requestedChannelKey !== channelKey) {
        throwCatalogError('CHANNEL_MISMATCH', 'Catalog channel does not match signed descriptor')
      }
      return { channelKey, publicBeeKey, store: publicBee, isPublic: true }
    }

    const channelKey = requestedChannelKey
    const channel = await loadChannelBounded(channelKey)
    if (!channel) throwCatalogError('CHANNEL_NOT_FOUND', 'Channel not found')
    const channelPublicBeeKey = channel.publicBeeKey
    const resolvedPublicBeeKey = isCatalogStorageKey(channelPublicBeeKey)
      ? channelPublicBeeKey.toLowerCase()
      : null
    return {
      channelKey,
      publicBeeKey: resolvedPublicBeeKey,
      store: channel,
      isPublic: false,
    }
  }

  async function callCatalogStore(store, method, fallback, options = undefined) {
    if (typeof store?.[method] !== 'function') return fallback
    return options === undefined ? store[method]() : store[method](options)
  }

  async function listCatalogVideos({ channelKey, publicBeeKey, store, isPublic }) {
    let records
    if (isPublic) {
      if (typeof store?.listVideosWithStatus !== 'function') {
        throwCatalogError('CATALOG_UNAVAILABLE', 'Catalog unavailable')
      }
      const options = { syncTimeoutMs: 1500, timeoutMs: 1200 }
      const operation = Promise.resolve(store.listVideosWithStatus(options))
      const listing = await withTimeout(
        operation,
        3500,
        `PublicBee catalog videos ${channelKey.slice(0, 16)} ${publicBeeKey?.slice?.(0, 16) || ''}`,
      )
      if (listing?.status !== 'authoritative' || !Array.isArray(listing.videos)) {
        throwCatalogError('CATALOG_UNAVAILABLE', 'Catalog unavailable')
      }
      records = listing.videos
    } else {
      records = await withTimeout(
        Promise.resolve(callCatalogStore(store, 'listVideos', [])),
        3500,
        `Channel catalog videos ${channelKey.slice(0, 16)}`,
      )
    }

    if (!Array.isArray(records)) return records ?? []
    const visible = []
    for (const record of records) {
      if (record?.publicationState === 'replicationPending') continue
      if (record?.canonicalVisibility === 'suppressed') continue
      visible.push(record)
    }
    return snapshotCatalogRecords(visible, CATALOG_ITEM_FIELDS)
  }

  async function readCatalogData(resolved, { includePresentation = false } = {}) {
    const { store, isPublic, channelKey } = resolved
    const pointReadOptions = isPublic
      ? { bounded: true, timeoutMs: CATALOG_PUBLIC_READ_TIMEOUT_MS }
      : undefined

    if (!includePresentation) {
      const reads = Promise.all([
        callCatalogStore(store, 'getChannelProfile', {}, pointReadOptions),
        listCatalogVideos(resolved),
      ])
      const [storedProfile, videos] = await withTimeout(
        reads,
        CATALOG_REQUEST_READ_TIMEOUT_MS,
        `Channel catalog item data ${channelKey.slice(0, 16)}`,
      )
      return {
        profile: snapshotCatalogRecord(storedProfile, CATALOG_PROFILE_FIELDS),
        videos,
      }
    }

    const reads = Promise.all([
      callCatalogStore(store, 'getMetadata', {}, pointReadOptions),
      callCatalogStore(store, 'getChannelProfile', {}, pointReadOptions),
      callCatalogStore(store, 'listChannelSources', [], isPublic
        ? { ...pointReadOptions, limit: MAX_CATALOG_CHANNEL_SOURCES }
        : undefined),
      callCatalogStore(store, 'listChannelArtwork', [], isPublic
        ? { ...pointReadOptions, limit: MAX_CATALOG_CHANNEL_ARTWORK }
        : undefined),

      listCatalogVideos(resolved),
    ])
    const [metadata, storedProfile, sources, artwork, videos] = await withTimeout(
      reads,
      CATALOG_REQUEST_READ_TIMEOUT_MS,
      `Channel catalog presentation data ${channelKey.slice(0, 16)}`,
    )
    return {
      profile: {
        ...snapshotCatalogRecord(metadata, CATALOG_PROFILE_FIELDS),
        ...snapshotCatalogRecord(storedProfile, CATALOG_PROFILE_FIELDS),
      },
      sources: snapshotCatalogRecords(
        assertBoundedCatalogCollection(sources, MAX_CATALOG_CHANNEL_SOURCES, 'Catalog sources'),
        CATALOG_SOURCE_FIELDS,
      ),
      artwork: snapshotCatalogRecords(
        assertBoundedCatalogCollection(artwork, MAX_CATALOG_CHANNEL_ARTWORK, 'Catalog artwork'),
        CATALOG_ARTWORK_FIELDS,
      ),
      videos,
    }
  }

  function catalogFailureResponse(error, collectionField) {
    const errorCode = CATALOG_ERROR_CODES.has(error?.code) ? error.code : 'CATALOG_UNAVAILABLE'
    const message = errorCode === 'CATALOG_UNAVAILABLE'
      ? 'Catalog unavailable'
      : error?.message || 'Catalog request failed'
    if (errorCode === 'CATALOG_UNAVAILABLE' && error?.code !== 'CATALOG_UNAVAILABLE') {
      console.error('[API] catalog read failed:', error?.message || error)
    }
    return {
      success: false,
      errorCode,
      error: message,
      [collectionField]: [],
    }
  }


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
  const activeRangeRequests = new Map() // key: `${driveKey}:${videoPath}`, value: tracked ranges, listeners, and timers
  const prefetchQuotaReservations = new Map() // key: prefetch key -> bytes promised to an active full-file fill
  const activeOnDemandPlaybackStats = new Map() // key: normalized stats key -> owned core and monitor cleanup
  const activePrefetchCores = new Map() // key: prefetch key -> API-manager-owned core session
  const sourceMutationQueues = new Map() // key: blobs core key -> FIFO mutation lease
  const apiTimers = new Set()
  const managedApiResources = new Set()
  let apiClosed = false
  let apiClosePromise = null

  const pendingPlaybackReadyResolvers = new Set()
  function scheduleApiTimeout(callback, delayMs) {
    if (apiClosed || ctx?.lifecycle?.signal?.aborted) return null
    const timer = setTimeout(() => {
      apiTimers.delete(timer)
      if (!apiClosed && !ctx?.lifecycle?.signal?.aborted) callback()
    }, delayMs)
    timer.unref?.()
    apiTimers.add(timer)
    return timer
  }

  function clearApiTimeout(timer) {
    if (timer == null) return
    clearTimeout(timer)
    apiTimers.delete(timer)
  }

  async function withSourceMutationLocks(coreKeys, operation) {
    const keys = [...new Set((coreKeys || [])
      .filter(key => typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key))
      .map(key => key.toLowerCase()))].sort()
    if (keys.length === 0) return operation()
    const leases = []
    for (const key of keys) {
      const previous = sourceMutationQueues.get(key) || Promise.resolve()
      let release
      const current = new Promise(resolve => { release = resolve })
      sourceMutationQueues.set(key, current)
      await previous
      leases.push({ key, current, release })
    }
    try {
      return await operation()
    } finally {
      for (let index = leases.length - 1; index >= 0; index--) leases[index].release()
      for (const lease of leases) {
        if (sourceMutationQueues.get(lease.key) === lease.current) sourceMutationQueues.delete(lease.key)
      }
    }
  }

  function ownManagedApiResource(resource, methods = 'close') {
    const candidates = Array.isArray(methods) ? methods : [methods]
    let cleanupPromise = null
    const record = {
      cleanup() {
        if (cleanupPromise) return cleanupPromise
        managedApiResources.delete(record)
        cleanupPromise = (async () => {
          for (const method of candidates) {
            if (typeof resource?.[method] !== 'function') continue
            await resource[method]()
            return
          }
        })().catch(() => {})
        return cleanupPromise
      },
    }
    managedApiResources.add(record)
    return record
  }

  function ownPrefetchCore(prefetchKey, core) {
    const ownership = ownManagedApiResource(core, 'close')
    let cleanupPromise = null
    const record = {
      core,
      cleanup() {
        if (cleanupPromise) return cleanupPromise
        if (activePrefetchCores.get(prefetchKey) === record) {
          activePrefetchCores.delete(prefetchKey)
        }
        cleanupPromise = (async () => {
          await ownership.cleanup()
        })()
        return cleanupPromise
      },
    }
    const previous = activePrefetchCores.get(prefetchKey)
    activePrefetchCores.set(prefetchKey, record)
    if (previous && previous !== record) void previous.cleanup()
    return record
  }

  async function cleanupPrefetchCore(prefetchKey) {
    await activePrefetchCores.get(prefetchKey)?.cleanup?.()
  }

  async function cleanupRangeRequest(prefetchKey, { cleanupMonitor = true } = {}) {
    prefetchQuotaReservations.delete(prefetchKey)
    const request = activeRangeRequests.get(prefetchKey)
    if (request) {
      activeRangeRequests.delete(prefetchKey)
      let cancelled = false
      try {
        if (typeof request.cancel === 'function') {
          request.cancel()
          cancelled = true
        }
      } catch { /* best effort */ }
      try { request.release?.() } catch { /* best effort */ }
      for (const timer of request.timers || []) clearApiTimeout(timer)
      request.timers?.clear?.()
      if (!cancelled) request.ranges?.forEach(range => { try { range?.destroy?.() } catch { /* best effort */ } })
      if (request.core) {
        try { request.core.off('download', request.onDownload) } catch { /* best effort */ }
        try { request.core.off('upload', request.onUpload) } catch { /* best effort */ }
      }
      try { request.resolvePlaybackReady?.() } catch { /* best effort */ }
      if (cleanupMonitor) {
        try { videoStats?.cleanupMonitor?.(request.driveKey, request.videoPath) } catch { /* best effort */ }
      }
    }
    await cleanupPrefetchCore(prefetchKey)
  }

  async function cleanupOnDemandPlaybackStats(statsKey) {
    const active = activeOnDemandPlaybackStats.get(statsKey)
    if (!active) return
    activeOnDemandPlaybackStats.delete(statsKey)
    try { active.cleanupMonitor?.() } catch { /* best effort */ }
    try { await active.ownership?.cleanup?.() } catch { /* best effort */ }
  }

  async function closeApiResources() {
    if (apiClosePromise) return apiClosePromise
    apiClosed = true
    apiClosePromise = (async () => {
      cancelScheduledQuotaSweep()
      for (const resolve of Array.from(pendingPlaybackReadyResolvers)) {
        try { resolve() } catch { /* best effort */ }
      }
      pendingPlaybackReadyResolvers.clear()
      for (const timer of Array.from(apiTimers)) clearApiTimeout(timer)
      await Promise.all(Array.from(activeRangeRequests.keys(), (key) => cleanupRangeRequest(key)))
      await Promise.all(Array.from(activeOnDemandPlaybackStats.keys(), (key) => cleanupOnDemandPlaybackStats(key)))
      await Promise.all(Array.from(activePrefetchCores.values(), (record) => record.cleanup()))
      await Promise.all(Array.from(managedApiResources, (record) => record.cleanup()))
      prefetchInFlight.clear()
      prefetchQuotaReservations.clear()
    })()
    return apiClosePromise
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
    let coreOwnership = null

    const blobsCoreKey = normalizeBlobsCoreKey(playbackBlobRef.blobsCoreKey)
    const blob = normalizeBlobRefInput(playbackBlobRef.blobId) || parseBlobRef(playbackBlobRef)?.blob
    if (!blobsCoreKey || !blob) return null

    const statsKey = getStatsKey(driveKey, videoPath)
    if (activeRangeRequests.has(encodeIndexKey(driveKey || '', videoPath || ''))) {
      return typeof videoStats.getStats === 'function' ? videoStats.getStats(driveKey, videoPath) : null
    }

    try {
      await cleanupOnDemandPlaybackStats(statsKey)
      try { videoStats.cleanupMonitor(driveKey, videoPath) } catch { /* best effort */ }

      assertApiContextRunning(ctx)
      const keyBuf = b4a.from(blobsCoreKey, 'hex')
      const core = ctx.store.get({ key: keyBuf })
      coreOwnership = ownManagedApiResource(core, 'close')
      await core.ready()
      assertApiContextRunning(ctx)

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
      const cleanupMonitor = () => videoStats.cleanupMonitor(driveKey, videoPath)
      activeOnDemandPlaybackStats.set(statsKey, {
        core,
        ownership: coreOwnership,
        cleanupMonitor,
      })
      videoStats.registerMonitor(driveKey, videoPath, monitor, () => {
        try { core.off('download', onDownload) } catch { /* best effort */ }
        try { core.off('upload', onUpload) } catch { /* best effort */ }
        const active = activeOnDemandPlaybackStats.get(statsKey)
        if (active?.core === core) activeOnDemandPlaybackStats.delete(statsKey)
        void coreOwnership?.cleanup?.()
      })
      videoStats.emitStats(driveKey, videoPath, true)

      return videoStats.getStats(driveKey, videoPath)
    } catch (err) {
      console.log('[API] on-demand playback stats unavailable:', err?.message || err)
      await cleanupOnDemandPlaybackStats(statsKey)
      try { await coreOwnership?.cleanup?.() } catch { /* best effort */ }
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
    clearApiTimeout(quotaSweepTimer)
    quotaSweepTimer = null
  }

  function runQuotaSweep() {
    if (apiClosed || ctx?.lifecycle?.signal?.aborted) return
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
    quotaSweepTimer = scheduleApiTimeout(runQuotaSweep, QUOTA_SWEEP_AFTER_PLAYBACK_MS)
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
  // Relay anchor: authenticated swarm/Noise keys from the one canonical trust
  // union assembled by the orchestrator (configured keys + persisted links).
  // A live or feed-discovered blind mirror is useful for dialing/delegation but
  // is not durable trust unless it is present in this explicit union.
  function getKnownDurableRelayKeys() {
    const keys = new Set()
    for (const value of Array.isArray(ctx?.trustedRelayKeys) ? ctx.trustedRelayKeys : []) {
      const key = typeof value === 'string' ? value.toLowerCase() : null
      if (key && /^[a-f0-9]{64}$/.test(key)) keys.add(key)
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


  function resolvePlaybackBlobRef(_driveKey, _videoId, _publicBeeKey, blobId, blobsCoreKey, mimeType) {
    return blobId && blobsCoreKey
      ? { blobId, blobsCoreKey, mimeType: mimeType || 'video/mp4' }
      : { blobId, blobsCoreKey, mimeType }
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
  const SOURCE_OFFLOAD_STATE_KEY = 'archive:source-offload-state:v1'
  const sourceOffloadRepository = sourceOffload.repository || (
    typeof ctx?.metaDb?.get === 'function' && typeof ctx?.metaDb?.put === 'function'
      ? {
          async load() {
            return (await ctx.metaDb.get(SOURCE_OFFLOAD_STATE_KEY))?.value || null
          },
          async save(state) {
            await ctx.metaDb.put(SOURCE_OFFLOAD_STATE_KEY, state)
          },
        }
      : null
  )

  function exactSourceLocators(manifest) {
    const renditions = (manifest?.body?.renditions || []).filter(rendition => rendition?.purpose === 'original')
    const locators = renditions.map(rendition => {
      const core = normalizeAssetCoreRefV2(rendition?.core)
      return {
        renditionId: rendition.renditionId,
        assetId: core.assetId,
        coreKey: core.key,
        start: 0,
        end: core.length,
        blobId: null,
        byteLength: core.byteLength,
        treeHash: core.treeHash,
        blockSize: core.blockSize,
      }
    })
    if (locators.length !== 1) throw new Error('publication must have exactly one local original source')
    return locators
  }

  function sameSourceLocators(left, right) {
    return left.length === right.length && left.every((locator, index) => {
      const other = right[index]
      return locator.renditionId === other.renditionId &&
        locator.assetId === other.assetId &&
        locator.coreKey === other.coreKey &&
        locator.start === other.start &&
        locator.end === other.end &&
        locator.blobId === other.blobId &&
        locator.byteLength === other.byteLength &&
        locator.treeHash === other.treeHash &&
        locator.blockSize === other.blockSize
    })
  }

  async function resolveOwnedPublication(publicationId) {
    const manifest = await ctx?.assetManifestStore?.getManifest?.(publicationId)
    if (!manifest || manifest.publicationId !== publicationId) throw new Error('publication manifest not found')
    let owned = false
    if (typeof sourceOffload.authorizePublication === 'function') {
      owned = await sourceOffload.authorizePublication({ publicationId, manifest })
    } else if (catalogRegistry && typeof catalogRegistry.resolve === 'function') {
      const binding = await catalogRegistry.resolve(manifest.body.publisherId)
      owned = Boolean(binding?.catalog?.writable)
    }
    if (!owned) throw new Error('publication source is not controlled by this publisher device')
    return { manifest, locators: exactSourceLocators(manifest) }
  }

  function localTransportKey() {
    const key = ctx?.swarm?.keyPair?.publicKey
    return key ? b4a.toString(b4a.from(key), 'hex') : null
  }

  function sourceIsActivelyPlaying(locators) {
    const keys = new Set(locators.map(locator => locator.coreKey))
    if (typeof sourceOffload.isPlaybackActive === 'function' &&
        sourceOffload.isPlaybackActive({ locators }) === true) return true
    for (const active of activeOnDemandPlaybackStats.values()) {
      const key = active?.core?.key ? b4a.toString(b4a.from(active.core.key), 'hex') : null
      if (key && keys.has(key)) return true
    }
    for (const active of activePrefetchCores.values()) {
      const key = active?.core?.key ? b4a.toString(b4a.from(active.core.key), 'hex') : null
      if (key && keys.has(key)) return true
    }
    for (const key of keys) {
      if (Number(seedingManager?.protectedBlobCores?.get?.(key) || 0) > 0) return true
    }
    return false
  }

  function sourceIsManuallyPinned(locators) {
    if (typeof sourceOffload.isPinned === 'function' &&
        sourceOffload.isPinned({ locators }) === true) return true
    for (const seed of seedingManager?.activeSeeds?.values?.() || []) {
      if (seed?.reason !== 'pinned') continue
      const ref = seed?.blobsCoreKey || seed?.blobKey
      if (locators.some(locator => locator.coreKey === ref)) return true
    }
    return false
  }


  function openStaticSourceCore(locator) {
    const descriptor = createStaticAssetManifest({
      treeHash: locator.treeHash,
      blockLength: locator.end,
      byteLength: locator.byteLength,
      blockSize: locator.blockSize,
    })
    return ctx.store.get({
      key: b4a.from(locator.coreKey, 'hex'),
      manifest: descriptor.hypercoreManifest,
      writable: false,
    })
  }
  async function inspectSourcePeers(locator) {
    const core = openStaticSourceCore(locator)
    const ownership = ownManagedApiResource(core, 'close')
    try {
      await core.ready()
      const holders = []
      let anonymous = 0
      for (const peer of getCorePeerObjects(core)) {
        if (!peerHasFullRange(peer, locator.start, locator.end)) continue
        const remoteKey = peer?.remotePublicKey
          ? b4a.toString(b4a.from(peer.remotePublicKey), 'hex')
          : null
        if (/^[0-9a-f]{64}$/.test(remoteKey || '')) holders.push(remoteKey)
        else anonymous++
      }
      return { holders: Array.from(new Set(holders)).sort(), anonymous }
    } finally {
      await ownership.cleanup()
    }
  }

  async function collectSourceOffloadEvidence(publicationId, resolvedPublication = null) {
    const { manifest, locators } = resolvedPublication || await resolveOwnedPublication(publicationId)
    const supplied = typeof sourceOffload.collectEvidence === 'function'
      ? await sourceOffload.collectEvidence({ publicationId, manifest, locators })
      : null
    if (supplied) {
      return {
        ...supplied,
        publicationId,
        byteLength: locators.reduce((total, locator) => total + locator.byteLength, 0),
        activePlayback: sourceIsActivelyPlaying(locators) || supplied.activePlayback === true,
      }
    }

    const deviceKeys = new Set(
      (typeof sourceOffload.getPublisherDeviceKeys === 'function'
        ? await sourceOffload.getPublisherDeviceKeys({ publisherId: manifest.body.publisherId, manifest })
        : []
      ).filter(key => typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key)).map(key => key.toLowerCase())
    )
    const publisherDeviceCopies = []
    let viewerFullCopies = 0
    for (const locator of locators) {
      const peers = await inspectSourcePeers(locator)
      viewerFullCopies += peers.anonymous
      for (const peerId of peers.holders) {
        if (deviceKeys.has(peerId)) {
          publisherDeviceCopies.push({
            deviceId: peerId,
            physicalDeviceId: peerId,
            sameDevice: peerId === localTransportKey(),
            connected: true,
            fullCopy: true,
            publisherControlled: true,
          })
        } else {
          viewerFullCopies++
        }
      }
    }
    const archivistChallenges = typeof sourceOffload.getArchivistChallenges === 'function'
      ? await sourceOffload.getArchivistChallenges({ publicationId, manifest, locators })
      : await permissionlessArchiveNetwork?.getOffloadEvidence?.(publicationId, locators) || []
    return {
      publicationId,
      byteLength: locators.reduce((total, locator) => total + locator.byteLength, 0),
      localPhysicalDeviceId: localTransportKey(),
      activePlayback: sourceIsActivelyPlaying(locators),
      publisherDeviceCopies,
      archivistChallenges,
      viewerFullCopies,
    }
  }

  async function deleteConfirmedPublicationSource(request, sourceMutationLocked = false, expectedLocators = null) {
    const { publicationId, authorize } = request
    const { manifest, locators } = await resolveOwnedPublication(publicationId)
    if (!sourceMutationLocked) {
      return withSourceMutationLocks(
        locators.map(locator => locator.coreKey),
        () => deleteConfirmedPublicationSource(request, true, locators)
      )
    }
    if (typeof authorize !== 'function') return { success: false, reason: 'locked-revalidation-required' }
    if (expectedLocators && !sameSourceLocators(expectedLocators, locators)) {
      return authorize({ refusalReason: 'evidence-changed' })
    }
    if (sourceIsManuallyPinned(locators)) return authorize({ refusalReason: 'source-pinned' })

    const collectLockedEvidence = () => collectSourceOffloadEvidence(publicationId, { manifest, locators })
    if (typeof sourceOffload.deleteSource === 'function') {
      const authorization = await authorize({ collectEvidence: collectLockedEvidence })
      if (!authorization.success) return authorization
      return sourceOffload.deleteSource({ publicationId, manifest, locators })
    }

    const locator = locators[0]
    let releasedOwnership = false
    let core = null
    let ownership = null
    try {
      core = openStaticSourceCore(locator)
      ownership = ownManagedApiResource(core, 'close')
      await core.ready()
      if (sourceIsManuallyPinned(locators)) return authorize({ refusalReason: 'source-pinned' })
      const authorization = await authorize({ collectEvidence: collectLockedEvidence })
      if (!authorization.success) return authorization
      if (typeof core.clear !== 'function') return { success: false, reason: 'delete-unavailable' }
      if (typeof scopedNetwork?.releaseAuthorizedRendition === 'function') {
        const released = await scopedNetwork.releaseAuthorizedRendition({
          renditionId: locator.renditionId,
          ownerId: publicationId,
          assetId: locator.assetId,
        })
        releasedOwnership = released?.released === true
        if (released?.scopeQuiescent === false) {
          return { success: true, freedBytes: 0, sharedRetention: true }
        }
      }
      await core.clear(locator.start, locator.end)
      const garbage = await collectCorestoreGarbage(ctx.store, {
        label: 'confirmed source offload',
        log: console.warn,
      })
      if (garbage.error) throw new Error(`source garbage collection failed: ${garbage.error}`)
      return { success: true, freedBytes: locator.byteLength }
    } catch (error) {
      if (releasedOwnership && typeof scopedNetwork?.retainAuthorizedRendition === 'function') {
        await scopedNetwork.retainAuthorizedRendition({
          manifest,
          renditionId: locator.renditionId,
          ownerId: publicationId,
          start: locator.start,
          end: locator.end,
        })
      }
      throw error
    } finally {
      await ownership?.cleanup?.()
    }
  }

  const sourceOffloadManager = createArchiveManager({
    repository: sourceOffloadRepository,
    diagnostics: ctx?.archiveDiagnostics,
    collectEvidence: collectSourceOffloadEvidence,
    deleteSource: deleteConfirmedPublicationSource,
  })

  ownApiResource(ctx, 'api resource manager', { close: closeApiResources }, 'close', 5000)
  const api = {
    invalidateChannelCaches,
    ...publisherApi,
    ...mediaGraphApi,
    ...operabilityApi,
    ...scopedNetworkApi,
    ...archiveParticipationApi,
    ...createPairingApi({
      ctx,
      loadChannel: (_ctx, channelKey) => loadChannelBounded(channelKey),
      pairChannelDevice,
    }),
    ...createSeedingApi({ ctx, seedingManager, loadChannel, isSeedingAuthorizationError }),
    async setStorageLimit(maxGB) {
      if (!seedingManager || !Number.isFinite(Number(maxGB)) || Number(maxGB) < 0) {
        return { success: false, error: 'Invalid storage limit' }
      }
      const normalizedMaxGB = Math.min(100, Math.max(1, Number(maxGB)))
      const preview = seedingManager.previewStorageLimit({
        maxBytes: normalizedMaxGB * 1024 * 1024 * 1024,
      }, { ignoreTransientProtection: true })
      if (preview?.success === false || preview?.feasible === false) return { ...preview, success: false }
      if (normalizedMaxGB < Number(seedingManager.getMaxStorageGB?.() || 0)) {
        for (const key of Array.from(activeRangeRequests.keys())) await cleanupRangeRequest(key)
      }
      const result = await seedingManager.setMaxStorageGB(normalizedMaxGB, { authorized: true })
      if (result?.success === false || result?.feasible === false) return { ...result, success: false }
      return { success: true, ...result }
    },
    async clearCache() {
      for (const key of Array.from(activeRangeRequests.keys())) await cleanupRangeRequest(key)
      if (!seedingManager) return { success: false, clearedBytes: 0 }
      const result = await seedingManager.clearCache({ authorized: true })
      return { success: true, ...result }
    },
    assessSourceOffload(request = {}) {
      return sourceOffloadManager.createOffloadAssessment(request)
    },
    confirmSourceOffload(request = {}) {
      return sourceOffloadManager.confirmSourceOffload(request)
    },
    async getAvailabilityHints(requests = []) {
      const hints = []
      for (const req of requests) {
        const id = req?.id
        if (!id) continue
        const local = await (async () => {
          let coreOwnership = null
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
            assertApiContextRunning(ctx)
            const core = ctx.store.get({ key: keyBuf })
            coreOwnership = ownApiResource(ctx, 'availability probe core', core, 'close', 2000)
            await core.ready()
            assertApiContextRunning(ctx)
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
          } finally {
            try { await coreOwnership?.cleanup?.() } catch { /* best effort */ }
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
    async prefetchVideo(driveKey, videoPath, publicBeeKey = null) {
      markVideoPlayed(driveKey, videoPath)
      const prefetchKey = encodeIndexKey(driveKey || '', videoPath || '')
      const existing = prefetchInFlight.get(prefetchKey)
      if (existing) return existing

      const prefetchPromise = (async () => {
        if (ctx.store?.closed) return { success: false, error: 'Corestore is closed' }
        await cleanupRangeRequest(prefetchKey)

        const intent = await loadDownloadIntent(ctx, driveKey, videoPath)
        const video = intent ? null : await this.getVideoData(driveKey, videoPath, publicBeeKey)
        const blobsCoreKey = normalizeBlobsCoreKey(intent?.blobsCoreKey || video?.blobsCoreKey)
        const rawBlobId = intent?.blobId || video?.blobId
        const blob = normalizeBlobRefInput(rawBlobId) || parseBlobRef({ blobId: rawBlobId })?.blob
        if (!blobsCoreKey || !blob) return { success: false, error: 'Video missing blob metadata' }

        const normalizedBlobId = typeof rawBlobId === 'string'
          ? rawBlobId
          : stringifyBlobId(blob)
        const startBlock = blob.blockOffset
        const totalBlocks = blob.blockLength
        const endBlock = startBlock + totalBlocks
        const totalBytes = blob.byteLength || intent?.totalBytes || video?.size || video?.byteLength || 0
        if (!Number.isSafeInteger(startBlock) || !Number.isSafeInteger(totalBlocks) ||
            startBlock < 0 || totalBlocks <= 0 || !Number.isSafeInteger(endBlock)) {
          return { success: false, error: 'Invalid blob range' }
        }

        let core
        let coreOwnership
        await withSourceMutationLocks([blobsCoreKey], () => {
          core = ctx.store.get({ key: b4a.from(blobsCoreKey, 'hex') })
          coreOwnership = ownPrefetchCore(prefetchKey, core)
        })
        let releaseBlobRef = null
        let discoveryHandle = null
        const releasePrefetchGuards = () => {
          try { releaseBlobRef?.() } catch { /* best effort */ }
          releaseBlobRef = null
          try { discoveryHandle?.release?.() } catch { /* best effort */ }
          discoveryHandle = null
        }
        try {
          await core.ready()
          assertApiContextRunning(ctx)
          if (ctx.swarm && core.discoveryKey) {
            discoveryHandle = retainSwarmDiscovery(ctx, core.discoveryKey, {
              label: `prefetch:${blobsCoreKey.slice(0, 16)}`,
            })
          }
          await waitForBlobPrefetchReadiness(core, discoveryHandle, blobsCoreKey.slice(0, 16))

          if (!intent) {
            await saveDownloadIntent(ctx, {
              driveKey,
              videoPath,
              blobsCoreKey,
              blobId: normalizedBlobId,
              startBlock,
              endBlock,
              totalBlocks,
              totalBytes,
              mimeType: video?.mimeType || '',
              startedAt: Date.now(),
            })
          }

          const initialAvailable = await countInitialBlobBlocks(core, startBlock, endBlock, totalBlocks)
          const wasCached = initialAvailable === totalBlocks
          const bytesPerBlock = totalBlocks > 0 ? totalBytes / totalBlocks : 0
          let cachedBytes = wasCached ? totalBytes : 0
          const seedMetadata = {
            blockLength: totalBlocks,
            byteLength: cachedBytes,
            publicBeeKey: publicBeeKey || video?.publicBeeKey || intent?.publicBeeKey || null,
            blobId: normalizedBlobId,
            blobsCoreKey,
            thumbnailBlobId: video?.thumbnailBlobId || intent?.thumbnailBlobId || null,
            thumbnailBlobsCoreKey: video?.thumbnailBlobsCoreKey || intent?.thumbnailBlobsCoreKey || null,
            mimeType: video?.mimeType || intent?.mimeType || null,
            thumbnailMimeType: video?.thumbnailMimeType || intent?.thumbnailMimeType || null,
          }
          if (seedingManager) {
            await seedingManager.addSeed(
              driveKey,
              videoPath,
              'watched',
              seedMetadata,
              { protectSelf: true, protectedKeys: getActiveRangeSeedKeys() },
            )
          }

          if (videoStats) {
            videoStats.cleanupMonitor(driveKey, videoPath)
            videoStats.updateStats(driveKey, videoPath, {
              status: wasCached ? 'complete' : 'downloading',
              totalBlocks,
              totalBytes,
              initialBlocks: initialAvailable,
              downloadedBlocks: 0,
              peerCount: core.peers?.length || 0,
            })
            videoStats.emitStats(driveKey, videoPath, true)
          }

          if (wasCached) {
            await deleteDownloadIntent(ctx, driveKey, videoPath).catch(() => {})
            await coreOwnership.cleanup()
            return {
              success: true,
              totalBlocks,
              totalBytes,
              peerCount: core.peers?.length || 0,
              initialBlocks: initialAvailable,
              cached: true,
              message: 'Video already fully cached',
            }
          }

          if (seedingManager?.getQuotaBudget) {
            const budget = await Promise.resolve(seedingManager.getQuotaBudget()).catch(() => null)
            const remainingBytes = Math.max(0, totalBytes - cachedBytes)
            const promisedBytes = Array.from(prefetchQuotaReservations.values())
              .reduce((total, bytes) => total + bytes, 0)
            if (budget && !fullDownloadFitsQuota(
              Math.max(0, budget.headroomBytes - promisedBytes),
              remainingBytes,
            )) {
              await deleteDownloadIntent(ctx, driveKey, videoPath).catch(() => {})
              await coreOwnership.cleanup()
              return {
                success: true,
                totalBlocks,
                totalBytes,
                peerCount: core.peers?.length || 0,
                initialBlocks: initialAvailable,
                cached: false,
                message: 'Streaming within storage quota',
              }
            }
            if (budget && remainingBytes > 0) prefetchQuotaReservations.set(prefetchKey, remainingBytes)
          }

          if (seedingManager?.retainBlobRef) {
            releaseBlobRef = seedingManager.retainBlobRef({ blobsCoreKey, blobId: normalizedBlobId })
          }
          const downloaded = new Set()
          const onDownload = (index, byteLength) => {
            if (!Number.isSafeInteger(index) || index < startBlock || index >= endBlock || downloaded.has(index)) return
            downloaded.add(index)
            cachedBytes = Math.min(totalBytes, cachedBytes + (
              Number.isFinite(byteLength) && byteLength > 0 ? byteLength : bytesPerBlock
            ))
            void seedingManager?.updateSeedCachedBytes?.(driveKey, videoPath, Math.round(cachedBytes))
            if (videoStats) {
              videoStats.updateStats(driveKey, videoPath, {
                downloadedBlocks: downloaded.size,
                peerCount: core.peers?.length || 0,
                status: 'downloading',
                initialBlocks: initialAvailable,
              })
              videoStats.emitStats(driveKey, videoPath)
            }
          }
          const onUpload = () => {
            if (!videoStats) return
            videoStats.updateStats(driveKey, videoPath, { peerCount: core.peers?.length || 0 })
            videoStats.emitStats(driveKey, videoPath)
          }
          core.on?.('download', onDownload)
          core.on?.('upload', onUpload)

          const range = core.download({ start: startBlock, end: endBlock, linear: true })
          const timers = new Set()
          const cleanup = async () => {
            await cleanupRangeRequest(prefetchKey)
          }
          activeRangeRequests.set(prefetchKey, {
            ranges: [range],
            timers,
            core,
            onDownload,
            onUpload,
            driveKey,
            videoPath,
            seedKey: `${driveKey}:${videoPath}`,
            release: releasePrefetchGuards,
            cancel: () => {
              try { range.destroy?.() } catch { /* best effort */ }
            },
          })
          Promise.resolve(range.done()).then(async completed => {
            if (completed === false) return cleanup()
            await deleteDownloadIntent(ctx, driveKey, videoPath).catch(() => {})
            if (seedingManager) {
              await seedingManager.addSeed(
                driveKey,
                videoPath,
                'watched',
                { ...seedMetadata, byteLength: totalBytes },
                { protectSelf: true, protectedKeys: getActiveRangeSeedKeys() },
              )
            }
            if (videoStats) {
              videoStats.updateStats(driveKey, videoPath, { status: 'complete', downloadedBlocks: totalBlocks })
              videoStats.emitStats(driveKey, videoPath, true)
            }
            await cleanup()
          }).catch(async error => {
            console.log('[API] Prefetch range failed:', error?.message || error)
            await cleanup()
          })

          return {
            success: true,
            totalBlocks,
            totalBytes,
            peerCount: core.peers?.length || 0,
            initialBlocks: initialAvailable,
            cached: false,
            message: 'Prefetch started',
          }
        } catch (error) {
          console.log('[API] Prefetch setup failed:', error?.message || error)
          releasePrefetchGuards()
          await cleanupRangeRequest(prefetchKey)
          await coreOwnership.cleanup()
          return { success: false, error: error?.message || 'Prefetch failed' }
        }
      })()

      prefetchInFlight.set(prefetchKey, prefetchPromise)
      try {
        return await prefetchPromise
      } finally {
        prefetchInFlight.delete(prefetchKey)
      }
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

    async getContentCatalog(request = {}) {
      try {
        const resolved = await resolveCatalogChannel(request)
        const data = await readCatalogData(resolved, { includePresentation: true })
        const catalog = buildChannelCatalog({
          channelKey: resolved.channelKey,
          profile: data.profile,
          sources: data.sources,
          artwork: data.artwork,
          videos: data.videos,
        })
        await markAsMultiWriterChannel(resolved.channelKey)
        return {
          success: true,
          profile: catalog.profile,
          groups: catalog.groups,
        }
      } catch (error) {
        return catalogFailureResponse(error, 'groups')
      }
    },

    async getContentItems(request = {}) {
      try {
        const groupId = request?.groupId
        if (!isCatalogKey(groupId) || b4a.byteLength(groupId) > 64) {
          throwCatalogError('INVALID_CATALOG_INPUT', 'Catalog item request requires groupId')
        }
        const resolved = await resolveCatalogChannel(request)
        const data = await readCatalogData(resolved)
        const page = buildCatalogGroupPage({
          channelKey: resolved.channelKey,
          publicBeeKey: resolved.publicBeeKey ?? undefined,
          profile: data.profile,
          videos: data.videos,
          groupId,
          cursor: request.cursor ?? undefined,
          limit: normalizeCatalogRequestLimit(request),
        })
        await markAsMultiWriterChannel(resolved.channelKey)
        return {
          success: true,
          group: page.group,
          items: page.items,
          nextCursor: page.nextCursor,
        }
      } catch (error) {
        return catalogFailureResponse(error, 'items')
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
     * derived from local graph snapshots/previews when available instead of
     * calling listVideos(), which duplicates expensive PublicBee/channel reads.
     * @param {string} driveKey
     * @returns {Promise<ChannelMetadata>}
     */
    async getChannelMeta(driveKey, publicBeeKey = null) {
      if (driveKey && typeof driveKey === 'object') {
        publicBeeKey = driveKey.publicBeeKey || publicBeeKey
        driveKey = driveKey.channelKey || driveKey.driveKey || driveKey.key || null
      }
      console.log('[API] GET_CHANNEL_META:', driveKey?.slice?.(0, 16));
      try {
        const cached = channelMetaCache.get(driveKey)
        if (cached && (Date.now() - cached.ts) < CHANNEL_META_CACHE_TTL_MS) {
          return cloneObject(cached.value)
        }
        // Fast catalog path: if publicBeeKey is provided, don't load Autobase.
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
            videoCount: Number.isSafeInteger(meta?.videoCount) ? meta.videoCount : 0
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
          videoCount: Number.isSafeInteger(meta?.videoCount) ? meta.videoCount : 0
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
          let coreOwnership = null
          try {
            assertApiContextRunning(ctx)
            const keyBuf = b4a.from(normalizeBlobsCoreKey(blobsCoreKey) || blobsCoreKey, 'hex')
            const core = ctx.store.get({ key: keyBuf })
            coreOwnership = ownApiResource(ctx, 'feed availability core', core, 'close', 2000)
            await core.ready()
            assertApiContextRunning(ctx)

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
          } finally {
            try { await coreOwnership?.cleanup?.() } catch { /* best effort */ }
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


          return cloned.map((video, index) => {
            const localHint = localHints[index]
            const peerHint = null
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
        if (cached && !publicBeeKey) {
          const ttl = Array.isArray(cached.value) && cached.value.length === 0
            ? LIST_VIDEOS_EMPTY_CACHE_TTL_MS
            : LIST_VIDEOS_CACHE_TTL_MS
          if ((Date.now() - cached.ts) < ttl) {
            const revalidated = await attachVideoAvailability(cloneArrayOfObjects(cached.value))
            return cloneArrayOfObjects(revalidated)
          }
        }

        // FAST PATH: If publicBeeKey is provided, read directly from PublicBee
        // This is the preferred path for remote catalog readers; no Autobase sync is needed.
        // IMPORTANT: If publicBeeKey is provided, this is definitely a multi-writer channel,
        // so we should not fall back to legacy storage paths.
        if (publicBeeKey) {
          console.log('[API] LIST_VIDEOS: using PublicBee fast path')
          // Mark as multi-writer since PublicBee is only used with multi-writer channels
          await markAsMultiWriterChannel(driveKey)
          try {
            const publicBee = await loadPublicBee(ctx, publicBeeKey)
            let listing
            try {
              listing = typeof publicBee.listVideosWithStatus === 'function'
                ? await publicBee.listVideosWithStatus()
                : { status: 'authoritative', videos: await publicBee.listVideos() }
            } catch (readErr) {
              console.log('[API] LIST_VIDEOS: PublicBee visibility is uncertain:', readErr.message)
              return []
            }
            const videos = listing?.videos || []
            console.log('[API] LIST_VIDEOS: PublicBee returned', videos.length, 'videos')
            if (videos.length === 0) {
              if (listing?.status !== 'authoritative' || Number(listing?.filteredCount || 0) > 0) {
                console.log('[API] LIST_VIDEOS: PublicBee visibility is uncertain, suppressing preview fallback')
                return []
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
            const publicListing = await listPublicBeeVideosBounded({
              publicBee: channel.publicBee,
              driveKey,
              publicBeeKey: channel.publicBeeKey || null,
              timeoutMs: 1200,
            })
            const publicBeeVideos = publicListing.videos || []
            if (publicBeeVideos.length > 0) {
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

    getVideoStats(driveKey, videoPath) {
      const tracked = videoStats?.getStats?.(driveKey, videoPath) || {}
      const core = getVideoCorePeerDetails(driveKey, videoPath)
      const hasCoreDetails = core.peerCount > 0 || core.blobPeerIds.length > 0 || core.blobCoreKey != null
      return {
        ...tracked,
        ...(hasCoreDetails ? core : {
          peerCount: tracked.peerCount || 0,
          blobPeerIds: tracked.blobPeerIds || [],
          blobCoreKey: tracked.blobCoreKey || null,
        }),
        swarmConnections: ctx?.swarm?.connections?.size || 0,
      }
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
    async preparePlayback(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType, sourceMutationLocked = false) {
      const playbackBlobRef = resolvePlaybackBlobRef(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType)
      const sourceCoreKey = playbackBlobRef?.blobsCoreKey || blobsCoreKey
      if (!sourceMutationLocked && sourceCoreKey) {
        return withSourceMutationLocks(
          [sourceCoreKey],
          () => this.preparePlayback(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType, true)
        )
      }
      console.log('[API] preparePlayback:', driveKey?.slice(0, 16), videoPath)
      markVideoPlayed(driveKey, videoPath)
      const startedAt = Date.now()
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

    ...createStatusApi({ ctx, recentPlaybackTimings }),
    ...createLiveApi({ ctx }),

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
      let coreOwnership = null
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
        assertApiContextRunning(ctx)
        const blobsCore = ctx.store.get(blobEntry.blobsKey);
        coreOwnership = ownApiResource(ctx, 'video download core', blobsCore, 'close', 2000)
        await blobsCore.ready();
        assertApiContextRunning(ctx)

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
      } finally {
        try { await coreOwnership?.cleanup?.() } catch { /* best effort */ }
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
          const result = await getPublicBeeVideoWithStatus(publicBee, id)
          const v = result.video
          console.log('[API] GET_VIDEO_DATA PublicBee result:', v?.id, 'status:', result.status, 'blobId:', v?.blobId, 'blobsCoreKey:', v?.blobsCoreKey?.slice(0, 16))
          if (result.status === 'found' && v) return { ...v, channelKey: driveKey }
          if (result.status !== 'notFound') {
            console.log('[API] GET_VIDEO_DATA: public visibility is uncertain or suppressed, skipping stale fallbacks')
            return null
          }
          // Fall through to feed previews/channel methods only for authoritative absence
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
        assertApiContextRunning(ctx)
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
          let blobsCoreOwnership = null;
          try {
            assertApiContextRunning(ctx)
            blobsCore = ctx.store.get(keyBuffer);
            blobsCoreOwnership = ownApiResource(
              ctx,
              `thumbnail blob core ${meta.thumbnailBlobsCoreKey.slice(0, 16)}`,
              blobsCore,
              'close',
              2000
            );
            await blobsCore.ready();
            assertApiContextRunning(ctx)
          } catch (storeErr) {
            await blobsCoreOwnership?.cleanup?.();
            console.error('[API] GET_VIDEO_THUMBNAIL: store.get/ready failed:', storeErr.message);
            throw storeErr;
          }

          // Join swarm for thumbnail core
          if (ctx.swarm && blobsCore.discoveryKey) {
            try {
              retainSwarmDiscovery(ctx, blobsCore.discoveryKey, {
                label: `thumbnail:${meta.thumbnailBlobsCoreKey.slice(0, 16)}`
              })
            } catch { /* best effort */ }
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
          assertApiContextRunning(ctx)
          if (!thumbnailLocal) {
            if (opts?.ensureLocal) {
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
              assertApiContextRunning(ctx)
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
              assertApiContextRunning(ctx)
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

    // Subscription Operations
    ...createSubscriptionsApi({ ctx, loadChannel }),

    ...createPersonalApi({ ctx }),

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
      // Locally staged descriptors can advance between calls. Re-read the
      // channel boundary instead of serving an indefinitely stale positive.

      let value = null
      try {
        const storedIdentities = typeof ctx.metaDb?.get === 'function'
          ? await ctx.metaDb.get('identities').catch(() => null)
          : null
        const identities = storedIdentities?.value || []
        const ownedIdentity = identities.find((identity) =>
          identity?.channelKey === driveKey || identity?.driveKey === driveKey)
        const loadOptions = ownedIdentity?.deferPublicProjection === true
          ? { deferPublicProjection: true }
          : undefined
        const channel = await loadChannelBounded(driveKey, 2500, loadOptions)
        const root = typeof channel?.publicBee?.getRootDescriptor === 'function'
          ? await channel.publicBee.getRootDescriptor().catch(() => null)
          : null
        const staged = typeof channel?.getStagedPublicProjection === 'function'
          ? channel.getStagedPublicProjection()?.stagedDescriptor || null
          : null
        const signed = compareSignedChannelRootDescriptors(staged, root) > 0 ? staged : root
        if (signed) {
          const verified = await verifySignedChannelRootDescriptor(signed)
          if (verified?.valid && verified.descriptor?.channelId === driveKey.toLowerCase()) {
            value = signed
          }
        }
      } catch { /* unavailable channels simply stay unsigned */ }

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

      // Unset season/episode default to Number.MAX_SAFE_INTEGER in HyperDB
      // storage; treat the sentinel (and any non-positive value) as absent.
      const boundedContentInt = (value) => {
        const n = Number(value)
        return Number.isInteger(n) && n > 0 && n < Number.MAX_SAFE_INTEGER ? n : null
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
                contentKind: video?.contentKind ? String(video.contentKind) : null,
                seasonNumber: boundedContentInt(video?.seasonNumber),
                episodeNumber: boundedContentInt(video?.episodeNumber),
                mediaProvider: video?.mediaProvider ? String(video.mediaProvider) : null,
                mediaId: video?.mediaId ? String(video.mediaId) : null,
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


    // Recommendations Operations
    ...createRecommendationsApi({
      ctx,
      ensureSemanticFinder,
      isMultiWriterChannelKey,
      loadChannel,
    }),

    // Network Lifecycle Management
    ...createNetworkLifecycleApi({
      onPlaybackActive: cancelScheduledQuotaSweep,
      onPlaybackInactive: scheduleQuotaSweepAfterPlayback,
      networkPolicyRuntime,
    }),
    // Local policy controls
    ...localPolicyApi,
  };
  return api
}
