import b4a from 'b4a'

import {
  DEFAULT_OFFLOAD_WINDOW_BYTES,
  createBlockOffloader,
  createGoogleDriveArchiveProvider,
  createMegaArchiveProvider,
  createOffloadStorage,
  createRemoteBlockStore,
  createS3ArchiveProvider
} from '@peartube/backend/archive'
import { ASSET_BLOCK_SIZE } from '@peartube/backend/assets'
import { isBlockPlaybackPinned } from '@peartube/backend/blob-range-priority'

import { ARCHIVE_OFFLOAD_PROVIDERS, ARCHIVE_OFFLOAD_PROVIDER_SECTIONS, DEFAULT_ARCHIVE_OFFLOAD_PROVIDER } from '../constants.js'
import { boundedIngestBytes } from '../storage-guard.js'

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

// What each backend cannot run without. Same rule for all three: offload that
// is asked for and cannot work is refused, never downgraded to local-only.
const REQUIRED_FIELDS = {
  s3: ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'],
  'google-drive': ['accessToken', 'folderId'],
  mega: ['session', 'folder']
}

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

/**
 * Per-block byte lengths of a canonical static asset, straight from its
 * descriptor. Every block is `blockSize` except the last, which is the
 * remainder. Reading each block back just to measure it would be the one extra
 * pass over the whole title that the window exists to avoid.
 */
function assetBlockLength (descriptor, index) {
  const blockSize = Number(descriptor.blockSize)
  const byteLength = Number(descriptor.byteLength)
  return Math.min(blockSize, byteLength - (index * blockSize))
}

/**
 * Which object store the operator selected, and the config section holding its
 * credentials. The config loader normalizes `archive.provider`, but this is
 * also handed hand-built config objects, so an unknown name is refused here
 * too: falling back to S3 would offload someone's blocks to a store they did
 * not name.
 */
function selectProvider (archive) {
  const raw = typeof archive.provider === 'string' ? archive.provider.trim() : ''
  const name = raw || DEFAULT_ARCHIVE_OFFLOAD_PROVIDER
  const section = ARCHIVE_OFFLOAD_PROVIDER_SECTIONS[name]
  if (!section) {
    throw new Error(`archive.provider must be one of ${ARCHIVE_OFFLOAD_PROVIDERS.join(', ')} (got "${name}")`)
  }
  return { name, section, config: archive[section] || {} }
}

/**
 * Build the relay's block offload, or return null when the operator has not
 * asked for it.
 *
 * Throws when offload is enabled and the selected store is only half
 * configured. That is deliberate: the alternative is a relay that quietly keeps
 * every block on the volume the operator was trying to stop filling.
 */
export async function createRelayBlockOffload ({
  config,
  logger = null,
  fetchImpl = globalThis.fetch,
  createSigner = null
} = {}) {
  const archive = config?.archive || {}
  const selected = selectProvider(archive)
  const settings = selected.config
  if (settings.offload !== true) return null

  const missing = missingFields(REQUIRED_FIELDS[selected.name], settings)
  if (missing.length) {
    throw new Error(`archive.${selected.section}.offload is enabled but archive.${selected.section} is incomplete: missing ${missing.join(', ')}`)
  }
  // S3 is also an archive STORAGE tier, and that tier has its own switch. The
  // other two backends exist only for offload, so they have no such flag to
  // contradict.
  if (selected.name === 's3' && settings.enabled === false) {
    throw new Error('archive.s3.offload is enabled but archive.s3.enabled is false')
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error(`archive.${selected.section}.offload is enabled but this runtime has no fetch implementation`)
  }

  const windowBytes = Number(settings.offloadWindowBytes)
  // The read path's bound must be the same number as the ingest path's window,
  // including when the operator's is unusable: the offloader falls back to its
  // own default rather than keeping everything, so this falls back with it.
  const residentWindowBytes = Number.isSafeInteger(windowBytes) && windowBytes >= 0
    ? windowBytes
    : DEFAULT_OFFLOAD_WINDOW_BYTES
  const prefix = typeof settings.prefix === 'string' ? settings.prefix : ''

  // Everything below this block is provider-blind: the three factories return
  // the same five methods, so the offloader, the remote block store and the
  // read path cannot tell which one they were handed. The only per-provider
  // work is turning config into one of them, plus naming the container the
  // blocks land in — a bucket, a Drive folder id or a Mega folder handle — so
  // the operator's log line says where its data went. `bucket` is that name and
  // nothing else: no token, session or key is carried out of here.
  let objectStore = null
  let bucket = ''
  if (selected.name === 's3') {
    let sign = createSigner
    if (typeof sign !== 'function') {
      // The SigV4 signer is Node-only (node:crypto). Say so rather than letting a
      // module resolution failure be the operator's first clue.
      if (!globalThis.process?.versions?.node) {
        throw new Error('archive.s3.offload is enabled but S3 request signing needs the Node runtime')
      }
      const { createS3Signer } = await import('../s3-signer.js')
      sign = createS3Signer(settings)
    }
    bucket = settings.bucket
    objectStore = createS3ArchiveProvider({ fetch: fetchImpl, sign, bucket, prefix })
  } else if (selected.name === 'google-drive') {
    bucket = settings.folderId
    objectStore = createGoogleDriveArchiveProvider({
      fetch: fetchImpl,
      accessToken: settings.accessToken,
      folderId: bucket,
      prefix,
      filesEndpoint: settings.filesEndpoint,
      uploadEndpoint: settings.uploadEndpoint
    })
  } else {
    bucket = settings.folder
    objectStore = createMegaArchiveProvider({
      fetch: fetchImpl,
      session: settings.session,
      folder: bucket,
      prefix,
      apiUrl: settings.apiUrl
    })
  }
  const log = (message) => logger?.archive?.debug?.(message)

  let blocksOffloaded = 0
  let bytesOffloaded = 0
  // Block data written to the object store, counted where every write passes
  // through rather than where residency is decided. The two are different
  // questions and conflating them cost an afternoon: a streaming ingest uploads
  // each staged block here, and those uploads are purged when the finished core
  // supersedes them, so they never appear in `blocksOffloaded`. A relay hours
  // into a multi-GB archive had genuinely moved gigabytes into the bucket while
  // reporting `blocksOffloaded: 0`, which reads as a bucket receiving nothing.
  // `uploaded*` answers "is anything arriving"; `*Offloaded` answers "is this
  // bucket holding block data the volume no longer has to".
  let uploadedBlocks = 0
  let uploadedBytes = 0
  let offloadStats = () => ({ restored: 0, missing: 0, failed: 0, corrupt: 0 })

  function storeFor (coreKey) {
    const store = createRemoteBlockStore({ provider: objectStore, prefix, coreKey })
    return {
      ...store,
      async put (blockIndex, data) {
        const result = await store.put(blockIndex, data)
        // Counted after the put resolves, so this reports what the bucket
        // accepted rather than what was attempted.
        uploadedBlocks++
        uploadedBytes += data?.byteLength ?? 0
        return result
      }
    }
  }

  return {
    enabled: true,
    windowBytes,
    prefix,
    // The two things an operator's log line needs to say where block data goes,
    // and the only two this module will hand out: the backend's name and the
    // container inside it.
    provider: selected.name,
    bucket,

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
        resolveStore: ({ keyHex }) => (
          typeof keyHex === 'string' && keyHex.length === 64 ? storeFor(keyHex) : null
        ),
        eviction: {
          windowBytes: residentWindowBytes,
          // Playback interest, per block. `blob-range-priority.js` holds the
          // exact block range each active player is blocking on, and the
          // backend runs in this process, so this reads the same registry the
          // blob server writes into — no second model of the playhead.
          isPinned: ({ keyHex, index }) => isBlockPlaybackPinned(keyHex, index)
        },
        log
      })
      offloadStats = wrapped.offloadStats
      return wrapped
    },

    /**
     * The writeStaticAsset hook. Declares every block of the finished asset
     * oldest-first, then offloads from the oldest end until what is left
     * resident is within the window.
     */
    async offloadAsset ({ core, descriptor }) {
      const offloader = createBlockOffloader({
        core,
        store: storeFor(keyHexOf(core)),
        windowBytes,
        log
      })
      for (let index = 0; index < descriptor.length; index++) {
        offloader.track(index, assetBlockLength(descriptor, index))
      }
      const result = await offloader.drain()
      blocksOffloaded += result.blocksOffloaded
      bytesOffloaded += result.bytesOffloaded
      if (result.blocksOffloaded > 0) {
        logger?.archive?.info?.('Offloaded asset block data', {
          provider: selected.name,
          assetId: descriptor.assetId,
          blocks: result.blocksOffloaded,
          bytes: result.bytesOffloaded,
          residentBytes: result.residentBytes,
          windowBytes
        })
      }
      return result
    },

    /**
     * Bounded/streaming ingest. `offloadAsset` above runs ONCE on a finished
     * core; this hands the writer an offloader it drives per block, so block
     * data leaves the volume as it arrives instead of after the whole title
     * has landed. Same offloader, same window - only the caller's cadence
     * differs. `drain` is wrapped so the relay's totals count every block that
     * leaves during an ingest, not just the ones offloadAsset moved.
     */
    createOffloader ({ core }) {
      const offloader = createBlockOffloader({
        core,
        store: storeFor(keyHexOf(core)),
        windowBytes,
        log
      })
      // An offloader's stats are CUMULATIVE, and the bounded ingest path drains
      // once per block, so adding each drain's totals counts every offloaded
      // block again for every drain that follows it - quadratic in the length of
      // the title, which for a feature-length archive is millions of blocks and
      // terabytes claimed for a few gigabytes moved. Only the difference a drain
      // made belongs to the relay's totals.
      let countedBlocks = 0
      let countedBytes = 0
      return {
        // The writer reports the window its ingest was bounded by, and it reads
        // it off the offloader it was handed.
        windowBytes: offloader.windowBytes,
        track: (index, byteLength) => offloader.track(index, byteLength),
        stats: () => offloader.stats?.(),
        async drain () {
          const result = await offloader.drain()
          blocksOffloaded += result.blocksOffloaded - countedBlocks
          bytesOffloaded += result.bytesOffloaded - countedBytes
          countedBlocks = result.blocksOffloaded
          countedBytes = result.bytesOffloaded
          return result
        }
      }
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
     * What an operator needs to see: how much block data has left the volume,
     * how much came back, and — the number that says whether this bucket is a
     * storage extension or just a one-time saving — how much block data the
     * offload-backed cores are holding locally right now, against the window
     * they are held to.
     *
     * `residentBytes` is what each offload-backed core's last sweep left, with
     * the retained window counted at the size its merkle tree says it is rather
     * than re-read to be measured. So it is a ceiling per swept core, and a
     * core opened but not yet swept is not in it yet.
     */
    stats () {
      const offload = offloadStats()
      const eviction = offload.eviction || null
      return {
        enabled: true,
        windowBytes,
        blocksOffloaded,
        bytesOffloaded,
        uploadedBlocks,
        uploadedBytes,
        restored: offload.restored,
        residentBytes: eviction === null ? 0 : eviction.residentBytes,
        blocksEvicted: eviction === null ? 0 : eviction.evicted,
        bytesEvicted: eviction === null ? 0 : eviction.bytesEvicted,
        playbackPinned: eviction === null ? 0 : eviction.pinned,
        residencySweeps: eviction === null ? 0 : eviction.sweeps
      }
    }
  }
}
