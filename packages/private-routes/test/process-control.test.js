import test from 'brittle'
import b4a from 'b4a'

import {
  CONTROL_BODY_MAX,
  CONTROL_COMMAND,
  CONTROL_EVENT,
  ControlFrameDecoder,
  ControlLifecycle,
  decodeCanonical,
  encodeCanonical,
  encodeControlFrame,
  validateControlCommand
} from './process/control-channel.js'
import { createProcessFaultAdapter, createRoleRunner } from './process/role-runner.js'
import processRuntime from '#private-route-process'
import { LIVE_ROUTE_CLOSE_SOCKET, LIVE_ROUTE_REVOKE_GRANT } from '../lib/live-route-node.js'

function code(run) {
  try {
    run()
    return null
  } catch (err) {
    return err && err.message
  }
}

test('process control frames use canonical tagged JSON and a four-byte length', (t) => {
  const value = {
    command: CONTROL_COMMAND.CONFIGURE,
    projection: { epoch: 23n, identity: b4a.from([1, 2, 3]), role: 'source' }
  }
  const body = encodeCanonical(value)
  const frame = encodeControlFrame(value)
  t.is(frame.byteLength, body.byteLength + 4)
  t.alike(frame.subarray(0, 4), b4a.from([0, 0, 0, body.byteLength]))
  t.alike(frame.subarray(4), body)
  t.alike(decodeCanonical(body), value)
  t.is(
    b4a.toString(body),
    '{"command":"configure","projection":{"epoch":{"$bigint":"23"},"identity":{"$bytes":"010203"},"role":"source"}}'
  )
  body.fill(0)
  frame.fill(0)
})

test('streaming decoder accepts split and coalesced frames without unbounded buffering', (t) => {
  const first = encodeControlFrame({ command: CONTROL_COMMAND.START })
  const second = encodeControlFrame({ command: CONTROL_COMMAND.SNAPSHOT })
  const decoder = new ControlFrameDecoder()
  t.alike(decoder.push(first.subarray(0, 2)), [])
  t.alike(decoder.push(first.subarray(2, 9)), [])
  t.alike(decoder.push(b4a.concat([first.subarray(9), second])), [
    { command: CONTROL_COMMAND.START },
    { command: CONTROL_COMMAND.SNAPSHOT }
  ])
  t.is(decoder.destroy(), true)
  t.is(decoder.destroy(), false)
  first.fill(0)
  second.fill(0)
})

test('decoder rejects oversize, malformed, and noncanonical frames', (t) => {
  const oversize = b4a.from([0, 1, 0, 1])
  t.ok(code(() => new ControlFrameDecoder().push(oversize)))
  const malformed = b4a.concat([b4a.from([0, 0, 0, 1]), b4a.from('{')])
  t.ok(code(() => new ControlFrameDecoder().push(malformed)))
  const noncanonicalBody = b4a.from('{"z":1,"a":2}')
  const noncanonical = b4a.alloc(4 + noncanonicalBody.byteLength)
  noncanonical[3] = noncanonicalBody.byteLength
  noncanonical.set(noncanonicalBody, 4)
  t.ok(code(() => new ControlFrameDecoder().push(noncanonical)))
  t.ok(code(() => encodeCanonical({ value: Number.MAX_SAFE_INTEGER + 1 })))
  t.ok(code(() => encodeCanonical({ value: -0 })))
  t.ok(code(() => encodeCanonical({ value: 'bad\ud800' })))
  t.ok(code(() => encodeCanonical({ __proto__: null, $bytes: '00' })))
  t.ok(code(() => encodeCanonical(b4a.alloc(CONTROL_BODY_MAX))))
})

test('command vocabulary and lifecycle are exact and closed is terminal', (t) => {
  t.alike(Object.values(CONTROL_COMMAND), [
    'configure',
    'start',
    'activate',
    'fault',
    'revoke',
    'snapshot',
    'stop'
  ])
  t.alike(Object.values(CONTROL_EVENT), [
    'configured',
    'prepared',
    'ready',
    'retry',
    'snapshot',
    'closed',
    'error'
  ])
  t.ok(code(() => validateControlCommand({ command: 'unknown' })))
  t.ok(code(() => validateControlCommand({ command: 'start', extra: true })))

  const lifecycle = new ControlLifecycle()
  t.ok(code(() => lifecycle.emit({ event: 'configured' })))
  t.is(lifecycle.accept({ command: 'configure', projection: { role: 'source' } }), 'configure')
  t.is(lifecycle.emit({ event: 'configured' }), 'configured')
  t.ok(code(() => lifecycle.accept({ command: 'configure', projection: {} })))
  t.is(lifecycle.accept({ command: 'fault', fault: 'delay-created' }), 'fault')
  t.is(lifecycle.accept({ command: 'revoke', grantDigest32: b4a.alloc(32) }), 'revoke')
  t.is(lifecycle.state, 'CONFIGURED')
  t.is(lifecycle.accept({ command: 'start' }), 'start')
  t.ok(code(() => lifecycle.emit({ event: 'ready' })))
  t.is(lifecycle.emit({ event: 'prepared' }), 'prepared')
  t.is(lifecycle.accept({ command: 'activate' }), 'activate')
  t.is(lifecycle.emit({ event: 'ready' }), 'ready')
  t.is(lifecycle.accept({ command: 'snapshot' }), 'snapshot')
  t.is(lifecycle.emit({ event: 'snapshot' }), 'snapshot')
  t.is(lifecycle.accept({ command: 'stop' }), 'stop')
  t.ok(code(() => lifecycle.accept({ command: 'snapshot' })))
  t.ok(code(() => lifecycle.emit({ event: 'snapshot' })))
  t.is(lifecycle.emit({ event: 'closed' }), 'closed')
  t.ok(code(() => lifecycle.emit({ event: 'closed' })))
  t.is(lifecycle.state, 'CLOSED')
})

test('runtime-conditioned adapter exposes only byte channels and exit', (t) => {
  t.alike(Object.keys(processRuntime).sort(), ['exit', 'stderr', 'stdin', 'stdout'])
  t.is(typeof processRuntime.stdin.on, 'function')
  t.is(typeof processRuntime.stdout.write, 'function')
  t.is(typeof processRuntime.stderr.write, 'function')
  t.is(typeof processRuntime.exit, 'function')
})

test('role runner configures once, serializes commands, and emits one terminal closed event', async (t) => {
  const events = []
  const calls = []
  let state = 'NEW'
  const projection = {
    role: 'source',
    grants: [b4a.alloc(32, 1)],
    local: { identity32: b4a.alloc(32, 2) }
  }
  const runner = createRoleRunner({
    emit: (event) => events.push(event),
    createNode() {
      return {
        async start() {
          calls.push('start')
          state = 'READY'
        },
        async connect() {
          calls.push('connect')
          state = 'OPEN'
        },
        snapshot() {
          return {
            role: 'source',
            state,
            links: state === 'OPEN' ? 1 : 0,
            counters: { queuedPackets: 0, queuedBytes: 0, inFlightSends: 0 },
            resources: {
              bindings: state === 'CLOSED' ? 0 : 1,
              waits: 0,
              timers: 0,
              openSockets: state === 'CLOSED' ? 0 : 1
            }
          }
        },
        async stop() {
          calls.push('stop')
          state = 'CLOSED'
        },
        [LIVE_ROUTE_REVOKE_GRANT](digest32) {
          calls.push(`revoke:${digest32[0]}`)
          state = 'FAILED'
        },
        async [LIVE_ROUTE_CLOSE_SOCKET]() {
          calls.push('close-socket')
          state = 'FAILED'
        }
      }
    }
  })
  await runner.handle({ command: 'configure', projection })
  let duplicate = null
  try {
    await runner.handle({ command: 'configure', projection })
  } catch (err) {
    duplicate = err
  }
  t.ok(duplicate)
  await runner.handle({ command: 'start' })
  t.alike(
    events.map((event) => event.event),
    ['configured', 'prepared'],
    'START stops at the actor-readiness barrier'
  )
  await runner.handle({ command: 'activate' })
  await runner.handle({ command: 'snapshot' })
  await runner.handle({ command: 'revoke', grantDigest32: b4a.alloc(32, 7) })
  await runner.handle({ command: 'fault', fault: 'close-socket' })
  await runner.handle({ command: 'stop' })
  let afterStop = null
  try {
    await runner.handle({ command: 'snapshot' })
  } catch (err) {
    afterStop = err
  }
  t.ok(afterStop)
  t.alike(calls, ['start', 'connect', 'revoke:7', 'close-socket', 'stop'])
  t.alike(
    events.map((event) => event.event),
    ['configured', 'prepared', 'ready', 'snapshot', 'snapshot', 'snapshot', 'closed']
  )
  t.is(events.filter((event) => event.event === 'closed').length, 1)
  t.alike(events.at(-1).resources, {
    bindings: 0,
    waits: 0,
    timers: 0,
    openSockets: 0
  })
})

test('role runner snapshots READY only after activation establishment settles', async (t) => {
  const order = []
  const projection = {
    role: 'source',
    grants: [b4a.alloc(32, 1)],
    local: { identity32: b4a.alloc(32, 2) },
    get route() {
      order.push('establish')
      return undefined
    }
  }
  const runner = createRoleRunner({
    emit() {},
    createNode() {
      return {
        async start() {},
        async connect() {},
        snapshot() {
          order.push('snapshot')
          return {
            role: 'source',
            state: 'OPEN',
            links: 1,
            counters: { queuedPackets: 0, queuedBytes: 0, inFlightSends: 0 },
            resources: { bindings: 1, waits: 0, timers: 0, openSockets: 1 }
          }
        }
      }
    }
  })
  await runner.handle({ command: 'configure', projection })
  await runner.handle({ command: 'start' })
  order.length = 0
  await runner.handle({ command: 'activate' })
  t.alike(order, ['establish', 'snapshot'])
})

test('role runner clears every configured buffer before CLOSED is observable', async (t) => {
  const secret = b4a.alloc(64, 0xa7)
  const nested = b4a.alloc(32, 0xb8)
  const projection = {
    role: 'safety-guard',
    grants: [b4a.alloc(32, 1)],
    local: { identity32: b4a.alloc(32, 2), identitySecretKey: secret },
    route: { nested }
  }
  const events = []
  const runner = createRoleRunner({
    emit(event) {
      if (event.event === 'closed') {
        t.ok(
          secret.every((value) => value === 0),
          'identity secret cleared before CLOSED'
        )
        t.ok(
          nested.every((value) => value === 0),
          'nested route secret cleared before CLOSED'
        )
        t.ok(
          projection.grants[0].every((value) => value === 0),
          'serialized grant copy cleared before CLOSED'
        )
      }
      events.push(event)
    },
    createNode() {
      let state = 'NEW'
      return {
        async start() {
          state = 'READY'
        },
        async connect() {
          state = 'OPEN'
        },
        snapshot() {
          return {
            role: 'safety-guard',
            state,
            links: state === 'OPEN' ? 1 : 0,
            counters: { queuedPackets: 0, queuedBytes: 0, inFlightSends: 0 },
            resources: {
              bindings: state === 'CLOSED' ? 0 : 1,
              waits: 0,
              timers: 0,
              openSockets: state === 'CLOSED' ? 0 : 1
            }
          }
        },
        async stop() {
          state = 'CLOSED'
        }
      }
    }
  })
  await runner.handle({ command: 'configure', projection })
  await runner.handle({ command: 'start' })
  await runner.handle({ command: 'stop' })
  t.is(events.at(-1).event, 'closed')
})

test('role runner arms socket closure until after the transport opens', async (t) => {
  const events = []
  const calls = []
  let state = 'NEW'
  const runner = createRoleRunner({
    emit: (event) => events.push(event),
    createNode() {
      return {
        async start() {
          calls.push('start')
          state = 'READY'
        },
        async connect() {
          calls.push('connect')
          state = 'OPEN'
        },
        snapshot() {
          return {
            role: 'safety-guard',
            state,
            links: state === 'OPEN' ? 1 : 0,
            counters: { queuedPackets: 0, queuedBytes: 0, inFlightSends: 0 },
            resources: { bindings: 1, waits: 0, timers: 0, openSockets: 1 }
          }
        },
        async [LIVE_ROUTE_CLOSE_SOCKET]() {
          calls.push('close-socket')
          state = 'FAILED'
        }
      }
    }
  })
  await runner.handle({
    command: 'configure',
    projection: {
      role: 'safety-guard',
      grants: [b4a.alloc(32, 1)],
      local: { identity32: b4a.alloc(32, 2) }
    }
  })
  await runner.handle({ command: 'fault', fault: 'close-socket' })
  t.alike(calls, [])
  const failure = await runner.handle({ command: 'start' }).then(
    () => null,
    (err) => err
  )
  t.is(failure?.code, 'ROUTE_UNAVAILABLE')
  t.alike(calls, ['start', 'connect', 'close-socket'])
  t.alike(
    events.map((event) => event.event),
    ['configured']
  )
})

test('process fault adapter spoofs source tuples and replays authenticated cells', async (t) => {
  const listeners = new Map()
  const socket = {
    sends: 0,
    bind() {},
    send() {
      this.sends++
      return Promise.resolve(true)
    },
    close() {
      return Promise.resolve(true)
    },
    on(event, listener) {
      listeners.set(event, listener)
    }
  }
  const base = {
    create() {
      return { createSocket: () => socket }
    }
  }
  const observed = []
  const faults = new Set(['spoof-source'])
  const adapter = createProcessFaultAdapter(base, faults)
  const wrapped = adapter.create().createSocket()
  wrapped.on('message', (packet, from) => observed.push([b4a.from(packet), { ...from }]))
  listeners.get('message')(b4a.alloc(1_200), { host: '127.0.0.1', port: 45_001, family: 4 })
  t.alike(observed[0][1], { host: '127.0.0.1', port: 45_002, family: 4 })

  faults.delete('spoof-source')
  faults.add('replay')
  const first = b4a.alloc(1_200, 0x31)
  first[1] = 0
  const second = b4a.alloc(1_200, 0x32)
  second[1] = 1
  listeners.get('message')(first, { host: '127.0.0.1', port: 45_001, family: 4 })
  listeners.get('message')(second, { host: '127.0.0.1', port: 45_001, family: 4 })
  t.alike(observed[1][0], first)
  t.alike(observed[2][0], first)

  faults.delete('replay')
  faults.add('overflow-queue')
  const established = b4a.alloc(1_200, 0x33)
  established[1] = 1
  const delayed = wrapped.send(established, 45_002, '127.0.0.2')
  t.is(socket.sends, 0)
  t.is(await delayed, true)
  t.is(socket.sends, 1)
  await wrapped.close()
})

test('role runner arms the one-packet endpoint limit for queue overflow', async (t) => {
  let runtime = null
  const runner = createRoleRunner({
    emit() {},
    createNode(_projection, adapters) {
      runtime = adapters
      return {
        async start() {},
        async connect() {},
        snapshot() {
          return {
            role: 'safety-guard',
            state: 'OPEN',
            links: 1,
            counters: { queuedPackets: 0, queuedBytes: 0, inFlightSends: 0 },
            resources: { bindings: 1, waits: 0, timers: 0, openSockets: 1 }
          }
        }
      }
    }
  })
  await runner.handle({
    command: 'configure',
    projection: {
      role: 'safety-guard',
      grants: [b4a.alloc(32, 1)],
      local: { identity32: b4a.alloc(32, 2) }
    }
  })
  t.is(runtime.endpointLimits.maxQueuedPackets, undefined)
  t.is(runtime.endpointLimits.maxQueuedBytes, undefined)
  await runner.handle({ command: 'fault', fault: 'overflow-queue' })
  t.is(runtime.endpointLimits.maxQueuedPackets, 1)
  t.is(runtime.endpointLimits.maxQueuedBytes, 1_200)
})

test('role runner retry refuses fallback without invoking its negative control', async (t) => {
  const events = []
  const calls = []
  let state = 'NEW'
  const negativeControl = {
    invocations: 0,
    async dial() {
      calls.push('dial')
      this.invocations++
    },
    async close() {
      calls.push('close-negative-control')
    }
  }
  const runner = createRoleRunner({
    emit: (event) => events.push(event),
    createNegativeControlDialer(options) {
      t.alike(options, {
        bind: { host: '10.203.77.2', port: 48_300 },
        target: { host: '10.203.77.9', port: 48_200 },
        payload: b4a.alloc(32, 0xa7)
      })
      return negativeControl
    },
    createNode() {
      return {
        async start() {
          state = 'READY'
        },
        async connect() {
          state = 'OPEN'
        },
        snapshot() {
          return {
            role: 'source',
            state,
            links: state === 'OPEN' ? 1 : 0,
            counters: { queuedPackets: 0, queuedBytes: 0, inFlightSends: 0 },
            resources: {
              bindings: state === 'CLOSED' ? 0 : 1,
              waits: 0,
              timers: 0,
              openSockets: state === 'CLOSED' ? 0 : 1
            }
          }
        },
        async stop() {
          state = 'CLOSED'
        }
      }
    }
  })
  await runner.handle({
    command: 'configure',
    projection: {
      role: 'source',
      grants: [b4a.alloc(32, 1)],
      local: { identity32: b4a.alloc(32, 2) },
      negativeControl: {
        bind: { host: '10.203.77.2', port: 48_300 },
        target: { host: '10.203.77.9', port: 48_200 },
        payload: b4a.alloc(32, 0xa7)
      }
    }
  })
  await runner.handle({ command: 'start' })
  await runner.handle({ command: 'activate' })
  await runner.handle({ command: 'fault', fault: 'retry' })
  t.alike(events.at(-1), {
    event: 'retry',
    role: 'source',
    code: 'ROUTE_UNAVAILABLE',
    negativeControlInvocations: 0
  })
  t.alike(calls, [])
  await runner.handle({ command: 'stop' })
  t.alike(calls, ['close-negative-control'])
})

test('role runner revokes an armed grant only after links open', async (t) => {
  const calls = []
  let state = 'NEW'
  const runner = createRoleRunner({
    emit() {},
    createNode() {
      return {
        async start() {
          calls.push('start')
          state = 'READY'
        },
        async connect() {
          calls.push('connect')
          state = 'OPEN'
        },
        snapshot() {
          return {
            role: 'safety-guard',
            state,
            links: state === 'OPEN' ? 1 : 0,
            counters: { queuedPackets: 0, queuedBytes: 0, inFlightSends: 0 },
            resources: { bindings: 1, waits: 0, timers: 0, openSockets: 1 }
          }
        },
        [LIVE_ROUTE_REVOKE_GRANT](digest32) {
          calls.push(`revoke:${digest32[0]}`)
          state = 'FAILED'
        }
      }
    }
  })
  await runner.handle({
    command: 'configure',
    projection: {
      role: 'safety-guard',
      grants: [b4a.alloc(32, 1)],
      local: { identity32: b4a.alloc(32, 2) }
    }
  })
  await runner.handle({ command: 'revoke', grantDigest32: b4a.alloc(32, 7) })
  t.alike(calls, [])
  const failure = await runner.handle({ command: 'start' }).then(
    () => null,
    (err) => err
  )
  t.is(failure?.code, 'ROUTE_UNAVAILABLE')
  t.alike(calls, ['start', 'connect', 'revoke:7'])
})

test('role runner stop interrupts pending setup instead of waiting behind it', async (t) => {
  const calls = []
  const events = []
  let releaseStart
  let state = 'NEW'
  const runner = createRoleRunner({
    emit: (event) => events.push(event),
    createNode() {
      return {
        async start() {
          calls.push('start')
          state = 'STARTING'
          await new Promise((resolve) => {
            releaseStart = resolve
          })
        },
        async connect() {
          calls.push('connect')
          throw new Error('stopped')
        },
        snapshot() {
          return {
            role: 'source',
            state,
            links: 0,
            counters: { queuedPackets: 0, queuedBytes: 0, inFlightSends: 0 },
            resources: {
              bindings: state === 'CLOSED' ? 0 : 1,
              waits: 0,
              timers: 0,
              openSockets: state === 'CLOSED' ? 0 : 1
            }
          }
        },
        async stop() {
          calls.push('stop')
          state = 'CLOSED'
        }
      }
    }
  })
  await runner.handle({
    command: 'configure',
    projection: {
      role: 'source',
      grants: [b4a.alloc(32, 1)],
      local: { identity32: b4a.alloc(32, 2) }
    }
  })
  const starting = runner.handle({ command: 'start' })
  await Promise.resolve()
  const stopping = runner.handle({ command: 'stop' })
  await Promise.resolve()
  await Promise.resolve()
  t.alike(calls, ['start', 'stop'])
  releaseStart()
  const outcomes = await Promise.allSettled([starting, stopping])
  t.is(outcomes[0].status, 'rejected')
  t.is(outcomes[1].status, 'fulfilled')
  t.alike(
    events.map((event) => event.event),
    ['configured', 'closed']
  )
})
