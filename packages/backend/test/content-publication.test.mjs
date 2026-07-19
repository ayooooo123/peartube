import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import Corestore from 'corestore'
import crypto from 'hypercore-crypto'
import sodium from 'sodium-universal'

import { createContentPublication } from '../src/content-publication.js'
import { createContentPublication as createContentPublicationFromRoot } from '../src/index.js'
import { createContentPublication as createContentPublicationFromSubpath } from '@peartube/backend/content-publication'
import { createIdentityManager } from '../src/identity.js'
import { PublicFeed } from '../src/public-feed.js'
import {
  installOwnedContentPublicationIdentityHooks,
  reconcileOwnedContentPublications,
} from '../src/orchestrator.js'

const CHANNEL_KEY = '11'.repeat(32)
const PUBLIC_BEE_KEY = '22'.repeat(32)
const CLAIMANT_A = 'aa'.repeat(32)
const CLAIMANT_B = 'bb'.repeat(32)

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function projectable(video, winner) {
  if (!video || !['durabilityVerified', 'published'].includes(video.publicationState)) return false
  if (!video.importIdentityKey) return true
  return winner?.identityKey === video.importIdentityKey &&
    winner.claimantId === video.importClaimantId &&
    winner.videoId === video.id
}

function createFakeHarness({ videos = [], claims = [], active = true } = {}) {
  const privateVideos = new Map(videos.map((video) => [video.id, clone(video)]))
  let currentClaims = claims.map(clone)
  const publicVideos = new Map()
  const updateCalls = []
  const activationCalls = []
  const feedRows = new Map()
  let publicRevision = null
  let failActivationAfterProjection = false
  let uncertain = false
  let feedCrash = false
  let feedWrites = 0
  let verifiedRoot = {
    descriptor: {
      channelId: CHANNEL_KEY,
      metadataKey: PUBLIC_BEE_KEY,
    },
  }

  const winnerFor = (identityKey) => currentClaims
    .filter((claim) => claim.identityKey === identityKey && claim.state !== 'released')
    .sort((left, right) => left.claimantId.localeCompare(right.claimantId))[0] || null

  const publicBee = {
    keyHex: PUBLIC_BEE_KEY,
    writable: true,
    async getVerifiedRootDescriptor() {
      return clone(verifiedRoot)
    },
    async getVideoWithStatus(videoId, options = {}) {
      if (uncertain) return { status: 'uncertain', video: null }
      const video = publicVideos.get(videoId)
      if (!video) return { status: 'notFound', video: null }
      if (video.canonicalVisibility === 'suppressed') {
        return { status: 'suppressed', video: options.includeSuppressed ? clone(video) : null }
      }
      return { status: 'found', video: clone(video) }
    },
    async getVideo(videoId, options = {}) {
      return (await this.getVideoWithStatus(videoId, options)).video
    },
    async listVideosWithStatus(options = {}) {
      if (uncertain) return { status: 'uncertain', videos: [], filteredCount: 0 }
      const all = [...publicVideos.values()]
        .filter((video) => options.includeSuppressed || video.canonicalVisibility !== 'suppressed')
        .map(clone)
      return { status: 'authoritative', videos: all, filteredCount: 0 }
    },
    async reconcileCanonicalClaims(channel, { revisionForVideos } = {}) {
      if (uncertain) return { status: 'uncertain', videos: [], revision: publicRevision, revisionChanged: false }
      for (const video of await channel.listVideos()) {
        const winner = video.importIdentityKey ? winnerFor(video.importIdentityKey) : null
        if (projectable(video, winner)) {
          publicVideos.set(video.id, { ...clone(video), canonicalVisibility: undefined, duplicateOfClaimantId: undefined })
        } else if (video.importIdentityKey && publicVideos.has(video.id)) {
          const existing = publicVideos.get(video.id)
          publicVideos.set(video.id, {
            ...existing,
            canonicalVisibility: 'suppressed',
            duplicateOfClaimantId: winner?.claimantId,
          })
        }
      }
      const visible = [...publicVideos.values()]
        .filter((video) => video.canonicalVisibility !== 'suppressed')
        .map(clone)
      const revision = revisionForVideos(visible)
      const revisionChanged = revision !== publicRevision
      publicRevision = revision
      return { status: 'authoritative', videos: visible, revision, revisionChanged }
    },
    async getCanonicalReconciliationRevision() {
      return publicRevision
    },
  }

  const channel = {
    keyHex: CHANNEL_KEY,
    publicBee,
    publicProjectionActive: active,
    updateCalls,
    activationCalls,
    async getVideo(videoId) {
      return clone(privateVideos.get(videoId) || null)
    },
    async listVideos() {
      return [...privateVideos.values()].map(clone)
    },
    async updateVideo(videoId, patch, options) {
      updateCalls.push({ videoId, patch: clone(patch), options: clone(options) })
      const existing = privateVideos.get(videoId)
      if (!existing) throw new Error('Video not found')
      privateVideos.set(videoId, { ...existing, ...clone(patch) })
    },
    async resolveImportClaim(identityKey) {
      return clone(winnerFor(identityKey))
    },
    async activatePublicProjection(staged = {}) {
      activationCalls.push(clone(staged))
      this.publicProjectionActive = true
      for (const video of privateVideos.values()) {
        const winner = video.importIdentityKey ? winnerFor(video.importIdentityKey) : null
        if (projectable(video, winner)) publicVideos.set(video.id, clone(video))
      }
      if (failActivationAfterProjection) {
        failActivationAfterProjection = false
        throw new Error('simulated partial projection')
      }
      return PUBLIC_BEE_KEY
    },
  }

  const publicFeed = {
    async upsertChannelSnapshot(snapshot) {
      if (feedCrash) {
        feedCrash = false
        throw new Error('simulated feed crash')
      }
      const key = `${snapshot.channelKey}/${snapshot.publicBeeKey}`
      const previous = feedRows.get(key)
      if (previous?.revision === snapshot.revision && JSON.stringify(previous) === JSON.stringify(snapshot)) {
        return { changed: false, snapshot: clone(previous) }
      }
      feedRows.set(key, clone(snapshot))
      feedWrites++
      return { changed: true, snapshot: clone(snapshot) }
    },
    async getChannelSnapshotRevision(channelKey, publicBeeKey) {
      return feedRows.get(`${channelKey}/${publicBeeKey}`)?.revision || null
    },
    async getChannelSnapshot(channelKey, publicBeeKey) {
      return clone(feedRows.get(`${channelKey}/${publicBeeKey}`) || null)
    },
  }

  return {
    channel,
    publicBee,
    publicFeed,
    privateVideos,
    publicVideos,
    feedRows,
    updateCalls,
    activationCalls,
    setClaims(next) { currentClaims = next.map(clone) },
    setFailActivation(value) { failActivationAfterProjection = value },
    setUncertain(value) { uncertain = value },
    setFeedCrash(value) { feedCrash = value },
    setVerifiedRoot(value) { verifiedRoot = clone(value) },
    get feedWrites() { return feedWrites },
    get publicRevision() { return publicRevision },
  }
}

function claim({ identityKey = 'youtube:video:42', claimantId, videoId, state = 'published' }) {
  return { identityKey, claimantId, videoId, state }
}

function createMemoryDb() {
  const values = new Map()
  return {
    values,
    async get(key) {
      return values.has(key) ? { key, value: clone(values.get(key)) } : null
    },
    async put(key, value) {
      values.set(key, clone(value))
    },
  }
}

function createTestSwarm() {
  const joins = []
  return {
    joins,
    swarm: {
      keyPair: crypto.keyPair(),
      connections: new Set(),
      dht: {
        on() {},
        off() {},
        removeListener() {},
        lookup() {
          let resolveNext = null
          return {
            closestNodes: [],
            destroy() { resolveNext?.({ done: true }) },
            [Symbol.asyncIterator]() { return this },
            next() {
              return new Promise((resolve) => { resolveNext = resolve })
            },
          }
        },
      },
      join(discoveryKey) {
        joins.push(b4a.toString(discoveryKey, 'hex'))
        return { async flushed() {}, destroy() {}, close() {} }
      },
      on() {},
      off() {},
      removeListener() {},
    },
  }
}

async function closeSilently(resource) {
  try { await resource?.close?.() } catch {}
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('content publication factory is exported from package root and subpath', (t) => {
  t.is(createContentPublicationFromRoot, createContentPublication)
  t.is(createContentPublicationFromSubpath, createContentPublication)
})

test('factory exposes exactly five idempotent publication methods', (t) => {
  const harness = createFakeHarness()
  const publication = createContentPublication({ channel: harness.channel, publicFeed: harness.publicFeed })
  t.alike(Object.keys(publication).sort(), [
    'announce',
    'finalize',
    'markDurabilityVerified',
    'project',
    'reconcileCanonicalClaims',
  ])
})

test('owned-channel restart reconciliation runs without jobs and installs one sync hook', async (t) => {
  const harness = createFakeHarness()
  let syncHandler = null
  let reconciliations = 0
  const reconcileCanonicalClaims = harness.publicBee.reconcileCanonicalClaims.bind(harness.publicBee)
  harness.publicBee.reconcileCanonicalClaims = async (...args) => {
    reconciliations++
    return reconcileCanonicalClaims(...args)
  }
  harness.publicBee.setOnCanonicalClaimsSynchronized = (handler) => {
    syncHandler = handler
  }
  harness.channel.publicProjectionActive = false
  const ctx = { channels: new Map([[CHANNEL_KEY, harness.channel]]) }
  const identityManager = {
    getIdentities() {
      return [{ channelKey: CHANNEL_KEY, deferPublicProjection: true }]
    },
  }

  const deferred = await reconcileOwnedContentPublications({
    ctx,
    identityManager,
    publicFeed: harness.publicFeed,
    log: { warn() {} },
  })
  t.alike(deferred, { checked: 1, reconciled: 0, deferred: 1, failed: 0 })
  t.is(reconciliations, 0, 'inactive deferred startup remains zero-public')
  t.is(typeof syncHandler, 'function')

  harness.channel.publicProjectionActive = true
  await reconcileOwnedContentPublications({
    ctx,
    identityManager,
    publicFeed: harness.publicFeed,
    log: { warn() {} },
  })
  const installed = syncHandler
  await reconcileOwnedContentPublications({
    ctx,
    identityManager,
    publicFeed: harness.publicFeed,
    log: { warn() {} },
  })
  t.is(typeof syncHandler, 'function')
  t.not(syncHandler, installed, 'repeat startup replaces rather than appends a handler')
  await syncHandler()
  t.is(reconciliations, 3, 'one post-sync callback performs one independent reconciliation')
})

test('recoverIdentity installs reconciliation for the recovered owned channel', async (t) => {
  const harness = createFakeHarness()
  let reconciliations = 0
  let identities = []
  const personalRefreshes = []
  const reconcileCanonicalClaims = harness.publicBee.reconcileCanonicalClaims.bind(harness.publicBee)
  harness.publicBee.reconcileCanonicalClaims = async (...args) => {
    reconciliations++
    return reconcileCanonicalClaims(...args)
  }
  const identityManager = {
    getActivePublicKey() { return 'active-a' },
    getIdentities() { return identities },
    async createIdentity() { return { publicKey: 'created' } },
    async recoverIdentity() {
      identities = [{ publicKey: 'recovered', channelKey: CHANNEL_KEY }]
      return { success: true, publicKey: 'recovered', driveKey: CHANNEL_KEY }
    },
  }
  const cleanup = installOwnedContentPublicationIdentityHooks({
    ctx: { channels: new Map([[CHANNEL_KEY, harness.channel]]) },
    identityManager,
    publicFeed: harness.publicFeed,
    refreshActivePersonalStore: async (publicKey) => { personalRefreshes.push(publicKey) },
    log: { warn() {} },
  })

  const result = await identityManager.recoverIdentity('mnemonic', 'Recovered')
  t.is(result.publicKey, 'recovered')
  t.alike(personalRefreshes, ['active-a'], 'recovering inactive B keeps personal state on active A')
  t.is(reconciliations, 1, 'recovery reconciles without an active import job')
  t.is(harness.feedRows.size, 1)
  cleanup()
})

test('transient feed failure schedules one bounded retry without another channel sync', async (t) => {
  const harness = createFakeHarness()
  let attempts = 0
  let stopHook = null
  const upsertChannelSnapshot = harness.publicFeed.upsertChannelSnapshot.bind(harness.publicFeed)
  harness.publicFeed.upsertChannelSnapshot = async (...args) => {
    attempts++
    if (attempts === 1) throw new Error('transient feed persistence failure')
    return upsertChannelSnapshot(...args)
  }
  harness.publicFeed.addStopHook = (hook) => {
    stopHook = hook
    return () => { if (stopHook === hook) stopHook = null }
  }
  const ctx = { channels: new Map([[CHANNEL_KEY, harness.channel]]) }
  const result = await reconcileOwnedContentPublications({
    ctx,
    identityManager: { getIdentities: () => [{ channelKey: CHANNEL_KEY }] },
    publicFeed: harness.publicFeed,
    log: { warn() {} },
    retryBaseMs: 5,
    retryMaxMs: 5,
  })

  t.alike(result, { checked: 1, reconciled: 0, deferred: 0, failed: 1 })
  await wait(30)
  t.is(attempts, 2, 'one deduplicated retry repairs the feed')
  t.is(harness.feedRows.size, 1)
  t.is(typeof stopHook, 'function')
  stopHook?.()
})

test('durability marking is private-only, idempotent, and rejects invalid logical states', async (t) => {
  const harness = createFakeHarness({ videos: [
    { id: 'pending', title: 'Pending', publicationState: 'replicationPending' },
    { id: 'durable', title: 'Durable', publicationState: 'durabilityVerified' },
    { id: 'published', title: 'Published', publicationState: 'published' },
    { id: 'suppressed', title: 'Suppressed', publicationState: 'replicationPending', canonicalVisibility: 'suppressed' },
    { id: 'invalid', title: 'Invalid' },
  ] })
  const publication = createContentPublication({ channel: harness.channel, publicFeed: harness.publicFeed })

  await publication.markDurabilityVerified('pending')
  await publication.markDurabilityVerified('pending')
  await publication.markDurabilityVerified('durable')
  await publication.markDurabilityVerified('published')

  t.is(harness.updateCalls.length, 1)
  t.alike(harness.updateCalls[0], {
    videoId: 'pending',
    patch: { publicationState: 'durabilityVerified' },
    options: { syncPublic: false },
  })
  t.is(harness.publicVideos.size, 0, 'durability does not create public rows')
  t.is(harness.feedRows.size, 0, 'durability does not create feed rows')
  await t.exception(publication.markDurabilityVerified('missing'), /not found/i)
  await t.exception(publication.markDurabilityVerified('suppressed'), /suppressed/i)
  await t.exception(publication.markDurabilityVerified('invalid'), /publication state/i)
})

test('project rejects pending and losing or unbound claims before mutation', async (t) => {
  const identityKey = 'youtube:video:42'
  const harness = createFakeHarness({
    videos: [
      { id: 'pending', publicationState: 'replicationPending' },
      { id: 'winner', publicationState: 'durabilityVerified', importIdentityKey: identityKey, importClaimantId: CLAIMANT_A },
      { id: 'loser', publicationState: 'durabilityVerified', importIdentityKey: identityKey, importClaimantId: CLAIMANT_B },
      { id: 'partial', publicationState: 'durabilityVerified', importIdentityKey: identityKey },
    ],
    claims: [claim({ identityKey, claimantId: CLAIMANT_A, videoId: 'winner' }), claim({ identityKey, claimantId: CLAIMANT_B, videoId: 'loser' })],
  })
  const publication = createContentPublication({ channel: harness.channel, publicFeed: harness.publicFeed })

  await t.exception(publication.project({ videoId: 'pending', stagedProfile: { name: 'must not leak' } }), /durability/i)
  await t.exception(publication.project({ videoId: 'loser', stagedProfile: { name: 'must not leak' } }), /claim/i)
  await t.exception(publication.project({ videoId: 'partial', stagedProfile: { name: 'must not leak' } }), /claim/i)
  t.is(harness.activationCalls.length, 0)
  t.is(harness.publicVideos.size, 0)
})

test('project passes explicit stages only to activation and replay repairs a partial projection', async (t) => {
  const harness = createFakeHarness({ videos: [{ id: 'video', title: 'Durable', publicationState: 'durabilityVerified' }] })
  const publication = createContentPublication({ channel: harness.channel, publicFeed: harness.publicFeed })
  const input = {
    videoId: 'video',
    stagedDescriptor: { descriptor: { seq: 1 } },
    stagedProfile: { name: 'Staged' },
    stagedSources: [{ provider: 'youtube', identityKey: 'youtube:channel' }],
    stagedArtwork: [{ role: 'poster', remoteUrl: 'https://example.test/poster.jpg' }],
  }

  t.is(harness.activationCalls.length, 0, 'unrelated legacy work cannot observe project input')
  harness.setFailActivation(true)
  await t.exception(publication.project(input), /partial projection/)
  t.ok(harness.publicVideos.has('video'), 'the simulated first attempt reached a partial public commit')
  await publication.project(input)
  await publication.project(input)

  t.is(harness.activationCalls.length, 3)
  t.alike(harness.activationCalls[1], {
    stagedDescriptor: input.stagedDescriptor,
    stagedProfile: input.stagedProfile,
    stagedSources: input.stagedSources,
    stagedArtwork: input.stagedArtwork,
  })
  t.is((await harness.publicBee.getVideo('video')).publicationState, 'durabilityVerified')
  t.is(harness.feedRows.size, 0, 'projection does not announce implicitly')
})

test('announce validates stable identities and finalize publishes private then public exactly once', async (t) => {
  const harness = createFakeHarness({ videos: [{ id: 'video', title: 'Ready', publicationState: 'durabilityVerified' }] })
  const publication = createContentPublication({ channel: harness.channel, publicFeed: harness.publicFeed })
  await publication.project({ videoId: 'video' })

  await t.exception(publication.announce({ channelKey: '33'.repeat(32), publicBeeKey: PUBLIC_BEE_KEY, videoId: 'video' }), /channel key/i)
  await t.exception(publication.announce({ channelKey: CHANNEL_KEY, publicBeeKey: '44'.repeat(32), videoId: 'video' }), /public bee key/i)
  await publication.announce({ channelKey: CHANNEL_KEY, publicBeeKey: PUBLIC_BEE_KEY, videoId: 'video' })
  const firstRevision = harness.publicRevision
  await publication.announce({ channelKey: CHANNEL_KEY, publicBeeKey: PUBLIC_BEE_KEY, videoId: 'video' })

  t.is(harness.feedRows.size, 1)
  t.is(harness.feedWrites, 1, 'announcement replay is a stable snapshot no-op')
  t.is(harness.feedRows.values().next().value.previewVideos[0].id, 'video')
  t.is(harness.feedRows.values().next().value.revision, firstRevision)

  await publication.finalize('video')
  await publication.finalize('video')
  t.is((await harness.channel.getVideo('video')).publicationState, 'published')
  t.is((await harness.publicBee.getVideo('video')).publicationState, 'published')
  t.is(harness.updateCalls.length, 1, 'finalize replay does not rewrite private state')
  t.alike(harness.updateCalls[0].options, { syncPublic: false })
})

test('finalize requires the exact video in the persisted announced snapshot', async (t) => {
  const harness = createFakeHarness({
    videos: [{ id: 'a', title: 'Announced', publicationState: 'durabilityVerified' }],
  })
  const publication = createContentPublication({ channel: harness.channel, publicFeed: harness.publicFeed })
  await publication.project({ videoId: 'a' })
  await publication.announce({ channelKey: CHANNEL_KEY, publicBeeKey: PUBLIC_BEE_KEY, videoId: 'a' })
  harness.privateVideos.set('b', { id: 'b', title: 'Projected only', publicationState: 'durabilityVerified' })
  await publication.project({ videoId: 'b' })

  await t.exception(publication.finalize('b'), /not been announced/i)
  t.is((await harness.channel.getVideo('b')).publicationState, 'durabilityVerified')
})

test('canonical feed reconciliation rejects missing root binding before persistence', async (t) => {
  const harness = createFakeHarness({
    videos: [{ id: 'video', title: 'Root required', publicationState: 'durabilityVerified' }],
  })
  const publication = createContentPublication({ channel: harness.channel, publicFeed: harness.publicFeed })
  await publication.project({ videoId: 'video' })
  harness.setVerifiedRoot(null)

  await t.exception(
    publication.reconcileCanonicalClaims({ channelKey: CHANNEL_KEY, publicBeeKey: PUBLIC_BEE_KEY }),
    /root descriptor/i,
  )
  t.is(harness.feedRows.size, 0)
  t.absent(harness.publicRevision)
})

test('claim reconciliation converges announced contenders and fail-closes uncertain evidence', async (t) => {
  const identityKey = 'youtube:video:42'
  const claimA = claim({ identityKey, claimantId: CLAIMANT_A, videoId: 'a' })
  const claimB = claim({ identityKey, claimantId: CLAIMANT_B, videoId: 'b' })
  const harness = createFakeHarness({
    videos: [
      { id: 'a', title: 'A', uploadedAt: 1, publicationState: 'durabilityVerified', importIdentityKey: identityKey, importClaimantId: CLAIMANT_A },
      { id: 'b', title: 'B', uploadedAt: 2, publicationState: 'durabilityVerified', importIdentityKey: identityKey, importClaimantId: CLAIMANT_B },
    ],
    claims: [claimA, claimB],
  })
  const publication = createContentPublication({ channel: harness.channel, publicFeed: harness.publicFeed })
  await publication.project({ videoId: 'a' })
  await publication.announce({ channelKey: CHANNEL_KEY, publicBeeKey: PUBLIC_BEE_KEY, videoId: 'a' })
  const revisionA = harness.publicRevision

  harness.setClaims([{ ...claimA, state: 'released' }, claimB])
  await publication.project({ videoId: 'b' })
  await publication.announce({ channelKey: CHANNEL_KEY, publicBeeKey: PUBLIC_BEE_KEY, videoId: 'b' })
  await publication.reconcileCanonicalClaims({ channelKey: CHANNEL_KEY, publicBeeKey: PUBLIC_BEE_KEY })
  const row = harness.feedRows.values().next().value
  t.alike(row.previewVideos.map((video) => video.id), ['b'])
  t.is((await harness.publicBee.getVideoWithStatus('a')).status, 'suppressed')
  t.is((await harness.publicBee.getVideoWithStatus('b')).status, 'found')
  t.not(harness.publicRevision, revisionA)

  const stableRevision = harness.publicRevision
  const stableWrites = harness.feedWrites
  harness.setUncertain(true)
  await t.exception(
    publication.reconcileCanonicalClaims({ channelKey: CHANNEL_KEY, publicBeeKey: PUBLIC_BEE_KEY }),
    /uncertain/i,
  )
  t.is(harness.publicRevision, stableRevision, 'uncertainty cannot advance the reconciliation revision')
  t.is(harness.feedWrites, stableWrites, 'uncertainty cannot replace the feed snapshot')
})

test('canonical revision sorts Unicode claim rows by fixed UTF-8 bytes', async (t) => {
  const rows = [
    { videoId: 'é-video', identityKey: 'é-source', claimantId: 'β-claimant' },
    { videoId: 'z-video', identityKey: 'z-source', claimantId: 'a-claimant' },
    { videoId: '𐐀-video', identityKey: '𐐀-source', claimantId: '𐐀-claimant' },
  ]
  const compareUtf8 = (left, right) => b4a.compare(b4a.from(left), b4a.from(right))
  const expectedRows = [...rows].sort((left, right) =>
    compareUtf8(left.videoId, right.videoId) ||
    compareUtf8(left.identityKey, right.identityKey) ||
    compareUtf8(left.claimantId, right.claimantId))
  const digest = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, b4a.from(JSON.stringify(expectedRows)))
  const expectedRevision = `sha256:${b4a.toString(digest, 'hex')}`

  const revisionForOrder = async (orderedRows) => {
    const videos = orderedRows.map((row, index) => ({
      id: row.videoId,
      title: row.videoId,
      uploadedAt: index + 1,
      publicationState: 'durabilityVerified',
      importIdentityKey: row.identityKey,
      importClaimantId: row.claimantId,
    }))
    const claims = orderedRows.map((row) => claim({
      identityKey: row.identityKey,
      claimantId: row.claimantId,
      videoId: row.videoId,
    }))
    const harness = createFakeHarness({ videos, claims })
    const publication = createContentPublication({
      channel: harness.channel,
      publicFeed: harness.publicFeed,
    })
    await publication.project({ videoId: orderedRows[0].videoId })
    return (await publication.reconcileCanonicalClaims({
      channelKey: CHANNEL_KEY,
      publicBeeKey: PUBLIC_BEE_KEY,
    })).revision
  }

  t.is(await revisionForOrder(rows), expectedRevision)
  t.is(await revisionForOrder([...rows].reverse()), expectedRevision)
})

test('a crash after PublicBee revision commit repairs feed state on a fresh publication instance', async (t) => {
  const harness = createFakeHarness({ videos: [{ id: 'video', title: 'Crash repair', publicationState: 'durabilityVerified' }] })
  await createContentPublication({ channel: harness.channel, publicFeed: harness.publicFeed }).project({ videoId: 'video' })
  harness.setFeedCrash(true)
  await t.exception(
    createContentPublication({ channel: harness.channel, publicFeed: harness.publicFeed })
      .reconcileCanonicalClaims({ channelKey: CHANNEL_KEY, publicBeeKey: PUBLIC_BEE_KEY }),
    /feed crash/,
  )
  const committedRevision = harness.publicRevision
  t.ok(committedRevision, 'raw PublicBee reconciliation revision committed before the crash')
  t.is(harness.feedRows.size, 0)

  const restarted = createContentPublication({ channel: harness.channel, publicFeed: harness.publicFeed })
  await restarted.reconcileCanonicalClaims({ channelKey: CHANNEL_KEY, publicBeeKey: PUBLIC_BEE_KEY })
  t.is(harness.feedRows.size, 1)
  t.is(harness.feedRows.values().next().value.revision, committedRevision)
})

test('PublicFeed stable channel snapshot upsert uses channel/publicBee identity without duplicate rows', async (t) => {
  const metaDb = createMemoryDb()
  const { swarm } = createTestSwarm()
  const feed = new PublicFeed(swarm, metaDb)
  const base = {
    channelKey: CHANNEL_KEY,
    publicBeeKey: PUBLIC_BEE_KEY,
    revision: `sha256:${'f'.repeat(64)}`,
    channelName: 'Stable Channel',
    manifestUpdatedAt: 999,
    videoIds: ['one'],
    previewVideos: [{ id: 'one', title: 'One', uploadedAt: 1 }],
  }

  t.is((await feed.upsertChannelSnapshot(base)).changed, true)
  t.is((await feed.upsertChannelSnapshot(base)).changed, false)
  t.is(await feed.getChannelSnapshotRevision(CHANNEL_KEY, PUBLIC_BEE_KEY), base.revision)
  t.is(feed.getFeed().length, 1)

  const next = {
    ...base,
    revision: `sha256:${'a'.repeat(64)}`,
    manifestUpdatedAt: 1,
    videoIds: ['two'],
    previewVideos: [{ id: 'two', title: 'Two', uploadedAt: 2 }],
  }
  t.is((await feed.upsertChannelSnapshot(next)).changed, true)
  t.is(feed.getFeed().length, 1, 'video ID is snapshot content, not feed row identity')
  t.alike(feed.getFeed()[0].previewVideos.map((video) => video.id), ['two'])
  t.is(feed.getFeed()[0].manifestUpdatedAt, 1, 'canonical revision replaces a lower manifest timestamp')
  feed.addEntry(CHANNEL_KEY, 'local', PUBLIC_BEE_KEY, {
    manifestUpdatedAt: 5000,
    videoCount: 1,
    previewVideos: [{ id: 'legacy-stale', title: 'Legacy stale', uploadedAt: 3 }],
  })
  t.alike(
    feed.getFeed()[0].previewVideos.map((video) => video.id),
    ['two'],
    'unrevisioned enrichment cannot overwrite a canonical winner snapshot',
  )
  const cleared = {
    ...next,
    revision: `sha256:${'b'.repeat(64)}`,
    manifestUpdatedAt: 0,
    videoIds: [],
    videoCount: 0,
    previewVideos: [],
  }
  t.is((await feed.upsertChannelSnapshot(cleared)).changed, true)
  const serialized = feed._serializeEntry(feed.getFeed()[0])
  t.ok(Object.hasOwn(serialized, 'previewVideos'))
  t.alike(serialized.previewVideos, [], 'revision-bound HAVE_FEED snapshots clear stale previews')
  t.is(serialized.videoCount, 0, 'revision-bound HAVE_FEED snapshots clear stale counts')
  feed.stop()
  const restarted = new PublicFeed(createTestSwarm().swarm, metaDb)
  await restarted.start()
  t.is(restarted.getFeed().length, 1)
  t.alike(restarted.getFeed()[0].previewVideos, [])
  t.is(await restarted.getChannelSnapshotRevision(CHANNEL_KEY, PUBLIC_BEE_KEY), cleared.revision)
  restarted.stop()
  const legacyFeed = new PublicFeed(createTestSwarm().swarm, createMemoryDb())
  legacyFeed.addEntry('33'.repeat(32), 'local', '44'.repeat(32), {
    manifestUpdatedAt: 1,
    previewVideos: [{ id: 'legacy-old', title: 'Old', uploadedAt: 1 }],
  })
  legacyFeed.addEntry('33'.repeat(32), 'local', '44'.repeat(32), {
    manifestUpdatedAt: 2,
    previewVideos: [{ id: 'legacy-new', title: 'New', uploadedAt: 2 }],
  })
  t.alike(
    legacyFeed.getFeed()[0].previewVideos.map((video) => video.id),
    ['legacy-new'],
    'legacy feed entries keep timestamp-based enrichment compatibility',
  )
  legacyFeed.stop()
})

test('real deferred MultiWriterChannel/PublicBee stays empty until staged durable projection activates', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-content-publication-'))
  const store = new Corestore(dir)
  const metaDb = createMemoryDb()
  const { swarm, joins } = createTestSwarm()
  const ctx = {
    store,
    swarm,
    channels: new Map(),
    metaDb,
    metaSubspaces: {
      channelKinds: { async put() {} },
      publicProjectionStates: createMemoryDb(),
    },
  }

  try {
    await store.ready()
    const identityManager = createIdentityManager({ ctx })
    const created = await identityManager.createIdentity('Publication Integration', false, { deferPublicProjection: true })
    const channel = ctx.channels.get(created.driveKey)
    const feed = new PublicFeed(swarm, metaDb)
    const publication = createContentPublication({ channel, publicFeed: feed })
    await channel.addVideo({ id: 'real-video', title: 'Real video', uploadedAt: 1, publicationState: 'replicationPending' })

    t.alike(await channel.publicBee.listVideos(), [])
    t.absent(await channel.publicBee.getMetadata())
    t.absent(await channel.publicBee.getRootDescriptor())
    t.absent(await channel.publicBee.getChannelProfile())
    t.alike(await channel.publicBee.listChannelSources(), [])
    t.alike(await channel.publicBee.listChannelArtwork(), [])
    await publication.markDurabilityVerified('real-video')
    t.alike(await channel.publicBee.listVideos(), [])

    await publication.project({
      videoId: 'real-video',
      stagedDescriptor: created.signedDescriptor,
      stagedProfile: { profileKind: 'creator', releaseYear: 2026 },
      stagedSources: [{ provider: 'youtube', identityKey: 'youtube:integration', sourceId: 'integration' }],
      stagedArtwork: [{ role: 'poster', remoteUrl: 'https://example.test/real.jpg' }],
    })
    t.is((await channel.publicBee.getVideo('real-video')).publicationState, 'durabilityVerified')
    t.is((await channel.publicBee.getMetadata()).name, 'Publication Integration')
    t.alike(await channel.publicBee.getChannelProfile(), {
      id: 'profile',
      profileKind: 'creator',
      releaseYear: 2026,
    })
    t.is((await channel.publicBee.listChannelSources()).length, 1)
    t.is((await channel.publicBee.listChannelArtwork()).length, 1)
    t.ok(joins.includes(b4a.toString(channel.publicBee.discoveryKey, 'hex')))

    await publication.announce({ channelKey: channel.keyHex, publicBeeKey: channel.publicBee.keyHex, videoId: 'real-video' })
    t.is(feed.getFeed().length, 1)
    const reconciliationRevision = await channel.publicBee.getCanonicalReconciliationRevision()
    t.ok(/^sha256:[0-9a-f]{64}$/.test(reconciliationRevision))
    t.absent(
      (await channel.publicBee.getChannelProfile()).canonicalRevision,
      'claim-set revision stays separate from root/profile capability evidence',
    )
    t.is(feed.getFeed()[0].signedDescriptor?.descriptor?.channelId, channel.keyHex)
    await publication.finalize('real-video')
    t.is((await channel.getVideo('real-video')).publicationState, 'published')
    t.is((await channel.publicBee.getVideo('real-video')).publicationState, 'published')
    feed.stop()
  } finally {
    for (const channel of new Set(ctx.channels.values())) await closeSilently(channel)
    await closeSilently(store)
    rmSync(dir, { recursive: true, force: true })
  }
})
