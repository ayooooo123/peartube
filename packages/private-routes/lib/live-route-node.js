import b4a from 'b4a'

import {
  AsyncRouteControlSession,
  abortAsyncRouteControlSessionAfterTransportLoss
} from './async-route-control-session.js'
import { BootstrapEnvelopeCodec } from './bootstrap-envelope.js'
import {
  createCompiledRouteDuplex,
  failCompiledRouteDuplex,
  mintCompiledRouteReady,
  receiveCompiledRouteCell
} from './compiled-route-duplex.js'
import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { createLinkSetupAuthority } from './link-setup.js'
import {
  CELL_CLASS,
  DIRECTION,
  LINK_OPERATION,
  PROTOCOL_VERSION,
  TOPOLOGY_ROLE
} from './protocol.js'
import { RemoteActorHost, forwardRemoteActorHost } from './remote-actor-host.js'
import {
  CIRCUIT_DESTROY_REASON,
  RemoteControlFragmentCodec,
  RemoteControlMux,
  createRemoteActorControlBoundary
} from './remote-control.js'
import {
  ROUTE_ENDPOINT,
  RoutePayloadCodec,
  mintCreatedRoutePayloadContext
} from './route-payload.js'
import { LinkDirectory, decodeTopologyGrant } from './topology-grant.js'
import {
  UDX_LINK_DESTROY_CIRCUIT,
  UDX_SEND_ACTOR_CONTROL,
  UDX_TRY_SEND_CELL
} from './udx-adapter.js'
import { UdxCellEndpoint } from './udx-cell-endpoint.js'

export const LIVE_ROUTE_CREATE_CONTROL = Symbol('live-route-create-control')
export const LIVE_ROUTE_ACTIVATE_ENDPOINT = Symbol('live-route-activate-endpoint')
export const LIVE_ROUTE_REGISTER_ACTOR = Symbol('live-route-register-actor')
export const LIVE_ROUTE_FORWARD_ACTOR = Symbol('live-route-forward-actor')
export const LIVE_ROUTE_REVOKE_GRANT = Symbol('live-route-revoke-grant')
export const LIVE_ROUTE_CLOSE_SOCKET = Symbol('live-route-close-socket')
export const LIVE_ROUTE_FAIL_ROUTE = Symbol('live-route-fail-route')

const ROLE_BINDINGS = Object.freeze({
  source: TOPOLOGY_ROLE.SOURCE,
  'safety-guard': TOPOLOGY_ROLE.SAFETY_GUARD,
  'safety-final': TOPOLOGY_ROLE.SAFETY_FINAL,
  'private-entry': TOPOLOGY_ROLE.PRIVATE_ENTRY,
  'private-middle': TOPOLOGY_ROLE.PRIVATE_MIDDLE,
  'private-final': TOPOLOGY_ROLE.PRIVATE_FINAL,
  destination: TOPOLOGY_ROLE.DESTINATION
})

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function stateError() {
  return PrivateRouteError.CIRCUIT_STATE()
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fixed(value, size) {
  return b4a.isBuffer(value) && value.byteLength === size
}

function validateProjection(value) {
  if (
    !isObject(value) ||
    value.version !== PROTOCOL_VERSION ||
    ROLE_BINDINGS[value.role] === undefined ||
    value.topologyRole !== ROLE_BINDINGS[value.role] ||
    !isObject(value.bind) ||
    typeof value.bind.host !== 'string' ||
    !Number.isInteger(value.bind.port) ||
    value.bind.port < 1 ||
    value.bind.port > 65_535 ||
    !isObject(value.local) ||
    !fixed(value.local.identity32, 32) ||
    !fixed(value.local.identitySecretKey, 64) ||
    !fixed(value.linkAuthorityPublicKey, 32) ||
    typeof value.epoch !== 'bigint' ||
    !fixed(value.runId32, 32) ||
    !fixed(value.linkCircuitId, 16) ||
    !Array.isArray(value.grants) ||
    value.grants.length < 1 ||
    value.grants.length > 2 ||
    !Array.isArray(value.contacts) ||
    value.contacts.length !== value.grants.length
  ) {
    invalid()
  }
  return value
}

function validateAdapters(value) {
  if (
    !isObject(value) ||
    typeof value.now !== 'function' ||
    typeof value.schedule !== 'function' ||
    typeof value.cancel !== 'function' ||
    typeof value.randomBytes !== 'function' ||
    (value.endpointLimits !== undefined && !isObject(value.endpointLimits)) ||
    (value.observe !== undefined && typeof value.observe !== 'function')
  ) {
    invalid()
  }
  return value
}

function grantView(encoding, localIdentity32) {
  const grant = decodeTopologyGrant(encoding)
  if (b4a.equals(grant.endpointA.identity32, localIdentity32)) {
    return { local: grant.endpointA, peer: grant.endpointB }
  }
  if (b4a.equals(grant.endpointB.identity32, localIdentity32)) {
    return { local: grant.endpointB, peer: grant.endpointA }
  }
  invalid()
}

function deriveLinkId(digest32, label) {
  const digest = cryptoSuite.hash([b4a.from(label), digest32])
  const value = b4a.from(digest.subarray(0, 16))
  b4a.fill(digest, 0)
  let nonzero = false
  for (const byte of value) nonzero = nonzero || byte !== 0
  if (!nonzero) value[15] = 1
  return value
}

function payloadProjection(projection) {
  const value = projection.route && projection.route.payload
  if (
    !isObject(value) ||
    !fixed(value.descriptorId, 32) ||
    !fixed(value.circuitId, 16) ||
    !fixed(value.forwardKey, 32) ||
    !fixed(value.forwardNoncePrefix, 16) ||
    !fixed(value.reverseKey, 32) ||
    !fixed(value.reverseNoncePrefix, 16) ||
    !b4a.equals(value.circuitId, projection.linkCircuitId)
  ) {
    invalid()
  }
  return value
}

export function createLiveRouteNode(roleProjection, adapters) {
  const projection = validateProjection(roleProjection)
  const runtime = validateAdapters(adapters)
  const observe = runtime.observe || null
  const ownedTimers = new Set()
  const handles = []
  const links = []
  const linksBySendHandle = new Map()
  const controls = new Set()
  const actorMux = new RemoteControlMux()
  let state = 'NEW'
  let directory = null
  let endpoint = null
  let duplex = null
  let compiledDuplex = null
  let bound = false
  let connecting = null
  let stopping = null
  let failing = null

  const schedule = (callback, delay) => {
    let handle = null
    const wrapped = () => {
      ownedTimers.delete(handle)
      callback()
    }
    handle = runtime.schedule(wrapped, delay)
    ownedTimers.add(handle)
    return handle
  }
  const cancel = (handle) => {
    ownedTimers.delete(handle)
    return runtime.cancel(handle)
  }
  const actorSchedule = (delay, callback) => schedule(callback, delay)

  const destroyReason = (reason) => {
    if (reason === 'ACK_TIMEOUT' || reason === CIRCUIT_DESTROY_REASON.ACK_TIMEOUT) {
      return CIRCUIT_DESTROY_REASON.ACK_TIMEOUT
    }
    if (reason === 'REVOKED' || reason === CIRCUIT_DESTROY_REASON.REVOKED) {
      return CIRCUIT_DESTROY_REASON.REVOKED
    }
    if (reason === 'EXPIRED' || reason === CIRCUIT_DESTROY_REASON.EXPIRED) {
      return CIRCUIT_DESTROY_REASON.EXPIRED
    }
    return CIRCUIT_DESTROY_REASON.TRANSPORT_LOST
  }

  const failRoute = (failedHandle, reason = CIRCUIT_DESTROY_REASON.TRANSPORT_LOST) => {
    if (failing) return failing
    if (state === 'CLOSING' || state === 'CLOSED') return stopping || Promise.resolve(true)
    let resolveFailure
    let rejectFailure
    failing = new Promise((resolve, reject) => {
      resolveFailure = resolve
      rejectFailure = reject
    })
    state = 'FAILED'
    if (compiledDuplex) {
      try {
        failCompiledRouteDuplex(compiledDuplex)
      } catch {}
    }
    emit()
    const propagations = []
    for (const control of controls) {
      try {
        propagations.push(abortAsyncRouteControlSessionAfterTransportLoss(control))
      } catch {}
    }
    controls.clear()
    for (const record of links) {
      if (record.sendHandle === failedHandle) continue
      try {
        propagations.push(
          endpoint[UDX_LINK_DESTROY_CIRCUIT](record.sendHandle, destroyReason(reason))
        )
      } catch {}
    }
    Promise.allSettled(propagations)
      .then(() => node.stop())
      .then(resolveFailure, rejectFailure)
    return failing
  }

  const failActorControl = (failedHandle, error) => {
    let limited = false
    try {
      limited = error && error.code === 'CIRCUIT_LIMIT'
    } catch {}
    void failRoute(
      limited ? null : failedHandle,
      limited ? CIRCUIT_DESTROY_REASON.ACK_TIMEOUT : CIRCUIT_DESTROY_REASON.TRANSPORT_LOST
    )
  }

  const initializeActorEndpoint = (record) => {
    const privateRole = projection.role.startsWith('private-')
    const client = record.mode === 'initiate' && (projection.role === 'source' || privateRole)
    const server = record.mode === 'accept' && (privateRole || projection.role === 'destination')
    if (!client && !server) return
    const boundary = createRemoteActorControlBoundary({
      link: record,
      epoch: projection.epoch,
      circuitId: projection.linkCircuitId,
      now: runtime.now,
      schedule: actorSchedule,
      cancel
    })
    const sender = new RemoteControlFragmentCodec({
      now: runtime.now,
      schedule: actorSchedule,
      cancel
    })
    const host = new RemoteActorHost({
      control: boundary.consumer,
      sendControl(message) {
        let messageId = null
        let frames = null
        try {
          messageId = runtime.randomBytes(16)
          frames = sender.fragment(message, { messageId })
          for (const frame of frames) {
            const sending = endpoint[UDX_SEND_ACTOR_CONTROL](record.sendHandle, frame)
            void sending.catch((err) => failActorControl(record.sendHandle, err))
          }
          return true
        } catch (err) {
          failActorControl(record.sendHandle, err)
          return false
        } finally {
          if (messageId) b4a.fill(messageId, 0)
          if (frames) for (const frame of frames) b4a.fill(frame, 0)
        }
      },
      now: runtime.now,
      randomBytes: runtime.randomBytes,
      schedule: actorSchedule,
      cancel
    })
    record.actorEndpoint = { boundary, sender, host, kind: client ? 'client' : 'server' }
  }

  const activateEndpoint = () => {
    if (compiledDuplex) return duplex
    if (state !== 'OPEN' || (projection.role !== 'source' && projection.role !== 'destination')) {
      throw stateError()
    }
    const fields = payloadProjection(projection)
    const endpointRole =
      projection.role === 'source' ? ROUTE_ENDPOINT.SOURCE : ROUTE_ENDPOINT.DESTINATION
    const routePayload = new RoutePayloadCodec({
      crypto: cryptoSuite,
      context: mintCreatedRoutePayloadContext({ ...fields, endpointRole }),
      window: 64,
      gapTimeout: 5_000,
      now: runtime.now,
      padding: (size) => b4a.alloc(size)
    })
    const ready = mintCompiledRouteReady({
      endpoint,
      handle: links[0].sendHandle,
      routePayload,
      generation: 1n,
      direction: projection.role === 'source' ? DIRECTION.FORWARD : DIRECTION.REVERSE,
      circuitContext: Object.freeze({})
    })
    compiledDuplex = createCompiledRouteDuplex({ ready, schedule, cancel })
    return duplex
  }

  const deferredDuplex = () =>
    Object.freeze({
      write(payload) {
        if (!compiledDuplex) throw stateError()
        return compiledDuplex.write(payload)
      },
      read() {
        if (!compiledDuplex) throw stateError()
        return compiledDuplex.read()
      },
      sendDatagram(payload) {
        if (!compiledDuplex) throw stateError()
        return compiledDuplex.sendDatagram(payload)
      },
      receiveDatagram() {
        if (!compiledDuplex) throw stateError()
        return compiledDuplex.receiveDatagram()
      },
      drain() {
        if (!compiledDuplex) return Promise.reject(stateError())
        return compiledDuplex.drain()
      },
      destroy() {
        return compiledDuplex ? compiledDuplex.destroy() : Promise.resolve(true)
      }
    })

  const snapshot = () =>
    Object.freeze({
      role: projection.role,
      state,
      links: links.reduce((count, record) => {
        try {
          return count + (record.session.state === 'OPEN' ? 1 : 0)
        } catch {
          return count
        }
      }, 0),
      counters: Object.freeze({
        queuedPackets: endpoint ? endpoint.queuedPackets : 0,
        queuedBytes: endpoint ? endpoint.queuedBytes : 0,
        inFlightSends: endpoint ? endpoint.inFlightSends : 0
      }),
      resources: Object.freeze({
        bindings: handles.length,
        waits:
          links.reduce((count, record) => {
            try {
              const actor = record.actorEndpoint?.host.stats
              return count + record.session.pending + (actor ? actor.pending + actor.inbound : 0)
            } catch {
              return count
            }
          }, 0) +
          Array.from(controls, (control) => {
            try {
              return control.stats.waits
            } catch {
              return 0
            }
          }).reduce((total, count) => total + count, 0),
        timers: ownedTimers.size,
        openSockets: bound ? 1 : 0
      })
    })

  const emit = () => {
    if (!observe) return
    try {
      observe(snapshot())
    } catch {}
  }

  const node = Object.freeze({
    async start() {
      if (state !== 'NEW') throw stateError()
      state = 'STARTING'
      try {
        directory = new LinkDirectory({
          localIdentity32: projection.local.identity32,
          localRole: projection.topologyRole,
          authorityPublicKey: projection.linkAuthorityPublicKey,
          epoch: projection.epoch,
          runId32: projection.runId32,
          now: () => BigInt(runtime.now()),
          schedule,
          cancel,
          onClose() {},
          onError() {}
        })
        endpoint = new UdxCellEndpoint({
          ...(runtime.adapter === undefined ? {} : { adapter: runtime.adapter }),
          ...(runtime.endpointLimits === undefined
            ? {}
            : {
                maxQueuedPackets: runtime.endpointLimits.maxQueuedPackets,
                maxQueuedBytes: runtime.endpointLimits.maxQueuedBytes
              }),
          host: projection.bind.host,
          port: projection.bind.port,
          onBootstrap(packet, sendHandle) {
            const record = linksBySendHandle.get(sendHandle)
            return record ? record.session.receive(packet) : false
          },
          onCell(payload, sendHandle, metadata) {
            const incoming = linksBySendHandle.get(sendHandle)
            if (incoming && isObject(metadata) && metadata.generation === 0n) {
              if (incoming.actorEndpoint) {
                let muxed = null
                try {
                  muxed = actorMux.encodeActorFragment(payload)
                  const event = incoming.actorEndpoint.boundary.pushAuthenticated(muxed, {
                    link: incoming,
                    epoch: projection.epoch,
                    direction: metadata.direction,
                    circuitId: projection.linkCircuitId
                  })
                  if (!event) return true
                  const receiving = incoming.actorEndpoint.host.receiveAuthenticated(event)
                  void receiving.catch((err) => failActorControl(null, err))
                  return true
                } catch (err) {
                  failActorControl(null, err)
                  return false
                } finally {
                  if (muxed) b4a.fill(muxed, 0)
                }
              }
              const outgoing = links.find(
                (record) =>
                  record.sendHandle !== sendHandle && record.sendDirection === metadata.direction
              )
              if (!outgoing) return false
              let sending
              try {
                sending = endpoint[UDX_SEND_ACTOR_CONTROL](outgoing.sendHandle, payload)
              } catch (err) {
                failActorControl(outgoing.sendHandle, err)
                return false
              }
              void sending.catch((err) => failActorControl(outgoing.sendHandle, err))
              return true
            }
            if (
              compiledDuplex &&
              (projection.role === 'source' || projection.role === 'destination')
            ) {
              return receiveCompiledRouteCell(compiledDuplex, sendHandle, payload, metadata)
            }
            if (
              projection.role === 'source' ||
              projection.role === 'destination' ||
              !isObject(metadata) ||
              (metadata.class !== CELL_CLASS.STREAM && metadata.class !== CELL_CLASS.DATAGRAM) ||
              (metadata.direction !== DIRECTION.FORWARD &&
                metadata.direction !== DIRECTION.REVERSE) ||
              typeof metadata.generation !== 'bigint'
            ) {
              return false
            }
            const outgoing = links.find(
              (record) =>
                record.sendHandle !== sendHandle && record.sendDirection === metadata.direction
            )
            if (!outgoing) return false
            let admitted = null
            try {
              admitted = endpoint[UDX_TRY_SEND_CELL](outgoing.sendHandle, {
                class: metadata.class,
                direction: metadata.direction,
                generation: metadata.generation,
                payload
              })
            } catch {
              return false
            }
            if (!admitted) {
              void failRoute(outgoing.sendHandle, CIRCUIT_DESTROY_REASON.ACK_TIMEOUT)
              return false
            }
            void admitted.sending.catch(() => {
              void failRoute(outgoing.sendHandle, CIRCUIT_DESTROY_REASON.TRANSPORT_LOST)
            })
            return true
          },
          onLinkFailure(handle, _direction, reason) {
            void failRoute(handle, reason)
          }
        })
        await endpoint.bind()
        bound = true
        for (const encoding of projection.grants) {
          const view = grantView(encoding, projection.local.identity32)
          const decoded = decodeTopologyGrant(encoding)
          const digest32 = directory.add(encoding)
          const handle = directory.authorize({
            digest32,
            operation:
              view.local.operations === LINK_OPERATION.INITIATE
                ? LINK_OPERATION.INITIATE
                : LINK_OPERATION.ACCEPT,
            localIdentity32: projection.local.identity32,
            localRole: projection.topologyRole,
            peerIdentity32: view.peer.identity32,
            peerRole: view.peer.role,
            epoch: projection.epoch,
            runId32: projection.runId32
          })
          handles.push(handle)
          const initiator =
            (decoded.endpointA.operations & LINK_OPERATION.INITIATE) === LINK_OPERATION.INITIATE
              ? decoded.endpointA
              : decoded.endpointB
          const responder = initiator === decoded.endpointA ? decoded.endpointB : decoded.endpointA
          const mode = b4a.equals(projection.local.identity32, initiator.identity32)
            ? 'initiate'
            : 'accept'
          const contact = projection.contacts.find((value) =>
            b4a.equals(value.identity32, responder.identity32)
          )
          if (
            (mode === 'initiate' && (!contact || !fixed(contact.routeEncryptionKey, 32))) ||
            (mode === 'accept' && !fixed(projection.local.routeEncryptionSecretKey, 32))
          ) {
            b4a.fill(digest32, 0)
            invalid()
          }
          const circuitId = b4a.from(projection.linkCircuitId)
          const initiatorLocalId = deriveLinkId(digest32, 'live-route-link-initiator')
          const responderLocalId = deriveLinkId(digest32, 'live-route-link-responder')
          const common = {
            circuitId,
            epoch: projection.epoch,
            initiatorIdentity: initiator.identity32,
            responderIdentity: responder.identity32,
            initiatorLocalId,
            responderLocalId,
            expiresAt: decoded.expiresAt
          }
          const sendHandle = endpoint.openLink(handle)
          let session = null
          try {
            session = endpoint.openLink(handle, {
              mode,
              codec: new BootstrapEnvelopeCodec({
                linkHandle: handle,
                localIdentitySecretKey: projection.local.identitySecretKey,
                padding: runtime.randomBytes
              }),
              linkSetup: createLinkSetupAuthority({
                now: runtime.now,
                randomBytes: runtime.randomBytes
              }),
              setup:
                mode === 'initiate'
                  ? {
                      ...common,
                      responderStaticKey: contact.routeEncryptionKey,
                      initiatorIdentitySecretKey: projection.local.identitySecretKey
                    }
                  : {
                      ...common,
                      responderStaticSecretKey: projection.local.routeEncryptionSecretKey,
                      responderIdentitySecretKey: projection.local.identitySecretKey
                    },
              now: runtime.now,
              schedule,
              cancel,
              randomBytes: runtime.randomBytes
            })
          } finally {
            b4a.fill(circuitId, 0)
            b4a.fill(initiatorLocalId, 0)
            b4a.fill(responderLocalId, 0)
            b4a.fill(digest32, 0)
          }
          const record = {
            mode,
            sendDirection: mode === 'initiate' ? DIRECTION.FORWARD : DIRECTION.REVERSE,
            sendHandle,
            session,
            opened: null,
            actorEndpoint: null
          }
          links.push(record)
          linksBySendHandle.set(sendHandle, record)
        }
        state = 'READY'
        emit()
        return true
      } catch (err) {
        try {
          await node.stop()
        } catch {}
        throw err instanceof PrivateRouteError ? err : PrivateRouteError.ROUTE_UNAVAILABLE()
      }
    },
    connect() {
      if (state === 'OPEN') return Promise.resolve(true)
      if (state !== 'READY' && state !== 'CONNECTING') return Promise.reject(stateError())
      if (connecting) return connecting
      state = 'CONNECTING'
      connecting = (async () => {
        const opened = []
        for (const record of links) {
          if (record.mode !== 'initiate') continue
          record.opened = record.session.open()
          opened.push(record.opened)
        }
        await Promise.all(opened)
        const deadline = Number(runtime.now()) + 5_000
        for (;;) {
          let ready = true
          for (const record of links) {
            if (record.session.state !== 'OPEN') ready = false
          }
          if (ready) break
          if (Number(runtime.now()) >= deadline) throw PrivateRouteError.ROUTE_UNAVAILABLE()
          await new Promise((resolve) => schedule(resolve, 1))
        }
        for (const record of links) initializeActorEndpoint(record)
        state = 'OPEN'
        if (projection.role === 'source' || projection.role === 'destination') {
          duplex = deferredDuplex()
        }
        emit()
        return duplex || true
      })().catch(async (err) => {
        if (state !== 'CLOSING' && state !== 'CLOSED') state = 'FAILED'
        emit()
        try {
          await node.stop()
        } catch {}
        throw err instanceof PrivateRouteError ? err : PrivateRouteError.ROUTE_UNAVAILABLE()
      })
      return connecting
    },
    [LIVE_ROUTE_ACTIVATE_ENDPOINT]() {
      return activateEndpoint()
    },
    [LIVE_ROUTE_CREATE_CONTROL](actorId) {
      if (state !== 'OPEN') throw stateError()
      const record = links.find((value) => value.actorEndpoint?.kind === 'client')
      if (!record) throw PrivateRouteError.UNAUTHORIZED()
      const control = new AsyncRouteControlSession({
        remote: record.actorEndpoint.host,
        actorId,
        now: runtime.now
      })
      controls.add(control)
      return control
    },
    [LIVE_ROUTE_REGISTER_ACTOR](actorId, actor) {
      if (state !== 'OPEN') throw stateError()
      const record = links.find((value) => value.actorEndpoint?.kind === 'server')
      if (!record) throw PrivateRouteError.UNAUTHORIZED()
      return record.actorEndpoint.host.register(actorId, actor)
    },
    [LIVE_ROUTE_FORWARD_ACTOR](kind, actorId, circuitId, generation, body) {
      if (state !== 'OPEN') return Promise.reject(stateError())
      const record = links.find((value) => value.actorEndpoint?.kind === 'client')
      if (!record) return Promise.reject(PrivateRouteError.UNAUTHORIZED())
      return forwardRemoteActorHost(
        record.actorEndpoint.host,
        kind,
        actorId,
        circuitId,
        generation,
        body
      )
    },
    [LIVE_ROUTE_REVOKE_GRANT](digest32) {
      if (state !== 'OPEN' || !directory) throw stateError()
      directory.revoke({ digest32, epoch: projection.epoch, runId32: projection.runId32 })
      if (compiledDuplex) {
        try {
          failCompiledRouteDuplex(compiledDuplex)
        } catch {}
      }
      state = 'FAILED'
      emit()
      return true
    },
    [LIVE_ROUTE_FAIL_ROUTE](reason = CIRCUIT_DESTROY_REASON.TRANSPORT_LOST) {
      return failRoute(null, reason)
    },
    async [LIVE_ROUTE_CLOSE_SOCKET]() {
      if (state !== 'OPEN' || !endpoint) throw stateError()
      if (compiledDuplex) {
        try {
          failCompiledRouteDuplex(compiledDuplex)
        } catch {}
      }
      state = 'FAILED'
      emit()
      await endpoint.close()
      bound = false
      emit()
      return true
    },
    snapshot,
    stop() {
      if (stopping) return stopping
      stopping = (async () => {
        if (state === 'CLOSED') return true
        state = 'CLOSING'
        if (compiledDuplex) {
          try {
            await compiledDuplex.destroy()
          } catch {}
          compiledDuplex = null
        }
        duplex = null
        await Promise.allSettled(Array.from(controls, (control) => control.stop()))
        controls.clear()
        for (const record of links) {
          const actorEndpoint = record.actorEndpoint
          record.actorEndpoint = null
          if (!actorEndpoint) continue
          try {
            actorEndpoint.host.destroy()
          } catch {}
          try {
            actorEndpoint.sender.destroy()
          } catch {}
          try {
            actorEndpoint.boundary.destroy()
          } catch {}
        }
        await Promise.allSettled(links.map((record) => record.session.close()))
        linksBySendHandle.clear()
        links.length = 0
        if (endpoint) {
          try {
            await endpoint.close()
          } catch {}
        }
        bound = false
        if (directory) {
          try {
            directory.destroy()
          } catch {}
        }
        handles.length = 0
        for (const timer of Array.from(ownedTimers)) {
          try {
            cancel(timer)
          } catch {}
        }
        endpoint = null
        directory = null
        state = 'CLOSED'
        emit()
        return true
      })()
      return stopping
    }
  })
  return node
}
