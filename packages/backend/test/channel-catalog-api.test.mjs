import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import IdentityKey from 'keet-identity-key'

import { createApi } from '../src/api.js'
import { createChannelRootDescriptor, signChannelRootDescriptor } from '../src/channel-descriptor.js'

const OWNER_CHANNEL_KEY = '11'.repeat(32)
const OWNER_PUBLIC_BEE_KEY = '22'.repeat(32)
const REMOTE_CHANNEL_KEY = '33'.repeat(32)
const REMOTE_PUBLIC_BEE_KEY = '44'.repeat(32)

class StoredRecord {
  constructor (values) {
    Object.assign(this, values)
  }
}

function assertNoPrivateTransportFields (t, value) {
  const json = JSON.stringify(value)
  t.absent(json.includes('fetchUrl'))
  t.absent(json.includes('credentials'))
  t.absent(json.includes('displayUrl'))
  t.absent(json.includes('secret-token'))
}

async function signedDescriptor (channelKey = REMOTE_CHANNEL_KEY, metadataKey = REMOTE_PUBLIC_BEE_KEY) {
  const identity = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() })
  const device = crypto.keyPair()
  const proof = await identity.bootstrap(device.publicKey)
  const descriptor = createChannelRootDescriptor({
    identityPublicKey: b4a.toString(identity.identityPublicKey, 'hex'),
    channelId: channelKey,
    metadataKey,
    mediaKey: '45'.repeat(32),
    createdAt: 1,
    updatedAt: 1,
  })
  return signChannelRootDescriptor({ descriptor, deviceKeyPair: device, deviceProof: proof })
}

function ownerFixture () {
  const calls = []
  const channel = {
    publicBeeKey: OWNER_PUBLIC_BEE_KEY,
    async getMetadata () {
      calls.push('owner:getMetadata')
      return new StoredRecord({
        name: 'Orbital Detectives',
        description: 'Cases from beyond the moon.',
        createdAt: 100,
        updatedAt: 200,
        fetchUrl: 'https://private.invalid/owner',
        credentials: 'secret-token',
      })
    },
    async getChannelProfile () {
      calls.push('owner:getChannelProfile')
      return new StoredRecord({
        profileKind: 'tvShow',
        mediaProvider: 'tmdb',
        mediaId: 'show-7',
        originalLanguage: 'en',
        releaseYear: 2024,
        displayUrl: 'https://private.invalid/show',
      })
    },
    async listChannelSources () {
      calls.push('owner:listChannelSources')
      return [new StoredRecord({
        provider: 'youtube',
        identityKey: 'channel:orbital',
        sourceId: 'orbital',
        identityUrl: 'https://youtube.example/orbital',
        handle: '@orbital',
        displayName: 'Orbital Detectives',
        fetchUrl: 'https://private.invalid/source',
        credentials: 'secret-token',
      })]
    },
    async listChannelArtwork () {
      calls.push('owner:listChannelArtwork')
      return [new StoredRecord({
        role: 'poster',
        blobId: 'poster-blob',
        blobsCoreKey: '55'.repeat(32),
        mimeType: 'image/jpeg',
        remoteUrl: 'https://cdn.example/poster.jpg',
        displayUrl: 'https://private.invalid/poster',
      })]
    },
    async listVideos () {
      calls.push('owner:listVideos')
      return [
        new StoredRecord({
          id: 'episode-2',
          title: 'Second Contact',
          description: 'The signal returns.',
          contentKind: 'episode',
          seasonNumber: 1,
          episodeNumber: 2,
          sourcePublishedAt: 120,
          duration: 2400,
          publicationState: 'published',
          blobId: 'episode-2-blob',
          blobsCoreKey: '66'.repeat(32),
          mimeType: 'video/mp4',
          fetchUrl: 'https://private.invalid/episode-2',
          credentials: 'secret-token',
        }),
        new StoredRecord({
          id: 'episode-1',
          title: 'First Contact',
          description: 'A quiet beginning.',
          contentKind: 'episode',
          seasonNumber: 1,
          episodeNumber: 1,
          sourcePublishedAt: 100,
          duration: 2300,
          publicationState: 'published',
          thumbnailUrl: 'https://cdn.example/episode-1.jpg',
        }),
        new StoredRecord({
          id: 'behind-scenes',
          title: 'Behind the Scenes',
          contentKind: 'extra',
          sourcePublishedAt: 90,
          publicationState: 'published',
        }),
        new StoredRecord({
          id: 'pending-draft',
          title: 'Pending Draft',
          contentKind: 'episode',
          seasonNumber: 2,
          episodeNumber: 1,
          publicationState: 'replicationPending',
        }),
        new StoredRecord({
          id: 'uncertain-draft',
          title: 'Uncertain Draft',
          contentKind: 'extra',
          sourcePublishedAt: 130,
          publicationState: 'commitUncertain',
        }),
      ]
    },
  }
  return { calls, channel }
}

async function remoteFixture (options = {}) {
  const calls = []
  const readOptions = []
  const rootDescriptor = Object.hasOwn(options, 'rootDescriptor')
    ? options.rootDescriptor
    : await signedDescriptor()
  const publicBee = {
    async getRootDescriptor () {
      calls.push('public:getRootDescriptor')
      if (options.rootError) throw options.rootError
      return rootDescriptor
    },
    async getMetadata (readOption) {
      calls.push('public:getMetadata')
      readOptions.push(['metadata', readOption])
      return new StoredRecord({
        name: 'Aster Studio',
        description: 'Films, streams, and studio notes.',
        createdAt: 300,
        updatedAt: 400,
        fetchUrl: 'https://private.invalid/public',
      })
    },
    async getChannelProfile (readOption) {
      calls.push('public:getChannelProfile')
      readOptions.push(['profile', readOption])
      return new StoredRecord({
        profileKind: 'creator',
        mediaProvider: 'peartube',
        mediaId: 'aster',
        originalLanguage: 'fr',
      })
    },
    async listChannelSources (readOption) {
      calls.push('public:listChannelSources')
      readOptions.push(['sources', readOption])
      return [new StoredRecord({
        provider: 'peertube',
        identityKey: 'aster@example.invalid',
        sourceId: 'aster',
        displayName: 'Aster Studio',
      })]
    },
    async listChannelArtwork (readOption) {
      calls.push('public:listChannelArtwork')
      readOptions.push(['artwork', readOption])
      return [new StoredRecord({ role: 'avatar', remoteUrl: 'https://cdn.example/aster.jpg' })]
    },
    async listVideosWithStatus (readOption) {
      calls.push('public:listVideosWithStatus')
      readOptions.push(['videos', readOption])
      return {
        status: options.listingStatus || 'authoritative',
        videos: [
          new StoredRecord({ id: 'feature', title: 'Feature', contentKind: 'video', sourcePublishedAt: 500, publicationState: 'published' }),
          new StoredRecord({ id: 'live', title: 'Live', contentKind: 'stream', sourcePublishedAt: 450, publicationState: 'published' }),
          new StoredRecord({ id: 'notes', title: 'Studio Notes', contentKind: 'extra', sourcePublishedAt: 400, publicationState: 'published' }),
          new StoredRecord({ id: 'uncategorized', title: 'Update', sourcePublishedAt: 350, publicationState: 'published' }),
          new StoredRecord({ id: 'suppressed', title: 'Duplicate', contentKind: 'video', sourcePublishedAt: 550, canonicalVisibility: 'suppressed', publicationState: 'published' }),
          new StoredRecord({ id: 'pending-public', title: 'Pending', contentKind: 'video', sourcePublishedAt: 600, publicationState: 'replicationPending' }),
        ],
      }
    },
  }
  return { calls, readOptions, publicBee }
}

function apiForPublicFixture (publicBee) {
  return createApi({
    ctx: {},
    loadChannel: async () => {
      throw new Error('public catalog must not load an owner channel')
    },
    loadPublicBee: async () => publicBee,
  })
}

test('owner channelKey returns a rich catalog and a stable item page without drafts or transport secrets', async (t) => {
  const owner = ownerFixture()
  let publicLoads = 0
  const api = createApi({
    ctx: {},
    loadChannel: async (_ctx, key) => {
      t.is(key, OWNER_CHANNEL_KEY)
      return owner.channel
    },
    loadPublicBee: async () => {
      publicLoads += 1
      throw new Error('owner catalog must not load a remote public bee')
    },
  })

  const catalog = await api.getContentCatalog({ channelKey: OWNER_CHANNEL_KEY })
  t.alike(catalog, {
    success: true,
    profile: {
      channelKey: OWNER_CHANNEL_KEY,
      name: 'Orbital Detectives',
      description: 'Cases from beyond the moon.',
      profileKind: 'tvShow',
      mediaProvider: 'tmdb',
      mediaId: 'show-7',
      originalLanguage: 'en',
      releaseYear: 2024,
      createdAt: 100,
      updatedAt: 200,
      sources: [{
        provider: 'youtube',
        identityKey: 'channel:orbital',
        sourceId: 'orbital',
        identityUrl: 'https://youtube.example/orbital',
        handle: '@orbital',
        displayName: 'Orbital Detectives',
      }],
      artwork: [{
        role: 'poster',
        blobId: 'poster-blob',
        blobsCoreKey: '55'.repeat(32),
        mimeType: 'image/jpeg',
        remoteUrl: 'https://cdn.example/poster.jpg',
      }],
    },
    groups: [
      { id: 'season:1', kind: 'season', title: 'Season 1', itemCount: 2, seasonNumber: 1 },
      { id: 'extras', kind: 'extras', title: 'Extras', itemCount: 1 },
    ],
  })
  assertNoPrivateTransportFields(t, catalog)

  const firstPage = await api.getContentItems({
    channelKey: OWNER_CHANNEL_KEY,
    groupId: 'season:1',
    limit: 1,
  })
  t.alike(firstPage, {
    success: true,
    group: { id: 'season:1', kind: 'season', title: 'Season 1', itemCount: 2, seasonNumber: 1 },
    items: [{
      id: 'episode-1',
      title: 'First Contact',
      channelKey: OWNER_CHANNEL_KEY,
      publicBeeKey: OWNER_PUBLIC_BEE_KEY,
      description: 'A quiet beginning.',
      contentKind: 'episode',
      sourcePublishedAt: 100,
      seasonNumber: 1,
      episodeNumber: 1,
      duration: 2300,
      thumbnailUrl: 'https://cdn.example/episode-1.jpg',
      publicationState: 'published',
    }],
    nextCursor: firstPage.nextCursor,
  })
  t.ok(typeof firstPage.nextCursor === 'string' && firstPage.nextCursor.length > 0)

  const secondPage = await api.getContentItems({
    channelKey: OWNER_CHANNEL_KEY,
    groupId: 'season:1',
    limit: 1,
    cursor: firstPage.nextCursor,
  })
  t.alike(secondPage, {
    success: true,
    group: { id: 'season:1', kind: 'season', title: 'Season 1', itemCount: 2, seasonNumber: 1 },
    items: [{
      id: 'episode-2',
      title: 'Second Contact',
      channelKey: OWNER_CHANNEL_KEY,
      publicBeeKey: OWNER_PUBLIC_BEE_KEY,
      description: 'The signal returns.',
      contentKind: 'episode',
      sourcePublishedAt: 120,
      seasonNumber: 1,
      episodeNumber: 2,
      duration: 2400,
      blobId: 'episode-2-blob',
      blobsCoreKey: '66'.repeat(32),
      mimeType: 'video/mp4',
      publicationState: 'published',
    }],
    nextCursor: undefined,
  })
  assertNoPrivateTransportFields(t, secondPage)
  t.is(publicLoads, 0)
  t.alike(owner.calls, [
    'owner:getMetadata', 'owner:getChannelProfile', 'owner:listChannelSources', 'owner:listChannelArtwork', 'owner:listVideos',
    'owner:getChannelProfile', 'owner:listVideos',
    'owner:getChannelProfile', 'owner:listVideos',
  ])
})

test('publicBeeKey resolves the remote channel identity and uses only public catalog records', async (t) => {
  const remote = await remoteFixture()
  let ownerLoads = 0
  const api = createApi({
    ctx: {},
    loadChannel: async () => {
      ownerLoads += 1
      throw new Error('remote catalog must not load an owner channel')
    },
    loadPublicBee: async (_ctx, key) => {
      t.is(key, REMOTE_PUBLIC_BEE_KEY)
      return remote.publicBee
    },
  })

  const catalog = await api.getContentCatalog({ channelKey: '', publicBeeKey: REMOTE_PUBLIC_BEE_KEY })
  t.alike(catalog, {
    success: true,
    profile: {
      channelKey: REMOTE_CHANNEL_KEY,
      name: 'Aster Studio',
      description: 'Films, streams, and studio notes.',
      profileKind: 'creator',
      mediaProvider: 'peartube',
      mediaId: 'aster',
      originalLanguage: 'fr',
      createdAt: 300,
      updatedAt: 400,
      sources: [{ provider: 'peertube', identityKey: 'aster@example.invalid', sourceId: 'aster', displayName: 'Aster Studio' }],
      artwork: [{ role: 'avatar', remoteUrl: 'https://cdn.example/aster.jpg' }],
    },
    groups: [
      { id: 'latest', kind: 'latest', title: 'Latest', itemCount: 1 },
      { id: 'videos', kind: 'videos', title: 'Videos', itemCount: 1 },
      { id: 'streams', kind: 'streams', title: 'Streams', itemCount: 1 },
      { id: 'extras', kind: 'extras', title: 'Extras', itemCount: 1 },
    ],
  })

  const page = await api.getContentItems({
    channelKey: REMOTE_CHANNEL_KEY,
    publicBeeKey: REMOTE_PUBLIC_BEE_KEY,
    groupId: 'videos',
    limit: 10,
  })
  t.alike(page, {
    success: true,
    group: { id: 'videos', kind: 'videos', title: 'Videos', itemCount: 1 },
    items: [{
      id: 'feature',
      title: 'Feature',
      channelKey: REMOTE_CHANNEL_KEY,
      publicBeeKey: REMOTE_PUBLIC_BEE_KEY,
      contentKind: 'video',
      sourcePublishedAt: 500,
      publicationState: 'published',
    }],
    nextCursor: undefined,
  })
  assertNoPrivateTransportFields(t, page)
  t.is(ownerLoads, 0)
  t.alike(remote.calls, [
    'public:getRootDescriptor', 'public:getMetadata', 'public:getChannelProfile', 'public:listChannelSources', 'public:listChannelArtwork', 'public:listVideosWithStatus',
    'public:getRootDescriptor', 'public:getChannelProfile', 'public:listVideosWithStatus',
  ])
  t.alike(remote.readOptions, [
    ['metadata', { bounded: true, timeoutMs: 1200 }],
    ['profile', { bounded: true, timeoutMs: 1200 }],
    ['sources', { bounded: true, timeoutMs: 1200, limit: 64 }],
    ['artwork', { bounded: true, timeoutMs: 1200, limit: 16 }],
    ['videos', { syncTimeoutMs: 1500, timeoutMs: 1200 }],
    ['profile', { bounded: true, timeoutMs: 1200 }],
    ['videos', { syncTimeoutMs: 1500, timeoutMs: 1200 }],
  ])
})

test('catalog request keys are canonicalized before loaders and cursor bindings', async (t) => {
  const canonicalOwnerKey = 'ab'.repeat(32)
  const canonicalRemoteKey = 'cd'.repeat(32)
  const canonicalPublicKey = 'ef'.repeat(32)
  const owner = ownerFixture()
  let loadedOwnerKey = null
  const ownerApi = createApi({
    ctx: {},
    loadChannel: async (_ctx, key) => {
      loadedOwnerKey = key
      return owner.channel
    },
  })
  const ownerCatalog = await ownerApi.getContentCatalog({
    channelKey: canonicalOwnerKey.toUpperCase(),
  })
  t.is(loadedOwnerKey, canonicalOwnerKey)
  t.is(ownerCatalog.profile.channelKey, canonicalOwnerKey)

  const remote = await remoteFixture({
    rootDescriptor: await signedDescriptor(canonicalRemoteKey, canonicalPublicKey),
  })
  let loadedPublicKey = null
  const remoteApi = createApi({
    ctx: {},
    loadPublicBee: async (_ctx, key) => {
      loadedPublicKey = key
      return remote.publicBee
    },
  })
  const remoteCatalog = await remoteApi.getContentCatalog({
    channelKey: canonicalRemoteKey.toUpperCase(),
    publicBeeKey: canonicalPublicKey.toUpperCase(),
  })
  t.is(loadedPublicKey, canonicalPublicKey)
  t.is(remoteCatalog.profile.channelKey, canonicalRemoteKey)
})

test('public catalog resolution rejects mismatched, foreign, and unsigned descriptors', async (t) => {
  const bound = await remoteFixture()
  t.alike(await apiForPublicFixture(bound.publicBee).getContentCatalog({
    channelKey: OWNER_CHANNEL_KEY,
    publicBeeKey: REMOTE_PUBLIC_BEE_KEY,
  }), {
    success: false,
    errorCode: 'CHANNEL_MISMATCH',
    error: 'Catalog channel does not match signed descriptor',
    groups: [],
  })

  const foreign = await remoteFixture({
    rootDescriptor: await signedDescriptor(REMOTE_CHANNEL_KEY, OWNER_PUBLIC_BEE_KEY),
  })
  t.alike(await apiForPublicFixture(foreign.publicBee).getContentCatalog({
    publicBeeKey: REMOTE_PUBLIC_BEE_KEY,
  }), {
    success: false,
    errorCode: 'CHANNEL_MISMATCH',
    error: 'Public catalog descriptor does not match publicBeeKey',
    groups: [],
  })

  const unsigned = await remoteFixture({
    rootDescriptor: { descriptor: { channelId: REMOTE_CHANNEL_KEY, metadataKey: REMOTE_PUBLIC_BEE_KEY } },
  })
  t.alike(await apiForPublicFixture(unsigned.publicBee).getContentCatalog({
    publicBeeKey: REMOTE_PUBLIC_BEE_KEY,
  }), {
    success: false,
    errorCode: 'CATALOG_UNAVAILABLE',
    error: 'Catalog unavailable',
    groups: [],
  })
})

test('public descriptor absence differs from root I/O failure and uncertain listings fail closed', async (t) => {
  const absent = await remoteFixture({ rootDescriptor: null })
  t.alike(await apiForPublicFixture(absent.publicBee).getContentCatalog({
    publicBeeKey: REMOTE_PUBLIC_BEE_KEY,
  }), {
    success: false,
    errorCode: 'CHANNEL_NOT_FOUND',
    error: 'Channel not found',
    groups: [],
  })

  const unavailable = await remoteFixture({ rootError: new Error('root read failed') })
  t.alike(await apiForPublicFixture(unavailable.publicBee).getContentCatalog({
    publicBeeKey: REMOTE_PUBLIC_BEE_KEY,
  }), {
    success: false,
    errorCode: 'CATALOG_UNAVAILABLE',
    error: 'Catalog unavailable',
    groups: [],
  })

  const uncertain = await remoteFixture({ listingStatus: 'uncertain' })
  t.alike(await apiForPublicFixture(uncertain.publicBee).getContentCatalog({
    publicBeeKey: REMOTE_PUBLIC_BEE_KEY,
  }), {
    success: false,
    errorCode: 'CATALOG_UNAVAILABLE',
    error: 'Catalog unavailable',
    groups: [],
  })
  t.ok(uncertain.calls.includes('public:listVideosWithStatus'))
})

test('a failing catalog caller never tears down a PublicBee concurrently reused by another caller', async (t) => {
  const shared = await remoteFixture()
  const originalGetRootDescriptor = shared.publicBee.getRootDescriptor
  let releaseFirstRoot
  const firstRootReleased = new Promise((resolve) => {
    releaseFirstRoot = resolve
  })
  let signalFirstRoot
  const firstRootStarted = new Promise((resolve) => {
    signalFirstRoot = resolve
  })
  let rootReads = 0
  shared.publicBee.getRootDescriptor = async () => {
    rootReads += 1
    if (rootReads === 1) {
      signalFirstRoot()
      await firstRootReleased
    }
    return originalGetRootDescriptor()
  }

  let closeCalls = 0
  shared.publicBee.close = async () => {
    closeCalls += 1
  }
  const discoveryKeyHex = b4a.toString(
    crypto.discoveryKey(b4a.from(REMOTE_PUBLIC_BEE_KEY, 'hex')),
    'hex',
  )
  let handleDestroys = 0
  const marks = []
  const ctx = {
    _publicBeeCache: new Map(),
    _publicBeeInflight: new Map(),
    _swarmDiscoveryHandles: new Map(),
    metaSubspaces: {
      channelKinds: {
        async put(key) {
          marks.push(key)
        },
      },
    },
  }
  const api = createApi({
    ctx,
    loadPublicBee: async (_ctx, key) => {
      if (ctx._publicBeeCache.has(key)) return ctx._publicBeeCache.get(key)
      ctx._publicBeeCache.set(key, shared.publicBee)
      ctx._swarmDiscoveryHandles.set(discoveryKeyHex, {
        destroy() {
          handleDestroys += 1
        },
      })
      return shared.publicBee
    },
  })

  const failingCaller = api.getContentCatalog({
    channelKey: OWNER_CHANNEL_KEY,
    publicBeeKey: REMOTE_PUBLIC_BEE_KEY,
  })
  await firstRootStarted
  const successfulCaller = await api.getContentCatalog({
    publicBeeKey: REMOTE_PUBLIC_BEE_KEY,
  })
  releaseFirstRoot()
  const failed = await failingCaller

  t.is(successfulCaller.success, true)
  t.is(failed.errorCode, 'CHANNEL_MISMATCH')
  t.is(ctx._publicBeeCache.get(REMOTE_PUBLIC_BEE_KEY), shared.publicBee)
  t.is(ctx._swarmDiscoveryHandles.has(discoveryKeyHex), true)
  t.is(closeCalls, 0)
  t.is(handleDestroys, 0)
  t.alike(marks, [REMOTE_CHANNEL_KEY], 'only the fully successful caller marks the channel resolved')
})

test('uncertain public listings do not mark a channel resolved', async (t) => {
  const uncertain = await remoteFixture({ listingStatus: 'uncertain' })
  const marks = []
  const api = createApi({
    ctx: {
      metaSubspaces: {
        channelKinds: {
          async put(key) {
            marks.push(key)
          },
        },
      },
    },
    loadPublicBee: async () => uncertain.publicBee,
  })

  t.is((await api.getContentCatalog({
    publicBeeKey: REMOTE_PUBLIC_BEE_KEY,
  })).errorCode, 'CATALOG_UNAVAILABLE')
  t.alike(marks, [])
})

test('catalog validation and missing channels return structured recoverable failures', async (t) => {
  const owner = ownerFixture()
  const api = createApi({
    ctx: {},
    loadChannel: async (_ctx, key) => key === OWNER_CHANNEL_KEY ? owner.channel : null,
  })

  t.alike(await api.getContentItems({
    channelKey: OWNER_CHANNEL_KEY,
    groupId: 'season:1',
    cursor: 'not-a-cursor',
  }), {
    success: false,
    errorCode: 'INVALID_CURSOR',
    error: 'Invalid catalog cursor',
    items: [],
  })

  t.alike(await api.getContentItems({
    channelKey: OWNER_CHANNEL_KEY,
    groupId: 'season:1',
    limit: 201,
  }), {
    success: false,
    errorCode: 'INVALID_LIMIT',
    error: 'Catalog page limit must be an integer between 1 and 200',
    items: [],
  })

  t.alike(await api.getContentItems({ channelKey: OWNER_CHANNEL_KEY }), {
    success: false,
    errorCode: 'INVALID_CATALOG_INPUT',
    error: 'Catalog item request requires groupId',
    items: [],
  })

  t.alike(await api.getContentCatalog({}), {
    success: false,
    errorCode: 'INVALID_CATALOG_INPUT',
    error: 'Catalog request requires channelKey or publicBeeKey',
    groups: [],
  })

  t.alike(await api.getContentCatalog({ channelKey: '99'.repeat(32) }), {
    success: false,
    errorCode: 'CHANNEL_NOT_FOUND',
    error: 'Channel not found',
    groups: [],
  })
})


test('legacy positive limits remain effective when the presence flag is false', async (t) => {
  const channelKey = '12'.repeat(32)
  const channel = {
    async getChannelProfile() {
      return {}
    },
    async listVideos() {
      return Array.from({ length: 8 }, (_, index) => ({
        id: `video-${index}`,
        title: `Video ${index}`,
        sourcePublishedAt: 100 - index,
        publicationState: 'published',
      }))
    },
  }
  const api = createApi({
    ctx: {},
    loadChannel: async () => channel,
  })

  const page = await api.getContentItems({
    channelKey,
    groupId: 'latest',
    limit: 7,
    limitProvided: false,
  })
  t.is(page.success, true)
  t.is(page.items.length, 7)
  t.ok(page.nextCursor)
})

test('catalog storage keys reject malformed values before any loader runs', async (t) => {
  let channelLoads = 0
  let publicLoads = 0
  const api = createApi({
    ctx: {},
    loadChannel: async () => {
      channelLoads += 1
      return null
    },
    loadPublicBee: async () => {
      publicLoads += 1
      return null
    },
  })

  for (const request of [
    { channelKey: 'ab' },
    { channelKey: 'gg'.repeat(32) },
    { publicBeeKey: 'ef' },
    { publicBeeKey: 'zz'.repeat(32) },
    { channelKey: 'not-a-key', publicBeeKey: REMOTE_PUBLIC_BEE_KEY },
  ]) {
    t.alike(await api.getContentCatalog(request), {
      success: false,
      errorCode: 'INVALID_CATALOG_INPUT',
      error: `Catalog request.${Object.hasOwn(request, 'channelKey') ? 'channelKey' : 'publicBeeKey'} is invalid`,
      groups: [],
    })
  }
  t.is(channelLoads, 0)
  t.is(publicLoads, 0)
})

test('empty legacy channels keep stable catalog and page response defaults', async (t) => {
  const legacyKey = '77'.repeat(32)
  const api = createApi({
    ctx: {},
    loadChannel: async () => ({
      async getMetadata () {
        return { name: 'Legacy Channel', description: 'Old but readable.', createdAt: 10 }
      },
      async listVideos () {
        return []
      },
    }),
  })

  t.alike(await api.getContentCatalog({ channelKey: legacyKey }), {
    success: true,
    profile: {
      channelKey: legacyKey,
      name: 'Legacy Channel',
      description: 'Old but readable.',
      createdAt: 10,
      sources: [],
      artwork: [],
    },
    groups: [{ id: 'latest', kind: 'latest', title: 'Latest', itemCount: 0 }],
  })

  t.alike(await api.getContentItems({ channelKey: legacyKey, groupId: 'latest' }), {
    success: true,
    group: { id: 'latest', kind: 'latest', title: 'Latest', itemCount: 0 },
    items: [],
    nextCursor: undefined,
  })

  t.alike(await api.getContentItems({
    channelKey: legacyKey,
    publicBeeKey: null,
    groupId: 'latest',
    cursor: null,
    limit: 0,
    limitProvided: false,
  }), {
    success: true,
    group: { id: 'latest', kind: 'latest', title: 'Latest', itemCount: 0 },
    items: [],
    nextCursor: undefined,
  })

  for (const request of [
    { channelKey: legacyKey, groupId: 'latest', limit: 0, limitProvided: true },
    { channelKey: legacyKey, groupId: 'latest', limit: 0 },
    { channelKey: legacyKey, groupId: 'latest', limit: -1 },
    { channelKey: legacyKey, groupId: 'latest', limit: Number.NaN },
  ]) {
    t.alike(await api.getContentItems(request), {
      success: false,
      errorCode: 'INVALID_LIMIT',
      error: 'Catalog page limit must be an integer between 1 and 200',
      items: [],
    })
  }
})
