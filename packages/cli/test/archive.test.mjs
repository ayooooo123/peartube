import test from 'brittle'

import { resolveRelayConfig } from '../src/config.js'
import { buildSourceId, buildWriterKeyName, classifySourceUrl } from '../src/archive/source-id.js'
import { ARCHIVE_STATUS, createArchiveState } from '../src/archive/state.js'
import { createArchiver } from '../src/archive/index.js'

function makeFakeMetaDb() {
  const map = new Map()
  return {
    map,
    async get(key) { return map.has(key) ? { value: map.get(key) } : null },
    async put(key, value) { map.set(key, value) },
    async del(key) { map.delete(key) },
    async *createReadStream({ gte, lt } = {}) {
      const keys = [...map.keys()].sort()
      for (const key of keys) {
        if (gte !== undefined && key < gte) continue
        if (lt !== undefined && key >= lt) continue
        yield { key, value: map.get(key) }
      }
    }
  }
}

function makeFakeFs(files = {}) {
  return {
    statSync: (path) => ({ size: files[path]?.length ?? 1024 }),
    readFileSync: (path) => Buffer.from(files[path] || 'thumb'),
    mkdirSync: () => {},
    rmSync: () => {}
  }
}

function makeFakeLogger() {
  const events = []
  function record(component, level) {
    return (msg, data) => events.push({ component, level, msg, data })
  }
  function level(component) {
    return {
      debug: record(component, 'debug'),
      info: record(component, 'info'),
      warn: record(component, 'warn'),
      error: record(component, 'error')
    }
  }
  return {
    events,
    archive: level('Archive'),
    runtime: level('Runtime')
  }
}

function makeFakeRuntime({ metaDb, totalBytes = 0 } = {}) {
  return {
    ctx: { metaDb, channels: new Map() },
    publicFeed: { submitChannel: async () => {} },
    cacheManager: {
      pinChannel: async () => {},
      getTotalBytes: () => totalBytes
    },
    seeder: { seedChannel: async () => {} }
  }
}

test('classifySourceUrl recognises YouTube channels, handles, and playlists', (t) => {
  t.alike(classifySourceUrl('https://www.youtube.com/@somechannel'), {
    type: 'youtube',
    normalizedUrl: 'https://www.youtube.com/@somechannel',
    identifier: '@somechannel',
    kind: 'handle'
  })
  t.alike(classifySourceUrl('https://www.youtube.com/channel/UC123abc'), {
    type: 'youtube',
    normalizedUrl: 'https://www.youtube.com/channel/UC123abc',
    identifier: 'UC123abc',
    kind: 'channel'
  })
  t.alike(classifySourceUrl('https://www.youtube.com/playlist?list=PLxyz'), {
    type: 'youtube',
    normalizedUrl: 'https://www.youtube.com/playlist?list=PLxyz',
    identifier: 'PLxyz',
    kind: 'playlist'
  })
  t.is(classifySourceUrl('https://example.com/feed').type, null)
  t.is(classifySourceUrl('not-a-url').type, null)
})

test('buildSourceId and buildWriterKeyName produce stable ids', (t) => {
  t.is(buildSourceId('youtube', 'UC123'), 'youtube:UC123')
  t.is(buildWriterKeyName('youtube:UC123'), 'peartube-archive-writer:youtube:UC123')
  t.is(buildWriterKeyName(null), null)
})

test('resolveRelayConfig parses archive sources and rejects bad urls', (t) => {
  const config = resolveRelayConfig({
    archive: {
      enabled: true,
      sources: [
        { url: 'https://www.youtube.com/@chan', label: 'Chan' },
        'https://www.youtube.com/channel/UCabc'
      ]
    }
  }, { env: {} })

  t.is(config.archive.enabled, true)
  t.is(config.archive.sources.length, 2)
  t.is(config.archive.sources[0].sourceId, 'youtube:@chan')
  t.is(config.archive.sources[0].label, 'Chan')
  t.is(config.archive.sources[1].sourceId, 'youtube:UCabc')
  t.is(typeof config.archive.tmpPath, 'string')
  t.ok(config.archive.tmpPath.length > 0)

  t.exception(() => resolveRelayConfig({
    archive: { enabled: true, sources: [{ url: 'https://example.com/feed' }] }
  }, { env: {} }), /Unsupported archive source/)

  t.exception(() => resolveRelayConfig({
    archive: { enabled: true, sources: [] }
  }, { env: {} }), /archive.sources is empty/)

  t.exception(() => resolveRelayConfig({
    archive: {
      enabled: true,
      sources: [
        { url: 'https://www.youtube.com/@dup' },
        { url: 'https://www.youtube.com/@dup' }
      ]
    }
  }, { env: {} }), /Duplicate archive source/)
})

test('archive state markFailed escalates to abandoned past maxRetries', async (t) => {
  const metaDb = makeFakeMetaDb()
  const state = createArchiveState({ metaDb })

  await state.markFailed('youtube:UC1', 'vid1', new Error('boom'), { maxRetries: 2 })
  let record = await state.getVideo('youtube:UC1', 'vid1')
  t.is(record.status, ARCHIVE_STATUS.FAILED)
  t.is(record.retries, 1)

  await state.markFailed('youtube:UC1', 'vid1', new Error('boom'), { maxRetries: 2 })
  record = await state.getVideo('youtube:UC1', 'vid1')
  t.is(record.retries, 2)
  t.is(record.status, ARCHIVE_STATUS.FAILED)

  await state.markFailed('youtube:UC1', 'vid1', new Error('boom'), { maxRetries: 2 })
  record = await state.getVideo('youtube:UC1', 'vid1')
  t.is(record.retries, 3)
  t.is(record.status, ARCHIVE_STATUS.ABANDONED)

  await state.markArchived('youtube:UC1', 'vid2', { peartubeVideoId: 'pt1', bytes: 100, title: 'T' })
  const archived = await state.getVideo('youtube:UC1', 'vid2')
  t.is(archived.status, ARCHIVE_STATUS.ARCHIVED)
  t.is(archived.peartubeVideoId, 'pt1')

  const list = await state.listVideos('youtube:UC1')
  t.is(list.length, 2)
})

test('createArchiver runOnce: archives new videos, skips already-archived, marks failed, respects budget', async (t) => {
  const metaDb = makeFakeMetaDb()
  const config = resolveRelayConfig({
    storage: { path: '/tmp/peartube-test', maxBytes: 1000 },
    archive: {
      enabled: true,
      maxRetries: 1,
      maxItems: 5,
      tmpPath: '/tmp/peartube-test/archive-tmp',
      sources: [{ url: 'https://www.youtube.com/@chan' }]
    }
  }, { env: {} })

  // Pre-mark vid-already as archived so it should be skipped.
  const state = createArchiveState({ metaDb })
  await state.markArchived('youtube:@chan', 'vid-already', { peartubeVideoId: 'pt-existing', bytes: 50, title: 'Old' })

  const listed = [
    { id: 'vid-already', title: 'Already', duration: 100, webpageUrl: 'https://yt/v?vid-already' },
    { id: 'vid-new', title: 'New', duration: 120, webpageUrl: 'https://yt/v?vid-new' },
    { id: 'vid-fail', title: 'Fail', duration: 90, webpageUrl: 'https://yt/v?vid-fail' }
  ]

  const downloads = []
  const fakeYtDlp = {
    async listVideos(url) {
      t.is(url, 'https://www.youtube.com/@chan')
      return listed
    },
    async downloadVideo(url, opts) {
      downloads.push({ url, videoId: opts.videoId })
      return {
        videoFile: `/tmp/${opts.videoId}.mp4`,
        thumbnailFile: `/tmp/${opts.videoId}.jpg`,
        infoFile: `/tmp/${opts.videoId}.info.json`
      }
    }
  }

  const uploadCalls = []
  const fakeUploadManager = {
    async uploadFromPath(channel, filePath, options) {
      uploadCalls.push({ filePath, options })
      return { success: true, videoId: `pt-${filePath.split('/').pop().replace(/\..*/, '')}` }
    },
    async setThumbnailFromBuffer() {
      return { success: true }
    }
  }

  const publishCalls = []
  const stubPublisher = {
    ensureSourceChannel: async (source) => ({
      channelKey: `chan-${source.sourceId}`,
      publicBeeKey: `bee-${source.sourceId}`
    }),
    publishVideo: async ({ source, ytEntry, files }) => {
      publishCalls.push({ sourceId: source.sourceId, ytId: ytEntry.id, file: files.videoFile })
      if (ytEntry.id === 'vid-fail') throw new Error('publish exploded')
      const result = await fakeUploadManager.uploadFromPath(null, files.videoFile, {})
      return {
        videoId: result.videoId,
        bytes: 200,
        channelKey: `chan-${source.sourceId}`,
        publicBeeKey: `bee-${source.sourceId}`
      }
    }
  }

  const runtime = makeFakeRuntime({ metaDb, totalBytes: 0 })
  const logger = makeFakeLogger()
  const fs = makeFakeFs({
    '/tmp/vid-new.mp4': 'video bytes',
    '/tmp/vid-fail.mp4': 'video bytes'
  })

  const archiver = createArchiver({
    config,
    runtime,
    logger,
    fs,
    ytDlp: fakeYtDlp,
    publisherFactory: () => stubPublisher,
    setIntervalFn: () => null,
    clearIntervalFn: () => {},
    setTimeoutFn: (fn) => fn()
  })

  t.is(archiver.enabled, true)
  await archiver.runOnce()

  t.alike(downloads.map((d) => d.videoId).sort(), ['vid-fail', 'vid-new'])
  t.alike(publishCalls.map((p) => p.ytId).sort(), ['vid-fail', 'vid-new'])

  const newRecord = await state.getVideo('youtube:@chan', 'vid-new')
  t.is(newRecord.status, ARCHIVE_STATUS.ARCHIVED)
  t.is(newRecord.peartubeVideoId, 'pt-vid-new')

  const failRecord = await state.getVideo('youtube:@chan', 'vid-fail')
  t.is(failRecord.status, ARCHIVE_STATUS.FAILED)
  t.is(failRecord.retries, 1)

  // Second runOnce should escalate vid-fail to abandoned (maxRetries=1)
  await archiver.runOnce()
  const failAfter = await state.getVideo('youtube:@chan', 'vid-fail')
  t.is(failAfter.status, ARCHIVE_STATUS.ABANDONED)

  // Source-level state record
  const sourceRecord = await state.getSource('youtube:@chan')
  t.ok(sourceRecord.lastPolledAt > 0)
})

test('createArchiver getSourcesStatus exposes per-source state for the WebUI', async (t) => {
  const metaDb = makeFakeMetaDb()
  const config = resolveRelayConfig({
    storage: { path: '/tmp/peartube-test', maxBytes: 100000 },
    archive: {
      enabled: true,
      tmpPath: '/tmp/peartube-test/archive-tmp',
      sources: [{ url: 'https://www.youtube.com/@chan', label: 'Chan' }]
    }
  }, { env: {} })

  const state = createArchiveState({ metaDb })
  await state.markArchived('youtube:@chan', 'v1', { peartubeVideoId: 'pt1', bytes: 100, title: 'A' })
  await state.markFailed('youtube:@chan', 'v2', new Error('x'), { maxRetries: 5 })
  await state.putSource('youtube:@chan', {
    url: 'https://www.youtube.com/@chan',
    type: 'youtube',
    channelKey: 'channel-key-hex',
    publicBeeKey: 'public-bee-hex',
    lastPolledAt: 1234,
    lastError: null
  })

  const archiver = createArchiver({
    config,
    runtime: makeFakeRuntime({ metaDb }),
    logger: makeFakeLogger(),
    fs: makeFakeFs(),
    ytDlp: { listVideos: async () => [], downloadVideo: async () => ({}) },
    publisherFactory: () => ({}),
    setIntervalFn: () => null,
    clearIntervalFn: () => {},
    setTimeoutFn: () => {}
  })

  const status = await archiver.getSourcesStatus()
  t.is(status.length, 1)
  t.is(status[0].sourceId, 'youtube:@chan')
  t.is(status[0].label, 'Chan')
  t.is(status[0].channelKey, 'channel-key-hex')
  t.is(status[0].publicBeeKey, 'public-bee-hex')
  t.is(status[0].lastPolledAt, 1234)
  t.alike(status[0].counts, { archived: 1, failed: 1, abandoned: 0 })
})

test('createArchiver returns no-op when disabled', async (t) => {
  const metaDb = makeFakeMetaDb()
  const config = resolveRelayConfig({}, { env: {} })
  const archiver = createArchiver({
    config,
    runtime: makeFakeRuntime({ metaDb }),
    logger: makeFakeLogger(),
    fs: makeFakeFs()
  })
  t.is(archiver.enabled, false)
  await archiver.start()
  await archiver.runOnce()
  await archiver.stop()
})

test('createArchiver budget exhaustion: stops archiving when within reserve', async (t) => {
  const metaDb = makeFakeMetaDb()
  const config = resolveRelayConfig({
    storage: { path: '/tmp/peartube-test', maxBytes: 1000 },
    archive: {
      enabled: true,
      budgetReservePercent: 5,
      tmpPath: '/tmp/peartube-test/archive-tmp',
      sources: [{ url: 'https://www.youtube.com/@chan' }]
    }
  }, { env: {} })

  const fakeYtDlp = {
    async listVideos() { return [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] },
    async downloadVideo() { throw new Error('should never be called when budget exhausted') }
  }
  const runtime = makeFakeRuntime({ metaDb, totalBytes: 999 })
  const logger = makeFakeLogger()

  const archiver = createArchiver({
    config,
    runtime,
    logger,
    fs: makeFakeFs(),
    ytDlp: fakeYtDlp,
    uploadManagerFactory: async () => ({}),
    setIntervalFn: () => null,
    clearIntervalFn: () => {},
    setTimeoutFn: (fn) => fn()
  })

  await archiver.runOnce()

  // No video records were written (budget hit before any download)
  const state = createArchiveState({ metaDb })
  t.is((await state.listVideos('youtube:@chan')).length, 0)
  const sourceRecord = await state.getSource('youtube:@chan')
  t.is(sourceRecord.archivedCount, 0)
  t.is(sourceRecord.skippedCount, 1)

  const budgetWarn = logger.events.find((e) => e.msg === 'Storage budget reached; skipping new archives')
  t.ok(budgetWarn, 'logs budget warning')
})
