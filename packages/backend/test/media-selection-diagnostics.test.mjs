import test from 'brittle'

import { projectSourceSelectionDiagnostics } from '../src/media-graph/selection-diagnostics.js'

const MAX_CLAIM_DIAGNOSTIC_IDS = 32
const MAX_INTRODUCTION_DIAGNOSTIC_IDS = 16
const MAX_SOURCE_DIAGNOSTICS = 64
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

function project(sources, options = {}) {
  return projectSourceSelectionDiagnostics(sources, { now: NOW, ...options })
}

test('diagnostics report the selector decision and its score components verbatim', (t) => {
  const diagnostics = project([
    source('selected', { expectedStartupLatencyMs: 0 }),
    source('lower', { expectedStartupLatencyMs: 900 }),
  ])

  t.alike(diagnostics.map(item => item.publicationId), ['selected', 'lower'])
  t.alike(diagnostics[0], {
    publicationId: 'selected',
    selected: true,
    eligible: true,
    selectionReasonCodes: ['SELECTED_BY_HIGHEST_SCORE'],
    rejectionReasonCodes: [],
    introductionPublisherIds: [],
    introductionIndexIds: [],
    moderationFeedIds: [],
    claimConflictIds: [],
    provenanceClaimIds: [],
    scoreLocalCompleteness: 0,
    scoreStartupReachability: 300,
    scorePeerEvidence: 200,
    scoreFormatSupport: 100,
    scoreStartupLatency: 0,
    scoreUserOverride: 0,
    stale: false,
    incomplete: false,
  })
  t.alike(diagnostics[1].selectionReasonCodes, [])
  t.alike(diagnostics[1].rejectionReasonCodes, ['LOWER_LOCAL_SCORE'])
})

test('diagnostics report preference only when it changes the winner', (t) => {
  const changed = project([
    source('preferred', { preferred: true, expectedStartupLatencyMs: 900 }),
    source('higher-score', { expectedStartupLatencyMs: 0 }),
  ])
  t.alike(changed[0].selectionReasonCodes, ['SELECTED_BY_LOCAL_PREFERENCE'])
  t.alike(changed[1].rejectionReasonCodes, ['DEPRIORITIZED_BY_LOCAL_PREFERENCE'])

  const unchanged = project([
    source('preferred', { preferred: true, expectedStartupLatencyMs: 0 }),
    source('slower', { expectedStartupLatencyMs: 900 }),
  ])
  t.alike(
    unchanged[0].selectionReasonCodes,
    ['SELECTED_BY_HIGHEST_SCORE'],
    'a preference that agreed with the score did not change anything'
  )
})

test('an explicit lower-scoring selection is local order, never a tie-break', (t) => {
  const diagnostics = project([
    source('higher', { expectedStartupLatencyMs: 0 }),
    source('selected', { expectedStartupLatencyMs: 500 }),
    source('same-score', { expectedStartupLatencyMs: 500 }),
  ], { selectedPublicationId: 'selected' })

  t.is(diagnostics.find(item => item.selected).publicationId, 'selected')
  t.alike(diagnostics.find(item => item.selected).selectionReasonCodes, ['SELECTED_BY_LOCAL_ORDER'])
})

test('hard gates are reported in precedence order and never mixed with ranking codes', (t) => {
  const diagnostics = project([
    source('blocked', {
      localPolicyDecision: 'blocked',
      moderationDecision: 'blocked',
      incomplete: true,
      archiveState: 'unarchived',
      cacheState: 'not-cached',
      availabilityState: 'unavailable',
      availability: availability({ state: 'unavailable' }),
    }),
    source('selected'),
  ])

  t.is(diagnostics[0].publicationId, 'selected')
  t.is(diagnostics[0].selected, true)
  t.is(diagnostics[1].selected, false)
  t.is(diagnostics[1].eligible, false)
  t.alike(diagnostics[1].rejectionReasonCodes, [
    'BLOCKED_BY_MODERATION',
    'BLOCKED_BY_LOCAL_POLICY',
    'INCOMPLETE_PUBLICATION',
    'NO_AVAILABLE_COPY',
  ])
  t.absent(
    diagnostics[1].rejectionReasonCodes.includes('LOWER_LOCAL_SCORE'),
    'a source that cannot play was never in the ranking to lose it'
  )
  t.is(diagnostics[1].archiveState, 'unarchived')
  t.is(diagnostics[1].cacheState, 'not-cached')
  t.is(diagnostics[1].availabilityState, 'unavailable')
  t.is(diagnostics[1].incomplete, true)
})

test('diagnostics bound and canonicalize public provenance without leaking peer PII', (t) => {
  const introductions = Array.from(
    { length: MAX_INTRODUCTION_DIAGNOSTIC_IDS + 8 },
    (_, index) => `index-${String(index).padStart(2, '0')}`,
  ).reverse()
  const claimIds = Array.from(
    { length: MAX_CLAIM_DIAGNOSTIC_IDS + 8 },
    (_, index) => `claim-${String(index).padStart(2, '0')}`,
  ).reverse()
  const diagnostics = project([source('public-source', {
    publisherId: 'publisher-root',
    introductionPublisherIds: ['publisher-z', 'publisher-root', 'publisher-z'],
    introductionIndexIds: [...introductions, introductions[0]],
    moderationFeedIds: ['moderation-z', 'moderation-a', 'moderation-z'],
    claimConflictIds: [...claimIds, claimIds[0]],
    provenanceClaimIds: [...claimIds, claimIds[1]],
    archiveState: 'archived',
    cacheState: 'cached',
    availabilityState: 'available',
    peerAvailability: {
      state: 'available',
      peerIds: ['private-peer-key'],
      addresses: ['203.0.113.99:49737'],
      networkAuthority: 'central.example',
    },
  })])
  const item = diagnostics[0]
  t.ok(item)
  if (!item) return
  const serialized = JSON.stringify(item)

  t.alike(item.introductionPublisherIds, ['publisher-root', 'publisher-z'])
  t.is(item.introductionIndexIds.length, MAX_INTRODUCTION_DIAGNOSTIC_IDS)
  t.alike(item.introductionIndexIds, introductions.slice().sort().slice(0, MAX_INTRODUCTION_DIAGNOSTIC_IDS))
  t.alike(item.moderationFeedIds, ['moderation-a', 'moderation-z'])
  t.is(item.claimConflictIds.length, MAX_CLAIM_DIAGNOSTIC_IDS)
  t.alike(item.claimConflictIds, claimIds.slice().sort().slice(0, MAX_CLAIM_DIAGNOSTIC_IDS))
  t.alike(item.provenanceClaimIds, claimIds.slice().sort().slice(0, MAX_CLAIM_DIAGNOSTIC_IDS))
  t.is(item.archiveState, 'archived')
  t.is(item.cacheState, 'cached')
  t.absent(serialized.includes('private-peer-key'))
  t.absent(serialized.includes('203.0.113.99'))
  t.absent(serialized.includes('central.example'))
})

test('diagnostics bound their output after the whole selection is resolved', (t) => {
  const sources = Array.from(
    { length: MAX_SOURCE_DIAGNOSTICS + 1 },
    (_, index) => source(`rank-${String(index).padStart(2, '0')}`, {
      expectedStartupLatencyMs: index === MAX_SOURCE_DIAGNOSTICS ? 0 : 100,
    }),
  )
  const diagnostics = project(sources, {
    networkAuthority: () => {
      throw new Error('network authority must not be consulted')
    },
  })

  t.is(diagnostics.length, MAX_SOURCE_DIAGNOSTICS)
  t.is(diagnostics[0].publicationId, `rank-${MAX_SOURCE_DIAGNOSTICS}`, 'the winner is resolved before truncation')
  t.is(diagnostics[0].selected, true)
})

test('diagnostics decide nothing: a caller-supplied selection is projected as-is', (t) => {
  const sources = [source('a', { expectedStartupLatencyMs: 900 }), source('b', { expectedStartupLatencyMs: 0 })]
  const selection = {
    candidates: [{
      publicationId: 'a',
      eligible: true,
      selected: true,
      score: 42,
      selectionReasonCodes: ['SELECTED_BY_LOCAL_ORDER'],
      rejectionReasonCodes: [],
      source: sources[0],
    }],
  }
  const diagnostics = projectSourceSelectionDiagnostics(sources, { selection })

  t.is(diagnostics.length, 1)
  t.is(diagnostics[0].publicationId, 'a')
  t.alike(diagnostics[0].selectionReasonCodes, ['SELECTED_BY_LOCAL_ORDER'])
})
