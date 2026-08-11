import test from 'brittle'
import { EventEmitter } from 'node:events'
import crypto from 'hypercore-crypto'

import { createApi } from '../src/api.js'
import { BlobPlaybackService } from '../src/blob-playback-service.js'
import { createStaticAssetManifest } from '../src/assets/static-core.js'
import { createPublicationManifest } from '../src/assets/manifest.js'
import { createRenditionDescriptor } from '../src/assets/rendition.js'
import { normalizeAssetCoreRefV2 } from '../src/assets/rendition.js'
import { createStaticAssetPlayback } from '../src/playback/index.js'
import { VERIFIED_CANDIDATE_MANIFEST } from '../src/search/source-verifier.js'

function immutablePlaybackFixture(fill = 21) {
  const keyPair = crypto.keyPair(Buffer.alloc(32, fill))
  const coreRef = createStaticAssetManifest({
    treeHash: Buffer.alloc(32, fill + 1),
    blockLength: 2,
    byteLength: 512 * 1024,
  })
  const manifest = createPublicationManifest({
    publisherId: keyPair.publicKey,
    title: 'Immutable playback',
    renditions: [createRenditionDescriptor({
      purpose: 'video',
      format: 'video/mp4',
      core: coreRef,
    })],
    keyPair,
    signedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
  })
  const rendition = manifest.body.renditions[0]
  const normalized = normalizeAssetCoreRefV2(coreRef)
  return {
    coreRef: normalized,
    manifest,
    rendition,
    immutablePublication: {
      publicationId: manifest.publicationId,
      manifestId: manifest.body.manifestId,
      renditionId: rendition.renditionId,
      assetId: normalized.assetId,
      coreKey: normalized.key,
      publisherId: manifest.body.publisherId,
      manifest,
    },
  }
}

function immutablePlaybackFixtureForCore(coreRef, fill, title) {
  const keyPair = crypto.keyPair(Buffer.alloc(32, fill))
  const manifest = createPublicationManifest({
    publisherId: keyPair.publicKey,
    title,
    renditions: [createRenditionDescriptor({
      purpose: 'video',
      format: 'video/mp4',
      core: coreRef,
    })],
    keyPair,
    signedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
  })
  const rendition = manifest.body.renditions[0]
  const normalized = normalizeAssetCoreRefV2(coreRef)
  return {
    coreRef: normalized,
    manifest,
    rendition,
    immutablePublication: {
      publicationId: manifest.publicationId,
      manifestId: manifest.body.manifestId,
      renditionId: rendition.renditionId,
      assetId: normalized.assetId,
      coreKey: normalized.key,
      publisherId: manifest.body.publisherId,
      manifest,
    },
  }
}

test('preparePlayback returns a streamable URL without waiting for startup prefetch', async (t) => {
  const api = createApi({ ctx: {} })
  const calls = []
  const statsValue = {
    status: 'unknown',
    progress: 0,
    totalBlocks: 0,
    downloadedBlocks: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    peerCount: 0,
    swarmConnections: 0,
    speedMBps: '0',
    elapsed: 0,
    isComplete: false,
  }

  api.getVideoUrl = async (...args) => {
    calls.push(['getVideoUrl', args])
    return { url: 'http://127.0.0.1:60023/video.mp4' }
  }

  api.prefetchVideo = (...args) => {
    calls.push(['prefetchVideo', args])
    return new Promise(() => {})
  }

  api.getVideoStats = (...args) => {
    calls.push(['getVideoStats', args])
    return { ...statsValue }
  }

  const result = await Promise.race([
    api.preparePlayback(
      'channel-key',
      'videos/demo.mp4',
      'public-bee-key',
      'blob-id',
      'blobs-core-key',
      'video/mp4',
    ),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 50)),
  ])

  t.is(result.url, 'http://127.0.0.1:60023/video.mp4')
  t.alike(result.stats, statsValue)
  // The URL remains the same direct blob-server URL; the API-level playback
  // path now starts prefetch in the background without blocking native player
  // handoff.
  t.is(result.warmupStarted, undefined)
  t.is(result.peerWarmupStarted, undefined)
  t.is(result.selectedBlobWarmup, undefined)

  t.alike(calls, [
    ['getVideoUrl', ['channel-key', 'videos/demo.mp4', 'public-bee-key', 'blob-id', 'blobs-core-key', 'video/mp4']],
    ['prefetchVideo', ['channel-key', 'videos/demo.mp4', 'public-bee-key']],
    ['getVideoStats', ['channel-key', 'videos/demo.mp4']],
  ])
})


test('preparePlayback falls back to direct on-demand stats when playback prefetch is unavailable', async (t) => {
  const driveKey = 'channel-key'
  const videoPath = 'videos/demo.mp4'
  const blobsCoreKey = '78'.repeat(32)
  const blobId = '5:4:0:4096'
  const calls = []
  const core = new EventEmitter()
  core.key = Buffer.from(blobsCoreKey, 'hex')
  core.discoveryKey = Buffer.from('discovery-key')
  core.peers = [{ remotePublicKey: Buffer.from('a'.repeat(64), 'hex') }]
  core.ready = async () => { calls.push(['core.ready']) }
  core.update = () => Promise.resolve()
  core.has = async (start, end) => {
    calls.push(['core.has', start, end])
    return false
  }

  const api = createApi({
    ctx: {
      blobServer: {
        port: 60023,
        getLink(_keyBuffer, options) {
          calls.push(['getLink', options.blob, options.type])
          return 'http://127.0.0.1:60023/demo.mp4'
        },
      },
      store: {
        get() {
          calls.push(['store.get'])
          return core
        },
      },
      swarm: {
        connections: new Set([1, 2]),
        join(discoveryKey) {
          calls.push(['swarm.join', discoveryKey])
          return { flushed: () => Promise.resolve() }
        },
      },
      channels: new Map(),
    },
    videoStats: new (await import('../src/video-stats.js')).VideoStatsTracker(),
  })
  api.getVideoData = async () => ({
    id: 'demo',
    blobId,
    blobsCoreKey,
    mimeType: 'video/mp4',
    immutablePublication: null,
  })

  api.prefetchVideo = async (...args) => {
    calls.push(['prefetchVideo', args])
    return { success: false, error: 'prefetch unavailable in test' }
  }

  const prepared = await api.preparePlayback(
    driveKey,
    videoPath,
    null,
    blobId,
    blobsCoreKey,
    'video/mp4',
  )

  t.is(prepared.url, 'http://127.0.0.1:60023/demo.mp4')
  t.is(prepared.stats.status, 'downloading')
  t.is(prepared.stats.totalBlocks, 4)
  t.is(prepared.stats.totalBytes, 4096)
  t.is(prepared.stats.peerCount, 1)

  core.emit('download', 5, 1024)
  const stats = api.getVideoStats(driveKey, videoPath)

  t.is(stats.status, 'downloading')
  t.is(stats.downloadedBlocks, 1)
  t.is(stats.downloadedBytes, 1024)
  t.is(stats.progress, 25)
  t.is(stats.peerCount, 1)
  t.alike(stats.blobPeerIds, ['a'.repeat(64)])
  t.is(stats.blobCoreKey, blobsCoreKey)
  t.ok(calls.find((call) => call[0] === 'prefetchVideo'), 'preparePlayback should start playback prefetch in the background')
})


test('getAvailabilityHints revalidates cached playable head proof', async (t) => {
  const driveKey = 'ab'.repeat(32)
  const blobsCoreKey = 'cd'.repeat(32)
  const blobId = '0:4:0:4096'
  const hasCalls = []
  let headAvailable = true
  const core = {
    async ready() {},
    async has(start, end) {
      hasCalls.push([start, end])
      return headAvailable
    },
  }

  const api = createApi({
    ctx: {
      store: {
        get() {
          return core
        },
      },
      swarm: {
        keyPair: { publicKey: Buffer.from('ef'.repeat(32), 'hex') },
      },
    },
  })

  const request = {
    driveKey,
    id: 'video-id',
    blobsCoreKey,
    blobId,
  }

  const first = await api.getAvailabilityHints([request])
  headAvailable = false
  const second = await api.getAvailabilityHints([request])

  t.is(first[0]?.availability, 'playable')
  t.is(first[0]?.hasHeadBlock, true)
  t.is(second[0]?.availability, 'unknown')
  t.is(second[0]?.hasHeadBlock, false)
  t.ok(hasCalls.length > 1, 'cached playable proof is rechecked against local blocks')
})



test('getVideoStats preserves tracked peer details when no live core is registered', (t) => {
  const tracked = {
    status: 'downloading',
    peerCount: 3,
    blobPeerIds: ['d'.repeat(64)],
    blobCoreKey: 'e'.repeat(64),
  }
  const api = createApi({
    ctx: {
      swarm: { connections: new Set([1]) },
      channels: new Map(),
    },
    videoStats: {
      getStats() {
        return tracked
      },
    },
  })

  const stats = api.getVideoStats('channel-key', 'videos/demo.mp4')

  t.is(stats.peerCount, 3)
  t.alike(stats.blobPeerIds, tracked.blobPeerIds)
  t.is(stats.blobCoreKey, tracked.blobCoreKey)
  t.is(stats.swarmConnections, 1)
})

test('getVideoStats keeps video peer count separate from global swarm connections', (t) => {
  const videoCore = { peers: [1, 2] }
  const api = createApi({
    ctx: {
      swarm: { connections: new Set([1, 2, 3, 4]) },
      channels: new Map([
        ['channel-key', { videoCores: new Map([['videos/demo.mp4', videoCore]]) }],
      ]),
    },
  })

  const stats = api.getVideoStats('channel-key', 'videos/demo.mp4')

  t.is(stats.peerCount, 2)
  t.is(stats.swarmConnections, 4)
})

test('getVideoStats exposes blob core peer identities for transfer proof', (t) => {
  const peerA = { remotePublicKey: Buffer.from('a'.repeat(64), 'hex'), remoteAddress: 'relay-a' }
  const peerB = { publicKey: Buffer.from('b'.repeat(64), 'hex'), remoteAddress: 'relay-b' }
  const videoCore = {
    key: Buffer.from('c'.repeat(64), 'hex'),
    peers: [peerA, peerB],
  }
  const api = createApi({
    ctx: {
      swarm: { connections: new Set([1, 2, 3, 4]) },
      channels: new Map([
        ['channel-key', { videoCores: new Map([['videos/demo.mp4', videoCore]]) }],
      ]),
    },
  })

  const stats = api.getVideoStats('channel-key', 'videos/demo.mp4')

  t.is(stats.peerCount, 2)
  t.alike(stats.blobPeerIds, ['a'.repeat(64), 'b'.repeat(64)])
  t.is(stats.blobCoreKey, 'c'.repeat(64))
  t.is(stats.swarmConnections, 4)
})

test('getVideoStats does not fall back to global swarm connections as video peers', (t) => {
  const api = createApi({
    ctx: {
      swarm: { connections: new Set([1, 2, 3]) },
      channels: new Map(),
    },
  })

  const stats = api.getVideoStats('channel-key', 'missing-video')

  t.is(stats.peerCount, 0)
  t.is(stats.swarmConnections, 3)
})

test('static playback URL reuses blob capability links and registers an exact marked scheduler entry', (t) => {
  const coreRef = createStaticAssetManifest({
    treeHash: Buffer.alloc(32, 7),
    blockLength: 2,
    byteLength: 512 * 1024,
  })
  const assetId = coreRef.assetId
  const scheduler = { requestRange() {}, seek() {} }
  const calls = []
  const releases = new Map()
  const release = asset => () => releases.set(asset, (releases.get(asset) || 0) + 1)
  const ctx = {
    staticAssetPlaybackEntries: new Map(),
    blobServerHost: '127.0.0.1',
    blobServer: {
      port: 60023,
      getLink(key, options) {
        calls.push({ key: Buffer.from(key), options })
        return 'http://127.0.0.1:60023/?key=capability&token=secret'
      },
    },
    store: { get() { t.fail('static URL registration must not open generic blob replication') } },
  }
  const service = new BlobPlaybackService({ ctx, maxStaticAssetEntries: 2 })

  const first = service.resolveStaticAssetUrl({
    coreRef,
    scheduler,
    mimeType: 'video/mp4',
    authorizationKey: 'publication-a:rendition-a',
    release: release(assetId),
  })

  t.ok(first.url.includes(`pt_static_asset=${assetId}`))
  t.alike(calls[0].key, Buffer.from(assetId, 'hex'))
  t.alike(calls[0].options.blob, { blockOffset: 0, blockLength: 2, byteOffset: 0, byteLength: 512 * 1024 })
  t.is(ctx.staticAssetPlaybackEntries.get(assetId).scheduler, scheduler)
  t.alike(ctx.staticAssetPlaybackEntries.get(assetId).coreRef, normalizeAssetCoreRefV2(coreRef))

  const middleCoreRef = createStaticAssetManifest({
    treeHash: Buffer.alloc(32, 8),
    blockLength: 2,
    byteLength: 512 * 1024,
  })
  service.resolveStaticAssetUrl({
    coreRef: middleCoreRef,
    scheduler: { requestRange() {}, seek() {} },
    authorizationKey: 'publication-middle:rendition-middle',
    release: release(middleCoreRef.assetId),
  })
  const repeated = service.resolveStaticAssetUrl({
    coreRef,
    scheduler: { requestRange() { t.fail('repeat must reuse the original scheduler') }, seek() {} },
    authorizationKey: 'publication-a:rendition-a',
    release: () => t.fail('repeat must reuse the existing playback retention'),
  })
  t.is(repeated.scheduler, scheduler)
  t.is(repeated.reused, true)
  t.is(ctx.staticAssetPlaybackEntries.get(assetId).scheduler, scheduler)

  const newestCoreRef = createStaticAssetManifest({
    treeHash: Buffer.alloc(32, 9),
    blockLength: 2,
    byteLength: 512 * 1024,
  })
  service.resolveStaticAssetUrl({
    coreRef: newestCoreRef,
    scheduler: { requestRange() {}, seek() {} },
    authorizationKey: 'publication-newest:rendition-newest',
    release: release(newestCoreRef.assetId),
  })
  t.is(ctx.staticAssetPlaybackEntries.size, 2)
  t.ok(ctx.staticAssetPlaybackEntries.has(assetId), 'repeat touches the exact asset entry')
  t.absent(ctx.staticAssetPlaybackEntries.get(middleCoreRef.assetId), 'least-recent exact asset is evicted')
  t.is(releases.get(middleCoreRef.assetId), 1)
  t.is(releases.get(assetId) || 0, 0)
})

test('static route assets expose exact verified scheduler ranges without minting blob URLs', async (t) => {
  const coreRef = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: Buffer.alloc(32, 10),
    blockLength: 2,
    byteLength: 512 * 1024,
  }))
  const calls = []
  let released = 0
  const scheduler = {
    seek(request) { calls.push(['seek', request]) },
    async requestRange(request) {
      calls.push(['requestRange', request])
      return { status: 'ok', verified: true, bytes: Buffer.alloc(request.byteEnd - request.byteStart) }
    },
  }
  const ctx = {
    staticAssetPlaybackEntries: new Map(),
    blobServer: {
      getLink() { t.fail('route-scoped streaming must not mint a blob-server URL') },
    },
  }
  const service = new BlobPlaybackService({ ctx })
  const asset = service.resolveStaticAssetStream({
    coreRef,
    scheduler,
    mimeType: 'text/html',
    authorizationKey: 'companion-capability-1',
    release: async () => { released++ },
  })

  t.is(asset.assetId, coreRef.assetId)
  t.is(asset.byteLength, coreRef.byteLength)
  t.is(asset.blockSize, coreRef.blockSize)
  t.is(asset.mimeType, 'application/octet-stream')
  t.is(asset.etag, `"${coreRef.treeHash}"`)
  asset.seek({ byteStart: 7 })
  const signal = new AbortController().signal
  await asset.requestRange({ assetId: coreRef.assetId, byteStart: 7, byteEnd: 19, signal })
  t.alike(calls, [
    ['seek', { byteStart: 7 }],
    ['requestRange', { assetId: coreRef.assetId, byteStart: 7, byteEnd: 19, signal }],
  ])

  await asset.release()
  await asset.release()
  t.is(released, 1)
  t.absent(ctx.staticAssetPlaybackEntries.get(coreRef.assetId))
})

test('live route assets survive LRU pressure until their capability retires', async (t) => {
  const firstCoreRef = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: Buffer.alloc(32, 15),
    blockLength: 2,
    byteLength: 512 * 1024,
  }))
  const secondCoreRef = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: Buffer.alloc(32, 16),
    blockLength: 2,
    byteLength: 512 * 1024,
  }))
  const calls = []
  let firstReleases = 0
  let secondReleases = 0
  const scheduler = {
    seek() {},
    async requestRange(request) {
      calls.push(request)
      return { status: 'ok', verified: true, bytes: Buffer.alloc(request.byteEnd - request.byteStart) }
    },
  }
  const ctx = { staticAssetPlaybackEntries: new Map() }
  const service = new BlobPlaybackService({ ctx, maxStaticAssetEntries: 1 })
  const first = service.resolveStaticAssetStream({
    coreRef: firstCoreRef,
    scheduler,
    authorizationKey: 'live-capability',
    release: async () => { firstReleases++ },
  })

  let capacityError = null
  try {
    service.resolveStaticAssetStream({
      coreRef: secondCoreRef,
      scheduler,
      authorizationKey: 'blocked-capability',
      release: async () => { secondReleases++ },
    })
  } catch (error) {
    capacityError = error
  }
  t.is(capacityError?.code, 'STATIC_ASSET_CAPACITY_EXHAUSTED')
  t.is(firstReleases, 0)
  t.is(secondReleases, 0)
  t.is(ctx.staticAssetPlaybackEntries.get(firstCoreRef.assetId)?.scheduler, scheduler)

  const result = await first.requestRange({ byteStart: 0, byteEnd: 4 })
  t.is(result.status, 'ok')
  t.is(result.bytes.byteLength, 4)
  t.alike(calls.map(({ byteStart, byteEnd }) => ({ byteStart, byteEnd })), [{ byteStart: 0, byteEnd: 4 }])
  t.is(firstReleases, 0)

  await first.release()
  t.is(firstReleases, 1)
  t.absent(ctx.staticAssetPlaybackEntries.get(firstCoreRef.assetId))
})

test('ordinary static URL LRU exceeds default capacity while skipping a capability pin', async (t) => {
  const calls = []
  let pinnedReleases = 0
  const ordinaryReleases = Array(130).fill(0)
  const scheduler = {
    seek() {},
    async requestRange(request) {
      calls.push(request)
      return { status: 'ok', verified: true, bytes: Buffer.alloc(request.byteEnd - request.byteStart) }
    },
  }
  const ctx = {
    staticAssetPlaybackEntries: new Map(),
    blobServer: {
      getLink() { return 'http://127.0.0.1/static-capability?token=secret' },
    },
  }
  const service = new BlobPlaybackService({ ctx })
  const pinnedCoreRef = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: Buffer.alloc(32, 250),
    blockLength: 1,
    byteLength: 256 * 1024,
  }))
  const pinned = service.resolveStaticAssetStream({
    coreRef: pinnedCoreRef,
    scheduler,
    authorizationKey: 'route-capability-pin',
    release: async () => { pinnedReleases++ },
  })
  const ordinaryCoreRefs = []

  for (let index = 0; index < ordinaryReleases.length; index++) {
    const coreRef = normalizeAssetCoreRefV2(createStaticAssetManifest({
      treeHash: Buffer.alloc(32, index + 1),
      blockLength: 1,
      byteLength: 256 * 1024,
    }))
    ordinaryCoreRefs.push(coreRef)
    service.resolveStaticAssetUrl({
      coreRef,
      scheduler,
      authorizationKey: `ordinary-static-url-${index}`,
      release: async () => { ordinaryReleases[index]++ },
    })
  }
  await Promise.resolve()

  t.is(ctx.staticAssetPlaybackEntries.size, 128)
  t.ok(ctx.staticAssetPlaybackEntries.has(pinnedCoreRef.assetId))
  for (const coreRef of ordinaryCoreRefs.slice(0, 3)) t.absent(ctx.staticAssetPlaybackEntries.get(coreRef.assetId))
  t.alike(ordinaryReleases.slice(0, 4), [1, 1, 1, 0])
  t.is(pinnedReleases, 0)

  const result = await pinned.requestRange({ byteStart: 0, byteEnd: 4 })
  t.is(result.status, 'ok')
  t.is(result.bytes.byteLength, 4)
  t.alike(calls.map(({ byteStart, byteEnd }) => ({ byteStart, byteEnd })), [{ byteStart: 0, byteEnd: 4 }])

  await pinned.release()
  t.is(pinnedReleases, 1)
})

test('verified index candidates open exact route assets and release their retained scope once', async (t) => {
  const fixture = immutablePlaybackFixture(14)
  const retains = []
  const releases = []
  const ctx = { staticAssetPlaybackEntries: new Map() }
  const scopedNetwork = {
    async retainAuthorizedRendition(request) { retains.push(request) },
    async releaseAuthorizedRendition(request) { releases.push(request); return { released: true } },
    getActiveAssetSession() { return { assetId: fixture.coreRef.assetId, coreRef: fixture.coreRef } },
    getActiveAssetPeerIds() { return [] },
    async listPeerAssetRanges() { return { ranges: [], nextCursor: null } },
    async hasVerifiedAssetBlock() { return true },
    async readVerifiedAssetBlock() { return Buffer.alloc(fixture.coreRef.blockSize) },
    async requestAssetBlocks() { throw new Error('local verified bytes should be reused') },
  }
  const api = createApi({ ctx, scopedNetwork })
  const candidate = Object.freeze({
    [VERIFIED_CANDIDATE_MANIFEST]: fixture.manifest,
    verification: { state: 'source-verified' },
    publication: { publicationId: fixture.manifest.publicationId },
    rendition: { renditionId: fixture.rendition.renditionId, container: 'mp4' },
    asset: {
      assetId: fixture.coreRef.assetId,
      coreKey: fixture.coreRef.key,
      treeHash: fixture.coreRef.treeHash,
      blockLength: fixture.coreRef.length,
      blockSize: fixture.coreRef.blockSize,
      byteLength: fixture.coreRef.byteLength,
    },
  })

  const asset = await api.openVerifiedCandidateStream(candidate)
  t.is(asset.assetId, fixture.coreRef.assetId)
  t.is(asset.byteLength, fixture.coreRef.byteLength)
  t.is(asset.mimeType, 'video/mp4')
  t.is(retains.length, 1)
  t.is(retains[0].manifest, fixture.manifest)
  await asset.release()
  await asset.release()
  t.is(releases.length, 1)
  t.absent(ctx.staticAssetPlaybackEntries.get(fixture.coreRef.assetId))
})

test('static playback composition binds one exact scheduler to the shared playback service', (t) => {
  const coreRef = createStaticAssetManifest({
    treeHash: Buffer.alloc(32, 11),
    blockLength: 1,
    byteLength: 256 * 1024,
  })
  const session = { assetId: coreRef.assetId, coreRef }
  const transport = {
    getActiveAssetPeerIds() { return [] },
    listPeerAssetRanges() { return { ranges: [], nextCursor: null } },
    hasVerifiedAssetBlock() { return false },
    readVerifiedAssetBlock() { throw new Error('not materialized') },
    requestAssetBlocks() { throw new Error('no peer') },
  }
  let registered = null
  const playbackService = {
    resolveStaticAssetUrl(input) {
      registered = input
      return { url: 'http://127.0.0.1/static-capability' }
    },
  }

  const playback = createStaticAssetPlayback({
    coreRef,
    session,
    transport,
    playbackService,
    mimeType: 'video/mp4',
  })

  t.is(playback.url, 'http://127.0.0.1/static-capability')
  t.is(playback.scheduler, registered.scheduler)
  t.is(registered.coreRef, coreRef)
  t.is(registered.mimeType, 'video/mp4')
})

test('getVideoUrl prefers verified immutable static playback over supplied legacy blob refs', async (t) => {
  const fixture = immutablePlaybackFixture()
  const calls = []
  const session = { assetId: fixture.coreRef.assetId, coreRef: fixture.coreRef }
  const ctx = {
    staticAssetPlaybackEntries: new Map(),
    blobServerHost: '127.0.0.1',
    blobServer: {
      port: 60023,
      getLink(key, options) {
        calls.push(['getLink', Buffer.from(key), options])
        return 'http://127.0.0.1:60023/static-capability?token=secret'
      },
    },
    store: { get() { t.fail('immutable playback must not warm the legacy blob core') } },
  }
  const scopedNetwork = {
    async retainAuthorizedRendition(request) {
      calls.push(['retain', request])
      return { status: 'retained' }
    },
    getActiveAssetSession(request) {
      calls.push(['session', request])
      return session
    },
    async releaseAuthorizedRendition(request) {
      calls.push(['release', request])
      return { released: true }
    },
    getActiveAssetPeerIds() { return [] },
    async listPeerAssetRanges() { return { ranges: [], nextCursor: null } },
    async hasVerifiedAssetBlock() { return false },
    async readVerifiedAssetBlock() { throw new Error('not materialized') },
    async requestAssetBlocks() { throw new Error('no peer') },
  }
  const api = createApi({ ctx, scopedNetwork })
  let metadataReads = 0
  api.getVideoData = async () => {
    metadataReads++
    return {
      id: 'immutable-video',
      blobId: '0:2:0:1024',
      blobsCoreKey: '44'.repeat(32),
      mimeType: 'video/mp4',
      immutablePublication: fixture.immutablePublication,
    }
  }

  const result = await api.getVideoUrl(
    'channel-key',
    'videos/immutable-video.mp4',
    null,
    '0:2:0:1024',
    '44'.repeat(32),
    'video/mp4',
  )
  const repeated = await api.getVideoUrl(
    'channel-key',
    'videos/immutable-video.mp4',
    null,
    '0:2:0:1024',
    '44'.repeat(32),
    'video/mp4',
  )

  t.is(metadataReads, 2)
  t.ok(result.url.includes(`pt_static_asset=${fixture.coreRef.assetId}`))
  t.is(repeated.scheduler, result.scheduler)
  t.is(calls.filter(call => call[0] === 'getLink').length, 2)
  t.is(calls.filter(call => call[0] === 'retain').length, 1)
  t.is(calls.filter(call => call[0] === 'session').length, 1)
  t.alike(calls.find(call => call[0] === 'getLink')[1], Buffer.from(fixture.coreRef.key, 'hex'))
  t.alike(calls.find(call => call[0] === 'retain')[1], {
    manifest: fixture.manifest,
    renditionId: fixture.rendition.renditionId,
    ownerId: `playback:${fixture.manifest.publicationId}:${fixture.rendition.renditionId}`,
    start: 0,
    end: fixture.coreRef.length,
  })
  t.alike(calls.find(call => call[0] === 'session')[1], { assetId: fixture.coreRef.assetId })
  t.is(ctx.staticAssetPlaybackEntries.get(fixture.coreRef.assetId).scheduler, result.scheduler)
  t.is(calls.some(call => call[0] === 'release'), false)
})

test('shared static assets retain and evict each exact publication authorization once', async (t) => {
  const first = immutablePlaybackFixture(61)
  const second = immutablePlaybackFixtureForCore(first.coreRef, 62, 'Independent shared asset')
  const evicting = immutablePlaybackFixture(63)
  const coreRefs = new Map([
    [first.coreRef.assetId, first.coreRef],
    [evicting.coreRef.assetId, evicting.coreRef],
  ])
  const retains = []
  const releases = []
  const ctx = {
    maxStaticAssetPlaybackEntries: 1,
    staticAssetPlaybackEntries: new Map(),
    blobServerHost: '127.0.0.1',
    blobServer: {
      port: 60023,
      getLink() {
        return 'http://127.0.0.1:60023/static-capability?token=secret'
      },
    },
    store: { get() { t.fail('shared immutable playback must not warm a legacy blob core') } },
  }
  const scopedNetwork = {
    async retainAuthorizedRendition(request) {
      retains.push(request)
      return { status: 'retained' }
    },
    getActiveAssetSession({ assetId }) {
      const coreRef = coreRefs.get(assetId)
      return { assetId, coreRef }
    },
    async releaseAuthorizedRendition(request) {
      releases.push(request)
      return { released: true }
    },
    getActiveAssetPeerIds() { return [] },
    async listPeerAssetRanges() { return { ranges: [], nextCursor: null } },
    async hasVerifiedAssetBlock() { return false },
    async readVerifiedAssetBlock() { throw new Error('not materialized') },
    async requestAssetBlocks() { throw new Error('no peer') },
  }
  const api = createApi({ ctx, scopedNetwork })
  let metadata = { immutablePublication: first.immutablePublication, mimeType: 'video/mp4' }
  api.getVideoData = async () => metadata

  const firstPlayback = await api.getVideoUrl('channel', 'first.mp4')
  const firstRepeat = await api.getVideoUrl('channel', 'first.mp4')
  t.is(retains.length, 1, 'same exact publication authorization is retained once')
  t.is(firstRepeat.scheduler, firstPlayback.scheduler)

  metadata = { immutablePublication: second.immutablePublication, mimeType: 'video/mp4' }
  const secondPlayback = await api.getVideoUrl('channel', 'second.mp4')
  const secondRepeat = await api.getVideoUrl('channel', 'second.mp4')
  t.is(retains.length, 2, 'independent publication cannot reuse the first authorization')
  t.is(secondPlayback.scheduler, firstPlayback.scheduler, 'shared asset reuses one scheduler')
  t.is(secondRepeat.scheduler, firstPlayback.scheduler)
  t.is(ctx.staticAssetPlaybackEntries.get(first.coreRef.assetId).authorizations.size, 2)

  metadata = { immutablePublication: evicting.immutablePublication, mimeType: 'video/mp4' }
  await api.getVideoUrl('channel', 'evicting.mp4')
  await Promise.resolve()

  const sharedReleases = retains.slice(0, 2).map(request => ({
    renditionId: request.renditionId,
    ownerId: request.ownerId,
    assetId: first.coreRef.assetId,
  }))
  t.is(retains.length, 3)
  t.alike(releases, sharedReleases)
  t.is(new Set(sharedReleases.map(request => request.ownerId)).size, 2)
})

test('failed static capability links leave authorization registry and LRU state atomic', async (t) => {
  const first = immutablePlaybackFixture(71)
  const secondOwner = immutablePlaybackFixtureForCore(first.coreRef, 72, 'Second owner')
  const other = immutablePlaybackFixture(73)
  const newest = immutablePlaybackFixture(74)
  const coreRefs = new Map([
    [first.coreRef.assetId, first.coreRef],
    [other.coreRef.assetId, other.coreRef],
    [newest.coreRef.assetId, newest.coreRef],
  ])
  const retains = []
  const releases = []
  let failNextLink = false
  const ctx = {
    maxStaticAssetPlaybackEntries: 2,
    staticAssetPlaybackEntries: new Map(),
    blobServerHost: '127.0.0.1',
    blobServer: {
      port: 60023,
      getLink() {
        if (failNextLink) {
          failNextLink = false
          throw new Error('capability link failed')
        }
        return 'http://127.0.0.1:60023/static-capability?token=secret'
      },
    },
    store: { get() { t.fail('failed static links must not fall through to legacy storage') } },
  }
  const scopedNetwork = {
    async retainAuthorizedRendition(request) {
      retains.push(request)
      return { status: 'retained' }
    },
    getActiveAssetSession({ assetId }) {
      const coreRef = coreRefs.get(assetId)
      return { assetId, coreRef }
    },
    async releaseAuthorizedRendition(request) {
      releases.push(request)
      return { released: true }
    },
    getActiveAssetPeerIds() { return [] },
    async listPeerAssetRanges() { return { ranges: [], nextCursor: null } },
    async hasVerifiedAssetBlock() { return false },
    async readVerifiedAssetBlock() { throw new Error('not materialized') },
    async requestAssetBlocks() { throw new Error('no peer') },
  }
  const api = createApi({ ctx, scopedNetwork })
  let metadata = { immutablePublication: first.immutablePublication, mimeType: 'video/mp4' }
  api.getVideoData = async () => metadata
  const resolve = publication => {
    metadata = { immutablePublication: publication, mimeType: 'video/mp4' }
    return api.getVideoUrl('channel', 'video.mp4')
  }
  const failResolve = async publication => {
    failNextLink = true
    return resolve(publication).then(() => null, error => error)
  }
  const authorizationKey = fixture =>
    `${fixture.manifest.publicationId}:${fixture.rendition.renditionId}`

  await resolve(first.immutablePublication)
  await resolve(other.immutablePublication)
  t.alike([...ctx.staticAssetPlaybackEntries.keys()], [first.coreRef.assetId, other.coreRef.assetId])

  const failedSecondOwner = await failResolve(secondOwner.immutablePublication)
  t.ok(failedSecondOwner)
  t.is(releases.length, 1)
  t.is(releases[0].ownerId, retains[2].ownerId)
  t.alike([...ctx.staticAssetPlaybackEntries.keys()], [first.coreRef.assetId, other.coreRef.assetId])
  t.alike(
    [...ctx.staticAssetPlaybackEntries.get(first.coreRef.assetId).authorizations.keys()],
    [authorizationKey(first)],
  )

  await resolve(secondOwner.immutablePublication)
  t.is(retains.filter(request => request.ownerId === retains[2].ownerId).length, 2)
  t.is(ctx.staticAssetPlaybackEntries.get(first.coreRef.assetId).authorizations.size, 2)
  await resolve(other.immutablePublication)
  t.alike([...ctx.staticAssetPlaybackEntries.keys()], [first.coreRef.assetId, other.coreRef.assetId])

  const releasesBeforeExistingFailure = releases.length
  const failedExisting = await failResolve(first.immutablePublication)
  t.ok(failedExisting)
  t.is(releases.length, releasesBeforeExistingFailure)
  t.alike([...ctx.staticAssetPlaybackEntries.keys()], [first.coreRef.assetId, other.coreRef.assetId])
  t.is(ctx.staticAssetPlaybackEntries.get(first.coreRef.assetId).authorizations.size, 2)

  const failedNew = await failResolve(newest.immutablePublication)
  t.ok(failedNew)
  t.is(releases.filter(request => request.ownerId === retains[retains.length - 1].ownerId).length, 1)
  t.alike([...ctx.staticAssetPlaybackEntries.keys()], [first.coreRef.assetId, other.coreRef.assetId])
  t.absent(ctx.staticAssetPlaybackEntries.get(newest.coreRef.assetId))

  const failedNewOwnerId = retains[retains.length - 1].ownerId
  const releasesBeforeSuccessfulEviction = releases.length
  await resolve(newest.immutablePublication)
  t.is(retains.filter(request => request.ownerId === failedNewOwnerId).length, 2)
  t.ok(ctx.staticAssetPlaybackEntries.has(newest.coreRef.assetId))
  t.absent(ctx.staticAssetPlaybackEntries.get(first.coreRef.assetId))
  t.alike(releases.slice(releasesBeforeSuccessfulEviction), [
    {
      renditionId: retains[0].renditionId,
      ownerId: retains[0].ownerId,
      assetId: first.coreRef.assetId,
    },
    {
      renditionId: retains[3].renditionId,
      ownerId: retains[3].ownerId,
      assetId: first.coreRef.assetId,
    },
  ])
})

test('getVideoUrl fails closed for malformed or mismatched immutable publication metadata', async (t) => {
  const fixture = immutablePlaybackFixture(31)
  let linkCalls = 0
  let retentionCalls = 0
  const ctx = {
    blobServer: {
      port: 60023,
      getLink() {
        linkCalls++
        return 'http://127.0.0.1:60023/legacy'
      },
    },
    store: { get() { t.fail('rejected immutable metadata must not warm legacy playback') } },
  }
  const scopedNetwork = {
    async retainAuthorizedRendition() { retentionCalls++ },
    getActiveAssetSession() { t.fail('rejected immutable metadata must not open a session') },
  }
  const api = createApi({ ctx, scopedNetwork })
  const cases = [
    { manifest: null },
    { ...fixture.immutablePublication, renditionId: 'ff'.repeat(32) },
    { ...fixture.immutablePublication, assetId: 'ee'.repeat(32) },
    { ...fixture.immutablePublication, coreKey: 'dd'.repeat(32) },
  ]
  for (const immutablePublication of cases) {
    api.getVideoData = async () => ({
      blobId: '0:2:0:1024',
      blobsCoreKey: '44'.repeat(32),
      immutablePublication,
    })
    const rejected = await api.getVideoUrl(
      'channel-key',
      'videos/immutable-video.mp4',
      null,
      '0:2:0:1024',
      '44'.repeat(32),
      'video/mp4',
    ).then(() => null, error => error)
    t.ok(rejected)
    t.ok(/immutable publication/.test(rejected.message))
  }
  t.is(linkCalls, 0)
  t.is(retentionCalls, 0)
})

test('getVideoUrl keeps legacy direct playback only when immutable publication metadata is absent', async (t) => {
  let metadataReads = 0
  let legacyCoreGets = 0
  let metadata = null
  const ctx = {
    blobServer: {
      port: 60023,
      getLink(key, options) {
        t.alike(Buffer.from(key), Buffer.from('44'.repeat(32), 'hex'))
        t.alike(options.blob, { blockOffset: 0, blockLength: 2, byteOffset: 0, byteLength: 1024 })
        return 'http://127.0.0.1:60023/legacy-capability'
      },
    },
    store: {
      get() {
        legacyCoreGets++
        return null
      },
    },
  }
  const api = createApi({ ctx })
  api.getVideoData = async () => {
    metadataReads++
    return metadata
  }
  const unresolved = await api.getVideoUrl(
    'channel-key',
    'videos/legacy-video.mp4',
    null,
    '0:2:0:1024',
    '44'.repeat(32),
    'video/mp4',
  ).then(() => null, error => error)
  t.ok(unresolved)
  t.is(legacyCoreGets, 0, 'uncertain metadata is not genuine immutable-publication absence')
  metadata = { id: 'legacy-video', immutablePublication: null }

  const result = await api.getVideoUrl(
    'channel-key',
    'videos/legacy-video.mp4',
    null,
    '0:2:0:1024',
    '44'.repeat(32),
    'video/mp4',
  )

  t.is(metadataReads, 2)
  t.is(result.url, 'http://127.0.0.1:60023/legacy-capability')
  t.is(result.url.includes('pt_static_asset'), false)
  t.ok(legacyCoreGets > 0, 'legacy fallback opens the legacy blob core')
})

test('preparePlayback marked static handoff skips legacy prefetch and on-demand core stats', async (t) => {
  const api = createApi({
    ctx: {
      store: { get() { t.fail('marked static preparation must not open the legacy blob core') } },
    },
  })
  let prefetchCalls = 0
  api.getVideoUrl = async () => ({
    url: `http://127.0.0.1/static?pt_static_asset=${'aa'.repeat(32)}`,
  })
  api.prefetchVideo = async () => {
    prefetchCalls++
    return { success: true }
  }
  api.getVideoStats = () => t.fail('marked static preparation must not collect legacy blob stats')

  const prepared = await api.preparePlayback(
    'channel-key',
    'videos/immutable-video.mp4',
    null,
    '0:2:0:1024',
    '44'.repeat(32),
    'video/mp4',
  )

  t.ok(prepared.url.includes('pt_static_asset='))
  t.is(prefetchCalls, 0)
})
