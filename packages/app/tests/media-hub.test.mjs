import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMediaHubSections,
  getMediaHubPlayableSourceItem,
  getMediaHubPlaybackKey,
  isMovieItem,
  isShowItem,
} from '../lib/media-hub.js'

const video = (overrides = {}) => ({
  id: 'video-1',
  title: 'Video 1',
  channelKey: 'channel-a',
  createdAt: '2026-01-01T00:00:00.000Z',
  duration: 120,
  thumbnailUrl: null,
  ...overrides,
})

test('classifies movies and shows only from explicit metadata', () => {
  const titleOnly = video({
    id: 'title-only',
    title: 'S99E99 title should not classify this',
    contentKind: null,
    classification: null,
  })

  assert.equal(isMovieItem(video({ contentKind: 'movie' })), true)
  assert.equal(isMovieItem(video({ classification: { type: 'movie' } })), true)
  assert.equal(isMovieItem(titleOnly), false)

  assert.equal(isShowItem(video({ contentKind: 'episode' })), true)
  assert.equal(isShowItem(video({ classification: { type: 'tv' } })), true)
  assert.equal(isShowItem(titleOnly), false)
})

test('maps semantic rails from mixed feed videos', () => {
  const legacy = video({
    id: 'legacy-1',
    title: 'Legacy upload',
    channelKey: 'legacy-channel',
    contentKind: null,
    classification: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  const episodeOne = video({
    id: 'episode-1',
    title: 'Pilot',
    channelKey: 'show-a',
    contentKind: 'episode',
    createdAt: '2026-01-02T00:00:00.000Z',
    thumbnailUrl: 'https://img.example/episode-1.jpg',
  })
  const movie = video({
    id: 'movie-1',
    title: 'Moon Archive',
    channelKey: 'movie-a',
    contentKind: 'movie',
    createdAt: '2026-01-03T00:00:00.000Z',
  })
  const episodeTwo = video({
    id: 'episode-2',
    title: 'Second episode',
    channelKey: 'show-a',
    classification: { type: 'tv' },
    createdAt: '2026-01-04T00:00:00.000Z',
  })

  const sections = buildMediaHubSections({ feedVideos: [legacy, episodeOne, movie, episodeTwo] })

  assert.equal(sections.movies.items.length, 1)
  assert.equal(sections.movies.items[0].id, 'movie-1')
  assert.equal(sections.shows.items.length, 2)
  assert.deepEqual(sections.newEpisodes.items.map((item) => item.id), ['episode-2', 'episode-1'])
  assert.deepEqual(sections.recentlySeeded.items.map((item) => item.id), [
    'episode-2',
    'movie-1',
    'episode-1',
    'legacy-1',
  ])
  assert.equal(sections.recentlySeeded.items.some((item) => item.id === 'legacy-1'), true)
  assert.equal(sections.featured.item.id, 'episode-1')
})

test('maps music and creator rails from current feed metadata', () => {
  const music = video({
    id: 'music-upload',
    title: 'Music upload',
    channelKey: 'music-channel',
    category: 'Music',
    contentKind: null,
    classification: null,
    createdAt: '2026-01-02T00:00:00.000Z',
  })
  const creator = video({
    id: 'creator-upload',
    title: 'Creator upload',
    channelKey: 'creator-channel',
    profileKind: 'creator',
    contentKind: null,
    classification: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  })

  const sections = buildMediaHubSections({ feedVideos: [creator, music] })

  assert.deepEqual(sections.musicAndCreators.items.map((item) => item.id), ['music-upload', 'creator-upload'])
})

test('sorts numeric uploadedAt newest first and uses it for featured ties', () => {
  const older = video({
    id: 'older-upload',
    uploadedAt: 1_000,
  })
  const newer = video({
    id: 'newer-upload',
    uploadedAt: 2_000,
  })

  const sections = buildMediaHubSections({ feedVideos: [older, newer] })

  assert.deepEqual(sections.allItems.map((item) => item.id), ['newer-upload', 'older-upload'])
  assert.deepEqual(sections.recentlySeeded.items.map((item) => item.id), ['newer-upload', 'older-upload'])
  assert.equal(sections.featured.item.id, 'newer-upload')
})

test('sorts equal uploadedAt items by stable playback key before input order', () => {
  const zEpisode = video({
    id: 'z-episode',
    channelKey: 'same-channel',
    title: 'Z episode',
    contentKind: 'episode',
    uploadedAt: 1_000,
  })
  const aEpisode = video({
    id: 'a-episode',
    channelKey: 'same-channel',
    title: 'A episode',
    contentKind: 'episode',
    uploadedAt: 1_000,
  })

  const sections = buildMediaHubSections({ feedVideos: [zEpisode, aEpisode] })

  assert.deepEqual(sections.allItems.map((item) => item.id), ['a-episode', 'z-episode'])
  assert.deepEqual(sections.recentlySeeded.items.map((item) => item.id), ['a-episode', 'z-episode'])
  assert.deepEqual(sections.newEpisodes.items.map((item) => item.id), ['a-episode', 'z-episode'])
})

test('backfills duplicate timestamps without replacing priority display fields', () => {
  const priority = video({
    id: 'backfilled-timestamp',
    channelKey: 'timestamp-channel',
    title: 'Priority timestamp title',
    createdAt: null,
    uploadedAt: null,
    updatedAt: null,
    indexedAt: null,
    addedAt: null,
    publishedAt: null,
  })
  const duplicate = video({
    id: 'backfilled-timestamp',
    channelKey: 'timestamp-channel',
    title: 'Feed timestamp title',
    createdAt: null,
    uploadedAt: 3_000,
  })
  const older = video({
    id: 'older-stable',
    channelKey: 'timestamp-channel',
    title: 'Older stable',
    createdAt: null,
    uploadedAt: 2_000,
  })

  const sections = buildMediaHubSections({
    recommendedVideos: [older, priority],
    feedVideos: [duplicate],
  })

  assert.deepEqual(sections.allItems.map((item) => item.id), ['backfilled-timestamp', 'older-stable'])
  assert.equal(sections.allItems[0].title, 'Priority timestamp title')
  assert.equal(sections.allItems[0].uploadedAt, 3_000)
})

test('dedupes by channel and video key while preserving priority item fields', () => {
  const recommended = video({
    id: undefined,
    videoId: 'moon-1',
    channelKey: 'movies',
    title: 'Moon Archive',
    contentKind: 'movie',
    thumbnailUrl: null,
  })
  const feed = video({
    id: undefined,
    videoId: 'moon-1',
    channelKey: 'movies',
    title: 'Moon Archive from feed',
    thumbnailUrl: 'https://img.example/moon.jpg',
  })
  const mine = video({
    id: undefined,
    videoId: 'moon-1',
    channelKey: 'movies',
    title: 'Local Moon Archive',
  })

  const sections = buildMediaHubSections({
    feedVideos: [feed],
    myVideos: [mine],
    recommendedVideos: [recommended],
  })

  assert.equal(getMediaHubPlaybackKey(recommended), 'movies:moon-1')
  assert.equal(sections.allItems.length, 1)
  assert.equal(sections.allItems[0].title, 'Moon Archive')
  assert.equal(sections.allItems[0].thumbnailUrl, 'https://img.example/moon.jpg')
  assert.equal(sections.movies.items[0].title, 'Moon Archive')
})

test('dedupes lower-priority metadata into priority stable duplicates', () => {
  const recommended = video({
    id: 'stable-movie',
    channelKey: 'movies',
    title: 'Priority title',
    contentKind: null,
    classification: null,
  })
  const feed = video({
    id: 'stable-movie',
    channelKey: 'movies',
    title: 'Feed title',
    classification: { type: 'movie' },
    thumbnailUrl: 'https://img.example/stable-movie.jpg',
  })

  const sections = buildMediaHubSections({
    feedVideos: [feed],
    recommendedVideos: [recommended],
  })

  assert.equal(sections.allItems.length, 1)
  assert.equal(sections.allItems[0].title, 'Priority title')
  assert.equal(sections.allItems[0].thumbnailUrl, 'https://img.example/stable-movie.jpg')
  assert.equal(sections.movies.items.length, 1)
  assert.equal(sections.movies.items[0].title, 'Priority title')
})

test('collapses same-source feed duplicates in recently seeded', () => {
  const first = video({
    id: 'feed-duplicate',
    channelKey: 'feed-channel',
    title: 'Feed priority title',
    thumbnailUrl: null,
  })
  const duplicate = video({
    id: 'feed-duplicate',
    channelKey: 'feed-channel',
    title: 'Feed duplicate title',
    thumbnailUrl: 'https://img.example/feed-duplicate.jpg',
  })

  const sections = buildMediaHubSections({ feedVideos: [first, duplicate] })

  assert.deepEqual(sections.recentlySeeded.items.map((item) => item.id), ['feed-duplicate'])
  assert.equal(sections.recentlySeeded.items[0].title, 'Feed priority title')
  assert.equal(sections.recentlySeeded.items[0].thumbnailUrl, 'https://img.example/feed-duplicate.jpg')
})

test('collapses same-source library duplicates in your library', () => {
  const first = video({
    id: 'library-duplicate',
    channelKey: 'library-channel',
    title: 'Library priority title',
    thumbnailUrl: null,
  })
  const duplicate = video({
    id: 'library-duplicate',
    channelKey: 'library-channel',
    title: 'Library duplicate title',
    thumbnailUrl: 'https://img.example/library-duplicate.jpg',
  })

  const sections = buildMediaHubSections({ myVideos: [first, duplicate] })

  assert.deepEqual(sections.yourLibrary.items.map((item) => item.id), ['library-duplicate'])
  assert.equal(sections.yourLibrary.items[0].title, 'Library priority title')
  assert.equal(sections.yourLibrary.items[0].thumbnailUrl, 'https://img.example/library-duplicate.jpg')
})

test('features deduped priority item with duplicate artwork backfilled', () => {
  const recommended = video({
    id: 'featured-duplicate',
    channelKey: 'featured-channel',
    title: 'Recommended title',
    thumbnailUrl: null,
  })
  const feed = video({
    id: 'featured-duplicate',
    channelKey: 'featured-channel',
    title: 'Feed title',
    thumbnailUrl: 'https://img.example/featured-duplicate.jpg',
  })

  const sections = buildMediaHubSections({
    recommendedVideos: [recommended],
    feedVideos: [feed],
  })

  assert.equal(sections.featured.item.title, 'Recommended title')
  assert.equal(sections.featured.item.thumbnailUrl, 'https://img.example/featured-duplicate.jpg')
})

test('normalizes thumbnail-only artwork for featured selection', () => {
  const noArtwork = video({
    id: 'no-artwork',
    channelKey: 'featured-artwork',
    title: 'No artwork',
    thumbnailUrl: null,
    uploadedAt: 2_000,
  })
  const thumbnailOnly = video({
    id: 'thumbnail-only',
    channelKey: 'featured-artwork',
    title: 'Thumbnail-only artwork',
    thumbnailUrl: null,
    thumbnail: 'https://img.example/thumbnail-only.jpg',
    uploadedAt: 1_000,
  })

  const sections = buildMediaHubSections({ feedVideos: [noArtwork, thumbnailOnly] })

  assert.equal(sections.featured.item.id, 'thumbnail-only')
  assert.equal(sections.featured.item.thumbnailUrl, 'https://img.example/thumbnail-only.jpg')
})

test('features equal candidates by playback key instead of input order', () => {
  const zFeatured = video({
    id: 'z-featured',
    channelKey: 'featured-key-channel',
    title: 'Z featured',
    contentKind: 'movie',
    thumbnailUrl: 'https://img.example/z-featured.jpg',
    createdAt: null,
    uploadedAt: 5_000,
  })
  const aFeatured = video({
    id: 'a-featured',
    channelKey: 'featured-key-channel',
    title: 'A featured',
    contentKind: 'movie',
    thumbnailUrl: 'https://img.example/a-featured.jpg',
    createdAt: null,
    uploadedAt: 5_000,
  })

  const sections = buildMediaHubSections({ feedVideos: [zFeatured, aFeatured] })

  assert.equal(sections.featured.item.id, 'a-featured')
})

test('normalizes progress-only continue watching entries', () => {
  const sections = buildMediaHubSections({
    continueWatching: [
      { channelKey: 'continue', videoId: 'over', title: 'Over progress', progress: 1.4 },
      { channelKey: 'continue', videoId: 'under', title: 'Under progress', progress: -0.2 },
      { channelKey: 'continue', videoId: 'valid', title: 'Valid progress', progress: 0.4 },
    ],
  })

  assert.deepEqual(
    sections.continueWatching.items.map((item) => [item.id, item.progress]),
    [
      ['over', 1],
      ['under', 0],
      ['valid', 0.4],
    ],
  )
})

test('backfills empty priority classification from duplicate classification', () => {
  const recommended = video({
    id: 'classification-duplicate',
    channelKey: 'classification-channel',
    title: 'Priority classification title',
    contentKind: null,
    classification: {},
  })
  const feed = video({
    id: 'classification-duplicate',
    channelKey: 'classification-channel',
    title: 'Duplicate classification title',
    classification: { type: 'movie' },
  })

  const sections = buildMediaHubSections({
    recommendedVideos: [recommended],
    feedVideos: [feed],
  })

  assert.equal(sections.movies.items.length, 1)
  assert.equal(sections.movies.items[0].title, 'Priority classification title')
  assert.deepEqual(sections.movies.items[0].classification, { type: 'movie' })
})

test('ignores invalid video entries instead of inventing placeholder cards', () => {
  const stable = video({
    id: 'stable-video',
    channelKey: 'stable-channel',
    title: 'Stable video',
  })

  const sections = buildMediaHubSections({
    feedVideos: [
      null,
      'not an object',
      [],
      { id: 'missing-title', channelKey: 'stable-channel' },
      { title: 'Title without identity', channelKey: 'stable-channel' },
      stable,
    ],
    myVideos: [undefined, { videoId: 'library-missing-title', channelKey: 'stable-channel' }],
    recommendedVideos: [{ path: '/tmp/no-title.mp4', channelKey: 'stable-channel' }],
  })

  assert.deepEqual(sections.allItems.map((item) => item.id), ['stable-video'])
  assert.equal(sections.allItems.some((item) => item.id === 'unknown'), false)
  assert.equal(sections.allItems.some((item) => item.playbackKey === 'local:unknown'), false)
  assert.equal(sections.allItems.some((item) => item.title === 'Untitled video'), false)
  assert.deepEqual(sections.recentlySeeded.items.map((item) => item.id), ['stable-video'])
  assert.deepEqual(sections.yourLibrary.items, [])
})

test('does not use title as playback identity fallback', () => {
  const playbackKey = getMediaHubPlaybackKey({ channelKey: 'c', title: 'Only Title' })

  assert.equal(playbackKey, 'c:unknown')
  assert.equal(playbackKey.includes('Only Title'), false)
})

test('drops title-only malformed videos', () => {
  const sections = buildMediaHubSections({
    feedVideos: [
      { channelKey: 'broken-channel', title: 'Duplicate title', uploadedAt: 1_000 },
      { channelKey: 'broken-channel', title: 'Duplicate title', uploadedAt: 2_000 },
    ],
    recommendedVideos: [
      { title: 'Recommended without stable identity' },
    ],
  })

  assert.deepEqual(sections.allItems, [])
  assert.deepEqual(sections.recentlySeeded.items, [])
})


test('keeps stable identities deduped after dropping malformed items', () => {
  const stableRecommended = video({
    id: 'stable-video',
    channelKey: 'stable-channel',
    title: 'Stable recommended',
    thumbnailUrl: null,
  })
  const stableFeed = video({
    id: 'stable-video',
    channelKey: 'stable-channel',
    title: 'Stable feed',
    thumbnailUrl: 'https://img.example/stable.jpg',
  })

  const sections = buildMediaHubSections({
    feedVideos: [
      { channelKey: 'broken-channel', title: 'Duplicate title', uploadedAt: 1_000 },
      { channelKey: 'broken-channel', title: 'Duplicate title', uploadedAt: 2_000 },
      stableFeed,
    ],
    recommendedVideos: [stableRecommended],
  })

  const stableItems = sections.allItems.filter((item) => item.playbackKey === 'stable-channel:stable-video')

  assert.equal(stableItems.length, 1)
  assert.equal(stableItems[0].title, 'Stable recommended')
  assert.equal(stableItems[0].thumbnailUrl, 'https://img.example/stable.jpg')
  assert.deepEqual(sections.recentlySeeded.items.map((item) => item.id), ['stable-video'])
})

test('normalizes continue watching without feeding content rails', () => {
  const sections = buildMediaHubSections({
    continueWatching: [
      {
        channelKey: 'show-a',
        videoId: 'episode-1',
        title: 'Episode 1',
        durationSec: 1800,
        positionSec: 450,
      },
    ],
  })

  assert.equal(sections.continueWatching.items.length, 1)
  assert.equal(sections.continueWatching.items[0].id, 'episode-1')
  assert.equal(sections.continueWatching.items[0].playbackKey, 'show-a:episode-1')
  assert.equal(sections.continueWatching.items[0].duration, 1800)
  assert.equal(sections.continueWatching.items[0].progress, 0.25)
  assert.equal(sections.movies.items.length, 0)
  assert.equal(sections.shows.items.length, 0)
})

test('returns empty media hub sections for null root input', () => {
  const sections = buildMediaHubSections(null)

  assert.equal(sections.featured.item, null)
  assert.deepEqual(sections.allItems, [])
  assert.deepEqual(sections.continueWatching.items, [])
  assert.deepEqual(sections.movies.items, [])
  assert.deepEqual(sections.shows.items, [])
  assert.deepEqual(sections.newEpisodes.items, [])
  assert.deepEqual(sections.musicAndCreators.items, [])
  assert.deepEqual(sections.recentlySeeded.items, [])
  assert.deepEqual(sections.yourLibrary.items, [])
})

test('features artwork candidates by timestamp before content type weighting', () => {
  const olderMovie = video({
    id: 'older-movie',
    channelKey: 'featured-order',
    title: 'Older movie',
    contentKind: 'movie',
    classification: { type: 'movie' },
    thumbnailUrl: 'https://img.example/older-movie.jpg',
    createdAt: null,
    uploadedAt: 1_000,
  })
  const newerUpload = video({
    id: 'newer-upload',
    channelKey: 'featured-order',
    title: 'Newer upload',
    contentKind: null,
    classification: null,
    thumbnailUrl: 'https://img.example/newer-upload.jpg',
    createdAt: null,
    uploadedAt: 2_000,
  })

  const sections = buildMediaHubSections({ feedVideos: [olderMovie, newerUpload] })

  assert.equal(sections.featured.item.id, 'newer-upload')
})

test('normalized media items preserve Home playback identity fields', () => {
  const raw = video({
    id: 'raw-id',
    videoId: 'raw-video-id',
    channelKey: 'raw-channel',
    driveKey: 'raw-drive',
    publicBeeKey: 'raw-public-bee',
    path: '/videos/raw.mp4',
    title: 'Raw playable item',
    thumbnailUrl: 'https://img.example/raw.jpg',
  })

  const sections = buildMediaHubSections({ feedVideos: [raw] })
  const item = sections.allItems[0]

  assert.equal(item.channelKey, 'raw-channel')
  assert.equal(item.videoId, 'raw-video-id')
  assert.equal(item.driveKey, 'raw-drive')
  assert.equal(item.publicBeeKey, 'raw-public-bee')
  assert.equal(item.path, '/videos/raw.mp4')
  assert.equal(item.playbackKey, 'raw-channel:raw-id')
  assert.equal(getMediaHubPlaybackKey(item), 'raw-channel:raw-id')
})

test('normalized continue watching items preserve resume playback fields', () => {
  const sections = buildMediaHubSections({
    continueWatching: [{
      channelKey: 'resume-channel',
      videoId: 'resume-video',
      title: 'Resume video',
      durationSec: 100,
      positionSec: 25,
      publicBeeKey: 'resume-public-bee',
      thumbnail: 'https://img.example/resume.jpg',
    }],
  })
  const item = sections.continueWatching.items[0]

  assert.equal(item.channelKey, 'resume-channel')
  assert.equal(item.videoId, 'resume-video')
  assert.equal(item.publicBeeKey, 'resume-public-bee')
  assert.equal(item.durationSec, 100)
  assert.equal(item.positionSec, 25)
  assert.equal(item.thumbnailUrl, 'https://img.example/resume.jpg')
  assert.equal(getMediaHubPlaybackKey(item), 'resume-channel:resume-video')
})

test('deduped playback field backfill survives source item unwrap', () => {
  const priority = video({
    id: 'backfilled-playback',
    videoId: null,
    channelKey: 'priority-channel',
    driveKey: null,
    publicBeeKey: null,
    path: null,
    title: 'Priority playback title',
    thumbnailUrl: null,
  })
  const duplicate = video({
    id: 'backfilled-playback',
    videoId: 'duplicate-video-id',
    channelKey: 'priority-channel',
    driveKey: 'duplicate-drive',
    publicBeeKey: 'duplicate-public-bee',
    path: '/videos/backfilled.mp4',
    title: 'Duplicate playback title',
    thumbnailUrl: 'https://img.example/backfilled-playback.jpg',
  })

  const sections = buildMediaHubSections({
    recommendedVideos: [priority],
    feedVideos: [duplicate],
  })
  const item = sections.allItems[0]

  assert.equal(item.title, 'Priority playback title')
  assert.equal(item.videoId, 'duplicate-video-id')
  assert.equal(item.driveKey, 'duplicate-drive')
  assert.equal(item.publicBeeKey, 'duplicate-public-bee')
  assert.equal(item.path, '/videos/backfilled.mp4')
  assert.equal(item.item.title, 'Priority playback title')
  assert.equal(item.item.videoId, 'duplicate-video-id')
  assert.equal(item.item.driveKey, 'duplicate-drive')
  assert.equal(item.item.publicBeeKey, 'duplicate-public-bee')
  assert.equal(item.item.path, '/videos/backfilled.mp4')
  assert.equal(item.thumbnailUrl, 'https://img.example/backfilled-playback.jpg')
})

test('playable source helper unwraps selected graph source without using entity id for playback', () => {
  const item = {
    id: 'work:movie:network-film',
    localEntityId: 'work:movie:network-film',
    title: 'Network Film',
    channelKey: 'entity-channel-should-not-win',
    selectedSource: {
      id: 'publication-id-should-not-win',
      publicationId: 'publication-id-should-not-win',
      videoId: 'playable-video-id',
      channelKey: 'publisher-channel',
      publicBeeKey: 'public-bee-key',
      raw: {
        id: 'raw-upload-id',
        videoId: 'playable-video-id',
        channelKey: 'publisher-channel',
        blobId: 'blob-1',
        blobsCoreKey: 'blobs-core-1',
      },
    },
  }

  const playable = getMediaHubPlayableSourceItem(item)
  assert.equal(playable.id, 'playable-video-id')
  assert.equal(playable.videoId, 'playable-video-id')
  assert.equal(playable.channelKey, 'publisher-channel')
  assert.equal(playable.publicBeeKey, 'public-bee-key')
  assert.equal(playable.blobId, 'blob-1')
  assert.notEqual(playable.id, item.localEntityId)
})

test('playable source helper preserves legacy normalized video wrappers', () => {
  const playable = getMediaHubPlayableSourceItem({
    id: 'legacy:channel-a:video-a',
    title: 'Legacy wrapped upload',
    item: {
      videoId: 'video-a',
      channelKey: 'channel-a',
      publicBeeKey: 'bee-a',
      thumbnailUrl: 'https://example.test/thumb.jpg',
    },
  })

  assert.equal(playable.id, 'video-a')
  assert.equal(playable.videoId, 'video-a')
  assert.equal(playable.channelKey, 'channel-a')
  assert.equal(playable.publicBeeKey, 'bee-a')
  assert.equal(playable.thumbnailUrl, 'https://example.test/thumb.jpg')
})

test('media hub renders resolved graph works as unified source-aware media', () => {
  const sections = buildMediaHubSections({
    resolvedEntities: [
      {
        localEntityId: 'work:movie:network-film',
        entityKind: 'work',
        contentKind: 'movie',
        preferredMetadata: { title: 'Network Film' },
        artwork: [{ role: 'poster', remoteUrl: 'https://example.test/poster.jpg' }],
        conflicts: [{ claimId: 'conflict-title' }],
        publications: [
          { publicationId: 'pub-a', renditionId: 'rend-a', publisherId: 'publisher-a', publisherName: 'Publisher A', availabilityStatus: 'available' },
          { publicationId: 'pub-b', renditionId: 'rend-b', publisherId: 'publisher-b', publisherName: 'Publisher B', availabilityStatus: 'cached', cached: true },
        ],
      },
    ],
  })

  assert.equal(sections.movies.items.length, 1)
  assert.equal(sections.movies.items[0].title, 'Network Film')
  assert.equal(sections.movies.items[0].localEntityId, 'work:movie:network-film')
  assert.equal(sections.movies.items[0].sourceCount, 2)
  assert.equal(sections.movies.items[0].publicationId, 'pub-b')
  assert.equal(sections.movies.items[0].posterUrl, 'https://example.test/poster.jpg')
  assert.equal(sections.movies.items[0].conflicts.length, 1)
})

test('media hub exposes collection and creator rails from the resolved graph', () => {
  const sections = buildMediaHubSections({
    collections: [
      {
        localEntityId: 'collection:season:show-x:s1',
        entityKind: 'collection',
        contentKind: 'season',
        preferredMetadata: { title: 'Show X Season 1' },
        items: [{ localEntityId: 'work:e1' }],
      },
    ],
    agents: [
      {
        localEntityId: 'agent:creator:one',
        entityKind: 'agent',
        preferredMetadata: { title: 'Creator One' },
        contributions: [{ publisherId: 'publisher-a', role: 'director' }],
      },
    ],
  })

  assert.equal(sections.collections.title, 'Collections')
  assert.equal(sections.collections.items[0].title, 'Show X Season 1')
  assert.equal(sections.creators.title, 'Creators')
  assert.equal(sections.creators.items[0].title, 'Creator One')
})



test('promotes collection and creator graph detail fields into serialized hub cards', () => {
  const sections = buildMediaHubSections({
    mediaGraph: {
      collections: [
        {
          localEntityId: 'collection:season:1',
          entityKind: 'collection',
          contentKind: 'season',
          preferredMetadata: { title: 'Season One' },
          items: [{ localEntityId: 'work:e1', title: 'Episode 1' }],
          missingMembers: [{ position: { season: 1, episode: 2 }, reason: 'peer claim' }],
          completeness: { known: 1, missing: 1, hasTrustedStructure: false },
        },
      ],
      creators: [
        {
          localEntityId: 'creator:director:1',
          entityKind: 'agent',
          contentKind: 'creator',
          preferredMetadata: { title: 'Director One' },
          contributions: [{ role: 'director', agentName: 'Director One', publisherId: 'publisher-a' }],
        },
      ],
    },
  })

  const collection = sections.collections.items[0]
  assert.equal(collection.items.length, 1)
  assert.equal(collection.missingMembers.length, 1)
  assert.equal(collection.completeness.hasTrustedStructure, false)

  const creator = sections.creators.items[0]
  assert.equal(creator.contributions.length, 1)
  assert.equal(creator.contributions[0].role, 'director')
  assert.equal(creator.sourcePublisherCount, 1)
})

test('dedupes graph media items against legacy playable feed entries by selected source identity', () => {
  const sections = buildMediaHubSections({
    mediaGraph: {
      works: [
        {
          localEntityId: 'work:movie:archive-1',
          entityKind: 'work',
          contentKind: 'movie',
          preferredMetadata: { title: 'Archive Movie' },
          publications: [{ publicationId: 'video-1', renditionId: 'rend-1', channelKey: 'channel-a', videoId: 'video-1', publisherName: 'Publisher', availabilityStatus: 'available' }],
        },
      ],
    },
    feedVideos: [video({ id: 'video-1', videoId: 'video-1', channelKey: 'channel-a', title: 'Archive Movie duplicate' })],
  })

  assert.equal(sections.allItems.length, 1)
  assert.equal(sections.allItems[0].localEntityId, 'work:movie:archive-1')
  assert.equal(sections.allItems[0].id, 'video-1')
})
