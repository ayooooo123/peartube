import b4a from 'b4a'
import crypto from 'hypercore-crypto'

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
//   * the primary read interception is `read().getBlock(index)` to restore
//     offloaded blocks from S3 on a miss. Block write transactions
//     (`putBlock` and `deleteBlock`) are observed only for committed byte
//     accounting; all non-block storage behavior remains delegated unchanged.
//     Tree nodes, bitfield pages, user data, marks, and streams pass through untouched.
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

function resolveCoreKeys (core, coreKey) {
  let resolvedKey = core?.key || null
  if (!resolvedKey) {
    if (isKey(coreKey)) {
      resolvedKey = coreKey
    } else if (typeof coreKey === 'string' && /^[0-9a-f]{64}$/i.test(coreKey)) {
      resolvedKey = b4a.from(coreKey, 'hex')
    }
  }
  const keyHex = hexOf(resolvedKey) || (typeof coreKey === 'string' ? coreKey.toLowerCase() : null)
  return { resolvedKey, keyHex }
}

function createUnavailableRetrievabilityResult (coreKey) {
  return {
    success: false,
    coreKey,
    error: 'CORE_STORAGE_UNAVAILABLE',
    requestedBlocks: 0,
    assessedBlocks: 0,
    totalBlocks: 0,
    residentBlocks: 0,
    residentBytes: 0,
    remoteRetrievableBlocks: 0,
    remoteRetrievableBytes: 0,
    unretrievableBlocks: 0,
    missingBlocks: 0,
    corruptBlocks: 0,
    unreachableBlocks: 0,
    logicalBitfieldBlocks: 0,
    ranges: [],
    residentRanges: [],
    remoteRetrievableRanges: [],
    unavailableRanges: [],
    status: 'unretrievable',
    isLocallyResident: false,
    isRetrievable: false,
    hasUnretrievable: true,
    truncated: false,
    aborted: false,
    nextCursor: null,
    assessmentPending: false,
    observedAt: Date.now(),
  }
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
    // `() => Promise`, optional gate that is awaited before a sweep starts.
    // This is separate from `isEvictable`: a registration hold must let a core
    // arm and accept writes while keeping destructive sweeps out of the way.
    waitForSweep: typeof eviction.waitForSweep === 'function' ? eviction.waitForSweep : null,
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
 * @param eviction      optional `{ windowBytes, isPinned, waitForSweep, sweepEveryReads }`.
 *                      Present, local block data for each offload-backed core
 *                      is held to `windowBytes` — see the residency section
 *                      below. Absent, nothing here evicts anything.
 */
function validateCreateOffloadStorageArgs({ storage, resolveStore, readAheadBlocks, restoreCacheBytes }) {
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
}

export function createOffloadStorage ({
  storage,
  resolveStore,
  log,
  eviction = null,
  readAheadBlocks = 0,
  restoreCacheBytes = 0,
} = {}) {
  validateCreateOffloadStorageArgs({ storage, resolveStore, readAheadBlocks, restoreCacheBytes })
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
    : {
      sweeps: 0,
      blocks: 0,
      bytes: 0,
      pinned: 0,
      unconfirmed: 0,
      unverifiable: 0,
      pinnedBytes: 0,
      unconfirmedBytes: 0,
      unverifiableBytes: 0,
      overageBytes: 0,
    }
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
    let residentBytes = 0
    let countedCores = 0
    for (const ledger of ledgers.values()) {
      if (ledger.countedInResidency) {
        residentBytes += ledger.residentBytes
        countedCores++
      }
    }
    const overageBytes = Math.max(0, residentBytes - bound.windowBytes)
    return {
      ...counters,
      eviction: {
        windowBytes: bound.windowBytes,
        cores: countedCores,
        sweeps: evicted.sweeps,
        evicted: evicted.blocks,
        bytesEvicted: evicted.bytes,
        pinned: evicted.pinned,
        unconfirmed: evicted.unconfirmed,
        unverifiable: evicted.unverifiable,
        residentBytes,
        overageBytes,
        pinnedBytes: evicted.pinnedBytes,
        unconfirmedBytes: evicted.unconfirmedBytes,
        unverifiableBytes: evicted.unverifiableBytes,
      },
    }
  }

  // ---------------------------------------------------------------------------
  // restore path
  // ---------------------------------------------------------------------------


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
        const contentKey = typeof store.contentKey === 'function' ? store.contentKey(expectedHash) : 'unknown'
        emit(`MISSING ${label}: object ${contentKey} is absent`)
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
    if (existing !== undefined) {
      if (store && !existing.store) existing.store = store
      return existing
    }
    const ledger = {
      keyHex,
      storage: coreStorage,
      store,
      // One place drops a local block copy, and this is it: the same
      // upload-confirm-delete the ingest window uses (block-offloader.js).
      offloader: createBlockOffloader({ storage: coreStorage, store, windowBytes: bound.windowBytes, log }),
      length: -1,
      reads: 0,
      residentBytes: 0,
      countedInResidency: false,
      lastAccessedAt: Date.now(),
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
    if (await evictable(ledger)) {
      ledger.countedInResidency = true
      await serializeAccounting(() => reconcileLedger(ledger))
    } else {
      ledger.countedInResidency = false
      ledger.residentBytes = 0
    }
    return ledger
  }
  function armAndSweep (context) {
    const pending = arm(context)
      .then((ledger) => {
        if (ledger !== null) void queueSweep()
      })
      .catch((error) => emit(`residency arming failed: ${errorText(error)}`))
      .finally(() => {
        arming.delete(pending)
        if (context.identity.armPending === pending) {
          context.identity.armPending = null
        }
      })
    context.identity.armPending = pending
    arming.add(pending)
    return pending
  }

  async function evictable (ledger) {
    if (bound.isEvictable === null) return true
    try {
      return await bound.isEvictable({ keyHex: ledger.keyHex }) !== false
    } catch (error) {
      emit(`evictability check failed for ${ledger.keyHex}: ${errorText(error)}`)
      return false
    }
  }

  async function waitForSweep () {
    if (bound.waitForSweep === null) return
    try {
      await bound.waitForSweep()
    } catch (error) {
      emit(`residency sweep hold failed: ${errorText(error)}`)
      throw error
    }
  }

  async function pinned (ledger, index) {
    if (bound.isPinned === null) return false
    try {
      return await bound.isPinned({ keyHex: ledger.keyHex, index }) === true
    } catch (error) {
      emit(`pin check failed for ${ledger.keyHex}: ${errorText(error)}`)
      return true
    }
  }

  async function reconcileLedger (ledger) {
    if (!(await evictable(ledger))) {
      ledger.countedInResidency = false
      ledger.residentBytes = 0
      ledger.dirty = false
      return
    }
    ledger.countedInResidency = true
    const head = await readOnce(ledger.storage, (rx) => rx.getHead())
    const length = head === null || head === undefined ? 0 : Number(head.length)
    if (!Number.isSafeInteger(length) || length <= 0) {
      ledger.length = 0
      ledger.residentBytes = 0
      ledger.dirty = false
      return
    }
    ledger.length = length
    let bytes = 0
    for await (const block of ledger.storage.createBlockStream()) {
      if (block?.value?.byteLength) {
        bytes += block.value.byteLength
      }
    }
    ledger.residentBytes = bytes
    ledger.dirty = false
  }

  async function runRelayWideSweep () {
    evicted.pinned = 0
    evicted.pinnedBytes = 0
    evicted.unconfirmedBytes = 0
    evicted.unverifiableBytes = 0
    evicted.overageBytes = 0

    const activeLedgers = []
    for (const ledger of ledgers.values()) {
      if (await evictable(ledger)) {
        ledger.countedInResidency = true
        if (ledger.dirty) await reconcileLedger(ledger)
        activeLedgers.push(ledger)
      } else {
        ledger.countedInResidency = false
        ledger.residentBytes = 0
      }
    }
    if (activeLedgers.length === 0) return
    evicted.sweeps++

    activeLedgers.sort((a, b) => (a.lastAccessedAt - b.lastAccessedAt) || a.keyHex.localeCompare(b.keyHex))

    let totalResident = 0
    for (const ledger of activeLedgers) {
      totalResident += ledger.residentBytes
    }

    if (totalResident <= bound.windowBytes) {
      return
    }

    let currentPinnedBytes = 0
    let currentUnconfirmedBytes = 0
    let currentUnverifiableBytes = 0

    for (const ledger of activeLedgers) {
      const protectedBytes = currentPinnedBytes + currentUnconfirmedBytes + currentUnverifiableBytes
      if ((totalResident - protectedBytes) <= bound.windowBytes) break

      for await (const block of ledger.storage.createBlockStream()) {
        const curProtected = currentPinnedBytes + currentUnconfirmedBytes + currentUnverifiableBytes
        if ((totalResident - curProtected) <= bound.windowBytes) break

        const byteLength = block.value ? block.value.byteLength : 0
        if (byteLength <= 0) continue

        if (await pinned(ledger, block.index)) {
          evicted.pinned++
          currentPinnedBytes += byteLength
          continue
        }

        try {
          const bytes = await ledger.offloader.evict(block.index)
          if (bytes > 0) {
            evicted.blocks++
            evicted.bytes += bytes
            ledger.residentBytes = Math.max(0, ledger.residentBytes - bytes)
            totalResident -= bytes
          }
        } catch (error) {
          emit(`kept ${ledger.keyHex} block ${block.index} on local disk: ${errorText(error)}`)
          if (error && error.code === 'OFFLOAD_BLOCK_UNVERIFIABLE') {
            evicted.unverifiable++
            currentUnverifiableBytes += byteLength
          } else {
            evicted.unconfirmed++
            currentUnconfirmedBytes += byteLength
            break
          }
        }
      }
    }

    evicted.pinnedBytes = currentPinnedBytes
    evicted.unconfirmedBytes = currentUnconfirmedBytes
    evicted.unverifiableBytes = currentUnverifiableBytes
    evicted.overageBytes = Math.max(0, totalResident - bound.windowBytes)
  }

  let accountingQueue = Promise.resolve()
  function serializeAccounting (action) {
    const next = accountingQueue.then(action, action)
    accountingQueue = next.catch(() => {})
    return next
  }

  let sweeping = null
  let sweepAgain = false

  async function drainSweeps () {
    do {
      sweepAgain = false
      try {
        await waitForSweep()
        await serializeAccounting(() => runRelayWideSweep())
      } catch (error) {
        emit(`relay-wide residency sweep failed: ${errorText(error)}`)
      }
    } while (sweepAgain)
  }

  function queueSweep () {
    if (bound === null) return Promise.resolve(stats())
    if (sweeping !== null) {
      sweepAgain = true
      return sweeping
    }
    sweeping = drainSweeps().finally(() => { sweeping = null })
    return sweeping
  }

  function noteRead (ledger) {
    ledger.lastAccessedAt = Date.now()
    if (++ledger.reads < bound.sweepEveryReads) return
    ledger.reads = 0
    let totalResident = 0
    for (const l of ledgers.values()) {
      if (l.countedInResidency) totalResident += l.residentBytes
    }
    if (totalResident > bound.windowBytes) {
      queueSweep()
    }
  }

  async function sweepNow () {
    if (bound === null) return stats()
    await Promise.all([...arming])
    await waitForSweep()
    await serializeAccounting(async () => {
      for (const ledger of ledgers.values()) {
        ledger.reads = 0
        if (await evictable(ledger)) {
          await reconcileLedger(ledger)
        } else {
          ledger.countedInResidency = false
          ledger.residentBytes = 0
        }
      }
    })
    await queueSweep()
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

  function wrapWrite (tx, context) {
    const staged = new Map()
    return delegate(tx, {
      putBlock (index, data) {
        staged.set(index, data && data.byteLength ? data.byteLength : 0)
        return tx.putBlock(index, data)
      },
      deleteBlock (index) {
        staged.set(index, 0)
        return tx.deleteBlock(index)
      },
      async flush () {
        if (staged.size === 0) {
          return tx.flush()
        }
        if (context.identity.armPending !== null) {
          await context.identity.armPending.catch(() => {})
        }
        const ledger = context.identity.ledger
        if (!ledger) {
          return tx.flush()
        }
        let shouldSweep = false
        const writePromise = serializeAccounting(async () => {
          let netDelta = 0
          for (const [index, newLength] of staged) {
            let oldLength = 0
            try {
              const old = await readOnce(context.storage, (rx) => rx.getBlock(index))
              if (old && old.byteLength) oldLength = old.byteLength
            } catch {
              oldLength = 0
            }
            netDelta += (newLength - oldLength)
          }
          const res = await tx.flush()
          ledger.lastAccessedAt = Date.now()
          ledger.residentBytes = Math.max(0, ledger.residentBytes + netDelta)
          staged.clear()
          if (bound !== null && ledger.countedInResidency) {
            let total = 0
            for (const l of ledgers.values()) {
              if (l.countedInResidency) total += l.residentBytes
            }
            if (total > bound.windowBytes) {
              shouldSweep = true
            }
          }
          return res
        })
        return writePromise.then((result) => {
          if (shouldSweep) queueSweep()
          return result
        })
      },
    })
  }

  function wrapCoreStorage (coreStorage, identity) {
    if (!coreStorage || typeof coreStorage.read !== 'function') return coreStorage

    const context = { storage: coreStorage, identity }

    const overrides = {
      _isOffloadWrapped: true,
      read (fork) {
        return wrapRead(coreStorage.read(fork), context)
      },
      write (fork) {
        return wrapWrite(coreStorage.write(fork), context)
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

  async function resolveAssessmentStore (resolvedKey, keyHex, core, ledger) {
    let store = ledger?.store || null
    if (!store && typeof resolveStore === 'function' && resolvedKey) {
      store = await resolveStore({ key: resolvedKey, keyHex, discoveryKey: core?.discoveryKey })
      if (store && ledger && !ledger.store) ledger.store = store
    }
    return store
  }

  async function resolveAssessmentStorage (core, resolvedKey, ledger) {
    let coreStorage = ledger?.storage || null
    let temporaryStorage = null
    if (!coreStorage) {
      try {
        const dKey = core?.discoveryKey || (resolvedKey ? crypto.discoveryKey(resolvedKey) : null)
        if (dKey) {
          temporaryStorage = await storage.resumeCore(dKey)
          coreStorage = temporaryStorage
        }
      } catch {
        coreStorage = null
      }
    }
    return { coreStorage, temporaryStorage }
  }

  async function assessRelayRetrievability ({
    core = null,
    coreKey = null,
    ranges = null,
    cursor = null,
    signal = null,
    maxBlocks = 2048,
    probeRemote = true,
    followContinuations = false,
  } = {}) {
    const { resolvedKey, keyHex } = resolveCoreKeys(core, coreKey)
    if (!keyHex) {
      throw new TypeError('assessRetrievability requires core or coreKey')
    }

    const ledger = ledgers ? ledgers.get(keyHex) : null
    const store = await resolveAssessmentStore(resolvedKey, keyHex, core, ledger)
    const { coreStorage, temporaryStorage } = await resolveAssessmentStorage(core, resolvedKey, ledger)

    if (!coreStorage || typeof coreStorage.read !== 'function') {
      return createUnavailableRetrievabilityResult(keyHex)
    }

    try {
      const pageArgs = {
        core,
        storage: coreStorage,
        store,
        coreKey: resolvedKey,
        ranges,
        cursor,
        signal,
        maxBlocks,
        probeRemote,
      }
      if (followContinuations !== true) {
        return await assessCoreRetrievability({ ...pageArgs, cursor })
      }
      return await accumulateRetrievabilityPages(pageArgs)
    } finally {
      if (temporaryStorage && typeof temporaryStorage.close === 'function') {
        await temporaryStorage.close().catch(() => {})
      }
    }
  }

  const overrides = {
    stats,
    offloadStats: stats,
    offloadSweep: sweepNow,
    assessRetrievability: assessRelayRetrievability,
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
    armPending: null,
    remoteStore: null,
    remoteStorePending: null,
    pendingRestores: new Map(),
  }
}

const DEFAULT_MAX_ASSESSMENT_BLOCKS = 2048
const MAX_ASSESSMENT_BLOCK_CEILING = 4096

function pushExactRange (list, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return
  const last = list.length > 0 ? list[list.length - 1] : null
  if (last && last.end === start) {
    last.end = end
    return
  }
  list.push({ start, end })
}

function mergeExactRanges (left = [], right = []) {
  const merged = []
  for (const range of [...left, ...right]) {
    pushExactRange(merged, Number(range?.start), Number(range?.end))
  }
  if (merged.length <= 1) return merged
  merged.sort((a, b) => a.start - b.start || a.end - b.end)
  const out = [{ start: merged[0].start, end: merged[0].end }]
  for (let i = 1; i < merged.length; i++) {
    const prev = out[out.length - 1]
    const cur = merged[i]
    if (cur.start <= prev.end) {
      if (cur.end > prev.end) prev.end = cur.end
    } else {
      out.push({ start: cur.start, end: cur.end })
    }
  }
  return out
}

function finalizeRetrievabilityStatus (acc) {
  const {
    requestedBlocks,
    assessedBlocks,
    residentBlocks,
    remoteRetrievableBlocks,
    unretrievableBlocks,
    truncated,
    aborted,
  } = acc
  let status = 'unretrievable'
  if (truncated || aborted) {
    status = (residentBlocks + remoteRetrievableBlocks) > 0 ? 'partial' : 'unretrievable'
  } else if (requestedBlocks > 0 && assessedBlocks === requestedBlocks && residentBlocks === requestedBlocks) {
    status = 'resident'
  } else if (requestedBlocks > 0 && assessedBlocks === requestedBlocks && (residentBlocks + remoteRetrievableBlocks) === requestedBlocks) {
    status = 'retrievable'
  } else if ((residentBlocks + remoteRetrievableBlocks) > 0) {
    status = 'partial'
  }
  acc.status = status
  acc.isLocallyResident = !truncated && !aborted && requestedBlocks > 0 && assessedBlocks === requestedBlocks && residentBlocks === requestedBlocks
  acc.isRetrievable = !truncated && !aborted && requestedBlocks > 0 && assessedBlocks === requestedBlocks && (residentBlocks + remoteRetrievableBlocks) === requestedBlocks
  acc.hasUnretrievable = unretrievableBlocks > 0
  acc.assessmentPending = truncated === true || aborted === true
  acc.totalBlocks = assessedBlocks
  acc.bounded = truncated === true
  acc.observedAt = Date.now()
  return acc
}

function createInitialRetrievabilityAccumulator () {
  return {
    success: true,
    coreKey: null,
    requestedBlocks: 0,
    assessedBlocks: 0,
    totalBlocks: 0,
    residentBlocks: 0,
    residentBytes: 0,
    remoteRetrievableBlocks: 0,
    remoteRetrievableBytes: 0,
    unretrievableBlocks: 0,
    missingBlocks: 0,
    corruptBlocks: 0,
    unreachableBlocks: 0,
    logicalBitfieldBlocks: 0,
    ranges: [],
    residentRanges: [],
    remoteRetrievableRanges: [],
    unavailableRanges: [],
    status: 'unretrievable',
    isLocallyResident: false,
    isRetrievable: false,
    hasUnretrievable: false,
    truncated: false,
    aborted: false,
    nextCursor: null,
    assessmentPending: false,
    bounded: false,
    observedAt: Date.now(),
  }
}

function mergeRetrievabilityPage (acc, page) {
  acc.coreKey = page.coreKey || acc.coreKey
  if (acc.requestedBlocks === 0) acc.requestedBlocks = Number(page.requestedBlocks) || 0
  acc.assessedBlocks += Number(page.assessedBlocks) || 0
  acc.residentBlocks += Number(page.residentBlocks) || 0
  acc.residentBytes += Number(page.residentBytes) || 0
  acc.remoteRetrievableBlocks += Number(page.remoteRetrievableBlocks) || 0
  acc.remoteRetrievableBytes += Number(page.remoteRetrievableBytes) || 0
  acc.unretrievableBlocks += Number(page.unretrievableBlocks) || 0
  acc.missingBlocks += Number(page.missingBlocks) || 0
  acc.corruptBlocks += Number(page.corruptBlocks) || 0
  acc.unreachableBlocks += Number(page.unreachableBlocks) || 0
  acc.logicalBitfieldBlocks += Number(page.logicalBitfieldBlocks) || 0
  if (Array.isArray(page.ranges) && page.ranges.length > 0) acc.ranges.push(...page.ranges)
  acc.residentRanges = mergeExactRanges(acc.residentRanges, page.residentRanges || [])
  acc.remoteRetrievableRanges = mergeExactRanges(acc.remoteRetrievableRanges, page.remoteRetrievableRanges || [])
  acc.unavailableRanges = mergeExactRanges(acc.unavailableRanges, page.unavailableRanges || [])
}

async function accumulateRetrievabilityPages (pageArgs = {}) {
  let cursor = pageArgs.cursor ?? null
  const acc = createInitialRetrievabilityAccumulator()

  for (;;) {
    if (pageArgs.signal?.aborted) {
      acc.aborted = true
      acc.truncated = true
      break
    }
    const page = await assessCoreRetrievability({ ...pageArgs, cursor })
    if (!page || page.success === false) {
      if (page) {
        acc.success = page.success
        acc.coreKey = page.coreKey || acc.coreKey
        acc.error = page.error
      }
      break
    }
    mergeRetrievabilityPage(acc, page)

    if (page.aborted === true) {
      acc.aborted = true
      acc.truncated = true
      acc.nextCursor = page.nextCursor || null
      break
    }
    if (page.truncated === true && page.nextCursor) {
      cursor = page.nextCursor
      continue
    }
    acc.truncated = false
    acc.nextCursor = null
    break
  }

  return finalizeRetrievabilityStatus(acc)
}

function getRawAssessmentStorage (storage, core) {
  const candidateStorage = storage || (core?.state?.storage && !core.state.storage._isOffloadWrapped ? core.state.storage : null)
  if (!candidateStorage || typeof candidateStorage.read !== 'function' || candidateStorage._isOffloadWrapped) {
    throw new TypeError('assessCoreRetrievability requires explicit raw storage with read(); wrapped storage triggers S3 restores and is refused')
  }
  return candidateStorage
}

function normalizeAssessmentOptions (options = {}) {
  const core = options.core || null
  const coreKey = options.coreKey || null
  const { resolvedKey, keyHex } = resolveCoreKeys(core, coreKey)
  const coreStorage = getRawAssessmentStorage(options.storage, core)
  const maxBlocks = options.maxBlocks
  const boundedMaxBlocks = Math.min(
    Math.max(1, Number.isSafeInteger(maxBlocks) && maxBlocks > 0 ? maxBlocks : DEFAULT_MAX_ASSESSMENT_BLOCKS),
    MAX_ASSESSMENT_BLOCK_CEILING
  )
  const startRangeIdx = Number.isSafeInteger(options.cursor?.rangeIndex) && options.cursor.rangeIndex >= 0 ? options.cursor.rangeIndex : 0
  const startBlockIdx = Number.isSafeInteger(options.cursor?.blockIndex) && options.cursor.blockIndex >= 0 ? options.cursor.blockIndex : null
  const probeRemote = options.probeRemote !== false

  return {
    core,
    resolvedKey,
    keyHex,
    coreStorage,
    store: options.store || null,
    ranges: options.ranges || null,
    signal: options.signal || null,
    resolveStore: options.resolveStore || null,
    boundedMaxBlocks,
    startRangeIdx,
    startBlockIdx,
    probeRemote,
  }
}

async function resolveRemoteAssessmentStore (store, resolveStore, storage, core, resolvedKey, keyHex) {
  if (store) return store
  const resolver = resolveStore || storage?.resolveStore
  if (typeof resolver === 'function' && resolvedKey) {
    return await resolver({ key: resolvedKey, keyHex, discoveryKey: core?.discoveryKey })
  }
  return null
}

async function resolveAssessmentTargetRanges (ranges, core, coreStorage) {
  if (Array.isArray(ranges) && ranges.length > 0) {
    return ranges.map(r => ({
      start: Math.max(0, Math.floor(Number(r.start)) || 0),
      end: Math.max(0, Math.floor(Number(r.end)) || 0)
    })).filter(r => r.end > r.start)
  }
  let length = Number(core?.length)
  if (!Number.isSafeInteger(length) || length <= 0) {
    const head = await readOnce(coreStorage, rx => rx.getHead())
    length = head && Number.isSafeInteger(Number(head.length)) ? Number(head.length) : 0
  }
  if (length > 0) {
    return [{ start: 0, end: length }]
  }
  return []
}

async function checkBlockBitfield (core, index) {
  try {
    if (typeof core?.has === 'function') {
      return await core.has(index) === true
    }
    if (core?.bitfield && typeof core.bitfield.get === 'function') {
      return core.bitfield.get(index) === true
    }
  } catch {
    return false
  }
  return false
}

async function readBlockExpectedHash (coreStorage, index) {
  try {
    const node = await readOnce(coreStorage, rx => rx.getTreeNode(2 * index))
    if (node && isKey(node.hash)) return node.hash
  } catch {
    return null
  }
  return null
}

async function readBlockLocalData (rawStorage, index) {
  try {
    return await readOnce(rawStorage, rx => rx.getBlock(index))
  } catch {
    return null
  }
}

async function probeRemoteBlock (remoteStore, index, expectedHash) {
  try {
    const verification = typeof remoteStore.verify === 'function'
      ? await remoteStore.verify(index, { expectedHash })
      : await (async () => {
          const data = await remoteStore.get(index, { expectedHash })
          return data ? { verified: true, byteLength: data.byteLength } : { verified: false, reason: 'missing' }
        })()

    if (verification.verified === true) {
      return { kind: 'remote', byteLength: verification.byteLength || 0 }
    }
    if (verification.reason === 'corrupt') return { kind: 'unavailable', corrupt: true }
    if (verification.reason === 'unreachable') return { kind: 'unavailable', unreachable: true }
    return { kind: 'unavailable', missing: true }
  } catch (error) {
    if (error?.code === 'REMOTE_BLOCK_CORRUPT') return { kind: 'unavailable', corrupt: true }
    return { kind: 'unavailable', unreachable: true }
  }
}

async function assessSingleBlock (coreStorage, rawStorage, remoteStore, index, probeRemote) {
  const expectedHash = await readBlockExpectedHash(coreStorage, index)
  const localData = await readBlockLocalData(rawStorage, index)

  if (localData !== null && localData !== undefined && localData.byteLength > 0) {
    if (expectedHash !== null && b4a.equals(crypto.data(localData), expectedHash)) {
      return { kind: 'resident', byteLength: localData.byteLength }
    }
    return { kind: 'unavailable', corrupt: true }
  }
  if (!expectedHash) {
    return { kind: 'unavailable', missing: true }
  }
  if (!probeRemote || !remoteStore) {
    return { kind: 'unavailable', unreachable: true }
  }
  return await probeRemoteBlock(remoteStore, index, expectedHash)
}

function recordBlockAssessment (result, stats, rangeStats, noteKind, index) {
  if (result.kind === 'resident') {
    stats.residentBlocks++
    rangeStats.rangeResident++
    stats.residentBytes += result.byteLength
    noteKind('resident', index)
    return
  }
  if (result.kind === 'remote') {
    stats.remoteRetrievableBlocks++
    rangeStats.rangeRetrievable++
    stats.remoteRetrievableBytes += result.byteLength
    noteKind('remote', index)
    return
  }
  stats.unretrievableBlocks++
  rangeStats.rangeUnretrievable++
  if (result.corrupt) stats.corruptBlocks++
  else if (result.unreachable) stats.unreachableBlocks++
  else stats.missingBlocks++
  noteKind('unavailable', index)
}

function createRunTracker (residentRanges, remoteRetrievableRanges, unavailableRanges, fromIndex) {
  let runKind = null
  let runStart = fromIndex

  const finishRun = (end) => {
    if (runKind == null || end <= runStart) return
    if (runKind === 'resident') pushExactRange(residentRanges, runStart, end)
    else if (runKind === 'remote') pushExactRange(remoteRetrievableRanges, runStart, end)
    else pushExactRange(unavailableRanges, runStart, end)
  }

  const noteKind = (kind, index) => {
    if (runKind !== kind) {
      finishRun(index)
      runStart = index
      runKind = kind
    }
  }

  return { finishRun, noteKind }
}

function computeRunEnd (aborted, truncated, nextCursor, rIdx, fromIndex, rangeAssessed, rangeEnd) {
  if (aborted || truncated) {
    if (nextCursor && nextCursor.rangeIndex === rIdx) {
      return nextCursor.blockIndex
    }
    return fromIndex + rangeAssessed
  }
  return rangeEnd
}

function computeRangeStatus (rangeResident, rangeRetrievable, rangeRequested, rangeAssessed) {
  if (rangeAssessed < rangeRequested) {
    return (rangeResident + rangeRetrievable) > 0 ? 'partial' : 'unretrievable'
  }
  if (rangeResident === rangeRequested && rangeRequested > 0) {
    return 'resident'
  }
  if ((rangeResident + rangeRetrievable) === rangeRequested && rangeRequested > 0) {
    return 'retrievable'
  }
  if ((rangeResident + rangeRetrievable) > 0) {
    return 'partial'
  }
  return 'unretrievable'
}

async function assessRangeBlocks ({
  range,
  fromIndex,
  rIdx,
  core,
  coreStorage,
  remoteStore,
  probeRemote,
  signal,
  boundedMaxBlocks,
  stats,
  noteKind,
}) {
  const rangeStats = {
    rangeResident: 0,
    rangeRetrievable: 0,
    rangeUnretrievable: 0,
    rangeBitfield: 0,
    rangeAssessed: 0,
  }
  let aborted = false
  let truncated = false
  let nextCursor = null

  for (let index = fromIndex; index < range.end; index++) {
    if (signal?.aborted) {
      aborted = true
      nextCursor = { rangeIndex: rIdx, blockIndex: index }
      break
    }
    if (stats.assessedBlocks >= boundedMaxBlocks) {
      truncated = true
      nextCursor = { rangeIndex: rIdx, blockIndex: index }
      break
    }
    stats.assessedBlocks++
    rangeStats.rangeAssessed++

    if (await checkBlockBitfield(core, index)) {
      stats.logicalBitfieldBlocks++
      rangeStats.rangeBitfield++
    }

    const blockResult = await assessSingleBlock(coreStorage, coreStorage, remoteStore, index, probeRemote)
    recordBlockAssessment(blockResult, stats, rangeStats, noteKind, index)
  }

  return {
    rangeStats,
    aborted,
    truncated,
    nextCursor,
  }
}

async function assessCoreRetrievability (options = {}) {
  const normalized = normalizeAssessmentOptions(options)
  const {
    core,
    resolvedKey,
    keyHex,
    coreStorage,
    ranges,
    signal,
    boundedMaxBlocks,
    startRangeIdx,
    startBlockIdx,
    probeRemote,
  } = normalized

  const remoteStore = await resolveRemoteAssessmentStore(
    normalized.store,
    normalized.resolveStore,
    options.storage,
    core,
    resolvedKey,
    keyHex
  )
  const assessedRanges = await resolveAssessmentTargetRanges(ranges, core, coreStorage)

  let requestedBlocks = 0
  for (const range of assessedRanges) {
    requestedBlocks += (range.end - range.start)
  }

  const stats = {
    assessedBlocks: 0,
    residentBlocks: 0,
    residentBytes: 0,
    remoteRetrievableBlocks: 0,
    remoteRetrievableBytes: 0,
    unretrievableBlocks: 0,
    missingBlocks: 0,
    corruptBlocks: 0,
    unreachableBlocks: 0,
    logicalBitfieldBlocks: 0,
  }

  const rangeSummaries = []
  const residentRanges = []
  const remoteRetrievableRanges = []
  const unavailableRanges = []
  let truncated = false
  let aborted = false
  let nextCursor = null

  for (let rIdx = startRangeIdx; rIdx < assessedRanges.length; rIdx++) {
    const range = assessedRanges[rIdx]
    if (signal?.aborted) {
      aborted = true
      break
    }
    const rangeRequested = range.end - range.start
    const fromIndex = (rIdx === startRangeIdx && startBlockIdx !== null)
      ? Math.max(range.start, Math.min(range.end, startBlockIdx))
      : range.start

    const { finishRun, noteKind } = createRunTracker(residentRanges, remoteRetrievableRanges, unavailableRanges, fromIndex)

    const blockAssessResult = await assessRangeBlocks({
      range,
      fromIndex,
      rIdx,
      core,
      coreStorage,
      remoteStore,
      probeRemote,
      signal,
      boundedMaxBlocks,
      stats,
      noteKind,
    })

    const { rangeStats } = blockAssessResult
    aborted = blockAssessResult.aborted
    truncated = blockAssessResult.truncated
    if (blockAssessResult.nextCursor) {
      nextCursor = blockAssessResult.nextCursor
    }

    const runEnd = computeRunEnd(aborted, truncated, nextCursor, rIdx, fromIndex, rangeStats.rangeAssessed, range.end)
    finishRun(runEnd)

    const status = computeRangeStatus(rangeStats.rangeResident, rangeStats.rangeRetrievable, rangeRequested, rangeStats.rangeAssessed)

    rangeSummaries.push({
      start: range.start,
      end: range.end,
      requestedBlocks: rangeRequested,
      assessedBlocks: rangeStats.rangeAssessed,
      residentBlocks: rangeStats.rangeResident,
      remoteRetrievableBlocks: rangeStats.rangeRetrievable,
      unretrievableBlocks: rangeStats.rangeUnretrievable,
      logicalBitfieldBlocks: rangeStats.rangeBitfield,
      truncated: rangeStats.rangeAssessed < rangeRequested,
      status,
    })

    if (truncated || aborted) break
  }

  return finalizeRetrievabilityStatus({
    success: true,
    coreKey: keyHex,
    requestedBlocks,
    assessedBlocks: stats.assessedBlocks,
    totalBlocks: stats.assessedBlocks,
    residentBlocks: stats.residentBlocks,
    residentBytes: stats.residentBytes,
    remoteRetrievableBlocks: stats.remoteRetrievableBlocks,
    remoteRetrievableBytes: stats.remoteRetrievableBytes,
    unretrievableBlocks: stats.unretrievableBlocks,
    missingBlocks: stats.missingBlocks,
    corruptBlocks: stats.corruptBlocks,
    unreachableBlocks: stats.unreachableBlocks,
    logicalBitfieldBlocks: stats.logicalBitfieldBlocks,
    ranges: rangeSummaries,
    residentRanges,
    remoteRetrievableRanges,
    unavailableRanges,
    truncated,
    aborted,
    nextCursor,
  })
}

export {
  assessCoreRetrievability,
  accumulateRetrievabilityPages,
  mergeExactRanges,
}
