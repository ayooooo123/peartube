import crypto from 'hypercore-crypto'
import b4a from 'b4a'

// The write half of block offload. remote-block-store.js and offload-storage.js
// bring an offloaded block back; this is what puts it there in the first place.
//
// A relay's archive capacity is its disk, and the media blocks are the whole
// title. Everything that makes a block *verifiable* — the merkle tree and the
// bitfield — is hashes and bits, so it stays small no matter how large the
// title is. The block DATA is the part that does not fit, so it is the only
// part that leaves.
//
// Two rules govern every byte that leaves:
//
//   * CONFIRM BEFORE DELETE. A block is uploaded, then the object store is
//     asked whether the object is really there (`store.has`, i.e. a HEAD on the
//     real bucket), and only then is the local copy dropped. A crash anywhere
//     in that order leaves a complete core and a possibly-orphaned object — the
//     recoverable failure. The reverse order loses the block.
//
//   * DELETE DATA, NOT THE BITFIELD. The local copy is dropped through the
//     storage write transaction (`deleteBlock`), which touches only the block
//     key. `core.clear()` would clear the bitfield too, so `core.has(index)`
//     would answer false and the relay would stop advertising a block it can
//     still serve — which is the whole point of offloading it.
//
// A block is also never deleted unless the core's own merkle leaf for it exists
// AND commits to exactly the bytes that were uploaded. The restore path needs
// that leaf to verify the object it fetches (offload-storage.js), so a block
// deleted without one is a block nobody can ever prove again.

// A window is a byte budget, not a block count: blocks are the same size until
// the last one, and an operator thinks in gigabytes of disk. 2 GiB is what
// DEFAULT_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES in the relay CLI resolves to; it is
// repeated here so the offloader is usable without the relay's config.
export const DEFAULT_OFFLOAD_WINDOW_BYTES = 2 * 1024 * 1024 * 1024

function offloadError (message, code, index) {
  const error = new Error(message)
  error.code = code
  error.blockIndex = index
  return error
}

/**
 * A sliding window over one core's local block data.
 *
 * Blocks are declared with `track(index, byteLength)` as they are durably
 * written, oldest first. `drain()` then offloads from the oldest end until the
 * un-offloaded block data left resident is within `windowBytes`, so peak
 * resident block data tracks the window and not the size of the title.
 *
 * `evict(index)` is the same thing for a block that came BACK — a block this
 * relay restored from the object store and now has to give up again so its
 * local footprint stays a window rather than a growing copy of the corpus.
 * Both go through one upload-confirm-delete step, so there is exactly one
 * place a local block copy is ever dropped.
 *
 * @param core          a ready Hypercore. Only `core.state.storage` is used:
 *                      block reads and the delete both go straight through the
 *                      storage layer, never through `core.clear()`.
 * @param storage       that per-core hypercore-storage instance, for a caller
 *                      that holds one without a Hypercore around it (the read
 *                      path's residency sweep). Defaults to the core's own.
 * @param store         a createRemoteBlockStore()-shaped store for this core.
 * @param windowBytes   un-offloaded block data allowed to stay resident. 0
 *                      offloads every tracked block.
 * @param log           optional `(message) => void`.
 * @param onOffloaded   optional `({ index, byteLength, ...stats })` after each
 *                      block's local copy is gone.
 */
export function createBlockOffloader ({
  core = null,
  storage = core?.state?.storage ?? null,
  store,
  windowBytes = DEFAULT_OFFLOAD_WINDOW_BYTES,
  log = null,
  onOffloaded = null,
} = {}) {
  if (!storage || typeof storage !== 'object' || typeof storage.read !== 'function' || typeof storage.write !== 'function') {
    throw new TypeError('core must be a ready Hypercore, or storage its hypercore-storage instance')
  }
  if (!store || typeof store.put !== 'function' || typeof store.has !== 'function') {
    throw new TypeError('store must be a remote block store with put and has')
  }
  const budget = Number.isSafeInteger(windowBytes) && windowBytes >= 0
    ? windowBytes
    : DEFAULT_OFFLOAD_WINDOW_BYTES

  const report = typeof log === 'function' ? log : null
  const notify = typeof onOffloaded === 'function' ? onOffloaded : null

  // FIFO of blocks whose data is still on local disk. The head is the oldest,
  // which is the one a sliding window gives up first.
  const queue = []
  const tracked = new Set()
  let residentBytes = 0
  let peakResidentBytes = 0
  let blocksOffloaded = 0
  let bytesOffloaded = 0
  let confirmed = 0

  function emit (message) {
    if (report === null) return
    try {
      report(`[block-offloader] ${message}`)
    } catch {
      // A logger must never take down an offload.
    }
  }

  function stats () {
    return {
      windowBytes: budget,
      residentBytes,
      peakResidentBytes,
      pending: queue.length,
      blocksOffloaded,
      bytesOffloaded,
      confirmed,
    }
  }

  /**
   * One read per transaction, called into synchronously and flushed by us.
   * hypercore-storage read transactions only resolve on `tryFlush()`.
   */
  async function readOnce (read) {
    const rx = storage.read()
    let pending = null
    try {
      pending = read(rx)
    } finally {
      rx.tryFlush()
    }
    return pending
  }

  // The 32-byte commitment for block `index` is the hash of merkle tree node
  // `2 * index` — the same leaf offload-storage.js verifies a restored block
  // against.
  async function leafHash (index) {
    const node = await readOnce((rx) => rx.getTreeNode(2 * index))
    return node && b4a.isBuffer(node.hash) && node.hash.byteLength === 32 ? node.hash : null
  }

  /**
   * Drop the local block DATA and nothing else. Only reached after the object
   * store has confirmed it holds the block.
   */
  async function deleteLocalBlock (index) {
    const tx = storage.write()
    tx.deleteBlock(index)
    await tx.flush()
  }

  function release (entry) {
    queue.shift()
    tracked.delete(entry.index)
    residentBytes -= entry.byteLength
    if (residentBytes < 0) residentBytes = 0
  }

  /**
   * An evicted block may also be sitting in the ingest FIFO — an eviction and
   * an ingest can be looking at the same core. Drop it there too, so the
   * window's accounting keeps matching local disk.
   */
  function forget (index) {
    if (!tracked.delete(index)) return
    const at = queue.findIndex((entry) => entry.index === index)
    if (at === -1) return
    residentBytes -= queue[at].byteLength
    if (residentBytes < 0) residentBytes = 0
    queue.splice(at, 1)
  }

  /**
   * Hand one block's DATA to the object store and drop the local copy. The one
   * path any local block copy is ever dropped through, for both reasons a
   * block leaves: ingest moving past it, and residency having outgrown the
   * window.
   *
   * `probeRemote` asks the object store whether it already holds the block
   * before uploading. An eviction wants that — the block it is giving up is
   * usually one this relay restored FROM the bucket, so re-uploading it buys
   * nothing — while an ingest knows the object is not there yet and skips the
   * round trip. Either way the local copy only goes after a `store.has()` that
   * answered true.
   *
   * @returns the byte length dropped, or 0 when there was no local copy left.
   */
  async function retireBlock (index, { probeRemote = false } = {}) {
    const data = await readOnce((rx) => rx.getBlock(index))
    if (data === null || data === undefined) return 0

    const expectedHash = await leafHash(index)
    if (expectedHash === null) {
      throw offloadError(
        `block ${index} has no merkle leaf; refusing to offload a block that could never be verified again`,
        'OFFLOAD_BLOCK_UNVERIFIABLE',
        index
      )
    }
    if (!b4a.equals(crypto.data(data), expectedHash)) {
      throw offloadError(
        `block ${index} does not match the merkle tree; refusing to offload it`,
        'OFFLOAD_BLOCK_UNVERIFIABLE',
        index
      )
    }

    // The confirmation is a real round trip against the object store, not the
    // put's own return value: a put that reported success and did not land is
    // exactly the failure that would turn a delete into a hole.
    let held = probeRemote === true && await store.has(index) === true
    if (!held) {
      await store.put(index, data)
      held = await store.has(index) === true
    }
    if (!held) {
      throw offloadError(
        `block ${index} was uploaded but the object store does not report holding it; the local copy is kept`,
        'OFFLOAD_BLOCK_UNCONFIRMED',
        index
      )
    }
    confirmed++

    await deleteLocalBlock(index)
    blocksOffloaded++
    bytesOffloaded += data.byteLength
    return data.byteLength
  }

  async function offloadHead () {
    const entry = queue[0]
    const byteLength = await retireBlock(entry.index)
    // Either the block is gone now, or it was already gone — an earlier run
    // offloaded it, or it was never resident. Both stop accounting for it.
    release(entry)
    if (byteLength === 0) return false

    if (notify !== null) {
      try {
        notify({ index: entry.index, byteLength, ...stats() })
      } catch {
        // A progress callback must never take down an offload.
      }
    }
    return true
  }

  return {
    windowBytes: budget,
    stats,

    /**
     * Declare a durably-written block. `byteLength` is the block's own size,
     * which the caller already knows: reading it back just to measure it would
     * be the one I/O the window exists to avoid.
     */
    track (index, byteLength) {
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new Error('index must be a non-negative safe integer')
      }
      if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
        throw new Error('byteLength must be a positive safe integer')
      }
      if (tracked.has(index)) return stats()
      tracked.add(index)
      queue.push({ index, byteLength })
      residentBytes += byteLength
      if (residentBytes > peakResidentBytes) peakResidentBytes = residentBytes
      return stats()
    },

    /**
     * Offload from the oldest end until the resident block data is within the
     * window. `all: true` offloads every tracked block regardless.
     */
    async drain ({ all = false } = {}) {
      while (queue.length > 0 && (all === true || residentBytes > budget)) {
        await offloadHead()
      }
      return stats()
    },

    /**
     * Give block `index` up because local residency has outgrown the window,
     * not because an ingest is moving past it. Same upload-confirm-delete
     * sequence, asking the object store first: an evicted block is normally
     * one this relay restored from the bucket, and the bucket still has it.
     *
     * Throws rather than delete when the block has no merkle leaf that commits
     * to its bytes, or when the object store will not confirm it holds them.
     * The local copy stays in both cases; it is the only copy.
     *
     * @returns the byte length dropped, or 0 when there was no local copy.
     */
    async evict (index) {
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new Error('index must be a non-negative safe integer')
      }
      const byteLength = await retireBlock(index, { probeRemote: true })
      if (byteLength > 0) forget(index)
      return byteLength
    },
  }
}
