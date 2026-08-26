import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { attachMobileHandlers } from '../../backend/src/mobile-handlers.js'

const appRoot = path.resolve(import.meta.dirname, '..')

async function loadController() {
  const result = await build({
    entryPoints: [path.join(appRoot, 'lib/studio-upload-controller.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-studio-upload-'))
  const output = path.join(directory, 'controller.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  const loaded = await import(`${pathToFileURL(output).href}?instance=${Date.now()}-${Math.random()}`)
  fs.rmSync(directory, { recursive: true, force: true })
  return loaded
}

test('Studio episode controller passes bounded metadata as the AppContext eighth argument', async () => {
  const controller = await loadController()
  const calls = []
  const backend = {}
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
  const appContextUpload = async (...args) => backend.uploadVideo({
    filePath: args[0],
    title: args[1],
    description: args[2],
    category: args[4],
    skipThumbnailGeneration: args[6],
    ...args[7],
  })
  await controller.uploadStudioVideo(appContextUpload, {
    filePath: '/fixtures/episode.mp4',
    title: 'Pilot',
    mimeType: 'video/mp4',
    category: 'Entertainment',
    skipThumbnailGeneration: true,
    media: {
      enabled: true,
      seriesId: 'show-42',
      seriesTitle: 'Authenticated Show',
      tmdbId: '42',
      seasonNumber: '1',
      episodeNumber: '2',
      expectedEpisodeCount: '8',
    },
  })
  assert.equal(calls.length, 1)
  assert.deepEqual({
    contentKind: calls[0].options.contentKind,
    seriesId: calls[0].options.seriesId,
    seriesTitle: calls[0].options.seriesTitle,
    mediaProvider: calls[0].options.mediaProvider,
    mediaId: calls[0].options.mediaId,
    seasonNumber: calls[0].options.seasonNumber,
    episodeNumber: calls[0].options.episodeNumber,
    expectedEpisodeCount: calls[0].options.expectedEpisodeCount,
  }, {
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

test('Studio episode controller rejects partial/invalid combinations and leaves movies unchanged', async () => {
  const controller = await loadController()
  const calls = []
  const uploadVideo = async (...args) => {
    calls.push(args)
    return { id: 'video-1' }
  }
  await assert.rejects(controller.uploadStudioVideo(uploadVideo, {
    filePath: '/fixtures/episode.mp4',
    title: 'Pilot',
    mimeType: 'video/mp4',
    category: 'Other',
    media: {
      enabled: true,
      seriesId: 'show-42',
      seriesTitle: '',
      tmdbId: '42',
      seasonNumber: '0',
      episodeNumber: '2',
      expectedEpisodeCount: '8',
    },
  }), /series title|positive/i)
  assert.equal(calls.length, 0)

  await controller.uploadStudioVideo(uploadVideo, {
    filePath: '/fixtures/movie.mp4',
    title: 'Movie',
    mimeType: 'video/mp4',
    category: 'Other',
    media: { enabled: false },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][7], undefined)
})
