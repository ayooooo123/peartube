import b4a from 'b4a'

import {
  DEFAULT_OFFLOAD_WINDOW_BYTES,
  createBlockOffloader,
  createOffloadStorage,
  createRemoteBlockStore,
  createS3ArchiveProvider
} from '@peartube/backend/archive'
import { ASSET_BLOCK_SIZE } from '@peartube/backend/assets'
import { isBlockPlaybackPinned } from '@peartube/backend/blob-range-priority'

import { boundedIngestBytes } from '../storage-guard.js'
import runtimeFetch from '#fetch'
import process from '#process'
// Relay-side wiring for block offload. The mechanism lives in the backend:
//   * archive/block-offloader.js  puts a block in the bucket and drops the
//     local copy once the bucket confirms it holds it,
//   * archive/remote-block-store.js  addresses and verifies one block,
//   * archive/offload-storage.js  brings an offloaded block back on a local
//     miss, so `core.has()` and `core.proof()` answer an authorized peer
//     exactly as they did before — and holds each offload-backed core's local
//     block data to the same window, so blocks that come back do not silently
//     turn the bucket back into a copy of the volume.
//
// This module is the operator's side of it: turn the resolved relay config into
// the two things the backend needs — a storage wrapper for the read path and an
// asset hook for the write path — or nothing at all when offload is off.

// Offload that is asked for and cannot work is refused, never downgraded to
// local-only.
const REQUIRED_S3_OFFLOAD_FIELDS = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']

function missingFields (fields, section) {
  return fields.filter((field) => !(typeof section?.[field] === 'string' && section[field].trim()))
}

function keyHexOf (core) {
  const key = core?.key
  if (!b4a.isBuffer(key) || key.byteLength !== 32) {
    throw new Error('block offload needs a ready core with a 32-byte public key')
  }
  return b4a.toString(key, 'hex')
}



// A usable resident window, or the default. Only a number or a numeric string
// counts as the operator having said one: `null`, `undefined`, `''`, a boolean
// and anything unparseable all mean "not configured", and must NOT collapse to
// 0 — which is a real setting that offloads every tracked block.
function resolveWindowBytes (value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_OFFLOAD_WINDOW_BYTES
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_OFFLOAD_WINDOW_BYTES
  }
  return DEFAULT_OFFLOAD_WINDOW_BYTES
}

/**
 * Build the relay's block offload, or return null when the operator has not
 * asked for it.
 *
 * Throws when offload is enabled and S3 is only half configured. That is
 * deliberate: the alternative is a relay that quietly keeps every block on
 * the volume the operator was trying to stop filling.
 */

export async function createRelayBlockOffload ({
  config,
  logger = null,
  fetchImpl = runtimeFetch || globalThis.fetch,
  createSigner = null
} = {}) {
  const settings = config?.archive?.s3 || {}
  if (settings.offload !== true) return null

  const missing = missingFields(REQUIRED_S3_OFFLOAD_FIELDS, settings)
  if (missing.length) {
    throw new Error(`archive.s3.offload is enabled but archive.s3 is incomplete: missing ${missing.join(', ')}`)
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('archive.s3.offload is enabled but this runtime has no fetch implementation')
  }

  // One window, validated once, because three different consumers read it and
  // they must agree: the offloader enforces it, the residency sweep bounds
  // itself by it, and `localWorkingBytes` reserves disk against it. Only the
  // offloader validated its own argument, so an unusable configured value left
  // it quietly working to the default while reporting and admission carried the
  // raw value — a relay enforcing one number and reserving disk against another.
  //
  // Presence and type are checked BEFORE any coercion, and that order is the
  // whole point: `Number(null)` is 0, and 0 is a legitimate setting meaning
  // offload every tracked block. Coercing first therefore turns a JSON null —
  // an absent value — into the most aggressive retention policy the relay has,
  // silently. A numeric string is accepted on purpose, because a config file or
  // an environment variable is a perfectly ordinary way to say 8388608.
  const windowBytes = resolveWindowBytes(settings.offloadWindowBytes)
  const readAheadBlocks = 15
  const restoreCacheBytes = 64 * 1024 * 1024
  const prefix = typeof settings.prefix === 'string' ? settings.prefix : ''

  let sign = createSigner
  if (typeof sign !== 'function') {
    const { createS3Signer } = await import('../s3-signer.js')
    sign = createS3Signer(settings)
  }
  const objectStore = createS3ArchiveProvider({ fetch: fetchImpl, sign })
  const bucket = settings.bucket
  const log = (message) => {
    if (/MISSING|unreachable/.test(String(message))) logger?.archive?.warn?.(message)
    else logger?.archive?.debug?.(message)
  }

  let offloadStats = () => ({ restored: 0, eviction: null })
  // Cores the operator's data lives in rather than media blocks. Offload moves
  // block DATA to the bucket and keeps only the merkle tree and bitfield on
  // disk, which is right for a 50 GB title and wrong for the metadata core: it
  // holds the acquisition ledger, accounting and settings, it is small, and
  // every read of it would otherwise depend on a remote bucket. A core is
  // excluded by key once the storage layer knows it.
  const excluded = new Set()
  // Sweeps run unless a caller explicitly holds them. The storage layer holds
  // while it opens the cores that stay on this volume, because opening a core
  // arms its residency ledger and a sweep in that window would evict exactly
  // the blocks the registration protects. Open by default so a consumer that
  // never registers anything can never hang waiting for a release.
  let evictionReady = null
  let openEviction = null
  const storeFor = (coreKey) => createRemoteBlockStore({ provider: objectStore, prefix, coreKey })

  const rawConcurrency = Number(settings.uploadConcurrency || process?.env?.PEARTUBE_ARCHIVE_UPLOAD_CONCURRENCY || 16)
  const uploadConcurrency = Number.isSafeInteger(rawConcurrency) && rawConcurrency > 0 ? rawConcurrency : 16

  return {
    enabled: true,
    windowBytes,
    uploadConcurrency,
    prefix,
    bucket,

    /**
     * Keep a core's blocks on this volume. The storage layer calls this for the
     * cores that hold operational state rather than media, before any of their
     * blocks can be evicted.
     */
    excludeCore (coreKey) {
      if (typeof coreKey === 'string' && coreKey.length === 64) excluded.add(coreKey.toLowerCase())
    },
    isExcluded (coreKey) {
      return typeof coreKey === 'string' && excluded.has(coreKey.toLowerCase())
    },
    /**
     * Hold every sweep until `startEviction` releases it. Called by the storage
     * layer before it opens the cores it will register as keep-local, so no
     * sweep can run against a list that is not complete yet. Re-entrant calls
     * keep the existing hold rather than opening a second one.
     */
    holdEviction () {
      if (evictionReady !== null) return
      evictionReady = new Promise(resolve => { openEviction = resolve })
    },
    /**
     * Every keep-local core is registered; sweeps may run.
     */
    startEviction () {
      openEviction?.()
      openEviction = null
      evictionReady = null
    },
    /**
     * Local working space a bounded ingest of `streamBytes` needs on this
     * volume: the window it keeps resident plus the two blocks in flight plus
     * the merkle bookkeeping neither the window nor the bucket holds. Never the
     * size of the title — that is the whole point of the window — so the
     * archive download guard sizes its requirement with this instead.
     */
    localWorkingBytes (streamBytes = 0) {
      return boundedIngestBytes({ windowBytes, blockBytes: ASSET_BLOCK_SIZE, streamBytes })
    },

    /**
     * Wraps the CorestoreStorage so a local block miss is answered from the
     * bucket, verified against the core's own merkle tree — and so each
     * offload-backed core's local block data stays inside the same window it
     * was ingested under, however it grew back.
     *
     * `resolveStore` answers for every core with a real public key rather than
     * for a remembered set of offloaded ones. A remembered set would be
     * in-memory state, so the first restart would blind the relay to every
     * block it had already offloaded. The cost of answering for all of them is
     * bounded: offload-storage.js only reaches the bucket for a block the core
     * has a merkle leaf for and does not hold locally, which is exactly an
     * offloaded block, and a stray 404 costs one HEAD-shaped GET.
     */
    wrapStorage (storage) {
      const wrapped = createOffloadStorage({
        storage,
        readAheadBlocks,
        restoreCacheBytes,
        // Every core still resolves a store, so a block already in the bucket
        // is always restorable. Excluded cores are held back from eviction
        // instead, which lets their blocks come home and stay home.
        resolveStore: ({ keyHex }) => (
          typeof keyHex === 'string' && keyHex.length === 64 ? storeFor(keyHex) : null
        ),
        eviction: {
          windowBytes,
          // Playback interest, per block. `blob-range-priority.js` holds the
          // exact block range each active player is blocking on, and the
          // backend runs in this process, so this reads the same registry the
          // blob server writes into — no second model of the playhead.
          isPinned: ({ keyHex, index }) => isBlockPlaybackPinned(keyHex, index),
          // The operator's keep-local list, read per sweep and only once any
          // hold has been released. Restore still answers for these cores;
          // nothing sweeps them.
          isEvictable: async ({ keyHex }) => {
            if (evictionReady !== null) await evictionReady
            return !excluded.has(String(keyHex).toLowerCase())
          }
        },
        log
      })
      offloadStats = wrapped.offloadStats
      return wrapped
    },

    /**
     * Bounded/streaming ingest. The writer drives this offloader once per
     * canonical block, so local residency never follows the title size.
     */
    createOffloader ({ core }) {
      return createBlockOffloader({
        core,
        store: storeFor(keyHexOf(core)),
        windowBytes,
        log
      })
    },

    /**
     * Where a streaming ingest parks blocks it has read but cannot keep: the
     * staging core's own keyspace in the bucket. The writer restores from here
     * on its second pass and purges the keys once the finished core verifies,
     * so nothing outlives the archive that produced it.
     */
    createStagingStore ({ core }) {
      return storeFor(keyHexOf(core))
    },

    /**
     * Process-local residency and restore activity. Durable S3 inventory is
     * deliberately not inferred from counters that reset on restart or include
     * temporary staging objects.
     */
    stats () {
      const offload = offloadStats()
      const eviction = offload.eviction || null
      return {
        enabled: true,
        windowBytes,
        restored: offload.restored,
        residentBytes: eviction === null ? 0 : eviction.residentBytes,
      }
    }
  }
}
