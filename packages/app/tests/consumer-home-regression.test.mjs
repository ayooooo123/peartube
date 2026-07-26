import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HOME_RAIL_IDS,
  isResumable,
  projectHomeRails,
  projectSearchResults,
  resumeFraction,
} from '../lib/home-rails.js'

const NOW = Date.now()

function availability(state, overrides = {}) {
  return {
    state,
    observedAt: NOW,
    expiresAt: NOW + 60_000,
    requiredRangeCount: 1,
    reachableRangeCount: state === 'healthy' || state === 'limited' ? 1 : 0,
    independentPeerCount: state === 'healthy' ? 3 : state === 'limited' ? 1 : 0,
    completePeerCount: state === 'healthy' ? 3 : 0,
    offlinePlayable: false,
    archivePledged: false,
    reasonCodes: [],
    ...overrides,
  }
}

function work(entityId, overrides = {}) {
  return {
    entityId,
    entityKind: 'work',
    title: `Title ${entityId}`,
    subtitle: 'Director A',
    sources: [{ publicationId: `${entityId}-pub`, publisherId: 'publisher-1' }],
    availability: availability('healthy'),
    ...overrides,
  }
}

function railById(rails, id) {
  return rails.find(rail => rail.id === id) || null
}

function railIds(rails) {
  return rails.map(rail => rail.id)
}

test('a fresh install with no local history shows no private rails', () => {
  const rails = projectHomeRails({ items: [work('a'), work('b')], watchState: [], now: NOW })
  assert.equal(railById(rails, 'continue-watching'), null, 'nothing to continue')
  assert.equal(railById(rails, 'recommended'), null, 'nothing to recommend from')
  assert.ok(railById(rails, 'movies'), 'the catalog still has something to show')
  assert.ok(rails.every(rail => rail.items.length > 0), 'an empty rail is never rendered')
})

test('rails appear in the documented order', () => {
  const rails = projectHomeRails({
    items: [
      work('movie-1', { contentKind: 'movie', tags: ['heist'] }),
      { ...work('series-1'), entityKind: 'collection' },
    ],
    watchState: [{ entityId: 'watched', positionSeconds: 10, durationSeconds: 100, tags: ['heist'] }],
    firstSeen: { 'movie-1': NOW - 1_000 },
    now: NOW,
  })
  const order = railIds(rails)
  const expected = HOME_RAIL_IDS.filter(id => order.includes(id))
  assert.deepEqual(order, expected, 'rails keep the canonical order')
})

test('a resumed episode leads Continue Watching and carries its progress', () => {
  const rails = projectHomeRails({
    items: [work('ep-1'), work('ep-2')],
    watchState: [
      { entityId: 'ep-1', positionSeconds: 300, durationSeconds: 1_200, updatedAt: 10 },
      { entityId: 'ep-2', positionSeconds: 600, durationSeconds: 1_200, updatedAt: 20 },
    ],
    now: NOW,
  })
  const rail = railById(rails, 'continue-watching')

  assert.deepEqual(rail.items.map(item => item.entityId), ['ep-2', 'ep-1'], 'most recently touched first')
  assert.equal(rail.items[0].resume.fraction, 0.5)
  assert.equal(rail.private, true, 'Continue Watching is device-local')
})

test('a barely started and a finished title are both out of Continue Watching', () => {
  assert.equal(isResumable({ positionSeconds: 1, durationSeconds: 1_200 }), false, 'a few seconds is not resuming')
  assert.equal(isResumable({ positionSeconds: 1_190, durationSeconds: 1_200 }), false, 'the credits are not resuming')
  assert.equal(isResumable({ positionSeconds: 600, durationSeconds: 1_200, completed: true }), false)
  assert.equal(isResumable({ positionSeconds: 600, durationSeconds: 0 }), false, 'an unknown duration cannot resume')
  assert.equal(isResumable(null), false)
  assert.equal(resumeFraction({ positionSeconds: 600, durationSeconds: 1_200 }), 0.5)
})

test('recommendations come from local affinities and never from a remote call', () => {
  const rails = projectHomeRails({
    items: [
      work('match-tag', { tags: ['heist'] }),
      work('match-creator', { subtitle: 'Director B' }),
      work('unrelated', { subtitle: 'Director Z', tags: ['nature'] }),
    ],
    watchState: [{ entityId: 'seen', positionSeconds: 10, durationSeconds: 20, tags: ['heist'], creator: 'Director B' }],
    now: NOW,
  })
  const rail = railById(rails, 'recommended')

  assert.deepEqual(rail.items.map(item => item.entityId), ['match-creator', 'match-tag'], 'creator affinity outweighs one tag')
  assert.equal(rail.private, true)
  assert.equal(rail.items.some(item => item.entityId === 'unrelated'), false)
})

test('a title already in progress is not also recommended', () => {
  const rails = projectHomeRails({
    items: [work('in-progress', { tags: ['heist'] })],
    watchState: [
      { entityId: 'in-progress', positionSeconds: 300, durationSeconds: 1_200, tags: ['heist'] },
      { entityId: 'other', positionSeconds: 10, durationSeconds: 20, tags: ['heist'] },
    ],
    now: NOW,
  })
  assert.equal(railById(rails, 'continue-watching').items[0].entityId, 'in-progress')
  assert.equal(railById(rails, 'recommended'), null, 'nothing left to recommend')
})

test('Trending ranks by peers sharing now and says so instead of implying view counts', () => {
  const rails = projectHomeRails({
    items: [
      work('quiet', { availability: availability('limited') }),
      work('busy', { availability: availability('healthy', { completePeerCount: 9, independentPeerCount: 9 }) }),
      work('gone', { availability: availability('unavailable') }),
    ],
    now: NOW,
  })
  const rail = railById(rails, 'trending')

  assert.equal(rail.title, 'Trending')
  assert.match(rail.subtitle, /peers/i, 'the basis is stated, not implied')
  assert.deepEqual(rail.items.map(item => item.entityId), ['busy', 'quiet'])
  assert.equal(rail.items.some(item => item.entityId === 'gone'), false, 'nothing is sharing it')
  assert.equal(rail.private, false)
})

test('Recently Added is local first-seen, never a publisher claim', () => {
  const rails = projectHomeRails({
    items: [work('old'), work('new'), work('never-seen')],
    firstSeen: { old: NOW - 100_000, new: NOW - 10 },
    now: NOW,
  })
  const rail = railById(rails, 'recently-added')

  assert.deepEqual(
    rail.items.map(item => item.entityId),
    ['new', 'old', 'never-seen'],
    'recorded first-seen leads; anything unseen falls to a stable tail'
  )
})

test('Recently Added still renders on a fresh install with no first-seen data', () => {
  const rails = projectHomeRails({ items: [work('b'), work('a')], firstSeen: {}, now: NOW })
  const rail = railById(rails, 'recently-added')

  assert.ok(rail, 'everything is genuinely new to a fresh catalog')
  assert.deepEqual(rail.items.map(item => item.entityId), ['a', 'b'], 'ordering stays deterministic')
})
test('unavailable and artwork-less titles still appear, carrying an honest state', () => {
  const rails = projectHomeRails({
    items: [
      work('gone', { availability: availability('unavailable'), posterUrl: null }),
      work('waiting', { availability: availability('awaiting-replication') }),
    ],
    now: NOW,
  })
  const movies = railById(rails, 'movies')

  assert.deepEqual(movies.items.map(item => item.entityId), ['gone', 'waiting'], 'metadata still browses')
  assert.equal(movies.items[0].availabilityView.state, 'unavailable')
  assert.equal(movies.items[0].availabilityView.playable, false)
  assert.equal(movies.items[1].availabilityView.state, 'awaiting-replication')
})

test('duplicate publications collapse into one entity row', () => {
  const duplicated = {
    ...work('same'),
    sources: [
      { publicationId: 'pub-a', publisherId: 'publisher-1' },
      { publicationId: 'pub-b', publisherId: 'publisher-2' },
    ],
  }
  const rails = projectHomeRails({ items: [duplicated, work('same'), work('other')], now: NOW })
  const movies = railById(rails, 'movies')

  assert.deepEqual(movies.items.map(item => item.entityId), ['other', 'same'])
  assert.equal(movies.items.filter(item => item.entityId === 'same').length, 1, 'one row per entity')
})

test('a partial series still projects as a collection', () => {
  const rails = projectHomeRails({
    items: [{ ...work('season-1'), entityKind: 'collection', expectedEpisodeCount: 10, sources: [] }],
    now: NOW,
  })
  assert.equal(railById(rails, 'series').items[0].entityId, 'season-1')
  assert.equal(railById(rails, 'movies'), null, 'a collection is not a movie')
})

test('rail projection is deterministic and bounded', () => {
  const items = Array.from({ length: 40 }, (_, index) => work(`work-${String(index).padStart(2, '0')}`))
  const first = projectHomeRails({ items, now: NOW, limit: 5 })
  const second = projectHomeRails({ items: [...items].reverse(), now: NOW, limit: 5 })

  assert.deepEqual(first, second, 'input order never changes the answer')
  assert.equal(railById(first, 'movies').items.length, 5, 'rails respect their limit')
})

test('search returns merged entities, not one row per publisher upload', () => {
  const results = projectSearchResults({
    items: [
      {
        ...work('movie'),
        title: 'The Heist',
        sources: [{ publicationId: 'pub-a' }, { publicationId: 'pub-b' }, { publicationId: 'pub-c' }],
      },
      work('other', { title: 'Nature Documentary' }),
    ],
    query: 'heist',
    now: NOW,
  })

  assert.equal(results.length, 1, 'three publications are still one title')
  assert.equal(results[0].title, 'The Heist')
  assert.equal(results[0].sourceCount, 3, 'the count is detail, not extra rows')
})

test('an empty query lists the catalog and a miss returns nothing', () => {
  const items = [work('a', { title: 'Alpha' }), work('b', { title: 'Beta' })]
  assert.equal(projectSearchResults({ items, query: '', now: NOW }).length, 2)
  assert.equal(projectSearchResults({ items, query: '   ', now: NOW }).length, 2)
  assert.deepEqual(projectSearchResults({ items, query: 'zzz', now: NOW }), [])
})
