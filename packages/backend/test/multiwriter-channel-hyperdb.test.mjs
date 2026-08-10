import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import Corestore from 'corestore'
import { MultiWriterChannel } from '../src/channel/multi-writer-channel.js'
import {
  createPublicationManifest,
  createRenditionDescriptor,
  createStaticAssetManifest,
  encodePublicationManifest,
} from '../src/assets/index.js'

async function withChannel(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-channel-hyperdb-'))
  const store = new Corestore(dir)
  let channel = null
  try {
    await store.ready()
    channel = new MultiWriterChannel(store, { key: null, encrypt: false })
    await channel.ready()
    await fn(channel)
  } finally {
    await channel?.close?.().catch(() => {})
    await store?.close?.().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}

test('MultiWriterChannel opens remote read-only channels without committing bootstrap records', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'peartube-mw-owner-'))
  const dirB = mkdtempSync(join(tmpdir(), 'peartube-mw-viewer-'))
  const storeA = new Corestore(dirA)
  const storeB = new Corestore(dirB)
  await storeA.ready()
  await storeB.ready()

  let owner = null
  let viewer = null
  try {
    owner = new MultiWriterChannel(storeA, { name: 'owner' })
    await owner.ready()
    await owner.updateMetadata({ name: 'Owner channel' })

    viewer = new MultiWriterChannel(storeB, { key: owner.key })
    await viewer.ready()

    assert.equal(viewer.writable, false)
    assert.ok(viewer.keyHex)
  } finally {
    await viewer?.close?.().catch(() => {})
    await owner?.close?.().catch(() => {})
    await storeA.close().catch(() => {})
    await storeB.close().catch(() => {})
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('MultiWriterChannel stores channel state in HyperDB, not Autobase views', async (t) => {
  await withChannel(async (channel) => {
    assert.ok(channel.db, 'channel HyperDB instance is opened')
    assert.equal('base' in channel, false, 'Autobase handle is removed')
    assert.equal('view' in channel, false, 'raw Hyperbee view is removed')

    await channel.updateMetadata({ name: 'HyperDB Root', description: 'typed channel', avatar: 'avatar.png' })
    await channel.updateMetadata({ description: 'updated typed channel' })

    const meta = await channel.getMetadata()
    assert.equal(meta.name, 'HyperDB Root')
    assert.equal(meta.description, 'updated typed channel')
    assert.equal(meta.avatar, 'avatar.png')
    assert.equal(meta.schemaVersion, 1)
  })
})

test('MultiWriterChannel video CRUD uses HyperDB collections and uploadedAt index', async () => {
  await withChannel(async (channel) => {
    await channel.addVideo({ id: 'old', title: 'Old', uploadedAt: 100, description: 'before' })
    await channel.addVideo({ id: 'new', title: 'New', uploadedAt: 200 })

    assert.equal((await channel.getVideo('old')).title, 'Old')
    assert.deepEqual((await channel.listVideos()).map((video) => video.id), ['new', 'old'])

    await channel.updateVideo('old', { title: 'Old Updated', category: 'demo' })
    const updated = await channel.getVideo('old')
    assert.equal(updated.title, 'Old Updated')
    assert.equal(updated.description, 'before')
    assert.equal(updated.category, 'demo')

    await channel.deleteVideo('new')
    assert.equal(await channel.getVideo('new'), null)
    assert.deepEqual((await channel.listVideos()).map((video) => video.id), ['old'])
    assert.equal(await channel.publicBee.getVideo('new'), null, 'delete removes the matching public row')
    assert.equal((await channel.publicBee.getVideo('old')).title, 'Old Updated', 'delete preserves unrelated public rows')

    await channel.publicBee.putVideo('new', { title: 'Stale retry', uploadedAt: 200 })
    await channel.deleteVideo('new')
    assert.equal(await channel.getVideo('new'), null, 'delete retry remains idempotent privately')
    assert.equal(await channel.publicBee.getVideo('new'), null, 'delete retry suppresses a stale public row')
    assert.equal((await channel.publicBee.getVideo('old')).title, 'Old Updated')
  })
})

test('MultiWriterChannel comments and reactions live in the same HyperDB channel database', async () => {
  await withChannel(async (channel) => {
    assert.equal('commentsAutobase' in channel, false, 'separate comments Autobase is removed')
    await channel.addVideo({ id: 'video-1', title: 'Video', uploadedAt: 1 })

    const first = await channel.comments.addComment('video-1', 'first')
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await channel.comments.addComment('video-1', 'second')

    const comments = await channel.comments.listComments('video-1')
    assert.deepEqual(comments.map((comment) => comment.commentId), [second.commentId, first.commentId])
    assert.deepEqual(comments.map((comment) => comment.text), ['second', 'first'])

    await channel.comments.hideComment('video-1', first.commentId)
    assert.deepEqual((await channel.comments.listComments('video-1')).map((comment) => comment.commentId), [second.commentId])

    await channel.reactions.addReaction('video-1', 'like')
    assert.deepEqual(await channel.reactions.getReactions('video-1'), {
      counts: { like: 1 },
      userReaction: 'like',
    })

    await channel.reactions.addReaction('video-1', 'dislike')
    assert.deepEqual(await channel.reactions.getReactions('video-1'), {
      counts: { dislike: 1 },
      userReaction: 'dislike',
    })

    await channel.reactions.removeReaction('video-1')
    assert.deepEqual(await channel.reactions.getReactions('video-1'), {
      counts: {},
      userReaction: null,
    })
  })
})

test('MultiWriterChannel stores structured channel records in private sidecars without public sync', async () => {
  await withChannel(async (channel) => {
    let publicSyncs = 0
    channel._syncPublicBeeFromFeedChannel = async () => { publicSyncs++ }

    await channel.putChannelProfile({
      profileKind: 'tvShow',
      mediaProvider: 'tmdb',
      mediaId: '1399',
      originalLanguage: 'en',
      releaseYear: 2011,
    })
    await channel.putChannelSource({
      provider: 'youtube',
      sourceId: 'UC1',
      identityUrl: 'https://youtube.example/channel/UC1',
      displayName: 'Example channel',
    })
    await channel.putChannelSource({
      provider: 'web',
      identityUrl: 'https://example.test/creator',
    })
    await channel.putChannelArtwork({
      role: 'poster',
      blobId: '1:2:0:20',
      blobsCoreKey: 'ab'.repeat(32),
      mimeType: 'image/jpeg',
    })

    assert.equal(publicSyncs, 0, 'private sidecar mutations never sync public state')
    const profile = await channel.getChannelProfile()
    assert.equal(profile.id, 'profile')
    assert.equal(profile.profileKind, 'tvShow')
    assert.equal(profile.mediaProvider, 'tmdb')
    assert.equal(profile.mediaId, '1399')
    assert.equal(profile.originalLanguage, 'en')
    assert.equal(profile.releaseYear, 2011)
    assert.equal('releaseDate' in profile, false, 'omitted profile integers stay absent')
    const metadata = await channel.getMetadata()
    assert.equal(metadata.key, 'meta', 'logical metadata retains legacy fields')
    assert.equal(metadata.profileKind, 'tvShow', 'logical metadata merges the profile')
    assert.equal(metadata.mediaId, '1399')
    const physicalMetadata = await channel.db.get('@peartubeChannel/metadata', { key: 'meta' })
    assert.equal(physicalMetadata.profileKind, undefined, 'legacy metadata remains physically unchanged')

    const sources = await channel.listChannelSources()
    assert.equal(sources.length, 2)
    assert.equal(sources.find((source) => source.provider === 'youtube').identityKey, 'id:UC1')
    assert.match(sources.find((source) => source.provider === 'web').identityKey, /^url:sha256:[0-9a-f]{64}$/)
    const webSource = sources.find((source) => source.provider === 'web')
    assert.equal('handle' in webSource, false, 'omitted source strings stay absent')
    assert.equal('createdAt' in webSource, false, 'omitted source integers stay absent')
    const poster = await channel.getChannelArtwork('poster')
    assert.equal(poster.role, 'poster')
    assert.equal(poster.blobId, '1:2:0:20')
    assert.equal(poster.blobsCoreKey, 'ab'.repeat(32))
    assert.equal(poster.mimeType, 'image/jpeg')
    assert.equal('remoteUrl' in poster, false, 'omitted artwork strings stay absent')
    assert.equal('updatedAt' in poster, false, 'omitted artwork integers stay absent')
    assert.deepEqual((await channel.listChannelArtwork()).map((artwork) => artwork.role), ['poster'])
  })
})

test('MultiWriterChannel splits structured videos physically and joins logical reads', async () => {
  await withChannel(async (channel) => {
    await channel.addVideo({
      id: 'draft-1',
      title: 'Pilot',
      description: 'private draft',
      uploadedAt: 100,
      contentKind: 'episode',
      sourceProvider: 'youtube',
      sourceVideoId: 'source-1',
      mediaProvider: 'tmdb',
      mediaId: '1399',
      seasonNumber: 1,
      episodeNumber: 1,
      publicationState: 'replicationPending',
      unknownInput: 'not persisted',
    })

    const physicalVideo = await channel.db.get('@peartubeChannel/videos', { id: 'draft-1' })
    const physicalDetails = await channel.db.get('@peartubeChannel/contentDetails', { id: 'draft-1' })
    assert.equal(physicalVideo.contentKind, undefined)
    assert.equal(physicalVideo.publicationState, undefined)
    assert.equal(physicalVideo.unknownInput, undefined)
    assert.equal(physicalDetails.id, 'draft-1')
    assert.equal(physicalDetails.contentKind, 'episode')
    assert.equal(physicalDetails.sourceProvider, 'youtube')
    assert.equal(physicalDetails.sourceVideoId, 'source-1')
    assert.equal(physicalDetails.mediaProvider, 'tmdb')
    assert.equal(physicalDetails.mediaId, '1399')
    assert.equal(physicalDetails.seasonNumber, 1)
    assert.equal(physicalDetails.episodeNumber, 1)
    assert.equal(physicalDetails.publicationState, 'replicationPending')

    const draft = await channel.getVideo('draft-1')
    assert.equal(draft.title, 'Pilot')
    assert.equal(draft.publicationState, 'replicationPending')
    assert.equal('identityUrl' in draft, false, 'omitted structured strings stay absent')
    assert.equal('originalAirDate' in draft, false, 'omitted structured integers stay absent')
    assert.equal((await channel.listVideos())[0].episodeNumber, 1)
    assert.equal(await channel.publicBee.getVideo('draft-1'), null, 'pending draft stays private by default')
    await channel.addVideo({ id: 'public-trigger', title: 'Published legacy video', uploadedAt: 75 })
    assert.equal(
      await channel.publicBee.getVideo('draft-1'),
      null,
      'an unrelated later public sync cannot expose a pending draft',
    )
    await channel.addVideo({ id: 'public-unrelated', title: 'Remain public', uploadedAt: 76 })
    await channel.updateVideo('public-trigger', { publicationState: 'replicationPending' })
    assert.equal(
      await channel.publicBee.getVideo('public-trigger'),
      null,
      'public-to-pending transition is suppressed immediately',
    )
    assert.equal((await channel.publicBee.getVideo('public-unrelated')).title, 'Remain public')
    await channel.addVideo({ id: 'public-add-upsert', title: 'Initially public', uploadedAt: 77 })
    await channel.addVideo({
      id: 'public-add-upsert',
      title: 'Now private',
      publicationState: 'replicationPending',
      uploadedAt: 78,
    }, { syncPublic: false })
    assert.equal(
      await channel.publicBee.getVideo('public-add-upsert'),
      null,
      'pending add upsert suppresses an existing public row immediately',
    )
    assert.equal((await channel.publicBee.getVideo('public-unrelated')).title, 'Remain public')

    await channel.updateVideo('draft-1', { title: 'Pilot revised', episodeNumber: 2 }, { syncPublic: false })
    const revised = await channel.getVideo('draft-1')
    assert.equal(revised.title, 'Pilot revised')
    assert.equal(revised.contentKind, 'episode', 'omitted sidecar fields are preserved')
    assert.equal(revised.sourceVideoId, 'source-1')
    assert.equal(revised.episodeNumber, 2)
    await channel.addVideo({
      id: 'draft-1',
      title: 'Pilot retried',
      episodeNumber: 3,
    }, { syncPublic: false })
    const retried = await channel.getVideo('draft-1')
    assert.equal(retried.contentKind, 'episode', 'partial add upsert preserves omitted details')
    assert.equal(retried.sourceVideoId, 'source-1')
    assert.equal(retried.episodeNumber, 3)

    await channel.addVideo({ id: 'legacy', title: 'Legacy', uploadedAt: 50 }, { syncPublic: false })
    await channel.addVideo({
      id: 'reused',
      title: 'Structured original',
      contentKind: 'video',
    }, { syncPublic: false })
    await channel.deleteVideo('reused')
    await channel.addVideo({ id: 'reused', title: 'Legacy replacement' }, { syncPublic: false })
    assert.equal('contentKind' in await channel.getVideo('reused'), false, 'delete removes the structured sidecar')

    const legacy = await channel.getVideo('legacy')
    assert.equal(legacy.title, 'Legacy')
    assert.equal('publicationState' in legacy, false, 'legacy reads gain no synthetic structured fields')
    assert.equal(await channel.db.get('@peartubeChannel/contentDetails', { id: 'legacy' }), null)
  })
})

test('MultiWriterChannel round-trips the private immutable publication reconciliation contract', async () => {
  await withChannel(async (channel) => {
    const keyPair = crypto.keyPair(Buffer.alloc(32, 21))
    const core = createStaticAssetManifest({
      treeHash: Buffer.alloc(32, 22),
      blockLength: 1,
      byteLength: 123,
      blockSize: 256 * 1024,
    })
    const rendition = createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core })
    const manifest = createPublicationManifest({
      publisherId: keyPair.publicKey,
      sequence: 7,
      title: 'Persisted publication',
      renditions: [rendition],
      keyPair,
      signedAt: 1_700_000_000_000,
    })
    const persisted = {
      publicationState: 'commitUncertain',
      publicationId: manifest.publicationId,
      manifestId: manifest.body.manifestId,
      renditionId: rendition.renditionId,
      assetId: core.assetId,
      coreKey: b4a.toString(core.key, 'hex'),
      publisherId: b4a.toString(keyPair.publicKey, 'hex'),
      publicationSequence: 7,
      metadataClaimId: '23'.repeat(32),
      availabilityClaimId: '24'.repeat(32),
      publicationOperationId: '25'.repeat(32),
      metadataClaimOperationId: '26'.repeat(32),
      availabilityClaimOperationId: '27'.repeat(32),
      publicationManifestHex: b4a.toString(encodePublicationManifest(manifest), 'hex'),
    }

    await channel.addVideo({ id: 'publication-private', title: 'Private', ...persisted })
    const physical = await channel.db.get('@peartubeChannel/contentDetails', { id: 'publication-private' })
    for (const [field, value] of Object.entries(persisted)) assert.equal(physical[field], value)

    const logical = await channel.getVideo('publication-private')
    assert.deepEqual(logical.immutablePublication, {
      publicationId: persisted.publicationId,
      manifestId: persisted.manifestId,
      renditionId: persisted.renditionId,
      assetId: persisted.assetId,
      coreKey: persisted.coreKey,
      publisherId: persisted.publisherId,
      sequence: persisted.publicationSequence,
      claimIds: [persisted.metadataClaimId, persisted.availabilityClaimId],
      operationIds: [
        persisted.publicationOperationId,
        persisted.metadataClaimOperationId,
        persisted.availabilityClaimOperationId,
      ],
      manifest,
    })
    assert.equal(await channel.publicBee.getVideo('publication-private'), null)
  })
})

test('MultiWriterChannel preserves legacy public sync defaults and honors explicit sync control', async () => {
  await withChannel(async (channel) => {
    let publicSyncs = 0
    channel._syncPublicBeeFromFeedChannel = async () => { publicSyncs++ }

    await channel.addVideo({ id: 'legacy', title: 'Legacy' })
    assert.equal(publicSyncs, 1, 'legacy add syncs by default')
    await channel.updateVideo('legacy', { title: 'Legacy revised' })
    assert.equal(publicSyncs, 2, 'legacy update syncs by default')

    await channel.addVideo({
      id: 'pending',
      title: 'Pending',
      publicationState: 'replicationPending',
    })
    assert.equal(publicSyncs, 2, 'pending add does not sync by default')
    await channel.updateVideo('pending', {
      publicationState: 'durabilityVerified',
    })
    assert.equal(publicSyncs, 3, 'non-pending structured update syncs by default')

    await channel.addVideo({ id: 'explicit-private', title: 'Private' }, { syncPublic: false })
    await channel.updateVideo('legacy', { title: 'No sync' }, { syncPublic: false })
    assert.equal(publicSyncs, 3, 'explicit false suppresses sync')
    await channel.updateVideo('explicit-private', { title: 'Forced sync' }, { syncPublic: true })
    assert.equal(publicSyncs, 4, 'explicit true forces sync')
  })
})

test('MultiWriterChannel reuses pairing discovery while waiting for a peer', async () => {
  let joinCalls = 0
  let destroyCalls = 0
  const discovery = {
    async flushed() {},
    async destroy() {
      destroyCalls += 1
    },
    async close() {},
  }
  const swarm = new EventEmitter()
  swarm.connections = new Set([new PassThrough()])
  swarm.join = () => {
    joinCalls += 1
    return discovery
  }
  const channel = Object.create(MultiWriterChannel.prototype)
  Object.assign(channel, {
    _pairingSetupDone: false,
    _channelDiscovery: null,
    _replicatedConnections: new WeakSet(),
    _publicDiscovery: null,
    _publicActivation: null,
    swarm: null,
    core: { discoveryKey: Buffer.alloc(32, 1), writable: false, replicate() {} },
    db: null,
    wakeupSession: null,
    publicBee: null,
    pairingMember: null,
    pairing: null,
    blobs: null,
    _blobsCore: null,
  })

  await channel.setupPairing(swarm)
  assert.equal(await channel.waitForPeerConnection(), true)
  await channel._close()
  assert.equal(joinCalls, 1)
  assert.equal(destroyCalls, 1)
})

test('MultiWriterChannel decodes a referenced blobs key without opening a redundant core', async () => {
  const localKey = Buffer.alloc(32, 1)
  const remoteKeyHex = 'ab'.repeat(32)
  let storeGets = 0
  const channel = Object.create(MultiWriterChannel.prototype)
  Object.assign(channel, {
    _blobsCore: { key: localKey },
    store: {
      get() {
        storeGets += 1
        throw new Error('must not open a core to decode an existing key')
      },
    },
  })

  const entry = await channel.getBlobEntry({
    blobId: '4:2:0:128',
    blobsCoreKey: remoteKeyHex,
  })

  assert.equal(storeGets, 0)
  assert.equal(entry.blobsKey.toString('hex'), remoteKeyHex)
  assert.deepEqual(entry.blobId, {
    blockOffset: 4,
    blockLength: 2,
    byteOffset: 0,
    byteLength: 128,
  })
})
