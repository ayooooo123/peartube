import test from 'brittle'

import { resolveRelayConfig } from '../src/config.js'
import { buildSourceId, buildWriterKeyName, classifySourceUrl } from '../src/archive/source-id.js'
import { ARCHIVE_STATUS, createArchiveState } from '../src/archive/state.js'
import { createArchiver } from '../src/archive/index.js'
import { announceArchiveChannel, createArchivePublisher } from '../src/archive/publisher.js'
import { createYtDlpDownloader } from '../src/archive-manager.js'
import { buildDownloadArgs } from '../src/media/yt-dlp.js'

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

test('archive publisher announces and seeds after public bee content changes', async (t) => {
  const logger = makeFakeLogger()
  const calls = []
  let videoCount = 0
  const channelEntry = {
    channelKey: 'aa'.repeat(32),
    publicBeeKey: null,
    channelName: 'Configured Label',
    channel: {
      async getPublicBeeKey() {
        return 'bb'.repeat(32)
      },
      async getMetadata() {
        return { publicBeeKey: 'bb'.repeat(32) }
      },
      async listVideos() {
        return videoCount > 0
          ? [{
              id: 'local-1',
              title: 'Local 1',
              path: '/videos/local-1.mp4',
              uploadedAt: 123,
              size: 4096,
              mimeType: 'video/mp4',
              blobId: '0:4:0:4096',
              blobsCoreKey: 'cc'.repeat(32)
            }]
          : []
      }
    }
  }
  const runtime = {
    publicFeed: {
      async submitChannel(driveKey, publicBeeKey, options) {
        calls.push(['submit', driveKey, publicBeeKey, videoCount, options?.previewVideos?.map((video) => video.blobId) || [], options?.channelName || null, options?.previewVideos?.map((video) => video.channelName || null) || []])
      }
    },
    cacheManager: {
      async pinChannel(driveKey, publicBeeKey) {
        calls.push(['pin', driveKey, publicBeeKey, videoCount])
      },
      async addChannel(driveKey, publicBeeKey, source, options) {
        calls.push(['cache', driveKey, publicBeeKey, source, videoCount, options?.previewVideos?.map((video) => video.blobId) || []])
      }
    },
    seeder: {
      async seedChannel(channel) {
        calls.push(['seed', channel.driveKey, channel.publicBeeKey, videoCount, channel.previewVideos?.map((video) => video.blobId) || []])
      }
    },
    async publishRelayCatalogEntry(entry) {
      calls.push(['catalog', entry.driveKey, entry.publicBeeKey, entry.source, videoCount, entry.previewVideos?.map((video) => video.blobId) || []])
    }
  }

  await announceArchiveChannel(runtime, channelEntry, logger, 'youtube:source')
  videoCount = 1
  await announceArchiveChannel(runtime, channelEntry, logger, 'youtube:source')

  t.is(channelEntry.publicBeeKey, 'bb'.repeat(32))
  t.alike(calls, [
    ['submit', 'aa'.repeat(32), 'bb'.repeat(32), 0, [], 'Configured Label', []],
    ['pin', 'aa'.repeat(32), 'bb'.repeat(32), 0],
    ['seed', 'aa'.repeat(32), 'bb'.repeat(32), 0, []],
    ['submit', 'aa'.repeat(32), 'bb'.repeat(32), 1, ['0:4:0:4096'], 'Configured Label', ['Configured Label']],
    ['cache', 'aa'.repeat(32), 'bb'.repeat(32), 'private', 1, ['0:4:0:4096']],
    ['seed', 'aa'.repeat(32), 'bb'.repeat(32), 1, ['0:4:0:4096']],
    ['catalog', 'aa'.repeat(32), 'bb'.repeat(32), 'archive-job', 1, ['0:4:0:4096']],
  ])
})

test('archive publisher derives YouTube channel name from yt-dlp uploader metadata', async (t) => {
  const channels = []
  const source = {
    sourceId: 'youtube:UCactual',
    url: 'https://www.youtube.com/channel/UCactual',
    type: 'youtube',
    kind: 'channel',
    identifier: 'UCactual'
  }
  const channel = {
    writable: true,
    async getMetadata() { return {} },
    async updateMetadata(meta) { channels.push(meta) },
    async ensureLocalBlobDrive() {},
    async getPublicBeeKey() { return 'bb'.repeat(32) },
    async listVideos() { return [] }
  }
  const publisher = createArchivePublisher({
    ctx: {},
    uploadManager: {
      async uploadFromPath(_channel, _filePath, options) {
        return { success: true, videoId: options.title }
      },
    },
    runtime: {
      publicFeed: { async submitChannel() {} },
      cacheManager: { async pinChannel() {} },
      seeder: { async seedChannel() {} },
    },
    fs: makeFakeFs({ '/tmp/video.mp4': 'video bytes' }),
    logger: makeFakeLogger(),
    state: null,
    createChannelFn: async () => ({ channel, channelKeyHex: 'aa'.repeat(32) })
  })

  await publisher.publishVideo({
    source,
    ytEntry: { id: 'yt1', title: 'Video', uploader: 'Actual Creator', duration: 1 },
    files: { videoFile: '/tmp/video.mp4' }
  })

  t.is(channels.length, 1)
  t.is(channels[0].name, 'Actual Creator')
})
test('archive publisher uses yt-dlp info metadata and thumbnail refs for previews', async (t) => {
  const submitted = []
  const uploaded = []
  const source = {
    sourceId: 'youtube:rumble:video:v7ah96i-america-first-ep.-1690',
    url: 'https://rumble.com/v7ah96i-america-first-ep.-1690.html',
    type: 'youtube',
    kind: 'rumble-video',
    identifier: 'rumble:video:v7ah96i-america-first-ep.-1690',
    label: 'America First Full Episodes'
  }
  const channel = {
    writable: true,
    blobsKeyHex: 'dd'.repeat(32),
    async getMetadata() { return {} },
    async updateMetadata(meta) { uploaded.push(['channel-meta', meta]) },
    async ensureLocalBlobDrive() {},
    async getPublicBeeKey() { return 'bb'.repeat(32) },
    async listVideos() { return [] }
  }
  const infoJson = JSON.stringify({
    id: 'v7ah96i-america-first-ep.-1690',
    title: 'America First Ep. 1690 - Real Rumble Title',
    uploader: 'Nicholas J. Fuentes',
    webpage_url: 'https://rumble.com/v7ah96i-america-first-ep.-1690.html',
    duration: 1234,
    thumbnail: 'https://rumble.com/thumb.jpg'
  })
  const fs = makeFakeFs({
    '/tmp/video.mp4': 'video bytes',
    '/tmp/video.info.json': infoJson,
    '/tmp/video.jpg': 'jpeg bytes'
  })
  fs.existsSync = (path) => path in {
    '/tmp/video.mp4': true,
    '/tmp/video.info.json': true,
    '/tmp/video.jpg': true
  }
  const publisher = createArchivePublisher({
    ctx: {},
    uploadManager: {
      async uploadFromPath(_channel, _filePath, options) {
        uploaded.push(['video', options])
        return {
          success: true,
          videoId: 'video-1',
          metadata: {
            blobId: '0:1:0:10',
            blobsCoreKey: 'cc'.repeat(32),
            mimeType: 'video/mp4',
            size: 10,
            duration: options.duration
          }
        }
      },
      async setThumbnailFromBuffer(_channel, videoId, image, mimeType) {
        uploaded.push(['thumbnail', videoId, image.toString(), mimeType])
        return { success: true, thumbnailBlobId: '1:1:0:4' }
      }
    },
    runtime: {
      publicFeed: {
        async submitChannel(_driveKey, _publicBeeKey, options) { submitted.push(options) }
      },
      cacheManager: { async pinChannel() {}, async addChannel() {} },
      seeder: { async seedChannel() {} },
      async publishRelayCatalogEntry() {}
    },
    fs,
    logger: makeFakeLogger(),
    state: null,
    createChannelFn: async () => ({ channel, channelKeyHex: 'aa'.repeat(32) })
  })

  const result = await publisher.publishVideo({
    source,
    ytEntry: { id: 'v7ah96i-america-first-ep.-1690', title: 'America First Full Episodes', uploader: null, duration: null, webpageUrl: source.url },
    files: { videoFile: '/tmp/video.mp4', infoFile: '/tmp/video.info.json', thumbnailFile: '/tmp/video.jpg' }
  })

  t.is(result.title, 'America First Ep. 1690 - Real Rumble Title')
  t.is(uploaded[0][1].name, 'Nicholas J. Fuentes')
  t.is(uploaded[1][1].title, 'America First Ep. 1690 - Real Rumble Title')
  t.is(uploaded[2][3], 'image/jpeg')
  const preview = submitted.at(-1).previewVideos[0]
  t.is(preview.title, 'America First Ep. 1690 - Real Rumble Title')
  t.is(preview.channelName, 'Nicholas J. Fuentes')
  t.is(preview.thumbnailBlobId, '1:1:0:4')
  t.is(preview.thumbnailBlobsCoreKey, 'dd'.repeat(32))
  t.is(preview.thumbnailMimeType, 'image/jpeg')
  t.is(preview.thumbnailUrl, 'https://rumble.com/thumb.jpg')
})

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
  t.alike(classifySourceUrl('https://rumble.com/v7afkp6-america-first-ep.-1689.html'), {
    type: 'youtube',
    normalizedUrl: 'https://rumble.com/v7afkp6-america-first-ep.-1689.html',
    identifier: 'rumble:video:v7afkp6-america-first-ep.-1689',
    kind: 'rumble-video'
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

test('createArchiver poll preserves archive source channel keys after publishing', async (t) => {
  const metaDb = makeFakeMetaDb()
  const config = resolveRelayConfig({
    storage: { path: '/tmp/peartube-test', maxBytes: 100000 },
    archive: {
      enabled: true,
      tmpPath: '/tmp/peartube-test/archive-tmp',
      sources: [{ url: 'https://www.youtube.com/@chan', label: 'Chan' }]
    }
  }, { env: {} })

  const archiver = createArchiver({
    config,
    runtime: makeFakeRuntime({ metaDb }),
    logger: makeFakeLogger(),
    fs: makeFakeFs({ '/tmp/v1.mp4': 'video bytes' }),
    ytDlp: {
      async listVideos() { return [{ id: 'v1', title: 'Video 1', webpageUrl: 'https://yt/v1' }] },
      async downloadVideo() { return { videoFile: '/tmp/v1.mp4' } }
    },
    publisherFactory: () => ({
      async publishVideo() {
        return {
          videoId: 'pt-v1',
          bytes: 200,
          channelKey: 'channel-key-hex',
          publicBeeKey: 'public-bee-hex'
        }
      }
    }),
    setIntervalFn: () => null,
    clearIntervalFn: () => {},
    setTimeoutFn: () => {}
  })

  await archiver.runOnce()

  const sourceRecord = await createArchiveState({ metaDb }).getSource('youtube:@chan')
  t.is(sourceRecord.channelKey, 'channel-key-hex')
  t.is(sourceRecord.publicBeeKey, 'public-bee-hex')
})

test('createArchiver reannounces archived source channels even when every video is already archived', async (t) => {
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
  await state.markArchived('youtube:@chan', 'v1', { peartubeVideoId: 'pt-v1', bytes: 100, title: 'Video 1' })

  const ensured = []
  const archiver = createArchiver({
    config,
    runtime: makeFakeRuntime({ metaDb }),
    logger: makeFakeLogger(),
    fs: makeFakeFs(),
    ytDlp: {
      async listVideos() { return [{ id: 'v1', title: 'Video 1', webpageUrl: 'https://yt/v1' }] },
      async downloadVideo() { throw new Error('already archived video should not be downloaded') }
    },
    publisherFactory: () => ({
      async ensureSourceChannel(source) {
        ensured.push(source.sourceId)
        await state.putSource(source.sourceId, {
          url: source.url,
          type: source.type,
          channelKey: 'channel-key-hex',
          publicBeeKey: 'public-bee-hex'
        })
      }
    }),
    setIntervalFn: () => null,
    clearIntervalFn: () => {},
    setTimeoutFn: () => {}
  })

  await archiver.runOnce()

  t.alike(ensured, ['youtube:@chan'])
  const sourceRecord = await state.getSource('youtube:@chan')
  t.is(sourceRecord.channelKey, 'channel-key-hex')
  t.is(sourceRecord.publicBeeKey, 'public-bee-hex')
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

test('createArchiver stop clears staggered initial poll timers', async (t) => {
  const metaDb = makeFakeMetaDb()
  const config = resolveRelayConfig({
    storage: { path: '/tmp/peartube-test', maxBytes: 100000 },
    archive: {
      enabled: true,
      tmpPath: '/tmp/peartube-test/archive-tmp',
      sources: [
        { url: 'https://www.youtube.com/@one' },
        { url: 'https://www.youtube.com/@two' }
      ]
    }
  }, { env: {} })

  const scheduled = []
  const cleared = []
  let listed = 0
  const archiver = createArchiver({
    config,
    runtime: makeFakeRuntime({ metaDb }),
    logger: makeFakeLogger(),
    fs: makeFakeFs(),
    ytDlp: {
      async listVideos() {
        listed += 1
        return []
      },
      async downloadVideo() { throw new Error('not expected') }
    },
    publisherFactory: () => ({}),
    setIntervalFn: () => ({ type: 'interval' }),
    clearIntervalFn: (timer) => { cleared.push(timer) },
    setTimeoutFn: (fn, delay) => {
      const timer = { type: 'timeout', fn, delay }
      scheduled.push(timer)
      return timer
    }
  })

  await archiver.start()
  t.is(scheduled.length, 2)
  await archiver.stop()

  t.is(cleared.filter((timer) => timer.type === 'timeout').length, 2)
  for (const timer of scheduled) timer.fn()
  t.is(listed, 0)
})

test('createYtDlpDownloader builds the canonical download argv via the shared media module', async (t) => {
  const spawned = []
  const spawnFn = (bin, args) => {
    spawned.push({ bin, args })
    return {
      stdout: { on (event, cb) { if (event === 'data') cb('/tmp/out/dir/Clip [abc].mp4\n') } },
      stderr: { on () {} },
      on (event, cb) { if (event === 'close') cb(0) }
    }
  }
  const files = { '/tmp/out/dir/Clip [abc].info.json': JSON.stringify({ title: 'Clip', uploader: 'Maker', duration: 42 }) }
  const fs = {
    mkdirSync () {},
    rmSync () {},
    existsSync (path) { return path in files || path === '/tmp/out/dir/Clip [abc].mp4' },
    readFileSync (path) { return files[path] || '{}' }
  }
  const downloader = createYtDlpDownloader({
    bin: '/bin/yt-dlp',
    outputDir: '/tmp/out',
    format: 'bv*+ba/b',
    ffmpegPath: '/opt/ffmpeg',
    cookiesPath: '/data/cookies.txt',
    spawnFn,
    fs,
    path: { join: (...parts) => parts.join('/') }
  })
  const result = await downloader.download({ id: 'dir', url: 'https://vimeo.com/9', title: 'Clip' })

  t.alike(spawned[0].args, buildDownloadArgs({
    format: 'bv*+ba/b',
    outputTemplate: '/tmp/out/dir/%(title).200B [%(id)s].%(ext)s',
    ffmpegPath: '/opt/ffmpeg',
    cookiesPath: '/data/cookies.txt',
    sourceUrl: 'https://vimeo.com/9'
  }))
  t.is(result.filePath, '/tmp/out/dir/Clip [abc].mp4')
  t.is(result.mimeType, 'video/mp4')
})
