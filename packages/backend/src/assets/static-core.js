import b4a from 'b4a'
import Hypercore from 'hypercore'
import crypto from 'hypercore-crypto'

import {
  normalizeBytes,
  normalizeNonNegativeInteger,
} from '../publisher/canonical.js'

export const ASSET_BLOCK_SIZE = 256 * 1024

// How many of pass 1's staged uploads may be in the air at once.
//
// One meant the download was stopped for the whole of every upload: measured
// against an object store with a realistic round trip, the source spent 94% of
// pass 1 handed nothing to read while a 256 KiB block went to the bucket and
// came back confirmed, and only 6% being hashed and appended. A held HTTP
// response drains at the rate its consumer asks for it, so that is not an
// upload cost, it is the archive's throughput.
//
// It cannot be unbounded. A block's local copy is the only copy until the
// object store confirms the object (see offloadStagedBlock), so N uploads in
// flight is N block copies on local disk and N in memory — which is the title
// again if N is allowed to follow it.
//
// Eight is where that trade sits. Hiding the round trip completely would take
// round-trip over local-work, which on the same measurement is 1026ms over
// 67ms — about fifteen in flight — and the last few of those buy progressively
// less while asking progressively more of the provider and of the operator's
export const STAGING_UPLOAD_CONCURRENCY = 8

const STATIC_ASSET_KIND = 'static-prologue-v1'

// --- resumable streaming ingest --------------------------------------------
//
// A one-shot source read is the most expensive thing in this file: a 4K title
// is tens of gigabytes over somebody's line, and an interruption forty minutes
// in used to throw all of it away. It does not have to. The staging core's
// merkle tree IS the record of what has been read, and the staging objects ARE
// the bytes, so a resume only has to find out how much of that is durable and
// ask the source for the rest.
//
// The staging core is addressed by a name derived from the caller's stable
// resume id, and Corestore derives that core's key pair deterministically from
// its own on-disk primary key. So the staging core — tree, length, byte length
// and the identity record below — is reachable again after a relay restart with
// nothing whatsoever held in memory.
const STAGING_NAME_PREFIX = 'asset-staging-'
const STAGING_IDENTITY_KEY = 'peartube.asset.staging.v1'
const STAGING_IDENTITY_VERSION = 1

// A day. Long enough that a multi-hour title interrupted overnight is still
// resumable in the morning; short enough that a job nobody ever retries stops
// being a line item on the operator's bucket bill.
export const DEFAULT_STAGING_TTL_MS = 24 * 60 * 60 * 1000

// The question a failure has to answer is not "was it the network?" but "are
// the bytes already staged still a truthful prefix of the content we set out to
// archive?".
//
// These codes are the failures that are themselves the evidence that they are
// NOT, or can never again be proven to be: the source's identity changed, bytes
// that do not hash to the leaf the tree committed to, a staged block that is
// gone, staging state too old to trust. No amount of retrying makes any of them
// true, so the staging state is reclaimed.
//
// Everything else — a reset connection, a timeout, a 503 while the source
// re-resolves upstream, an abort, the process dying — leaves the staged prefix
// exactly as truthful as it was, so it is kept. Default-resumable is the
// deliberate direction: keeping bytes costs bucket storage that the TTL above
// bounds, while discarding them costs the whole download again from byte zero.
const PERMANENT_INGEST_FAILURES = new Set([
  'ASSET_RESUME_UNSUPPORTED',
  'ASSET_SOURCE_CHANGED',
  'ASSET_SOURCE_IDENTITY_CHANGED',
  'ASSET_SOURCE_NOT_REOPENABLE',
  'ASSET_STAGED_BLOCK_MISSING',
  'ASSET_STAGED_BLOCK_UNVERIFIABLE',
  'ASSET_STAGING_EXPIRED',
  'ASSET_STAGING_IDENTITY_CORRUPT',
  'REMOTE_BLOCK_CORRUPT',
])

/**
 * Is this failure one a retry could get past, or one that condemns what is
 * already staged?
 *
 * A transport carrying its own verdict is believed: `SourceCallbackError` sets
 * `recoverable === false` for exactly the statuses a retry cannot help with
 * (a revoked grant, a range outside the file, a redirect), so that is honoured
 * rather than second-guessed.
 */
export function classifyIngestFailure (error) {
  const code = typeof error?.code === 'string' ? error.code : null
  if (code !== null && PERMANENT_INGEST_FAILURES.has(code)) return 'permanent'
  if (error?.recoverable === false) return 'permanent'
  return 'resumable'
}

function normalizeIdentityInput(input = {}) {
  const treeHash = normalizeBytes(input.treeHash, 32, 'treeHash')
  const blockLength = normalizeNonNegativeInteger(
    input.blockLength ?? input.length,
    'blockLength',
    NaN
  )
  const byteLength = normalizeNonNegativeInteger(input.byteLength, 'byteLength', NaN)
  const blockSize = normalizeNonNegativeInteger(
    input.blockSize ?? ASSET_BLOCK_SIZE,
    'blockSize',
    NaN
  )

  if (blockSize !== ASSET_BLOCK_SIZE) throw new Error('blockSize does not match canonical asset blocks')
  if (blockLength !== Math.ceil(byteLength / ASSET_BLOCK_SIZE)) {
    throw new Error('blockLength does not match canonical asset blocks')
  }

  return { treeHash, blockLength, byteLength, blockSize }
}

function createHypercoreManifest(treeHash, blockLength) {
  return {
    version: 1,
    hash: 'blake2b',
    allowPatch: false,
    quorum: 0,
    signers: [],
    prologue: { hash: treeHash, length: blockLength },
  }
}

function isIterable(source) {
  return !!source && (
    typeof source[Symbol.asyncIterator] === 'function' ||
    typeof source[Symbol.iterator] === 'function'
  )
}

function assertWriteInput(store, source, createSource, resume = null) {
  if (!store || typeof store.get !== 'function') throw new Error('store is required')
  if (resume !== null) {
    if (source !== null || createSource !== null) {
      throw new Error('a resumable write opens its own source: pass resume.open(), not source or createSource')
    }
    return
  }
  if (createSource !== null && typeof createSource !== 'function') {
    throw new Error('createSource must be a function')
  }
  if (createSource === null && !isIterable(source)) {
    throw new Error('source is required')
  }
}

/**
 * How this write gets at the source bytes.
 *
 * `reopenable` is the whole point: bounded ingest reads the source TWICE (once
 * to derive the content-addressed key, once to write the blocks), so it can
 * only run when the source can be opened again. A factory can always be called
 * again; an array is the one iterable that is provably re-iterable; anything
 * else — a generator, a stream — is one-shot and is refused rather than
 * buffered.
 */
function resolveSource({ source, createSource, resume = null }) {
  // A resumable write opens its source AT AN OFFSET, and that offset is only
  // known once the staging core on disk has been read, so the source cannot
  // exist before the write starts. That makes `resume.open` the one source
  // shape that is one-shot by construction and still restartable — and it is
  // never re-openable, because pass 2 must read the staged blocks back from the
  // object store rather than fetch the title a second time.
  if (resume !== null) {
    return {
      reopenable: false,
      open(at) {
        const opened = resume.open({ byteOffset: at.byteOffset, blockIndex: at.blockIndex })
        if (!isIterable(opened)) throw new Error('resume.open() must return an iterable of byte chunks')
        return opened
      },
    }
  }
  if (typeof createSource === 'function') {
    return {
      reopenable: true,
      open() {
        const opened = createSource()
        if (!isIterable(opened)) throw new Error('createSource() must return an iterable of byte chunks')
        return opened
      },
    }
  }
  return { reopenable: Array.isArray(source), open: () => source }
}

/**
 * `offload` is one of three things, and which one it is decides how the write
 * runs:
 *
 *   null                 no offload; the classic single-pass write.
 *   function             the classic single-pass write, then one call with
 *                        `({ core, descriptor, signal })` on the finished core.
 *   { createOffloader,   bounded ingest — see writeStaticAsset.
 *     createStagingStore }
 */
function normalizeOffload(offload) {
  if (offload === null || offload === undefined) {
    return { hook: null, createOffloader: null, createStagingStore: null }
  }
  if (typeof offload === 'function') {
    return { hook: offload, createOffloader: null, createStagingStore: null }
  }
  if (typeof offload === 'object' && typeof offload.createOffloader === 'function') {
    const staging = offload.createStagingStore
    if (staging !== null && staging !== undefined && typeof staging !== 'function') {
      throw new Error('offload.createStagingStore must be a function')
    }
    return {
      hook: null,
      createOffloader: (input) => offload.createOffloader(input),
      createStagingStore: typeof staging === 'function' ? (input) => staging(input) : null,
    }
  }
  throw new Error('offload must be a function or an object with createOffloader()')
}

function assertOffloader(offloader) {
  if (!offloader || typeof offloader.track !== 'function' || typeof offloader.drain !== 'function') {
    throw new Error('createOffloader() must return a block offloader with track() and drain()')
  }
  return offloader
}

const STAGING_STORE_METHODS = ['put', 'has', 'get', 'purge']

function assertStagingStore(store) {
  for (const name of STAGING_STORE_METHODS) {
    if (!store || typeof store[name] !== 'function') {
      throw new Error(`createStagingStore() must return a remote block store with ${STAGING_STORE_METHODS.join('(), ')}()`)
    }
  }
  return store
}

function sourceNotReopenableError() {
  const error = new Error(
    'bounded offload ingest needs the title twice and this source can only be read once: pass createSource(), a function returning a fresh iterable, or offload.createStagingStore() so the second pass can read the staged blocks back from the object store'
  )
  error.code = 'ASSET_SOURCE_NOT_REOPENABLE'
  return error
}

function sourceChangedError(message, index) {
  const error = new Error(`the source changed between passes: ${message}`)
  error.code = 'ASSET_SOURCE_CHANGED'
  error.blockIndex = index
  return error
}

function stagedBlockError(message, code, index) {
  const error = new Error(message)
  error.code = code
  error.blockIndex = index
  return error
}

function stagingStateError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function describeIdentity(value) {
  return value === null || value === undefined ? 'no source identity' : `identity ${value}`
}

function sourceIdentityChangedError(staged, offered) {
  const error = new Error(
    `the source's identity changed between attempts: the staged blocks were read under ${describeIdentity(staged)} and the source now reports ${describeIdentity(offered)}; refusing to splice two sources into one content-addressed core`
  )
  error.code = 'ASSET_SOURCE_IDENTITY_CHANGED'
  error.stagedIdentity = staged ?? null
  error.sourceIdentity = offered ?? null
  return error
}

function resumeUnsupportedError() {
  const error = new Error(
    'a resumable write needs somewhere durable to keep its staged blocks: pass both offload.createOffloader() and offload.createStagingStore()'
  )
  error.code = 'ASSET_RESUME_UNSUPPORTED'
  return error
}

function normalizeResumeId(id) {
  if (typeof id !== 'string') throw new Error('resume.id must be a string')
  const trimmed = id.trim()
  if (trimmed.length === 0 || trimmed.length > 128) throw new Error('resume.id must be 1 to 128 characters')
  return trimmed
}

/**
 * The staging core's name for a resume id.
 *
 * Hashed rather than interpolated so an id of any shape becomes a fixed-length
 * corestore name, and domain-separated so it can never collide with the random
 * names a non-resumable write uses.
 */
function stagingCoreName(id) {
  const digest = crypto.hash(b4a.from(`peartube.asset.staging.id.v1\u0000${id}`))
  return `${STAGING_NAME_PREFIX}${b4a.toString(digest, 'hex')}`
}

/**
 * `resume` turns a one-shot streaming ingest into one that survives being
 * interrupted:
 *
 *   id        a stable identifier for this ingest — the relay's job id. It is
 *             the only thing that has to survive a restart, and everything else
 *             is read back off disk from the staging core it names.
 *   open      `({ byteOffset, blockIndex })` returning a ONE-SHOT iterable of
 *             the source bytes from `byteOffset` on. It is called exactly once
 *             per attempt, and never with an offset that is not a canonical
 *             block boundary. An offset equal to the whole length is legal and
 *             must yield nothing.
 *   etag      the source's own statement of which bytes it is serving. Recorded
 *             on the first attempt and compared on every later one.
 *   ttlMs     how long staging state may go untouched before it is reclaimed
 *             rather than resumed.
 *   now       clock, for tests.
 *   classify  `(error) => 'resumable' | 'permanent'`; defaults to
 *             classifyIngestFailure.
 */
function normalizeResume(resume) {
  if (resume === null || resume === undefined) return null
  if (typeof resume !== 'object' || Array.isArray(resume)) throw new Error('resume must be an object')
  const id = normalizeResumeId(resume.id)
  if (typeof resume.open !== 'function') {
    throw new Error('resume.open({ byteOffset, blockIndex }) must return an iterable of the source bytes from byteOffset on')
  }
  const etag = resume.etag === null || resume.etag === undefined ? null : resume.etag
  if (etag !== null && (typeof etag !== 'string' || etag.length === 0 || etag.length > 256)) {
    throw new Error('resume.etag must be a source identity token of 1 to 256 characters')
  }
  const ttlMs = resume.ttlMs === null || resume.ttlMs === undefined ? DEFAULT_STAGING_TTL_MS : resume.ttlMs
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('resume.ttlMs must be a positive safe integer')
  const now = resume.now === null || resume.now === undefined ? () => Date.now() : resume.now
  if (typeof now !== 'function') throw new Error('resume.now must be a function')
  const classify = resume.classify === null || resume.classify === undefined ? classifyIngestFailure : resume.classify
  if (typeof classify !== 'function') throw new Error('resume.classify must be a function')
  return {
    id,
    etag,
    ttlMs,
    now,
    classify: (error) => (classify(error) === 'permanent' ? 'permanent' : 'resumable'),
    open: (at) => resume.open(at),
  }
}

function assertNotCancelled(signal) {
  if (signal?.aborted) {
    // Coded, because the difference between "this write was interrupted" and
    // "the operator withdrew consent" is not visible from inside a write — an
    // AbortSignal fires for a relay shutting down and for a real cancellation
    // alike. So an abort is retained as resumable here, and the consent-aware
    // layer above reclaims the staging state explicitly when it means it.
    throw stagingStateError('static asset write cancelled', 'ASSET_WRITE_CANCELLED')
  }
}

function sourceChunkView(value) {
  if (!b4a.isBuffer(value)) {
    throw new Error('source chunks must be a Buffer or Uint8Array')
  }
  return value.subarray(0)
}

/**
 * Split the source into canonical asset blocks and hand each one to `onBlock`,
 * in order, with its index. Chunk boundaries in the source are irrelevant: only
 * `blockSize` decides where a block ends, which is what makes the resulting
 * tree — and therefore the asset key — a function of the bytes alone.
 */
async function eachCanonicalBlock(source, { blockSize, signal, onBlock, startIndex = 0 }) {
  let partial = null
  let partialLength = 0
  let index = startIndex

  for await (const value of source) {
    assertNotCancelled(signal)
    const chunk = sourceChunkView(value)
    let offset = 0

    if (partial !== null) {
      const length = Math.min(blockSize - partialLength, chunk.byteLength)
      b4a.copy(chunk.subarray(0, length), partial, partialLength)
      partialLength += length
      offset += length

      if (partialLength === blockSize) {
        await onBlock(partial, index++)
        assertNotCancelled(signal)
        partial = null
        partialLength = 0
      }
    }

    while (chunk.byteLength - offset >= blockSize) {
      await onBlock(chunk.subarray(offset, offset + blockSize), index++)
      assertNotCancelled(signal)
      offset += blockSize
    }

    if (offset < chunk.byteLength) {
      partial = b4a.allocUnsafe(blockSize)
      partialLength = chunk.byteLength - offset
      b4a.copy(chunk.subarray(offset), partial)
    }
  }

  assertNotCancelled(signal)
  if (partialLength > 0) await onBlock(partial.subarray(0, partialLength), index++)
  assertNotCancelled(signal)
  return index
}

/**
 * Append every canonical block of the source to `core`.
 *
 * `onAppended(index, block)` is optional and, when absent, this is the append
 * loop it always was. Bounded ingest uses it to deal with each staged block's
 * DATA the moment the block is durably written — dropped, or uploaded and then
 * dropped — keeping the merkle tree the append built and nothing else.
 */
async function appendCanonicalSource(core, source, { blockSize, signal, onAppended = null, startIndex = 0 }) {
  await eachCanonicalBlock(source, {
    blockSize,
    signal,
    startIndex,
    async onBlock(block, index) {
      await core.append(block)
      if (onAppended !== null) await onAppended(index, block)
    },
  })
}

async function copyStaticPrologue({ sourceState, target }) {
  await target.ready()
  // Hypercore 11.35.1 exposes this internal operation as Core.copyPrologue(sourceState).
  await target.core.copyPrologue(sourceState)
}

// ---------------------------------------------------------------------------
// bounded ingest
// ---------------------------------------------------------------------------
//
// The staging core is written through Hypercore, but a staged block's DATA is
// put and dropped through the storage write transaction directly, exactly as
// archive/block-offloader.js drops an offloaded block: it touches only the
// block key, so the tree and the bitfield the transplant needs survive.

async function putStagedBlockData(storage, index, data) {
  const tx = storage.write()
  tx.putBlock(index, data)
  await tx.flush()
}

async function dropStagedBlockData(storage, index) {
  const tx = storage.write()
  tx.deleteBlock(index)
  await tx.flush()
}

/**
 * The 32-byte commitment the staged tree made to block `index` — the hash of
 * merkle tree node `2 * index`. The second pass is only allowed to write bytes
 * that hash to this.
 */
async function stagedLeafHash(storage, index) {
  const rx = storage.read()
  let pending = null
  try {
    pending = rx.getTreeNode(2 * index)
  } finally {
    rx.tryFlush()
  }
  const node = await pending
  return node && b4a.isBuffer(node.hash) && node.hash.byteLength === 32 ? node.hash : null
}

function residentBytesOf(offloader) {
  const stats = typeof offloader.stats === 'function' ? offloader.stats() : null
  return Number.isSafeInteger(stats?.residentBytes) ? stats.residentBytes : 0
}

/**
 * Read block `index` from the staging core through its own storage layer.
 *
 * In streaming mode the local copy was dropped in pass 1, so this read misses
 * locally and the offload storage wrapper (archive/offload-storage.js) fetches
 * the object it was uploaded to and verifies it against the staged tree before
 * handing it back. Nothing above this line knows the difference.
 */
async function readStagedBlockData(storage, index) {
  const rx = storage.read()
  let pending = null
  try {
    pending = rx.getBlock(index)
  } finally {
    rx.tryFlush()
  }
  const data = await pending
  return data === undefined ? null : data
}

/**
 * The staged tree's commitment for block `index`, refusing a block the tree the
 * asset key came from never committed to.
 */
async function stagedLeafFor(stagingStorage, index, descriptor) {
  if (index >= descriptor.length) {
    throw sourceChangedError(`block ${index} is past the end of the tree the asset key was derived from`, index)
  }
  const expectedHash = await stagedLeafHash(stagingStorage, index)
  if (expectedHash === null) {
    throw sourceChangedError(`block ${index} has no leaf in the tree the asset key was derived from`, index)
  }
  return expectedHash
}

/**
 * The bytes for block `index` are checked against the staged tree BEFORE they
 * are written into the finished core.
 *
 * `copyPrologue` verifies the source core's roots against the prologue, but it
 * never hashes the block data it copies, so bytes that read back differently —
 * a source that changed between passes, an object store that handed back
 * something else — would otherwise land in a core whose key says they cannot
 * have, leaving every peer that asked for that block unable to verify the proof
 * the relay serves it. This check is the only thing standing there, so it stays
 * on the write side of the write.
 */
function assertMatchesStagedLeaf(block, index, expectedHash) {
  if (!b4a.equals(crypto.data(block), expectedHash)) {
    throw sourceChangedError(`block ${index} does not match the tree the asset key was derived from`, index)
  }
}

/**
 * Move one verified block from the staging core into the finished core.
 *
 * Stage the bytes, transplant them, drop the staged copy, then let the offloader
 * take the oldest end. So the only block data on local disk at any moment is the
 * window the offloader has not given up yet plus the one block being moved —
 * never the title.
 */
async function transplantStagedBlock({ staging, finalCore, offloader, signal, progress }, block, index) {
  // Both copies of this block are on local disk between the two writes below:
  // the staged one the transplant reads and the final one it writes. That pair,
  // on top of the window the offloader has not given up yet, is the peak this
  // whole path exists to bound.
  const local = residentBytesOf(offloader) + (2 * block.byteLength)
  if (local > progress.peakLocalBytes) progress.peakLocalBytes = local

  const stagingStorage = staging.core.state.storage
  await putStagedBlockData(stagingStorage, index, block)
  assertNotCancelled(signal)
  await copyStaticPrologue({ sourceState: staging.core.state, target: finalCore })
  assertNotCancelled(signal)
  // Redundant now rather than lost: the finished core holds it durably, and the
  // finished core's own offload has not started for this block yet, so no delete
  // here can be the delete of a block whose only other copy is remote.
  await dropStagedBlockData(stagingStorage, index)
  assertNotCancelled(signal)

  offloader.track(index, block.byteLength)
  await offloader.drain()
  assertNotCancelled(signal)

  progress.blocks++
  progress.bytes += block.byteLength
}

/**
 * Close the finished core's accounting and describe what the pass cost.
 */
async function finishIngest({ mode, finalCore, descriptor, offloader, progress }) {
  if (progress.blocks !== descriptor.length || progress.bytes !== descriptor.byteLength) {
    throw sourceChangedError(
      `it ended at ${progress.blocks} block(s) and ${progress.bytes} byte(s), but the asset key was derived from ${descriptor.length} block(s) and ${descriptor.byteLength} byte(s)`,
      progress.blocks
    )
  }

  if (progress.blocks > 0) {
    // `copyPrologue` sets the contiguous-length hint from the run of blocks one
    // call saw, and here every call sees exactly one, so the finished core is
    // told the truth once at the end. It is only a fast path — a full core
    // answers `has()` for every block either way — but a core that lies about
    // it is a core somebody debugs twice.
    finalCore.core.updateContiguousLength({ drop: false, start: 0, length: 1 })
    await finalCore.core.flushHints()
  }

  return {
    mode,
    blocks: progress.blocks,
    bytes: progress.bytes,
    peakLocalBytes: progress.peakLocalBytes,
    windowBytes: Number.isSafeInteger(offloader.windowBytes) ? offloader.windowBytes : null,
    offload: typeof offloader.stats === 'function' ? offloader.stats() : null,
  }
}

/**
 * Second pass over a RE-OPENABLE source: read the source again and move it into
 * the finished core one block at a time. Nothing leaves for the object store
 * except through the offloader's window, and the source is a local file or an
 * array, so re-reading it is cheaper than a round trip to a bucket.
 */
async function ingestBoundedSource({ staging, finalCore, descriptor, source, offloader, signal }) {
  const stagingStorage = staging.core.state.storage
  const progress = { blocks: 0, bytes: 0, peakLocalBytes: 0 }

  await eachCanonicalBlock(source, {
    blockSize: ASSET_BLOCK_SIZE,
    signal,
    async onBlock(block, index) {
      const expectedHash = await stagedLeafFor(stagingStorage, index, descriptor)
      assertMatchesStagedLeaf(block, index, expectedHash)
      await transplantStagedBlock({ staging, finalCore, offloader, signal, progress }, block, index)
    },
  })

  return finishIngest({ mode: 'reopen', finalCore, descriptor, offloader, progress })
}

// ---------------------------------------------------------------------------
// streaming ingest: one read of the source, ever
// ---------------------------------------------------------------------------
//
// A network download cannot be re-opened, and a relay that must stage the whole
// title on disk before ingest can only archive what its volume holds — which is
// the failure this mode exists for. So pass 1 sends each staged block to the
// object store under the STAGING core's key as it is appended, and pass 2 reads
// them back from there instead of from the network.
//
// Pass 1 does NOT wait for one block's upload before reading the next. A held
// response only moves as fast as somebody asks it for bytes, so an upload
// awaited inline is not a cost paid alongside the download, it IS the download
// time. Up to STAGING_UPLOAD_CONCURRENCY uploads run against the read instead,
// which is why the confirmed staging objects are no longer an exact prefix of
// the staged tree — the two places that used to rely on that, the resume
// bisection and the tail confirmation, say how they cope.
//
// Objects are addressed BY CORE KEY, so the staging objects cannot be handed to
// the finished core: each restored block is re-uploaded under the finished
// core's own key by its own offloader, and the staging objects are deleted once
// the finished core verifies.

/**
 * Run up to `limit` uploads at once, oldest first, and remember the first one
 * that fails.
 *
 * `start` returns as soon as the OLDEST upload has finished, not as soon as any
 * of them has. That distinction is load-bearing. A plain counting semaphore
 * would let the read run arbitrarily far ahead of one slow upload — a block
 * near the start of the title can still be in the air while the tail is already
 * confirmed — and then the missing objects are scattered through the tree
 * instead of sitting at the end of it, which is a question the resume path
 * cannot answer cheaply. Waiting on the head keeps the gap between the staged
 * tree and the confirmed objects at most `limit` blocks wide, which is what
 * confirmedStagingBlocks relies on.
 *
 * A failure is latched and re-thrown at the next `start` or at `settle`, so an
 * upload that never lands still fails the ingest: the block it was carrying is
 * one pass 2 would go looking for in the bucket.
 */
function createUploadPipeline (limit) {
  // Uploads in the order they were started. An entry may already be settled;
  // awaiting it again costs nothing and keeps the order honest.
  const queue = []
  let failure = null

  function track (run) {
    queue.push(run().then(null, (error) => {
      if (failure === null) failure = error
    }))
  }

  return {
    async start (run) {
      if (failure !== null) throw failure
      track(run)
      while (queue.length >= limit) await queue.shift()
      if (failure !== null) throw failure
    },

    /**
     * Wait for every upload still in the air. The staging core must not be
     * closed, removed or handed to pass 2 while one is still writing to it.
     */
    async settle () {
      while (queue.length > 0) await queue.shift()
      if (failure !== null) throw failure
    },
  }
}

/**
 * Pass 1, per appended block: upload it under the staging core's key, make the
 * object store confirm it holds it, and only then drop the local copy.
 *
 * That is the order block-offloader.js uses, for the same reason: a delete that
 * happens before the confirmation is a delete of the only copy. The staged leaf
 * is checked first because that leaf is what pass 2 verifies the restored object
 * against — a block dropped without one is a block nobody can prove again.
 *
 * Several of these run at once, so `block` must be memory this call owns for as
 * long as the upload takes: the read loop hands out views into the source's own
 * chunk, and it goes back to reading the moment this is scheduled.
 */
async function offloadStagedBlock({ staging, stagingStore, staged, index, block, signal }) {
  const storage = staging.core.state.storage
  const expectedHash = await stagedLeafHash(storage, index)
  if (expectedHash === null || !b4a.equals(crypto.data(block), expectedHash)) {
    throw stagedBlockError(
      `staged block ${index} has no matching leaf in the staging tree; refusing to drop a block that could never be verified again`,
      'ASSET_STAGED_BLOCK_UNVERIFIABLE',
      index
    )
  }

  await stagingStore.put(index, block)
  assertNotCancelled(signal)
  if (await stagingStore.has(index) !== true) {
    throw stagedBlockError(
      `staged block ${index} was uploaded but the object store does not report holding it; the local copy is kept`,
      'ASSET_STAGED_UPLOAD_UNCONFIRMED',
      index
    )
  }
  // A high-water mark, not a counter: uploads finish out of order now, and what
  // a purge has to account for is the whole prefix anything was ever put under.
  if (index + 1 > staged.uploaded) staged.uploaded = index + 1

  await dropStagedBlockData(storage, index)
  assertNotCancelled(signal)
}

/**
 * Pass 2's source in streaming mode.
 *
 * The wrapper restores the block for us when the host's `resolveStore` answers
 * for staging cores, which is the normal wiring. The direct read is for a host
 * whose does not: without it a write that has already spent the entire download
 * would fail on a wiring detail, and there is no second download.
 */
async function restoreStagedBlock({ storage, stagingStore, index, expectedHash }) {
  const local = await readStagedBlockData(storage, index)
  if (local !== null) return local

  const restored = await stagingStore.get(index, { expectedHash })
  if (restored === null || restored === undefined) {
    throw stagedBlockError(
      `staged block ${index} is not on local disk and the object store does not hold it`,
      'ASSET_STAGED_BLOCK_MISSING',
      index
    )
  }
  return restored
}

/**
 * Second pass with no source: walk the staged tree and pull every block back
 * from the object store, one at a time, into the finished core.
 */
async function ingestStagedBlocks({ staging, finalCore, descriptor, stagingStore, staged, offloader, signal }) {
  const stagingStorage = staging.core.state.storage
  const progress = { blocks: 0, bytes: 0, peakLocalBytes: 0 }

  for (let index = 0; index < descriptor.length; index++) {
    assertNotCancelled(signal)
    const expectedHash = await stagedLeafFor(stagingStorage, index, descriptor)

    const block = await restoreStagedBlock({ storage: stagingStorage, stagingStore, index, expectedHash })
    staged.restored++
    assertNotCancelled(signal)
    assertMatchesStagedLeaf(block, index, expectedHash)
    await transplantStagedBlock({ staging, finalCore, offloader, signal, progress }, block, index)
  }

  return finishIngest({ mode: 'streaming', finalCore, descriptor, offloader, progress })
}

/**
 * Drop every staging object. They exist only to carry the title from pass 1 to
 * pass 2, so past that point they are pure cost.
 *
 * This never throws: on the success path a bucket that will not delete must not
 * lose the caller an archive that is already verified, and on the failure path
 * it must not bury the error that got us here. What it cannot delete it names.
 */
async function purgeStagingObjects(stagingStore, uploaded) {
  if (stagingStore === null || uploaded === 0) {
    return { uploaded, deleted: 0, orphaned: [], error: null }
  }
  try {
    const { deleted, orphaned } = await stagingStore.purge({ length: uploaded })
    return {
      uploaded,
      deleted,
      orphaned: orphaned.map((entry) => entry.key),
      error: orphaned.length > 0 ? orphaned[0].error : null,
    }
  } catch (error) {
    const orphaned = []
    for (let index = 0; index < uploaded; index++) orphaned.push(stagingStore.key(index))
    return { uploaded, deleted: 0, orphaned, error }
  }
}

async function closeUnreturnedCore(core, error) {
  if (!core || core.closed) return
  try {
    await core.close()
  } catch (closeError) {
    throw new AggregateError([error, closeError], 'static asset failure and final core close failed')
  }
}

async function removeStagingCore(staging) {
  const core = staging.core
  const storage = core.state.storage
  const storageRoot = storage.store
  const storagePointer = storage.core

  // Hypercore 11.35.1's public purge method references removed internals.
  await staging.close()
  await core.close()
  await storageRoot.deleteCore(storagePointer)
}

/**
 * Is this interruption one whose staging state is worth keeping?
 *
 * Only a write that was asked to be resumable keeps anything: without `resume`
 * the staging core has a random name nothing could ever find again, so keeping
 * it would be a leak with no upside, and the behaviour is the one it always had.
 */
function retainStagingState(error, resume) {
  if (resume === null) return false
  // The identity guard is the one permanent failure whose staging state is still
  // worth keeping: the staged prefix is a truthful prefix of the source it was
  // read from, and it is the REQUEST that now points somewhere else. Keeping it
  // costs bucket storage the TTL already bounds; reclaiming it costs the whole
  // download if what changed was the grant rather than the content.
  if (error?.code === 'ASSET_SOURCE_IDENTITY_CHANGED') return true
  return resume.classify(error) !== 'permanent'
}

/**
 * Say on the error what was kept and where to pick it up, so a caller does not
 * have to guess whether a retry is free.
 */
function annotateRetainedStaging(error, staging, resume) {
  if (error === null || typeof error !== 'object') return
  let blockIndex = null
  let byteOffset = null
  try {
    blockIndex = staging.length
    byteOffset = staging.byteLength
  } catch {
    // A core that never opened has no progress to report; the codes below still
    // tell the caller what to do.
  }
  error.staging = {
    id: resume.id,
    retained: true,
    resumable: resume.classify(error) !== 'permanent',
    blockIndex,
    byteOffset,
  }
}

/**
 * Let go of the staging core WITHOUT deleting it.
 *
 * Only the session is closed. The core stays in the corestore, which is the
 * point: everything a resume needs — the tree, the length, the byte length and
 * the identity record — is that core, and a later attempt opens a fresh session
 * on it by name.
 */
async function closeStagingCore(staging) {
  if (staging.closed) return
  await staging.close()
}

/**
 * Open the staging core for one resume id, hand it to `fn`, and let it go
 * again. `remove()` is the way out for a caller that means to delete it.
 */
async function withStagingCore(store, id, fn) {
  const keyPair = await store.createKeyPair(stagingCoreName(id))
  const staging = store.get({ keyPair })
  await staging.ready()
  let removed = false
  try {
    return await fn(staging, {
      async remove() {
        await removeStagingCore(staging)
        removed = true
      },
    })
  } finally {
    if (!removed) await closeStagingCore(staging)
  }
}

/**
 * The identity record, kept in the staging core's own user data.
 *
 * User data goes through the same storage write transaction as everything else
 * in the core, so it survives a relay restart and dies with the core. That is
 * exactly why it lives here rather than in a bucket object or a manager's
 * memory: there is no second place that could disagree with it.
 */
async function readStagingIdentity(staging) {
  const raw = await staging.getUserData(STAGING_IDENTITY_KEY)
  if (raw === null || raw === undefined) return null
  let value = null
  try {
    value = JSON.parse(b4a.toString(raw, 'utf8'))
  } catch {
    throw stagingStateError('the staging identity record is unreadable', 'ASSET_STAGING_IDENTITY_CORRUPT')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.version !== STAGING_IDENTITY_VERSION ||
      (value.etag !== null && typeof value.etag !== 'string') ||
      !Number.isSafeInteger(value.createdAt) ||
      !Number.isSafeInteger(value.touchedAt)) {
    throw stagingStateError(
      'the staging identity record is not the shape this version writes',
      'ASSET_STAGING_IDENTITY_CORRUPT'
    )
  }
  return value
}

async function writeStagingIdentity(staging, record) {
  await staging.setUserData(STAGING_IDENTITY_KEY, b4a.from(JSON.stringify(record), 'utf8'))
}

/**
 * The first staged block the object store does NOT hold.
 *
 * Below the last STAGING_UPLOAD_CONCURRENCY blocks presence is still a PREFIX,
 * and it is createUploadPipeline's FIFO shape that makes it one: the read loop
 * will not start block `n + STAGING_UPLOAD_CONCURRENCY` until block `n`'s
 * upload has finished, so nothing older than that window can still be missing.
 * That part is a bisection — seventeen HEAD requests for a title of a hundred
 * thousand blocks rather than a hundred thousand. Inside the window uploads
 * land out of order, so it is walked, which is at most a handful of requests.
 *
 * Nothing here trusts a counter: `length` bounds the search because it is the
 * tree on disk, and every other bit of the answer comes from the bucket.
 */
async function confirmedStagingBlocks({ stagingStore, length, signal }) {
  const settled = Math.max(0, length - STAGING_UPLOAD_CONCURRENCY)
  let low = 0
  let high = settled
  while (low < high) {
    assertNotCancelled(signal)
    const middle = low + Math.floor((high - low) / 2)
    if (await stagingStore.has(middle) === true) low = middle + 1
    else high = middle
  }
  if (low < settled) return low

  for (let index = settled; index < length; index++) {
    assertNotCancelled(signal)
    if (await stagingStore.has(index) !== true) return index
  }
  return length
}

/**
 * Finish the uploads an interrupted pass 1 started but never confirmed.
 *
 * A block is appended to the staging core BEFORE it is uploaded, so an
 * interruption can leave the tree one block longer than the bucket. Those
 * blocks are still on local disk — the drop only ever happens after the store
 * confirms the object — so they go up now and the resumed read starts after
 * them.
 *
 * A block above that boundary whose local copy is gone is not automatically a
 * lost block: uploads overlap, so the block after a missing one may well have
 * landed and had its local copy dropped for the best of reasons. Only a block
 * the bucket does not hold EITHER means the one invariant this whole path rests
 * on was broken — a local copy dropped without remote confirmation. Nothing can
 * recover that, so it says so rather than quietly re-reading bytes the tree has
 * already committed to.
 */
async function confirmStagedTail({ staging, stagingStore, staged, confirmed, signal }) {
  const storage = staging.core.state.storage
  for (let index = confirmed; index < staging.length; index++) {
    assertNotCancelled(signal)
    if (await stagingStore.has(index) === true) {
      if (index + 1 > staged.uploaded) staged.uploaded = index + 1
      continue
    }
    const block = await readStagedBlockData(storage, index)
    if (block === null) {
      throw stagedBlockError(
        `staged block ${index} is on neither local disk nor the object store, so a local copy was dropped without remote confirmation`,
        'ASSET_STAGED_BLOCK_MISSING',
        index
      )
    }
    await offloadStagedBlock({ staging, stagingStore, staged, index, block, signal })
  }
}

/**
 * Where a resumed streaming ingest picks up.
 *
 * Every number below is derived: `length` and `byteLength` are the staged tree
 * on disk, and the confirmed prefix comes from the bucket. No counter is kept
 * anywhere, which is what makes this survive a process that died without
 * getting to write one down.
 */
async function prepareResume({ staging, stagingStore, staged, resume, signal }) {
  const identity = await readStagingIdentity(staging)
  const timestamp = resume.now()

  if (identity === null) {
    if (staging.length > 0) {
      throw stagingStateError(
        'the staging core holds blocks but no identity record, so nothing can say which source they came from',
        'ASSET_STAGING_IDENTITY_CORRUPT'
      )
    }
    await writeStagingIdentity(staging, {
      version: STAGING_IDENTITY_VERSION,
      etag: resume.etag,
      createdAt: timestamp,
      touchedAt: timestamp,
    })
    return { byteOffset: 0, blockIndex: 0, complete: false, resumed: false }
  }

  // The consistency guard. `etag` is the source's own statement of which bytes
  // it is serving; if it differs from the one the staged prefix was read under,
  // appending to that prefix would splice two different titles into a core whose
  // key claims to be the hash of neither. So it stops here, loudly — and the
  // staged prefix is left exactly as it is, because it is still a truthful
  // prefix of the ORIGINAL source and destroying a long download on the strength
  // of one unexpected header is the wrong trade. The TTL is what stops it
  // leaking.
  if (identity.etag !== resume.etag) throw sourceIdentityChangedError(identity.etag, resume.etag)

  const idle = timestamp - identity.touchedAt
  if (idle > resume.ttlMs) {
    throw stagingStateError(
      `the staging state was last touched ${idle}ms ago, past its ${resume.ttlMs}ms lifetime, so it is reclaimed rather than resumed`,
      'ASSET_STAGING_EXPIRED'
    )
  }

  const confirmed = await confirmedStagingBlocks({ stagingStore, length: staging.length, signal })
  // Anything the earlier attempt uploaded is this attempt's to account for: a
  // permanent failure now has to purge the whole prefix, not just its own share.
  staged.uploaded = confirmed
  await confirmStagedTail({ staging, stagingStore, staged, confirmed, signal })
  assertNotCancelled(signal)
  await writeStagingIdentity(staging, { ...identity, touchedAt: timestamp })

  // A short block is only ever the LAST canonical block, so a staged prefix
  // whose tail is short IS the whole title: the earlier attempt finished reading
  // the source and died in pass 2. There is nothing left to fetch, and asking
  // for more could only append past the end. A title that happens to be an
  // exact multiple of the block size instead opens the source at its own length
  // and is handed nothing, which costs one empty request and no bytes.
  const complete = staging.byteLength % ASSET_BLOCK_SIZE !== 0
  return {
    byteOffset: staging.byteLength,
    blockIndex: staging.length,
    complete,
    resumed: staging.length > 0,
  }
}

/**
 * Objects first, then the core.
 *
 * That order is not incidental: the staging core's length is the only record of
 * how many objects exist, so deleting the core first would strand them with
 * nothing left that knows their keys. An object that will not delete keeps the
 * core alive too, so the next sweep tries again instead of losing the only
 * handle on the orphan.
 */
async function reclaimOpenStagingState(staging, core, { createStagingStore, signal }) {
  const blocks = staging.length
  const stagingStore = assertStagingStore(await createStagingStore({ core: staging, signal }))
  const cleanup = await purgeStagingObjects(stagingStore, blocks)
  const reclaimed = cleanup.orphaned.length === 0
  if (reclaimed) await core.remove()
  return { blocks, deleted: cleanup.deleted, orphaned: cleanup.orphaned, reclaimed }
}

function assertStagingOwner(store, createStagingStore) {
  if (!store || typeof store.get !== 'function' || typeof store.createKeyPair !== 'function') {
    throw new Error('store is required')
  }
  if (typeof createStagingStore !== 'function') {
    throw new Error('createStagingStore() is required to reclaim staging objects')
  }
}

/**
 * Reclaim the staging state for one resume id: every staging object, then the
 * staging core.
 *
 * This is the consent-aware exit. A write cannot tell an interruption from a
 * withdrawal — both arrive as an abort — so it keeps what it has and the layer
 * that knows the difference calls this when it means it.
 */
export async function reclaimStagingState({ store, id, createStagingStore, signal } = {}) {
  assertStagingOwner(store, createStagingStore)
  const resumeId = normalizeResumeId(id)
  return withStagingCore(store, resumeId, async (staging, core) => {
    const identity = await readStagingIdentity(staging).catch(() => null)
    const outcome = await reclaimOpenStagingState(staging, core, { createStagingStore, signal })
    return { id: resumeId, ...outcome, touchedAt: identity === null ? null : identity.touchedAt }
  })
}

/**
 * Garbage-collect abandoned staging state.
 *
 * `ids` is every resume id the owner has ever issued — for the relay that is
 * its durable ingest job ids, which is what makes this complete rather than
 * best-effort: the bucket is never enumerated, because the job store already
 * knows the whole set. `keep` is the subset whose staging state must survive.
 * Anything in `ids` that is not in `keep`, or whose state has gone untouched
 * for longer than `ttlMs`, is reclaimed.
 *
 * An id whose ingest is running RIGHT NOW must not be passed: this reads the
 * staged length, and a length that is being appended to is not a length.
 */
export async function sweepStagingState({
  store,
  createStagingStore,
  ids = [],
  keep = [],
  ttlMs = DEFAULT_STAGING_TTL_MS,
  now = () => Date.now(),
  signal,
} = {}) {
  assertStagingOwner(store, createStagingStore)
  if (!Array.isArray(ids) || !Array.isArray(keep)) throw new Error('ids and keep must be arrays of resume ids')
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('ttlMs must be a positive safe integer')
  const live = new Set(keep.map((value) => normalizeResumeId(value)))
  const timestamp = now()
  const reclaimed = []
  const retained = []
  const orphaned = []

  for (const value of ids) {
    assertNotCancelled(signal)
    const resumeId = normalizeResumeId(value)
    const outcome = await withStagingCore(store, resumeId, async (staging, core) => {
      const identity = await readStagingIdentity(staging).catch(() => null)
      const expired = identity === null || timestamp - identity.touchedAt > ttlMs
      if (live.has(resumeId) && !expired) return { kept: true, blocks: staging.length }
      return { kept: false, ...await reclaimOpenStagingState(staging, core, { createStagingStore, signal }) }
    })
    if (outcome.kept) retained.push(resumeId)
    else if (outcome.reclaimed) reclaimed.push(resumeId)
    else orphaned.push(...outcome.orphaned.map((key) => ({ id: resumeId, key })))
  }

  return { reclaimed, retained, orphaned }
}

export function deriveStaticAssetId(input = {}) {
  const { treeHash, blockLength } = normalizeIdentityInput(input)
  return b4a.toString(Hypercore.key(createHypercoreManifest(treeHash, blockLength)), 'hex')
}

export function deriveStaticAssetTopic(assetId) {
  return Hypercore.discoveryKey(normalizeBytes(assetId, 32, 'assetId'))
}

export function createStaticAssetManifest(input = {}) {
  const { treeHash, blockLength, byteLength, blockSize } = normalizeIdentityInput(input)
  const hypercoreManifest = createHypercoreManifest(treeHash, blockLength)
  const key = Hypercore.key(hypercoreManifest)
  const descriptor = {
    kind: STATIC_ASSET_KIND,
    key,
    treeHash,
    length: blockLength,
    byteLength,
    blockSize,
    hypercoreManifest,
  }

  return {
    ...descriptor,
    assetId: b4a.toString(key, 'hex'),
  }
}

/**
 * Write one immutable static asset core.
 *
 * The asset's key is derived from the content, so the bytes have to be hashed
 * before the core they belong in can be opened. That is what shapes this
 * function, and `offload` decides which of the three shapes it takes.
 *
 * WITHOUT OFFLOAD (`offload` null, or a plain function) it is one pass: the
 * whole source is appended to a staging core, the descriptor is derived from
 * the staging tree, the prologue is copied into the finished core, the staging
 * core is removed, and a function `offload` is then called once with
 * `({ core, descriptor, signal })` — the first moment every block is durably
 * written, every merkle leaf exists, and the core's key is the content-
 * addressed key the network will ask for. Peak local block data is the title,
 * twice over at the copy, so the title has to fit on the volume.
 *
 * WITH BOUNDED INGEST (`offload` is `{ createOffloader }`) it is two passes and
 * the title does NOT have to fit:
 *
 *   1. the source is appended to the staging core and each staged block's DATA
 *      is dropped the moment it is written. Staging keeps the merkle tree,
 *      which is hashes and stays small no matter how large the title is, so
 *      this pass costs one block of disk and still yields the tree hash the
 *      key is derived from;
 *   2. `createOffloader({ core, descriptor, signal })` is asked for a windowed
 *      offloader over the finished core, and then the title is moved into that
 *      core one block at a time, the offloader giving up the oldest end as it
 *      goes.
 *
 * Where pass 2 gets the title decides the mode, and `ingest.mode` reports it:
 *
 *   'reopen'     a re-openable source (`createSource()`, or an array) is read a
 *                second time. Cheapest when the source is a local file: nothing
 *                is uploaded except through the offloader's window.
 *   'streaming'  the source is ONE-SHOT — a network download, a pipe — and
 *                `offload.createStagingStore({ core, signal })` supplied an
 *                object store for the staging core. Pass 1 then uploads each
 *                staged block under the STAGING core's key before dropping it,
 *                up to STAGING_UPLOAD_CONCURRENCY of them at a time so the
 *                download is not stopped for each round trip, and pass 2 reads
 *                them back from there. The source is consumed exactly once, so
 *                a relay archives a title larger than its own volume off a
 *                single download.
 *
 * Peak local block data in pass 2 is the offload window plus the single block
 * being moved (its staged copy and its finished copy), whatever the title's
 * size — reported as `ingest.peakLocalBytes`, bounded by
 * `windowBytes + 2 * ASSET_BLOCK_SIZE`. Streaming pass 1 costs
 * `STAGING_UPLOAD_CONCURRENCY * ASSET_BLOCK_SIZE` before that, for the blocks
 * whose local copies are waiting on their objects to be confirmed. Both are
 * constants: neither follows the title.
 *
 * A one-shot source with no staging store is refused with
 * `ASSET_SOURCE_NOT_REOPENABLE` rather than buffered.
 *
 * RESUME. `resume` (see normalizeResume) makes the streaming mode survive being
 * interrupted. Instead of `source`, the caller supplies `resume.open`, which
 * opens the download AT A BYTE OFFSET, and `resume.id`, a stable name for the
 * staging core. An interruption that leaves the staged prefix truthful — a reset
 * connection, a timeout, an abort, the process dying — keeps that core and every
 * block the object store has confirmed, so the next attempt re-reads only the
 * bytes after the last confirmed block. The finished core's key is a hash of the
 * whole content, and a resume always restarts on a canonical block boundary, so
 * a resumed ingest produces exactly the key an uninterrupted one would.
 */
export async function writeStaticAsset({
  store,
  source = null,
  createSource = null,
  signal,
  offload = null,
  resume = null,
} = {}) {
  const resumeState = normalizeResume(resume)
  assertWriteInput(store, source, createSource, resumeState)
  const { hook, createOffloader, createStagingStore } = normalizeOffload(offload)
  // Resume state IS the staging core plus its objects. Without both there is
  // nowhere for an interrupted attempt's bytes to wait.
  if (resumeState !== null && (createOffloader === null || createStagingStore === null)) {
    throw resumeUnsupportedError()
  }
  const resolved = resolveSource({ source, createSource, resume: resumeState })
  // A source that can be re-opened is re-opened: a caller with a local file
  // should not be pushed through a bucket for pass 2. Streaming is what the
  // one-shot sources get, and only if they brought a staging store.
  const streaming = createOffloader !== null && !resolved.reopenable
  if (streaming && createStagingStore === null) throw sourceNotReopenableError()
  assertNotCancelled(signal)

  const stagingName = resumeState === null
    ? `${STAGING_NAME_PREFIX}${b4a.toString(crypto.randomBytes(16), 'hex')}`
    : stagingCoreName(resumeState.id)
  const stagingKeyPair = await store.createKeyPair(stagingName)
  const staging = store.get({ keyPair: stagingKeyPair })

  let finalCore = null
  let descriptor = null
  let ingest = null
  let stagingStore = null
  // How much of the staging core made it to the object store, and how much came
  // back. `uploaded` is what the cleanup has to account for on either path.
  const staged = { uploaded: 0, restored: 0 }
  // Pass 1's uploads, running against the read rather than in front of it.
  const stagingConcurrency = Number.isSafeInteger(offload?.uploadConcurrency) && offload.uploadConcurrency > 0
    ? offload.uploadConcurrency
    : STAGING_UPLOAD_CONCURRENCY
  const uploads = createUploadPipeline(stagingConcurrency)
  // Set when an interruption leaves the staging core and its confirmed objects
  // worth keeping. This one boolean is the difference between "the download died
  // at minute 42" and "the download has to start again", so it is decided once,
  // deliberately, in the catch below.
  let retainStaging = false
  // Which block a resumed attempt started at, reported so a caller can see that
  // an interruption cost it nothing.
  let resumeAtBlock = 0
  try {
    try {
      await staging.ready()
      if (streaming) {
        stagingStore = assertStagingStore(await createStagingStore({ core: staging, signal }))
        assertNotCancelled(signal)
      }

      const resumeAt = resumeState === null
        ? { byteOffset: 0, blockIndex: 0, complete: false, resumed: false }
        : await prepareResume({ staging, stagingStore, staged, resume: resumeState, signal })
      resumeAtBlock = resumeAt.blockIndex
      assertNotCancelled(signal)

      if (!resumeAt.complete) {
        await appendCanonicalSource(staging, resolved.open(resumeAt), {
          blockSize: ASSET_BLOCK_SIZE,
          signal,
          startIndex: resumeAt.blockIndex,
          onAppended: createOffloader === null
            ? null
            : (streaming
                // The block is a view into the chunk the source just handed
                // over, and the read resumes the instant this is scheduled, so
                // the upload gets its own copy rather than a window onto a
                // buffer the source is free to fill again. One memcpy per block
                // against a round trip, bounded by the pipeline's depth.
                ? (index, block) => uploads.start(() => offloadStagedBlock({
                  staging,
                  stagingStore,
                  staged,
                  index,
                  block: b4a.from(block),
                  signal,
                }))
                : (index) => dropStagedBlockData(staging.core.state.storage, index)),
        })
      }
      // Pass 2 reads what pass 1 uploaded, so every upload has to have landed
      // before the tree is closed off and handed to it.
      await uploads.settle()

      assertNotCancelled(signal)
      const treeHash = await staging.treeHash()
      assertNotCancelled(signal)
      descriptor = createStaticAssetManifest({
        treeHash,
        blockLength: staging.length,
        byteLength: staging.byteLength,
      })
      finalCore = store.get({
        key: descriptor.key,
        manifest: descriptor.hypercoreManifest,
        writable: false,
      })

      assertNotCancelled(signal)
      if (createOffloader === null) {
        await copyStaticPrologue({
          sourceState: staging.core.state,
          target: finalCore,
        })
      } else {
        // The same prologue copy, with no staged block data left for it to
        // find: the finished core learns its length, byte length and roots up
        // front, so what is handed to createOffloader below is a core that
        // already knows the whole title rather than an empty one that fills in
        // later. Every block then arrives through the same copy, one at a time.
        await copyStaticPrologue({
          sourceState: staging.core.state,
          target: finalCore,
        })
        assertNotCancelled(signal)
        const offloader = assertOffloader(await createOffloader({ core: finalCore, descriptor, signal }))
        assertNotCancelled(signal)
        ingest = streaming
          ? await ingestStagedBlocks({
            staging,
            finalCore,
            descriptor,
            stagingStore,
            staged,
            offloader,
            signal,
          })
          : await ingestBoundedSource({
            staging,
            finalCore,
            descriptor,
            source: resolved.open(),
            offloader,
            signal,
          })
      }
      assertNotCancelled(signal)
      const verified = await verifyStaticAssetDescriptor(finalCore, descriptor)
      assertNotCancelled(signal)
      if (!verified) throw new Error('static asset verification failed')
    } catch (error) {
      // An upload in the air is still writing to the staging core, and it is
      // still capable of confirming a block this attempt has to account for.
      // Both of those have to be finished with before the decision below is
      // taken and before the core is closed or deleted underneath them. The
      // failure that got us here is the one worth reporting, so a second one
      // from a doomed upload is dropped.
      await uploads.settle().catch(() => {})
      retainStaging = retainStagingState(error, resumeState)
      if (retainStaging) annotateRetainedStaging(error, staging, resumeState)
      // Reclaiming a RESUMED write has to account for the objects an earlier
      // attempt uploaded, and the only record of how many that is is the staged
      // tree on disk — not this attempt's counter, which may have failed before
      // it even got as far as reading one.
      else if (resumeState !== null && Number.isSafeInteger(staging.length)) {
        staged.uploaded = Math.max(staged.uploaded, staging.length)
      }
      throw error
    } finally {
      if (retainStaging) await closeStagingCore(staging)
      else await removeStagingCore(staging)
    }

    // The finished core is verified, so the staging objects have carried the
    // title as far as they ever will.
    if (stagingStore !== null) {
      const cleanup = await purgeStagingObjects(stagingStore, staged.uploaded)
      ingest.staging = {
        uploaded: cleanup.uploaded,
        restored: staged.restored,
        deleted: cleanup.deleted,
        orphaned: cleanup.orphaned,
      }
      if (cleanup.error !== null) ingest.staging.error = cleanup.error
      if (resumeState !== null) ingest.staging.resumed = resumeAtBlock
    }

    assertNotCancelled(signal)
    if (hook !== null) await hook({ core: finalCore, descriptor, signal })
    assertNotCancelled(signal)
    return ingest === null ? { core: finalCore, descriptor } : { core: finalCore, descriptor, ingest }
  } catch (error) {
    await closeUnreturnedCore(finalCore, error)
    // A failed write must not leave the bucket paying for a staging copy of a
    // title nobody will ever finish. What cannot be deleted is named on the
    // error rather than forgotten.
    // A resumable interruption is the exception: its staging objects are the
    // progress, and purging them here is exactly the bug this path exists to
    // stop.
    if (stagingStore !== null && !retainStaging && error !== null && typeof error === 'object') {
      const cleanup = await purgeStagingObjects(stagingStore, staged.uploaded)
      if (cleanup.orphaned.length > 0) {
        error.orphanedStagingKeys = cleanup.orphaned
        if (cleanup.error !== null) error.stagingCleanupError = cleanup.error
      }
    }
    throw error
  }
}

export async function verifyStaticAssetDescriptor(core, descriptor) {
  if (!core || !descriptor) return false

  try {
    const expected = createStaticAssetManifest({
      treeHash: descriptor.treeHash,
      blockLength: descriptor.length,
      byteLength: descriptor.byteLength,
      blockSize: descriptor.blockSize,
    })

    if (descriptor.kind !== STATIC_ASSET_KIND || descriptor.assetId !== expected.assetId) return false
    if (!b4a.equals(normalizeBytes(descriptor.key, 32, 'key'), expected.key)) return false

    await core.ready()
    if (!b4a.equals(normalizeBytes(core.key, 32, 'core.key'), expected.key)) return false
    if (core.length !== expected.length || core.byteLength !== expected.byteLength) return false

    return b4a.equals(normalizeBytes(await core.treeHash(), 32, 'core.treeHash'), expected.treeHash)
  } catch {
    return false
  }
}
