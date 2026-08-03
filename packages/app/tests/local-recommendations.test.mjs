import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  MAX_LOCAL_RECOMMENDATIONS,
  rankLocalRecommendations,
} from '../lib/local-recommendations.ts'

// A fixed clock, not the real one. The ranker takes `now` as an argument
// precisely so a test can pin it; reading the clock inside would make every
// assertion below time-dependent.
const NOW = 1_700_000_000_000
const DAY = 86_400_000

function availability(state = 'healthy', overrides = {}) {
  return {
    state,
    observedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    requiredRangeCount: 1,
    reachableRangeCount: state === 'unavailable' ? 0 : 1,
    independentPeerCount: state === 'healthy' ? 3 : 0,
    completePeerCount: state === 'healthy' ? 3 : 0,
    offlinePlayable: false,
    archivePledged: false,
    reasonCodes: [],
    ...overrides,
  }
}

function item(entityId, overrides = {}) {
  return {
    entityId,
    entityKind: 'work',
    title: `Title ${entityId}`,
    subtitle: 'Director A',
    availability: availability(),
    ...overrides,
  }
}

function watched(entityId, overrides = {}) {
  return {
    entityId,
    title: `Watched ${entityId}`,
    positionSeconds: 600,
    durationSeconds: 1_200,
    updatedAt: NOW - DAY,
    ...overrides,
  }
}

function ids(recommendations) {
  return recommendations.map(entry => entry.entityId)
}

test('the same inputs always produce the same shelf', () => {
  const items = [
    item('a', { tags: ['heist'] }),
    item('b', { subtitle: 'Director B' }),
    item('c', { tags: ['heist', 'noir'], subtitle: 'Director B' }),
  ]
  const watchState = [watched('seen', { tags: ['heist', 'noir'], creator: 'Director B' })]

  const first = rankLocalRecommendations({ items, watchState, now: NOW })
  const again = rankLocalRecommendations({ items, watchState, now: NOW })
  const reversed = rankLocalRecommendations({ items: [...items].reverse(), watchState, now: NOW })

  assert.deepEqual(first, again, 'a second call answers identically')
  assert.deepEqual(first, reversed, 'catalog arrival order never changes the answer')
  assert.deepEqual(ids(first), ['c', 'b', 'a'], 'creator plus two tags leads, then creator, then one tag')
  assert.ok(first.every(entry => entry.recommendation.score > 0), 'nothing is recommended without local evidence')
})

test('every result explains itself', () => {
  const recommendations = rankLocalRecommendations({
    items: [item('tagged', { tags: ['heist'], subtitle: 'Director Z' }), item('by-creator', { subtitle: 'Director B' })],
    watchState: [watched('seen', { title: 'The First Job', tags: ['heist'], creator: 'Director B' })],
    now: NOW,
  })
  const byId = new Map(recommendations.map(entry => [entry.entityId, entry.recommendation.reason]))

  assert.equal(byId.get('by-creator').kind, 'creator')
  assert.equal(byId.get('by-creator').creator, 'Director B')
  assert.equal(byId.get('by-creator').label, 'More from Director B')
  assert.equal(byId.get('tagged').kind, 'tag')
  assert.deepEqual(byId.get('tagged').tags, ['heist'])
  assert.equal(byId.get('tagged').label, 'Because you watched The First Job', 'the reason names a real local title')
})

test('the list is bounded by the caller and by the module', () => {
  const items = Array.from({ length: 120 }, (_, index) => item(`work-${String(index).padStart(3, '0')}`, { tags: ['heist'] }))
  const watchState = [watched('seen', { tags: ['heist'] })]

  assert.equal(rankLocalRecommendations({ items, watchState, now: NOW, limit: 5 }).length, 5)
  assert.equal(
    rankLocalRecommendations({ items, watchState, now: NOW, limit: 1_000 }).length,
    MAX_LOCAL_RECOMMENDATIONS,
    'a caller cannot ask for an unbounded shelf',
  )
  assert.deepEqual(rankLocalRecommendations({ items, watchState, now: NOW, limit: 0 }), [])
})

test('a finished title is not recommended back', () => {
  const recommendations = rankLocalRecommendations({
    items: [item('finished', { tags: ['heist'] }), item('fresh', { tags: ['heist'] })],
    watchState: [
      watched('finished', { tags: ['heist'], completed: true, positionSeconds: 1_200 }),
      watched('other', { tags: ['heist'] }),
    ],
    now: NOW,
  })

  assert.deepEqual(ids(recommendations), ['fresh'], 'watching it is why the rail exists, not a reason to repeat it')
})

test('a title the caller already shows elsewhere is excluded', () => {
  const recommendations = rankLocalRecommendations({
    items: [item('resuming', { tags: ['heist'] }), item('fresh', { tags: ['heist'] })],
    watchState: [watched('seen', { tags: ['heist'] })],
    exclude: new Set(['resuming']),
    now: NOW,
  })

  assert.deepEqual(ids(recommendations), ['fresh'], 'Continue Watching and Recommended never show one title twice')
})

test('blocked and unavailable titles are never recommended', () => {
  const recommendations = rankLocalRecommendations({
    items: [
      item('blocked-flag', { tags: ['heist'], blocked: true }),
      item('blocked-moderation', { tags: ['heist'], moderation: { action: 'blocked' } }),
      item('hidden-moderation', { tags: ['heist'], policyDecision: { action: 'hidden' } }),
      item('gone', { tags: ['heist'], availability: availability('unavailable') }),
      item('expired', { tags: ['heist'], availability: availability('healthy', { observedAt: NOW - 120_000, expiresAt: NOW - 60_000 }) }),
      item('playable', { tags: ['heist'] }),
      item('offline-copy', { tags: ['heist'], availability: availability('unavailable', { offlinePlayable: true }) }),
    ],
    watchState: [watched('seen', { tags: ['heist'] })],
    now: NOW,
  })

  assert.deepEqual(
    ids(recommendations).sort(),
    ['offline-copy', 'playable'],
    'a blocked, hidden, gone, or expired title is out; a downloaded copy still plays',
  )
})

test('ties resolve by title then entity id, never by input order', () => {
  const tie = { tags: ['heist'], subtitle: 'Director Z' }
  const items = [
    item('z-id', { ...tie, title: 'Same Title' }),
    item('a-id', { ...tie, title: 'Same Title' }),
    item('m-id', { ...tie, title: 'Another Title' }),
  ]
  const watchState = [watched('seen', { tags: ['heist'] })]

  const forward = rankLocalRecommendations({ items, watchState, now: NOW })
  const backward = rankLocalRecommendations({ items: [...items].reverse(), watchState, now: NOW })

  assert.deepEqual(ids(forward), ['m-id', 'a-id', 'z-id'])
  assert.deepEqual(ids(forward), ids(backward), 'equal scores still order the same way')
  assert.equal(new Set(forward.map(entry => entry.recommendation.score)).size, 1, 'the ordering above really is a tie')
})

test('recency and completion weight the same tag differently', () => {
  const items = [item('recent-taste', { tags: ['heist'] }), item('old-taste', { tags: ['noir'] })]
  const recommendations = rankLocalRecommendations({
    items,
    watchState: [
      watched('recent', { tags: ['heist'], updatedAt: NOW - DAY, completed: true, positionSeconds: 1_200 }),
      watched('ancient', { tags: ['noir'], updatedAt: NOW - 400 * DAY, positionSeconds: 30 }),
    ],
    now: NOW,
  })

  assert.deepEqual(ids(recommendations), ['recent-taste', 'old-taste'], 'what was just finished outweighs what was opened years ago')
  assert.ok(
    recommendations[0].recommendation.score > recommendations[1].recommendation.score,
    'the weighting is in the score, not only in the order',
  )
})

test('empty local state produces nothing to render', () => {
  const items = [item('a', { tags: ['heist'] }), item('b')]

  assert.deepEqual(rankLocalRecommendations({ items, watchState: [], now: NOW }), [], 'a fresh install has no private rail')
  assert.deepEqual(rankLocalRecommendations({ items, now: NOW }), [])
  assert.deepEqual(rankLocalRecommendations({ now: NOW }), [])
  assert.deepEqual(
    rankLocalRecommendations({ items, watchState: [watched('seen')], now: NOW }),
    [],
    'watch state with no tag and no creator is no evidence at all',
  )
  assert.deepEqual(
    rankLocalRecommendations({ items, watchState: [{ positionSeconds: 10, durationSeconds: 20, tags: ['heist'] }], now: NOW }),
    [],
    'an entry with no identity cannot contribute an affinity',
  )
})

test('a caller that forgets `now` is told, not silently given epoch zero', () => {
  // Ranking is pure and cannot reach the clock, so there is no honest default.
  // Coercing a missing `now` to 0 used to put every watched title inside the
  // seven-day bucket, which is recency weighting switched off without a word.
  const items = [item('recent-taste', { tags: ['heist'] }), item('old-taste', { tags: ['noir'] })]
  const watchState = [
    watched('recent', { tags: ['heist'], updatedAt: NOW - DAY }),
    watched('ancient', { tags: ['noir'], updatedAt: NOW - 400 * DAY }),
  ]

  for (const omitted of [{}, { now: undefined }, { now: null }, { now: Number.NaN }, { now: '1700000000000' }]) {
    assert.throws(
      () => rankLocalRecommendations({ items, watchState, ...omitted }),
      (error) => error instanceof TypeError && /finite `now`/.test(error.message),
      `a ${JSON.stringify(omitted)} clock must be refused, never coerced`,
    )
  }
  assert.throws(() => rankLocalRecommendations(), TypeError, 'no options at all is the same programming error')

  // The caller that does pass a clock still gets the weighting the omitted
  // case would have flattened: recent taste outranks decade-old taste.
  const ranked = rankLocalRecommendations({ items, watchState, now: NOW })
  assert.deepEqual(ids(ranked), ['recent-taste', 'old-taste'])
  assert.ok(
    ranked[0].recommendation.score > ranked[1].recommendation.score,
    'a real clock separates the two; epoch zero would have tied them',
  )
})

test('a long history stays bounded on the way in', () => {
  const watchState = Array.from({ length: 400 }, (_, index) => watched(`seen-${String(index).padStart(3, '0')}`, {
    tags: [index < 200 ? 'recent-tag' : 'ancient-tag'],
    updatedAt: NOW - index * DAY,
  }))
  const recommendations = rankLocalRecommendations({
    items: [item('recent-match', { tags: ['recent-tag'] }), item('ancient-match', { tags: ['ancient-tag'] })],
    watchState,
    now: NOW,
  })

  assert.deepEqual(ids(recommendations), ['recent-match'], 'only the bounded, most recent slice of history is consulted')
})

test('the ranker issues no request and reports nothing', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'local-recommendations.ts'), 'utf8')

  for (const forbidden of [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /\bWebSocket\b/,
    /\brpc\b/,
    /logWatchEvent/,
    /getRecommendations/,
    /analytics/i,
    /telemetry/i,
    /\bbeacon\b/i,
    /\bimport\s*\(/,
    /require\s*\(/,
  ]) {
    assert.doesNotMatch(source, forbidden, `the ranker must not contain ${forbidden}`)
  }
  // `now` is an argument, so reading the clock here would be a bug rather than
  // a convenience: it would make the same local state rank two different ways.
  assert.doesNotMatch(source, /Date\.now\s*\(/, 'ranking never reads the clock')
  assert.deepEqual(
    source.match(/^import .*$/gm),
    ["import { describeAvailability } from './media-availability.js'"],
    'the only dependency is the shared, pure availability description',
  )
})

test('Home consumes this ranker and keeps no second one', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'home-rails.js'), 'utf8')

  assert.match(source, /import \{ rankLocalRecommendations \} from '\.\/local-recommendations\.ts'/)
  assert.match(source, /rankLocalRecommendations\(\{/)
  assert.doesNotMatch(source, /affinities/, 'the inline affinity ranker is gone, not merely unused')
})
