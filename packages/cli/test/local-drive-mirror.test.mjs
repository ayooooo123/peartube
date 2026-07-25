import test from 'brittle'

import { createLocalDriveMirrorState, listLocalDriveVideos, mirrorLocalDriveToRelayChannel } from '../src/local-drive-mirror.js'

function dirent(name, type) {
  return {
    name,
    isDirectory: () => type === 'dir',
    isFile: () => type === 'file'
  }
}

function makeFs(tree, sizes = {}) {
  return {
    readdirSync(path) {
      const entries = tree[path]
      if (!entries) throw new Error(`ENOENT: ${path}`)
      return entries
    },
    statSync(path) {
      return { size: sizes[path] ?? 1024, mtimeMs: 1 }
    }
  }
}

const pathShim = {
  join(...parts) {
    return parts.join('/').replace(/\/+/g, '/')
  }
}

test('listLocalDriveVideos recursively finds supported video files', (t) => {
  const fs = makeFs({
    '/drive': [dirent('a.mp4', 'file'), dirent('notes.txt', 'file'), dirent('nested', 'dir'), dirent('.hidden.mp4', 'file')],
    '/drive/nested': [dirent('b.MKV', 'file'), dirent('empty.webm', 'file')]
  }, {
    '/drive/a.mp4': 100,
    '/drive/nested/b.MKV': 200,
    '/drive/nested/empty.webm': 0
  })

  const videos = listLocalDriveVideos('/drive', { fs, path: pathShim })
  t.alike(videos.map((video) => ({ filePath: video.filePath, title: video.title, mimeType: video.mimeType, size: video.size })), [
    { filePath: '/drive/a.mp4', title: 'a', mimeType: 'video/mp4', size: 100 },
    { filePath: '/drive/nested/b.MKV', title: 'b', mimeType: 'video/x-matroska', size: 200 }
  ])
})

test('mirrorLocalDriveToRelayChannel imports, publishes, and seeds preview refs', async (t) => {
  const fs = makeFs({
    '/drive': [dirent('one.mp4', 'file'), dirent('two.webm', 'file')]
  }, {
    '/drive/one.mp4': 100,
    '/drive/two.webm': 200
  })
  const calls = []
  const publisher = {
    async ensureAnonymousChannel({ channelName }) {
      calls.push(['ensure', channelName])
      return { channel: { id: 'channel' }, channelKey: 'aa'.repeat(32), publicBeeKey: 'bb'.repeat(32) }
    },
    async importVideo({ filePath, title, mimeType }) {
      calls.push(['import', filePath, title, mimeType])
      return {
        videoId: title,
        metadata: {
          uploadedAt: 123,
          size: filePath.endsWith('one.mp4') ? 100 : 200,
          mimeType,
          blobId: `blob:${title}`,
          blobsCoreKey: title === 'one' ? 'cc'.repeat(32) : 'dd'.repeat(32)
        }
      }
    },
    async publishCatalog(channelInfo) {
      calls.push(['publish', channelInfo.channelKey, channelInfo.previewVideos.map((video) => video.blobId)])
    },
    async retainAssets(channelInfo) {
      calls.push(['seed', channelInfo.previewVideos.map((video) => video.blobsCoreKey)])
    }
  }

  const result = await mirrorLocalDriveToRelayChannel({ rootPath: '/drive', publisher, fs, path: pathShim, channelName: 'Mirror' })

  t.is(result.scanned, 2)
  t.is(result.imported, 2)
  t.is(result.failed, 0)
  t.is(result.skipped, 0)
  t.alike(calls, [
    ['ensure', 'Mirror'],
    ['import', '/drive/one.mp4', 'one', 'video/mp4'],
    ['import', '/drive/two.webm', 'two', 'video/webm'],
    ['publish', 'aa'.repeat(32), ['blob:one', 'blob:two']],
    ['seed', ['cc'.repeat(32), 'dd'.repeat(32)]]
  ])
})


test('mirrorLocalDriveToRelayChannel marks local containers playable with unverified playback support', async (t) => {
  const fs = makeFs({
    '/drive': [dirent('movie.mkv', 'file')]
  }, {
    '/drive/movie.mkv': 100
  })
  let publishedPreview = null
  const publisher = {
    async ensureAnonymousChannel() {
      return { channel: { id: 'channel' }, channelKey: 'aa'.repeat(32), publicBeeKey: 'bb'.repeat(32) }
    },
    async importVideo({ title, mimeType }) {
      return {
        videoId: title,
        metadata: {
          uploadedAt: 123,
          size: 100,
          mimeType,
          blobId: `blob:${title}`,
          blobsCoreKey: 'cc'.repeat(32)
        }
      }
    },
    async publishCatalog(channelInfo) {
      publishedPreview = channelInfo.previewVideos[0]
    },
    async retainAssets() {}
  }

  await mirrorLocalDriveToRelayChannel({ rootPath: '/drive', publisher, fs, path: pathShim })

  t.is(publishedPreview.mimeType, 'video/x-matroska')
  t.is(publishedPreview.availability, 'playable')
  t.is(publishedPreview.playbackSupport, 'unverified-container')
})


test('mirrorLocalDriveToRelayChannel republishes and reseeds cached local previews on unchanged scans', async (t) => {
  const sizes = { '/drive/one.mp4': 100 }
  const fs = {
    readdirSync() {
      return [dirent('one.mp4', 'file')]
    },
    statSync(path) {
      return { size: sizes[path], mtimeMs: sizes[path] }
    }
  }
  const state = createLocalDriveMirrorState()
  const imports = []
  const published = []
  const seeded = []
  const publisher = {
    async ensureAnonymousChannel() {
      return { channel: { id: 'channel' }, channelKey: 'aa'.repeat(32), publicBeeKey: 'bb'.repeat(32) }
    },
    async importVideo({ filePath }) {
      imports.push(filePath)
      return { videoId: `video-${imports.length}`, metadata: { size: sizes[filePath], blobId: `blob-${imports.length}`, blobsCoreKey: 'cc'.repeat(32) } }
    },
    async publishCatalog(channelInfo) {
      published.push(channelInfo.previewVideos.map((video) => video.blobId))
    },
    async retainAssets(channelInfo) {
      seeded.push(channelInfo.previewVideos.map((video) => video.blobsCoreKey))
    }
  }

  const first = await mirrorLocalDriveToRelayChannel({ rootPath: '/drive', publisher, fs, path: pathShim, state })
  const second = await mirrorLocalDriveToRelayChannel({ rootPath: '/drive', publisher, fs, path: pathShim, state })
  sizes['/drive/one.mp4'] = 101
  const third = await mirrorLocalDriveToRelayChannel({ rootPath: '/drive', publisher, fs, path: pathShim, state })

  t.is(first.imported, 1)
  t.is(second.imported, 0)
  t.is(second.skipped, 1)
  t.is(third.imported, 1)
  t.alike(imports, ['/drive/one.mp4', '/drive/one.mp4'])
  t.alike(published, [['blob-1'], ['blob-1'], ['blob-2']])
  t.alike(seeded, [['cc'.repeat(32)], ['cc'.repeat(32)], ['cc'.repeat(32)]])
})


test('mirrorLocalDriveToRelayChannel derives safe metadata and tags from mixed local and yt-dlp files', async (t) => {
  const fs = makeFs({
    '/drive': [dirent('random clip 01.mp4', 'file'), dirent('abc123.webm', 'file'), dirent('abc123.info.json', 'file'), dirent('notes.txt', 'file')]
  }, {
    '/drive/random clip 01.mp4': 100,
    '/drive/abc123.webm': 200,
    '/drive/abc123.info.json': 50
  })
  fs.existsSync = (filePath) => filePath === '/drive/abc123.info.json'
  fs.readFileSync = (filePath, encoding) => {
    t.is(encoding, 'utf8')
    if (filePath !== '/drive/abc123.info.json') throw new Error(`ENOENT: ${filePath}`)
    return JSON.stringify({
      title: 'YT Title',
      description: 'Original YouTube description',
      uploader: 'Uploader Name',
      channel: 'Channel Name',
      webpage_url: 'https://www.youtube.com/watch?v=abc123',
      categories: ['Education'],
      tags: ['demo', 'Demo', '  ', 'very-long-tag-name-that-should-be-clipped-to-a-sed-to-a-safe-length'],
      duration: 42,
      thumbnail: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg'
    })
  }

  const imports = []
  const publishedPreviews = []
  const publisher = {
    async ensureAnonymousChannel() {
      return { channel: { id: 'channel' }, channelKey: 'aa'.repeat(32), publicBeeKey: 'bb'.repeat(32) }
    },
    async importVideo(input) {
      imports.push(input)
      return {
        videoId: input.title.replace(/\s+/g, '-').toLowerCase(),
        metadata: {
          uploadedAt: 123,
          size: input.filePath.endsWith('.webm') ? 200 : 100,
          mimeType: input.mimeType,
          duration: input.duration || 0,
          category: input.category || '',
          blobId: `blob:${input.title}`,
          blobsCoreKey: input.filePath.endsWith('.webm') ? 'dd'.repeat(32) : 'cc'.repeat(32)
        }
      }
    },
    async publishCatalog(channelInfo) {
      publishedPreviews.push(...channelInfo.previewVideos)
    },
    async retainAssets() {}
  }

  const result = await mirrorLocalDriveToRelayChannel({ rootPath: '/drive', publisher, fs, path: pathShim })

  t.is(result.scanned, 2)
  t.is(imports[0].title, 'YT Title')
  t.is(imports[0].description, 'Original YouTube description')
  t.is(imports[0].category, 'Education')
  t.alike(imports[0].tags, ['youtube', 'yt-dlp', 'education', 'uploader-name', 'channel-name', 'demo', 'very-long-tag-name-that-should-be-clipped-to-a-s'])
  t.is(imports[0].sourceUrl, 'https://www.youtube.com/watch?v=abc123')
  t.is(imports[0].sourceType, 'yt-dlp')
  t.is(imports[0].duration, 42)

  t.is(imports[1].title, 'random clip 01')
  t.is(imports[1].description, '')
  t.is(imports[1].category, 'Local')
  t.alike(imports[1].tags, ['local'])
  t.is(imports[1].sourceType, 'local')

  t.is(publishedPreviews[0].sourceType, 'yt-dlp')
  t.alike(publishedPreviews[0].tags, ['youtube', 'yt-dlp', 'education', 'uploader-name', 'channel-name', 'demo', 'very-long-tag-name-that-should-be-clipped-to-a-s'])
  t.is(publishedPreviews[1].sourceType, 'local')
  t.alike(publishedPreviews[1].tags, ['local'])
})


test('mirrorLocalDriveToRelayChannel groups yt-dlp imports by creator channel identity', async (t) => {
  const fs = makeFs({
    '/drive': [dirent('alpha.mp4', 'file'), dirent('alpha.info.json', 'file'), dirent('beta.mp4', 'file'), dirent('beta.info.json', 'file')]
  }, {
    '/drive/alpha.mp4': 100,
    '/drive/alpha.info.json': 50,
    '/drive/beta.mp4': 200,
    '/drive/beta.info.json': 50
  })
  fs.existsSync = (filePath) => filePath.endsWith('.info.json')
  fs.readFileSync = (filePath) => JSON.stringify(filePath.includes('alpha')
    ? {
        id: 'alpha',
        title: 'Alpha',
        channel: 'Creator One',
        channel_id: 'UCcreatorone',
        uploader: 'Creator One',
        webpage_url: 'https://www.youtube.com/watch?v=alpha'
      }
    : {
        id: 'beta',
        title: 'Beta',
        channel: 'Creator Two',
        channel_id: 'UCcreatortwo',
        uploader: 'Creator Two',
        webpage_url: 'https://www.youtube.com/watch?v=beta'
      })

  const ensured = []
  const imports = []
  const published = []
  const seeded = []
  const publisher = {
    async ensureAnonymousChannel({ channelName, sourceIdentity }) {
      ensured.push({ channelName, sourceIdentity })
      const suffix = sourceIdentity.sourceId.endsWith('UCcreatorone') ? '11' : '22'
      return { channel: { id: sourceIdentity.sourceId }, channelKey: suffix.repeat(32), publicBeeKey: suffix.repeat(32) }
    },
    async importVideo(input) {
      imports.push(input)
      return {
        videoId: input.sourceVideoId,
        metadata: {
          size: input.filePath.endsWith('alpha.mp4') ? 100 : 200,
          mimeType: input.mimeType,
          blobId: `blob:${input.sourceVideoId}`,
          blobsCoreKey: input.sourceVideoId === 'alpha' ? 'aa'.repeat(32) : 'bb'.repeat(32)
        }
      }
    },
    async publishCatalog(channelInfo) {
      published.push({ channelKey: channelInfo.channelKey, titles: channelInfo.previewVideos.map((video) => video.title) })
    },
    async retainAssets(channelInfo) {
      seeded.push({ channelKey: channelInfo.channelKey, refs: channelInfo.previewVideos.map((video) => video.blobsCoreKey) })
    }
  }

  const result = await mirrorLocalDriveToRelayChannel({ rootPath: '/drive', publisher, fs, path: pathShim, channelName: 'Fallback Mirror' })

  t.is(result.scanned, 2)
  t.is(result.imported, 2)
  t.is(ensured.length, 2)
  t.alike(ensured.map((entry) => entry.channelName), ['Creator One', 'Creator Two'])
  t.alike(ensured.map((entry) => entry.sourceIdentity), [
    { platform: 'youtube', sourceId: 'youtube:channel:UCcreatorone', creatorName: 'Creator One', creatorHandle: null },
    { platform: 'youtube', sourceId: 'youtube:channel:UCcreatortwo', creatorName: 'Creator Two', creatorHandle: null }
  ])
  t.alike(imports.map((entry) => [entry.title, entry.creatorName, entry.creatorSourceId, entry.sourceVideoId]), [
    ['Alpha', 'Creator One', 'youtube:channel:UCcreatorone', 'alpha'],
    ['Beta', 'Creator Two', 'youtube:channel:UCcreatortwo', 'beta']
  ])
  t.alike(published, [
    { channelKey: '11'.repeat(32), titles: ['Alpha'] },
    { channelKey: '22'.repeat(32), titles: ['Beta'] }
  ])
  t.alike(seeded, [
    { channelKey: '11'.repeat(32), refs: ['aa'.repeat(32)] },
    { channelKey: '22'.repeat(32), refs: ['bb'.repeat(32)] }
  ])
  t.alike(result.channels.map((channel) => ({ channelName: channel.channelName, imported: channel.imported })), [
    { channelName: 'Creator One', imported: 1 },
    { channelName: 'Creator Two', imported: 1 }
  ])
})
