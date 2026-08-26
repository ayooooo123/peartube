import test from 'brittle'
import c from 'compact-encoding'

import schema from '../spec/schema/index.js'

function roundtrip(value) {
  const encoding = schema.getEncoding('@peartube/upload-video-request')
  return c.decode(encoding, c.encode(encoding, value))
}

test('upload video wire contract carries canonical episode collection metadata', t => {
  t.alike(roundtrip({
    filePath: '/fixtures/episode.mp4',
    title: 'Pilot',
    contentKind: 'episode',
    seriesId: 'show-42',
    seriesTitle: 'Authenticated Show',
    mediaProvider: 'tmdb',
    mediaId: '42',
    seasonNumber: 1,
    episodeNumber: 2,
    expectedEpisodeCount: 8,
  }), {
    filePath: '/fixtures/episode.mp4',
    title: 'Pilot',
    description: null,
    category: null,
    skipThumbnailGeneration: false,
    contentKind: 'episode',
    seriesId: 'show-42',
    seriesTitle: 'Authenticated Show',
    mediaProvider: 'tmdb',
    mediaId: '42',
    seasonNumber: 1,
    episodeNumber: 2,
    expectedEpisodeCount: 8,
  })
})

test('ordinary movie upload remains wire compatible without episode metadata', t => {
  t.alike(roundtrip({
    filePath: '/fixtures/movie.mp4',
    title: 'Movie',
  }), {
    filePath: '/fixtures/movie.mp4',
    title: 'Movie',
    description: null,
    category: null,
    skipThumbnailGeneration: false,
    contentKind: null,
    seriesId: null,
    seriesTitle: null,
    mediaProvider: null,
    mediaId: null,
    seasonNumber: 0,
    episodeNumber: 0,
    expectedEpisodeCount: 0,
  })
})
