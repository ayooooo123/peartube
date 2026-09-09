import b4a from 'b4a'

import {
  ACTOR_CONTROL_KIND,
  PrivateRouteError,
  createDestinationReplayCache,
  createLiveRouteNode,
  createPrivateDestinationActor,
  createRemoteActivationVerifier,
  createRemoteRegistrationVerifier,
  cryptoSuite,
  destroyPrivateDestinationActor
} from '../../index.js'
import {
  createDistributedPrivateRelayActor,
  destroyDistributedPrivateRelayActor
} from '../../lib/activation.js'
import {
  LIVE_ROUTE_ACTIVATE_ENDPOINT,
  LIVE_ROUTE_CLOSE_SOCKET,
  LIVE_ROUTE_CREATE_CONTROL,
  LIVE_ROUTE_FORWARD_ACTOR,
  LIVE_ROUTE_REGISTER_ACTOR,
  LIVE_ROUTE_REVOKE_GRANT
} from '../../lib/live-route-node.js'
import { UdxAdapter } from '../../lib/udx-adapter.js'
import runtime from '#private-route-process'
import { NegativeControlDialer } from '../namespace/negative-control.js'
import { createProcessCodecVectors } from './codec-vectors.js'
import {
  CONTROL_COMMAND,
  CONTROL_EVENT,
  CONTROL_FAULT,
  ControlFrameDecoder,
  ControlLifecycle,
  encodeControlFrame
} from './control-channel.js'

const REGISTRATION_ATTEMPT_TIMEOUT = 1_000

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clearTree(value, seen = new Set()) {
  if (b4a.isBuffer(value)) {
    value.fill(0)
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const entry of Array.isArray(value) ? value : Object.values(value)) clearTree(entry, seen)
}

function runtimeRecord() {
  const bare = typeof Bare !== 'undefined'
  return Object.freeze({
    runtime: bare ? 'bare' : 'node',
    runtimeVersion: bare ? Bare.version : globalThis.process.version,
    adapter: bare ? 'bare-process' : 'node-process',
    udxVersion: '1.20.7'
  })
}

function linkFingerprints(projection) {
  return Object.freeze(
    projection.grants
      .map((encoding) => {
        const digest = cryptoSuite.hash([b4a.from('private-route-process-link-v0'), encoding])
        const fingerprint = b4a.toString(digest.subarray(0, 8), 'hex')
        digest.fill(0)
        return fingerprint
      })
      .sort()
  )
}

function errorCode(error) {
  return error instanceof PrivateRouteError ? error.code : 'ROUTE_UNAVAILABLE'
}

export function createProcessFaultAdapter(adapter, faults) {
  if (!object(adapter) || typeof adapter.create !== 'function' || !(faults instanceof Set))
    invalid()
  return Object.freeze({
    create() {
      const udx = adapter.create()
      return {
        createSocket() {
          const socket = udx.createSocket()
          let replay = null
          return {
            bind(...args) {
              return socket.bind(...args)
            },
            send(...args) {
              const packet = args[0]
              if (
                faults.has(CONTROL_FAULT.OVERFLOW_QUEUE) &&
                b4a.isBuffer(packet) &&
                packet.byteLength === 1_200 &&
                packet[1] !== 0x80
              ) {
                return Promise.resolve().then(() => socket.send(...args))
              }
              return socket.send(...args)
            },
            close(...args) {
              if (replay) replay.fill(0)
              replay = null
              return socket.close(...args)
            },
            on(event, listener) {
              if (event !== 'message') return socket.on(event, listener)
              return socket.on(event, (packet, from) => {
                if (faults.has(CONTROL_FAULT.SPOOF_SOURCE)) {
                  listener(packet, {
                    host: from.host,
                    port: from.port === 65_535 ? 1 : from.port + 1,
                    family: from.family
                  })
                  return
                }
                if (
                  faults.has(CONTROL_FAULT.REPLAY) &&
                  b4a.isBuffer(packet) &&
                  packet.byteLength === 1_200 &&
                  packet[1] !== 0x80
                ) {
                  if (!replay) replay = b4a.from(packet)
                  listener(replay, from)
                  return
                }
                listener(packet, from)
              })
            }
          }
        }
      }
    }
  })
}

export function createRoleRunner(options = {}) {
  if (!object(options) || typeof options.emit !== 'function') invalid()
  const makeNode = options.createNode || createLiveRouteNode
  if (typeof makeNode !== 'function') invalid()
  const makeNegativeControl =
    options.createNegativeControlDialer || ((value) => new NegativeControlDialer(value))
  if (typeof makeNegativeControl !== 'function') invalid()
  const adapters = options.adapters || {
    now: Date.now,
    schedule: setTimeout,
    cancel: clearTimeout,
    randomBytes: cryptoSuite.randomBytes
  }
  const lifecycle = new ControlLifecycle()
  const emitted = options.emit
  const onFault = options.onFault
  let projection = null
  let fingerprints = null
  let node = null
  let actor = null
  let destroyActor = null
  let codecVectors = null
  let negativeControl = null
  let preparedMilestone = null
  let destinationWork = null
  let armedRevocation = null
  let phase = 'configured'
  const armedFaults = new Set()
  const endpointLimits = Object.freeze({
    get maxQueuedPackets() {
      return armedFaults.has(CONTROL_FAULT.OVERFLOW_QUEUE) ? 1 : undefined
    },
    get maxQueuedBytes() {
      return armedFaults.has(CONTROL_FAULT.OVERFLOW_QUEUE) ? 1_200 : undefined
    }
  })
  const traffic = { streamBytes: 0, datagramBytes: 0 }
  let queue = Promise.resolve()

  const releaseActor = () => {
    if (!actor || !destroyActor) return
    const owned = actor
    actor = null
    const destroy = destroyActor
    destroyActor = null
    try {
      destroy(owned)
    } catch {}
  }

  const releaseNegativeControl = async () => {
    if (!negativeControl) return false
    const owned = negativeControl
    negativeControl = null
    try {
      await owned.close()
    } catch {}
    return true
  }

  const wait = (delay) =>
    new Promise((resolve, reject) => {
      let handle
      try {
        handle = adapters.schedule(resolve, delay)
      } catch (err) {
        reject(err)
        return
      }
      if (handle === null || handle === undefined) reject(PrivateRouteError.ROUTE_UNAVAILABLE())
    })

  const routeTraffic = () => {
    const value = projection.route?.traffic
    if (
      !object(value) ||
      !b4a.isBuffer(value.sendStream) ||
      value.sendStream.byteLength < 1 ||
      !b4a.isBuffer(value.sendDatagram) ||
      value.sendDatagram.byteLength < 1 ||
      !b4a.isBuffer(value.expectStream) ||
      value.expectStream.byteLength < 1 ||
      !b4a.isBuffer(value.expectDatagram) ||
      value.expectDatagram.byteLength < 1
    )
      invalid()
    return value
  }

  const receiveTraffic = async (duplex, expected) => {
    const deadline = Number(adapters.now()) + 5_000
    const chunks = []
    let streamBytes = 0
    let datagram = null
    try {
      while (streamBytes < expected.expectStream.byteLength || !datagram) {
        let chunk
        while ((chunk = duplex.read()) !== null) {
          chunks.push(chunk)
          streamBytes += chunk.byteLength
        }
        if (!datagram) datagram = duplex.receiveDatagram()
        if (streamBytes >= expected.expectStream.byteLength && datagram) break
        if (Number(adapters.now()) >= deadline) throw PrivateRouteError.ROUTE_UNAVAILABLE()
        await wait(1)
      }
      const stream = b4a.concat(chunks)
      try {
        if (
          !b4a.equals(stream, expected.expectStream) ||
          !b4a.equals(datagram, expected.expectDatagram)
        )
          throw PrivateRouteError.UNAUTHORIZED()
      } finally {
        stream.fill(0)
      }
      traffic.streamBytes = streamBytes
      traffic.datagramBytes = datagram.byteLength
      return true
    } finally {
      for (const chunk of chunks) chunk.fill(0)
      if (datagram) datagram.fill(0)
    }
  }

  const sendTraffic = async (duplex, value) => {
    if (!duplex.write(value.sendStream) || !duplex.sendDatagram(value.sendDatagram)) {
      throw PrivateRouteError.ROUTE_UNAVAILABLE()
    }
    await duplex.drain()
  }

  const registerPrivateActor = () => {
    phase = 'private-register'
    const nextRole =
      projection.role === 'private-entry'
        ? 'private-middle'
        : projection.role === 'private-middle'
          ? 'private-final'
          : 'destination'
    const contact = projection.contacts.find((value) => value.role === nextRole)
    if (!contact || !object(projection.route)) invalid()
    actor = createDistributedPrivateRelayActor({
      identity: projection.local.identity32,
      identitySecretKey: projection.local.identitySecretKey,
      routeEncryptionSecretKey: projection.local.routeEncryptionSecretKey,
      nextIdentity: contact.identity32,
      nextRouteEncryptionKey: contact.routeEncryptionKey,
      entry: projection.role === 'private-entry',
      destination: nextRole === 'destination',
      now: adapters.now,
      randomBytes: adapters.randomBytes,
      forward(kind, circuitId, generation, body) {
        const forwarded = node[LIVE_ROUTE_FORWARD_ACTOR](
          kind,
          contact.actorId,
          circuitId,
          generation,
          body
        )
        if (
          projection.role !== 'private-final' ||
          kind !== ACTOR_CONTROL_KIND.ACTIVATE_CREATE ||
          !armedFaults.delete(CONTROL_FAULT.DELAY_CREATED)
        ) {
          return forwarded
        }
        return forwarded.then(async (created) => {
          await wait(5_100)
          return created
        })
      }
    })
    destroyActor = destroyDistributedPrivateRelayActor
    node[LIVE_ROUTE_REGISTER_ACTOR](projection.route.actorId, actor)
    return 'actor-registered'
  }

  const prepareDestinationActor = () => {
    phase = 'destination-register'
    const route = projection.route
    if (!object(route)) invalid()
    let resolveCreated
    let rejectCreated
    const created = new Promise((resolve, reject) => {
      resolveCreated = resolve
      rejectCreated = reject
    })
    let destinationDuplex = null
    actor = createPrivateDestinationActor({
      identity: projection.local.identity32,
      identitySecretKey: projection.local.identitySecretKey,
      routeSigningKey: route.routeSigningKey,
      routeSigningSecretKey: route.routeSigningSecretKey,
      routeEncryptionSecretKey: route.routeEncryptionSecretKey,
      finalToken: route.finalToken,
      now: adapters.now,
      randomBytes: adapters.randomBytes,
      observe(event) {
        if (event.type !== 'private-destination-created' || destinationDuplex) return
        try {
          destinationDuplex = node[LIVE_ROUTE_ACTIVATE_ENDPOINT]()
          resolveCreated(destinationDuplex)
        } catch (err) {
          rejectCreated(err)
        }
      }
    })
    destroyActor = destroyPrivateDestinationActor
    node[LIVE_ROUTE_REGISTER_ACTOR](route.actorId, actor)
    destinationWork = (async () => {
      phase = 'destination-receive'
      const duplex = await created
      const value = routeTraffic()
      await receiveTraffic(duplex, value)
      phase = 'destination-send'
      await sendTraffic(duplex, value)
      return 'traffic-exchanged'
    })()
    void destinationWork.catch(() => {})
    return 'actor-registered'
  }

  const establishSource = async () => {
    const route = projection.route
    if (!object(route)) return 'transport-open'
    const deadline = Number(adapters.now()) + 5_000
    phase = 'source-register'
    let control = null
    let registered = null
    const registrationTimeout = armedFaults.size === 0 ? REGISTRATION_ATTEMPT_TIMEOUT : undefined
    for (;;) {
      control = node[LIVE_ROUTE_CREATE_CONTROL](route.entryActorId)
      try {
        registered = await control.register({
          stage: route.registrationCapsule,
          prepare: route.prepareCapsule,
          finalize: route.finalizeCapsule,
          abort: route.abortCapsule,
          timeout: registrationTimeout,
          registrationVerifier: createRemoteRegistrationVerifier({
            request: route.registrationCapsule,
            registrations: route.registrations
          })
        })
        registered.acknowledgements.fill(0)
        break
      } catch (err) {
        try {
          await control.stop()
        } catch {}
        control = null
        if (err?.code !== 'ROUTE_UNAVAILABLE' || Number(adapters.now()) >= deadline) throw err
        await wait(5)
      }
    }
    const activation = route.activation
    phase = 'source-activate'
    const proof = await control.activate({
      body: activation.body,
      circuitId: activation.circuitId,
      generation: activation.generation,
      activationVerifier: createRemoteActivationVerifier({
        request: activation.body,
        circuitId: activation.circuitId,
        generation: activation.generation,
        entryIdentity: activation.entryIdentity,
        entryRouteEncryptionKey: activation.entryRouteEncryptionKey,
        endpointIdentity: activation.endpointIdentity,
        routeSigningKey: activation.routeSigningKey,
        destinationRouteEncryptionKey: activation.destinationRouteEncryptionKey,
        sourceEphemeralSecretKey: activation.sourceEphemeralSecretKey,
        entryChallenge: activation.entryChallenge,
        destinationChallenge: activation.destinationChallenge,
        replayCache: createDestinationReplayCache({ now: adapters.now }),
        now: adapters.now
      })
    })
    proof.fill(0)
    const duplex = node[LIVE_ROUTE_ACTIVATE_ENDPOINT]()
    const value = routeTraffic()
    phase = 'source-send'
    await sendTraffic(duplex, value)
    phase = 'source-receive'
    await receiveTraffic(duplex, value)
    return 'created-and-traffic-verified'
  }

  const prepareRole = () => {
    if (projection.role.startsWith('private-')) return registerPrivateActor()
    if (projection.role === 'destination') return prepareDestinationActor()
    return 'transport-open'
  }

  const establishRole = async () => {
    if (projection.role === 'source') return establishSource()
    if (projection.role === 'destination') return destinationWork
    return preparedMilestone
  }

  const send = (record) => {
    lifecycle.emit(record)
    emitted(Object.freeze(record))
  }

  const snapshotEvent = (event) => {
    const snapshot = node.snapshot()
    return {
      event,
      role: projection.role,
      state: snapshot.state,
      links: snapshot.links,
      counters: snapshot.counters,
      fingerprints,
      resources: snapshot.resources
    }
  }

  const execute = async (command) => {
    const kind = lifecycle.accept(command)
    switch (kind) {
      case CONTROL_COMMAND.CONFIGURE:
        projection = command.projection
        if (projection.negativeControl !== undefined) {
          if (projection.role !== 'source') invalid()
          negativeControl = makeNegativeControl(projection.negativeControl)
          if (
            !object(negativeControl) ||
            !Number.isSafeInteger(negativeControl.invocations) ||
            negativeControl.invocations !== 0 ||
            typeof negativeControl.dial !== 'function' ||
            typeof negativeControl.close !== 'function'
          ) {
            invalid()
          }
        }
        fingerprints = linkFingerprints(projection)
        codecVectors = createProcessCodecVectors()
        node = makeNode(projection, {
          ...adapters,
          adapter: createProcessFaultAdapter(adapters.adapter || new UdxAdapter(), armedFaults),
          endpointLimits
        })
        send({
          event: CONTROL_EVENT.CONFIGURED,
          role: projection.role,
          state: 'CONFIGURED',
          codecVectors,
          ...runtimeRecord()
        })
        return true
      case CONTROL_COMMAND.START:
        phase = 'transport-start'
        await node.start()
        phase = 'transport-connect'
        await node.connect()
        if (armedRevocation) {
          const digest32 = armedRevocation
          armedRevocation = null
          try {
            node[LIVE_ROUTE_REVOKE_GRANT](digest32)
          } finally {
            digest32.fill(0)
          }
          throw PrivateRouteError.ROUTE_UNAVAILABLE()
        }
        if (armedFaults.delete(CONTROL_FAULT.CLOSE_SOCKET)) {
          await node[LIVE_ROUTE_CLOSE_SOCKET]()
          throw PrivateRouteError.ROUTE_UNAVAILABLE()
        }
        preparedMilestone = prepareRole()
        send({
          ...snapshotEvent(CONTROL_EVENT.PREPARED),
          ...runtimeRecord(),
          codecVectors,
          milestone: preparedMilestone
        })
        return true
      case CONTROL_COMMAND.ACTIVATE:
        {
          const milestone = await establishRole()
          send({
            ...snapshotEvent(CONTROL_EVENT.READY),
            ...runtimeRecord(),
            codecVectors,
            milestone,
            traffic: { ...traffic }
          })
        }
        return true
      case CONTROL_COMMAND.SNAPSHOT:
        send(snapshotEvent(CONTROL_EVENT.SNAPSHOT))
        return true
      case CONTROL_COMMAND.REVOKE:
        if (lifecycle.state === 'CONFIGURED') {
          if (armedRevocation) throw PrivateRouteError.CIRCUIT_STATE()
          armedRevocation = b4a.from(command.grantDigest32)
          return true
        }
        node[LIVE_ROUTE_REVOKE_GRANT](command.grantDigest32)
        send(snapshotEvent(CONTROL_EVENT.SNAPSHOT))
        return true
      case CONTROL_COMMAND.FAULT:
        if (lifecycle.state === 'CONFIGURED') {
          if (
            command.fault !== CONTROL_FAULT.DELAY_CREATED &&
            command.fault !== CONTROL_FAULT.CLOSE_SOCKET &&
            command.fault !== CONTROL_FAULT.SPOOF_SOURCE &&
            command.fault !== CONTROL_FAULT.REPLAY &&
            command.fault !== CONTROL_FAULT.OVERFLOW_QUEUE
          ) {
            throw PrivateRouteError.ROUTE_UNAVAILABLE()
          }
          armedFaults.add(command.fault)
          return true
        }
        if (typeof onFault === 'function') await onFault(command.fault, node, projection)
        else if (command.fault === CONTROL_FAULT.CLOSE_SOCKET) {
          await node[LIVE_ROUTE_CLOSE_SOCKET]()
        } else if (command.fault === CONTROL_FAULT.RETRY) {
          if (projection.role !== 'source' || !negativeControl) invalid()
          send({
            event: CONTROL_EVENT.RETRY,
            role: projection.role,
            code: 'ROUTE_UNAVAILABLE',
            negativeControlInvocations: negativeControl.invocations
          })
          return true
        } else {
          throw PrivateRouteError.ROUTE_UNAVAILABLE()
        }
        send(snapshotEvent(CONTROL_EVENT.SNAPSHOT))
        return true
      case CONTROL_COMMAND.STOP:
        await node.stop()
        await releaseNegativeControl()
        if (armedRevocation) armedRevocation.fill(0)
        armedRevocation = null
        releaseActor()
        clearTree(projection)
        send(snapshotEvent(CONTROL_EVENT.CLOSED))
        return true
      default:
        invalid()
    }
  }

  const handle = (command) => {
    if (command?.command === CONTROL_COMMAND.STOP) {
      const stopping = Promise.resolve().then(() => execute(command))
      void stopping.catch(() => {})
      return stopping
    }
    const result = queue.then(() => execute(command))
    queue = result.catch(() => {})
    return result
  }

  const fail = (error) => {
    if (!projection || lifecycle.state === 'STOPPING' || lifecycle.state === 'CLOSED') return false
    send({
      event: CONTROL_EVENT.ERROR,
      role: projection.role,
      state: node ? node.snapshot().state : 'NEW',
      code: errorCode(error),
      phase
    })
    return true
  }

  const abort = async (error) => {
    try {
      fail(error)
    } catch {}
    if (node) {
      try {
        await node.stop()
      } catch {}
    }
    await releaseNegativeControl()
    if (armedRevocation) armedRevocation.fill(0)
    armedRevocation = null
    releaseActor()
    clearTree(projection)
    return true
  }

  return Object.freeze({ handle, fail, abort })
}

export function runRoleProcess(processRuntime = runtime) {
  if (
    !object(processRuntime) ||
    typeof processRuntime.stdin?.on !== 'function' ||
    typeof processRuntime.stdout?.write !== 'function' ||
    typeof processRuntime.stderr?.write !== 'function' ||
    typeof processRuntime.exit !== 'function'
  ) {
    invalid()
  }
  const decoder = new ControlFrameDecoder()
  let ending = false
  const runner = createRoleRunner({
    emit(record) {
      const frame = encodeControlFrame(record)
      try {
        processRuntime.stdout.write(frame, () => frame.fill(0))
      } catch (err) {
        frame.fill(0)
        throw err
      }
      if (record.event === CONTROL_EVENT.CLOSED) {
        ending = true
        decoder.destroy()
        processRuntime.exit(0)
      }
    }
  })
  const terminate = (error) => {
    if (ending) return
    ending = true
    decoder.destroy()
    void runner.abort(error).finally(() => processRuntime.exit(1))
  }
  processRuntime.stdin.on('data', (chunk) => {
    if (ending) return
    let commands
    let owned = null
    try {
      owned = b4a.from(chunk)
      commands = decoder.push(owned)
    } catch (err) {
      terminate(err)
      return
    } finally {
      if (owned) owned.fill(0)
    }
    for (const command of commands) {
      void runner.handle(command).catch(terminate)
    }
  })
  processRuntime.stdin.on('error', terminate)
  processRuntime.stdin.on('end', () => {
    if (!ending) terminate(PrivateRouteError.ROUTE_UNAVAILABLE())
  })
  return runner
}

if (import.meta.main) runRoleProcess()
