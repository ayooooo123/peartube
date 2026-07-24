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
