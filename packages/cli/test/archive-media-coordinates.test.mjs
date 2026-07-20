import test from 'brittle'
import { createArchiveManager, createArchivePublisher, deriveMediaCoordinates, enqueueArchiveJob } from '../src/archive-manager.js'

function memStore () {
  const jobs = []
  const inputs = {}
  return {
    async listJobs () { return jobs },
    async getPrivateInput (id) { return inputs[id] || null },
    async addJob (job, privateInput) { jobs.unshift(job); inputs[job.id] = privateInput; return job },
    async updateJob (id, patch) {
      const index = jobs.findIndex((job) => job.id === id)
      if (index >= 0) jobs[index] = { ...jobs[index], ...patch }
      return jobs[index] || null
    }
  }
}

function harness () {
  const store = memStore()
  const calls = { upload: [], seedChannel: [] }
  const downloader = {
    async download () {
      return { filePath: '/tmp/clip.mp4', title: 'Downloaded Title', duration: 10, size: 100, mimeType: 'video/mp4', cleanup () {} }
    }
  }
  const channelStub = { blobs: {}, publicBeeKey: 'pb1', getMetadata: async () => ({}) }
  const publisher = createArchivePublisher({
    identityManager: {
      getActiveIdentity: () => ({ driveKey: 'ck1', channelKey: 'ck1' }),
      getActiveChannel: async () => channelStub
    },
    uploadManager: {
      async uploadFromPath (channel, filePath, options) { calls.upload.push(options); return { success: true, videoId: 'v1', metadata: {} } },
      async setThumbnailFromBuffer () { return { success: false } }
    },
    api: { submitToFeed: async () => ({ success: true }) },
    runtime: {},
    fs: {}
  })
  const manager = createArchiveManager({ store, downloader, publisher })
  return { store, manager, calls }
}

test('deriveMediaCoordinates maps movie/tv and rejects partial episode coords', (t) => {
  t.alike(deriveMediaCoordinates({ tmdbType: 'movie', tmdbId: '603' }),
    { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '603' })
  t.alike(deriveMediaCoordinates({ tmdbType: 'tv', tmdbId: 1396, tmdbSeason: '1', tmdbEpisode: '3' }),
    { contentKind: 'episode', mediaProvider: 'tmdb', mediaId: '1396', seasonNumber: 1, episodeNumber: 3 })
  t.alike(deriveMediaCoordinates({ tmdbType: 'tv', tmdbId: 1396, tmdbSeason: '1' }), {}, 'tv without episode stays plain')
  t.alike(deriveMediaCoordinates({ tmdbType: 'movie' }), {}, 'no tmdbId stays plain')
  t.alike(deriveMediaCoordinates({}), {})
})

test('discover-initiated episode archive persists coordinates on record and feed preview', async (t) => {
  const { store, manager, calls } = harness()
  const job = await enqueueArchiveJob(store, {
    url: 'https://cdn.example/ep.mp4',
    title: 'Pilot',
    tmdbType: 'tv',
    tmdbId: '1396',
    tmdbSeason: '1',
    tmdbEpisode: '1',
    tmdbTitle: 'Breaking Bad',
    tmdbYear: '2008'
  })

  const completed = await manager.runJob(job.id)

  t.is(completed.status, 'completed')
  const upload = calls.upload[0]
  t.is(upload.contentKind, 'episode', 'canonical record gets contentKind')
  t.is(upload.mediaProvider, 'tmdb')
  t.is(upload.mediaId, '1396')
  t.is(upload.seasonNumber, 1)
  t.is(upload.episodeNumber, 1)

  const preview = completed.previewVideo
  t.is(preview.contentKind, 'episode', 'feed preview carries contentKind')
  t.is(preview.seasonNumber, 1)
  t.is(preview.episodeNumber, 1)
  t.is(preview.classification.type, 'tv')
  t.is(preview.classification.year, 2008)
})

test('movie archive persists movie coordinates without season/episode', async (t) => {
  const { store, manager, calls } = harness()
  const job = await enqueueArchiveJob(store, {
    url: 'https://cdn.example/movie.mp4',
    tmdbType: 'movie',
    tmdbId: '603',
    tmdbTitle: 'The Matrix',
    tmdbYear: '1999'
  })

  const completed = await manager.runJob(job.id)

  const upload = calls.upload[0]
  t.is(upload.contentKind, 'movie')
  t.is(upload.mediaId, '603')
  t.absent('seasonNumber' in upload && upload.seasonNumber != null, 'no season on a movie')
  t.is(completed.previewVideo.contentKind, 'movie')
})

test('plain URL archive (no tmdb fields) is unchanged', async (t) => {
  const { store, manager, calls } = harness()
  const job = await enqueueArchiveJob(store, { url: 'https://cdn.example/plain.mp4' })
  const completed = await manager.runJob(job.id)

  const upload = calls.upload[0]
  t.absent(upload.contentKind, 'no contentKind injected')
  t.absent(upload.mediaProvider)
  t.absent(completed.previewVideo.contentKind)
  t.absent(completed.previewVideo.classification)
})
