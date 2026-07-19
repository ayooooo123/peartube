import { createRequire } from 'node:module'

import test from 'brittle'
import c from 'compact-encoding'

import { APP_RPC_METHODS } from '../spec/hrpc/app-rpc-adapter.mjs'

const require = createRequire(import.meta.url)
const schema = require('../spec/schema/index.js')
const hrpc = require('../spec/hrpc/hrpc.json')

function roundTrip(name, value) {
  const encoding = schema.getEncoding(name)
  return c.decode(encoding, c.encode(encoding, value))
}

const legacyContentItemsRequest = {
  preencode(state, message) {
    c.string.preencode(state, message.channelKey)
    state.end++
    if (message.publicBeeKey) c.string.preencode(state, message.publicBeeKey)
    c.string.preencode(state, message.groupId)
    if (message.cursor) c.string.preencode(state, message.cursor)
    if (message.limit) c.uint.preencode(state, message.limit)
  },
  encode(state, message) {
    const flags =
      (message.publicBeeKey ? 1 : 0) |
      (message.cursor ? 2 : 0) |
      (message.limit ? 4 : 0)
    c.string.encode(state, message.channelKey)
    c.uint.encode(state, flags)
    if (message.publicBeeKey) c.string.encode(state, message.publicBeeKey)
    c.string.encode(state, message.groupId)
    if (message.cursor) c.string.encode(state, message.cursor)
    if (message.limit) c.uint.encode(state, message.limit)
  },
  decode(state) {
    const channelKey = c.string.decode(state)
    const flags = c.uint.decode(state)
    return {
      channelKey,
      publicBeeKey: (flags & 1) !== 0 ? c.string.decode(state) : null,
      groupId: c.string.decode(state),
      cursor: (flags & 2) !== 0 ? c.string.decode(state) : null,
      limit: (flags & 4) !== 0 ? c.uint.decode(state) : 0,
    }
  },
}

const artwork = [
  {
    role: 'avatar',
    blobId: 'avatar-blob',
    blobsCoreKey: 'aa'.repeat(32),
    mimeType: 'image/png',
    remoteUrl: 'https://images.example.test/avatar.png'
  },
  {
    role: 'banner',
    blobId: 'banner-blob',
    blobsCoreKey: 'bb'.repeat(32),
    mimeType: 'image/webp',
    remoteUrl: 'https://images.example.test/banner.webp'
  },
  {
    role: 'poster',
    blobId: 'poster-blob',
    blobsCoreKey: 'cc'.repeat(32),
    mimeType: 'image/jpeg',
    remoteUrl: 'https://images.example.test/poster.jpg'
  },
  {
    role: 'backdrop',
    blobId: 'backdrop-blob',
    blobsCoreKey: 'dd'.repeat(32),
    mimeType: 'image/jpeg',
    remoteUrl: 'https://images.example.test/backdrop.jpg'
  }
]

const sources = [
  {
    provider: 'youtube',
    identityKey: 'id:UC-catalog',
    sourceId: 'UC-catalog',
    identityUrl: 'https://www.youtube.com/@catalog',
    handle: '@catalog',
    displayName: 'Catalog Channel'
  }
]

const groups = [
  { id: 'season:1', kind: 'seasons', title: 'Season 1', itemCount: 2, seasonNumber: 1 },
  { id: 'episodes', kind: 'episodes', title: 'Episodes', itemCount: 2 },
  { id: 'extras', kind: 'extras', title: 'Extras', itemCount: 1 },
  { id: 'movie', kind: 'movie', title: 'Movie', itemCount: 1 },
  { id: 'trailers', kind: 'trailers', title: 'Trailers', itemCount: 1 },
  { id: 'latest', kind: 'latest', title: 'Latest', itemCount: 7 }
]

const item = {
  id: 'episode-1',
  title: 'Pilot',
  description: 'The first episode.',
  contentKind: 'episode',
  channelKey: 'channel-key',
  publicBeeKey: 'public-bee-key',
  sourceProvider: 'youtube',
  sourceVideoId: 'video-1',
  identityUrl: 'https://www.youtube.com/watch?v=video-1',
  sourceCreatorId: 'UC-catalog',
  sourceCreatorUrl: 'https://www.youtube.com/@catalog',
  sourcePublishedAt: 1212537600000,
  mediaProvider: 'tmdb',
  mediaId: '62085',
  seasonNumber: 1,
  episodeNumber: 1,
  originalAirDate: 1212537600000,
  duration: 2820,
  blobId: 'video-blob',
  blobsCoreKey: 'ee'.repeat(32),
  mimeType: 'video/mp4',
  thumbnailUrl: 'https://images.example.test/pilot.jpg',
  thumbnailBlobId: 'thumbnail-blob',
  thumbnailBlobsCoreKey: 'ff'.repeat(32),
  thumbnailMimeType: 'image/jpeg',
  provenanceVersion: 'catalog-resolver@1',
  contentFingerprint: 'sha256:catalog-item',
  publicationState: 'published'
}

test('structured channel catalog codecs round-trip rich profile and ordered groups', (t) => {
  const response = {
    success: true,
    profile: {
      channelKey: 'channel-key',
      name: 'Catalog Channel',
      description: 'A structured TV catalog.',
      profileKind: 'tvShow',
      mediaProvider: 'tmdb',
      mediaId: '1399',
      originalLanguage: 'en',
      releaseDate: 1212537600000,
      releaseYear: 2008,
      createdAt: 1212537600000,
      updatedAt: 1212624000000,
      sources,
      artwork
    },
    groups
  }

  const decoded = roundTrip('@peartube/get-content-catalog-response', response)

  t.is(decoded.success, true)
  t.alike(decoded.profile, response.profile, 'profile, source links, and artwork blob coordinates survive')
  t.alike(decoded.groups.map((group) => group.id), groups.map((group) => group.id), 'all catalog group summaries retain stable order')
  t.alike(decoded.groups[0], groups[0], 'season summary fields survive')
})

test('structured content item page codec round-trips rich items and cursor errors', (t) => {
  const page = {
    success: true,
    group: groups[0],
    items: [item],
    nextCursor: 'opaque:season-1:page-2'
  }

  const decoded = roundTrip('@peartube/get-content-items-response', page)

  t.is(decoded.success, true)
  t.alike(decoded.group, groups[0])
  t.alike(decoded.items, [item], 'content, source, media, season, and episode fields survive')
  t.is(decoded.nextCursor, page.nextCursor)

  const invalidCursor = roundTrip('@peartube/get-content-items-response', {
    success: false,
    errorCode: 'INVALID_CURSOR',
    error: 'Cursor does not match this catalog group.'
  })
  t.alike(invalidCursor, {
    success: false,
    errorCode: 'INVALID_CURSOR',
    error: 'Cursor does not match this catalog group.',
    group: null,
    items: null,
    nextCursor: null
  })
})

test('catalog request codecs retain bounded pagination inputs', (t) => {
  t.alike(roundTrip('@peartube/get-content-catalog-request', {
    channelKey: 'channel-key',
    publicBeeKey: 'public-bee-key'
  }), {
    channelKey: 'channel-key',
    publicBeeKey: 'public-bee-key'
  })

  t.alike(roundTrip('@peartube/get-content-items-request', {
    channelKey: 'channel-key',
    publicBeeKey: 'public-bee-key',
    groupId: 'latest',
    cursor: 'opaque:latest:page-2',
    limit: 200,
    limitProvided: true
  }), {
    channelKey: 'channel-key',
    publicBeeKey: 'public-bee-key',
    groupId: 'latest',
    cursor: 'opaque:latest:page-2',
    limit: 200,
    limitProvided: true
  })

  t.alike(roundTrip('@peartube/get-content-items-request', {
    channelKey: 'channel-key',
    groupId: 'latest'
  }), {
    channelKey: 'channel-key',
    publicBeeKey: null,
    groupId: 'latest',
    cursor: null,
    limit: 0,
    limitProvided: false
  })

  t.alike(roundTrip('@peartube/get-content-items-request', {
    channelKey: 'channel-key',
    groupId: 'latest',
    limit: 0,
    limitProvided: true
  }), {
    channelKey: 'channel-key',
    publicBeeKey: null,
    groupId: 'latest',
    cursor: null,
    limit: 0,
    limitProvided: true
  })
})

test('catalog limit presence remains wire-compatible with legacy peers', (t) => {
  const current = schema.getEncoding('@peartube/get-content-items-request')
  const legacyPayload = c.encode(legacyContentItemsRequest, {
    channelKey: 'channel-key',
    groupId: 'latest',
  })
  t.alike(c.decode(current, legacyPayload), {
    channelKey: 'channel-key',
    publicBeeKey: null,
    groupId: 'latest',
    cursor: null,
    limit: 0,
    limitProvided: false,
  })

  const explicitZeroPayload = c.encode(current, {
    channelKey: 'channel-key',
    groupId: 'latest',
    limit: 0,
    limitProvided: true,
  })
  t.alike(c.decode(legacyContentItemsRequest, explicitZeroPayload), {
    channelKey: 'channel-key',
    publicBeeKey: null,
    groupId: 'latest',
    cursor: null,
    limit: 0,
  })
})

test('catalog commands are registered and classified under channel', (t) => {
  const commands = new Set(hrpc.schema.map((entry) => entry.name))

  t.ok(commands.has('@peartube/get-content-catalog'))
  t.ok(commands.has('@peartube/get-content-items'))
  t.is(APP_RPC_METHODS.channel.getContentCatalog, 'getContentCatalog')
  t.is(APP_RPC_METHODS.channel.getContentItems, 'getContentItems')
})
