import test from 'brittle'

import { createConsumerCatalogProjection } from '../src/media-graph/catalog-projection.js'
import { createLocalMediaIndex } from '../src/indexing/local-index.js'
import { createBootstrapManager } from '../src/discovery/bootstrap-manager.js'
import { createBootstrapLocator } from '../src/discovery/bootstrap-protocol.js'
import crypto from 'hypercore-crypto'

const id = (character) => character.repeat(64)
const candidate = { kind: 'movie', entityRef: 'work:publisher-record', publicationId: id('1'), publisherId: id('a'), title: 'Publisher record' }

test('removing a bundled curator changes only the local projection and never publisher validity or playback authority', (t) => {
  const index = createLocalMediaIndex()
  let enabled = true
  const protocol = { publisherRecordIsValid: () => true, canReplicate: () => true, canPlay: () => true }
  const projection = createConsumerCatalogProjection({
    localIndex: index,
    bootstrapManager: { listLocators: () => [{ publisherId: id('a') }] },
    indexFeedManager: { getRecords: () => [candidate] },
    moderationPolicy: {
      enabled: () => enabled,
      curatorSubscriptions: [id('c')],
      evaluate: () => enabled ? { action: 'hidden', reason: 'feed-block' } : { action: 'visible', reason: 'disabled' },
    },
  })

  projection.rebuild()
  t.is(projection.getCatalog().items.length, 0)
  t.ok(protocol.publisherRecordIsValid(candidate))
  t.ok(protocol.canReplicate(candidate))
  t.ok(protocol.canPlay(candidate))
  t.alike(projection.getCuratorSubscriptions(), [id('c')])

  enabled = false
  projection.rebuild()
  t.alike(projection.getCatalog().items.map(item => item.entityRef), ['work:publisher-record'])
  t.ok(protocol.publisherRecordIsValid(candidate), 'local profile did not alter signed publisher validity')
  t.ok(protocol.canReplicate(candidate), 'local profile did not alter replication')
  t.ok(protocol.canPlay(candidate), 'local profile did not alter playback')
})

test('a curated moderation key cannot authenticate bootstrap or publisher authority', async (t) => {
  const curator = crypto.keyPair(Buffer.alloc(32, 7))
  const locator = createBootstrapLocator({
    publisherId: id('a'),
    catalogBootstrapKey: id('b'),
    catalogHead: id('c'),
    authorizationChainDigest: id('d'),
    issuedAt: 10,
    expiresAt: 100,
    keyPair: curator,
  })
  const bootstrap = createBootstrapManager({ now: () => 20, trustedSigners: [] })

  const result = await bootstrap.ingestLocator('peer', locator.envelope)
  t.is(result.status, 'quarantined')
  t.absent(bootstrap.getLocator(id('a')))
})
