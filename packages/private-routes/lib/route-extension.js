import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'
import { RELAY_CAPABILITY } from './protocol.js'

const REQUESTS = new WeakMap()
const TRANSFERS = new WeakMap()
const SPENT_REQUESTS = new WeakSet()
const SPENT_TRANSFERS = new WeakSet()
const SESSION_TRANSFER_HOOKS = new WeakMap()
const MAX_EXTENSION_MS = 5_000
const MAX_DISCOVERY_ENVELOPES = 5
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn
const DEFAULT_LIMITS = Object.freeze({
  maxCells: 64,
  maxBytes: 65_536,
  maxCommands: 10,
  idleTimeoutMs: 5_000
})
const LIMIT_KEYS = new Set(Object.keys(DEFAULT_LIMITS))
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const fillIntrinsic = Uint8Array.prototype.fill

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function authentication() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
}

function replay() {
  throw PrivateRouteError.ERR_REPLAY()
}

function safeObject(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

function opaqueCapability() {
  return Object.freeze({})
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

function nowValue(now) {
  let value
  try {
    value = now()
  } catch {
    invalid()
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) invalid()
    value = BigInt(value)
  }
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT64) invalid()
  return value
}

function random32(randomBytes) {
  let value = null
  try {
    value = randomBytes(32)
    if (length(value) !== 32) invalid()
    return value
  } catch (err) {
    clear(value)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

export function createRouteExtensionLimits(limits, now, deadline) {
  if (!safeObject(limits) || !Object.isFrozen(limits)) invalid()
  if (typeof deadline !== 'bigint' || deadline < 1n || deadline > MAX_UINT64) invalid()
  let keys
  try {
    keys = Reflect.ownKeys(limits)
  } catch {
    invalid()
  }
  const selected = { ...DEFAULT_LIMITS }
  for (const key of keys) {
    if (typeof key !== 'string' || !LIMIT_KEYS.has(key)) invalid()
    let value
    try {
      value = limits[key]
    } catch {
      invalid()
    }
    if (!Number.isInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) invalid()
    selected[key] = value
  }
  const current = nowValue(now)
  if (current > MAX_UINT64 - BigInt(MAX_EXTENSION_MS)) invalid()
  const expiresAtMs = current + BigInt(MAX_EXTENSION_MS)
  if (deadline <= current) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
  return Object.freeze({
    cellSize: 1200,
    maxCells: selected.maxCells,
    maxBytes: selected.maxBytes,
    maxCommands: selected.maxCommands,
    idleTimeoutMs: selected.idleTimeoutMs,
    expiresAtMs: expiresAtMs < deadline ? expiresAtMs : deadline
  })
}

function validTailControl(value) {
  return (
    safeObject(value) &&
    typeof value.sealDiscoverRequest === 'function' &&
    typeof value.openDiscoverResponse === 'function' &&
    typeof value.sealExtend === 'function' &&
    typeof value.openExtended === 'function' &&
    typeof value.completeClientExtension === 'function' &&
    typeof value.abortClientExtension === 'function' &&
    typeof value.destroy === 'function'
  )
}

function validTransport(value) {
  return (
    safeObject(value) &&
    typeof value.send === 'function' &&
    typeof value.receive === 'function' &&
    typeof value.destroy === 'function'
  )
}

function normalizeRequest(options) {
  if (!safeObject(options)) invalid()
  const expected = [
    'candidateDirectory',
    'cancel',
    'deadline',
    'extensionIndex',
    'limits',
    'now',
    'randomBytes',
    'routedDiscoveryService',
    'schedule',
    'tailControl',
    'tailControlTransportFactory'
  ]
  let keys
  try {
    keys = Reflect.ownKeys(options)
  } catch {
    invalid()
  }
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    invalid()
  }
  let values
  try {
    values = {
      candidateDirectory: options.candidateDirectory,
      cancel: options.cancel,
      deadline: options.deadline,
      extensionIndex: options.extensionIndex,
      limits: options.limits,
      now: options.now,
      randomBytes: options.randomBytes,
      routedDiscoveryService: options.routedDiscoveryService,
      schedule: options.schedule,
      tailControl: options.tailControl,
      tailControlTransportFactory: options.tailControlTransportFactory
    }
  } catch {
    invalid()
  }
  if (
    !safeObject(values.candidateDirectory) ||
    typeof values.candidateDirectory.admit !== 'function' ||
    typeof values.cancel !== 'function' ||
    typeof values.deadline !== 'bigint' ||
    values.deadline < 1n ||
    values.deadline > MAX_UINT64 ||
    (values.extensionIndex !== 1 && values.extensionIndex !== 2) ||
    !safeObject(values.limits) ||
    !Object.isFrozen(values.limits) ||
    typeof values.now !== 'function' ||
    typeof values.randomBytes !== 'function' ||
    !safeObject(values.routedDiscoveryService) ||
    typeof values.routedDiscoveryService.request !== 'function' ||
    typeof values.schedule !== 'function' ||
    !validTailControl(values.tailControl) ||
    typeof values.tailControlTransportFactory !== 'function'
  ) {
    invalid()
  }
  return values
}

export function createRouteExtensionSessionRequest(options) {
  const request = opaqueCapability()
  REQUESTS.set(request, normalizeRequest(options))
  return request
}

function takeRequest(request) {
  const material = safeObject(request) ? REQUESTS.get(request) : null
  if (!material) {
    if (safeObject(request) && SPENT_REQUESTS.has(request)) replay()
    authentication()
  }
  REQUESTS.delete(request)
  SPENT_REQUESTS.add(request)
  return material
}

function makeTransfer(session, tailControl, transport) {
  const transfer = opaqueCapability()
  TRANSFERS.set(transfer, { session, tailControl, transport })
  return transfer
}

export function takeRouteExtensionTransfer(transfer) {
  const material = safeObject(transfer) ? TRANSFERS.get(transfer) : null
  if (!material) {
    if (safeObject(transfer) && SPENT_TRANSFERS.has(transfer)) replay()
    authentication()
  }
  const take = SESSION_TRANSFER_HOOKS.get(material.session)
  if (typeof take !== 'function') replay()
  take(transfer)
  TRANSFERS.delete(transfer)
  SPENT_TRANSFERS.add(transfer)
  return Object.freeze({ tailControl: material.tailControl, transport: material.transport })
}

export class RouteExtensionSession {
  #material
  #state
  #opening
  #lifecycle
  #transport
  #completion
  #transfer
  #timer
  #timeoutReject

  constructor(request) {
    this.#material = takeRequest(request)
    this.#state = 'REQUESTED'
    this.#opening = false
    this.#lifecycle = Object.freeze({})
    this.#transport = null
    this.#completion = null
    this.#transfer = null
    this.#timer = null
    this.#timeoutReject = null
    SESSION_TRANSFER_HOOKS.set(this, (transfer) => this.#transferTaken(transfer))
    Object.freeze(this)
  }

  async open(...args) {
    if (args.length !== 0) invalid()
    if (this.#state === 'DESTROYED') throw PrivateRouteError.ERR_DESTROYED()
    if (this.#opening || this.#state !== 'REQUESTED') replay()
    this.#opening = true
    const lifecycle = this.#lifecycle
    try {
      this.#armTimeout(lifecycle)
      const transportRequest = opaqueCapability()
      let transport
      try {
        transport = this.#material.tailControlTransportFactory(transportRequest)
      } catch {
        throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      }
      this.#assert(lifecycle)
      if (!validTransport(transport)) {
        try {
          if (safeObject(transport) && typeof transport.destroy === 'function') transport.destroy()
        } catch {}
        invalid()
      }
      this.#transport = transport

      const randomTarget = random32(this.#material.randomBytes)
      const queryNonce = random32(this.#material.randomBytes)
      let discover = null
      try {
        discover = this.#material.tailControl.sealDiscoverRequest({
          requestedCapabilityMask:
            this.#material.extensionIndex === 1
              ? RELAY_CAPABILITY.CIRCUIT_RELAY_V1
              : RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
          randomTarget,
          queryNonce,
          maximumResults: 1,
          randomBytes: this.#material.randomBytes
        })
        this.#assert(lifecycle)
        await this.#bounded(transport.send(discover), lifecycle)
        this.#assert(lifecycle)
      } finally {
        clear(randomTarget)
        clear(queryNonce)
        clear(discover)
      }

      const discoveryRequest = opaqueCapability()
      await this.#bounded(
        this.#material.routedDiscoveryService.request(discoveryRequest),
        lifecycle
      )
      this.#assert(lifecycle)

      let evidence = null
      for (let index = 0; index < MAX_DISCOVERY_ENVELOPES && evidence === null; index++) {
        const response = await this.#receive(lifecycle)
        try {
          evidence = this.#material.tailControl.openDiscoverResponse(response)
          this.#assert(lifecycle)
        } finally {
          clear(response)
        }
      }
      if (evidence === null) authentication()
      let candidates
      try {
        candidates = this.#material.candidateDirectory.admit(evidence)
      } catch (err) {
        if (err instanceof PrivateRouteError) throw err
        invalid()
      }
      this.#assert(lifecycle)
      if (!Array.isArray(candidates) || candidates.length !== 1) authentication()

      let extend = null
      try {
        extend = this.#material.tailControl.sealExtend(candidates[0], {
          requestedLimits: createRouteExtensionLimits(
            this.#material.limits,
            this.#material.now,
            this.#material.deadline
          ),
          randomBytes: this.#material.randomBytes
        })
        this.#assert(lifecycle)
        await this.#bounded(transport.send(extend), lifecycle)
        this.#assert(lifecycle)
      } finally {
        clear(extend)
      }

      const extended = await this.#receive(lifecycle)
      try {
        this.#completion = this.#material.tailControl.openExtended(extended)
        this.#assert(lifecycle)
      } finally {
        clear(extended)
      }
      this.#state = 'EXTENDED'

      const ready = await this.#receive(lifecycle)
      let nextTail = null
      try {
        nextTail = this.#material.tailControl.completeClientExtension(this.#completion, ready)
        this.#completion = null
        this.#assert(lifecycle)
      } finally {
        clear(ready)
      }
      if (!safeObject(nextTail) || typeof nextTail.destroy !== 'function') {
        try {
          if (safeObject(nextTail) && typeof nextTail.destroy === 'function') nextTail.destroy()
        } catch {}
        invalid()
      }
      this.#disarmTimeout()
      this.#state = 'ACTIVE'
      this.#transfer = makeTransfer(this, nextTail, transport)
      this.#transport = null
      return this.#transfer
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    } finally {
      this.#opening = false
    }
  }

  diagnostics() {
    return Object.freeze({ state: this.#state })
  }

  destroy() {
    if (this.#state === 'DESTROYED') return false
    this.#terminate()
    return true
  }

  #transferTaken(transfer) {
    if (this.#state !== 'ACTIVE' || transfer !== this.#transfer) replay()
    SESSION_TRANSFER_HOOKS.delete(this)
    this.#transfer = null
    this.#material = null
    this.#state = 'DESTROYED'
    this.#lifecycle = Object.freeze({})
  }

  async #receive(lifecycle) {
    let frame
    try {
      frame = await this.#bounded(this.#transport.receive(), lifecycle)
    } catch (err) {
      if (err instanceof PrivateRouteError) throw err
      throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    }
    this.#assert(lifecycle)
    if (length(frame) < 1) {
      clear(frame)
      invalid()
    }
    return frame
  }

  #bounded(operation, lifecycle) {
    let promise
    try {
      promise = Promise.resolve(operation)
    } catch {
      throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    }
    const timeout = new Promise((resolve, reject) => {
      this.#timeoutReject = reject
    })
    return Promise.race([promise, timeout]).then((value) => {
      this.#assert(lifecycle)
      return value
    })
  }

  #armTimeout(lifecycle) {
    let fired = false
    let timer = null
    const current = nowValue(this.#material.now)
    if (current >= this.#material.deadline) {
      throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    }
    const remaining = this.#material.deadline - current
    const delay = Number(
      remaining < BigInt(MAX_EXTENSION_MS) ? remaining : BigInt(MAX_EXTENSION_MS)
    )
    try {
      timer = this.#material.schedule(() => {
        fired = true
        if (this.#state === 'DESTROYED' || lifecycle !== this.#lifecycle) return
        this.#terminate(PrivateRouteError.ERR_PRIVACY_UNAVAILABLE())
      }, delay)
    } catch {
      throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    }
    if (fired || this.#state === 'DESTROYED' || lifecycle !== this.#lifecycle) {
      try {
        this.#material.cancel(timer)
      } catch {}
      throw PrivateRouteError.ERR_DESTROYED()
    }
    this.#timer = timer
  }

  #disarmTimeout() {
    const timer = this.#timer
    this.#timer = null
    this.#timeoutReject = null
    if (timer !== null) {
      try {
        this.#material.cancel(timer)
      } catch {}
    }
  }

  #assert(lifecycle) {
    if (this.#state === 'DESTROYED' || lifecycle !== this.#lifecycle) {
      throw PrivateRouteError.ERR_DESTROYED()
    }
  }

  #terminate(reason = PrivateRouteError.ERR_DESTROYED()) {
    if (this.#state === 'DESTROYED') return false
    const material = this.#material
    const reject = this.#timeoutReject
    this.#disarmTimeout()
    this.#state = 'DESTROYED'
    this.#lifecycle = Object.freeze({})
    SESSION_TRANSFER_HOOKS.delete(this)
    const completion = this.#completion
    this.#completion = null
    if (completion && material) {
      try {
        material.tailControl.abortClientExtension(completion)
      } catch {}
    }
    if (this.#transfer) {
      const transfer = this.#transfer
      const moved = TRANSFERS.get(transfer)
      TRANSFERS.delete(transfer)
      SPENT_TRANSFERS.add(transfer)
      this.#transfer = null
      if (moved) {
        try {
          moved.tailControl.destroy()
        } catch {}
        try {
          moved.transport.destroy()
        } catch {}
      }
    }
    if (material) {
      try {
        material.tailControl.destroy()
      } catch {}
    }
    const transport = this.#transport
    this.#transport = null
    if (transport) {
      try {
        transport.destroy()
      } catch {}
    }
    this.#material = null
    if (reject) reject(reason)
    return true
  }
}
