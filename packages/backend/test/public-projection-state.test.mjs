import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import Corestore from 'corestore'
import crypto from 'hypercore-crypto'

import { createApi } from '../src/api.js'
import { PublicChannelBee } from '../src/channel/public-channel-bee.js'
import { MultiWriterChannel } from '../src/channel/multi-writer-channel.js'
import { createIdentityManager } from '../src/identity.js'
import {
  createChannelRootDescriptor,
  signChannelRootDescriptor,
  verifySignedChannelRootDescriptor,
} from '../src/channel-descriptor.js'
import { deriveIdentity } from '../src/peartube-identity.js'
import { loadChannel } from '../src/storage.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function closeSilently(resource) {
  if (!resource || typeof resource.close !== 'function') return
  try {
    await resource.close()
  } catch {
    // Best-effort cleanup for temporary Corestore resources.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withPublicBee(fn) {
  const dir = makeTempDir('peartube-public-projection-')
  const store = new Corestore(dir)
  let publicBee = null

  try {
    await store.ready()
    publicBee = new PublicChannelBee(store, { name: `projection-${Date.now()}-${Math.random()}` })
    await publicBee.ready()
    await fn(publicBee)
  } finally {
    await closeSilently(publicBee)
    await closeSilently(store)
    rmSync(dir, { recursive: true, force: true })
  }
}

function createMemoryDb() {
  const values = new Map()
  return {
    async get(key) {
      return values.has(key) ? { key, value: values.get(key) } : null
    },
    async put(key, value) {
      values.set(key, value)
    },
  }
}

function createTestSwarm() {
  const joins = []
  const keyPair = crypto.keyPair()
  const swarm = {
    keyPair,
    connections: new Set(),
    dht: {
      on() {},
      off() {},
      removeListener() {},
      lookup() {
        let resolveNext = null
        return {
          closestNodes: [],
          destroy() {
            resolveNext?.({ done: true })
          },
          [Symbol.asyncIterator]() {
            return this
          },
          next() {
            return new Promise((resolve) => {
              resolveNext = resolve
            })
          },
        }
      },
    },
    join(discoveryKey) {
      const entry = {
        keyHex: b4a.toString(discoveryKey, 'hex'),
        destroyed: false,
        closed: false,
      }
      joins.push(entry)
      return {
        async flushed() {},
        destroy() {
          entry.destroyed = true
        },
        close() {
          entry.closed = true
        },
      }
    },
    on() {},
    off() {},
    removeListener() {},
  }
  return { swarm, joins }
}

async function withIdentityContext(fn) {
  const dir = makeTempDir('peartube-deferred-identity-')
  const store = new Corestore(dir)
  const { swarm, joins } = createTestSwarm()
  const ctx = {
    store,
    swarm,
    channels: new Map(),
    metaDb: createMemoryDb(),
    metaSubspaces: {
      channelKinds: { async put() {} },
      publicProjectionStates: createMemoryDb(),
    },
  }

  try {
    await store.ready()
    await fn({ ctx, joins })
  } finally {
    for (const channel of new Set(ctx.channels.values())) await closeSilently(channel)
    await closeSilently(store)
    rmSync(dir, { recursive: true, force: true })
  }
}

function ids(records) {
  return records.map((record) => record.id).sort()
}

test('staged collections merge by logical key and descriptors advance monotonically', (t) => {
  const channel = Object.create(MultiWriterChannel.prototype)
  channel._stagedPublicProjection = {}
  channel._inFlightPublicProjection = null
  const descriptor2 = { descriptor: { seq: 2, updatedAt: 20 } }
  const descriptor1 = { descriptor: { seq: 1, updatedAt: 30 } }

  channel.stagePublicProjection({
    stagedDescriptor: descriptor2,
    stagedSources: [{
      provider: 'youtube',
      identityKey: 'youtube:creator',
      sourceId: 'creator',
      displayName: 'Older Name',
      updatedAt: 10,
    }],
    stagedArtwork: [{
      role: 'poster',
      remoteUrl: 'https://img.example/old.jpg',
      updatedAt: 10,
    }],
  })
  channel.stagePublicProjection({
    stagedDescriptor: descriptor1,
    stagedSources: [
      {
        provider: 'youtube',
        identityKey: 'youtube:creator',
        displayName: 'Newer Name',
        updatedAt: 20,
      },
      {
        provider: 'tmdb',
        identityKey: 'tmdb:9001',
        sourceId: '9001',
        updatedAt: 5,
      },
    ],
    stagedArtwork: [
      {
        role: 'poster',
        remoteUrl: 'https://img.example/new.jpg',
        updatedAt: 20,
      },
      {
        role: 'banner',
        remoteUrl: 'https://img.example/banner.jpg',
        updatedAt: 5,
      },
    ],
  })

  const staged = channel.getStagedPublicProjection()
  t.is(staged.stagedDescriptor, descriptor2, 'lower descriptor sequence cannot replace the staged descriptor')
  t.is(staged.stagedSources.length, 2)
  const youtubeSource = staged.stagedSources.find((source) => source.provider === 'youtube')
  t.is(youtubeSource?.sourceId, 'creator', 'newer partial source retains older defined fields')
  t.is(youtubeSource?.displayName, 'Newer Name')
  t.is(staged.stagedArtwork.length, 2)
  t.is(staged.stagedArtwork.find((artwork) => artwork.role === 'poster')?.remoteUrl, 'https://img.example/new.jpg')

  const reverse = Object.create(MultiWriterChannel.prototype)
  reverse._stagedPublicProjection = {}
  reverse._inFlightPublicProjection = null
  reverse.stagePublicProjection({
    stagedSources: [{
      provider: 'youtube',
      identityKey: 'youtube:tie',
      displayName: 'Zulu',
      updatedAt: 20,
    }],
    stagedArtwork: [{
      role: 'poster',
      remoteUrl: 'https://img.example/zulu.jpg',
      updatedAt: 20,
    }],
  })
  reverse.stagePublicProjection({
    stagedSources: [{
      provider: 'youtube',
      identityKey: 'youtube:tie',
      displayName: 'Alpha',
      updatedAt: 20,
    }],
    stagedArtwork: [{
      role: 'poster',
      remoteUrl: 'https://img.example/alpha.jpg',
      updatedAt: 20,
    }],
  })
  const forward = Object.create(MultiWriterChannel.prototype)
  forward._stagedPublicProjection = {}
  forward._inFlightPublicProjection = null
  forward.stagePublicProjection({
    stagedSources: [{
      provider: 'youtube',
      identityKey: 'youtube:tie',
      displayName: 'Alpha',
      updatedAt: 20,
    }],
    stagedArtwork: [{
      role: 'poster',
      remoteUrl: 'https://img.example/alpha.jpg',
      updatedAt: 20,
    }],
  })
  forward.stagePublicProjection({
    stagedSources: [{
      provider: 'youtube',
      identityKey: 'youtube:tie',
      displayName: 'Zulu',
      updatedAt: 20,
    }],
    stagedArtwork: [{
      role: 'poster',
      remoteUrl: 'https://img.example/zulu.jpg',
      updatedAt: 20,
    }],
  })
  const equalDescriptorA = {
    schema: 'test.signed.descriptor',
    descriptor: { seq: 5, updatedAt: 50 },
    attestation: 'aa',
  }
  const equalDescriptorB = {
    ...equalDescriptorA,
    attestation: 'bb',
  }
  reverse.stagePublicProjection({ stagedDescriptor: equalDescriptorA })
  reverse.stagePublicProjection({ stagedDescriptor: equalDescriptorB })
  forward.stagePublicProjection({ stagedDescriptor: equalDescriptorB })
  forward.stagePublicProjection({ stagedDescriptor: equalDescriptorA })
  t.alike(
    reverse.getStagedPublicProjection(),
    forward.getStagedPublicProjection(),
    'equal-timestamp staged records resolve independently of arrival order',
  )
})

test('public source and artwork upserts are monotonic and merge partial records', async (t) => {
  await withPublicBee(async (publicBee) => {
    await publicBee.putChannelSource({
      provider: 'youtube',
      identityKey: 'source:monotonic',
      sourceId: 'creator',
      displayName: 'Newer Source',
      updatedAt: 20,
    })
    await publicBee.putChannelSource({
      provider: 'youtube',
      identityKey: 'source:monotonic',
      displayName: 'Stale Source',
      handle: '@creator',
      updatedAt: 10,
    })
    t.alike((await publicBee.listChannelSources())[0], {
      provider: 'youtube',
      identityKey: 'source:monotonic',
      sourceId: 'creator',
      handle: '@creator',
      displayName: 'Newer Source',
      updatedAt: 20,
    })

    await publicBee.putChannelArtwork({
      role: 'poster',
      remoteUrl: 'https://img.example/newer.jpg',
      updatedAt: 21,
    })
    await publicBee.putChannelArtwork({
      role: 'poster',
      mimeType: 'image/jpeg',
      remoteUrl: 'https://img.example/stale.jpg',
      updatedAt: 11,
    })
    t.alike((await publicBee.listChannelArtwork())[0], {
      role: 'poster',
      mimeType: 'image/jpeg',
      remoteUrl: 'https://img.example/newer.jpg',
      updatedAt: 21,
    })

    await publicBee.putChannelSource({
      provider: 'rss',
      identityKey: 'source:tie-a',
      displayName: 'Alpha',
      updatedAt: 30,
    })
    await publicBee.putChannelSource({
      provider: 'rss',
      identityKey: 'source:tie-a',
      displayName: 'Zulu',
      updatedAt: 30,
    })
    await publicBee.putChannelSource({
      provider: 'rss',
      identityKey: 'source:tie-b',
      displayName: 'Zulu',
      updatedAt: 30,
    })
    await publicBee.putChannelSource({
      provider: 'rss',
      identityKey: 'source:tie-b',
      displayName: 'Alpha',
      updatedAt: 30,
    })
    const tied = await publicBee.listChannelSources()
    t.is(tied.find((source) => source.identityKey === 'source:tie-a')?.displayName, 'Zulu')
    t.is(tied.find((source) => source.identityKey === 'source:tie-b')?.displayName, 'Zulu')
  })
})

test('root-backed rich channels fail closed on missing details and materialize empty sidecars', async (t) => {
  await withPublicBee(async (publicBee) => {
    const canonicalRevision = 'sha256:root-backed-catalog'
    await publicBee.setRootDescriptor({
      schema: 'test.signed.descriptor',
      descriptor: {
        seq: 1,
        updatedAt: 1,
        profile: { canonicalRevision },
      },
      attestation: 'aa',
    })
    await publicBee.putChannelProfile({ canonicalRevision })
    publicBee._contentDetailsRequired = async () => true
    const compact = { id: 'modern-compact', title: 'Modern compact row', uploadedAt: 1 }
    await publicBee.putVideo(compact.id, compact)
    await publicBee.db.delete('@peartubePublic/contentDetails', { id: compact.id })
    await publicBee.db.flush()

    t.alike(
      await publicBee.listVideos(),
      [],
      'a modern row with a missing required sidecar is not canonically visible',
    )
    t.alike(
      ids(await publicBee.listVideos({ includeSuppressed: true })),
      [compact.id],
      'internal reconciliation retains the compact modern row',
    )

    await publicBee.syncVideos([compact], {
      destructive: false,
      materializeContentDetails: true,
    })
    t.alike(await publicBee.getContentDetails(compact.id), { id: compact.id })
    t.alike(ids(await publicBee.listVideos()), [compact.id])
  })
})
test('structured direct sync establishes modern format before every compact projection row', async (t) => {
  await withPublicBee(async (publicBee) => {
    const compact = { id: 'direct-compact', title: 'Compact', uploadedAt: 1 }
    const identityKey = 'youtube:direct-structured'
    const claimantId = 'd'.repeat(64)
    const structured = {
      id: 'direct-structured',
      title: 'Structured',
      uploadedAt: 2,
      contentKind: 'episode',
      publicationState: 'durabilityVerified',
      importIdentityKey: identityKey,
      importClaimantId: claimantId,
    }
    const forged = {
      ...structured,
      id: 'direct-forged-binding',
      title: 'Forged same-claimant binding',
    }
    await publicBee.putVideo(forged.id, forged)

    await publicBee.syncVideos([compact, structured, forged], {
      destructive: false,
      claimWinners: new Map([[identityKey, { identityKey, claimantId, videoId: structured.id }]]),
    })

    t.is(await publicBee.getProjectionFormat(), 'modern')
    t.alike(await publicBee.getContentDetails(compact.id), { id: compact.id })
    t.is((await publicBee.getContentDetails(structured.id))?.contentKind, 'episode')
    t.alike(ids(await publicBee.listVideos()), [compact.id, structured.id])
    t.absent(await publicBee.getVideo(forged.id))
    t.is(
      (await publicBee.getVideo(forged.id, { includeSuppressed: true }))?.canonicalVisibility,
      'suppressed',
    )
  })
})

test('projection format evidence distinguishes legacy compact rows from uncertain partial modern rows', async (t) => {
  await withPublicBee(async (publicBee) => {
    const compact = { id: 'format-evidence', title: 'Format evidence', uploadedAt: 1 }
    await publicBee.db.insert('@peartubePublic/videos', compact)
    await publicBee.db.flush()

    t.alike(
      await publicBee.listVideosWithStatus(),
      { status: 'uncertain', videos: [], filteredCount: 1 },
      'an unmarked sparse replica cannot masquerade as legacy',
    )

    await publicBee.setProjectionFormat('legacy')
    t.alike((await publicBee.listVideos()).map((video) => video.id), [compact.id])

    await publicBee.setProjectionFormat('modern')
    t.alike(
      await publicBee.listVideosWithStatus(),
      { status: 'uncertain', videos: [], filteredCount: 1 },
      'a durable modern marker fails closed even when profile/root blocks are temporarily absent',
    )
    await t.exception(
      publicBee.setProjectionFormat('legacy'),
      /cannot downgrade/i,
      'modern projection evidence is monotonic',
    )
  })
})


test('public descriptor and revisioned sidecar writes cannot race backward', async (t) => {
  await withPublicBee(async (publicBee) => {
    const descriptor = (seq) => ({
      schema: 'test.signed.descriptor',
      descriptor: { seq, updatedAt: seq },
    })
    await publicBee.setRootDescriptor(descriptor(0))
    const rawPut = publicBee.db.db.put.bind(publicBee.db.db)
    let releaseLowDescriptor
    let markLowDescriptorStarted
    const lowDescriptorGate = new Promise((resolve) => {
      releaseLowDescriptor = resolve
    })
    const lowDescriptorStarted = new Promise((resolve) => {
      markLowDescriptorStarted = resolve
    })
    publicBee.db.db.put = async (key, value) => {
      const record = JSON.parse(b4a.toString(value))
      if (record?.descriptor?.seq === 1) {
        markLowDescriptorStarted()
        await lowDescriptorGate
      }
      return rawPut(key, value)
    }
    const lowDescriptorWrite = publicBee.setRootDescriptor(descriptor(1))
    await lowDescriptorStarted
    const highDescriptorWrite = publicBee.setRootDescriptor(descriptor(2))
    await delay(20)
    releaseLowDescriptor()
    await Promise.all([lowDescriptorWrite, highDescriptorWrite])
    t.is((await publicBee.getRootDescriptor()).descriptor.seq, 2)
    publicBee.db.db.put = rawPut

    const rawInsert = publicBee.db.insert.bind(publicBee.db)
    let releaseLowSource
    let markLowSourceStarted
    const lowSourceGate = new Promise((resolve) => {
      releaseLowSource = resolve
    })
    const lowSourceStarted = new Promise((resolve) => {
      markLowSourceStarted = resolve
    })
    let releaseLowArtwork
    let markLowArtworkStarted
    const lowArtworkGate = new Promise((resolve) => {
      releaseLowArtwork = resolve
    })
    const lowArtworkStarted = new Promise((resolve) => {
      markLowArtworkStarted = resolve
    })
    publicBee.db.insert = async (collection, record) => {
      if (
        collection === '@peartubePublic/channelSources' &&
        record.identityKey === 'source:race' &&
        record.updatedAt === 10
      ) {
        markLowSourceStarted()
        await lowSourceGate
      }
      if (
        collection === '@peartubePublic/channelArtwork' &&
        record.role === 'banner' &&
        record.updatedAt === 10
      ) {
        markLowArtworkStarted()
        await lowArtworkGate
      }
      return rawInsert(collection, record)
    }
    const lowSourceWrite = publicBee.putChannelSource({
      provider: 'youtube',
      identityKey: 'source:race',
      displayName: 'Stale Source',
      updatedAt: 10,
    })
    await lowSourceStarted
    const highSourceWrite = publicBee.putChannelSource({
      provider: 'youtube',
      identityKey: 'source:race',
      displayName: 'New Source',
      updatedAt: 20,
    })
    await delay(20)
    releaseLowSource()
    await Promise.all([lowSourceWrite, highSourceWrite])

    const lowArtworkWrite = publicBee.putChannelArtwork({
      role: 'banner',
      remoteUrl: 'https://img.example/stale-banner.jpg',
      updatedAt: 10,
    })
    await lowArtworkStarted
    const highArtworkWrite = publicBee.putChannelArtwork({
      role: 'banner',
      remoteUrl: 'https://img.example/new-banner.jpg',
      updatedAt: 20,
    })
    await delay(20)
    releaseLowArtwork()
    await Promise.all([lowArtworkWrite, highArtworkWrite])

    const source = (await publicBee.listChannelSources())
      .find((record) => record.identityKey === 'source:race')
    const artwork = (await publicBee.listChannelArtwork())
      .find((record) => record.role === 'banner')
    t.is(source?.displayName, 'New Source')
    t.is(source?.updatedAt, 20)
    t.is(artwork?.remoteUrl, 'https://img.example/new-banner.jpg')
    t.is(artwork?.updatedAt, 20)
  })
})

test('equal-revision descriptors converge independently of arrival order', async (t) => {
  await withPublicBee(async (first) => {
    await withPublicBee(async (second) => {
      const descriptorA = {
        schema: 'test.signed.descriptor',
        descriptor: { seq: 4, updatedAt: 40, channelId: 'aa'.repeat(32) },
        proof: 'proof',
        attestation: 'aa',
      }
      const descriptorB = {
        ...descriptorA,
        attestation: 'bb',
      }
      await first.setRootDescriptor(descriptorA)
      await first.setRootDescriptor(descriptorB)
      await second.setRootDescriptor(descriptorB)
      await second.setRootDescriptor(descriptorA)
      t.alike(
        await first.getRootDescriptor(),
        await second.getRootDescriptor(),
        'root descriptor tie-breaking is stable across replicas',
      )
      t.alike(await first.getRootDescriptor(), descriptorB)
    })
  })
})

test('overlapping public syncs cannot restore a stale claim winner', async (t) => {
  await withPublicBee(async (publicBee) => {
    const identityKey = 'youtube:sync-race'
    const claimantA = 'a'.repeat(64)
    const claimantB = 'b'.repeat(64)
    const videos = [
      {
        id: 'race-a',
        title: 'Claimant A',
        uploadedAt: 1,
        publicationState: 'durabilityVerified',
        importIdentityKey: identityKey,
        importClaimantId: claimantA,
      },
      {
        id: 'race-b',
        title: 'Claimant B',
        uploadedAt: 2,
        publicationState: 'durabilityVerified',
        importIdentityKey: identityKey,
        importClaimantId: claimantB,
      },
    ]
    let claims = [
      {
        identityKey,
        claimantId: claimantA,
        writerKey: '11'.repeat(32),
        jobId: 'job-a',
        videoId: 'race-a',
        state: 'published',
      },
      {
        identityKey,
        claimantId: claimantB,
        writerKey: '22'.repeat(32),
        jobId: 'job-b',
        videoId: 'race-b',
        state: 'published',
      },
    ]
    const channel = {
      keyHex: '44'.repeat(32),
      async getMetadata() { return null },
      async getChannelProfile() { return null },
      async listChannelSources() { return [] },
      async listChannelArtwork() { return [] },
      async listVideos() { return videos },
      async listImportClaims() { return claims },
    }
    const syncVideos = publicBee.syncVideos.bind(publicBee)
    let releaseFirstSync
    let markFirstSyncStarted
    const firstSyncGate = new Promise((resolve) => {
      releaseFirstSync = resolve
    })
    const firstSyncStarted = new Promise((resolve) => {
      markFirstSyncStarted = resolve
    })
    let syncVideoCalls = 0
    publicBee.syncVideos = async (...args) => {
      syncVideoCalls++
      if (syncVideoCalls === 1) {
        markFirstSyncStarted()
        await firstSyncGate
      }
      return syncVideos(...args)
    }

    const staleSync = publicBee.syncFromChannel(channel, { throwOnError: true })
    await firstSyncStarted
    claims = [
      { ...claims[0], state: 'released', releasedAt: 10 },
      claims[1],
    ]
    const currentSync = publicBee.syncFromChannel(channel, { throwOnError: true })
    await delay(30)
    releaseFirstSync()
    await Promise.all([staleSync, currentSync])

    t.alike((await publicBee.listVideos()).map((video) => video.id), ['race-b'])
    const all = await publicBee.listVideos({ includeSuppressed: true })
    t.is(all.find((video) => video.id === 'race-a')?.canonicalVisibility, 'suppressed')
    t.is(all.find((video) => video.id === 'race-b')?.canonicalVisibility, undefined)
  })
})

test('partial claims cannot expose a newcomer beside an unaccounted established winner', async (t) => {
  await withPublicBee(async (publicBee) => {
    const identityKey = 'youtube:partial-newcomer'
    const claimantA = 'a'.repeat(64)
    const claimantB = 'b'.repeat(64)
    let videos = [{
      id: 'established-a',
      title: 'Established A',
      uploadedAt: 1,
      publicationState: 'durabilityVerified',
      importIdentityKey: identityKey,
      importClaimantId: claimantA,
    }]
    let claims = [{
      identityKey,
      claimantId: claimantA,
      writerKey: '11'.repeat(32),
      jobId: 'job-a',
      videoId: 'established-a',
      state: 'published',
    }]
    const channel = {
      keyHex: '55'.repeat(32),
      async getMetadata() { return null },
      async getChannelProfile() { return null },
      async listChannelSources() { return [] },
      async listChannelArtwork() { return [] },
      async listVideos() { return videos },
      async listImportClaims() { return claims },
    }
    await publicBee.syncFromChannel(channel, { throwOnError: true })

    videos = [{
      id: 'newcomer-b',
      title: 'Newcomer B',
      uploadedAt: 2,
      publicationState: 'durabilityVerified',
      importIdentityKey: identityKey,
      importClaimantId: claimantB,
    }]
    claims = [{
      identityKey,
      claimantId: claimantB,
      writerKey: '22'.repeat(32),
      jobId: 'job-b',
      videoId: 'newcomer-b',
      state: 'published',
    }]
    const getContentDetails = publicBee.getContentDetails.bind(publicBee)
    publicBee.getContentDetails = async (videoId) => {
      if (videoId === 'established-a') throw new Error('established sidecar unavailable')
      return getContentDetails(videoId)
    }
    await publicBee.syncFromChannel(channel, { throwOnError: true })
    publicBee.getContentDetails = getContentDetails

    t.alike((await publicBee.listVideos()).map((video) => video.id), ['established-a'])
    t.absent(await publicBee.getVideo('newcomer-b'))
  })
})

test('syncFromChannel projects logical durable winners and reconciles partition losers non-destructively', async (t) => {
  await withPublicBee(async (publicBee) => {
    const identityKey = 'youtube:video-42'
    const winnerId = 'a'.repeat(64)
    const loserId = 'b'.repeat(64)
    let claims = [
      {
        identityKey,
        claimantId: winnerId,
        writerKey: '11'.repeat(32),
        jobId: 'winner-job',
        videoId: 'winner',
        state: 'published',
      },
      {
        identityKey,
        claimantId: loserId,
        writerKey: '22'.repeat(32),
        jobId: 'loser-job',
        videoId: 'loser',
        state: 'published',
      },
    ]
    const privateVideos = [
      { id: 'legacy', title: 'Legacy', uploadedAt: 10 },
      {
        id: 'pending',
        title: 'Private draft',
        uploadedAt: 20,
        publicationState: 'replicationPending',
      },
      {
        id: 'winner',
        title: 'Canonical winner',
        uploadedAt: 30,
        contentKind: 'episode',
        sourceProvider: 'youtube',
        sourceVideoId: 'video-42',
        seasonNumber: 1,
        episodeNumber: 2,
        publicationState: 'durabilityVerified',
        importIdentityKey: identityKey,
        importClaimantId: winnerId,
      },
      {
        id: 'loser',
        title: 'Partition loser',
        uploadedAt: 25,
        contentKind: 'episode',
        sourceProvider: 'youtube',
        sourceVideoId: 'video-42',
        publicationState: 'durabilityVerified',
        importIdentityKey: identityKey,
        importClaimantId: loserId,
      },
    ]
    const privateSources = [{
      provider: 'youtube',
      identityKey: 'youtube:channel-9',
      sourceId: 'channel-9',
      identityUrl: 'https://youtube.example/channel-9',
      handle: '@channel9',
      displayName: 'Channel Nine',
      createdAt: 1,
      updatedAt: 2,
    }]
    const privateArtwork = [{
      role: 'poster',
      blobId: '1:1:0:1',
      blobsCoreKey: '33'.repeat(32),
      mimeType: 'image/jpeg',
      remoteUrl: 'https://img.example/poster.jpg',
      updatedAt: 3,
    }]
    const privateProfile = {
      id: 'profile',
      profileKind: 'tvShow',
      mediaProvider: 'tmdb',
      mediaId: '4242',
      originalLanguage: 'en',
      releaseYear: 2024,
      canonicalRevision: 'sha256:canonical-revision-1',
    }
    let listAllClaimReads = 0
    const privateChannel = {
      keyHex: '44'.repeat(32),
      async getMetadata() {
        return { name: 'Projection Channel', description: 'Private source' }
      },
      async getChannelProfile() {
        return privateProfile
      },
      async listChannelSources() {
        return privateSources
      },
      async listChannelArtwork() {
        return privateArtwork
      },
      async listVideos() {
        return privateVideos
      },
      async listAllImportClaims() {
        listAllClaimReads++
        throw new Error('projection must not scan all claims')
      },
      async listImportClaims(key) {
        return claims.filter((claim) => claim.identityKey === key)
      },
    }

    await publicBee.putVideo('pending', {
      title: 'Pending leaked during an older sync',
      uploadedAt: 1,
      publicationState: 'published',
    })
    await publicBee.putVideo('loser', privateVideos.find((video) => video.id === 'loser'))
    await publicBee.putVideo('winner', {
      ...privateVideos.find((video) => video.id === 'winner'),
      canonicalVisibility: 'suppressed',
      duplicateOfClaimantId: loserId,
    })
    await publicBee.putVideo('unrelated', {
      title: 'Keep across partial snapshots',
      uploadedAt: 5,
      contentKind: 'movie',
      mediaProvider: 'tmdb',
      mediaId: 'unrelated-1',
      publicationState: 'published',
    })

    await publicBee.syncFromChannel(privateChannel)
    t.is(listAllClaimReads, 0, 'claim reconciliation uses identity indexes from bounded candidates')

    const visible = await publicBee.listVideos()
    t.alike(ids(visible), ['legacy', 'unrelated', 'winner'])
    t.absent(await publicBee.getVideo('pending'))

    const internal = await publicBee.listVideos({ includeSuppressed: true })
    t.alike(ids(internal), ['legacy', 'loser', 'unrelated', 'winner'])
    const winner = internal.find((video) => video.id === 'winner')
    const loser = internal.find((video) => video.id === 'loser')
    const unrelated = internal.find((video) => video.id === 'unrelated')
    t.is(winner.contentKind, 'episode', 'public video logically merges content sidecar')
    t.is(winner.episodeNumber, 2)
    t.is(winner.canonicalVisibility, undefined, 'winner stale suppression is cleared')
    t.is(winner.duplicateOfClaimantId, undefined)
    t.is(loser.publicationState, 'durabilityVerified', 'suppression does not overload publication state')
    t.is(loser.canonicalVisibility, 'suppressed')
    t.is(loser.duplicateOfClaimantId, winnerId)
    t.is(unrelated.mediaId, 'unrelated-1', 'partial sync preserves unrelated public sidecars')

    t.alike(await publicBee.getChannelProfile?.(), privateProfile)
    t.alike(await publicBee.listChannelSources?.(), privateSources)
    t.alike(await publicBee.listChannelArtwork?.(), privateArtwork)
    t.is(privateVideos.length, 4, 'projection never deletes private rows')

    await publicBee.syncFromChannel(privateChannel)
    const replay = await publicBee.listVideos({ includeSuppressed: true })
    t.alike(ids(replay), ['legacy', 'loser', 'unrelated', 'winner'])
    t.is(replay.find((video) => video.id === 'loser')?.duplicateOfClaimantId, winnerId)

    const completeClaims = claims
    const getContentDetails = publicBee.getContentDetails.bind(publicBee)
    publicBee.getContentDetails = async (videoId) => {
      if (videoId === 'loser') throw new Error('loser sidecar unavailable')
      return getContentDetails(videoId)
    }
    claims = [completeClaims[1]]
    await publicBee.syncFromChannel(privateChannel)
    publicBee.getContentDetails = getContentDetails
    const afterUnavailableDetails = await publicBee.listVideos({ includeSuppressed: true })
    t.is(
      afterUnavailableDetails.find((video) => video.id === 'loser')?.canonicalVisibility,
      'suppressed',
      'unavailable loser details cannot clear an established suppression marker',
    )
    t.is(
      afterUnavailableDetails.find((video) => video.id === 'loser')?.duplicateOfClaimantId,
      winnerId,
    )
    claims = completeClaims
    claims = [completeClaims[1]]
    await publicBee.syncFromChannel(privateChannel)
    const partialWinnerView = await publicBee.listVideos({ includeSuppressed: true })
    t.is(
      partialWinnerView.find((video) => video.id === 'winner')?.canonicalVisibility,
      undefined,
      'absence of the prior winner claim cannot hide the prior visible winner',
    )
    t.is(
      partialWinnerView.find((video) => video.id === 'loser')?.canonicalVisibility,
      'suppressed',
      'a previously suppressed claimant stays hidden without affirmative winner release',
    )
    t.is(
      partialWinnerView.find((video) => video.id === 'loser')?.duplicateOfClaimantId,
      winnerId,
    )
    claims = completeClaims
    await publicBee.putVideo('claim-view-gap', {
      title: 'Claim outside partial view',
      uploadedAt: 7,
      publicationState: 'durabilityVerified',
      importIdentityKey: identityKey,
      importClaimantId: 'c'.repeat(64),
    })
    claims = [completeClaims[0]]
    await publicBee.syncFromChannel(privateChannel)
    const gapCandidate = await publicBee.getVideo('claim-view-gap')
    t.is(
      gapCandidate?.canonicalVisibility,
      undefined,
      'a bounded partial claim view cannot suppress an unobserved contender',
    )
    t.ok((await publicBee.listVideos()).some((video) => video.id === 'claim-view-gap'))
    await publicBee.applyVideoChanges([{ type: 'del', id: 'claim-view-gap' }])
    claims = completeClaims
    claims = [
      { ...claims[0], state: 'released', releasedAt: 100 },
      claims[1],
    ]
    await publicBee.syncFromChannel(privateChannel)
    const afterRelease = await publicBee.listVideos()
    t.alike(ids(afterRelease), ['legacy', 'loser', 'unrelated'])
    const releaseInternal = await publicBee.listVideos({ includeSuppressed: true })
    t.is(releaseInternal.find((video) => video.id === 'winner')?.canonicalVisibility, 'suppressed')
    t.is(releaseInternal.find((video) => video.id === 'winner')?.duplicateOfClaimantId, loserId)
    t.is(releaseInternal.find((video) => video.id === 'loser')?.canonicalVisibility, undefined)

    claims = [claims[1]]
    await publicBee.syncFromChannel(privateChannel)
    const afterCompaction = await publicBee.listVideos({ includeSuppressed: true })
    t.is(afterCompaction.find((video) => video.id === 'winner')?.duplicateOfClaimantId, loserId)
    t.alike(ids(await publicBee.listVideos()), ['legacy', 'loser', 'unrelated'])

    const { videoId: _releasedVideoId, ...releasedWithoutVideoId } = claims[0]
    claims = [{ ...releasedWithoutVideoId, state: 'released', releasedAt: 200 }]
    await publicBee.syncFromChannel(privateChannel)
    const afterFinalRelease = await publicBee.listVideos({ includeSuppressed: true })
    t.is(afterFinalRelease.find((video) => video.id === 'loser')?.canonicalVisibility, 'suppressed')
    t.is(afterFinalRelease.find((video) => video.id === 'loser')?.duplicateOfClaimantId, undefined)
    t.alike(ids(await publicBee.listVideos()), ['legacy', 'unrelated'])

    claims = []
    await publicBee.syncFromChannel(privateChannel)

    t.alike(ids(await publicBee.listVideos()), ['legacy', 'unrelated'])
  })
})

test('identity creation cannot swallow signed root descriptor failures', async (t) => {
  await withIdentityContext(async ({ ctx }) => {
    const identityManager = createIdentityManager({ ctx })
    identityManager.attestDevice = async () => {
      throw new Error('attestation unavailable')
    }
    await t.exception(
      identityManager.createIdentity('Descriptor Failure Channel', false, {
        deferPublicProjection: true,
      }),
      /signed channel root descriptor creation failed/i,
    )
    t.absent(
      identityManager.getIdentities().find((identity) =>
        identity.name === 'Descriptor Failure Channel'),
      'an unsigned identity is never persisted',
    )
  })
})

test('deferred activation requires a valid accepted channel root descriptor', async (t) => {
  await withIdentityContext(async ({ ctx, joins }) => {
    const identityManager = createIdentityManager({ ctx })
    const created = await identityManager.createIdentity('Missing Root Channel', false, {
      deferPublicProjection: true,
    })
    const channel = ctx.channels.get(created.driveKey)
    const publicDiscoveryKeyHex = b4a.toString(channel.publicBee.discoveryKey, 'hex')
    channel._stagedPublicProjection = {}

    await t.exception(
      channel.activatePublicProjection({
        stagedProfile: {
          name: 'Must Stay Private',
          canonicalRevision: 'sha256:missing-root',
        },
      }),
      /valid signed channel root descriptor/i,
    )
    t.is(channel.publicProjectionActive, false)
    t.is((await channel.getMetadata()).publicBeeKey, null)
    t.absent(
      joins.find((entry) => entry.keyHex === publicDiscoveryKeyHex),
      'descriptor failure cannot join public discovery',
    )
    t.is(
      channel.getStagedPublicProjection().stagedProfile?.canonicalRevision,
      'sha256:missing-root',
      'failed descriptor activation remains replayable',
    )
  })
})

test('deferred identity creation has no public side effects until idempotent activation', async (t) => {
  await withIdentityContext(async ({ ctx, joins }) => {
    const identityManager = createIdentityManager({ ctx })
    const created = await identityManager.createIdentity('Deferred Channel', true, {
      deferPublicProjection: true,
    })
    let channel = ctx.channels.get(created.driveKey)
    const publicDiscoveryKeyHex = b4a.toString(channel.publicBee.discoveryKey, 'hex')
    const { identityKeyPair, identityPublicKey } = await deriveIdentity(created.mnemonic)
    const deviceProof = await identityManager.attestDevice(
      identityKeyPair,
      ctx.swarm.keyPair.publicKey,
    )
    const signDescriptorRevision = async (seq, canonicalRevision = null) => {
      const descriptor = createChannelRootDescriptor({
        ...created.signedDescriptor.descriptor,
        seq,
        updatedAt: created.signedDescriptor.descriptor.updatedAt + seq,
        profile: canonicalRevision
          ? { ...created.signedDescriptor.descriptor.profile, canonicalRevision }
          : created.signedDescriptor.descriptor.profile,
      })
      return signChannelRootDescriptor({
        descriptor,
        deviceKeyPair: ctx.swarm.keyPair,
        deviceProof,
      })
    }

    t.ok(channel.publicBeeKey, 'deferred channel allocates a public key for authorization')
    t.ok(created.signedDescriptor, 'signed descriptor remains available to the durable job boundary')
    const createdDescriptorVerification = await verifySignedChannelRootDescriptor(
      created.signedDescriptor
    )
    t.ok(createdDescriptorVerification.valid, 'created descriptor attestation verifies')
    t.is(
      createdDescriptorVerification.identityPublicKey,
      b4a.toString(identityPublicKey, 'hex'),
      'descriptor attestation is rooted in the mnemonic-derived identity key',
    )
    t.absent(await channel.publicBee.getMetadata(), 'no public bootstrap metadata before activation')
    t.alike(await channel.publicBee.listVideos(), [])
    t.absent(await channel.publicBee.getRootDescriptor?.(), 'descriptor is not publicly written before activation')
    t.absent(joins.find((entry) => entry.keyHex === publicDiscoveryKeyHex), 'public discovery is not joined')
    t.is((await channel.getMetadata()).publicBeeKey, null, 'deferred key is not feed-exposed through private metadata')

    await channel.close()
    ctx.channels.delete(created.driveKey)
    let descriptorLoadOptions = null
    const coldDescriptorApi = createApi({
      ctx,
      loadChannel: async (_context, _key, options) => {
        descriptorLoadOptions = options
        return {
          publicBee: null,
          getStagedPublicProjection() {
            return { stagedDescriptor: created.signedDescriptor }
          },
        }
      },
    })
    t.alike(
      await coldDescriptorApi.getChannelSignedDescriptor(created.driveKey),
      created.signedDescriptor,
    )
    t.is(
      descriptorLoadOptions?.deferPublicProjection,
      true,
      'an uncached descriptor read preserves the persisted deferred channel mode',
    )
    const signedRevision2 = await signDescriptorRevision(2)
    let stagedDescriptorForLookup = signedRevision2
    let revisionDescriptorLoads = 0
    const revisionDescriptorApi = createApi({
      ctx,
      loadChannel: async () => {
        revisionDescriptorLoads++
        return {
          publicBee: {
            async getRootDescriptor() {
              return created.signedDescriptor
            },
          },
          getStagedPublicProjection() {
            return { stagedDescriptor: stagedDescriptorForLookup }
          },
        }
      },
    })
    t.is(
      (await revisionDescriptorApi.getChannelSignedDescriptor(created.driveKey))?.descriptor?.seq,
      2,
      'descriptor lookup chooses a newer staged revision over the published root',
    )
    stagedDescriptorForLookup = await signDescriptorRevision(3)
    t.is(
      (await revisionDescriptorApi.getChannelSignedDescriptor(created.driveKey))?.descriptor?.seq,
      3,
      'a newer local stage invalidates an older positive descriptor cache result',
    )
    t.is(revisionDescriptorLoads, 2)
    const timeoutCountBeforeReload = process.getActiveResourcesInfo()
      .filter((resource) => resource === 'Timeout').length
    await identityManager.ensureSignedChannelDescriptors()
    t.is(
      process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length,
      timeoutCountBeforeReload,
      'successful channel reload clears its ready timeout',
    )
    channel = ctx.channels.get(created.driveKey)
    t.ok(channel, 'startup descriptor reconciliation reloads the owned channel')
    t.absent(await channel.publicBee.getMetadata(), 'startup reconciliation preserves deferred projection')
    t.absent(await channel.publicBee.getRootDescriptor(), 'startup reconciliation stages rather than publishes descriptor')
    t.absent(joins.find((entry) => entry.keyHex === publicDiscoveryKeyHex), 'startup reconciliation does not join public discovery')
    t.ok(channel.getStagedPublicProjection().stagedDescriptor, 'startup reconciliation restores staged descriptor')
    const api = createApi({
      ctx,
      loadChannel: async (context, key) => context.channels.get(key) || null,
    })
    t.alike(
      await api.getChannelSignedDescriptor(created.driveKey),
      created.signedDescriptor,
      'feed descriptor lookup uses the staged descriptor before public activation',
    )

    const stagedProfile = {
      name: 'Deferred Rich Channel',
      description: 'Published only after durability',
      profileKind: 'tvShow',
      mediaProvider: 'tmdb',
      mediaId: '9001',
      originalLanguage: 'en',
      releaseYear: 2026,
      canonicalRevision: 'sha256:deferred-revision-1',
    }
    const stagedSources = [{
      provider: 'youtube',
      identityKey: 'id:deferred-channel',
      sourceId: 'deferred-channel',
      displayName: 'Deferred Source',
      updatedAt: 10,
    }]
    const stagedArtwork = [{
      role: 'poster',
      remoteUrl: 'https://img.example/deferred-poster.jpg',
      updatedAt: 11,
    }]

    if (typeof channel.stagePublicProjection === 'function') {
      channel.stagePublicProjection({
        stagedDescriptor: created.signedDescriptor,
        stagedProfile,
        stagedSources,
        stagedArtwork,
      })
    }

    await channel.addVideo({
      id: 'deferred-video',
      title: 'Deferred Video',
      uploadedAt: 12,
      contentKind: 'episode',
      publicationState: 'replicationPending',
    })
    await channel.updateMetadata({ description: 'Unrelated private metadata sync' })
    t.absent(await channel.publicBee.getMetadata(), 'unrelated sync cannot leak staged profile changes')
    t.alike(await channel.publicBee.listVideos(), [], 'pending video remains private')

    await channel.updateVideo('deferred-video', { publicationState: 'durabilityVerified' })
    t.alike(await channel.publicBee.listVideos(), [], 'durable video waits for explicit activation')
    await channel.addVideo({
      id: 'failed-activation-delete',
      title: 'Delete after failed activation',
      uploadedAt: 13,
      publicationState: 'durabilityVerified',
    })

    t.is(typeof channel.activatePublicProjection, 'function')
    if (typeof channel.activatePublicProjection !== 'function') return

    const listVideos = channel.listVideos.bind(channel)
    channel.listVideos = async () => {
      throw new Error('projection read failed')
    }
    await t.exception(
      channel.activatePublicProjection({
        stagedDescriptor: created.signedDescriptor,
        stagedProfile,
        stagedSources,
        stagedArtwork,
      }),
      /projection read failed/,
      'activation rejects when durable projection cannot be read',
    )
    channel.listVideos = listVideos
    t.is((await channel.getMetadata()).publicBeeKey, null, 'failed activation remains private')
    t.absent(joins.find((entry) => entry.keyHex === publicDiscoveryKeyHex), 'failed activation does not join discovery')
    const updateMetadata = channel.updateMetadata.bind(channel)
    const publicJoinsBeforeMetadataFailure = joins.filter(
      (entry) => entry.keyHex === publicDiscoveryKeyHex
    ).length
    channel.updateMetadata = async (updates) => {
      if (updates?.publicBeeKey) throw new Error('public metadata commit failed')
      return updateMetadata(updates)
    }
    await t.exception(
      channel.activatePublicProjection(),
      /public metadata commit failed/,
      'fallible metadata commit completes before public discovery exposure',
    )
    channel.updateMetadata = updateMetadata
    t.is(
      joins.filter((entry) => entry.keyHex === publicDiscoveryKeyHex).length,
      publicJoinsBeforeMetadataFailure,
      'metadata failure cannot attempt public discovery',
    )
    t.is((await channel.getMetadata()).publicBeeKey, null)


    const join = ctx.swarm.join.bind(ctx.swarm)
    ctx.swarm.join = (discoveryKey) => {
      if (b4a.equals(discoveryKey, channel.publicBee.discoveryKey)) {
        throw new Error('public discovery join failed')
      }
      return join(discoveryKey)
    }
    await t.exception(
      channel.activatePublicProjection(),
      /public discovery join failed/,
      'activation propagates a synchronous public discovery join failure',
    )
    t.is(channel.publicProjectionActive, false)
    t.is((await channel.getMetadata()).publicBeeKey, null)
    await channel.deleteVideo('failed-activation-delete')
    t.absent(
      await channel.publicBee.getVideo('failed-activation-delete'),
      'delete tombstones a row written by failed activation while projection is inactive',
    )

    let rejectedJoinDestroyed = false
    ctx.swarm.join = (discoveryKey) => {
      if (!b4a.equals(discoveryKey, channel.publicBee.discoveryKey)) return join(discoveryKey)
      return {
        async flushed() {
          throw new Error('public discovery flush failed')
        },
        destroy() {
          rejectedJoinDestroyed = true
        },
        close() {
          rejectedJoinDestroyed = true
        },
      }
    }
    await t.exception(
      channel.activatePublicProjection(),
      /public discovery flush failed/,
      'activation propagates public discovery flush rejection',
    )
    t.ok(rejectedJoinDestroyed, 'failed strict discovery join is cleaned up')
    t.is(channel.publicProjectionActive, false)
    t.is((await channel.getMetadata()).publicBeeKey, null)

    let timedOutJoinDestroyed = false
    channel.opts.publicDiscoveryFlushTimeoutMs = 20
    ctx.swarm.join = (discoveryKey) => {
      if (!b4a.equals(discoveryKey, channel.publicBee.discoveryKey)) return join(discoveryKey)
      return {
        flushed() {
          return new Promise(() => {})
        },
        destroy() {
          timedOutJoinDestroyed = true
        },
        close() {
          timedOutJoinDestroyed = true
        },
      }
    }
    const flushTimeoutStarted = Date.now()
    await t.exception(
      channel.activatePublicProjection(),
      /public discovery flush timed out/i,
    )
    t.ok(Date.now() - flushTimeoutStarted < 150, 'strict discovery timeout is bounded')
    t.ok(timedOutJoinDestroyed, 'timed-out provisional discovery is destroyed')
    t.is(channel.publicProjectionActive, false)
    t.is((await channel.getMetadata()).publicBeeKey, null)
    delete channel.opts.publicDiscoveryFlushTimeoutMs
    ctx.swarm.join = join

    await channel.activatePublicProjection({
      stagedDescriptor: created.signedDescriptor,
      stagedProfile,
      stagedSources,
      stagedArtwork,
    })

    const activatedMeta = await channel.publicBee.getMetadata()
    t.is(activatedMeta.name, 'Deferred Channel')
    t.is(activatedMeta.description, 'Unrelated private metadata sync')
    t.alike(await channel.publicBee.getChannelProfile(), {
      id: 'profile',
      profileKind: 'tvShow',
      mediaProvider: 'tmdb',
      mediaId: '9001',
      originalLanguage: 'en',
      releaseYear: 2026,
      canonicalRevision: 'sha256:deferred-revision-1',
    })
    t.alike(await channel.publicBee.listChannelSources(), stagedSources)
    t.alike(await channel.publicBee.listChannelArtwork(), stagedArtwork)
    t.is((await channel.publicBee.getRootDescriptor()).descriptor.channelId, created.driveKey)
    t.alike(ids(await channel.publicBee.listVideos()), ['deferred-video'])
    t.ok(joins.find((entry) => entry.keyHex === publicDiscoveryKeyHex), 'activation joins public discovery')

    const profileRevision2 = await signDescriptorRevision(2, 'sha256:profile-revision-2')
    await channel.activatePublicProjection({
      stagedDescriptor: profileRevision2,
      stagedProfile: { canonicalRevision: 'sha256:profile-revision-2' },
    })
    const staleProfileRevision1 = await signDescriptorRevision(1, 'sha256:profile-revision-1')
    await channel.activatePublicProjection({
      stagedDescriptor: staleProfileRevision1,
      stagedProfile: { canonicalRevision: 'sha256:profile-revision-1' },
    })
    t.is(
      (await channel.publicBee.getChannelProfile()).canonicalRevision,
      'sha256:profile-revision-2',
      'a stale descriptor replay cannot regress the public profile revision',
    )
    t.ok(
      await channel.publicBee._contentDetailsRequired(),
      'matching signed-root and public profile revisions durably require content sidecars',
    )

    const activatePublicProjection = channel.publicBee.activatePublicProjection.bind(channel.publicBee)
    let releaseProjection
    let markProjectionStarted
    const projectionGate = new Promise((resolve) => {
      releaseProjection = resolve
    })
    const projectionStarted = new Promise((resolve) => {
      markProjectionStarted = resolve
    })
    channel.publicBee.activatePublicProjection = async (input) => {
      markProjectionStarted()
      await projectionGate
      return activatePublicProjection(input)
    }
    const inFlightActivation = channel.activatePublicProjection({
      stagedDescriptor: created.signedDescriptor,
    })
    await projectionStarted
    t.alike(
      channel.getStagedPublicProjection().stagedDescriptor,
      created.signedDescriptor,
      'the in-flight stage remains observable until activation succeeds',
    )
    const queuedDescriptor = await signDescriptorRevision(
      3,
      'sha256:queued-during-activation',
    )
    channel.stagePublicProjection({
      stagedDescriptor: queuedDescriptor,
      stagedProfile: { canonicalRevision: 'sha256:queued-during-activation' },
    })
    releaseProjection()
    await inFlightActivation
    t.is(
      channel.getStagedPublicProjection().stagedProfile?.canonicalRevision,
      'sha256:queued-during-activation',
      'staging during activation remains queued for the next replay',
    )
    t.alike(
      channel.getStagedPublicProjection().stagedDescriptor,
      queuedDescriptor,
      'a newer descriptor staged during activation remains queued for replay',
    )
    channel.publicBee.activatePublicProjection = activatePublicProjection
    await channel.activatePublicProjection()
    t.is(
      (await channel.publicBee.getChannelProfile()).canonicalRevision,
      'sha256:queued-during-activation',
      'the next replay consumes the concurrently queued stage',
    )
    t.is(
      (await channel.publicBee.getRootDescriptor()).descriptor.seq,
      3,
      'the next replay publishes the newer concurrently queued descriptor',
    )

    const newerDescriptor = await signDescriptorRevision(4)
    const staleDescriptor = await signDescriptorRevision(3)
    await channel.publicBee.setRootDescriptor(newerDescriptor)
    await channel.activatePublicProjection({ stagedDescriptor: staleDescriptor })
    t.is(
      (await channel.publicBee.getRootDescriptor()).descriptor.seq,
      4,
      'a replayed stale stage cannot overwrite a newer public descriptor',
    )
    t.absent(
      channel.getStagedPublicProjection().stagedDescriptor,
      'a successful activation consumes its staged descriptor',
    )

    await channel.updateMetadata({
      name: 'Newer Private Channel',
      description: 'Newer committed metadata',
    })
    await channel.putChannelProfile({
      profileKind: 'creator',
      mediaProvider: 'tmdb',
      mediaId: 'newer-profile',
      originalLanguage: 'fr',
      releaseYear: 2027,
    })
    await channel.putChannelSource({
      ...stagedSources[0],
      displayName: 'Newer Committed Source',
      updatedAt: 20,
    })
    await channel.putChannelArtwork({
      ...stagedArtwork[0],
      remoteUrl: 'https://img.example/newer-poster.jpg',
      updatedAt: 21,
    })

    await channel.activatePublicProjection()
    t.is((await channel.publicBee.getMetadata()).name, 'Newer Private Channel')
    t.is((await channel.publicBee.getMetadata()).description, 'Newer committed metadata')
    t.is((await channel.publicBee.getChannelProfile()).mediaId, 'newer-profile')
    t.is((await channel.publicBee.listChannelSources())[0]?.displayName, 'Newer Committed Source')
    t.is((await channel.publicBee.listChannelArtwork())[0]?.remoteUrl, 'https://img.example/newer-poster.jpg')
    t.alike(ids(await channel.publicBee.listVideos()), ['deferred-video'])
    t.is((await channel.publicBee.listChannelSources()).length, 1)
    t.is((await channel.publicBee.listChannelArtwork()).length, 1)
    t.is(joins.filter((entry) => entry.keyHex === publicDiscoveryKeyHex).length, 1, 'replay does not duplicate discovery')

    const publicJoin = joins.find((entry) => entry.keyHex === publicDiscoveryKeyHex)
    await channel.close()
    ctx.channels.delete(created.driveKey)
    t.ok(publicJoin.destroyed || publicJoin.closed, 'channel close releases its public discovery handle')
  })
})

test('failed deferred discovery activation remains private after channel reload', async (t) => {
  await withIdentityContext(async ({ ctx, joins }) => {
    const identityManager = createIdentityManager({ ctx })
    const created = await identityManager.createIdentity('Restart Safe Deferred Channel', false, {
      deferPublicProjection: true,
    })
    let channel = ctx.channels.get(created.driveKey)
    const publicDiscoveryKeyHex = b4a.toString(channel.publicBee.discoveryKey, 'hex')
    const originalJoin = ctx.swarm.join.bind(ctx.swarm)
    ctx.swarm.join = (discoveryKey) => {
      if (b4a.equals(discoveryKey, channel.publicBee.discoveryKey)) {
        throw new Error('restart-gap public discovery failure')
      }
      return originalJoin(discoveryKey)
    }

    await t.exception(
      channel.activatePublicProjection(),
      /restart-gap public discovery failure/,
    )
    t.is(channel.publicProjectionActive, false)
    t.is((await channel.getMetadata()).publicBeeKey, null)
    await channel.close()
    ctx.channels.delete(created.driveKey)

    const publicJoinsBeforeReload = joins.filter(
      (entry) => entry.keyHex === publicDiscoveryKeyHex
    ).length
    ctx.swarm.join = originalJoin
    const identity = identityManager.getIdentities().find(
      (candidate) => candidate.driveKey === created.driveKey
    )
    channel = await loadChannel(ctx, created.driveKey, {
      encryptionKeyHex: identity.channelEncryptionKey,
      writerKeyName: identity.channelWriterKeyName,
      preferWritable: true,
    })

    t.is(channel.publicProjectionActive, false, 'pending activation stays inactive after reload')
    t.is((await channel.getMetadata()).publicBeeKey, null, 'pending public key remains feed-masked')
    t.is(
      joins.filter((entry) => entry.keyHex === publicDiscoveryKeyHex).length,
      publicJoinsBeforeReload,
      'reload does not join discovery without durable active evidence',
    )
  })
})

test('active marker failure is fail-closed on reload and idempotent replay repairs it', async (t) => {
  await withIdentityContext(async ({ ctx, joins }) => {
    const identityManager = createIdentityManager({ ctx })
    const created = await identityManager.createIdentity('Repairable Deferred Channel', false, {
      deferPublicProjection: true,
    })
    let channel = ctx.channels.get(created.driveKey)
    const publicDiscoveryKeyHex = b4a.toString(channel.publicBee.discoveryKey, 'hex')
    const persistProjectionState = channel.opts.setPublicProjectionState
    let rejectActiveMarker = true
    channel.opts.setPublicProjectionState = async (state) => {
      if (state === 'active' && rejectActiveMarker) {
        rejectActiveMarker = false
        throw new Error('active marker unavailable')
      }
      return persistProjectionState(state)
    }

    await channel.activatePublicProjection()
    t.is(channel.publicProjectionActive, true, 'post-exposure marker failure does not reject activation')
    let marker = await ctx.metaSubspaces.publicProjectionStates.get(
      created.driveKey.toLowerCase()
    )
    t.is(marker?.value?.state, 'pending')
    await channel.close()
    ctx.channels.delete(created.driveKey)

    const identity = identityManager.getIdentities().find(
      (candidate) => candidate.driveKey === created.driveKey
    )
    const loadOwnedChannel = () => loadChannel(ctx, created.driveKey, {
      encryptionKeyHex: identity.channelEncryptionKey,
      writerKeyName: identity.channelWriterKeyName,
      preferWritable: true,
    })
    const joinsBeforePendingReload = joins.filter(
      (entry) => entry.keyHex === publicDiscoveryKeyHex
    ).length
    channel = await loadOwnedChannel()
    t.is(channel.publicProjectionActive, false, 'pending marker reload fails closed')
    t.is((await channel.getMetadata()).publicBeeKey, null)
    t.is(
      joins.filter((entry) => entry.keyHex === publicDiscoveryKeyHex).length,
      joinsBeforePendingReload,
    )

    await channel.activatePublicProjection()
    marker = await ctx.metaSubspaces.publicProjectionStates.get(
      created.driveKey.toLowerCase()
    )
    t.is(marker?.value?.state, 'active', 'idempotent replay repairs active evidence')
    await channel.close()
    ctx.channels.delete(created.driveKey)

    channel = await loadOwnedChannel()
    t.is(channel.publicProjectionActive, true, 'durable active evidence restores projection')
    t.is((await channel.getMetadata()).publicBeeKey, channel.publicBeeKey)
    const joinsAfterActiveReload = joins.filter(
      (entry) => entry.keyHex === publicDiscoveryKeyHex
    ).length
    await channel.activatePublicProjection()
    t.is(
      joins.filter((entry) => entry.keyHex === publicDiscoveryKeyHex).length,
      joinsAfterActiveReload,
      'active replay reuses the restored discovery handle',
    )
  })
})

test('closing during first activation cannot leak a late public discovery join', async (t) => {
  await withIdentityContext(async ({ ctx, joins }) => {
    const identityManager = createIdentityManager({ ctx })
    const created = await identityManager.createIdentity('Closing Deferred Channel', false, {
      deferPublicProjection: true,
    })
    const channel = ctx.channels.get(created.driveKey)
    const publicBee = channel.publicBee
    const publicDiscoveryKeyHex = b4a.toString(publicBee.discoveryKey, 'hex')
    const joinPublicDiscovery = channel._joinPublicDiscovery.bind(channel)
    const closePublicBee = publicBee.close.bind(publicBee)
    let releaseJoin
    let markJoinStarted
    let releasePublicBeeClose
    let markPublicBeeCloseStarted
    const joinGate = new Promise((resolve) => {
      releaseJoin = resolve
    })
    const joinStarted = new Promise((resolve) => {
      markJoinStarted = resolve
    })
    const publicBeeCloseGate = new Promise((resolve) => {
      releasePublicBeeClose = resolve
    })
    const publicBeeCloseStarted = new Promise((resolve) => {
      markPublicBeeCloseStarted = resolve
    })

    channel._joinPublicDiscovery = async () => {
      markJoinStarted()
      await joinGate
      return joinPublicDiscovery()
    }
    publicBee.close = async () => {
      markPublicBeeCloseStarted()
      await publicBeeCloseGate
      return closePublicBee()
    }

    const activation = channel.activatePublicProjection({
      stagedDescriptor: created.signedDescriptor,
      stagedProfile: { name: 'Closing Deferred Channel' },
    })
    await joinStarted
    const close = channel.close()
    const closeReachedPublicBee = await Promise.race([
      publicBeeCloseStarted.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10)),
    ])
    releaseJoin()
    if (!closeReachedPublicBee) await publicBeeCloseStarted
    releasePublicBeeClose()
    await Promise.allSettled([activation, close])
    ctx.channels.delete(created.driveKey)

    t.absent(
      joins.find((entry) =>
        entry.keyHex === publicDiscoveryKeyHex &&
        entry.destroyed !== true &&
        entry.closed !== true),
      'channel close leaves no live public discovery handle created by activation',
    )
  })
})

test('default identity creation still publishes bootstrap metadata and discovery', async (t) => {
  await withIdentityContext(async ({ ctx, joins }) => {
    const identityManager = createIdentityManager({ ctx })
    const created = await identityManager.createIdentity('Legacy Default Channel', false)
    const channel = ctx.channels.get(created.driveKey)
    const publicDiscoveryKeyHex = b4a.toString(channel.publicBee.discoveryKey, 'hex')

    t.is((await channel.publicBee.getMetadata())?.name, 'Legacy Default Channel')
    t.ok(joins.find((entry) => entry.keyHex === publicDiscoveryKeyHex), 'legacy default joins public discovery')
  })
})
test('storage centrally preserves deferred mode for optionless channel loads', async (t) => {
  await withIdentityContext(async ({ ctx, joins }) => {
    const identityManager = createIdentityManager({ ctx })
    const created = await identityManager.createIdentity('Cold Deferred Channel', false, {
      deferPublicProjection: true,
    })
    let channel = ctx.channels.get(created.driveKey)
    const publicDiscoveryKeyHex = b4a.toString(channel.publicBee.discoveryKey, 'hex')
    await channel.close()
    ctx.channels.delete(created.driveKey)

    channel = await loadChannel(ctx, created.driveKey.toUpperCase())
    t.is(channel.publicProjectionActive, false)
    t.absent(await channel.publicBee.getMetadata())
    t.is(ctx.channels.get(created.driveKey), channel, 'owned channel cache keys are canonical lowercase')
    t.absent(ctx.channels.get(created.driveKey.toUpperCase()))
    t.absent(
      joins.find((entry) =>
        entry.keyHex === publicDiscoveryKeyHex &&
        entry.destroyed !== true &&
        entry.closed !== true),
      'optionless storage load does not expose deferred public discovery',
    )
  })
})

test('projection marker writes preserve concurrent identity saves and never regress active', async (t) => {
  await withIdentityContext(async ({ ctx }) => {
    const identityManager = createIdentityManager({ ctx })
    const created = await identityManager.createIdentity('Concurrent Marker Channel', false, {
      deferPublicProjection: true,
    })
    const channel = ctx.channels.get(created.driveKey)
    const states = ctx.metaSubspaces.publicProjectionStates
    t.ok(states, 'projection state has a dedicated keyed metadata subspace')
    if (!states) return

    const originalGet = states.get.bind(states)
    let releasePendingRead
    let markPendingRead
    const pendingRead = new Promise((resolve) => {
      markPendingRead = resolve
    })
    const releasePending = new Promise((resolve) => {
      releasePendingRead = resolve
    })
    let blockFirstRead = true
    states.get = async (key) => {
      const node = await originalGet(key)
      if (blockFirstRead) {
        blockFirstRead = false
        markPendingRead()
        await releasePending
      }
      return node
    }

    const pendingWrite = channel.opts.setPublicProjectionState('pending')
    await pendingRead
    const personalKey = 'ab'.repeat(32)
    await identityManager.setPersonalKey(created.publicKey, personalKey)
    const activeWrite = channel.opts.setPublicProjectionState('active')
    releasePendingRead()
    await Promise.all([pendingWrite, activeWrite])
    states.get = originalGet

    const storedIdentities = (await ctx.metaDb.get('identities')).value
    t.is(
      storedIdentities.find((identity) => identity.publicKey === created.publicKey)?.personalKey,
      personalKey,
      'marker update cannot erase a concurrent identity save',
    )
    const marker = await states.get(created.driveKey.toLowerCase())
    t.is(marker?.value?.state, 'active', 'pending cannot race a durable active marker backward')
    t.absent(await states.get(created.driveKey.toUpperCase()), 'marker key is canonical lowercase')
  })
})

test('storage fails closed when persisted projection mode cannot be resolved', async (t) => {
  const ctx = {
    channels: new Map(),
    metaDb: {
      async get() {
        throw new Error('identity metadata unavailable')
      },
    },
  }
  await t.exception(
    loadChannel(ctx, 'a'.repeat(64)),
    /Unable to resolve channel public projection mode/,
  )
  t.is(ctx.channels.size, 0, 'an unresolved mode never opens or caches a channel')
})

