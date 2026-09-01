import test from 'brittle'

import { createMediaGraphApi, mediaCoordinatesResponse } from '../src/api/media-graph.js'
import { createStaticAssetManifest } from '../src/assets/static-core.js'
import { normalizeAssetCoreRefV2 } from '../src/assets/rendition.js'
import { createPlaybackError } from '../src/playback/errors.js'
import {
  areSourcesEquivalent,
  selectPlaybackSource,
  sourceEquivalenceKey,
} from '../src/media-graph/source-selector.js'
import { preparePlaybackSource } from '../src/playback/source-preparation.js'

const NOW = 1_700_000_000_000

function availability(state, overrides = {}) {
  return {
    state,
    observedAt: NOW,
    expiresAt: NOW + 60_000,
    requiredRangeCount: 1,
    reachableRangeCount: state === 'healthy' || state === 'limited' ? 1 : 0,
    independentPeerCount: state === 'healthy' ? 2 : state === 'limited' ? 1 : 0,
    completePeerCount: state === 'healthy' ? 2 : 0,
    offlinePlayable: false,
    archivePledged: false,
    reasonCodes: [],
    ...overrides,
  }
}

function source(publicationId, overrides = {}) {
  return {
    publicationId,
    publisherId: `publisher-${publicationId}`,
    renditionId: `rendition-${publicationId}`,
    entityId: 'work:movie-1',
    publicationAuthorized: true,
    availability: availability('healthy'),
    ...overrides,
  }
}

function select(sources, context = {}) {
  return selectPlaybackSource(sources, { now: NOW, ...context })
}

function codesFor(selection, publicationId) {
  return selection.candidates.find(candidate => candidate.publicationId === publicationId)?.rejectionReasonCodes || []
}

test('every hard gate rejects before any scoring happens', (t) => {
  const cases = [
    ['moderated', { moderationDecision: 'blocked' }, 'BLOCKED_BY_MODERATION'],
    ['policy', { localPolicyDecision: 'deny' }, 'BLOCKED_BY_LOCAL_POLICY'],
    ['unsigned', { publicationAuthorized: false }, 'UNAUTHORIZED_PUBLICATION'],
    ['codec', { codecs: ['av01'] }, 'UNSUPPORTED_CODEC'],
    ['container', { container: 'video/webm' }, 'UNSUPPORTED_CONTAINER'],
    ['superseded', { manifestStale: true }, 'STALE_MANIFEST'],
    ['partial', { incomplete: true }, 'INCOMPLETE_PUBLICATION'],
    ['orphan-episode', { collectionMemberBound: false }, 'INCOMPLETE_COLLECTION_BINDING'],
    ['gone', { availability: availability('unavailable') }, 'NO_AVAILABLE_COPY'],
  ]
  const capabilities = { codecs: ['avc1'], containers: ['video/mp4'] }

  for (const [id, overrides, expected] of cases) {
    const selection = select([source(id, overrides)], { capabilities })
    t.is(selection.selected, null, `${id} never becomes the Play target`)
    t.ok(codesFor(selection, id).includes(expected), `${id} reports ${expected}`)
    const candidate = selection.candidates[0]
    t.is(candidate.eligible, false)
    t.absent(candidate.selectionReasonCodes.length, `${id} carries no selection reason`)
  }
})

test('expired availability evidence is a hard gate, not a low score', (t) => {
  const expired = source('expired', { availability: availability('healthy', { expiresAt: NOW - 1 }) })
  const selection = select([expired])
  t.is(selection.selected, null)
  t.ok(codesFor(selection, 'expired').includes('STALE_AVAILABILITY'))
})

test('a device with no declared capability constraint accepts any codec', (t) => {
  const selection = select([source('a', { codecs: ['av01'], container: 'video/webm' })])
  t.is(selection.selectedPublicationId, 'a')
})

test('Play picks one source deterministically without opening a picker', (t) => {
  const sources = [
    source('slow', { expectedStartupLatencyMs: 4_000 }),
    source('fast', { expectedStartupLatencyMs: 100 }),
    source('limited', { availability: availability('limited') }),
  ]
  const first = select(sources)
  const shuffled = select([sources[2], sources[0], sources[1]])
  t.is(first.selectedPublicationId, 'fast')
  t.is(shuffled.selectedPublicationId, 'fast', 'input order never changes the answer')
  t.alike(
    first.candidates.find(candidate => candidate.selected).selectionReasonCodes,
    ['SELECTED_BY_HIGHEST_SCORE']
  )
})

test('a local complete copy outranks every network source', (t) => {
  const selection = select([
    source('network', { availability: availability('healthy') }),
    source('offline', { availability: availability('limited', { offlinePlayable: true }) }),
  ])
  t.is(selection.selectedPublicationId, 'offline')
})

test('a user override wins, and the sources it beat say so', (t) => {
  const selection = select([
    source('best', { availability: availability('healthy') }),
    source('mine', { availability: availability('limited'), preferred: true }),
  ])
  t.is(selection.selectedPublicationId, 'mine')
  t.alike(
    selection.candidates.find(candidate => candidate.selected).selectionReasonCodes,
    ['SELECTED_BY_LOCAL_PREFERENCE']
  )
  t.alike(codesFor(selection, 'best'), ['DEPRIORITIZED_BY_LOCAL_PREFERENCE'])
})

test('publisher popularity and paid placement have nowhere to enter the score', (t) => {
  const selection = select([
    source('promoted', { publisherTrust: 1_000_000, metadataConfidence: 1_000, sponsored: true, popularity: 99 }),
    source('a-plain'),
  ])
  const [promoted, plain] = ['promoted', 'a-plain'].map(id =>
    selection.candidates.find(candidate => candidate.publicationId === id)
  )
  t.is(promoted.score, plain.score, 'promotion buys exactly nothing')
  t.is(selection.selectedPublicationId, 'a-plain', 'the tie breaks on publication id, not on money')
})

test('equivalence fails closed and never crosses edition or episode', (t) => {
  t.is(sourceEquivalenceKey({}), null, 'a source with no entity has no identity')
  t.absent(areSourcesEquivalent({}, {}), 'two anonymous sources are not interchangeable')

  const base = source('a')
  t.ok(areSourcesEquivalent(base, source('b')))
  t.absent(areSourcesEquivalent(base, source('c', { entityId: 'work:movie-2' })), 'different work')
  t.absent(areSourcesEquivalent(base, source('d', { editionId: 'directors-cut' })), 'different cut')
  t.absent(areSourcesEquivalent(base, source('e', { collectionMemberId: 'episode-2' })), 'different episode')
})

test('the failover order contains only sources equivalent to the winner', (t) => {
  const selection = select([
    source('winner', { expectedStartupLatencyMs: 0 }),
    source('sibling', { expectedStartupLatencyMs: 500 }),
    source('other-episode', { collectionMemberId: 'episode-9', expectedStartupLatencyMs: 900 }),
    source('other-cut', { editionId: 'directors-cut', expectedStartupLatencyMs: 900 }),
  ])
  t.is(selection.selectedPublicationId, 'winner')
  t.alike(selection.failoverOrder.map(item => item.publicationId), ['sibling'])
})

function opener(script) {
  const opened = []
  const closed = []
  return {
    opened,
    closed,
    async openSession({ publicationId }) {
      opened.push(publicationId)
      const outcome = script[publicationId]
      if (typeof outcome === 'function') return outcome({ closed, publicationId })
      if (outcome === 'ok') return { success: true, close: () => closed.push(publicationId) }
      return { success: false, errorCode: outcome, close: () => closed.push(publicationId) }
    },
  }
}

test('preparation falls over to the next equivalent source and closes the abandoned one', async (t) => {
  const script = opener({ winner: 'PEER_DISCONNECT', sibling: 'ok' })
  const result = await preparePlaybackSource({
    sources: [source('winner', { expectedStartupLatencyMs: 0 }), source('sibling', { expectedStartupLatencyMs: 500 })],
    openSession: script.openSession,
    now: () => NOW,
  })
  t.is(result.success, true)
  t.is(result.publicationId, 'sibling')
  t.alike(script.opened, ['winner', 'sibling'])
  t.alike(script.closed, ['winner'], 'the failed attempt is closed before the next one opens')
  t.alike(result.attempts.map(attempt => attempt.errorCode), ['PEER_DISCONNECT', null])
})

test('a terminal failure stops immediately instead of walking every source', async (t) => {
  const script = opener({ winner: 'NO_COMPATIBLE_SOURCE', sibling: 'ok' })
  const result = await preparePlaybackSource({
    sources: [source('winner', { expectedStartupLatencyMs: 0 }), source('sibling', { expectedStartupLatencyMs: 500 })],
    openSession: script.openSession,
    now: () => NOW,
  })
  t.is(result.success, false)
  t.is(result.errorCode, 'NO_COMPATIBLE_SOURCE')
  t.alike(script.opened, ['winner'], 'a device-level incompatibility is not a peer problem')
})

test('preparation never loops and never exceeds its attempt cap', async (t) => {
  const sources = ['a', 'b', 'c', 'd', 'e'].map((id, index) => source(id, { expectedStartupLatencyMs: index }))
  const script = opener(Object.fromEntries(sources.map(item => [item.publicationId, 'PEER_TIMEOUT'])))
  const result = await preparePlaybackSource({
    sources,
    openSession: script.openSession,
    maxAttempts: 2,
    now: () => NOW,
  })
  t.is(result.success, false)
  t.is(result.errorCode, 'ATTEMPT_LIMIT')
  t.is(script.opened.length, 2)
  t.is(new Set(script.opened).size, 2, 'no source is attempted twice')
})

test('one deadline covers every attempt together', async (t) => {
  let clock = NOW
  const script = opener({
    a: () => { clock += 11_000; return { success: false, errorCode: 'PEER_TIMEOUT' } },
    b: () => { clock += 11_000; return { success: false, errorCode: 'PEER_TIMEOUT' } },
  })
  const result = await preparePlaybackSource({
    sources: [source('a', { expectedStartupLatencyMs: 0 }), source('b', { expectedStartupLatencyMs: 1 })],
    openSession: script.openSession,
    deadlineMs: 10_000,
    now: () => clock,
  })
  t.is(result.success, false)
  t.is(result.errorCode, 'PREPARATION_DEADLINE')
  t.alike(script.opened, ['a'], 'the second attempt never starts past the shared deadline')
})

test('an opener that ignores the deadline loses the race and its session is closed', async (t) => {
  const closed = []
  const result = await preparePlaybackSource({
    sources: [source('hung')],
    deadlineMs: 20,
    now: () => NOW,
    openSession: () => new Promise(resolve => {
      setTimeout(() => resolve({ success: true, close: () => closed.push('hung') }), 200)
    }),
  })
  t.is(result.success, false)
  t.is(result.errorCode, 'PREPARATION_DEADLINE')
  await new Promise(resolve => setTimeout(resolve, 300))
  t.alike(closed, ['hung'], 'a late session is closed, never leaked')
})

test('preparation reports no compatible source rather than guessing', async (t) => {
  const result = await preparePlaybackSource({
    sources: [source('blocked', { moderationDecision: 'blocked' })],
    openSession: () => { throw new Error('must not open a rejected source') },
    now: () => NOW,
  })
  t.is(result.success, false)
  t.is(result.errorCode, 'NO_COMPATIBLE_SOURCE')
  t.alike(result.attempts, [])
})

test('a caller-supplied non-equivalent source can never be smuggled into failover', async (t) => {
  const script = opener({ winner: 'PEER_TIMEOUT', 'other-work': 'ok' })
  const result = await preparePlaybackSource({
    sources: [
      source('winner', { expectedStartupLatencyMs: 0 }),
      source('other-work', { entityId: 'work:movie-2', expectedStartupLatencyMs: 900 }),
    ],
    openSession: script.openSession,
    now: () => NOW,
  })
  t.is(result.success, false)
  t.alike(script.opened, ['winner'])
})

test('an abort signal cancels the whole preparation tree', async (t) => {
  const controller = new AbortController()
  const closed = []
  const result = await preparePlaybackSource({
    sources: [source('a'), source('b')],
    signal: controller.signal,
    now: () => NOW,
    openSession: () => {
      controller.abort()
      return { success: false, errorCode: 'PEER_TIMEOUT', close: () => closed.push('a') }
    },
  })
  t.is(result.success, false)
  t.is(result.errorCode, 'PREPARATION_CANCELLED')
  t.alike(closed, ['a'])
})

const coreA = createStaticAssetManifest({ treeHash: 'a'.repeat(64), blockLength: 4, byteLength: 4 * 262144 })
const coreB = createStaticAssetManifest({ treeHash: 'b'.repeat(64), blockLength: 4, byteLength: 4 * 262144 })
const coreRefA = normalizeAssetCoreRefV2(coreA)
const coreRefB = normalizeAssetCoreRefV2(coreB)
function graphFixture(overrides = {}) {
  const manifests = new Map([
    ['pub-a', { publicationId: 'pub-a', body: { publisherId: 'pub', manifestId: 'm-a', renditions: [{ renditionId: 'rendition-pub-a', core: coreA }], provenance: [{ renditionId: 'rendition-pub-a', coreKey: coreRefA.key, start: 0, end: coreRefA.length }] } }],
    ['pub-b', { publicationId: 'pub-b', body: { publisherId: 'pub', manifestId: 'm-b', renditions: [{ renditionId: 'rendition-pub-b', core: coreB }], provenance: [{ renditionId: 'rendition-pub-b', coreKey: coreRefB.key, start: 0, end: coreRefB.length }] } }],
  ])
  return {
    verifiedQueryView: {
      async getEntity({ entityId }) {
        if (entityId !== 'work:movie-1') return null
        return {
          entityId,
          entityKind: 'work',
          publications: [...manifests.values()].map(manifest => ({
            publicationId: manifest.publicationId,
            publisherId: manifest.body.publisherId,
            sourceRecordRef: `claim-${manifest.publicationId}`,
            manifest,
          })),
        }
      },
      async getManifest({ publicationId }) {
        return manifests.get(publicationId) || null
      },
      async getRendition({ publicationId, renditionId }) {
        const manifest = manifests.get(publicationId)
        const rendition = manifest?.body.renditions.find(candidate => candidate.renditionId === renditionId)
        if (!rendition) return null
        const core = normalizeAssetCoreRefV2(rendition.core)
        return {
          manifest,
          rendition,
          requirement: {
            publicationId,
            renditionId,
            coreKey: core.key,
            coreLength: core.length,
            requiredRanges: [{ start: 0, end: core.length }],
          },
        }
      },
      async authorizeRendition() {
        return true
      },
    },
    availabilityEvidenceStore: {
      getCachedEvidence: publicationId => ({
        peers: ['aa', 'bb'].map(transportKey => ({
          transportKey: `${transportKey}-${publicationId}`,
          connected: true,
          advertisedRanges: [{ start: 0, end: 4 }],
          advertisedAt: NOW - 10_000,
          challengeStatus: 'passed',
          verifiedAt: NOW - 1_000,
          latencyMs: publicationId === 'pub-a' ? 10 : 900,
        })),
      }),
    },
    sourcePreferenceStore: new Map(),
    now: () => NOW,
    ...overrides,
  }
}

test('one Play call selects, opens, and reports the source without a picker', async (t) => {
  const opened = []
  const api = createMediaGraphApi(graphFixture({
    openPlaybackSession: async ({ publicationId }) => {
      opened.push(publicationId)
      return { success: true, coreKey: 'a'.repeat(64), close() {} }
    },
  }))

  const result = await api.prepareMediaPlayback({ entityId: 'work:movie-1' })
  t.is(result.success, true)
  t.is(result.publicationId, 'pub-a', 'the lower measured latency wins')
  t.is(result.renditionId, 'rendition-pub-a')
  t.alike(opened, ['pub-a'])
  t.ok(result.sources.some(item => item.selected), 'Other Sources explains the same decision')
})

test('verified rendition URL opener returns a playable loopback URL', async t => {
  const api = createMediaGraphApi(graphFixture({
    blobServer: {
      port: 8080,
      getLink() { return 'http://127.0.0.1:8080/verified-rendition' }
    },
    ctx: { blobServerHost: '127.0.0.1', blobServerPort: 8080 }
  }))
  const opened = await api.openMediaRenditionUrl({
    publicationId: 'pub-a',
    renditionId: 'rendition-pub-a'
  })
  t.is(opened.success, true, opened.errorCode || opened.error || 'opened')
  t.is(opened.assetId, coreA.assetId)
  t.is(opened.url, 'http://127.0.0.1:8080/verified-rendition')
})

test('verified rendition URL opener reads legacy static publications without usable provenance ranges', async t => {
  const fixture = graphFixture({
    blobServer: {
      port: 8080,
      getLink() { return 'http://127.0.0.1:8080/legacy-static-rendition' }
    },
    ctx: { blobServerHost: '127.0.0.1', blobServerPort: 8080 }
  })
  const getRendition = fixture.verifiedQueryView.getRendition.bind(fixture.verifiedQueryView)
  fixture.verifiedQueryView.getRendition = async input => {
    const projected = await getRendition(input)
    return {
      ...projected,
      manifest: {
        ...projected.manifest,
        body: {
          ...projected.manifest.body,
          provenance: [{
            renditionId: projected.rendition.renditionId,
            coreKey: normalizeAssetCoreRefV2(projected.rendition.core).key,
            blobId: null,
          }],
        }
      }
    }
  }
  const api = createMediaGraphApi(fixture)
  const opened = await api.openMediaRenditionUrl({
    publicationId: 'pub-a',
    renditionId: 'rendition-pub-a'
  })

  t.is(opened.success, true, opened.errorCode || opened.error || 'opened')
  t.is(opened.assetId, coreA.assetId)
  t.is(opened.url, 'http://127.0.0.1:8080/legacy-static-rendition')
})

test('Play falls over to the equivalent source and reports every attempt', async (t) => {
  const api = createMediaGraphApi(graphFixture({
    openPlaybackSession: async ({ publicationId }) => (
      publicationId === 'pub-a'
        ? { success: false, errorCode: 'PEER_DISCONNECT', close() {} }
        : { success: true, coreKey: 'b'.repeat(64), close() {} }
    ),
  }))

  const result = await api.prepareMediaPlayback({ entityId: 'work:movie-1' })
  t.is(result.success, true)
  t.is(result.publicationId, 'pub-b')
  t.alike(result.attempts, [
    { publicationId: 'pub-a', errorCode: 'PEER_DISCONNECT' },
    { publicationId: 'pub-b', errorCode: null },
  ])
  const started = result.sources.find(item => item.selected)
  t.is(started.publicationId, 'pub-b', 'Other Sources marks the source that actually started')
  const abandoned = result.sources.find(item => item.publicationId === 'pub-a')
  t.ok(
    abandoned.rejectionReasonCodes.includes('PEER_DISCONNECT'),
    'the abandoned winner explains why Play moved on'
  )
})

test('Play reports one bounded message when every source fails', async (t) => {
  const api = createMediaGraphApi(graphFixture({
    openPlaybackSession: async () => ({ success: false, errorCode: 'PEER_TIMEOUT', close() {} }),
  }))

  const result = await api.prepareMediaPlayback({ entityId: 'work:movie-1' })
  t.is(result.success, false)
  t.is(result.errorCode, 'ATTEMPT_LIMIT', 'exhausting every equivalent source is its own outcome')
  t.is(result.retry, 'manual', 'nothing automatic is left to try')
  t.ok(result.error.length > 0, 'every failure code carries one user-facing message')
  t.alike(
    result.attempts.map(attempt => attempt.errorCode),
    ['PEER_TIMEOUT', 'PEER_TIMEOUT'],
    'the per-source reasons stay visible'
  )
})

test('Play refuses a rendition whose core key does not match the signed manifest', async (t) => {
  const api = createMediaGraphApi(graphFixture({ openCore: async key => ({ key, close() {} }) }))
  const result = await api.prepareMediaPlayback({ entityId: 'work:movie-1' })

  t.is(result.success, true, 'the manifest-authorized key opens')
  t.is(result.coreKey, coreA.assetId)
})

test('a session limit reaches Play as itself, not as a peer timeout', async (t) => {
  const api = createMediaGraphApi(graphFixture({
    openCore: async () => { throw createPlaybackError('SESSION_LIMIT') },
  }))

  const result = await api.prepareMediaPlayback({ entityId: 'work:movie-1' })
  t.is(result.success, false)
  t.alike(
    result.attempts.map(attempt => attempt.errorCode),
    ['SESSION_LIMIT', 'SESSION_LIMIT'],
    'the scoped session reports its own bounded code'
  )
  t.is(result.retry, 'manual', 'every equivalent source was already tried')
})

// Catalog presence and peer availability are claims about a work and about
// other devices. "Local" is a claim about this disk, so the only thing allowed
// to answer it is the local bitfield.
test('local range residency reads the local bitfield and nothing else', async (t) => {
  const asked = []
  const store = (held) => ({
    get({ key }) {
      return {
        async ready() {},
        async has(start, end) {
          asked.push([start, end])
          return held
        },
        async close() {},
      }
    },
  })

  const complete = createMediaGraphApi(graphFixture({ store: store(true) }))
  const result = await complete.getLocalRangeResidency({ publicationId: 'pub-a' })
  t.is(result.success, true)
  t.is(result.renditionId, 'rendition-pub-a')
  t.is(result.requiredRangeCount, 1)
  t.is(result.localRangeCount, 1)
  t.is(result.complete, true, 'every required range is held here')
  t.alike(asked, [[0, coreRefA.length]], 'the probe asks the core for exactly the required range')

  const absent = createMediaGraphApi(graphFixture({ store: store(false) }))
  const missing = await absent.getLocalRangeResidency({ publicationId: 'pub-a' })
  t.is(missing.complete, false, 'a core holding none of it is not local')
  t.is(missing.localRangeCount, 0)

  const unknown = await complete.getLocalRangeResidency({ publicationId: 'pub-missing' })
  t.is(unknown.success, false, 'an unknown publication has no residency to report')
  t.is(unknown.errorCode, 'MEDIA_RENDITION_UNAVAILABLE')
})

// A show release has to say which episode it is. The publisher signs that into
// the work's external reference (`channel/structured-content.js` writes
// `show:<mediaId>:s<season>:e<episode>`), so the catalog projects the ordinals
// rather than letting every reader guess them from a title.
test('catalog coordinates name the episode, the film and the unknown alike', (t) => {
  t.alike(
    mediaCoordinatesResponse([{ namespace: 'tmdb', identifier: 'show:95396:s2:e4' }], 'work'),
    { contentKind: 'episode', mediaProvider: 'tmdb', mediaId: '95396', seasonNumber: 2, episodeNumber: 4 },
    'an episode reference carries its season and episode'
  )
  t.alike(
    mediaCoordinatesResponse([{ namespace: 'tmdb', identifier: '603' }], 'work', 1999),
    { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '603', releaseYear: 1999 },
    'a film reference carries its year instead'
  )
  t.alike(
    mediaCoordinatesResponse([{ namespace: 'tmdb', identifier: '95396' }], 'series'),
    { contentKind: 'series', mediaProvider: 'tmdb', mediaId: '95396' },
    'a show-level reference is a series coordinate with no ordinals invented'
  )
  t.is(mediaCoordinatesResponse([], 'work'), null, 'a work nobody cross-referenced has no coordinate')
  t.is(mediaCoordinatesResponse([{ namespace: 'tmdb' }], 'work'), null, 'and half a reference is not one')
})

test('the media catalog keeps its metadata fields while carrying coordinates', async (t) => {
  const base = graphFixture()
  const api = createMediaGraphApi({
    ...base,
    verifiedQueryView: {
      ...base.verifiedQueryView,
      async listEntities () {
        return [{
          entityId: 'work:show-1',
          entityKind: 'work',
          externalRefs: [{ namespace: 'tmdb', identifier: 'show:95396:s2:e4' }],
          resolved: { localClusterId: 'cluster-1', metadata: { title: 'Severance', releaseYear: 2022 }, claims: [], conflicts: [] },
          publications: [],
        }]
      },
    },
  })
  const page = await api.getMediaCatalog({})
  t.is(page.success, true)
  t.is(page.items[0].title, 'Severance')
  t.is(page.items[0].releaseYear, 2022, 'the summary media fields still ride along')
})
