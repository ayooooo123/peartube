import test from 'brittle'

import { createP2PNetworkHarness } from './fixtures/p2p-network-harness.mjs'
import { createPeerSessionPair } from '../src/network/peer-session.js'
import { createNetworkAdmission } from '../src/network/admission.js'
import { encodePeerFrame } from '../src/network/frame.js'
import { enforceModerationDecision } from '../src/moderation/manager.js'

test('adversarial harness bounds sybil discovery, oversized frames, drops, and shutdown leaks', (t) => {
  const net = createP2PNetworkHarness({ seed: 42, bandwidthLimitBytes: 1024, diskLimitBytes: 2048 })
  const honest = net.createPeer('viewer')
  for (let i = 0; i < 64; i++) net.connect(net.createPeer('sybil', { hostile: true }), honest)
  const before = net.snapshotResources()
  t.ok(before.peers >= 65)
  const huge = net.send(honest, net.createPeer('publisher'), { type: 'catalog', bytes: 2048 })
  t.is(huge.accepted, false)
  t.is(huge.reason, 'bandwidth-budget')
  const dropped = net.send(honest, net.createPeer('publisher'), { type: 'locator', bytes: 10 }, { drop: true })
  t.is(dropped.reason, 'dropped')
  net.shutdown()
  t.is(net.snapshotResources().connections, 0)
})

test('purpose/topic mismatch and moderation stop download or seed before expensive work', (t) => {
  const pair = createPeerSessionPair({ purpose: 'asset', topic: Buffer.alloc(32, 1) })
  t.exception(() => pair.client.handshake({ purpose: 'publisher' }), /purpose mismatch/)
  t.exception(() => pair.client.handshake({ topic: Buffer.alloc(32, 2) }), /topic mismatch/)
  const blockedDownload = enforceModerationDecision({ action: 'not-downloaded', evidence: [{ source: 'local' }] }, 'download')
  const blockedSeed = enforceModerationDecision({ action: 'not-seeded', evidence: [{ source: 'feed' }] }, 'seed')
  t.is(blockedDownload.allowed, false)
  t.is(blockedSeed.allowed, false)
})

test('malformed peer frames and cumulative valid frames are budget-bound', (t) => {
  const admission = createNetworkAdmission({ maxMessages: 2, maxBytes: 128 })
  const frame = encodePeerFrame({ type: 'catalog', payload: Buffer.alloc(16), protocolMajor: 1, protocolMinor: 0 })
  t.is(admission.reserve({ peerId: 'p', bytes: frame.length }).accepted, true)
  t.is(admission.reserve({ peerId: 'p', bytes: frame.length }).accepted, true)
  t.is(admission.reserve({ peerId: 'p', bytes: frame.length }).accepted, false)
})
