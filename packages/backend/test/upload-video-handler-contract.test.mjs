import test from 'brittle'

import { attachMobileHandlers } from '../src/mobile-handlers.js'

function fixture() {
  const backend = {}
  const calls = []
  attachMobileHandlers(backend, {
    api: {},
    identityManager: {
      getActiveIdentity: () => ({ driveKey: 'active-drive' }),
      getActiveChannel: async () => ({ blobs: true }),
      getIdentities: () => [],
    },
    uploadManager: {
      async uploadFromPath(channel, filePath, options) {
        calls.push({ channel, filePath, options })
        return { success: true, videoId: 'video-1' }
      },
    },
    ctx: {},
    initializeIdentityFromMnemonic: async () => ({}),
    rpc: { eventUploadProgress() {} },
    fs: {},
    path: {},
    generateAndStoreThumbnail: async () => null,
    transcoder: {},
    castTranscoder: {},
    player: 'exoplayer',
  })
  return { backend, calls }
}

test('production mobile upload handler forwards complete episode metadata to upload manager', async t => {
  const { backend, calls } = fixture()
  await backend.uploadVideo({
    filePath: '/fixtures/episode.mp4',
    title: 'Pilot',
    description: 'Episode',
    category: 'TV',
    skipThumbnailGeneration: true,
    contentKind: 'episode',
    seriesId: 'show-42',
    seriesTitle: 'Authenticated Show',
    mediaProvider: 'tmdb',
    mediaId: '42',
    seasonNumber: 1,
    episodeNumber: 2,
    expectedEpisodeCount: 8,
  })
  t.alike(calls[0].options, {
    title: 'Pilot',
    description: 'Episode',
    mimeType: 'video/mp4',
    category: 'TV',
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

test('production mobile upload handler rejects partial and non-positive episode coordinates', async t => {
  const { backend, calls } = fixture()
  await t.exception(backend.uploadVideo({
    filePath: '/fixtures/episode.mp4',
    title: 'Pilot',
    contentKind: 'episode',
    seriesId: 'show-42',
    seasonNumber: 0,
    episodeNumber: 2,
  }))
  t.is(calls.length, 0, 'invalid episode requests never reach storage')
})
