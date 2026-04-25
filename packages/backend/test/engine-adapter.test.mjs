import test from 'brittle'

import { createEngineAdapter, normalizeEngineVideoId } from '../src/engine-adapter.js'

test('engine adapter creates and persists a UI-channel mapping', async (t) => {
  const metaDb = createMemoryMetaDb()
  const created = []
  const adapter = createEngineAdapter({
    storagePath: '/store',
    ctx: { metaDb },
    createEngineImpl: async (opts) => {
      created.push(opts)
      return createFakeEngine({ channelKey: 'ee'.repeat(32) })
    }
  })

  const engine = await adapter.ensureEngineForUiChannel('ui-channel', { name: 'Alice' })

  t.is(engine.channelKey, 'ee'.repeat(32))
  t.is(created.length, 1)
  t.is(created[0].storagePath.endsWith('/engine-channels/ui-channel'), true)
  t.alike(await metaDb.get('engine-channel:ui-channel'), {
    value: {
      uiChannelKey: 'ui-channel',
      engineChannelKey: 'ee'.repeat(32),
      storagePath: '/store/engine-channels/ui-channel',
      createdAt: metaDb.store.get('engine-channel:ui-channel').createdAt
    }
  })
  t.is(await adapter.hasEngineChannel('ui-channel'), true)

  await adapter.close()
})

test('engine adapter opens an existing mapped channel without creating a new one', async (t) => {
  const metaDb = createMemoryMetaDb()
  await metaDb.put('engine-channel:ui-channel', {
    uiChannelKey: 'ui-channel',
    engineChannelKey: 'aa'.repeat(32),
    storagePath: '/store/engine-channels/ui-channel',
    createdAt: 1
  })

  const created = []
  const adapter = createEngineAdapter({
    storagePath: '/store',
    ctx: { metaDb },
    createEngineImpl: async (opts) => {
      created.push(opts)
      return createFakeEngine({ channelKey: opts.channelKey })
    }
  })

  const engine = await adapter.ensureEngineForUiChannel('ui-channel')

  t.is(engine.channelKey, 'aa'.repeat(32))
  t.is(created.length, 1)
  t.is(created[0].channelKey, 'aa'.repeat(32))

  await adapter.close()
})

test('engine adapter uploads, lists, reads data, and returns playback URLs using UI channel keys', async (t) => {
  const engine = createFakeEngine({ channelKey: 'ee'.repeat(32) })
  const adapter = createEngineAdapter({
    storagePath: '/store',
    ctx: { metaDb: createMemoryMetaDb() },
    createEngineImpl: async () => engine
  })

  const uploaded = await adapter.uploadVideo('ui-channel', '/videos/demo.mp4', {
    title: 'Demo',
    description: 'desc',
    category: 'cat',
    mimeType: 'video/webm'
  })

  t.is(uploaded.video.channelKey, 'ui-channel')
  t.is(uploaded.video.id, 'v1')

  const listed = await adapter.listVideos('ui-channel')
  t.is(listed.length, 1)
  t.alike(listed[0], {
    id: 'v1',
    title: 'Demo',
    description: 'desc',
    path: '/videos/v1/source.mp4',
    filename: '/videos/v1/source.mp4',
    duration: 0,
    thumbnail: null,
    channelKey: 'ui-channel',
    channelName: '',
    createdAt: 123,
    uploadedAt: 123,
    views: 0,
    category: 'cat',
    mimeType: 'video/webm',
    size: 4,
    byteLength: 4,
    availability: 'playable',
    publicBeeKey: null,
    source: 'engine'
  })

  t.alike(await adapter.getVideoData('ui-channel', '/videos/v1/source.mp4'), listed[0])
  t.alike(await adapter.getVideoUrl('ui-channel', 'v1'), { url: 'http://127.0.0.1/video/v1' })
  t.alike(await adapter.preparePlayback('ui-channel', '/videos/v1/source.mp4'), {
    url: 'http://127.0.0.1/video/v1',
    stats: { status: 'playable', progress: 1, isComplete: true },
    warmupStarted: false
  })

  await adapter.close()
  t.is(engine.closed, true)
})

test('normalizeEngineVideoId accepts ids and canonical source paths', (t) => {
  t.is(normalizeEngineVideoId('v1'), 'v1')
  t.is(normalizeEngineVideoId('/videos/v1/source.mp4'), 'v1')
  t.is(normalizeEngineVideoId('/videos/v1/video.json'), 'v1')
})

function createFakeEngine({ channelKey }) {
  const records = new Map()
  return {
    channelKey,
    closed: false,
    async writeVideoFile(filePath, opts) {
      const record = {
        id: opts.id || 'v1',
        title: opts.title,
        description: opts.description || '',
        filename: '/videos/v1/source.mp4',
        byteLength: 4,
        size: 4,
        mimeType: opts.mimeType || 'video/mp4',
        category: opts.category || '',
        duration: opts.duration || 0,
        width: opts.width || 0,
        height: opts.height || 0,
        thumbnail: null,
        thumbnailMimeType: null,
        thumbnailByteLength: 0,
        createdAt: 123,
        uploadedAt: 123
      }
      records.set(record.id, record)
      return record
    },
    async listVideos() {
      return [...records.values()]
    },
    async getVideo(id) {
      return records.get(id) || null
    },
    async getVideoUrl(id) {
      return `http://127.0.0.1/video/${id}`
    },
    async close() {
      this.closed = true
    }
  }
}

function createMemoryMetaDb() {
  const store = new Map()
  return {
    store,
    async get(key) {
      return store.has(key) ? { value: store.get(key) } : null
    },
    async put(key, value) {
      store.set(key, value)
    }
  }
}
