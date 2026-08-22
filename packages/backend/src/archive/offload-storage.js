import b4a from 'b4a'

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
 */
export function createOffloadStorage ({ storage, resolveStore, log } = {}) {
  if (!storage || typeof storage !== 'object' || typeof storage.setDefaultDiscoveryKey !== 'function') {
    throw new TypeError('storage must be a hypercore-storage instance')
  }
  if (typeof resolveStore !== 'function') {
    throw new TypeError('resolveStore is required')
  }

  const counters = { restored: 0, missing: 0, failed: 0, corrupt: 0 }
  const report = typeof log === 'function' ? log : null

  function emit (message) {
    if (report === null) return
    try {
      report(`[offload-storage] ${message}`)
    } catch {
      // A logger must never take down a block read.
    }
  }

  function stats () {
    return { ...counters }
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

  async function restore (context, index) {
    let identity = null
    let store = null
    try {
      identity = await identityOf(context)
      store = await resolveStore(identity)
    } catch (error) {
      counters.failed++
      emit(`no remote store for block ${index}: ${errorText(error)}`)
      return null
    }
    // Not an offloaded core: a local miss is just a local miss.
    if (!store) return null

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

  // ---------------------------------------------------------------------------
  // interception
  // ---------------------------------------------------------------------------

  function wrapRead (rx, context) {
    return delegate(rx, {
      getBlock (index) {
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
  }

  for (const name of CORE_PRODUCERS) {
    if (typeof storage[name] !== 'function') continue
    overrides[name] = async (...args) => {
      const coreStorage = await storage[name](...args)
      if (!coreStorage) return coreStorage
      return wrapCoreStorage(coreStorage, seedIdentity(name, args))
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
  }
}
