import b4a from 'b4a'
import flat from 'flat-tree'

import { createBlockOffloader } from './block-offloader.js'

// A relay's archive capacity is its disk, and the media blocks are the whole
// title. This wrapper lets a relay keep the part of a core that makes a block
// *verifiable* — the merkle tree and the bitfield — on local disk while the
// block DATA lives in an object store.
//
// It is deliberately a thin skin over a real hypercore-storage instance:
//
//   * everything is delegated, so the wrapper keeps satisfying
//     `CoreStorage.isCoreStorage` (which is only ever
//     `typeof s.setDefaultDiscoveryKey === 'function'`) and can be handed
//     straight to `new Corestore(...)`;
//   * the ONLY interception is `read().getBlock(index)`. Tree nodes, bitfield
//     pages, user data, marks, streams, every write transaction and every
//     flush pass through untouched.
//
// Because the bitfield is untouched, `core.has(index)` still answers true for
// an offloaded block, so the relay keeps advertising it. Because
// `core.proof({ block })` reads the block through this same read transaction,
// a restored block satisfies an authorized peer request with no change
// anywhere above the storage layer.
//
// The object store is never trusted: a restored block is hashed against the
// leaf the core's own merkle tree already committed to (see
// remote-block-store.js), and unverifiable bytes are dropped rather than
// served.
//
// RESTORING IS NOT FREE FOREVER. A restored block is served from memory and
// never written back here, but a relay does not read a title in a vacuum: a
// restore that fails is a local miss like any other, so hypercore asks its
// peers instead and commits what they send — permanently. Left alone, a relay
// that serves its corpus through one bucket outage ends up holding the whole
// corpus again, with the window meaning nothing. So when an eviction window is
// configured, this wrapper also owns the other direction: it measures what is
// really on local disk for each offload-backed core and gives the oldest end
// back until residency is inside the window again. See `eviction` below.

// Per-core storage instances come out of these two CorestoreStorage methods.
const CORE_PRODUCERS = ['resumeCore', 'createCore']

// ...and further per-core instances are derived from those by these
// HypercoreStorage methods. Each derived instance reads the same blocks, so
// each needs the same interception and shares the core's identity.
const DERIVED_PRODUCERS = [
  'snapshot',
  'atomize',
  'createSession',
  'resumeSession',
  'createAtomicSession',
]

// Block reads on one offload-backed core between automatic residency sweeps. A
// converged core's sweep is one head read and one empty range scan, so this
// only exists to keep even that off the front of every single block read.
const SWEEP_EVERY_READS = 64

function isKey (value) {
  return b4a.isBuffer(value) && value.byteLength === 32
}

function hexOf (value) {
  return isKey(value) ? b4a.toString(value, 'hex') : null
}

function errorText (error) {
  if (!error) return 'unknown error'
  return error.message || String(error)
}

/**
 * Eviction is opt-in. Absent, this wrapper is the read-only skin it always
 * was: no sweeps, no ledgers, no counters, no `resolveStore` call a local hit
 * would not have made.
 */
function normalizeEviction (eviction) {
  if (eviction === null || eviction === undefined) return null
  const windowBytes = Number(eviction.windowBytes)
  if (!Number.isSafeInteger(windowBytes) || windowBytes < 0) {
    throw new TypeError('eviction.windowBytes must be a non-negative safe integer')
  }
  const sweepEveryReads = eviction.sweepEveryReads === undefined ? SWEEP_EVERY_READS : Number(eviction.sweepEveryReads)
  if (!Number.isSafeInteger(sweepEveryReads) || sweepEveryReads < 1) {
    throw new TypeError('eviction.sweepEveryReads must be a positive safe integer')
  }
  return {
    windowBytes,
    sweepEveryReads,
    // `({ keyHex, index }) => boolean`, may be async. True pins the block: a
    // player is reading through it and taking it back off disk now would stall
    // playback for a bucket round trip.
    isPinned: typeof eviction.isPinned === 'function' ? eviction.isPinned : null,
    // `({ keyHex }) => boolean`, may be async. False keeps every block of that
    // core on this volume. Restore still answers for it, so blocks already in
    // the bucket stay readable and come home as they are read - excluding a
    // core by refusing it a store would instead strand whatever was already
    // evicted.
    isEvictable: typeof eviction.isEvictable === 'function' ? eviction.isEvictable : null,
  }
}

/**
 * Delegating proxy. Forwards every property; functions are bound to the target
 * so `this` stays the real instance and the storage engine never observes its
 * own state through the proxy. Own keys of `overrides` are consulted first —
 * own keys only, so inherited `Object.prototype` members never shadow the
 * target's.
 */
function delegate (target, overrides) {
  return new Proxy(target, {
    get (object, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property]
      const value = object[property]
      return typeof value === 'function' ? value.bind(object) : value
    },
  })
}

/**
 * @param storage       a hypercore-storage CorestoreStorage (or anything that
 *                      satisfies `isCoreStorage`).
 * @param resolveStore  called with `{ key, keyHex, discoveryKey,
 *                      discoveryKeyHex }` when a block is not held locally.
 *                      Returns a createRemoteBlockStore()-shaped store for an
 *                      offloaded core, or null/undefined for any core that is
 *                      not offloaded — in which case the miss is reported
 *                      exactly as the unwrapped storage would report it. May
 *                      be async.
 * @param log           optional `(message) => void`.
 * @param eviction      optional `{ windowBytes, isPinned, sweepEveryReads }`.
 *                      Present, local block data for each offload-backed core
 *                      is held to `windowBytes` — see the residency section
 *                      below. Absent, nothing here evicts anything.
 */
export function createOffloadStorage ({
  storage,
  resolveStore,
  log,
  eviction = null,
  readAheadBlocks = 0,
  restoreCacheBytes = 0,
} = {}) {
  if (!storage || typeof storage !== 'object' || typeof storage.setDefaultDiscoveryKey !== 'function') {
    throw new TypeError('storage must be a hypercore-storage instance')
  }
  if (typeof resolveStore !== 'function') {
    throw new TypeError('resolveStore is required')
  }
  if (!Number.isSafeInteger(readAheadBlocks) || readAheadBlocks < 0 || readAheadBlocks > 64) {
    throw new TypeError('readAheadBlocks must be an integer between 0 and 64')
  }
  if (!Number.isSafeInteger(restoreCacheBytes) || restoreCacheBytes < 0 || restoreCacheBytes > 256 * 1024 * 1024) {
    throw new TypeError('restoreCacheBytes must be between 0 and 256 MiB')
  }
  const bound = normalizeEviction(eviction)
  const restoreCache = new Map()
  let restoreCacheSize = 0
  const counters = { restored: 0, missing: 0, failed: 0, corrupt: 0 }
  const report = typeof log === 'function' ? log : null

  // One ledger per offload-backed core, keyed by public key hex. Null when no
  // window is configured, and then none of the residency code below ever runs.
  const ledgers = bound === null ? null : new Map()
  const arming = bound === null ? null : new Set()
  const evicted = bound === null
    ? null
    : { sweeps: 0, blocks: 0, bytes: 0, pinned: 0, unconfirmed: 0, unverifiable: 0 }

  function emit (message) {
    if (report === null) return
    try {
      report(`[offload-storage] ${message}`)
    } catch {
      // A logger must never take down a block read.
    }
  }

  function cachedBlock (key) {
    const block = restoreCache.get(key)
    if (!block) return null
    restoreCache.delete(key)
    restoreCache.set(key, block)
    return block
  }

  function cacheBlock (key, block) {
    if (restoreCacheBytes === 0 || !b4a.isBuffer(block) || block.byteLength > restoreCacheBytes) return
    const previous = restoreCache.get(key)
    if (previous) {
      restoreCacheSize -= previous.byteLength
      restoreCache.delete(key)
    }
    restoreCache.set(key, block)
    restoreCacheSize += block.byteLength
    while (restoreCacheSize > restoreCacheBytes && restoreCache.size > 0) {
      const oldestKey = restoreCache.keys().next().value
      const oldest = restoreCache.get(oldestKey)
      restoreCache.delete(oldestKey)
      restoreCacheSize -= oldest.byteLength
    }
  }

  function stats () {
    if (bound === null) return { ...counters }
    // What each core's last sweep left. The retained window is counted at the
    // size the merkle tree says it is rather than read back to be measured, so
    // per swept core this is a ceiling: some of those blocks may not be on disk
    // at all. A core opened but not yet swept contributes nothing yet.
    let residentBytes = 0
    for (const ledger of ledgers.values()) residentBytes += ledger.residentBytes
    return {
      ...counters,
      eviction: {
        windowBytes: bound.windowBytes,
        cores: ledgers.size,
        sweeps: evicted.sweeps,
        evicted: evicted.blocks,
        bytesEvicted: evicted.bytes,
        pinned: evicted.pinned,
        unconfirmed: evicted.unconfirmed,
        unverifiable: evicted.unverifiable,
        residentBytes,
      },
    }
  }

  // ---------------------------------------------------------------------------
  // restore path
  // ---------------------------------------------------------------------------

  /**
   * Run one read against its own short-lived transaction.
   *
   * hypercore-storage read transactions only resolve once someone calls
   * `tryFlush()`, and by the time we know a block is missing the caller's
   * transaction has already been flushed — issuing another get on it would
   * never resolve. Owning the transaction means the restore can neither
   * deadlock the caller's transaction nor leave it unflushed. `read` must call
   * into the transaction synchronously, which every CoreRX getter does.
   */
  async function readOnce (coreStorage, read) {
    const rx = coreStorage.read()
    let pending = null
    try {
      pending = read(rx)
    } finally {
      rx.tryFlush()
    }
    return pending
  }

  /**
   * The 32-byte commitment for block `index` is the hash of merkle tree node
   * `2 * index`. No leaf means the core never committed to this block, so
   * there is nothing an object store could legitimately hand back.
   */
  async function leafHash (coreStorage, index) {
    const node = await readOnce(coreStorage, (rx) => rx.getTreeNode(2 * index))
    return node && isKey(node.hash) ? node.hash : null
  }

  /**
   * `createCore()` is handed the public key up front; `resumeCore()` is only
   * given a discovery key (and may be given nothing at all, falling back to
   * the store default), so the public key is recovered from the core's own
   * auth record. One point lookup, memoised for the life of the core.
   */
  async function completeIdentity (context) {
    const identity = context.identity
    try {
      if (!isKey(identity.key)) {
        const auth = await readOnce(context.storage, (rx) => rx.getAuth())
        if (auth) {
          if (isKey(auth.key)) identity.key = auth.key
          if (isKey(auth.discoveryKey)) identity.discoveryKey = auth.discoveryKey
        }
      }
    } finally {
      identity.pending = null
    }

    const value = {
      key: isKey(identity.key) ? identity.key : null,
      keyHex: hexOf(identity.key),
      discoveryKey: isKey(identity.discoveryKey) ? identity.discoveryKey : null,
      discoveryKeyHex: hexOf(identity.discoveryKey),
    }

    // Only a complete identity is worth caching: a transient read failure must
    // not permanently blind the wrapper to this core.
    if (value.key !== null) {
      identity.complete = true
      identity.value = value
    }
    return value
  }

  function identityOf (context) {
    const identity = context.identity
    if (identity.complete) return identity.value
    if (identity.pending === null) identity.pending = completeIdentity(context)
    return identity.pending
  }

  async function remoteStoreFor (context) {
    const identity = context.identity
    if (identity.remoteStore !== null) return identity.remoteStore
    if (identity.remoteStorePending !== null) return identity.remoteStorePending

    identity.remoteStorePending = Promise.resolve(resolveStore(await identityOf(context)))
      .then((store) => {
        // A configured store is stable for the life of this core. Do not cache
        // null: a core can become offload-backed after it was opened.
        if (store) identity.remoteStore = store
        return store
      })
      .finally(() => { identity.remoteStorePending = null })
    return identity.remoteStorePending
  }

  async function restoreOnce (context, index) {
    let identity = null
    let store = null
    try {
      identity = await identityOf(context)
      store = await remoteStoreFor(context)
    } catch (error) {
      counters.failed++
      emit(`no remote store for block ${index}: ${errorText(error)}`)
      return null
    }
    // Not an offloaded core: a local miss is just a local miss.
    if (!store) return null

    // A miss on an offload-backed core is the freshest evidence there is that
    // this title is being served, so it is the moment to check the bound. The
    // sweep is never awaited: a read waits for its block, not for housekeeping.
    if (context.identity.ledger !== null) queueSweep(context.identity.ledger)

    const label = `${store.coreKey || identity.keyHex || identity.discoveryKeyHex || 'unknown'} block ${index}`

    try {
      const expectedHash = await leafHash(context.storage, index)
      if (expectedHash === null) {
        counters.missing++
        return null
      }

      const block = await store.get(index, { expectedHash })
      if (block === null || block === undefined) {
        counters.missing++
        return null
      }

      counters.restored++
      return block
    } catch (error) {
      if (error && error.code === 'REMOTE_BLOCK_CORRUPT') {
        // Loud: the object store handed back bytes the tree does not commit
        // to. They are dropped here, never returned, never served to a peer.
        counters.corrupt++
        emit(`CORRUPT ${label}: restored bytes do not match the merkle tree, refusing to serve them`)
        return null
      }
      // A transport outage must never surface as core corruption. Say so once
      // and behave exactly as if the block were simply not held locally.
      counters.failed++
      emit(`unreachable ${label}: ${errorText(error)}`)
      return null
    }
  }

  async function restore (context, index, { prefetch = true } = {}) {
    const identity = await identityOf(context)
    const key = `${identity.keyHex || identity.discoveryKeyHex || 'unknown'}:${index}`
    const cached = cachedBlock(key)
    if (cached) return cached

    const pending = context.identity.pendingRestores.get(index)
    if (pending) return pending

    const restoring = restoreOnce(context, index)
      .then((block) => {
        if (block) cacheBlock(key, block)
        return block
      })
      .finally(() => { context.identity.pendingRestores.delete(index) })
    context.identity.pendingRestores.set(index, restoring)
    const block = await restoring
    if (block && prefetch && readAheadBlocks > 0) {
      for (let ahead = 1; ahead <= readAheadBlocks; ahead++) {
        restore(context, index + ahead, { prefetch: false }).catch(() => {})
      }
    }
    return block
  }

  // ---------------------------------------------------------------------------
  // residency
  // ---------------------------------------------------------------------------
  //
  // The bound is a property of local disk, not of a counter, so every sweep
  // asks the disk. Two questions, both cheap:
  //
  //   * WHICH BLOCKS DOES THE WINDOW KEEP? If the whole core fits in the window
  //     — which every catalog, bee and index core a relay opens does — its
  //     merkle roots say so in log2(length) point reads and the sweep is over.
  //     Otherwise walk down from the top of the core adding leaf sizes until
  //     the next block would not fit. That is the same "newest end stays,
  //     oldest end goes" the ingest offloader applies, and it is still only
  //     tree reads: the retained window is never read just to be measured.
  //
  //   * WHICH BLOCKS BELOW THAT ARE STILL HERE? Stream that part of the block
  //     keyspace. The bitfield cannot answer it: it says true for an offloaded
  //     block by design. On a converged core the range is empty and the scan
  //     costs one iterator; on a core that grew back it yields exactly the
  //     blocks about to be evicted, whose bytes have to be read anyway to be
  //     hashed against the tree before anything is deleted.
  //
  // Nothing is remembered across a restart, and nothing needs to be: the first
  // sweep after a relay comes back up reaches the same answer from the same
  // disk.

  function ledgerFor (keyHex, coreStorage, store) {
    const existing = ledgers.get(keyHex)
    if (existing !== undefined) return existing
    const ledger = {
      keyHex,
      storage: coreStorage,
      // One place drops a local block copy, and this is it: the same
      // upload-confirm-delete the ingest window uses (block-offloader.js).
      offloader: createBlockOffloader({ storage: coreStorage, store, windowBytes: bound.windowBytes, log }),
      // Memoised per core length: an archived title's tree never changes again.
      boundary: null,
      length: -1,
      reads: 0,
      residentBytes: 0,
      sweeping: null,
      again: false,
    }
    ledgers.set(keyHex, ledger)
    return ledger
  }

  /**
   * Decide once per core whether its local block data is a cache with a bound
   * or the only copy in existence.
   *
   * Asked when the core is OPENED, not on its first local miss: a relay that
   * restarts holding a full local cache has no misses to be triggered by, and
   * it is precisely the relay that has to give the disk back.
   */
  async function arm (context) {
    const identity = await identityOf(context)
    if (identity.keyHex === null) return null
    const store = await resolveStore(identity)
    // No remote store: these blocks are the only copy. Never evict from it.
    if (!store) return null
    const ledger = ledgerFor(identity.keyHex, context.storage, store)
    context.identity.ledger = ledger
    return ledger
  }

  function armAndSweep (context) {
    const pending = arm(context)
      .then((ledger) => (ledger === null ? null : queueSweep(ledger)))
      .catch((error) => emit(`residency arming failed: ${errorText(error)}`))
      .finally(() => arming.delete(pending))
    arming.add(pending)
    return pending
  }

  /**
   * A core's total byte length, from its merkle roots. Every tree of `length`
   * blocks has at most log2(length) of them and each carries the byte span it
   * covers, so this is the whole size of a title in a handful of point reads.
   */
  async function treeBytes (ledger, length) {
    let bytes = 0
    for (const root of flat.fullRoots(2 * length)) {
      const node = await readOnce(ledger.storage, (rx) => rx.getTreeNode(root))
      const size = node === null || node === undefined ? -1 : Number(node.size)
      if (!Number.isSafeInteger(size) || size < 0) return null
      bytes += size
    }
    return bytes
  }

  /**
   * The lowest index the window keeps, and the bytes it keeps there. Blocks
   * below it are what an over-window core gives up, oldest first.
   */
  async function keepBoundary (ledger, length) {
    if (ledger.boundary !== null && ledger.length === length) return ledger.boundary

    // A core that fits inside the window has nothing below it, and this is how
    // that is settled in a few reads instead of one per block. It matters most
    // for what a relay opens the MOST of: every catalog, bee and index core is
    // orders of magnitude smaller than a media window, and each one exits here
    // having read a handful of tree nodes and given up nothing.
    const total = await treeBytes(ledger, length)
    if (total !== null && total <= bound.windowBytes) {
      ledger.boundary = { index: 0, bytes: total }
      ledger.length = length
      return ledger.boundary
    }

    let index = length
    let bytes = 0
    while (index > 0) {
      const node = await readOnce(ledger.storage, (rx) => rx.getTreeNode(2 * (index - 1)))
      const size = node === null || node === undefined ? 0 : Number(node.size)
      // No leaf for this block, or one more block would put the window over
      // budget: the window stops here.
      if (!Number.isSafeInteger(size) || size <= 0 || bytes + size > bound.windowBytes) break
      bytes += size
      index--
    }
    ledger.boundary = { index, bytes }
    ledger.length = length
    return ledger.boundary
  }

  /**
   * Every block below `boundary` whose DATA is still on local disk, oldest
   * first — which is the order they are given up in.
   */
  async function residentBelow (ledger, boundary) {
    const resident = []
    if (boundary <= 0) return resident
    for await (const block of ledger.storage.createBlockStream({ lt: boundary })) {
      resident.push({ index: block.index, byteLength: block.value.byteLength })
    }
    return resident
  }

  async function pinned (ledger, index) {
    if (bound.isPinned === null) return false
    try {
      return await bound.isPinned({ keyHex: ledger.keyHex, index }) === true
    } catch (error) {
      // A playback signal that throws pins nothing, and says so once. Guessing
      // "not pinned" is the answer that could stutter a player; guessing
      // "pinned" is the answer that could stall the bound forever.
      emit(`playback pin check failed for ${ledger.keyHex} block ${index}: ${errorText(error)}`)
      return false
    }
  }

  async function runSweep (ledger) {
    const head = await readOnce(ledger.storage, (rx) => rx.getHead())
    const length = head === null || head === undefined ? 0 : Number(head.length)
    if (!Number.isSafeInteger(length) || length <= 0) return

    // A sweep and an ingest can be looking at the same core, and that is fine:
    // both are draining the same oldest end to the same window, both go through
    // one upload-confirm-delete, and a block the other already took reads back
    // as absent and costs nothing. Deferring instead would cost the case that
    // matters most — a relay that boots holding a full cache and is only ever
    // asked to serve it has no append to wait for.
    const boundary = await keepBoundary(ledger, length)

    evicted.sweeps++

    // Ceiling, not measurement: the window is counted at its full tree size.
    let retained = boundary.bytes
    let stopped = false
    for (const block of await residentBelow(ledger, boundary.index)) {
      if (stopped) {
        retained += block.byteLength
        continue
      }
      if (await pinned(ledger, block.index)) {
        // A player is reading through this block. It stays, residency stays
        // over the window by its size, and the next sweep past the playhead
        // takes it.
        evicted.pinned++
        retained += block.byteLength
        continue
      }
      try {
        // 0 means a concurrent sweep or ingest already dropped it: nothing
        // left, nothing to count.
        const bytes = await ledger.offloader.evict(block.index)
        if (bytes > 0) {
          evicted.blocks++
          evicted.bytes += bytes
        }
      } catch (error) {
        // Nothing was deleted: the offloader refuses to drop a block the object
        // store would not confirm, or one the merkle tree does not commit to.
        retained += block.byteLength
        if (error && error.code === 'OFFLOAD_BLOCK_UNVERIFIABLE') {
          evicted.unverifiable++
        } else {
          // The object store is the dependency every remaining block shares, so
          // one refusal is the whole sweep's answer. The next sweep tries again.
          evicted.unconfirmed++
          stopped = true
        }
        emit(`kept ${ledger.keyHex} block ${block.index} on local disk: ${errorText(error)}`)
      }
    }
    ledger.residentBytes = retained
  }

  // Asked per sweep rather than cached on the ledger: the storage layer can
  // only register a core as keep-local once it knows that core's real key,
  // which is after the core is open - by which time this ledger already exists.
  // A cached answer would be the answer from before the operator's list was
  // known.
  async function evictable (ledger) {
    if (bound.isEvictable === null) return true
    try {
      return await bound.isEvictable({ keyHex: ledger.keyHex }) !== false
    } catch (error) {
      // A list that cannot be read is not permission to evict.
      emit(`evictability check failed for ${ledger.keyHex}: ${errorText(error)}`)
      return false
    }
  }

  async function drainSweeps (ledger) {
    do {
      ledger.again = false
      try {
        if (!(await evictable(ledger))) return
        await runSweep(ledger)
      } catch (error) {
        // Housekeeping never surfaces into a read.
        emit(`residency sweep failed for ${ledger.keyHex}: ${errorText(error)}`)
      }
    } while (ledger.again)
  }

  /**
   * One sweep at a time per core. A trigger that arrives during a sweep is
   * folded into exactly one more pass, so a core being read hard cannot queue
   * an unbounded chain of them.
   */
  function queueSweep (ledger) {
    if (ledger.sweeping !== null) {
      ledger.again = true
      return ledger.sweeping
    }
    ledger.sweeping = drainSweeps(ledger).finally(() => { ledger.sweeping = null })
    return ledger.sweeping
  }

  function noteRead (ledger) {
    if (++ledger.reads < bound.sweepEveryReads) return
    ledger.reads = 0
    queueSweep(ledger)
  }

  /**
   * Apply the bound now and resolve when every armed core is inside it.
   *
   * Reads arm sweeps on their own; this is for a caller that needs the bound
   * applied at a known point — an operator command, a shutdown, a test.
   */
  async function sweepNow () {
    if (bound === null) return stats()
    // A core may still be resolving its own identity.
    await Promise.all([...arming])
    const pending = []
    for (const ledger of ledgers.values()) {
      ledger.reads = 0
      pending.push(queueSweep(ledger))
    }
    await Promise.all(pending)
    return stats()
  }

  // ---------------------------------------------------------------------------
  // interception
  // ---------------------------------------------------------------------------

  function wrapRead (rx, context) {
    return delegate(rx, {
      getBlock (index) {
        // Every block read on an offload-backed core is a chance the local
        // footprint has grown behind our back — hypercore commits what a peer
        // sends without going through here. Null until this core is known to
        // be offload-backed, and permanently null when no window is configured.
        const ledger = context.identity.ledger
        if (ledger !== null) noteRead(ledger)
        // Call through synchronously so this read still joins the caller's
        // transaction and is resolved by the caller's `tryFlush()`. What we
        // hand back is only a continuation of that same promise.
        return rx.getBlock(index).then((block) => {
          if (block !== null && block !== undefined) return block
          return restore(context, index)
        })
      },
    })
  }

  function wrapCoreStorage (coreStorage, identity) {
    if (!coreStorage || typeof coreStorage.read !== 'function') return coreStorage

    const context = { storage: coreStorage, identity }

    const overrides = {
      read (fork) {
        return wrapRead(coreStorage.read(fork), context)
      },
    }

    for (const name of DERIVED_PRODUCERS) {
      if (typeof coreStorage[name] !== 'function') continue
      overrides[name] = (...args) => {
        const derived = coreStorage[name](...args)
        // Sessions and atomic sessions are async; snapshot and atomize are not.
        if (derived && typeof derived.then === 'function') {
          return derived.then((value) => wrapCoreStorage(value, identity))
        }
        return wrapCoreStorage(derived, identity)
      }
    }

    return delegate(coreStorage, overrides)
  }

  // ---------------------------------------------------------------------------
  // top level
  // ---------------------------------------------------------------------------

  const overrides = {
    // Shadows CorestoreStorage#stats, an internal tree-cache counter object.
    // hypercore-storage only ever reads that as `this.stats` / `this.store.stats`
    // on raw instances, and every method reached through this proxy is bound to
    // the raw instance, so the shadow is not observable inside the engine.
    // `offloadStats` is the unambiguous name for callers that hold both.
    stats,
    offloadStats: stats,
    offloadSweep: sweepNow,
  }

  for (const name of CORE_PRODUCERS) {
    if (typeof storage[name] !== 'function') continue
    overrides[name] = async (...args) => {
      const coreStorage = await storage[name](...args)
      if (!coreStorage) return coreStorage
      const identity = seedIdentity(name, args)
      // Opening a core is the one moment a relay is guaranteed to reach, full
      // local cache or not, so it is where the bound gets a chance to apply.
      if (bound !== null && typeof coreStorage.read === 'function') {
        armAndSweep({ storage: coreStorage, identity })
      }
      return wrapCoreStorage(coreStorage, identity)
    }
  }

  return delegate(storage, overrides)
}

function seedIdentity (method, args) {
  const seed = method === 'resumeCore' ? { discoveryKey: args[0] } : (args[0] || {})
  return {
    key: isKey(seed.key) ? seed.key : null,
    discoveryKey: isKey(seed.discoveryKey) ? seed.discoveryKey : null,
    complete: false,
    pending: null,
    value: null,
    // Set once this core is known to be offload-backed, and shared by every
    // derived read transaction so any of them can arm a residency sweep.
    ledger: null,
    remoteStore: null,
    remoteStorePending: null,
    pendingRestores: new Map(),
  }
}
