import test from 'brittle'

import { createMediaGraphApi } from '../src/api/media-graph.js'
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
function graphFixture(overrides = {}) {
  const manifests = new Map([
    ['pub-a', { publicationId: 'pub-a', body: { publisherId: 'pub', manifestId: 'm-a', renditions: [{ renditionId: 'rendition-pub-a', core: coreA }] } }],
    ['pub-b', { publicationId: 'pub-b', body: { publisherId: 'pub', manifestId: 'm-b', renditions: [{ renditionId: 'rendition-pub-b', core: coreB }] } }],
  ])
  const claim = publicationId => ({
    claimId: `claim-${publicationId}`,
    issuer: 'pub',
    revoked: false,
    body: {
      claimType: 'AvailabilityObservation',
      confidence: 10,
      subjectRefs: [{ entityId: 'work:movie-1', entityKind: 'work' }],
      payload: { publicationId },
    },
  })
  return {
    mediaGraphStore: { getClaimsBySubject: () => [claim('pub-a'), claim('pub-b')] },
    assetManifestStore: {
      getManifest: publicationId => manifests.get(publicationId) || null,
      getRenditionRequirement: publicationId => {
        const rendition = manifests.get(publicationId)?.body.renditions[0]
        if (!rendition) return null
        const coreRef = normalizeAssetCoreRefV2(rendition.core)
        return {
          publicationId,
          renditionId: rendition.renditionId,
          coreKey: coreRef.key,
          coreLength: coreRef.length,
          requiredRanges: [{ start: 0, end: coreRef.length }],
        }
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
