import test from 'brittle'

import { createP2PNetworkHarness } from './fixtures/p2p-network-harness.mjs'
import { createLocalMediaIndex } from '../src/indexing/local-index.js'
import { evaluateModerationPolicy } from '../src/moderation/policy.js'

test('duplicate publications share an asset swarm without merging provenance', (t) => {
  const net = createP2PNetworkHarness({ seed: 7 })
  net.createPeer('publisher')
  net.createPeer('publisher')
  const index = createLocalMediaIndex()
  index.ingestRecords([
    { entityRef: 'work:1', publicationId: 'pub:a', publisherId: 'publisher:a', renditionId: 'rend:same', sourceId: 'curator:a', title: 'Same', playable: true },
    { entityRef: 'work:1', publicationId: 'pub:b', publisherId: 'publisher:b', renditionId: 'rend:same', sourceId: 'curator:b', title: 'Same', playable: true },
  ])
  const result = index.search('Same')[0]
  t.is(result.publications.length, 2)
  t.alike(result.provenance.sort(), ['curator:a', 'curator:b'])
  t.not(result.publications[0].publisherId, result.publications[1].publisherId)
  net.shutdown()
  t.is(net.snapshotResources().connections, 0)
})

test('local moderation prevents entity download before source selection', (t) => {
  const decision = evaluateModerationPolicy({ publicationId: 'pub:a', publisherId: 'publisher:a' }, { localBlocks: [{ targetType: 'publisher', targetId: 'publisher:a' }] })
  t.is(decision.action, 'not-downloaded')
})
