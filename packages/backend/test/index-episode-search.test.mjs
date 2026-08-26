import test from 'brittle'

import { episodeWorkIdentifier } from '../src/channel/structured-content.js'
import { createIndexFederation } from '../src/search/index-federation.js'

const PUBLISHER = '11'.repeat(32)
const NOW = 1_700_000_000_000

const MOVIE = Object.freeze({
  workEntityId: '1a'.repeat(32),
  publicationId: '1b'.repeat(32),
  manifestId: '1c'.repeat(32),
  title: 'Fight Club',
  releaseYear: 1999,
  renditions: Object.freeze([{ renditionId: '1d'.repeat(32), assetId: '1e'.repeat(32) }]),
})

const EPISODE = Object.freeze({
  workEntityId: '2a'.repeat(32),
  publicationId: '2b'.repeat(32),
  manifestId: '2c'.repeat(32),
  title: 'The Bear And The Maiden Fair',
  releaseYear: 2013,
  renditions: Object.freeze([
    { renditionId: '2d'.repeat(32), assetId: '2e'.repeat(32) },
    { renditionId: '2f'.repeat(32), assetId: '3a'.repeat(32) },
  ]),
})

// What the relay actually holds, keyed the way the archive writes it: a movie
// under the coordinate a movie selector carries verbatim, an episode under the
// coordinate `episodeWorkIdentifier` mints at upload time. Keying the fixture
// on the writer's own builder is the point — a search that composes the
// coordinate differently finds nothing, which is the bug this covers.
const ARCHIVE = new Map([
  ['tmdb\u0000348', MOVIE],
  [`tmdb\u0000${episodeWorkIdentifier('1399', 3, 7)}`, EPISODE],
])

const MOVIE_SELECTOR = Object.freeze({ namespace: 'tmdb', identifier: '348', kind: 'movie' })
const EPISODE_SELECTOR = Object.freeze({
  namespace: 'tmdb',
  identifier: '1399',
  kind: 'episode',
  season: 3,
  episode: 7,
})

function randomSource() {
  let value = 0
  return size => Buffer.alloc(size, ++value)
}

function rowsFor(selector) {
  if (selector.type === 'exact-external-ref') {
    const entry = ARCHIVE.get(`${selector.namespace}\u0000${selector.identifier}`)
    if (!entry) return []
    return [{
      type: 'external-ref',
      publisherId: PUBLISHER,
      sourceRecordRef: `source-${entry.workEntityId.slice(0, 8)}`,
      namespace: selector.namespace,
      identifier: selector.identifier,
      // Every archived work is a `work`, whatever kind of work it is.
      entityKind: 'work',
      entityId: entry.workEntityId,
      evidenceWeight: 10,
    }]
  }
  if (selector.type === 'publication-by-work') {
    const entry = [...ARCHIVE.values()].find(value => value.workEntityId === selector.workEntityId)
    if (!entry) return []
    return [{
      type: 'publication',
      publisherId: PUBLISHER,
      sourceRecordRef: 'publication-source',
      publicationId: entry.publicationId,
      workEntityId: entry.workEntityId,
      normalizedTitle: entry.title,
      releaseYear: entry.releaseYear,
      manifestId: entry.manifestId,
      provenanceSummary: null,
    }]
  }
  const entry = [...ARCHIVE.values()].find(value => value.publicationId === selector.publicationId)
  if (!entry) return []
  return entry.renditions.map(rendition => ({
    type: 'rendition',
    publisherId: PUBLISHER,
    sourceRecordRef: 'publication-source',
    publicationId: entry.publicationId,
    renditionId: rendition.renditionId,
    assetId: rendition.assetId,
    format: 'video/mp4',
    codec: 'avc1',
    dimensions: '1920x1080',
    mediaFeatures: null,
    byteLength: 2048,
  }))
}

function createArchiveService(indexerId = 'relay-index') {
  const selectors = []
  return {
    indexerId,
    selectors,
    async queryIndexService({ query }) {
      const selector = query.selectors[0]
      selectors.push(selector)
      return {
        queryId: query.queryId,
        results: rowsFor(selector).slice(0, query.limit),
        nextCursor: null,
        sourceRevision: '0:1',
      }
    },
  }
}

function createFederation(service, limits = {}) {
  return createIndexFederation({
    services: [service],
    cache: new Map(),
    now: () => NOW,
    limits: { randomBytes: randomSource(), ...limits },
  })
}

function candidateShape(candidate) {
  return Object.keys(candidate).sort()
}

test('an archived episode resolves through the same exact-external-ref lookup a movie takes', async t => {
  const service = createArchiveService()
  const federation = createFederation(service)
  t.teardown(() => federation.close())

  const [movie] = await federation.search({ selector: MOVIE_SELECTOR, limit: 64 })
  const episodes = await federation.search({ selector: EPISODE_SELECTOR, limit: 64 })

  t.is(episodes.length, 2, 'both renditions of the held episode are candidates')
  const [episode] = episodes
  t.is(episode.work.entityId, EPISODE.workEntityId)
  t.is(episode.work.title, EPISODE.title)
  t.is(episode.publication.publicationId, EPISODE.publicationId)
  t.is(episode.rendition.renditionId, EPISODE.renditions[0].renditionId)
  t.is(episode.asset.assetId, EPISODE.renditions[0].assetId)
  t.is(episode.verification.state, 'unverified')
  t.alike(episode.sourceIndexers, [{ indexerId: 'relay-index', observedAtMs: NOW }])
  t.alike(candidateShape(episode), candidateShape(movie), 'an episode candidate has a movie candidate\'s shape')

  // The show plus the ordinals, joined exactly as the archive named the work.
  t.alike(
    service.selectors.filter(selector => selector.type === 'exact-external-ref').map(selector => selector.identifier),
    ['348', 'show:1399:s3:e7'],
  )
  t.alike(episode.work.externalRefs, [{ namespace: 'tmdb', identifier: 'show:1399:s3:e7' }])
})

test('season and episode ordinals select: a held S3E7 is not an answer for S3E8 or S2E7', async t => {
  const federation = createFederation(createArchiveService())
  t.teardown(() => federation.close())

  t.is((await federation.search({ selector: EPISODE_SELECTOR, limit: 64 })).length, 2)
  for (const [season, episode] of [[3, 8], [2, 7], [4, 7], [3, 6]]) {
    const results = await federation.search({
      selector: { ...EPISODE_SELECTOR, season, episode },
      limit: 64,
    })
    t.alike(results, [], `S${season}E${episode} is not the archived S3E7`)
  }
})

test('an episode the relay does not hold is an empty answer, not a failure', async t => {
  const federation = createFederation(createArchiveService())
  t.teardown(() => federation.close())

  for (const selector of [
    { namespace: 'tmdb', identifier: '9999', kind: 'episode', season: 1, episode: 1 },
    { namespace: 'tvdb', identifier: '1399', kind: 'episode', season: 3, episode: 7 },
    { namespace: 'tmdb', identifier: '1399', kind: 'episode', season: 100_000, episode: 100_000 },
  ]) {
    t.alike(await federation.search({ selector, limit: 64 }), [])
  }
})

test('an episode selector without its ordinals is refused rather than answered as a series', async t => {
  const federation = createFederation(createArchiveService())
  t.teardown(() => federation.close())

  await t.exception(
    federation.search({ selector: { namespace: 'tmdb', identifier: '1399', kind: 'episode' }, limit: 64 }),
    /exact fields/,
  )
  for (const ordinals of [{ season: 0, episode: 7 }, { season: 3, episode: -1 }, { season: 1.5, episode: 7 }]) {
    await t.exception(
      federation.search({ selector: { ...EPISODE_SELECTOR, ...ordinals }, limit: 64 }),
      /positive integer/,
    )
  }
  await t.exception(
    federation.search({ selector: { ...MOVIE_SELECTOR, season: 3, episode: 7 }, limit: 64 }),
    /unsupported fields/,
  )
})

test('limit bounds an episode answer exactly as it bounds a movie answer', async t => {
  const federation = createFederation(createArchiveService())
  t.teardown(() => federation.close())

  t.is((await federation.search({ selector: EPISODE_SELECTOR, limit: 1 })).length, 1)
  t.is((await federation.search({ selector: EPISODE_SELECTOR, limit: 2 })).length, 2)
  t.is((await federation.search({ selector: MOVIE_SELECTOR, limit: 1 })).length, 1)
  await t.exception(federation.search({ selector: EPISODE_SELECTOR, limit: 0 }), /bounded limit/)
  await t.exception(federation.search({ selector: MOVIE_SELECTOR, limit: 0 }), /bounded limit/)
})

test('a movie selector still passes its identifier through untouched', async t => {
  const service = createArchiveService()
  const federation = createFederation(service)
  t.teardown(() => federation.close())

  const results = await federation.search({ selector: MOVIE_SELECTOR, limit: 64 })
  t.is(results.length, 1)
  t.is(results[0].work.entityId, MOVIE.workEntityId)
  t.is(results[0].work.title, MOVIE.title)
  t.is(results[0].work.releaseYear, 1999)
  t.alike(results[0].work.externalRefs, [{ namespace: 'tmdb', identifier: '348' }])
  t.is(service.selectors[0].identifier, '348')
  t.alike(await federation.search({ selector: { ...MOVIE_SELECTOR, identifier: '349' }, limit: 64 }), [])
})
