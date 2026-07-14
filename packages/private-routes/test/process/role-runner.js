import b4a from 'b4a'

import { PrivateRouteError, createLiveRouteNode, cryptoSuite } from '../../index.js'
import { LIVE_ROUTE_CLOSE_SOCKET, LIVE_ROUTE_REVOKE_GRANT } from '../../lib/live-route-node.js'
import runtime from '#private-route-process'
import {
  CONTROL_COMMAND,
  CONTROL_EVENT,
  CONTROL_FAULT,
  ControlFrameDecoder,
  ControlLifecycle,
  encodeControlFrame
} from './control-channel.js'

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

export function createRoleRunner(options = {}) {
  if (!object(options) || typeof options.emit !== 'function') invalid()
  const makeNode = options.createNode || createLiveRouteNode
  if (typeof makeNode !== 'function') invalid()
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
  let queue = Promise.resolve()

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
        fingerprints = linkFingerprints(projection)
        node = makeNode(projection, adapters)
        send({
          event: CONTROL_EVENT.CONFIGURED,
          role: projection.role,
          state: 'CONFIGURED',
          ...runtimeRecord()
        })
        return true
      case CONTROL_COMMAND.START:
        await node.start()
        await node.connect()
        send({ ...snapshotEvent(CONTROL_EVENT.READY), ...runtimeRecord() })
        return true
      case CONTROL_COMMAND.SNAPSHOT:
        send(snapshotEvent(CONTROL_EVENT.SNAPSHOT))
        return true
      case CONTROL_COMMAND.REVOKE:
        node[LIVE_ROUTE_REVOKE_GRANT](command.grantDigest32)
        send(snapshotEvent(CONTROL_EVENT.SNAPSHOT))
        return true
      case CONTROL_COMMAND.FAULT:
        if (typeof onFault === 'function') await onFault(command.fault, node, projection)
        else if (command.fault === CONTROL_FAULT.CLOSE_SOCKET) {
          await node[LIVE_ROUTE_CLOSE_SOCKET]()
        } else {
          throw PrivateRouteError.ROUTE_UNAVAILABLE()
        }
        send(snapshotEvent(CONTROL_EVENT.SNAPSHOT))
        return true
      case CONTROL_COMMAND.STOP:
        await node.stop()
        send(snapshotEvent(CONTROL_EVENT.CLOSED))
        return true
      default:
        invalid()
    }
  }

  const handle = (command) => {
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
      code: errorCode(error)
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
