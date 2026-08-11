import test from 'brittle'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createArchiveManager, createArchivePublisher, enqueueArchiveJob } from '../src/archive-manager.js'

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
  const calls = { upload: [], download: 0 }
  const downloader = {
    async download () { calls.download += 1; throw new Error('downloader must not run for uploads') }
  }
  const channelStub = { blobs: {}, publicBeeKey: 'pb1', getMetadata: async () => ({}) }
  const publisher = createArchivePublisher({
    identityManager: {
      getActiveIdentity: () => ({ driveKey: 'ck1', channelKey: 'ck1' }),
      getActiveChannel: async () => channelStub
    },
    uploadManager: {
      async uploadFromPath (channel, filePath, options) {
        calls.upload.push({ filePath, options })
        return { success: true, videoId: 'v1', metadata: {} }
      },
      async setThumbnailFromBuffer () { return { success: false } }
    },
    api: {},
    runtime: {},
    fs: {},
    canPublish: retentionClass => retentionClass === 'archive-pin',
  })
  const manager = createArchiveManager({ store, downloader, publisher })
  return { store, manager, calls }
}

test('uploaded episode archives via the local file, never the downloader', async function (t) {
  const { store, manager, calls } = harness()
  const dir = mkdtempSync(join(tmpdir(), 'pt-upload-job-'))
  const uploadPath = join(dir, 'severance-s01e02.mp4')
  writeFileSync(uploadPath, 'FAKE-MP4-BYTES')
  try {
    const job = await enqueueArchiveJob(store, {
      channelName: 'Severance',
      title: 'Severance S01E02',
      uploadPath,
      uploadFilename: 'severance-s01e02.mp4',
      uploadMimeType: 'video/mp4',
      uploadSize: 14,
      tmdbType: 'tv',
      tmdbId: '95396',
      tmdbSeason: '1',
      tmdbEpisode: '2',
      publish: false
    })
    t.ok(job.id, 'upload job enqueued without a URL')

    const completed = await manager.runJob(job.id)
    t.is(completed.status, 'completed')
    t.is(calls.download, 0, 'yt-dlp downloader is never invoked for uploads')
    t.is(calls.upload.length, 1, 'the uploaded file is imported once')
    t.is(calls.upload[0].filePath, uploadPath, 'imports the exact uploaded file path')
    t.is(calls.upload[0].options.contentKind, 'episode', 'TMDB episode coordinates thread through')
    t.is(calls.upload[0].options.seasonNumber, 1)
    t.is(calls.upload[0].options.episodeNumber, 2)

    t.is(completed.previewVideo.contentKind, 'episode', 'feed preview carries the coordinates')
    t.is(completed.previewVideo.classification.type, 'tv')
    t.absent(existsSync(uploadPath), 'uploaded temp file is cleaned up after import')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('uploaded movie carries movie coordinates and no season/episode', async function (t) {
  const { store, manager, calls } = harness()
  const dir = mkdtempSync(join(tmpdir(), 'pt-upload-movie-'))
  const uploadPath = join(dir, 'the-matrix.mkv')
  writeFileSync(uploadPath, 'FAKE')
  try {
    const job = await enqueueArchiveJob(store, {
      channelName: 'The Matrix',
      uploadPath,
      uploadFilename: 'the-matrix.mkv',
      uploadMimeType: 'video/x-matroska',
      tmdbType: 'movie',
      tmdbId: '603',
      publish: false
    })
    const completed = await manager.runJob(job.id)
    t.is(completed.status, 'completed')
    t.is(calls.upload[0].options.contentKind, 'movie')
    t.absent('seasonNumber' in calls.upload[0].options, 'movies carry no season')
    t.is(completed.title, 'the-matrix', 'title falls back to the uploaded filename stem')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an archive job with neither url nor upload is rejected at run time', async function (t) {
  const { store, manager } = harness()
  // Bypass enqueue validation to store a degenerate job, then ensure runJob guards.
  await store.addJob({ id: 'arch_bad', status: 'queued' }, { title: 'x' })
  await t.exception(manager.runJob('arch_bad'), /no private URL input/)
})
