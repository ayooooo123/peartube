import test from 'brittle'
import b4a from 'b4a'

import { BOOTSTRAP_LOCATOR_CAPABILITY } from '../src/discovery/bootstrap-protocol.js'
import {
  createScopedNetworkRuntime,
  createScopedProtocolSession,
  encodeScopedHello,
} from '../src/network/scoped-runtime.js'
import { deriveBootstrapTopic } from '../src/network/topics.js'
import { encodePeerFrame } from '../src/network/frame.js'

function portableSwarm () {
  const listeners = new Map()
  const handles = []
  return {
    handles,
    connections: new Set(),
    on (name, listener) { listeners.set(name, listener) },
    off (name, listener) { if (listeners.get(name) === listener) listeners.delete(name) },
    removeListener (name, listener) { if (listeners.get(name) === listener) listeners.delete(name) },
    join (topic) {
      const handle = { topic: b4a.from(topic), closed: 0, flushed: async () => {}, destroy () { this.closed++ } }
      handles.push(handle)
      return handle
    },
  }
}

test('portable scoped protocol enforces handshake and replay bounds', async (t) => {
  const topic = deriveBootstrapTopic({ networkId: 'portable' })
  let frames = 0
  const session = createScopedProtocolSession({
    peerId: 'bare-peer',
    purpose: 'bootstrap',
    topic,
    requiredCapability: BOOTSTRAP_LOCATOR_CAPABILITY,
    onFrame () { frames++; return { status: 'accepted' } },
  })
  await session.acceptHello(encodeScopedHello({
    purpose: 'bootstrap',
    topic,
    capabilities: [BOOTSTRAP_LOCATOR_CAPABILITY],
  }))
  const frame = encodePeerFrame({ purpose: 'bootstrap', type: 'locator', requestId: 7, payload: b4a.alloc(0) })
  t.alike(await session.receive(frame), { status: 'accepted' })
  await t.exception(session.receive(frame), /replay/)
  t.is(frames, 1)
  session.close()
})

test('portable runtime leaves the bootstrap scope exactly once', async (t) => {
  const swarm = portableSwarm()
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, networkId: 'portable' })
  await runtime.start()
  t.is(runtime.getDiagnostics().topics.length, 1)
  await runtime.close()
  await runtime.close()
  t.is(swarm.handles.length, 1)
  t.is(swarm.handles[0].closed, 1)
})
