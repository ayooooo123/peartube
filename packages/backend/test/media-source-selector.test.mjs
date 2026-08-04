import test from 'brittle'

import {
  PLAYBACK_REJECTION_CODES,
  PLAYBACK_SOURCE_SCORE_WEIGHTS,
  scorePlaybackSource,
  selectPlaybackSource,
} from '../src/media-graph/source-selector.js'
import { preparePlaybackSource } from '../src/playback/source-preparation.js'
import { PLAYBACK_ERROR_CODES } from '../src/playback/errors.js'

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

function protectedSource(publicationId, drmSystem = 'widevine', overrides = {}) {
  return source(publicationId, { protected: true, drmSystem, ...overrides })
}

function codesFor(selection, publicationId) {
  return selection.candidates.find(candidate => candidate.publicationId === publicationId)?.rejectionReasonCodes || []
}

test('the DRM rejection reason has exactly one spelling, shared with the error vocabulary', (t) => {
  t.ok(PLAYBACK_REJECTION_CODES.includes('DRM_UNSUPPORTED'), 'the selector rejects with DRM_UNSUPPORTED')
  t.ok(PLAYBACK_ERROR_CODES.includes('DRM_UNSUPPORTED'), 'Play reports the same code it was rejected for')
  t.absent(
    PLAYBACK_REJECTION_CODES.some(code => code.includes('DRM') && code !== 'DRM_UNSUPPORTED'),
    'one fact about this device has one name'
  )
})

test('a protected source this device cannot decrypt is rejected with DRM_UNSUPPORTED', (t) => {
  const capabilities = { drmSystems: ['fairplay'] }
  const selection = selectPlaybackSource([protectedSource('wv')], { now: NOW, capabilities })

  t.is(selection.selected, null, 'an unplayable protected source never becomes the Play target')
  t.alike(codesFor(selection, 'wv'), ['DRM_UNSUPPORTED'])
  t.is(selection.candidates[0].eligible, false)
  t.alike(selection.failoverOrder, [], 'and it is never a failover target either')
})

test('a protected source this device can decrypt is selectable like any other', (t) => {
  const capabilities = { drmSystems: ['widevine', 'playready'] }
  const selection = selectPlaybackSource([protectedSource('wv')], { now: NOW, capabilities })

  t.is(selection.selectedPublicationId, 'wv')
  t.alike(codesFor(selection, 'wv'), [])
  t.is(selection.candidates[0].score, scorePlaybackSource(protectedSource('wv')), 'protection is a gate, never a score input')
})

test('an unknown or absent DRM capability list supports no protected system at all', (t) => {
  const cases = [
    ['no capability object', undefined],
    ['no drm list', { codecs: ['avc1'] }],
    ['an empty list', { drmSystems: [] }],
    ['an unrecognised system name', { drmSystems: ['acme-drm', 'widevine-2'] }],
    ['a list of the wrong type', { drmSystems: 'widevine' }],
    ['non-string entries', { drmSystems: [{ name: 'widevine' }, 1] }],
    // cenc/cbcs name how the ciphertext is framed, not which CDM can license
    // it. A device that reports a scheme has still not claimed a DRM system.
    ['a protection scheme instead of a system', { drmSystems: ['cenc'] }],
    // ClearKey has no real CDM behind it, so claiming it is not enough on its
    // own: production wiring can never inject the test capability.
    ['clearkey without the test capability', { drmSystems: ['clearkey'] }],
  ]

  for (const [label, capabilities] of cases) {
    const selection = selectPlaybackSource([protectedSource('wv')], { now: NOW, capabilities })
    t.alike(codesFor(selection, 'wv'), ['DRM_UNSUPPORTED'], `${label} fails closed`)
  }

  t.is(
    selectPlaybackSource([protectedSource('ck', 'clearkey')], {
      now: NOW,
      capabilities: { drmSystems: ['clearkey'], allowClearKeyForTests: true },
    }).selectedPublicationId,
    'ck',
    'a deterministic test fixture opts in explicitly'
  )
})

test('a source that claims protection without naming a system cannot play', (t) => {
  const selection = selectPlaybackSource([source('mystery', { protected: true })], {
    now: NOW,
    capabilities: { drmSystems: ['widevine', 'fairplay', 'playready'] },
  })
  t.alike(codesFor(selection, 'mystery'), ['DRM_UNSUPPORTED'], 'there is no system to ask a CDM for')
})

test('device DRM capability cannot affect a public source in either direction', (t) => {
  const capabilities = [
    undefined,
    { drmSystems: [] },
    { drmSystems: ['widevine'] },
    { drmSystems: ['acme-drm'] },
  ]
  for (const capability of capabilities) {
    const selection = selectPlaybackSource([source('public')], { now: NOW, capabilities: capability })
    t.is(selection.selectedPublicationId, 'public', 'a public source is unaffected by DRM capability')
    t.alike(codesFor(selection, 'public'), [])
  }
})

test('an unplayable protected source is refused before any session is opened', async (t) => {
  const opened = []
  const openSession = async ({ source: candidate }) => {
    opened.push(candidate.publicationId)
    return { success: true }
  }

  const refused = await preparePlaybackSource({
    sources: [protectedSource('wv')],
    capabilities: { drmSystems: ['fairplay'] },
    openSession,
    now: () => NOW,
  })
  t.is(refused.success, false)
  t.is(refused.errorCode, 'NO_COMPATIBLE_SOURCE')
  t.alike(refused.attempts, [], 'no attempt was made')
  t.alike(opened, [], 'no asset session was ever authorized for it')
  t.alike(
    refused.candidates.find(candidate => candidate.publicationId === 'wv').rejectionReasonCodes,
    ['DRM_UNSUPPORTED'],
    'and the reason is reported without touching the asset'
  )

  const played = await preparePlaybackSource({
    sources: [protectedSource('wv')],
    capabilities: { drmSystems: ['widevine'] },
    openSession,
    now: () => NOW,
  })
  t.is(played.success, true)
  t.alike(opened, ['wv'], 'the same source opens once the device can decrypt it')
})
