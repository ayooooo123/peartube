import test from 'brittle'
import { EventEmitter } from 'node:events'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createPublicationManifest } from '../src/assets/index.js'
import { createArchiveRequest } from '../src/archive/request.js'
import { createMediaGraphApi } from '../src/api/media-graph.js'
import { createConsumerCatalogProjection } from '../src/media-graph/catalog-projection.js'
import { createLocalMediaIndex } from '../src/indexing/local-index.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'

const id = (character) => character.repeat(64)

test('default moderation blocks a candidate before artwork, topic, playback, cache, seed, or archive work', async (t) => {
  const work = []
  const publisherRecords = [
    { directPublisher: true, kind: 'movie', entityRef: 'work:blocked', publicationId: id('1'), publisherId: id('a'), title: 'Blocked', artwork: 'https://blocked.invalid/poster' },
    { directPublisher: true, kind: 'movie', entityRef: 'work:visible', publicationId: id('2'), publisherId: id('b'), title: 'Visible' },
  ]
  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    bootstrapManager: { listLocators: () => [{ publisherId: id('a') }, { publisherId: id('b') }] },
    indexFeedManager: {
      getRecords: () => publisherRecords,
    },
    publisherRecords: () => publisherRecords,
    moderationPolicy: {
      enabled: true,
      evaluate: record => record.entityRef === 'work:blocked'
        ? { action: 'hidden', reason: 'local-block' }
        : { action: 'visible', reason: 'default' },
    },
    onArtwork: record => work.push(['artwork', record.entityRef]),
    onTopicJoin: record => work.push(['topic', record.entityRef]),
    onPlaybackPreparation: record => work.push(['playback', record.entityRef]),
    onCache: record => work.push(['cache', record.entityRef]),
    onSeed: record => work.push(['seed', record.entityRef]),
    onArchive: record => work.push(['archive', record.entityRef]),
  })

  const result = projection.rebuild()
  t.is(result.accepted, 1)
  t.is(result.rejectionCodes.LOCAL_MODERATION_HIDDEN, 1)
  t.alike(work, [], 'catalog projection never schedules downstream work')
  t.alike(projection.getCatalog().items.map(item => item.entityRef), ['work:visible'])
  t.is(projection.isPublicationVisible(id('1')), false)
  t.is(projection.isPublicationVisible(id('2')), true)
  t.alike(projection.getRejectedCandidates(), [{ entityRef: 'work:blocked', reason: 'local-block' }])
  t.alike(await projection.schedule('work:blocked', ['artwork', 'topic', 'playback', 'cache', 'seed', 'archive']), {
    scheduled: false,
    errorCode: 'CONSUMER_CANDIDATE_NOT_VISIBLE',
  })
  t.alike(work, [], 'blocked candidates cannot be scheduled after projection either')
  t.alike(await projection.schedule('work:visible', ['artwork', 'topic', 'playback', 'cache', 'seed', 'archive']), {
    scheduled: true,
    operations: ['artwork', 'topic', 'playback', 'cache', 'seed', 'archive'],
  })
  t.alike(work.map(([operation, entityRef]) => [operation, entityRef]), [
    ['artwork', 'work:visible'], ['topic', 'work:visible'], ['playback', 'work:visible'],
    ['cache', 'work:visible'], ['seed', 'work:visible'], ['archive', 'work:visible'],
  ])
})

function fakeSwarm() {
  const swarm = new EventEmitter()
  swarm.connections = new Set()
  swarm.joins = []
  swarm.join = topic => {
    const handle = { topic, async flushed () {}, destroy () {} }
    swarm.joins.push(handle)
    return handle
  }
  return swarm
}

test('real media graph and retained asset seams reject hidden consumer work before storage or topic work', async (t) => {
  let graphReads = 0
  const hiddenProjection = {
    async update () {},
    isVisible: entityRef => entityRef !== 'work:hidden',
  }
  const graphApi = createMediaGraphApi({
    consumerCatalogProjection: hiddenProjection,
    mediaGraphStore: {
      getClaimsBySubject () { graphReads++; return [] },
    },
  })
  const hiddenEntity = await graphApi.getMediaEntity({ entityId: 'work:hidden' })
  t.is(hiddenEntity.errorCode, 'MEDIA_ENTITY_NOT_VISIBLE')
  t.is(graphReads, 0, 'hidden entity does not reach graph/source/artwork projection reads')

  const publisher = crypto.keyPair(b4a.alloc(32, 91))
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Moderated asset',
    renditions: [{
      purpose: 'video',
      format: 'video/mp4',
      core: {
        key: b4a.alloc(32, 92),
        length: 2,
        treeHash: b4a.alloc(32, 93),
        byteLength: 2048,
      },
    }],
    keyPair: publisher,
  })
  const renditionId = manifest.body.renditions[0].renditionId
  let coreOpens = 0
  let downloads = 0
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    authorizePublication: async () => true,
    authorizeConsumerWork: async ({ entityRef }) => entityRef !== 'work:hidden',
    store: {
      get ({ key }) {
        coreOpens++
        return {
          key,
          async ready () {},
          download () { downloads++; return { destroy () {} } },
          async close () {},
        }
      },
    },
  })
  await runtime.start()
  await t.exception(runtime.retainAuthorizedRendition({
    manifest,
    renditionId,
    entityRef: 'work:hidden',
  }), /not visible/i)
  t.is(coreOpens, 0, 'hidden playback/cache/seed work never opens a media core')
  t.is(downloads, 0)
  t.is(swarm.joins.length, 1, 'hidden asset topic is never joined')

  const visible = await runtime.retainAuthorizedRendition({
    manifest,
    renditionId,
    entityRef: 'work:visible',
  })
  t.is(visible.status, 'retained')
  t.is(coreOpens, 1)
  t.is(downloads, 1)
  t.is(swarm.joins.length, 2, 'locally permitted media follows the normal retained asset path')

  const archiveRequest = createArchiveRequest({
    requesterId: publisher.publicKey,
    publicationId: manifest.publicationId,
    renditionId,
    ranges: [{ coreKey: manifest.body.renditions[0].core.key, start: 0, end: 2 }],
    requestedBytes: 2048,
    retentionUntil: 1000,
    issuedAt: 10,
    expiresAt: 100,
    keyPair: publisher,
  })
  await runtime.retainArchiveDiscovery()
  await t.exception(runtime.publishArchiveRequest({
    request: archiveRequest,
    entityRef: 'work:hidden',
  }), /not visible/i)
  const visibleArchive = await runtime.publishArchiveRequest({
    request: archiveRequest,
    entityRef: 'work:visible',
  })
  t.is(visibleArchive.status, 'published', 'locally permitted archive initiation follows the normal scoped path')
  await runtime.close()
})
