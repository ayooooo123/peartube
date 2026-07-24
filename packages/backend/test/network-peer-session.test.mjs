import test from 'brittle'
import b4a from 'b4a'

import { createPeerSessionPair } from '../src/network/index.js'

test('peer session moves Noise-authenticated purpose-bound handshake to active then closed', async (t) => {
  const { client, server } = createPeerSessionPair({ purpose: 'asset', topic: b4a.alloc(32, 1), features: ['range-v1'], localLimits: { maxFrameBytes: 4096 }, remoteLimits: { maxFrameBytes: 2048 } })
  server.handle('ping', async (payload) => ({ type: 'pong', payload }))

  t.is(client.state, 'noise-authenticated')
  await client.handshake()
  t.is(client.state, 'active')
  t.is(client.negotiatedLimits.maxFrameBytes, 2048)
  const response = await client.request({ type: 'ping', payload: b4a.from('hi') })
  t.is(response.type, 'pong')
  t.alike(response.payload, b4a.from('hi'))
  client.close('done')
  t.is(client.state, 'closed')
})

test('peer session rejects purpose/topic mismatch, major mismatch, pre-handshake requests, and unknown dispatch', async (t) => {
  const goodTopic = b4a.alloc(32, 1)
  const badTopic = b4a.alloc(32, 2)
  const { client } = createPeerSessionPair({ purpose: 'asset', topic: goodTopic })

  await t.exception(client.request({ type: 'ping' }), /handshake required/)
  await t.exception(client.handshake({ purpose: 'publisher' }), /purpose mismatch/)
  await t.exception(client.handshake({ topic: badTopic }), /topic mismatch/)
  await t.exception(client.handshake({ protocolMajor: 99 }), /major mismatch/)

  const pair = createPeerSessionPair({ purpose: 'asset', topic: goodTopic })
  await pair.client.handshake()
  await t.exception(pair.client.request({ type: 'missing' }), /unknown handler/)
})

test('peer session releases admission reservations on handler error and cancellation', async (t) => {
  const { client, server, admission } = createPeerSessionPair({ purpose: 'asset', topic: b4a.alloc(32, 1), admission: { maxInFlightBytes: 4, maxMessages: 10, maxBytes: 100 } })
  server.handle('fail', async () => { throw new Error('boom') })
  await client.handshake()
  await t.exception(client.request({ type: 'fail', payload: b4a.alloc(4) }), /boom/)
  t.is(admission.snapshot(client.peerId).inFlightBytes, 0)

  const pending = client.reserveForTest({ bytes: 4 })
  t.is(admission.reserve({ peerId: client.peerId, bytes: 1 }).reason, 'in-flight-bytes')
  pending.release('cancelled')
  t.is(admission.reserve({ peerId: client.peerId, bytes: 1 }).accepted, true)
})
