import test from 'brittle'
import { classifySource, evaluatePair, matchSources, parseSeasonEpisode } from '../src/add/bulk/matcher.js'
import { createManifest, isReadyForUpload, serializeManifest, unresolvedRows } from '../src/add/bulk/manifest.js'

const targets = [
  { id: 't1', seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: '2008-01-20', sourceProvider: 'tmdb', sourceVideoId: 'ep-101' },
  { id: 't2', seasonNumber: 1, episodeNumber: 2, title: "Cat's in the Bag...", airDate: '2008-01-27', sourceProvider: 'tmdb', sourceVideoId: 'ep-102' }
]

test('evidence precedence: stable id outranks coordinates, title, and date', (t) => {
  t.is(evaluatePair({ sourceProvider: 'tmdb', sourceVideoId: 'ep-101' }, targets[0]), 'stableId')
  t.is(evaluatePair({ providerCoords: true, seasonNumber: 1, episodeNumber: 2 }, targets[1]), 'providerCoords')
  t.is(evaluatePair({ filename: 'show.S01E01.mkv' }, targets[0]), 'embedded')
  t.is(evaluatePair({ title: 'pilot' }, targets[0]), 'title')
  t.is(evaluatePair({ airDate: '2008-01-27' }, targets[1]), 'date')
  t.is(evaluatePair({ title: 'unrelated' }, targets[0]), null)
})

test('stable id wins conflict against misleading title/date/filename evidence', (t) => {
  const sources = [
    { id: 's1', sourceProvider: 'tmdb', sourceVideoId: 'ep-102', title: 'Pilot', filename: 'S01E01.mkv', airDate: '2008-01-20' }
  ]
  const result = matchSources({ sources, targets })
  const assignment = result.assignments.find((a) => a.sourceId === 's1')
  t.is(assignment.targetId, 't2', 'stable id points to the correct target despite misleading title/filename')
  t.is(assignment.evidence, 'stableId')
  t.is(assignment.auto, true)
})

test('unique embedded tokens auto-assign but ambiguous title matches stay for review', (t) => {
  const sources = [
    { id: 's1', filename: 'show.S01E01.mkv' },
    { id: 's2', title: "Cat's in the Bag..." },
    { id: 's3', title: "Cat's in the Bag..." }
  ]
  const result = matchSources({ sources, targets })
  const auto = result.assignments.find((a) => a.sourceId === 's1')
  t.is(auto.targetId, 't1')
  t.is(auto.auto, true)
  t.absent(result.assignments.some((a) => a.sourceId === 's2' || a.sourceId === 's3'), 'ambiguous title never auto-assigns')
  t.ok(result.suggestions.some((s) => s.sourceId === 's2' && s.targetId === 't2' && s.confidence === 'review'))
  t.ok(result.unassignedSources.includes('s2') && result.unassignedSources.includes('s3'))
})
test('already-added source ids and fingerprints are excluded from assignment', (t) => {
  const sources = [
    { id: 's1', sourceProvider: 'tmdb', sourceVideoId: 'ep-101' },
    { id: 's2', fingerprint: 'sha256:abc', filename: 'S01E02.mkv' }
  ]
  const result = matchSources({
    sources,
    targets,
    alreadyAdded: { sourceIds: ['tmdb:ep-101'], fingerprints: ['sha256:abc'] }
  })
  t.alike(result.alreadyAdded.sort(), ['s1', 's2'])
  t.is(result.assignments.length, 0)
})

test('one source cannot claim two targets and duplicate target claims stay unresolved', (t) => {
  const dupeTargets = [
    { id: 't1', title: 'Pilot' },
    { id: 't2', title: 'Pilot' }
  ]
  const sources = [{ id: 's1', title: 'Pilot' }]
  const result = matchSources({ sources, targets: dupeTargets })
  t.is(result.assignments.length, 0, 'ambiguous one-to-many stays for review')
})

test('trailers and extras are classified and never auto-assigned to episodes', (t) => {
  t.is(classifySource({ title: 'Season 1 Trailer' }), 'trailer')
  t.is(classifySource({ filename: 'behind-the-scenes.mkv' }), 'extra')
  const sources = [{ id: 's1', title: 'Official Trailer', filename: 'trailer.mkv', sourceProvider: 'tmdb', sourceVideoId: 'ep-101' }]
  const result = matchSources({ sources, targets })
  t.ok(result.classified.some((row) => row.sourceId === 's1' && row.classification === 'trailer'))
  t.is(result.assignments.length, 0)
})

test('parseSeasonEpisode handles SxxExx and NxNN forms', (t) => {
  t.alike(parseSeasonEpisode('Show.S02E08.mkv'), { seasonNumber: 2, episodeNumber: 8 })
  t.alike(parseSeasonEpisode('show 1x01 pilot'), { seasonNumber: 1, episodeNumber: 1 })
  t.is(parseSeasonEpisode('no coordinates'), null)
})

test('manifest is frozen, deterministically serialized, and gates upload readiness', (t) => {
  const channelDraft = { kind: 'channel', profileKind: 'tvShow', name: 'Breaking Bad', channelTarget: { mode: 'new' } }
  const sources = [
    { id: 's1', kind: 'local', fingerprint: 'sha256:1' },
    { id: 's2', kind: 'local', fingerprint: 'sha256:2' }
  ]
  const incomplete = createManifest({ channelDraft, targets, sources, assignments: [{ sourceId: 's1', targetId: 't1', evidence: 'embedded' }] })
  t.ok(Object.isFrozen(incomplete))
  t.is(isReadyForUpload(incomplete), false)
  const rowsMissing = unresolvedRows(incomplete)
  t.ok(rowsMissing.some((row) => row.type === 'unassigned-target' && row.id === 't2'))
  t.ok(rowsMissing.some((row) => row.type === 'unassigned-source' && row.id === 's2'))

  const complete = createManifest({
    channelDraft,
    targets,
    sources,
    assignments: [
      { sourceId: 's1', targetId: 't1', evidence: 'embedded' },
      { sourceId: 's2', targetId: 't2', evidence: 'embedded' }
    ]
  })
  t.is(isReadyForUpload(complete), true)

  const a = serializeManifest(createManifest({ channelDraft, targets: [targets[1], targets[0]], sources, assignments: [], createdAt: 5, updatedAt: 5 }))
  const b = serializeManifest(createManifest({ channelDraft, targets: [targets[0], targets[1]], sources, assignments: [], createdAt: 5, updatedAt: 5 }))
  t.is(a, b, 'serialization is order-independent and deterministic')
})
