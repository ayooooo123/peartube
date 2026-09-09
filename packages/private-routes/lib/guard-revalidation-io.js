import b4a from 'b4a'

import { BootstrapIO, consumeBootstrapGuardReady } from './bootstrap-io.js'
import {
  failBranchConstruction,
  readPinnedBranchGuard,
  takeBranchConstructionRequest
} from './branch-construction-authority.js'
import { PrivateRouteError } from './errors.js'
import {
  decodeRelayCapabilityAdvertisement,
  digestRelayCapabilityAdvertisement
} from './relay-capability.js'
import { RELAY_CAPABILITY } from './protocol.js'

const REVALIDATION_TRANSFERS = new WeakSet()

const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const fillIntrinsic = Uint8Array.prototype.fill

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function fixed(value, size) {
  try {
    return b4a.isBuffer(value) && byteLengthGetter.call(value) === size
  } catch {
    return false
  }
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? byteLengthGetter.call(value) : -1
  } catch {
    return -1
  }
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {}
}

function same(left, right) {
  try {
    return fixed(left, byteLengthGetter.call(right)) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function ownedRandom(randomBytes) {
  let value = null
  try {
    value = randomBytes(32)
    if (!fixed(value, 32)) invalid()
    return b4a.from(value)
  } finally {
    clear(value)
  }
}

function clearPinned(value) {
  if (!value) return
  clear(value.relayIdentity)
  clear(value.reachableEndpoint)
  clear(value.advertisementDigest)
}

function clearEntry(value) {
  if (!value) return
  clear(value.advertisement)
  clear(value.relayIdentity)
  clear(value.currentDhtNodeId)
}

export function consumeGuardRevalidationReady(capability) {
  if (
    capability === null ||
    typeof capability !== 'object' ||
    !REVALIDATION_TRANSFERS.has(capability)
  ) {
    throw PrivateRouteError.ERR_REPLAY()
  }
  REVALIDATION_TRANSFERS.delete(capability)
  return true
}

export class GuardRevalidationIO {
  #io
  #session
  #pinned
  #directory
  #now
  #randomBytes
  #opened
  #destroyed
  #lifecycle

  constructor({
    constructionRequest,
    socketFactory,
    directory,
    guardHandshakeFactory,
    now,
    randomBytes,
    setTimeout,
    clearTimeout
  } = {}) {
    if (
      typeof socketFactory !== 'function' ||
      directory === null ||
      typeof directory !== 'object' ||
      typeof directory.admit !== 'function' ||
      typeof directory.validate !== 'function' ||
      typeof directory.isValidated !== 'function' ||
      typeof directory.read !== 'function' ||
      typeof now !== 'function' ||
      typeof randomBytes !== 'function' ||
      guardHandshakeFactory === null ||
      typeof guardHandshakeFactory !== 'object' ||
      typeof guardHandshakeFactory.openGuard !== 'function'
    ) {
      invalid()
    }
    let session = null
    let pinned = null
    try {
      session = takeBranchConstructionRequest(constructionRequest)
      pinned = readPinnedBranchGuard(session)
      this.#io = new BootstrapIO({
        socketFactory,
        candidateChecker: directory,
        configuredBootstraps: [pinned.reachableEndpoint],
        guardHandshakeFactory,
        now,
        randomBytes,
        setTimeout,
        clearTimeout,
        constructionSession: session
      })
      this.#session = session
      this.#pinned = pinned
      this.#directory = directory
      this.#now = now
      this.#randomBytes = randomBytes
      this.#opened = false
      this.#destroyed = false
      this.#lifecycle = Object.freeze({})
      pinned = null
      session = null
    } finally {
      clearPinned(pinned)
      if (session) {
        try {
          failBranchConstruction(session)
        } catch {}
      }
    }
  }

  async open(...args) {
    if (args.length !== 0) invalid()
    if (this.#destroyed) throw PrivateRouteError.ERR_DESTROYED()
    if (this.#opened) throw PrivateRouteError.ERR_REPLAY()
    this.#opened = true
    const lifecycle = this.#lifecycle
    const session = this.#session
    let randomTarget = null
    let queryNonce = null
    let response = null
    let entry = null
    let decoded = null
    let digest = null
    let projection = null
    try {
      await this.#io.ready()
      this.#assertLifecycle(lifecycle)
      randomTarget = ownedRandom(this.#randomBytes)
      this.#assertLifecycle(lifecycle)
      queryNonce = ownedRandom(this.#randomBytes)
      this.#assertLifecycle(lifecycle)
      response = await this.#io.capsQuery(
        this.#pinned.reachableEndpoint,
        Object.freeze({
          requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
          randomTarget,
          queryNonce,
          maximumResults: 1
        })
      )
      this.#assertLifecycle(lifecycle)
      if (
        response === null ||
        typeof response !== 'object' ||
        response.fragmented !== false ||
        !Array.isArray(response.advertisements) ||
        response.advertisements.length !== 1
      ) {
        invalid()
      }
      entry = response.advertisements[0]
      const advertisementBytes = length(entry.advertisement)
      if (!entry.self || advertisementBytes < 260 || advertisementBytes > 548) invalid()
      const current = this.#now()
      this.#assertLifecycle(lifecycle)
      decoded = decodeRelayCapabilityAdvertisement(entry.advertisement, { now: current })
      digest = digestRelayCapabilityAdvertisement(entry.advertisement, { now: current })
      if (
        !same(decoded.relayIdentity, this.#pinned.relayIdentity) ||
        !same(decoded.reachableEndpoint, this.#pinned.reachableEndpoint) ||
        decoded.epoch < this.#pinned.epoch ||
        (decoded.epoch === this.#pinned.epoch && !same(digest, this.#pinned.advertisementDigest))
      ) {
        throw PrivateRouteError.ERR_AUTHENTICATION()
      }
      const admitted = this.#io.admitCandidate(entry.provenance, this.#directory)
      this.#assertLifecycle(lifecycle)
      const validated = await this.#directory.validate(admitted, (challenge) =>
        this.#io.activeChallenge(admitted, challenge)
      )
      this.#assertLifecycle(lifecycle)
      if (!this.#directory.isValidated(validated)) {
        throw PrivateRouteError.ERR_AUTHENTICATION()
      }
      this.#assertLifecycle(lifecycle)
      projection = this.#directory.read(validated)
      this.#assertLifecycle(lifecycle)
      if (
        !same(projection.relayIdentity, this.#pinned.relayIdentity) ||
        !same(projection.reachableEndpoint, this.#pinned.reachableEndpoint) ||
        projection.epoch !== decoded.epoch
      ) {
        throw PrivateRouteError.ERR_AUTHENTICATION()
      }
      const ready = await this.#io.pinGuard(validated)
      this.#assertLifecycle(lifecycle)
      consumeBootstrapGuardReady(ready)
      this.#assertLifecycle(lifecycle)
      const transfer = Object.freeze({})
      REVALIDATION_TRANSFERS.add(transfer)
      try {
        this.#assertLifecycle(lifecycle)
      } catch (err) {
        REVALIDATION_TRANSFERS.delete(transfer)
        throw err
      }
      this.#destroyed = true
      this.#lifecycle = Object.freeze({})
      this.#io = null
      clearPinned(this.#pinned)
      this.#pinned = null
      this.#directory = null
      this.#randomBytes = null
      this.#now = null
      this.#session = null
      return transfer
    } catch (err) {
      this.destroy()
      try {
        failBranchConstruction(session)
      } catch {}
      if (err instanceof PrivateRouteError) throw err
      throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    } finally {
      clear(randomTarget)
      clear(queryNonce)
      clearEntry(entry)
      if (decoded) {
        for (const value of Object.values(decoded)) clear(value)
      }
      clear(digest)
      if (projection) {
        for (const value of Object.values(projection)) clear(value)
      }
    }
  }

  diagnostics() {
    return Object.freeze({
      state: this.#destroyed ? 'DESTROYED' : this.#opened ? 'OPENING' : 'NEW'
    })
  }

  destroy() {
    if (this.#destroyed) return false
    this.#destroyed = true
    this.#lifecycle = Object.freeze({})
    const io = this.#io
    this.#io = null
    try {
      if (io) io.destroy()
    } finally {
      clearPinned(this.#pinned)
      this.#pinned = null
      this.#directory = null
      this.#randomBytes = null
      this.#now = null
      this.#session = null
    }
    return true
  }

  #assertLifecycle(lifecycle) {
    if (this.#destroyed || lifecycle !== this.#lifecycle) {
      throw PrivateRouteError.ERR_DESTROYED()
    }
  }
}
