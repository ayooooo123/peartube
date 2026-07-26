import test from 'brittle'

import {
  PLAYBACK_SOURCE_SCORE_WEIGHTS,
  scorePlaybackSource,
  selectPlaybackSource,
} from '../src/media-graph/source-selector.js'

const NOW = 1_700_000_000_000

function availability(overrides = {}) {
  return {
    state: 'healthy',
    observedAt: NOW,
    expiresAt: NOW + 60_000,
    requiredRangeCount: 1,
    reachableRangeCount: 1,
    independentPeerCount: 2,
    completePeerCount: 2,
    offlinePlayable: false,
    archivePledged: false,
    reasonCodes: [],
    ...overrides,
  }
}

function source(publicationId, overrides = {}) {
  return {
    publicationId,
    entityId: 'work:1',
    renditionId: `rendition-${publicationId}`,
    publicationAuthorized: true,
    availability: availability(),
    ...overrides,
  }
}

test('the playback score is the sum of its reported components', (t) => {
  const candidate = source('a', {
    availability: availability({ offlinePlayable: true }),
    expectedStartupLatencyMs: 250,
    preferred: true,
  })
  const selection = selectPlaybackSource([candidate], { now: NOW })
  const item = selection.candidates[0]
  const components = [
    item.scoreLocalCompleteness,
    item.scoreStartupReachability,
    item.scorePeerEvidence,
    item.scoreFormatSupport,
    item.scoreStartupLatency,
    item.scoreUserOverride,
  ]

  t.ok(components.every(Number.isFinite))
  t.is(item.score, components.reduce((total, value) => total + value, 0))
  t.is(item.score, scorePlaybackSource(candidate))
  t.is(item.scoreStartupLatency, 250 * PLAYBACK_SOURCE_SCORE_WEIGHTS.startupLatency)
  t.ok(item.scoreStartupLatency < 0, 'startup latency is a penalty, not a bonus')
})

test('an extreme latency claim cannot overwhelm the rest of the score', (t) => {
  const selection = selectPlaybackSource([
    source('honest', { expectedStartupLatencyMs: 10 }),
    source('absurd', { expectedStartupLatencyMs: Number.MAX_SAFE_INTEGER }),
  ], { now: NOW })

  t.is(selection.selectedPublicationId, 'honest')
  t.ok(selection.candidates.every(candidate => Number.isFinite(candidate.score)))
})

test('ordering is total: eligible sources by score, everything rejected behind them', (t) => {
  const selection = selectPlaybackSource([
    source('z-eligible', { expectedStartupLatencyMs: 900 }),
    source('a-rejected', { publicationAuthorized: false }),
    source('m-eligible', { expectedStartupLatencyMs: 10 }),
    source('b-rejected', { moderationDecision: 'blocked' }),
  ], { now: NOW })

  t.alike(
    selection.candidates.map(candidate => candidate.publicationId),
    ['m-eligible', 'z-eligible', 'a-rejected', 'b-rejected']
  )
  t.alike(
    selection.candidates.map(candidate => candidate.eligible),
    [true, true, false, false]
  )
  t.is(selection.selectedPublicationId, 'm-eligible')
})

test('an explicit source request is honoured only while that source stays eligible', (t) => {
  const sources = [
    source('best', { expectedStartupLatencyMs: 0 }),
    source('chosen', { expectedStartupLatencyMs: 900 }),
  ]
  t.is(selectPlaybackSource(sources, { now: NOW, selectedPublicationId: 'chosen' }).selectedPublicationId, 'chosen')

  const blocked = [sources[0], source('chosen', { moderationDecision: 'blocked' })]
  t.is(
    selectPlaybackSource(blocked, { now: NOW, selectedPublicationId: 'chosen' }).selectedPublicationId,
    'best',
    'a request cannot promote a source past a hard gate'
  )
})

test('an empty source list selects nothing rather than inventing a candidate', (t) => {
  const selection = selectPlaybackSource([], { now: NOW })
  t.is(selection.selected, null)
  t.is(selection.selectedPublicationId, null)
  t.alike(selection.candidates, [])
  t.alike(selection.failoverOrder, [])
})
