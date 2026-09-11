import test from 'brittle'

import { createLocalDriveMirrorState, listLocalDriveVideos, mirrorLocalDriveToRelayChannel } from '../src/local-drive-mirror.js'

const PUBLISHER_ID = 'cc'.repeat(32)

function channelInfo(channelKey = 'aa'.repeat(32), publicBeeKey = 'bb'.repeat(32)) {
  return { publisherId: PUBLISHER_ID, channelKey, publicBeeKey }
}

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
    },
    createReadStream(path) {
      return [Buffer.from(`fixture:${path}`)]
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

test('mirrorLocalDriveToRelayChannel requires requestLocalFileAcquisition', async (t) => {
  const fs = makeFs({ '/drive': [dirent('one.mp4', 'file')] }, { '/drive/one.mp4': 100 })
  await t.exception(
    mirrorLocalDriveToRelayChannel({ rootPath: '/drive', fs, path: pathShim }),
    /requestLocalFileAcquisition is required/
  )
})

test('mirrorLocalDriveToRelayChannel imports through ProviderService acquisition and never leaks raw paths', async (t) => {
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
      return channelInfo()
    }
  }

  const result = await mirrorLocalDriveToRelayChannel({
    rootPath: '/drive',
    publisher,
    fs,
    path: pathShim,
    channelName: 'Mirror',
    requestLocalFileAcquisition: async (input) => {
      calls.push(['acquire', input.title, input.selector, input.expectedBytes, input.idempotencyKey])
      return {
        acquisitionId: `acq-${input.title}`,
        state: 'completed',
        publicationId: `pub-${input.title}`,
        manifestId: 'manifest-1',
        renditionId: 'rendition-1',
        assetId: 'asset-1'
      }
    },
    service: {
      async getPublication(publicationId) {
        calls.push(['publication', publicationId])
        return {
          publicationId,
          publisherId: PUBLISHER_ID,
          manifestId: 'manifest-1',
          renditions: [{ renditionId: 'rendition-1', assetId: 'asset-1', mimeType: 'video/mp4', byteLength: 100 }]
        }
      }
    }
  })

  t.is(result.scanned, 2)
  t.is(result.imported, 2)
  t.is(result.failed, 0)
  t.is(result.skipped, 0)
  t.is(result.channels[0].publisherId, PUBLISHER_ID)
  t.alike(calls.filter((call) => call[0] === 'publication').map((call) => call[1]), ['pub-one', 'pub-two'])
  t.absent(JSON.stringify(result).includes('/drive'), 'public mirror result must not contain raw file paths')

  // Verify that selector and idempotencyKey never contain the raw filePath
  for (const call of calls.filter(c => c[0] === 'acquire')) {
    const [, title, selector, expectedBytes, idempotencyKey] = call
    t.absent(idempotencyKey.includes('/drive'), 'idempotencyKey must not contain raw file path')
    t.absent(selector.identifier.includes('/drive'), 'selector identifier must not contain raw file path')
  }
})

test('mirrorLocalDriveToRelayChannel marks local containers playable with unverified playback support', async (t) => {
  const fs = makeFs({
    '/drive': [dirent('movie.mkv', 'file')]
  }, {
    '/drive/movie.mkv': 100
  })
  const publisher = {
    async ensureAnonymousChannel() {
      return channelInfo()
    }
  }

  const result = await mirrorLocalDriveToRelayChannel({
    rootPath: '/drive',
    publisher,
    fs,
    path: pathShim,
    requestLocalFileAcquisition: async (input) => ({
      acquisitionId: 'acq-movie',
      state: 'completed',
      publicationId: 'pub-movie',
      manifestId: 'manifest-1',
      renditionId: 'rendition-1',
      assetId: 'asset-1'
    })
  })

  const preview = result.channels[0].videos[0]
  t.is(preview.mimeType, 'video/x-matroska')
  t.is(preview.availability, 'playable')
  t.is(preview.playbackSupport, 'unverified-container')
  t.is(preview.publicationId, 'pub-movie')
})

test('mirrorLocalDriveToRelayChannel re-acquires only changed files on subsequent scans', async (t) => {
  const sizes = { '/drive/one.mp4': 100 }
  const fs = {
    readdirSync() {
      return [dirent('one.mp4', 'file')]
    },
    statSync(path) {
      return { size: sizes[path], mtimeMs: sizes[path] }
    },
    createReadStream(path) {
      return [Buffer.from(`fixture:${path}`)]
    }
  }
  const state = createLocalDriveMirrorState()
  const acquisitions = []
  const publisher = {
    async ensureAnonymousChannel() {
      return channelInfo()
    }
  }
  const requestLocalFileAcquisition = async (input) => {
    acquisitions.push(input.path)
    return {
      acquisitionId: `acq-${acquisitions.length}`,
      state: 'completed',
      publicationId: `pub-${acquisitions.length}`,
      manifestId: 'manifest-1',
      renditionId: 'rendition-1',
      assetId: 'asset-1'
    }
  }

  const first = await mirrorLocalDriveToRelayChannel({ rootPath: '/drive', publisher, fs, path: pathShim, state, requestLocalFileAcquisition })
  const second = await mirrorLocalDriveToRelayChannel({ rootPath: '/drive', publisher, fs, path: pathShim, state, requestLocalFileAcquisition })
  sizes['/drive/one.mp4'] = 101
  const third = await mirrorLocalDriveToRelayChannel({ rootPath: '/drive', publisher, fs, path: pathShim, state, requestLocalFileAcquisition })

  t.is(first.imported, 1)
  t.is(second.imported, 0)
  t.is(second.skipped, 1)
  t.is(third.imported, 1)
  t.alike(acquisitions, ['/drive/one.mp4', '/drive/one.mp4'])
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
  fs.readFileSync = (filePath) => {
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
      thumbnail: 'https://private-artwork.example/poster.png?token=grant-only'
    })
  }

  const acquired = []
  const publisher = {
    async ensureAnonymousChannel() {
      return channelInfo()
    }
  }

  const state = createLocalDriveMirrorState()
  const options = {
    rootPath: '/drive',
    publisher,
    fs,
    path: pathShim,
    state,
    requestLocalFileAcquisition: async (input) => {
      acquired.push(input)
      return {
        acquisitionId: `acq-${input.title}`,
        state: 'completed',
        publicationId: `pub-${input.title}`,
        manifestId: 'manifest-1',
        renditionId: 'rendition-1',
        assetId: 'asset-1'
      }
    }
  }
  const result = await mirrorLocalDriveToRelayChannel(options)

  t.is(result.scanned, 2)
  t.is(acquired[0].title, 'YT Title')
  t.is(acquired[1].title, 'random clip 01')
  t.absent(JSON.stringify(result).includes('private-artwork.example'), 'fresh public previews omit the private artwork locator')
  t.absent(JSON.stringify(result).includes('youtube.com/watch'), 'source URLs do not escape through public previews')

  for (const record of state.seen.values()) {
    record.previewVideo.thumbnailUrl = 'https://private-artwork.example/legacy.png?token=old'
    record.previewVideo.sourceUrl = 'https://private-source.example/watch?token=old'
  }
  const replay = await mirrorLocalDriveToRelayChannel(options)
  t.is(replay.imported, 0, 'cached previews do not reacquire unchanged files')
  t.alike(replay.channels.flatMap(channel => channel.videos.map(video => video.id)).sort(), ['pub-YT Title', 'pub-random clip 01'], 'safe cached publication previews remain available')
  t.absent(JSON.stringify(replay).includes('private-artwork.example'), 'legacy cached previews omit artwork locators')
  t.absent(JSON.stringify(replay).includes('private-source.example'), 'legacy cached previews omit source locators')
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
  const acquired = []
  const publisher = {
    async ensureAnonymousChannel({ channelName, sourceIdentity }) {
      ensured.push({ channelName, sourceIdentity })
      const suffix = sourceIdentity.sourceId.endsWith('UCcreatorone') ? '11' : '22'
      return channelInfo(suffix.repeat(32), suffix.repeat(32))
    }
  }

  const result = await mirrorLocalDriveToRelayChannel({
    rootPath: '/drive',
    publisher,
    fs,
    path: pathShim,
    channelName: 'Fallback Mirror',
    requestLocalFileAcquisition: async (input) => {
      acquired.push(input)
      return {
        acquisitionId: `acq-${input.title}`,
        state: 'completed',
        publicationId: `pub-${input.title}`,
        manifestId: 'manifest-1',
        renditionId: 'rendition-1',
        assetId: 'asset-1'
      }
    }
  })

  t.is(result.scanned, 2)
  t.is(result.imported, 2)
  t.is(ensured.length, 2)
  t.alike(ensured.map((entry) => entry.channelName), ['Creator One', 'Creator Two'])
  t.alike(ensured.map((entry) => entry.sourceIdentity), [
    { platform: 'youtube', sourceId: 'youtube:channel:UCcreatorone', creatorName: 'Creator One', creatorHandle: null },
    { platform: 'youtube', sourceId: 'youtube:channel:UCcreatortwo', creatorName: 'Creator Two', creatorHandle: null }
  ])
  t.alike(acquired.map((entry) => entry.title), ['Alpha', 'Beta'])
})
