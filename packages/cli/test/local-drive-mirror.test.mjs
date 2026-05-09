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
    async publishChannel(channelInfo, options) {
      calls.push(['publish', channelInfo.channelKey, options.previewVideos.map((video) => video.blobId)])
    },
    async seedChannel(channelInfo) {
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


test('mirrorLocalDriveToRelayChannel skips already mirrored file fingerprints', async (t) => {
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
  const publisher = {
    async ensureAnonymousChannel() {
      return { channel: { id: 'channel' }, channelKey: 'aa'.repeat(32), publicBeeKey: 'bb'.repeat(32) }
    },
    async importVideo({ filePath }) {
      imports.push(filePath)
      return { videoId: `video-${imports.length}`, metadata: { size: sizes[filePath], blobId: `blob-${imports.length}`, blobsCoreKey: 'cc'.repeat(32) } }
    },
    async publishChannel() {},
    async seedChannel() {}
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
})
