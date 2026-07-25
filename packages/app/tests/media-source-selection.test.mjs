import test from 'node:test'
import assert from 'node:assert/strict'

import { selectMediaSource, switchMediaSource } from '../lib/media-source-selection.js'

test('source selection keeps playback bound to selected publication and rendition', () => {
  const sources = [
    { publicationId: 'pub-a', renditionId: 'rend-a', availabilityState: 'available', rejectionReasonCodes: ['UNAUTHORIZED_PUBLICATION'], score: 10 },
    { publicationId: 'pub-b', renditionId: 'rend-b', availabilityState: 'available', rejectionReasonCodes: [], score: 5 },
  ]
  const selected = selectMediaSource(sources)
  assert.equal(selected.publicationId, 'pub-b')
  assert.deepEqual(selected.playbackRef, { publicationId: 'pub-b', renditionId: 'rend-b' })
})

test('source switching preserves entity navigation identity separately from playback identity', () => {
  const next = switchMediaSource({ entityId: 'work:alpha', playbackRef: { publicationId: 'pub-a', renditionId: 'rend-a' } }, { publicationId: 'pub-b', renditionId: 'rend-b', availabilityState: 'available', rejectionReasonCodes: [] })
  assert.equal(next.entityId, 'work:alpha')
  assert.deepEqual(next.playbackRef, { publicationId: 'pub-b', renditionId: 'rend-b' })
})

test('source selection fails closed when authorization diagnostics are missing', () => {
  const unsigned = { publicationId: 'pub-a', renditionId: 'rend-a', playable: true, score: 100 }
  assert.equal(selectMediaSource([unsigned]), null)
  assert.deepEqual(
    switchMediaSource({ entityId: 'work:alpha' }, unsigned),
    { entityId: 'work:alpha', sourceSwitchError: 'source-not-playable' },
  )
})
