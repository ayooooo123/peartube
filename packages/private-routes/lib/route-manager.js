import b4a from 'b4a'

import {
  failCompiledRouteDuplex,
  isCompiledRouteDuplex,
  isCompiledRouteDuplexFor,
  replaceCompiledRouteDuplex
} from './compiled-route-duplex.js'
import {
  activationChallengeCipher,
  createDestinationProof,
  createDestinationReplayCache,
  createEntryProof,
  createEntryReplayCache,
  encodeCreate,
  hashCreateBase,
  verifyDestinationProof,
  verifyEntryProof
} from './activation.js'
import {
  consumeBranchConstructionPair,
  createBranchConstructionAuthority,
  revokeBranchPathPairBinding
} from './branch-construction-authority.js'
import { consumeBootstrapGuardReady, consumeConstructedGuardBranch } from './bootstrap-io.js'
import { CELL_SIZE, CellCodec } from './cell-codec.js'
import {
  isRouteCompilerChecker,
  isRouteCandidateChecker,
  isSafetyInstallerChecker,
  isSafetyRouteChecker
} from './circuit-authority.js'
import { cryptoSuite } from './crypto-suite.js'
import {
  decodeRelayAdvertisement,
  encodeUnsignedRelayAdvertisement,
  isVerifiedDescriptor,
  readVerifiedDescriptor
} from './descriptor.js'
import { PrivateRouteError } from './errors.js'
import { consumeGuardRevalidationReady } from './guard-revalidation-io.js'
import { createLinkSetupAuthority } from './link-setup.js'
import { isM3AdjacencyAuthority } from './m3-adjacency-runtime.js'
import { PRIVACY_OPERATION } from './privacy-domains.js'
import { BRANCH_CLASS, CELL_CLASS, DIRECTION, DOMAIN, ROLE, roleForIdentity } from './protocol.js'
import { RelayService, TEST_ONLY_RELAY_OBSERVER } from './relay-service.js'
import {
  ROUTE_ENDPOINT,
  RoutePayloadCodec,
  mintCreatedRoutePayloadContext
} from './route-payload.js'
import { VirtualNetwork } from './virtual-network.js'

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const bufferByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const bufferFill = Uint8Array.prototype.fill

export const TEST_ONLY_DYNAMIC_OBSERVER = Symbol('test-only-dynamic-observer')

const DYNAMIC_OPTION_KEYS = new Set([
  'adjacencyAuthority',
  'bootstrapIOFactory',
  'cancel',
  'crypto',
  'guardRevalidationIOFactory',
  'limits',
  'now',
  'randomBytes',
  'routedDiscoveryService',
  'schedule',
  'tailControlTransportFactory'
])

const DYNAMIC_BRANCH_STATES = new WeakMap()

function destroyConstructedBranch(branch) {
  if (!branch) return
  try {
    branch.tailControl.destroy()
  } finally {
    branch.runtime.destroy()
  }
}

function dynamicBranches(lookup, announce) {
  const branches = Object.freeze({
    destroy() {
      const state = DYNAMIC_BRANCH_STATES.get(branches)
      if (!state) return false
      DYNAMIC_BRANCH_STATES.delete(branches)
      try {
        destroyConstructedBranch(state.lookup)
      } finally {
        destroyConstructedBranch(state.announce)
      }
      return true
    }
  })
  DYNAMIC_BRANCH_STATES.set(branches, { lookup, announce })
  return branches
}

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}
function unauthorized() {
  throw PrivateRouteError.UNAUTHORIZED()
}
function safeObject(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}
function length(value) {
  try {
    return b4a.isBuffer(value) ? bufferByteLength.call(value) : -1
  } catch {
    return -1
  }
}
function same(a, b) {
  if (length(a) < 0 || length(a) !== length(b)) return false
  try {
    return b4a.equals(a, b)
  } catch {
    return false
  }
}
function clear(value) {
  try {
    if (b4a.isBuffer(value)) bufferFill.call(value, 0)
  } catch {
    // Best-effort zeroization only.
  }
}
function dynamicOptions(options) {
  if (!safeObject(options)) invalid()
  let keys
  try {
    keys = Reflect.ownKeys(options)
  } catch {
    invalid()
  }
  for (const key of keys) {
    if (key === TEST_ONLY_DYNAMIC_OBSERVER) continue
    if (typeof key !== 'string' || !DYNAMIC_OPTION_KEYS.has(key)) invalid()
  }
  let values
  try {
    values = {
      adjacencyAuthority: options.adjacencyAuthority,
      bootstrapIOFactory: options.bootstrapIOFactory,
      cancel: options.cancel,
      crypto: options.crypto,
      guardRevalidationIOFactory: options.guardRevalidationIOFactory,
      limits: options.limits,
      now: options.now,
      observe: options[TEST_ONLY_DYNAMIC_OBSERVER],
      randomBytes: options.randomBytes,
      routedDiscoveryService: options.routedDiscoveryService,
      schedule: options.schedule,
      tailControlTransportFactory: options.tailControlTransportFactory
    }
  } catch {
    invalid()
  }
  if (
    !isM3AdjacencyAuthority(values.adjacencyAuthority) ||
    typeof values.bootstrapIOFactory !== 'function' ||
    typeof values.cancel !== 'function' ||
    !safeObject(values.crypto) ||
    typeof values.crypto.hash !== 'function' ||
    typeof values.crypto.keyPair !== 'function' ||
    typeof values.crypto.encryptionKeyPair !== 'function' ||
    typeof values.guardRevalidationIOFactory !== 'function' ||
    !safeObject(values.limits) ||
    !Object.isFrozen(values.limits) ||
    typeof values.now !== 'function' ||
    (values.observe !== undefined && typeof values.observe !== 'function') ||
    typeof values.randomBytes !== 'function' ||
    !safeObject(values.routedDiscoveryService) ||
    typeof values.routedDiscoveryService.request !== 'function' ||
    typeof values.schedule !== 'function' ||
    typeof values.tailControlTransportFactory !== 'function'
  ) {
    invalid()
  }
  return values
}
function ownedRandom(randomBytes, size) {
  let value
  try {
    value = randomBytes(size)
  } catch {
    invalid()
  }
  if (length(value) !== size) {
    clear(value)
    invalid()
  }
  return value
}
function nonzero(value) {
  for (let index = 0; index < value.byteLength; index++) {
    if (value[index] !== 0) return true
  }
  return false
}
function generationFrom(value) {
  let generation = 0n
  for (let index = 0; index < value.byteLength; index++) {
    generation = (generation << 8n) | BigInt(value[index])
  }
  return generation
}
function nowValue(clock) {
  let value
  try {
    value = clock()
  } catch {
    invalid()
  }
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  return BigInt(value)
}

function dynamicNowValue(clock) {
  let value
  try {
    value = clock()
  } catch {
    invalid()
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) invalid()
    return value
  }
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  return BigInt(value)
}

class DynamicRouteManager {
  #options
  #observer
  #allocations
  #constructionAuthority
  #bootstrapIO
  #revalidationIO
  #branches
  #destroyed
  #opening
  #lifecycle

  constructor(options) {
    this.#options = dynamicOptions(options)
    this.#observer = this.#options.observe || null
    this.#allocations = []
    this.#constructionAuthority = null
    this.#bootstrapIO = null
    this.#revalidationIO = null
    this.#branches = null
    this.#destroyed = false
    this.#opening = false
    this.#lifecycle = Object.freeze({})
  }

  async openDynamic(...args) {
    if (args.length !== 0) invalid()
    if (this.#destroyed) throw PrivateRouteError.ERR_DESTROYED()
    if (this.#branches) throw PrivateRouteError.ERR_REPLAY()
    if (this.#opening) throw PrivateRouteError.ERR_BUSY()
    this.#opening = true
    const lifecycle = this.#lifecycle
    try {
      this.#allocatePair(lifecycle)
      this.#notify({ type: 'allocation-reserved', resource: 'lookup', branchClass: 'LOOKUP' })
      this.#assertLifecycle(lifecycle)
      this.#notify({ type: 'allocation-reserved', resource: 'announce', branchClass: 'ANNOUNCE' })
      this.#assertLifecycle(lifecycle)

      this.#createConstructionAuthority(lifecycle)

      const request = this.#constructionAuthority.bootstrapRequest
      let io
      try {
        io = this.#options.bootstrapIOFactory(request)
      } catch {
        throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      }
      this.#assertLifecycle(lifecycle)
      if (!safeObject(io) || typeof io.open !== 'function' || typeof io.destroy !== 'function') {
        try {
          if (safeObject(io) && typeof io.destroy === 'function') io.destroy()
        } catch {}
        invalid()
      }
      this.#bootstrapIO = io
      this.#notify({ type: 'io-created', resource: 'bootstrap' })
      this.#assertLifecycle(lifecycle)

      let bootstrapTransfer
      try {
        bootstrapTransfer = await io.open()
      } catch {
        this.#assertLifecycle(lifecycle)
        throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      }
      this.#assertLifecycle(lifecycle)
      consumeBootstrapGuardReady(bootstrapTransfer)
      this.#assertLifecycle(lifecycle)
      try {
        io.destroy()
      } catch {}
      this.#bootstrapIO = null

      const revalidationRequest = this.#constructionAuthority.revalidationRequest
      let revalidationIO
      try {
        revalidationIO = this.#options.guardRevalidationIOFactory(revalidationRequest)
      } catch {
        throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      }
      this.#assertLifecycle(lifecycle)
      if (
        !safeObject(revalidationIO) ||
        typeof revalidationIO.open !== 'function' ||
        typeof revalidationIO.destroy !== 'function'
      ) {
        try {
          if (safeObject(revalidationIO) && typeof revalidationIO.destroy === 'function') {
            revalidationIO.destroy()
          }
        } catch {}
        invalid()
      }
      this.#revalidationIO = revalidationIO
      this.#notify({ type: 'io-created', resource: 'guard-revalidation' })
      this.#assertLifecycle(lifecycle)
      let revalidationTransfer
      try {
        revalidationTransfer = await revalidationIO.open()
      } catch {
        this.#assertLifecycle(lifecycle)
        throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      }
      this.#assertLifecycle(lifecycle)
      consumeGuardRevalidationReady(revalidationTransfer)
      this.#assertLifecycle(lifecycle)
      try {
        revalidationIO.destroy()
      } catch {}
      this.#revalidationIO = null

      const pairTransfer = this.#constructionAuthority.takePair()
      const pair = consumeBranchConstructionPair(pairTransfer)
      this.#constructionAuthority = null
      let lookup = null
      let announce = null
      let lookupMoved = false
      let announceMoved = false
      let branches = null
      let published = false
      try {
        lookup = consumeConstructedGuardBranch(pair.lookup)
        lookupMoved = true
        announce = consumeConstructedGuardBranch(pair.announce)
        announceMoved = true
        branches = dynamicBranches(lookup, announce)
        lookup = null
        announce = null
        this.#releaseAllocations(lifecycle)
        this.#assertLifecycle(lifecycle)
        this.#notify({ type: 'guard-ready', resource: 'paired-branches' })
        this.#assertLifecycle(lifecycle)
        this.#branches = branches
        published = true
        return branches
      } finally {
        revokeBranchPathPairBinding(pair.pathBinding)
        if (!published && branches) branches.destroy()
        destroyConstructedBranch(lookup)
        destroyConstructedBranch(announce)
        try {
          if (!lookupMoved) pair.lookup.destroy()
        } catch {}
        try {
          if (!announceMoved) pair.announce.destroy()
        } catch {}
      }
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    } finally {
      this.#opening = false
    }
  }

  destroy() {
    if (this.#destroyed) return false
    this.#terminate()
    return true
  }

  #allocatePair(lifecycle) {
    const allocated = []
    try {
      allocated.push(this.#allocateBranch(BRANCH_CLASS.LOOKUP, lifecycle))
      allocated.push(this.#allocateBranch(BRANCH_CLASS.ANNOUNCE, lifecycle))
      const [lookup, announce] = allocated
      if (
        same(lookup.branchId, announce.branchId) ||
        same(lookup.circuitId, announce.circuitId) ||
        lookup.generation === announce.generation
      ) {
        invalid()
      }
      this.#allocations = allocated
    } catch (err) {
      for (const allocation of allocated) this.#clearAllocation(allocation)
      throw err
    }
  }

  #allocateBranch(branchClass, lifecycle) {
    const values = []
    try {
      for (const size of [16, 16, 8, 32, 32]) {
        const value = ownedRandom(this.#options.randomBytes, size)
        values.push(value)
        this.#assertLifecycle(lifecycle)
        if (!nonzero(value)) invalid()
      }
      const generation = generationFrom(values[2])
      if (generation === 0n) invalid()
      return {
        branchClass,
        branchId: values[0],
        circuitId: values[1],
        generationSeed: values[2],
        generation,
        clientIdentitySeed: values[3],
        clientTailSeed: values[4]
      }
    } catch (err) {
      for (const value of values) clear(value)
      throw err
    }
  }

  #createConstructionAuthority(lifecycle) {
    const keyPairs = []
    let authority = null
    try {
      const current = dynamicNowValue(this.#options.now)
      this.#assertLifecycle(lifecycle)
      if (current > 0xffff_ffff_ffff_ffffn - 5_000n) invalid()
      const deadline = current + 5_000n
      const branches = []
      for (const allocation of this.#allocations) {
        let identity
        let tail
        try {
          identity = this.#options.crypto.keyPair(allocation.clientIdentitySeed)
          keyPairs.push(identity)
          this.#assertLifecycle(lifecycle)
          tail = this.#options.crypto.encryptionKeyPair(allocation.clientTailSeed)
          keyPairs.push(tail)
          this.#assertLifecycle(lifecycle)
        } catch {
          invalid()
        }
        branches.push(
          Object.freeze({
            branchClass: allocation.branchClass,
            branchId: allocation.branchId,
            circuitId: allocation.circuitId,
            generation: allocation.generation,
            clientCircuitIdentity: identity,
            clientTailEphemeral: tail,
            deadline,
            requestedLimits: this.#options.limits
          })
        )
      }
      authority = createBranchConstructionAuthority({
        lookup: branches[0],
        announce: branches[1],
        now: this.#options.now,
        adjacencyAuthority: this.#options.adjacencyAuthority
      })
      this.#assertLifecycle(lifecycle)
      this.#constructionAuthority = authority
      authority = null
    } finally {
      if (authority) authority.destroy()
      for (const pair of keyPairs) {
        clear(pair && pair.publicKey)
        clear(pair && pair.secretKey)
      }
    }
  }

  #terminate() {
    if (!this.#destroyed) {
      this.#destroyed = true
      this.#lifecycle = Object.freeze({})
    }
    const constructionAuthority = this.#constructionAuthority
    this.#constructionAuthority = null
    if (constructionAuthority) constructionAuthority.destroy()
    const io = this.#bootstrapIO
    this.#bootstrapIO = null
    if (io) {
      try {
        io.destroy()
      } catch {}
    }
    const revalidationIO = this.#revalidationIO
    this.#revalidationIO = null
    if (revalidationIO) {
      try {
        revalidationIO.destroy()
      } catch {}
    }
    const branches = this.#branches
    this.#branches = null
    if (branches) {
      try {
        branches.destroy()
      } catch {}
    }
    this.#releaseAllocations()
  }

  #releaseAllocations(lifecycle = null) {
    const allocations = this.#allocations
    this.#allocations = []
    const resources = []
    for (const allocation of allocations) {
      const resource = allocation.branchClass === BRANCH_CLASS.LOOKUP ? 'lookup' : 'announce'
      this.#clearAllocation(allocation)
      resources.push(resource)
    }
    for (const resource of resources) this.#notify({ type: 'allocation-erased', resource })
    if (lifecycle !== null) this.#assertLifecycle(lifecycle)
  }

  #clearAllocation(allocation) {
    clear(allocation.branchId)
    clear(allocation.circuitId)
    clear(allocation.generationSeed)
    clear(allocation.clientIdentitySeed)
    clear(allocation.clientTailSeed)
    allocation.generation = 0n
  }

  #assertLifecycle(lifecycle) {
    if (this.#destroyed || lifecycle !== this.#lifecycle) {
      throw PrivateRouteError.ERR_DESTROYED()
    }
  }

  #notify(event) {
    if (!this.#observer) return
    try {
      this.#observer(Object.freeze({ ...event }))
    } catch {
      // Test-only observation cannot affect protocol behavior.
    }
  }
}

export class RouteManager {
  #network
  #registry
  #crypto
  #clock
  #descriptorChecker
  #circuitIssuer
  #linkInstaller
  #safetyInstallerChecker
  #safetyRouteChecker
  #routeCompiler
  #routeCompilerChecker
  #maxSafetyHops
  #routeCandidate
  #routeCandidateChecker

  static createDynamic(options) {
    return new DynamicRouteManager(options)
  }

  constructor(options) {
    if (
      !safeObject(options) ||
      !safeObject(options.network) ||
      !safeObject(options.registry) ||
      !safeObject(options.crypto) ||
      typeof options.crypto.verify !== 'function' ||
      typeof options.crypto.randomBytes !== 'function' ||
      typeof options.clock !== 'function' ||
      !safeObject(options.descriptorChecker) ||
      options.descriptorChecker.isVerified !== isVerifiedDescriptor ||
      options.descriptorChecker.read !== readVerifiedDescriptor ||
      !safeObject(options.circuitIssuer) ||
      typeof options.circuitIssuer.issueFinalSafety !== 'function'
    )
      invalid()
    if (
      (options.routeCandidate === undefined) !== (options.routeCandidateChecker === undefined) ||
      (options.routeCandidateChecker !== undefined &&
        !isRouteCandidateChecker(options.routeCandidateChecker))
    )
      invalid()
    const linkInstaller = options.safetyInstaller
    if (!safeObject(linkInstaller) || !isSafetyInstallerChecker(options.safetyInstallerChecker))
      invalid()
    if (
      !safeObject(options.routeCompiler) ||
      !isRouteCompilerChecker(options.routeCompilerChecker) ||
      !isSafetyRouteChecker(options.safetyRouteChecker)
    )
      invalid()
    const maximum = options.limits && options.limits.maxSafetyHops
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 3) invalid()
    this.#network = options.network
    this.#registry = options.registry
    this.#crypto = options.crypto
    this.#clock = options.clock
    this.#descriptorChecker = options.descriptorChecker
    this.#circuitIssuer = options.circuitIssuer
    this.#linkInstaller = linkInstaller
    this.#safetyInstallerChecker = options.safetyInstallerChecker
    this.#safetyRouteChecker = options.safetyRouteChecker
    this.#routeCompiler = options.routeCompiler
    this.#routeCompilerChecker = options.routeCompilerChecker
    this.#maxSafetyHops = maximum
    this.#routeCandidate = options.routeCandidate || null
    this.#routeCandidateChecker = options.routeCandidateChecker || null
  }

  open(options) {
    let active = null
    let draining = null
    let destroyed = false
    let replacing = false
    let relayLossRetried = false
    let forwardClosed = false
    const generations = new Set()
    const destroyAttempts = new Set()
    const destroyGeneration = (generation) => {
      if (!generation || destroyAttempts.has(generation)) return
      destroyAttempts.add(generation)
      generations.delete(generation)
      generation.circuit.destroy()
    }
    const destroyAll = () => {
      if (destroyed) return
      destroyed = true
      const circuits = [...generations]
      active = null
      draining = null
      for (const value of circuits) {
        try {
          destroyGeneration(value)
        } catch {
          // Teardown of the other generation must still run.
        }
      }
    }
    const replace = (reason) => {
      if (destroyed || replacing || !active || !this.#routeCandidate) {
        destroyAll()
        throw PrivateRouteError.ROUTE_UNAVAILABLE()
      }
      replacing = true
      try {
        const candidate = this.#routeCandidateChecker.next(
          this.#routeCandidate,
          active.epoch,
          reason
        )
        const previous = active
        const next = this.#openOne(candidate, replace, previous.epoch)
        generations.add(next)
        if (draining) destroyGeneration(draining)
        if (reason === 'rotation') {
          if (previous.live) replaceCompiledRouteDuplex(previous.circuit, next.epoch)
          else previous.circuit.drain()
          active = next
          draining = previous.live ? null : previous
        } else {
          destroyGeneration(previous)
          active = next
          draining = null
        }
      } catch {
        destroyAll()
        throw PrivateRouteError.ROUTE_UNAVAILABLE()
      } finally {
        replacing = false
      }
    }
    active = this.#openOne(options, replace, null)
    generations.add(active)
    if (active.live) return active.circuit
    const send = (method, payload) => {
      if (destroyed || !active || forwardClosed) throw PrivateRouteError.CIRCUIT_STATE()
      try {
        return active.circuit[method](payload)
      } catch (err) {
        if (
          err instanceof PrivateRouteError &&
          err.code === 'ROUTE_UNAVAILABLE' &&
          !relayLossRetried
        ) {
          relayLossRetried = true
          replace('relay-loss')
          throw PrivateRouteError.ROUTE_UNAVAILABLE()
        }
        destroyAll()
        throw err
      }
    }
    return Object.freeze({
      sendDatagram(payload) {
        return send('sendDatagram', payload)
      },
      sendStreamFrame(payload) {
        return send('sendStreamFrame', payload)
      },
      drain() {
        if (destroyed || !active || forwardClosed) throw PrivateRouteError.CIRCUIT_STATE()
        forwardClosed = true
        const current = active
        const stale = draining
        active = null
        draining = current
        try {
          if (stale) destroyGeneration(stale)
          current.circuit.drain()
        } catch (err) {
          destroyAll()
          throw err
        }
      },
      destroy: destroyAll
    })
  }

  #openOne(options, requestReplacement, minimumEpoch) {
    if (
      !safeObject(options) ||
      !Array.isArray(options.safety) ||
      options.safety.length < 1 ||
      options.safety.length > this.#maxSafetyHops ||
      !this.#descriptorChecker.isVerified(options.descriptor)
    )
      invalid()
    let descriptor
    let safetyRouteCapability = null
    let circuitContext = null
    try {
      descriptor = this.#descriptorChecker.read(options.descriptor)
    } catch {
      unauthorized()
    }
    const now = nowValue(this.#clock)
    if (descriptor.expiresAt <= now) invalid()
    if (minimumEpoch !== null && descriptor.epoch <= minimumEpoch) invalid()
    const identities = new Set()
    const dials = new Set()
    const advertisements = []
    for (let index = 0; index < options.safety.length; index++) {
      const advertisement = decodeRelayAdvertisement(options.safety[index])
      if (
        advertisement.role !== ROLE.SAFETY ||
        roleForIdentity(advertisement.identityKey) !== ROLE.SAFETY ||
        advertisement.epoch !== descriptor.epoch ||
        advertisement.expiresAt < descriptor.expiresAt ||
        advertisement.expiresAt <= now ||
        same(advertisement.identityKey, descriptor.entry.identityKey) ||
        same(advertisement.dial, descriptor.entry.dial)
      )
        invalid()
      const identity = b4a.toString(advertisement.identityKey, 'hex')
      const dial = b4a.toString(advertisement.dial, 'hex')
      if (identities.has(identity) || dials.has(dial)) invalid()
      identities.add(identity)
      dials.add(dial)
      const message = b4a.concat([
        DOMAIN.RELAY_ADVERTISEMENT,
        encodeUnsignedRelayAdvertisement(advertisement)
      ])
      let valid = false
      try {
        valid =
          this.#crypto.verify(message, advertisement.relaySignature, advertisement.identityKey) ===
          true
      } catch {}
      if (!valid) unauthorized()
      advertisements.push(advertisement)
    }
    for (let index = 0; index < advertisements.length; index++) {
      const advertisement = advertisements[index]
      let allowed = false
      try {
        allowed =
          this.#registry.allows(
            b4a.from(advertisement.identityKey),
            PRIVACY_OPERATION.PUBLIC_RETURN,
            { consumer: 'relay-discovery' }
          ) === true
      } catch {}
      if (!allowed) unauthorized()
      if (index === 0) {
        try {
          allowed =
            this.#registry.allows(
              b4a.from(advertisement.identityKey),
              PRIVACY_OPERATION.GUARD_DIAL,
              { selectedGuard: true }
            ) === true
        } catch {
          allowed = false
        }
        if (!allowed) unauthorized()
      }
    }
    const circuitId = this.#crypto.randomBytes(16)
    if (length(circuitId) !== 16) invalid()
    try {
      for (let index = 0; index < advertisements.length; index++) {
        const advertisement = advertisements[index]
        const binding = Object.freeze({
          circuitId: b4a.from(circuitId),
          epoch: descriptor.epoch,
          expiresAt: descriptor.expiresAt,
          index,
          total: advertisements.length
        })
        // The checker is the only object with authority to invoke a branded installer.
        this.#safetyInstallerChecker.authenticate(this.#linkInstaller, advertisement, binding)
        this.#safetyInstallerChecker.install(this.#linkInstaller, advertisement, binding)
      }
      const final = advertisements[advertisements.length - 1]
      circuitContext = this.#circuitIssuer.issueFinalSafety({
        circuitId,
        epoch: descriptor.epoch,
        finalSafetyIdentity32: final.identityKey,
        entryIdentity32: descriptor.entry.identityKey,
        expiresAt: descriptor.expiresAt
      })
      if (!safeObject(circuitContext)) invalid()
      safetyRouteCapability = this.#safetyInstallerChecker.finalize(
        this.#linkInstaller,
        circuitContext
      )
      let circuit
      try {
        circuit = this.#routeCompilerChecker.open(
          this.#routeCompiler,
          Object.freeze({
            circuitContext,
            safetyRouteCapability,
            circuitId: b4a.from(circuitId),
            descriptorValue: descriptor,
            requestReplacement
          })
        )
        const branded = isCompiledRouteDuplex(circuit)
        const live =
          branded &&
          isCompiledRouteDuplexFor(circuit, {
            circuitContext,
            descriptorId: descriptor.descriptorId,
            circuitId,
            epoch: descriptor.epoch
          })
        if (branded && !live) invalid()
        if (
          !live &&
          (!safeObject(circuit) ||
            Object.keys(circuit).sort().join(',') !==
              'destroy,drain,sendDatagram,sendStreamFrame' ||
            typeof circuit.sendDatagram !== 'function' ||
            typeof circuit.sendStreamFrame !== 'function' ||
            typeof circuit.drain !== 'function' ||
            typeof circuit.destroy !== 'function')
        )
          invalid()
      } catch (err) {
        if (isCompiledRouteDuplex(circuit)) {
          try {
            failCompiledRouteDuplex(circuit)
          } catch {}
        }
        // A missing or timed-out circuit is an availability failure. Preserve
        // authenticated protocol rejections so callers cannot mistake forged
        // route material for a transient outage.
        if (err instanceof PrivateRouteError && err.code !== 'CIRCUIT_STATE') throw err
        throw PrivateRouteError.ROUTE_UNAVAILABLE()
      }
      return Object.freeze({
        circuit,
        epoch: descriptor.epoch,
        live: isCompiledRouteDuplexFor(circuit, {
          circuitContext,
          descriptorId: descriptor.descriptorId,
          circuitId,
          epoch: descriptor.epoch
        })
      })
    } catch (err) {
      if (safetyRouteCapability) {
        try {
          this.#safetyRouteChecker.read(safetyRouteCapability, circuitContext).destroy()
        } catch {}
      }
      try {
        this.#safetyInstallerChecker.rollback(this.#linkInstaller)
      } catch {
        throw PrivateRouteError.ROUTE_UNAVAILABLE()
      }
      throw err
    }
  }
}

function simulatorRandom(start = 1) {
  let value = start
  return (size) => b4a.alloc(size, value++)
}

let simulatorInstances = 0

function simulatorIdentityForRole(role, start) {
  for (let value = start; value < start + 256; value++) {
    const seed = b4a.alloc(32)
    seed[30] = value >>> 8
    seed[31] = value
    const pair = cryptoSuite.keyPair(seed)
    if (roleForIdentity(pair.publicKey) === role) return pair
  }
  invalid()
}

function simulatorInstanceBuffer(size, marker, instance) {
  const value = b4a.alloc(size, marker)
  let current = BigInt(instance)
  for (let index = size - 1; index >= Math.max(0, size - 8); index--) {
    value[index] = Number(current & 0xffn)
    current >>= 8n
  }
  return value
}

function simulatorClearState(state) {
  if (!state) return
  for (const name of ['circuitId', 'localIdentity', 'peerIdentity', 'localId', 'peerLocalId']) {
    try {
      if (b4a.isBuffer(state[name])) state[name].fill(0)
    } catch {}
  }
  for (const pair of Object.values(state.contexts || {})) {
    for (const context of [pair.tx, pair.rx]) {
      try {
        context.key.fill(0)
      } catch {}
      try {
        context.noncePrefix.fill(0)
      } catch {}
      try {
        context.counter.destroy()
      } catch {}
    }
  }
}

function simulatorEndpoint(checker, ticket) {
  const state = checker.take(ticket)
  const codec = new CellCodec({
    crypto: cryptoSuite,
    cellSize: CELL_SIZE,
    padding: (size) => b4a.alloc(size)
  })
  let live = true
  return Object.freeze({
    seal(cellClass, direction, payload) {
      if (!live) throw PrivateRouteError.CIRCUIT_STATE()
      const context = state.contexts[cellClass].tx
      return codec.seal({
        key: context.key,
        noncePrefix: context.noncePrefix,
        senderCounter: context.counter,
        class: cellClass,
        direction,
        epoch: state.epoch,
        circuitId: state.peerLocalId,
        payload
      })
    },
    open(cellClass, direction, packet) {
      if (!live) throw PrivateRouteError.CIRCUIT_STATE()
      const context = state.contexts[cellClass].rx
      return codec.open(
        {
          key: context.key,
          noncePrefix: context.noncePrefix,
          receiver: context.counter,
          expectedClass: cellClass,
          expectedDirection: direction,
          expectedEpoch: state.epoch,
          expectedCircuitId: state.localId
        },
        packet
      )
    },
    destroy() {
      if (!live) return
      live = false
      simulatorClearState(state)
    }
  })
}

function simulatorDeliver(codec, direction, frame, target) {
  const deliveries = codec.open({ direction }, frame)
  const values = Array.isArray(deliveries) ? deliveries : [deliveries]
  for (const delivery of values) {
    try {
      const callback = delivery.class === CELL_CLASS.DATAGRAM ? target.ondata : target.onstream
      if (typeof callback === 'function') callback(delivery.payload)
    } finally {
      delivery.payload.fill(0)
    }
  }
}

// Deterministic Milestone 1 harness. It is intentionally absent from index.js;
// only compiled-route tests may centrally inspect the complete simulated path.
export function createCompiledRouteSimulator(options) {
  if (!safeObject(options) || options.safetyHops !== 2 || options.privateHops !== 2) invalid()
  simulatorInstances++
  if (!Number.isSafeInteger(simulatorInstances)) throw PrivateRouteError.CIRCUIT_LIMIT()
  const instance = simulatorInstances
  const names = ['source', 'guard', 'safety-final', 'private-entry', 'private-final', 'destination']
  const randomBytes = simulatorRandom(20)
  const roles = [null, ROLE.SAFETY, ROLE.SAFETY, ROLE.PRIVATE, ROLE.PRIVATE, null]
  const nodes = names.map((name, index) => ({
    name,
    identity:
      roles[index] === null
        ? cryptoSuite.keyPair(b4a.alloc(32, 40 + index))
        : simulatorIdentityForRole(roles[index], 100 + index * 300),
    encryption: cryptoSuite.encryptionKeyPair(b4a.alloc(32, 60 + index))
  }))
  const circuitId = simulatorInstanceBuffer(16, 0x70, instance)
  const descriptorId = simulatorInstanceBuffer(32, 0x72, instance)
  const epoch = 7n
  const expiresAt = 10_000n
  const network = new VirtualNetwork({ now: 1_000 })
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => 1_000,
    randomBytes
  })
  const links = []
  const relays = []
  const relayEvents = names.slice(1, -1).map(() => [])
  const source = { onstream: null }
  const destination = { ondata: null, onstream: null }
  let sourceLink = null
  let destinationLink = null
  let sourcePayload = null
  let destinationPayload = null
  let state = 'create'
  let drainDeadline = null

  for (let index = 0; index < nodes.length - 1; index++) {
    const initiator = nodes[index]
    const responder = nodes[index + 1]
    const common = {
      circuitId,
      epoch,
      initiatorIdentity: initiator.identity.publicKey,
      responderIdentity: responder.identity.publicKey,
      initiatorLocalId: b4a.alloc(16, 0x80 + index * 2),
      responderLocalId: b4a.alloc(16, 0x81 + index * 2),
      expiresAt
    }
    const started = authority.initiate({
      ...common,
      responderStaticKey: responder.encryption.publicKey,
      initiatorIdentitySecretKey: initiator.identity.secretKey
    })
    const accepted = authority.respond(started.message, {
      ...common,
      responderStaticSecretKey: responder.encryption.secretKey,
      responderIdentitySecretKey: responder.identity.secretKey
    })
    links.push({
      common,
      initiatorTicket: authority.complete(started.pending, accepted.message),
      responderTicket: accepted.ticket
    })
  }

  function nodeForIdentity(identity) {
    return nodes.find((node) => same(node.identity.publicKey, identity))
  }

  for (let index = 0; index < nodes.length; index++) {
    if (index === 0) {
      network.register(nodes[index].name, (packet) => {
        if (state === 'destroyed') return
        const cellClass = packet[1]
        const opened = sourceLink.open(cellClass, DIRECTION.REVERSE, packet)
        const frames = Array.isArray(opened) ? opened : [opened]
        for (const frame of frames) {
          try {
            simulatorDeliver(sourcePayload, DIRECTION.REVERSE, frame, source)
          } finally {
            frame.fill(0)
          }
        }
      })
      continue
    }
    if (index === nodes.length - 1) {
      network.register(nodes[index].name, (packet) => {
        if (state === 'destroyed') return
        const cellClass = packet[1]
        const opened = destinationLink.open(cellClass, DIRECTION.FORWARD, packet)
        const frames = Array.isArray(opened) ? opened : [opened]
        for (const frame of frames) {
          try {
            simulatorDeliver(destinationPayload, DIRECTION.FORWARD, frame, destination)
          } finally {
            frame.fill(0)
          }
        }
      })
      continue
    }
    const relayIndex = index - 1
    network.register(nodes[index].name, (packet) => {
      if (state === 'destroyed') return
      const localId = packet.subarray(12, 28)
      const fromPrevious = same(localId, links[index - 1].common.responderLocalId)
      const peer = fromPrevious ? nodes[index - 1] : nodes[index + 1]
      relays[relayIndex].receive(peer.identity.publicKey, packet)
    })
  }

  for (let index = 1; index < nodes.length - 1; index++) {
    const relayIndex = index - 1
    const relay = new RelayService({
      identity: nodes[index].identity.publicKey,
      ticketChecker: authority.checker,
      crypto: cryptoSuite,
      now: () => 1_000,
      padding: (size) => b4a.alloc(size),
      send(peer, packet) {
        const target = nodeForIdentity(peer)
        if (!target) return false
        network.send(nodes[index].name, target.name, packet)
        return true
      },
      [TEST_ONLY_RELAY_OBSERVER](event) {
        if (event.type !== 'forward' || event.class === CELL_CLASS.CONTROL) return
        relayEvents[relayIndex].push({
          frameHash: b4a.toString(event.beforeHash, 'hex'),
          frameBytes: event.byteLength
        })
      }
    })
    relay.install(links[index - 1].responderTicket, links[index].initiatorTicket)
    relays.push(relay)
  }

  sourceLink = simulatorEndpoint(authority.checker, links[0].initiatorTicket)
  destinationLink = simulatorEndpoint(authority.checker, links.at(-1).responderTicket)
  const entryChallenge = b4a.alloc(32, 0xa1)
  const destinationChallenge = b4a.alloc(32, 0xa2)
  const encryptedHops = b4a.from('registered private route')
  const createValue = {
    version: 0,
    circuitId,
    epoch,
    descriptorId,
    sourceEphemeralKey: nodes[0].encryption.publicKey,
    safetyTranscriptHash: cryptoSuite.hash(
      nodes.slice(1, 3).map((node) => node.identity.publicKey)
    ),
    entryChallengeCipher: b4a.alloc(48),
    destinationChallengeCipher: b4a.alloc(48),
    encryptedHops
  }
  const createBaseHash = hashCreateBase(createValue)
  const entryShared = cryptoSuite.keyAgreement(
    nodes[0].encryption.secretKey,
    nodes[3].encryption.publicKey
  )
  const destinationShared = cryptoSuite.keyAgreement(
    nodes[0].encryption.secretKey,
    nodes.at(-1).encryption.publicKey
  )
  createValue.entryChallengeCipher = activationChallengeCipher(
    entryShared,
    createBaseHash,
    entryChallenge,
    0
  )
  createValue.destinationChallengeCipher = activationChallengeCipher(
    destinationShared,
    createBaseHash,
    destinationChallenge,
    1
  )
  const create = encodeCreate(createValue)
  const entryProof = createEntryProof({
    create,
    entryIdentity: nodes[3].identity.publicKey,
    entryIdentitySecretKey: nodes[3].identity.secretKey,
    entryRouteEncryptionSecretKey: nodes[3].encryption.secretKey,
    expectedDescriptorId: descriptorId,
    expectedEpoch: epoch,
    expectedCircuitId: circuitId,
    expiresAt,
    startedAt: 1_000,
    now: () => 1_000,
    replayCache: createEntryReplayCache({ now: () => 1_000 })
  })
  verifyEntryProof({
    create,
    proof: entryProof,
    entryIdentity: nodes[3].identity.publicKey,
    entryRouteEncryptionKey: nodes[3].encryption.publicKey,
    sourceEphemeralSecretKey: nodes[0].encryption.secretKey,
    entryChallenge,
    expiresAt,
    startedAt: 1_000,
    now: () => 1_000
  })
  const parameters = {
    version: 0,
    cellSize: 1200,
    routeFrameSize: 1100,
    maxCellPayload: 1146,
    maxRoutePayload: 1073,
    capabilities: 7,
    safetyMin: 1,
    safetyMax: 3,
    privateMin: 1,
    privateMax: 3,
    counterWindow: 64
  }
  const created = createDestinationProof({
    create,
    entryProof,
    endpointIdentity: nodes.at(-1).identity.publicKey,
    routeSigningKey: nodes.at(-1).identity.publicKey,
    routeSigningSecretKey: nodes.at(-1).identity.secretKey,
    destinationRouteEncryptionSecretKey: nodes.at(-1).encryption.secretKey,
    expectedDescriptorId: descriptorId,
    expectedEpoch: epoch,
    expectedCircuitId: circuitId,
    parameters,
    expiresAt,
    startedAt: 1_000,
    now: () => 1_000,
    replayCache: createDestinationReplayCache({ now: () => 1_000 })
  })
  const verified = verifyDestinationProof({
    create,
    entryProof,
    created,
    endpointIdentity: nodes.at(-1).identity.publicKey,
    routeSigningKey: nodes.at(-1).identity.publicKey,
    destinationRouteEncryptionKey: nodes.at(-1).encryption.publicKey,
    sourceEphemeralSecretKey: nodes[0].encryption.secretKey,
    destinationChallenge,
    parameters,
    expiresAt,
    startedAt: 1_000,
    now: () => 1_000,
    replayCache: createDestinationReplayCache({ now: () => 1_000 })
  })
  const keyMaterial = verified.payloadKeys
  const payloadFields = {
    descriptorId,
    circuitId,
    forwardKey: keyMaterial.forwardKey,
    forwardNoncePrefix: keyMaterial.forwardNoncePrefix,
    reverseKey: keyMaterial.reverseKey,
    reverseNoncePrefix: keyMaterial.reverseNoncePrefix
  }
  sourcePayload = new RoutePayloadCodec({
    crypto: cryptoSuite,
    context: mintCreatedRoutePayloadContext({
      ...payloadFields,
      endpointRole: ROUTE_ENDPOINT.SOURCE
    }),
    window: 64,
    gapTimeout: 5_000,
    now: () => 1_000,
    padding: (size) => b4a.alloc(size)
  })
  destinationPayload = new RoutePayloadCodec({
    crypto: cryptoSuite,
    context: mintCreatedRoutePayloadContext({
      ...payloadFields,
      endpointRole: ROUTE_ENDPOINT.DESTINATION
    }),
    window: 64,
    gapTimeout: 5_000,
    now: () => 1_000,
    padding: (size) => b4a.alloc(size)
  })
  keyMaterial.forwardKey.fill(0)
  keyMaterial.reverseKey.fill(0)
  keyMaterial.forwardNoncePrefix.fill(0)
  keyMaterial.reverseNoncePrefix.fill(0)
  entryShared.fill(0)
  destinationShared.fill(0)
  entryChallenge.fill(0)
  destinationChallenge.fill(0)
  nodes[0].encryption.secretKey.fill(0)
  nodes[3].encryption.secretKey.fill(0)
  nodes.at(-1).encryption.secretKey.fill(0)
  for (let index = 0; index < relays.length; index++) {
    relays[index].created(nodes[index].identity.publicKey, links[index].common.responderLocalId)
    relays[index].open(nodes[index].identity.publicKey, links[index].common.responderLocalId)
  }
  state = 'open'

  function refreshState() {
    if (state === 'draining' && network.now >= drainDeadline) destroy()
  }

  function requireOpen() {
    refreshState()
    if (state !== 'open') throw PrivateRouteError.CIRCUIT_STATE()
  }

  function sendFrom(endpoint, payloadCodec, cellLink, node, cellClass, direction, payload) {
    refreshState()
    if (
      (direction === DIRECTION.FORWARD && state !== 'open') ||
      (direction === DIRECTION.REVERSE && state !== 'open' && state !== 'draining')
    ) {
      throw PrivateRouteError.CIRCUIT_STATE()
    }
    const frame = payloadCodec.seal({ class: cellClass, direction, payload })
    let packet = null
    try {
      packet = cellLink.seal(cellClass, direction, frame)
    } finally {
      frame.fill(0)
    }
    network.send(node.name, direction === DIRECTION.FORWARD ? names[1] : names.at(-2), packet)
  }

  function destroy() {
    if (state === 'destroyed') return
    state = 'destroyed'
    for (let index = relays.length - 1; index >= 0; index--) {
      try {
        relays[index].destroy(nodes[index].identity.publicKey, links[index].common.responderLocalId)
      } catch {}
    }
    sourceLink.destroy()
    destinationLink.destroy()
    sourcePayload.destroy()
    destinationPayload.destroy()
    try {
      network.flush()
    } catch {}
  }

  const circuit = Object.freeze({
    sendDatagram(payload) {
      sendFrom(
        source,
        sourcePayload,
        sourceLink,
        nodes[0],
        CELL_CLASS.DATAGRAM,
        DIRECTION.FORWARD,
        payload
      )
    },
    sendStreamFrame(payload) {
      sendFrom(
        source,
        sourcePayload,
        sourceLink,
        nodes[0],
        CELL_CLASS.STREAM,
        DIRECTION.FORWARD,
        payload
      )
    },
    drain() {
      requireOpen()
      state = 'draining'
      drainDeadline = network.now + 5_000
    },
    destroy
  })

  destination.sendStreamFrame = (payload) => {
    sendFrom(
      destination,
      destinationPayload,
      destinationLink,
      nodes.at(-1),
      CELL_CLASS.STREAM,
      DIRECTION.REVERSE,
      payload
    )
  }

  return Object.freeze({
    circuit,
    destination,
    network,
    observer: Object.freeze({
      relayViews() {
        return Object.freeze(
          relayEvents.map((events, index) => {
            const event = events.at(-1)
            return Object.freeze({
              adjacent: Object.freeze([names[index], names[index + 2]]),
              frameHash: event && event.frameHash,
              frameBytes: event && event.frameBytes,
              hasPayloadKeys: false,
              containsPlaintext: false
            })
          })
        )
      },
      resources() {
        refreshState()
        return Object.freeze({
          activeCircuits: relays.reduce((total, relay) => total + relay.activeCircuits, 0),
          queuedBytes: relays.reduce((total, relay) => total + relay.queuedBytes, 0),
          destroyed: state === 'destroyed'
        })
      }
    }),
    source,
    get state() {
      refreshState()
      return state
    }
  })
}
