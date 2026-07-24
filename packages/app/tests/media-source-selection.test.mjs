import test from 'node:test'
import assert from 'node:assert/strict'
import { selectMediaSource, normalizeMediaSource, scoreMediaSource } from '../lib/media-source-selection.js'

test('selects playable local or cached source before unavailable publisher source', () => {
  const entity = {
    localEntityId: 'work:episode:1',
    sources: [
      {
        publicationId: 'pub-remote',
        renditionId: 'rend-remote',
        publisherId: 'publisher-b',
        publisherName: 'Publisher B',
        availabilityStatus: 'unavailable',
        formatSupported: true,
      },
      {
        publicationId: 'pub-local',
        renditionId: 'rend-local',
        publisherId: 'publisher-a',
        publisherName: 'Publisher A',
        availabilityStatus: 'local',
        localComplete: true,
        formatSupported: true,
      },
    ],
  }

  const selection = selectMediaSource(entity)

  assert.equal(selection.selectedSource.publicationId, 'pub-local')
  assert.equal(selection.alternateSources.length, 1)
  assert.equal(selection.sourceCount, 2)
})

test('keeps source-provider identity separate from playback identity', () => {
  const source = normalizeMediaSource({
    publicationId: 'publication-1',
    renditionId: 'rendition-1080p',
    publisherId: 'publisher-root-1',
    publisherName: 'Archive Node 7',
    channelKey: 'legacy-channel',
    videoId: 'legacy-video',
  })

  assert.equal(source.publisherId, 'publisher-root-1')
  assert.equal(source.publisherName, 'Archive Node 7')
  assert.equal(source.channelKey, 'legacy-channel')
  assert.equal(source.videoId, 'legacy-video')
  assert.equal(source.playbackKey, 'legacy-channel:legacy-video')
})

test('policy can prefer a publication without making unavailable sources silently win', () => {
  const entity = {
    sources: [
      { publicationId: 'preferred', publisherId: 'publisher-a', availabilityStatus: 'unavailable' },
      { publicationId: 'available', publisherId: 'publisher-b', availabilityStatus: 'available', verified: true },
    ],
  }

  const defaultSelection = selectMediaSource(entity)
  const preferredSelection = selectMediaSource(entity, { preferredPublicationId: 'preferred', allowUnavailable: true })

  assert.equal(defaultSelection.selectedSource.publicationId, 'available')
  assert.equal(preferredSelection.selectedSource.publicationId, 'preferred')
})

test('moderation-blocked source receives a hard score penalty', () => {
  const allowed = scoreMediaSource({ publicationId: 'allowed', availabilityStatus: 'available' })
  const blocked = scoreMediaSource({ publicationId: 'blocked', availabilityStatus: 'available', moderation: { action: 'blocked' } })

  assert.ok(blocked < allowed - 500)
})


test('preserves multiple renditions for the same publication and lets policy select rendition', () => {
  const selection = selectMediaSource({
    sources: [
      { publicationId: 'pub-shared', renditionId: 'rend-720', videoId: 'video-720', availabilityStatus: 'available' },
      { publicationId: 'pub-shared', renditionId: 'rend-1080', videoId: 'video-1080', availabilityStatus: 'available' },
    ],
  }, { preferredRenditionId: 'rend-1080' })

  assert.equal(selection.sourceCount, 2)
  assert.equal(selection.selectedSource.renditionId, 'rend-1080')
  assert.deepEqual(selection.sources.map((source) => source.renditionId).sort(), ['rend-1080', 'rend-720'].sort())
})
