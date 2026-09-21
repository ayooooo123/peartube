/**
 * Pear OTA updater lifecycle, mobile worklet side.
 *
 * `pear-mobile` runs the updater inside the Bare worklet because that is the
 * process holding the Corestore and the swarm. This module is the only place in
 * the app that knows `pear-mobile` exists: it owns construction, event
 * forwarding and teardown, and hands the backend a three-method handle.
 *
 * Nothing here auto-applies a payload. `updated` is reported and the view
 * decides when to swap, because applying only writes the payload to disk — the
 * running code stays the old build until the app restarts.
 */
import PearRuntime from 'pear-mobile'
import { attachUpdateDriveReplication } from './pear-update-replication.mjs'

/**
 * `pear-runtime-updater` samples ONE delay at construction — `random(0, delay)`
 * — and reuses it for every change it later detects. Its own default is an
 * hour, which exists so a freshly staged release does not put every device on
 * the seeders in the same second. An hour of silence after "update available"
 * is useless to a person holding the phone, so PearTube keeps the
 * thundering-herd spread and shortens the window to five minutes.
 */
const PEAR_UPDATE_MIRROR_DELAY_MS = 300_000

function resolveMirrorDelay(delay, debug) {
  if (Number.isInteger(delay) && delay >= 0) return delay
  // Debug runs want the payload now, not somewhere inside a random window.
  return debug ? 0 : PEAR_UPDATE_MIRROR_DELAY_MS
}

function noopLog() {}

function describeError(error) {
  if (error instanceof Error) return error.message || String(error)
  if (typeof error === 'string') return error
  return String(error)
}

function updateInfo(productName, version, upgrade, enabled) {
  return {
    productName: typeof productName === 'string' ? productName : '',
    version: typeof version === 'string' ? version : '',
    upgrade: typeof upgrade === 'string' && upgrade.length > 0 ? upgrade : null,
    enabled,
  }
}

/**
 * The updater is dead but the backend keeps serving video. Every entry point
 * stays callable so the view never has to special-case a missing namespace.
 */
function inertUpdates({ productName, version, upgrade, reason, log }) {
  log(`[pear-updates] disabled: ${reason}`)
  console.log('[PearUpdates] disabled:', reason)

  return {
    async applyUpdate() {
      throw new Error(`Pear updates are unavailable: ${reason}`)
    },
    async info() {
      return updateInfo(productName, version, upgrade, false)
    },
    async close() {},
  }
}

/**
 * Upstream treats store and swarm as one option: passing only one throws, and
 * a store without a swarm would silently never replicate. Sharing PearTube's
 * pair keeps a phone on a single swarm instead of opening a second one.
 */
function canShareRuntimeResources(store, swarm, log) {
  const shared = Boolean(store) && Boolean(swarm) && store.closed !== true && swarm.destroyed !== true
  if (!shared && (Boolean(store) || Boolean(swarm))) {
    log('[pear-updates] shared corestore/swarm unusable, updater will open its own')
  }
  return shared
}

/**
 * The pear link is parsed inside the updater constructor, so a missing or
 * malformed `upgrade` throws here — even with `updates: false`, and even
 * before anything is opened. The caller degrades to an inert updater rather
 * than taking the backend down with it.
 *
 * The updater builds `new Hyperdrive(store, key)`, and closing a Hyperdrive
 * closes the exact Corestore it was handed. Handing it a session keeps
 * `updater.close()` from tearing down PearTube's root store; the session
 * shares the root's core tracker, so replicating on the root still serves the
 * upgrade drive.
 */
function constructRuntime({ shared, store, swarm, storage, version, upgrade, productName, updates, delay }) {
  const pearStore = shared ? store.namespace('pear-runtime') : null
  try {
    return {
      pearStore,
      pear: new PearRuntime({
        version,
        upgrade,
        name: productName,
        updates: updates !== false,
        // Never inherited: the default is an hour sampled at construction.
        delay,
        // `dir` and `app` are deliberately left at the pear-mobile defaults —
        // they are the paths the pear-runtime-react-native boot patch reads
        // (`<app dir>/pear-runtime/ota`). Overriding them hides the payload
        // from the native bundle selection.
        ...(shared ? { store: pearStore, swarm } : {}),
        ...(storage ? { storage } : {}),
      }),
      error: null,
    }
  } catch (error) {
    return { pearStore, pear: null, error }
  }
}

async function closeQuietly(resource) {
  if (!resource) return
  try { await resource.close() } catch { /* never opened, or already gone */ }
}

/**
 * @param {object} options
 * @param {string} options.version current build version (package.json `version`)
 * @param {string} options.upgrade pear link the payload is staged on
 * @param {string} options.productName package.json `productName`
 * @param {object} [options.store] PearTube's Corestore; must be paired with `swarm`
 * @param {object} [options.swarm] PearTube's Hyperswarm; must be paired with `store`
 * @param {string} [options.storage] suggested app storage path, surfaced as `pear.storage`
 * @param {boolean} [options.updates] false opts the build out of OTA entirely
 * @param {number} [options.delay] explicit mirror-delay upper bound in ms
 * @param {boolean} [options.debug] dev/debug signal: collapses the delay to 0
 * @param {(event: { state: string, version: string | null, minver: string | null }) => void} [options.sendEvent]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{ applyUpdate(): Promise<void>, info(): Promise<object>, close(): Promise<void> }>}
 */
export async function startPearUpdates({
  version,
  upgrade,
  productName,
  store = null,
  swarm = null,
  storage = null,
  updates = true,
  delay = null,
  debug = false,
  sendEvent = () => {},
  log = noopLog,
} = {}) {
  const emit = (state, payload) => {
    try {
      sendEvent({
        state,
        version: typeof payload?.version === 'string' ? payload.version : null,
        minver: typeof payload?.minver === 'string' ? payload.minver : null,
      })
    } catch (error) {
      log(`[pear-updates] event dispatch failed: ${describeError(error)}`)
    }
  }

  const shared = canShareRuntimeResources(store, swarm, log)
  const { pear, pearStore, error: constructionError } = constructRuntime({
    shared,
    store,
    swarm,
    storage,
    version,
    upgrade,
    productName,
    updates,
    delay: resolveMirrorDelay(delay, debug),
  })

  if (constructionError) {
    await closeQuietly(pearStore)
    return inertUpdates({ productName, version, upgrade, reason: describeError(constructionError), log })
  }

  // EventEmitter throws when 'error' is emitted with no listener, and both the
  // runtime and the updater route background mirror failures there.
  pear.on('error', (error) => log(`[pear-updates] runtime error: ${describeError(error)}`))
  pear.updater.on('error', (error) => log(`[pear-updates] updater error: ${describeError(error)}`))

  // pear-mobile registers `updater.on('updated', () => this._writeManifest())`
  // in its constructor and drops the returned promise, so a failed payload
  // manifest copy would surface as an unhandled rejection in the worklet — and
  // this backend reports unhandled rejections as a fatal host error. The
  // listener resolves the method at call time, so containing it on the instance
  // is enough.
  const writeManifest = typeof pear._writeManifest === 'function' ? pear._writeManifest.bind(pear) : null
  if (writeManifest) {
    pear._writeManifest = () => writeManifest().catch((error) => {
      log(`[pear-updates] payload manifest copy failed: ${describeError(error)}`)
    })
  }

  pear.updater.on('updating', () => emit('updating', { version: pear.updater.nextVersion }))
  pear.updater.on('updated', () => emit('updated', { version: pear.updater.nextVersion }))
  // `minver-required` is emitted by pear-mobile itself, not the updater, and
  // shows nothing by default: surfacing the store install is the app's job.
  pear.on('minver-required', (data) => emit('minver-required', data))

  let detachReplication = null
  let discovery = null

  try {
    await pear.ready()
  } catch (error) {
    detachReplication?.()
    await closeQuietly(pear.updater)
    await closeQuietly(pearStore)
    return inertUpdates({ productName, version, upgrade, reason: describeError(error), log })
  }

  if (shared) {
    const attached = attachUpdateDriveReplication({
      swarm,
      drive: pear.updater.drive,
      onError: (error, stage) => log(`[pear-updates] upgrade drive ${stage} failed: ${describeError(error)}`),
    })
    detachReplication = attached.detach
    discovery = attached.discovery
  }

  log(`[pear-updates] ready version=${version} shared-swarm=${shared}`)

  let closed = false

  return {
    async applyUpdate() {
      if (closed) throw new Error('Pear updates are unavailable: updater closed')
      const updater = pear.updater
      if (!updater.updates) throw new Error('Pear updates are disabled in this build')
      if (!updater.updated) throw new Error('No downloaded Pear update to apply')
      // Resolves once the payload is swapped into place on disk. The running
      // code is still the old build; the caller has to restart.
      await updater.applyUpdate()
    },

    async info() {
      return updateInfo(productName, version, upgrade, pear.updater.updates === true)
    },

    async close() {
      if (closed) return
      closed = true
      detachReplication?.()
      detachReplication = null
      if (discovery) {
        try { await discovery.destroy() } catch { /* swarm already tearing down */ }
        discovery = null
      }

      if (shared) {
        // pear-mobile's own close() destroys the swarm and closes the store it
        // was *given* (`if (this.opts.swarm) await this.swarm.destroy()`), which
        // here are PearTube's. Close the updater — the thing actually holding
        // the drive — and leave the shared resources to the backend lifecycle
        // that owns them. Closing the drive already closes the session created
        // above; the explicit close only covers a drive that never opened.
        await closeQuietly(pear.updater)
        await closeQuietly(pearStore)
        return
      }

      await closeQuietly(pear)
    },
  }
}
