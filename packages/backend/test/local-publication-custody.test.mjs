import assert from 'node:assert/strict'
import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Corestore from 'corestore'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalPublicationCustody } from '../src/network/local-publication-custody.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'
import {
  createPublicationManifest,
  createRenditionDescriptor,
  verifyPublicationManifest,
  writeStaticAsset,
  createBufferSourceReader,
  ASSET_BLOCK_SIZE,
} from '../src/assets/index.js'

function scheduler() {
  let clock = 0
  let pending = null
  return {
    now: () => clock,
    schedule(fn, delay) {
      assert.equal(pending, null, 'custody may schedule only one task')
      pending = { fn, at: clock + delay }
      return pending
    },
    cancel(task) { if (pending === task) pending = null },
    get pending() { return pending !== null },
    async tick() {
      assert.ok(pending, 'custody has a continuation')
      const task = pending
      pending = null
      clock = task.at
      await task.fn()
    },
    async until(predicate, limit = 10_000) {
      for (let ticks = 0; !predicate(); ticks++) {
        assert.ok(ticks < limit, 'custody eventually makes progress')
        await this.tick()
      }
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// A scheduling model, not an authorization fixture. Real signed manifests and
// static cores exercise the production ownership and cancellation boundary below.
function catalogModel(count = 300) {
  const manifests = new Map()
  for (let index = 0; index < count; index++) {
    const publicationId = String(index)
    const rendition = { renditionId: `media:${index}`, purpose: 'original' }
    const artwork = { renditionId: `cover:${index}`, purpose: 'poster' }
    manifests.set(publicationId, { rendition, manifest: { body: { renditions: [rendition, artwork] } } })
  }
  const ids = [...manifests.keys()]
  // Cross both boundaries: >64 publications in one binding and >16 bindings.
  const groups = [ids.slice(0, 130)]
  for (let start = 130; start < ids.length; start += 10) groups.push(ids.slice(start, start + 10))
  let leases = 0
  let reads = 0
  let failPage = false
  let failProjection = false
  const catalogRegistry = {
    async listBindingPage({ cursor, limit, writableOnly }) {
      assert.equal(writableOnly, true)
      assert.ok(limit <= 16)
      reads++
      if (failPage) { failPage = false; throw new Error('transient registry read') }
      assert.equal(leases, 0, 'previous binding page released before next admission')
      leases++
      const start = Number(cursor || 0)
      let released = false
      return {
        items: groups.slice(start, start + limit).map(group => ({
          catalog: {
            writable: true,
            async listProjections(_kind, { cursor: offset, limit: size }) {
              assert.equal(released, false, 'projection reads require their page lease')
              assert.ok(size <= 64)
              if (failProjection) { failProjection = false; throw new Error('transient projection read') }
              const position = Number(offset || 0)
              return {
                items: group.slice(position, position + size).map(publicationId => ({ body: { publicationId } })),
                nextCursor: position + size < group.length ? String(position + size) : null,
              }
            },
          },
        })),
        nextCursor: start + limit < groups.length ? String(start + limit) : null,
        async release() {
          assert.equal(released, false, 'lease released exactly once')
          released = true
          leases--
        },
      }
    },
  }
  const visits = new Map()
  const active = new Map()
  const attempts = new Map()
  const failures = new Map()
  let peak = 0
  const scopedNetwork = {
    async retainAuthorizedRendition({ renditionId, ownerId, retainArtwork, signal }) {
      assert.equal(retainArtwork, false, 'implicit artwork must not escape the budget')
      assert.equal(signal.aborted, false)
      attempts.set(renditionId, (attempts.get(renditionId) || 0) + 1)
      const failuresLeft = failures.get(renditionId) || 0
      if (failuresLeft > 0) {
        failures.set(renditionId, failuresLeft - 1)
        throw new Error('temporary unavailable rendition')
      }
      visits.set(renditionId, (visits.get(renditionId) || 0) + 1)
      active.set(`${renditionId}\0${ownerId}`, true)
      peak = Math.max(peak, active.size)
    },
    async releaseAuthorizedRendition({ renditionId, ownerId }) {
      assert.ok(ownerId, 'rotation must never release other owners')
      active.delete(`${renditionId}\0${ownerId}`)
    },
  }
  return {
    catalogRegistry,
    verifiedQueryView: { async getRendition({ publicationId }) { return manifests.get(publicationId) } },
    scopedNetwork,
    visits, active, attempts, failures,
    get peak() { return peak },
    get leases() { return leases },
    get reads() { return reads },
    failPage() { failPage = true },
    failProjection() { failProjection = true },
  }
}

test('rolling custody visits the full catalog and artwork across repeated bounded windows', async t => {
  const model = catalogModel()
  const clock = scheduler()
  const custody = createLocalPublicationCustody({ ...model, ...clock })
  custody.start()
  await clock.until(() => model.visits.size === 600)
  t.is(model.peak, 256, 'artwork shares the 256-handle ceiling')
  t.is(model.active.size, 256, 'not all catalog bytes are simultaneously held')
  await clock.until(() => [...model.visits.values()].every(count => count >= 2))
  t.is(model.peak, 256, 'subsequent full passes cannot multiply owners')
  await custody.close()
  t.is(model.active.size, 0)
  t.is(model.leases, 0)
  t.is(clock.pending, false)
})

test('custody retries transient candidates and pages, advances after bounded failures, and revisits', async t => {
  const model = catalogModel(3)
  model.failPage()
  model.failProjection()
  model.failures.set('media:0', 1)
  model.failures.set('media:1', 3)
  const clock = scheduler()
  const custody = createLocalPublicationCustody({ ...model, ...clock, ceiling: 8 })
  custody.start()
  await clock.until(() => model.visits.has('media:2'))
  t.is(model.attempts.get('media:0'), 2, 'a transient rendition retries without restart')
  t.is(model.attempts.get('media:1'), 3, 'a failing candidate has a bounded attempt budget')
  t.absent(model.visits.get('media:1'), 'later titles are visited before retrying a spent candidate')
  await clock.until(() => model.visits.has('media:1'))
  t.is(model.attempts.get('media:1'), 4, 'a later full pass revisits the failed title')
  await custody.close()
  t.is(model.leases, 0)
  t.is(clock.pending, false)
})

test('custody waits for dwell before evicting and never admits above capacity', async t => {
  const model = catalogModel(1)
  const clock = scheduler()
  const custody = createLocalPublicationCustody({ ...model, ...clock, ceiling: 1, dwellMs: 5000 })
  custody.start()
  await clock.until(() => model.visits.has('media:0'))
  const retainedAt = clock.now()
  t.absent(model.visits.get('cover:0'), 'cover cannot implicitly overfill media custody')
  await clock.until(() => model.visits.has('cover:0'))
  t.ok(clock.now() >= retainedAt + 5000, 'oldest custody dwells before rotation')
  t.is(model.peak, 1)
  await custody.close()
})

test('close drains an in-flight binding lease without admitting its publications', async t => {
  const model = catalogModel(1)
  const clock = scheduler()
  const entered = deferred()
  const resume = deferred()
  const custody = createLocalPublicationCustody({
    ...model, ...clock,
    catalogRegistry: {
      async listBindingPage(request) {
        const page = await model.catalogRegistry.listBindingPage(request)
        entered.resolve()
        await resume.promise
        return page
      },
    },
  })
  custody.start()
  const tick = clock.tick()
  await entered.promise
  const closing = custody.close()
  resume.resolve()
  await Promise.all([tick, closing])
  t.is(model.leases, 0)
  t.is(model.visits.size, 0)
  t.is(clock.pending, false)
  custody.start()
  t.is(clock.pending, false, 'closed manager cannot restart')
})

async function realFixture(t, mediaBytes = b4a.from('custody media')) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-local-custody-'))
  const store = new Corestore(dir)
  await store.ready()
  const publisher = crypto.keyPair(b4a.alloc(32, 61))
  const mediaAsset = await writeStaticAsset({ store, reader: createBufferSourceReader(mediaBytes) })
  const coverAsset = await writeStaticAsset({ store, reader: createBufferSourceReader(b4a.from('custody cover')) })
  const media = createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core: mediaAsset.descriptor })
  const cover = createRenditionDescriptor({ purpose: 'poster', format: 'image/jpeg', core: coverAsset.descriptor })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey, keyPair: publisher, title: 'Local custody',
    renditions: [media, cover], signedAt: 10, expiresAt: 1000,
  })
  const swarm = new EventEmitter()
  swarm.connections = new Set()
  swarm.join = () => ({ async flushed() {}, destroy() {} })
  let authorizationGate = null
  const runtime = createScopedNetworkRuntime({
    swarm, store, now: () => 20,
    authorizePublication: async ({ manifest: candidate }) => {
      if (authorizationGate) await authorizationGate()
      return verifyPublicationManifest(candidate, { now: 20, allowedSigners: [publisher.publicKey] })
    },
  })
  await runtime.start()
  t.teardown(async () => {
    await runtime.close()
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    runtime, manifest, media, cover,
    gate(fn) { authorizationGate = fn },
    catalogRegistry: {
      async listBindingPage() {
        return {
          items: [{ catalog: {
            writable: true,
            async listProjections() { return { items: [{ body: { publicationId: manifest.publicationId } }] } },
          } }],
          async release() {},
        }
      },
    },
    verifiedQueryView: { async getRendition() { return { manifest, rendition: media } } },
  }
}

test('real signed static custody rotates artwork without releasing a playback owner', async t => {
  const fixture = await realFixture(t)
  const { runtime, manifest, media, cover } = fixture
  await runtime.retainAuthorizedRendition({ manifest, renditionId: media.renditionId, ownerId: 'playback', retainArtwork: false })
  const clock = scheduler()
  const visited = new Set()
  const custody = createLocalPublicationCustody({
    ...fixture, ...clock, ceiling: 1,
    scopedNetwork: {
      async retainAuthorizedRendition(request) {
        const result = await runtime.retainAuthorizedRendition(request)
        visited.add(request.renditionId)
        return result
      },
      releaseAuthorizedRendition: request => runtime.releaseAuthorizedRendition(request),
    },
  })
  t.teardown(() => custody.close())
  custody.start()
  await clock.until(() => visited.has(cover.renditionId))
  await custody.close()
  t.alike(await runtime.readVerifiedAssetBlock({ assetId: media.core.assetId, blockIndex: 0 }), b4a.from('custody media'),
    'playback still reads verified bytes after rotation and manager close')
  await t.exception(() => runtime.readVerifiedAssetBlock({ assetId: cover.core.assetId, blockIndex: 0 }),
    /asset scope is not active/, 'artwork had no unaccounted default owner')
  const released = await runtime.releaseAuthorizedRendition({ renditionId: media.renditionId, ownerId: 'playback' })
  t.is(released.released, true)
  t.is(released.remainingOwners, 0)
})

test('close during real authorization prevents late retention', async t => {
  const fixture = await realFixture(t)
  const clock = scheduler()
  const entered = deferred()
  const resume = deferred()
  fixture.gate(async () => { entered.resolve(); await resume.promise })
  const custody = createLocalPublicationCustody({ ...fixture, ...clock, scopedNetwork: fixture.runtime })
  custody.start()
  const tick = clock.tick()
  await entered.promise
  const closing = custody.close()
  resume.resolve()
  await Promise.all([tick, closing])
  const released = await fixture.runtime.releaseAuthorizedRendition({ renditionId: fixture.media.renditionId })
  t.is(released.released, false, 'aborted authorization never admitted an owner')
  t.is(clock.pending, false)
})

test('rotation skips a dependent slot and evicts the next oldest safe owner', async t => {
  const model = catalogModel(2)
  const clock = scheduler()
  let blocked = 0
  const custody = createLocalPublicationCustody({
    ...model, ...clock, ceiling: 2,
    scopedNetwork: {
      retainAuthorizedRendition: request => model.scopedNetwork.retainAuthorizedRendition(request),
      async releaseAuthorizedRendition(request) {
        if (request.renditionId === 'media:0') {
          assert.equal(request.preserveDependentOwners, true)
          blocked++
          return { released: false, blockedByDependentOwners: true }
        }
        return model.scopedNetwork.releaseAuthorizedRendition(request)
      },
    },
  })
  custody.start()
  await clock.until(() => model.visits.has('media:1'))
  t.ok(blocked > 0)
  t.is(model.active.size, 2)
  t.ok([...model.active.keys()].some(key => key.startsWith('media:0\0')), 'dependent slot stays counted')
  t.absent([...model.active.keys()].find(key => key.startsWith('cover:0\0')), 'next oldest safe slot rotated')
  t.alike(await custody.close(), { deferredToRuntimeClose: ['media:0'] })
})

test('real narrower owner blocks all rotation slots and defers its supporting handle on close', async t => {
  const fixture = await realFixture(t, b4a.alloc(ASSET_BLOCK_SIZE * 2, 37))
  const { runtime, manifest, media, cover } = fixture
  const clock = scheduler()
  const visited = new Set()
  let blocked = 0
  const custody = createLocalPublicationCustody({
    ...fixture, ...clock, ceiling: 1, workPerTick: 1,
    scopedNetwork: {
      async retainAuthorizedRendition(request) {
        const result = await runtime.retainAuthorizedRendition(request)
        visited.add(request.renditionId)
        return result
      },
      async releaseAuthorizedRendition(request) {
        const result = await runtime.releaseAuthorizedRendition(request)
        if (result.blockedByDependentOwners) blocked++
        return result
      },
    },
  })
  t.teardown(() => custody.close())
  custody.start()
  await clock.until(() => visited.has(media.renditionId))
  await runtime.retainAuthorizedRendition({
    manifest, renditionId: media.renditionId, ownerId: 'short-playback',
    start: 0, end: 1, retainArtwork: false,
  })
  await clock.until(() => blocked >= 2)
  t.absent(visited.has(cover.renditionId), 'all dependent slots wait instead of exceeding capacity')
  t.alike(await custody.close(), { deferredToRuntimeClose: [media.renditionId] })
  t.is(clock.pending, false)
  t.alike(await runtime.readVerifiedAssetBlock({ assetId: media.core.assetId, blockIndex: 0 }), b4a.alloc(ASSET_BLOCK_SIZE, 37))
  const released = await runtime.releaseAuthorizedRendition({ renditionId: media.renditionId, ownerId: 'short-playback' })
  t.is(released.released, true, 'manager close did not revoke the unrelated narrower owner')
  t.is(released.remainingOwners, 1, 'supporting custody owner awaits enclosing runtime shutdown')
})
