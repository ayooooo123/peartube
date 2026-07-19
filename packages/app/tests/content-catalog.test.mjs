import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cardArtworkCandidates,
  mapContentCatalog,
  mapContentItems,
  profileArtworkCandidates,
} from '../lib/content-catalog.js'

const profile = (overrides = {}) => ({
  channelKey: 'channel-key',
  name: 'Channel',
  description: null,
  profileKind: null,
  sources: null,
  artwork: null,
  ...overrides,
})

const group = (id, kind, itemCount, overrides = {}) => ({
  id,
  kind,
  title: `backend:${id}`,
  itemCount,
  seasonNumber: 0,
  ...overrides,
})

test('maps TV summaries in protocol order without inventing title-derived seasons', () => {
  const summaries = [
    group('extras', 'extras', 2, { title: 'Season 99 Episodes' }),
    group('season:2', 'season', 3, { title: 'Latest Movies', seasonNumber: 2 }),
    group('season:1', 'season', 1, { title: 'Creator uploads', seasonNumber: 1 }),
    group('latest', 'latest', 0, { title: 'S01E01 should not make this visible' }),
  ]

  const result = mapContentCatalog({
    success: true,
    profile: profile({ profileKind: 'tvShow' }),
    groups: summaries,
  })

  assert.equal(result.profileKind, 'tvShow')
  assert.equal(result.badge, 'TV')
  assert.deepEqual(result.groups, summaries.slice(0, 3))
  assert.deepEqual(result.tabs.map(({ id, label, sectionLabel }) => ({ id, label, sectionLabel })), [
    { id: 'extras', label: 'Extras', sectionLabel: 'Extras' },
    { id: 'season:2', label: 'Season 2', sectionLabel: 'Episodes' },
    { id: 'season:1', label: 'Season 1', sectionLabel: 'Episodes' },
  ])
  assert.strictEqual(result.tabs[0].group, summaries[0])
  assert.strictEqual(result.tabs[1].group, summaries[1])
})

test('maps movie and creator labels and badges only from explicit profile/group fields', () => {
  const movie = mapContentCatalog({
    profile: profile({ profileKind: 'movie', name: 'A Creator Season 8' }),
    groups: [
      group('movie', 'movie', 1, { title: 'Latest creator stream' }),
      group('trailers', 'trailers', 2, { title: 'Season 4' }),
      group('extras', 'extras', 1, { title: 'S03E07' }),
    ],
  })
  assert.equal(movie.badge, 'Movie')
  assert.deepEqual(movie.tabs.map((tab) => tab.label), ['Movie', 'Trailers', 'Extras'])

  const creator = mapContentCatalog({
    profile: profile({ profileKind: 'creator', name: 'Movie S05E02' }),
    groups: [
      group('latest', 'latest', 2, { title: 'Season 1' }),
      group('videos', 'videos', 1, { title: 'Movie' }),
      group('streams', 'streams', 1, { title: 'Episode 10' }),
      group('extras', 'extras', 0),
    ],
  })
  assert.equal(creator.badge, 'Creator')
  assert.deepEqual(creator.tabs.map((tab) => tab.label), ['Latest', 'Videos', 'Streams'])
})

test('maps standard and decoded legacy responses without synthesizing Latest', () => {
  const legacy = mapContentCatalog({
    profile: profile(),
    groups: [group('latest', 'latest', 4, { title: 'Season 12' })],
  })
  assert.equal(legacy.profileKind, 'standard')
  assert.equal(legacy.badge, null)
  assert.deepEqual(legacy.tabs.map((tab) => tab.label), ['Latest'])

  const emptyDecoded = mapContentCatalog({
    success: true,
    profile: profile({ profileKind: 'standard', sources: null, artwork: null }),
    groups: null,
  })
  assert.deepEqual(emptyDecoded.groups, [])
  assert.deepEqual(emptyDecoded.tabs, [])
  assert.deepEqual(emptyDecoded.sources, [])
  assert.deepEqual(emptyDecoded.artwork, [])

  const absentSummary = mapContentCatalog({
    profile: profile({ name: 'Latest videos' }),
  })
  assert.deepEqual(absentSummary.tabs, [])
})

test('orders profile artwork candidates by placement role and blob before remote URL', () => {
  const movieProfile = profile({
    profileKind: 'movie',
    artwork: [
      { role: 'avatar', blobId: null, blobsCoreKey: null, mimeType: null, remoteUrl: 'https://img/avatar.jpg' },
      { role: 'banner', blobId: 'partial-only', blobsCoreKey: null, mimeType: 'image/png', remoteUrl: 'https://img/banner.jpg' },
      { role: 'poster', blobId: 'poster-blob', blobsCoreKey: 'poster-core', mimeType: 'image/webp', remoteUrl: 'https://img/poster.jpg' },
      { role: 'backdrop', blobId: 'backdrop-blob', blobsCoreKey: 'backdrop-core', mimeType: null, remoteUrl: 'https://img/backdrop.jpg' },
    ],
  })

  assert.deepEqual(profileArtworkCandidates(movieProfile, 'card'), [
    { kind: 'blob', role: 'poster', blobId: 'poster-blob', blobsCoreKey: 'poster-core', mimeType: 'image/webp' },
    { kind: 'remote', role: 'poster', url: 'https://img/poster.jpg' },
    { kind: 'remote', role: 'avatar', url: 'https://img/avatar.jpg' },
  ])
  assert.deepEqual(profileArtworkCandidates(movieProfile, 'banner'), [
    { kind: 'blob', role: 'backdrop', blobId: 'backdrop-blob', blobsCoreKey: 'backdrop-core', mimeType: null },
    { kind: 'remote', role: 'backdrop', url: 'https://img/backdrop.jpg' },
    { kind: 'remote', role: 'banner', url: 'https://img/banner.jpg' },
  ])

  const mapped = mapContentCatalog({ profile: movieProfile, groups: [] })
  assert.deepEqual(mapped.profileArtwork.card, profileArtworkCandidates(movieProfile, 'card'))
  assert.deepEqual(mapped.profileArtwork.banner, profileArtworkCandidates(movieProfile, 'banner'))
})

test('uses creator avatar/banner roles before poster/backdrop fallbacks', () => {
  const creatorProfile = profile({
    profileKind: 'creator',
    artwork: [
      { role: 'poster', remoteUrl: 'https://img/poster.jpg' },
      { role: 'avatar', remoteUrl: 'https://img/avatar.jpg' },
      { role: 'backdrop', remoteUrl: 'https://img/backdrop.jpg' },
      { role: 'banner', remoteUrl: 'https://img/banner.jpg' },
    ],
  })

  assert.deepEqual(profileArtworkCandidates(creatorProfile, 'card').map((candidate) => candidate.url), [
    'https://img/avatar.jpg',
    'https://img/poster.jpg',
  ])
  assert.deepEqual(profileArtworkCandidates(creatorProfile, 'banner').map((candidate) => candidate.url), [
    'https://img/banner.jpg',
    'https://img/backdrop.jpg',
  ])
})

test('puts explicit item thumbnail candidates before profile fallback without copying items', () => {
  const fallbackProfile = profile({
    profileKind: 'tvShow',
    artwork: [
      { role: 'avatar', remoteUrl: 'https://img/avatar.jpg' },
      { role: 'poster', blobId: 'poster-blob', blobsCoreKey: 'poster-core', mimeType: null, remoteUrl: 'https://img/poster.jpg' },
    ],
  })
  const first = {
    id: 'item-2',
    title: 'Movie trailer S09E03',
    contentKind: null,
    seasonNumber: 0,
    episodeNumber: 0,
    thumbnailBlobId: 'thumb-blob',
    thumbnailBlobsCoreKey: 'thumb-core',
    thumbnailMimeType: 'image/jpeg',
    thumbnailUrl: 'https://img/item.jpg',
  }
  const second = { id: 'item-1', title: 'Season 99', thumbnailUrl: null }

  assert.deepEqual(cardArtworkCandidates(first, fallbackProfile), [
    { kind: 'blob', role: 'thumbnail', blobId: 'thumb-blob', blobsCoreKey: 'thumb-core', mimeType: 'image/jpeg' },
    { kind: 'remote', role: 'thumbnail', url: 'https://img/item.jpg' },
    { kind: 'blob', role: 'poster', blobId: 'poster-blob', blobsCoreKey: 'poster-core', mimeType: null },
    { kind: 'remote', role: 'poster', url: 'https://img/poster.jpg' },
    { kind: 'remote', role: 'avatar', url: 'https://img/avatar.jpg' },
  ])

  const responseGroup = group('season:0', 'season', 2, { seasonNumber: 0, title: 'Movie' })
  const page = mapContentItems({ group: responseGroup, items: [first, second], nextCursor: 'cursor-1' }, fallbackProfile)
  assert.deepEqual(page.items, [first, second])
  assert.strictEqual(page.items[0], first)
  assert.strictEqual(page.cards[0].item, first)
  assert.strictEqual(page.cards[1].item, second)
  assert.deepEqual(page.cards.map((card) => card.id), ['item-2', 'item-1'])
  assert.equal(page.section.label, 'Episodes')
  assert.equal(page.section.tabLabel, 'Season 0')
  assert.strictEqual(page.section.group, responseGroup)
  assert.equal(page.nextCursor, 'cursor-1')
})

test('normalizes decoded null item arrays and omits empty sections', () => {
  const decoded = mapContentItems({ group: group('latest', 'latest', 0), items: null, nextCursor: null }, profile())
  assert.deepEqual(decoded.items, [])
  assert.deepEqual(decoded.cards, [])
  assert.equal(decoded.section, null)
  assert.equal(decoded.nextCursor, null)

  const missing = mapContentItems({}, profile())
  assert.deepEqual(missing.items, [])
  assert.equal(missing.group, null)
  assert.equal(missing.section, null)
})
