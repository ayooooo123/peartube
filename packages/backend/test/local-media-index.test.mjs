import test from 'brittle'

import { createLocalMediaIndex } from '../src/indexing/local-index.js'

test('local media index projects coherent entities with alternate publications and provenance', (t) => {
  const index = createLocalMediaIndex()
  index.ingestRecords([
    { sourceId: 'curator:1', kind: 'publication-reference', entityRef: 'work:alpha', publicationId: 'a'.repeat(64), publisherId: '1'.repeat(64), title: 'Alpha', creator: 'Alice', collectionId: 'collection:season-1', tags: ['sci-fi'] },
    { sourceId: 'curator:2', kind: 'publication-reference', entityRef: 'work:alpha', publicationId: 'b'.repeat(64), publisherId: '2'.repeat(64), title: 'Alpha remaster', creator: 'Alice', collectionId: 'collection:season-1', tags: ['remaster'] },
  ])
  const results = index.search('alpha')
  t.is(results.length, 1)
  t.is(results[0].entityRef, 'work:alpha')
  t.is(results[0].publications.length, 2)
  t.alike(results[0].provenance.sort(), ['curator:1', 'curator:2'])
  t.is(results[0].creator, 'Alice')
})

test('local media index is bounded and does not make stale locators playable', (t) => {
  const index = createLocalMediaIndex({ maxRecords: 1 })
  index.ingestRecords([
    { sourceId: 'old', kind: 'publication-reference', entityRef: 'work:old', publicationId: 'a'.repeat(64), publisherId: '1'.repeat(64), title: 'Old' },
    { sourceId: 'new', kind: 'publication-reference', entityRef: 'work:new', publicationId: 'b'.repeat(64), publisherId: '2'.repeat(64), title: 'New', playable: false },
  ])
  t.is(index.search('old').length, 0)
  t.is(index.search('new')[0].playable, false)
})

// Cover art reaches the index as a bounded display locator, and moderation is
// applied to that locator. A record carrying one has to stay admissible: when
// it does not, media syncs fine and then stays invisible to local policy.
test('local media index admits records carrying cover art', (t) => {
  const index = createLocalMediaIndex()
  index.ingestRecords([
    { sourceId: 'curator:1', kind: 'publication-reference', entityRef: 'work:art', publicationId: 'a'.repeat(64), publisherId: '1'.repeat(64), title: 'Art', artwork: 'p2p://poster' },
  ])

  const results = index.search('art')
  t.is(results.length, 1, 'a record with cover art is admitted')
  t.is(results[0].artwork, 'p2p://poster', 'the projected entity carries the locator through')
})

test('a publisher without cover art does not blank an entity another publisher illustrated', (t) => {
  const index = createLocalMediaIndex()
  index.ingestRecords([
    { sourceId: 'curator:1', kind: 'publication-reference', entityRef: 'work:shared', publicationId: 'a'.repeat(64), publisherId: '1'.repeat(64), title: 'Shared' },
    { sourceId: 'curator:2', kind: 'publication-reference', entityRef: 'work:shared', publicationId: 'b'.repeat(64), publisherId: '2'.repeat(64), title: 'Shared', artwork: 'p2p://shared-poster' },
  ])

  t.is(index.search('shared')[0].artwork, 'p2p://shared-poster', 'the group falls back to whichever publisher knows the cover')
})

test('malformed cover art keeps a record out of the index', (t) => {
  const index = createLocalMediaIndex()
  index.ingestRecords([
    { sourceId: 'curator:1', kind: 'publication-reference', entityRef: 'work:bad', publicationId: 'a'.repeat(64), publisherId: '1'.repeat(64), title: 'Bad', artwork: [{ role: 'poster', remoteUrl: 'https://image.example/poster.jpg' }] },
    { sourceId: 'curator:2', kind: 'publication-reference', entityRef: 'work:worse', publicationId: 'b'.repeat(64), publisherId: '2'.repeat(64), title: 'Worse', artwork: 'x'.repeat(4096) },
  ])

  t.is(index.search('bad').length, 0, 'a structured list is not a display locator')
  t.is(index.search('worse').length, 0, 'an unbounded locator is refused')
})
