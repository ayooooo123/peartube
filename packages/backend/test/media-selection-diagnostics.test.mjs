import test from 'brittle'

import { projectSourceSelectionDiagnostics } from '../src/media-graph/selection-diagnostics.js'
import { selectPublicationSources } from '../src/media-graph/source-selector.js'

const MAX_CLAIM_DIAGNOSTIC_IDS = 32
const MAX_INTRODUCTION_DIAGNOSTIC_IDS = 16
const MAX_SOURCE_DIAGNOSTICS = 64

test('selection diagnostics preserves ranking and exposes stable component scores', (t) => {
  const ranked = selectPublicationSources([
    {
      publicationId: 'selected',
      preferred: true,
      metadataConfidence: 10,
      publisherTrust: 2,
      availabilityScore: 3,
      formatSupport: 4,
      moderationPenalty: 1,
    },
    {
      publicationId: 'lower',
      metadataConfidence: 1,
    },
  ])
  const diagnostics = projectSourceSelectionDiagnostics(ranked)

  t.alike(diagnostics.map(item => item.publicationId), ranked.map(item => item.publicationId))
  if (diagnostics.length < 2) return
  t.alike(diagnostics[0], {
    publicationId: 'selected',
    selected: true,
    selectionReasonCodes: ['SELECTED_BY_HIGHEST_SCORE'],
    rejectionReasonCodes: [],
    introductionPublisherIds: [],
    introductionIndexIds: [],
    moderationFeedIds: [],
    claimConflictIds: [],
    provenanceClaimIds: [],
    scoreMetadataConfidence: 20,
    scorePublisherTrust: 20,
    scoreAvailability: 12,
    scoreFormatSupport: 12,
    scoreModerationPenalty: -20,
    stale: false,
    incomplete: false,
  })
  t.alike(diagnostics[1].selectionReasonCodes, [])
  t.alike(diagnostics[1].rejectionReasonCodes, ['LOWER_LOCAL_SCORE'])
})

test('selection diagnostics reports preference only when it changes the local winner', (t) => {
  const diagnostics = projectSourceSelectionDiagnostics([
    { publicationId: 'preferred', preferred: true, metadataConfidence: 1 },
    { publicationId: 'higher-score', metadataConfidence: 2 },
  ])

  t.alike(diagnostics[0].selectionReasonCodes, ['SELECTED_BY_LOCAL_PREFERENCE'])
  t.alike(diagnostics[1].rejectionReasonCodes, ['DEPRIORITIZED_BY_LOCAL_PREFERENCE'])
})

test('selection diagnostics compares the same weighted components it exposes', (t) => {
  const diagnostics = projectSourceSelectionDiagnostics([
    { publicationId: 'selected', score: -1000, metadataConfidence: 10 },
    { publicationId: 'alternative', score: 1000, metadataConfidence: 1 },
  ])

  t.alike(diagnostics[0].selectionReasonCodes, ['SELECTED_BY_HIGHEST_SCORE'])
  t.alike(diagnostics[1].rejectionReasonCodes, ['LOWER_LOCAL_SCORE'])
  t.is(diagnostics[0].scoreMetadataConfidence, 20)
  t.is(diagnostics[1].scoreMetadataConfidence, 2)
})

test('selection diagnostics does not call a lower-score explicit selection a tie-break', (t) => {
  const diagnostics = projectSourceSelectionDiagnostics([
    { publicationId: 'higher', metadataConfidence: 3 },
    { publicationId: 'selected', metadataConfidence: 1 },
    { publicationId: 'same-score', metadataConfidence: 1 },
  ], { selectedPublicationId: 'selected' })

  t.alike(diagnostics[1].selectionReasonCodes, ['SELECTED_BY_LOCAL_ORDER'])
})

test('selection diagnostics explains selected and rejected alternatives in explicit precedence order', (t) => {
  const sources = selectPublicationSources([
    {
      publicationId: 'blocked',
      localPolicyDecision: 'blocked',
      moderationDecision: 'blocked',
      stale: true,
      incomplete: true,
      archiveState: 'unarchived',
      cacheState: 'not-cached',
      peerAvailability: { state: 'unavailable' },
      metadataConfidence: 1,
    },
    {
      publicationId: 'selected',
      preferred: true,
      metadataConfidence: 2,
    },
  ])
  const diagnostics = projectSourceSelectionDiagnostics(sources)
  t.is(diagnostics.length, 2)
  if (diagnostics.length < 2) return

  t.is(diagnostics[0].publicationId, 'selected')
  t.is(diagnostics[0].selected, true)
  t.is(diagnostics[1].selected, false)
  t.alike(diagnostics[1].rejectionReasonCodes, [
    'BLOCKED_BY_LOCAL_POLICY',
    'BLOCKED_BY_MODERATION',
    'STALE_AVAILABILITY',
    'INCOMPLETE_PUBLICATION',
    'NO_AVAILABLE_COPY',
    'LOWER_LOCAL_SCORE',
  ])
  t.is(diagnostics[1].archiveState, 'unarchived')
  t.is(diagnostics[1].cacheState, 'not-cached')
  t.is(diagnostics[1].availabilityState, 'unavailable')
  t.is(diagnostics[1].stale, true)
  t.is(diagnostics[1].incomplete, true)
})

test('selection diagnostics bounds and canonicalizes public provenance without peer PII', (t) => {
  const introductions = Array.from(
    { length: MAX_INTRODUCTION_DIAGNOSTIC_IDS + 8 },
    (_, index) => `index-${String(index).padStart(2, '0')}`,
  ).reverse()
  const claimIds = Array.from(
    { length: MAX_CLAIM_DIAGNOSTIC_IDS + 8 },
    (_, index) => `claim-${String(index).padStart(2, '0')}`,
  ).reverse()
  const diagnostics = projectSourceSelectionDiagnostics([{
    publicationId: 'public-source',
    publisherId: 'publisher-root',
    introductionPublisherIds: ['publisher-z', 'publisher-root', 'publisher-z'],
    introductionIndexIds: [...introductions, introductions[0]],
    moderationFeedIds: ['moderation-z', 'moderation-a', 'moderation-z'],
    claimConflictIds: [...claimIds, claimIds[0]],
    provenanceClaimIds: [...claimIds, claimIds[1]],
    archiveState: 'archived',
    cacheState: 'cached',
    peerAvailability: {
      state: 'available',
      peerIds: ['private-peer-key'],
      addresses: ['203.0.113.99:49737'],
      networkAuthority: 'central.example',
    },
  }])
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
  t.is(item.availabilityState, 'available')
  t.absent(serialized.includes('private-peer-key'))
  t.absent(serialized.includes('203.0.113.99'))
  t.absent(serialized.includes('central.example'))
})

test('selection diagnostics bounds output after resolving the full local selection context', (t) => {
  const sources = Array.from(
    { length: MAX_SOURCE_DIAGNOSTICS + 1 },
    (_, index) => ({ publicationId: `rank-${String(index).padStart(2, '0')}`, metadataConfidence: index === MAX_SOURCE_DIAGNOSTICS ? 2 : 1 }),
  )
  const diagnostics = projectSourceSelectionDiagnostics(sources, {
    selectedPublicationId: sources[MAX_SOURCE_DIAGNOSTICS].publicationId,
    networkAuthority: () => {
      throw new Error('network authority must not be consulted')
    },
  })

  t.is(diagnostics.length, MAX_SOURCE_DIAGNOSTICS)
  t.absent(diagnostics.some(item => item.selected))
  t.is(diagnostics[0].publicationId, sources[0].publicationId)
  t.is(diagnostics.at(-1).publicationId, sources[MAX_SOURCE_DIAGNOSTICS - 1].publicationId)

  const defaultSelection = projectSourceSelectionDiagnostics(sources)
  t.alike(defaultSelection[0].selectionReasonCodes, ['SELECTED_BY_LOCAL_ORDER'])
})
