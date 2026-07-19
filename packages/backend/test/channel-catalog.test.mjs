import assert from 'node:assert/strict'

import b4a from 'b4a'
import c from 'compact-encoding'
import * as schema from '../../spec/spec/schema/index.js'
import test from 'brittle'

import {
  buildCatalogGroupPage,
  buildChannelCatalog,
  buildGroupSummaries,
  classifyCatalogItem,
  compareCatalogItems,
  decodeCatalogCursor,
  encodeCatalogCursor,
  normalizeCatalogProfile,
} from '../src/catalog/channel-catalog.js'

const CHANNEL_A = 'a1'.repeat(32)
const CHANNEL_B = 'b2'.repeat(32)

function video (id, contentKind, uploadedAt, extra = {}) {
  return {
    id,
    title: `Title ${id}`,
    uploadedAt,
    ...(contentKind === undefined ? {} : { contentKind }),
    ...extra,
  }
}

function ids (items) {
  return items.map((item) => item.id)
}

function encodePayload (payload) {
  return b4a.toString(b4a.from(JSON.stringify(payload)), 'base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}
function encodeJsonCursor (json) {
  return b4a.toString(b4a.from(json), 'base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function throwsCode (fn, code) {
  assert.throws(fn, (error) => error?.code === code)
}

test('normalizes the rich catalog profile without retaining unrelated fields', (t) => {
  const profile = normalizeCatalogProfile({
    channelKey: CHANNEL_A,
    name: 'Example Show',
    description: 'A description',
    profileKind: 'tvShow',
    mediaProvider: 'tmdb',
    mediaId: '42',
    originalLanguage: 'en',
    releaseDate: 1700000000000,
    releaseYear: 2024,
    createdAt: 1,
    updatedAt: 2,
    sources: [{ provider: 'youtube', identityKey: 'youtube:creator:1', sourceId: '1', identityUrl: 'https://example.test/c/1', ignored: true }],
    artwork: [{ role: 'poster', blobId: 'poster', blobsCoreKey: 'c1', mimeType: 'image/jpeg', remoteUrl: 'https://example.test/poster.jpg', ignored: true }],
    ignored: 'not public',
  })

  t.alike(profile, {
    channelKey: CHANNEL_A,
    name: 'Example Show',
    description: 'A description',
    profileKind: 'tvShow',
    mediaProvider: 'tmdb',
    mediaId: '42',
    originalLanguage: 'en',
    releaseDate: 1700000000000,
    releaseYear: 2024,
    createdAt: 1,
    updatedAt: 2,
    sources: [{ provider: 'youtube', identityKey: 'youtube:creator:1', sourceId: '1', identityUrl: 'https://example.test/c/1' }],
    artwork: [{ role: 'poster', blobId: 'poster', blobsCoreKey: 'c1', mimeType: 'image/jpeg', remoteUrl: 'https://example.test/poster.jpg' }],
  })
})

test('creator groups have stable order and omit empty optional groups', (t) => {
  const videos = [
    video('legacy', undefined, 50),
    video('video', 'video', 40),
    video('stream', 'stream', 30),
    video('extra', 'extra', 20),
    video('trailer', 'trailer', 10),
  ]
  const catalog = buildChannelCatalog({ channelKey: CHANNEL_A, profile: { profileKind: 'creator' }, videos })

  t.alike(catalog.groups, [
    { id: 'latest', kind: 'latest', title: 'Latest', itemCount: 2 },
    { id: 'videos', kind: 'videos', title: 'Videos', itemCount: 1 },
    { id: 'streams', kind: 'streams', title: 'Streams', itemCount: 1 },
    { id: 'extras', kind: 'extras', title: 'Extras', itemCount: 1 },
  ])

  t.alike(buildGroupSummaries({ profileKind: 'creator' }, [video('only-video', 'video', 1)]), [
    { id: 'latest', kind: 'latest', title: 'Latest', itemCount: 0 },
    { id: 'videos', kind: 'videos', title: 'Videos', itemCount: 1 },
  ])
})

test('TV groups seasons ascending then extras and conditional latest', (t) => {
  const videos = [
    video('s2e1', 'episode', 50, { seasonNumber: 2, episodeNumber: 1 }),
    video('s1e2', 'episode', 40, { seasonNumber: 1, episodeNumber: 2 }),
    video('s1e1', 'episode', 30, { seasonNumber: 1, episodeNumber: 1 }),
    video('extra', 'extra', 20),
    video('legacy', undefined, 10),
  ]
  const catalog = buildChannelCatalog({ profile: { profileKind: 'tvShow' }, videos })

  t.alike(catalog.groups, [
    { id: 'season:1', kind: 'season', title: 'Season 1', itemCount: 2, seasonNumber: 1 },
    { id: 'season:2', kind: 'season', title: 'Season 2', itemCount: 1, seasonNumber: 2 },
    { id: 'extras', kind: 'extras', title: 'Extras', itemCount: 1 },
    { id: 'latest', kind: 'latest', title: 'Latest', itemCount: 1 },
  ])

  t.alike(buildGroupSummaries({ profileKind: 'tvShow' }, videos.slice(0, 3)).map((group) => group.id), ['season:1', 'season:2'])
})

test('movie groups movie then trailers, extras, and conditional latest', (t) => {
  const videos = [
    video('feature', 'movie', 40),
    video('trailer', 'trailer', 30),
    video('extra', 'extra', 20),
    video('legacy', undefined, 10),
  ]
  const catalog = buildChannelCatalog({ profile: { profileKind: 'movie' }, videos })

  t.alike(catalog.groups.map((group) => group.id), ['movie', 'trailers', 'extras', 'latest'])
  t.alike(catalog.groups.map((group) => group.itemCount), [1, 1, 1, 1])
  t.alike(buildGroupSummaries({ profileKind: 'movie' }, [videos[0]]).map((group) => group.id), ['movie'])
})

test('standard and legacy channels use latest, including an empty legacy catalog', (t) => {
  t.alike(buildGroupSummaries({ profileKind: 'standard' }, [video('one', 'episode', 1)]), [
    { id: 'latest', kind: 'latest', title: 'Latest', itemCount: 1 },
  ])
  t.alike(buildChannelCatalog({ profile: {}, videos: [] }).groups, [
    { id: 'latest', kind: 'latest', title: 'Latest', itemCount: 0 },
  ])
})

test('classification uses persisted fields only and never infers from titles or filenames', (t) => {
  const misleading = { id: 'S04E08-trailer.mp4', title: 'Season 4 Episode 8 Trailer', uploadedAt: 1 }

  t.is(classifyCatalogItem({ profileKind: 'tvShow' }, misleading), 'latest')
  t.is(classifyCatalogItem({ profileKind: 'tvShow' }, { ...misleading, contentKind: 'episode' }), 'latest')
  t.is(classifyCatalogItem({ profileKind: 'tvShow' }, { ...misleading, contentKind: 'episode', seasonNumber: 4 }), 'season:4')
  t.is(classifyCatalogItem({ profileKind: 'movie' }, misleading), 'latest')
  t.is(classifyCatalogItem({ profileKind: 'creator' }, misleading), 'latest')
})

test('season episodes sort by episode number, effective date, then ID', (t) => {
  const items = [
    video('z', 'episode', 5, { seasonNumber: 1, episodeNumber: 2, sourcePublishedAt: 20 }),
    video('b', 'episode', 99, { seasonNumber: 1, episodeNumber: 1, sourcePublishedAt: 10 }),
    video('a', 'episode', 1, { seasonNumber: 1, episodeNumber: 1, sourcePublishedAt: 10 }),
    video('c', 'episode', 5, { seasonNumber: 1, episodeNumber: 1 }),
  ]
  const page = buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: { profileKind: 'tvShow' }, videos: items, groupId: 'season:1' })

  t.alike(ids(page.items), ['c', 'a', 'b', 'z'])
  t.is(compareCatalogItems('season:1', items[2], items[1]), -1)
})

test('non-season groups sort by effective publication descending then ID', (t) => {
  const items = [
    video('z', 'video', 100, { sourcePublishedAt: 20 }),
    video('b', 'video', 200, { sourcePublishedAt: 20 }),
    video('old', 'video', 30),
    video('new', 'video', 40),
  ]
  const page = buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: { profileKind: 'creator' }, videos: items, groupId: 'videos' })

  t.alike(ids(page.items), ['new', 'old', 'b', 'z'])
  t.is(compareCatalogItems('videos', items[1], items[0]), -1)
})

test('group pages expose only catalog metadata and default to the first stable group', (t) => {
  const mediaBytes = b4a.alloc(1024, 7)
  const item = video('episode', 'episode', 10, {
    description: 'Pilot',
    seasonNumber: 1,
    episodeNumber: 1,
    identityUrl: 'https://example.test/watch/episode',
    blobId: 'blob',
    mediaBytes,
    canonicalVisibility: 'public',
  })
  const page = buildCatalogGroupPage({ channelKey: CHANNEL_A, publicBeeKey: CHANNEL_B, profile: { profileKind: 'tvShow' }, videos: [item] })

  t.is(page.group.id, 'season:1')
  t.alike(page.items, [{
    id: 'episode',
    title: 'Title episode',
    description: 'Pilot',
    contentKind: 'episode',
    channelKey: CHANNEL_A,
    publicBeeKey: CHANNEL_B,
    identityUrl: 'https://example.test/watch/episode',
    seasonNumber: 1,
    episodeNumber: 1,
    blobId: 'blob',
  }])
  t.is(page.items[0].mediaBytes, undefined)
  t.is(item.mediaBytes, mediaBytes, 'input metadata is not copied or rewritten')

  const empty = buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos: [] })
  t.is(empty.group.id, 'latest')
  t.alike(empty.items, [])
  t.is(empty.nextCursor, undefined)
})

test('cursor pagination has no gaps or overlaps', (t) => {
  const videos = [5, 4, 3, 2, 1].map((time) => video(`v${time}`, undefined, time))
  const first = buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos, groupId: 'latest', limit: 2 })
  const second = buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos, groupId: 'latest', limit: 2, cursor: first.nextCursor })
  const third = buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos, groupId: 'latest', limit: 2, cursor: second.nextCursor })

  t.alike([...ids(first.items), ...ids(second.items), ...ids(third.items)], ['v5', 'v4', 'v3', 'v2', 'v1'])
  t.is(new Set([...ids(first.items), ...ids(second.items), ...ids(third.items)]).size, 5)
  t.is(third.nextCursor, undefined)
})

test('keyset cursor remains stable when an item is inserted before it', (t) => {
  const videos = [50, 40, 30, 20].map((time) => video(`v${time}`, undefined, time))
  const first = buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos, groupId: 'latest', limit: 2 })
  const inserted = [video('v60', undefined, 60), ...videos]
  const second = buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos: inserted, groupId: 'latest', limit: 2, cursor: first.nextCursor })

  t.alike(ids(first.items), ['v50', 'v40'])
  t.alike(ids(second.items), ['v30', 'v20'])
})

test('cursor encodes and validates channel, group, version, and stable tuple', (t) => {
  const cursor = encodeCatalogCursor({ channelKey: CHANNEL_A, groupId: 'latest', sort: [42, 'item'] })
  t.alike(decodeCatalogCursor(cursor, { channelKey: CHANNEL_A, groupId: 'latest' }), [42, 'item'])

  throwsCode(() => decodeCatalogCursor(cursor, { channelKey: CHANNEL_B, groupId: 'latest' }), 'INVALID_CURSOR')
  throwsCode(() => decodeCatalogCursor(cursor, { channelKey: CHANNEL_A, groupId: 'videos' }), 'INVALID_CURSOR')
})

test('cursor decoder rejects malformed payloads, unknown versions, and non-exact shapes', (t) => {
  const invalidPayloads = [
    { v: 2, channelKey: CHANNEL_A, groupId: 'latest', sort: [1, 'id'] },
    { v: '1', channelKey: CHANNEL_A, groupId: 'latest', sort: [1, 'id'] },
    { v: 1, channelKey: CHANNEL_A, groupId: 'latest' },
    { v: 1, channelKey: CHANNEL_A, groupId: 'latest', sort: [1, 'id'], extra: true },
    { v: 1, channelKey: 1, groupId: 'latest', sort: [1, 'id'] },
    { v: 1, channelKey: CHANNEL_A, groupId: 1, sort: [1, 'id'] },
    { v: 1, channelKey: '', groupId: 'latest', sort: [1, 'id'] },
    { v: 1, channelKey: CHANNEL_A, groupId: '', sort: [1, 'id'] },
    { v: 1, channelKey: CHANNEL_A, groupId: 'latest', sort: ['1', 'id'] },
    { v: 1, channelKey: CHANNEL_A, groupId: 'latest', sort: [-1, 'id'] },
    { v: 1, channelKey: CHANNEL_A, groupId: 'latest', sort: [1.5, 'id'] },
    { v: 1, channelKey: CHANNEL_A, groupId: 'latest', sort: [Number.MAX_SAFE_INTEGER + 1, 'id'] },
    { v: 1, channelKey: CHANNEL_A, groupId: 'latest', sort: [1, 2] },
    { v: 1, channelKey: CHANNEL_A, groupId: 'latest', sort: [1] },
    { v: 1, channelKey: CHANNEL_A, groupId: 'season:1', sort: [1, 'id'] },
    { v: 1, channelKey: CHANNEL_A, groupId: 'latest', sort: [1, 'x'.repeat(257)] },
    { v: 1, channelKey: 'x'.repeat(257), groupId: 'latest', sort: [1, 'id'] },
    { v: 1, channelKey: CHANNEL_A, groupId: 'x'.repeat(65), sort: [1, 'id'] },
  ]

  for (const payload of invalidPayloads) {
    throwsCode(() => decodeCatalogCursor(encodePayload(payload), { channelKey: CHANNEL_A, groupId: payload.groupId === 'season:1' ? 'season:1' : 'latest' }), 'INVALID_CURSOR')
  }
  for (const cursor of ['', '%%%', 'e30=', encodePayload(null), 'x'.repeat(2049)]) {
    throwsCode(() => decodeCatalogCursor(cursor, { channelKey: CHANNEL_A, groupId: 'latest' }), 'INVALID_CURSOR')
  }
  throwsCode(() => decodeCatalogCursor(null, { channelKey: CHANNEL_A, groupId: 'latest' }), 'INVALID_CURSOR')
  throwsCode(() => decodeCatalogCursor({}, { channelKey: CHANNEL_A, groupId: 'latest' }), 'INVALID_CURSOR')
})

test('cursor encoder rejects prototypes and accessors without invoking them', (t) => {
  const inherited = Object.create({ sort: [1, 'id'] })
  inherited.channelKey = CHANNEL_A
  inherited.groupId = 'latest'
  throwsCode(() => encodeCatalogCursor(inherited), 'INVALID_CURSOR')

  let invoked = false
  const accessor = { groupId: 'latest', sort: [1, 'id'] }
  Object.defineProperty(accessor, 'channelKey', {
    enumerable: true,
    get () {
      invoked = true
      throw new Error('must not run')
    },
  })
  throwsCode(() => encodeCatalogCursor(accessor), 'INVALID_CURSOR')
  t.is(invoked, false)
})

test('group page maps bad cursors to INVALID_CURSOR and rejects invalid limits', (t) => {
  const videos = [video('one', undefined, 1)]
  const cursor = encodeCatalogCursor({ channelKey: CHANNEL_A, groupId: 'latest', sort: [1, 'one'] })

  for (const overrides of [
    { cursor: 'not-a-cursor' },
    { channelKey: CHANNEL_B, cursor },
    { groupId: 'videos', cursor },
  ]) {
    throwsCode(() => buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos, groupId: 'latest', ...overrides }), 'INVALID_CURSOR')
  }

  for (const limit of [0, -1, 201, 1.5, '2', Number.NaN]) {
    throwsCode(() => buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos, groupId: 'latest', limit }), 'INVALID_LIMIT')
  }
})

test('group page defaults to 50 items and permits the bounded maximum of 200', (t) => {
  const videos = Array.from({ length: 201 }, (_, index) => video(`v${String(index).padStart(3, '0')}`, undefined, index))
  const defaultPage = buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos, groupId: 'latest' })
  const maxPage = buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos, groupId: 'latest', limit: 200 })

  t.is(defaultPage.items.length, 50)
  t.ok(defaultPage.nextCursor)
  t.is(maxPage.items.length, 200)
  t.ok(maxPage.nextCursor)
})

test('catalog inputs reject missing, malformed, and duplicate item IDs before paging', (t) => {
  const invalidIds = ['', `x${'\0'}y`, 'x'.repeat(257)]
  for (const id of invalidIds) {
    throwsCode(
      () => buildChannelCatalog({ channelKey: CHANNEL_A, profile: {}, videos: [video(id, undefined, 1)] }),
      'INVALID_CATALOG_INPUT',
    )
    throwsCode(
      () => buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos: [video(id, undefined, 1)] }),
      'INVALID_CATALOG_INPUT',
    )
  }

  throwsCode(
    () => buildChannelCatalog({ channelKey: CHANNEL_A, profile: {}, videos: [{ title: 'Missing ID' }] }),
    'INVALID_CATALOG_INPUT',
  )

  const duplicateIds = [
    video('duplicate', undefined, 10),
    video('duplicate', undefined, 10),
  ]
  throwsCode(
    () => buildChannelCatalog({ channelKey: CHANNEL_A, profile: {}, videos: duplicateIds }),
    'INVALID_CATALOG_INPUT',
  )
  throwsCode(
    () => buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos: duplicateIds, limit: 1 }),
    'INVALID_CATALOG_INPUT',
  )
})

test('wire normalization rejects non-data fields and malformed schema values without invoking getters', (t) => {
  let itemGetterInvoked = false
  const accessorItem = { title: 'Accessor', uploadedAt: 1 }
  Object.defineProperty(accessorItem, 'id', {
    enumerable: true,
    get () {
      itemGetterInvoked = true
      return 'accessor'
    },
  })
  throwsCode(
    () => buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos: [accessorItem] }),
    'INVALID_CATALOG_INPUT',
  )
  t.is(itemGetterInvoked, false)

  let profileGetterInvoked = false
  const accessorProfile = { name: 'Unsafe' }
  Object.defineProperty(accessorProfile, 'profileKind', {
    enumerable: true,
    get () {
      profileGetterInvoked = true
      return 'creator'
    },
  })
  throwsCode(() => normalizeCatalogProfile(accessorProfile), 'INVALID_CATALOG_INPUT')
  t.is(profileGetterInvoked, false)

  const malformedItems = [
    video('date', undefined, 1, { title: new Date(0) }),
    video('bigint', undefined, 1, { sourcePublishedAt: 1n }),
    video('negative', undefined, 1, { duration: -1 }),
    video('unsafe', undefined, 1, { episodeNumber: Number.MAX_SAFE_INTEGER + 1 }),
    video('object', undefined, 1, { identityUrl: { href: 'https://example.test' } }),
  ]
  for (const item of malformedItems) {
    throwsCode(
      () => buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos: [item] }),
      'INVALID_CATALOG_INPUT',
    )
  }

  const customPrototype = Object.create({ id: 'inherited' })
  customPrototype.title = 'Custom'
  customPrototype.uploadedAt = 1
  throwsCode(
    () => buildChannelCatalog({ channelKey: CHANNEL_A, profile: {}, videos: [customPrototype] }),
    'INVALID_CATALOG_INPUT',
  )
  const hostileProxy = new Proxy(video('proxied', undefined, 1), {
    getPrototypeOf () {
      throw new Error('must be rejected')
    },
  })
  throwsCode(
    () => buildChannelCatalog({ channelKey: CHANNEL_A, profile: {}, videos: [hostileProxy] }),
    'INVALID_CATALOG_INPUT',
  )
})

test('profile source and artwork normalization is dense, bounded, codec-ready, and snapshotted', (t) => {
  const source = {
    provider: 'youtube',
    identityKey: 'youtube:creator:stable',
    identityUrl: 'https://example.test/creator',
  }
  const artwork = {
    role: 'poster',
    blobId: 'poster',
    mimeType: 'image/jpeg',
  }
  const profile = normalizeCatalogProfile({
    channelKey: CHANNEL_A,
    name: 'Codec Ready',
    profileKind: 'creator',
    sources: [source],
    artwork: [artwork],
  })

  source.provider = 'mutated'
  artwork.role = 'mutated'
  t.is(profile.sources[0].provider, 'youtube')
  t.is(profile.artwork[0].role, 'poster')
  const profileEncoding = schema.getEncoding('@peartube/channel-catalog-profile')
  t.ok(c.encode(profileEncoding, profile).byteLength > 0)

  const page = buildCatalogGroupPage({
    channelKey: CHANNEL_A,
    profile: { profileKind: 'creator' },
    groupId: 'videos',
    videos: [video('codec-item', 'video', 1, { duration: 4, identityUrl: 'https://example.test/watch' })],
  })
  const itemEncoding = schema.getEncoding('@peartube/channel-catalog-item')
  t.ok(c.encode(itemEncoding, page.items[0]).byteLength > 0)

  const sparseSources = new Array(1)
  throwsCode(
    () => normalizeCatalogProfile({ channelKey: CHANNEL_A, name: 'Sparse', sources: sparseSources }),
    'INVALID_CATALOG_INPUT',
  )
  throwsCode(
    () => normalizeCatalogProfile({
      channelKey: CHANNEL_A,
      name: 'Bad source',
      sources: [{ provider: 'youtube', identityKey: 'x'.repeat(1025) }],
    }),
    'INVALID_CATALOG_INPUT',
  )
  const customArtwork = Object.create({ role: 'poster' })
  throwsCode(
    () => normalizeCatalogProfile({ channelKey: CHANNEL_A, name: 'Bad artwork', artwork: [customArtwork] }),
    'INVALID_CATALOG_INPUT',
  )
})

test('cursor decoding accepts only the canonical payload byte representation', (t) => {
  const canonicalObject = { v: 1, channelKey: CHANNEL_A, groupId: 'latest', sort: [1, 'id'] }
  const nonCanonicalJson = [
    JSON.stringify({ groupId: 'latest', channelKey: CHANNEL_A, sort: [1, 'id'], v: 1 }),
    `{ \"v\": 1, \"channelKey\": \"${CHANNEL_A}\", \"groupId\": \"latest\", \"sort\": [1, \"id\"] }`,
    `{\"v\":1,\"channelKey\":\"${CHANNEL_A}\",\"groupId\":\"lat\\\\u0065st\",\"sort\":[1,\"id\"]}`,
    `{\"v\":1,\"v\":1,\"channelKey\":\"${CHANNEL_A}\",\"groupId\":\"latest\",\"sort\":[1,\"id\"]}`,
    `{\"v\":1,\"channelKey\":\"${CHANNEL_A}\",\"groupId\":\"latest\",\"sort\":[1e0,\"id\"]}`,
    `{\"v\":1,\"channelKey\":\"${CHANNEL_A}\",\"groupId\":\"latest\",\"sort\":[-0,\"id\"]}`,
  ]
  const canonical = encodeCatalogCursor({
    channelKey: canonicalObject.channelKey,
    groupId: canonicalObject.groupId,
    sort: canonicalObject.sort,
  })
  t.alike(decodeCatalogCursor(canonical, { channelKey: CHANNEL_A, groupId: 'latest' }), [1, 'id'])
  for (const json of nonCanonicalJson) {
    throwsCode(
      () => decodeCatalogCursor(encodeJsonCursor(json), { channelKey: CHANNEL_A, groupId: 'latest' }),
      'INVALID_CURSOR',
    )
  }
})

test('bounded page selection preserves exact keyset pages for a large group', (t) => {
  const videos = Array.from(
    { length: 10_000 },
    (_, index) => video(`large-${String(index).padStart(5, '0')}`, undefined, index),
  )
  const first = buildCatalogGroupPage({ channelKey: CHANNEL_A, profile: {}, videos, limit: 3 })
  const second = buildCatalogGroupPage({
    channelKey: CHANNEL_A,
    profile: {},
    videos,
    limit: 3,
    cursor: first.nextCursor,
  })

  t.alike(ids(first.items), ['large-09999', 'large-09998', 'large-09997'])
  t.alike(ids(second.items), ['large-09996', 'large-09995', 'large-09994'])
})

test('catalog identifiers reject controls, lone surrogates, and UTF-8 byte overflow', (t) => {
  const invalidIds = [
    `control-\u0001`,
    `control-\u0085`,
    `surrogate-\ud800`,
    '😀'.repeat(65),
  ]
  for (const id of invalidIds) {
    throwsCode(
      () => buildCatalogGroupPage({
        channelKey: CHANNEL_A,
        profile: {},
        videos: [video(id, undefined, 1)],
      }),
      'INVALID_CATALOG_INPUT',
    )
  }

  for (const channelKey of [`channel-\u0001`, `channel-\udfff`, '😀'.repeat(65)]) {
    throwsCode(
      () => buildCatalogGroupPage({ channelKey, profile: {}, videos: [video('valid', undefined, 1)] }),
      'INVALID_CATALOG_INPUT',
    )
  }
  for (const groupId of [`group-\u007f`, `group-\ud800`, '😀'.repeat(17)]) {
    throwsCode(
      () => buildCatalogGroupPage({
        channelKey: CHANNEL_A,
        profile: {},
        videos: [video('valid', undefined, 1)],
        groupId,
      }),
      'INVALID_CATALOG_INPUT',
    )
  }
})

test('cursor components use well-formed bounded UTF-8 and max accepted values round trip', (t) => {
  const invalidComponents = [
    { channelKey: `channel-\u0001`, groupId: 'latest', sort: [1, 'id'] },
    { channelKey: `channel-\ud800`, groupId: 'latest', sort: [1, 'id'] },
    { channelKey: '😀'.repeat(65), groupId: 'latest', sort: [1, 'id'] },
    { channelKey: CHANNEL_A, groupId: `group-\u0085`, sort: [1, 'id'] },
    { channelKey: CHANNEL_A, groupId: `group-\udfff`, sort: [1, 'id'] },
    { channelKey: CHANNEL_A, groupId: '😀'.repeat(17), sort: [1, 'id'] },
    { channelKey: CHANNEL_A, groupId: 'latest', sort: [1, `id-\u0001`] },
    { channelKey: CHANNEL_A, groupId: 'latest', sort: [1, `id-\ud800`] },
    { channelKey: CHANNEL_A, groupId: 'latest', sort: [1, '😀'.repeat(65)] },
  ]
  for (const position of invalidComponents) {
    throwsCode(() => encodeCatalogCursor(position), 'INVALID_CURSOR')
  }

  const channelKey = 'é'.repeat(128)
  const groupId = '😀'.repeat(16)
  const itemId = '😁'.repeat(64)
  const cursor = encodeCatalogCursor({
    channelKey,
    groupId,
    sort: [Number.MAX_SAFE_INTEGER, itemId],
  })
  t.ok(cursor.length <= 2048)
  t.alike(decodeCatalogCursor(cursor, { channelKey, groupId }), [Number.MAX_SAFE_INTEGER, itemId])

  const pageChannelKey = '\\'.repeat(256)
  const page = buildCatalogGroupPage({
    channelKey: pageChannelKey,
    profile: {},
    videos: [
      video('"'.repeat(256), undefined, 1),
      video('\\'.repeat(256), undefined, 1),
    ],
    limit: 1,
  })
  t.ok(page.nextCursor)
  t.ok(page.nextCursor.length <= 2048)
  t.alike(decodeCatalogCursor(page.nextCursor, {
    channelKey: pageChannelKey,
    groupId: 'latest',
  }), [1, page.items[0].id])
})
