import test from 'brittle'
import { EventEmitter } from 'node:events'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Corestore from 'corestore'
import Hyperbee from 'hyperbee'

import * as publisherApiModule from '../src/api/publisher.js'
import {
  PUBLISHER_RECORD_TYPES,
  PublisherCatalog,
  createPublisherNamespaceDescriptor,
  derivePublisherId,
  encodePublisherNamespaceDescriptor,
  encodePublisherOperationBody,
} from '../src/publisher/index.js'
import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '@peartube/backend/records'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'
import { derivePublisherTopic } from '../src/network/topics.js'
import { PROTOCOL_MAJOR } from '../src/network/version.js'

const NOW = 1_700_000_000_000
const bytes = (length, seed = 0) => b4a.from(Array.from({ length }, (_, index) => (seed + index) & 255))
const hex = value => b4a.toString(value, 'hex')
const id = seed => bytes(32, seed)

function tempDir (name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name))
}

function signed ({ descriptor, signer, recordType, policyEpoch, sequence, body, signedAt = NOW }) {
  const canonicalBody = recordType === PUBLISHER_RECORD_TYPES.NAMESPACE
    ? encodePublisherNamespaceDescriptor(body)
    : encodePublisherOperationBody(recordType, body)
  const prepared = prepareSignedEnvelope({
    recordType,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: signer.publicKey,
    policyEpoch,
    issuerSequence: sequence,
    signedAt,
    canonicalBody,
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(
    prepared,
    crypto.sign(signedRecordSignaturePreimage(prepared), signer.secretKey)
  )
}

function deviceSigner (keyPair) {
  return Object.freeze({
    signerKey: b4a.from(keyPair.publicKey),
    async sign (preimage) {
      return crypto.sign(preimage, keyPair.secretKey)
    },
  })
}

function contributionPolicy (overrides = {}) {
  return {
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1024 * 1024,
    diskCeilingBytes: 1024 * 1024,
    permissions: { contribute: true, archive: false },
    publicServingAllowed: true,
    contributionBudgetBytes: 1024 * 1024,
    archiveBudgetBytes: 0,
    ...overrides,
  }
}

function fakeSwarm () {
  const swarm = new EventEmitter()
  swarm.connections = new Set()
  swarm.joins = []
  swarm.join = (topic, options = {}) => {
    const handle = {
      topic: b4a.from(topic),
      options,
      destroyed: 0,
      suspended: 0,
      resumed: 0,
      destroy () { this.destroyed += 1 },
      suspend () { this.suspended += 1 },
      resume () { this.resumed += 1 },
      flushed: async () => {},
    }
    swarm.joins.push(handle)
    return handle
  }
  swarm.destroy = async () => {}
  return swarm
}

async function openRegistry (directory, { maxOpenCatalogs = 4, deviceSeed = 71 } = {}) {
  const store = new Corestore(directory)
  await store.ready()
  const metadataCore = store.get({ name: 'publisher-registry-meta' })
  await metadataCore.ready()
  const metaDb = new Hyperbee(metadataCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await metaDb.ready()
  const device = crypto.keyPair(bytes(32, deviceSeed))
  const registry = publisherApiModule.createPublisherCatalogRegistry({ store, metaDb }, {
    now: () => NOW,
    maxOpenCatalogs,
    deviceSigner: deviceSigner(device),
  })
  return { store, metaDb, registry, device }
}

async function seedLocalPublisher (registry, { rootSeed, device, publicationSeed = 1, payload = 'seed-title' }) {
  const root = crypto.keyPair(bytes(32, rootSeed))
  const publisherId = derivePublisherId(root.publicKey)
  const binding = await registry.provision(publisherId, root.publicKey)
  const catalog = binding.catalog
  await catalog.ready()
  if (!(catalog.writable || catalog.localWriterKey != null)) {
    throw new Error('expected writable local catalog after provision')
  }

  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
  })
  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor,
  }), { allowAuthorityBootstrap: true })

  await catalog.append(signed({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0,
    sequence: 1,
    body: {
      writerKey: catalog.localWriterKey,
      signerKey: catalog.localSignerKey || device.publicKey,
      capabilities: ['announce', 'publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, rootSeed + 50),
    },
  }), { allowAuthorityBootstrap: true })

  const publicationId = id(200 + publicationSeed)
  await catalog.append(await catalog.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    policyEpoch: 0,
    sequence: 1,
    signedAt: NOW,
    body: {
      publicationId,
      manifestId: id(300 + publicationSeed),
      payload: b4a.from(payload),
    },
  }))
  await catalog.update?.()

  const projection = await catalog.getProjection('publication', publicationId)
  if (!projection) throw new Error('seeded publication projection missing')

  return { root, publisherId, binding, catalog, descriptor, publicationId, projection }
}

test('real-core cold restart discovers writable, uploads, and publishLocal advertises', async (t) => {
  const directory = tempDir('pt-reg-cold-')
  const first = await openRegistry(directory, { maxOpenCatalogs: 4, deviceSeed: 11 })
  let publisherId = null
  let publicationId = null
  try {
    const seeded = await seedLocalPublisher(first.registry, {
      rootSeed: 12,
      device: first.device,
      publicationSeed: 1,
      payload: 'before-restart',
    })
    publisherId = seeded.publisherId
    publicationId = seeded.publicationId
    t.ok(seeded.projection, 'seeded publication is projected before restart')
  } finally {
    await first.registry.close()
    await first.store.close()
  }

  const second = await openRegistry(directory, { maxOpenCatalogs: 4, deviceSeed: 11 })
  const swarm = fakeSwarm()
  let runtime = null
  try {
    t.is((await second.registry.listBindings()).length, 0, 'cold registry starts empty')

    const writables = await second.registry.getWritableBindings()
    t.is(writables.length, 1, 'cold discovery finds the real persisted local writable')
    t.alike(writables[0].publisherId, publisherId)
    t.ok(writables[0].catalog.writable || writables[0].catalog.localWriterKey != null)
    t.is(writables[0].transient, undefined)

    const catalog = writables[0].catalog
    await catalog.ready()
    t.ok(await catalog.getProjection('publication', publicationId), 'pre-restart publication readable after cold discovery')

    const nextPublicationId = id(211)
    await catalog.append(await catalog.createLocalOperation({
      recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
      policyEpoch: 0,
      sequence: 2,
      signedAt: NOW + 1,
      body: {
        publicationId: nextPublicationId,
        manifestId: id(311),
        payload: b4a.from('after-restart-upload'),
      },
    }))
    await catalog.update?.()
    t.ok(await catalog.getProjection('publication', nextPublicationId), 'cold upload projects a new publication')

    const descriptor = await catalog.getNamespaceDescriptor()
    t.ok(descriptor, 'namespace descriptor available for advertise topic')
    const expectedTopic = derivePublisherTopic({
      protocolMajor: PROTOCOL_MAJOR,
      publisherId: hex(publisherId),
      catalogEpoch: descriptor.catalogEpoch,
    })
    const expectedTopicHex = hex(expectedTopic)

    runtime = createScopedNetworkRuntime({
      swarm,
      store: second.store,
      catalogRegistry: second.registry,
      initialNetworkPolicy: contributionPolicy(),
    })
    await runtime.start()

    // start() -> restoreLocalPublisherScopes already publishes the cold local catalog.
    const publisherJoin = swarm.joins.find(join =>
      join.options?.server === true &&
      hex(join.topic) === expectedTopicHex &&
      join.destroyed === 0
    )
    t.ok(publisherJoin, 'startup restore advertises exact local publisher topic as server join')

    const refreshed = await runtime.publishLocalPublisherCatalog({
      publisherId: hex(publisherId),
    })
    t.is(refreshed.status, 'refreshed', 'repeat publish after restore refreshes existing local scope')
    t.is(refreshed.topic?.topicHex || hex(refreshed.topic?.topic || expectedTopic), expectedTopicHex,
      'refresh reports the same publisher topic')

    const resolved = await second.registry.resolve(publisherId)
    t.is(resolved.catalog, catalog, 'resolve still returns retained cold writable')
  } finally {
    try { await runtime?.close?.() } catch {}
    await second.registry.close()
    await second.store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('real-core listBindingPage walks more than maxOpenCatalogs after releasing each seed', async (t) => {
  const directory = tempDir('pt-reg-page-')
  const maxOpenCatalogs = 2
  const total = 5
  const opened = await openRegistry(directory, { maxOpenCatalogs, deviceSeed: 21 })
  const publisherIds = []
  try {
    for (let i = 0; i < total; i++) {
      const seeded = await seedLocalPublisher(opened.registry, {
        rootSeed: 30 + i,
        device: opened.device,
        publicationSeed: 10 + i,
        payload: `page-seed-${i}`,
      })
      publisherIds.push(hex(seeded.publisherId))
      // Release after each seed so capacity never blocks seeding; page walk reopens durable mappings.
      t.is(await opened.registry.release(seeded.publisherId), true)
    }
    t.is((await opened.registry.listBindings()).length, 0, 'all seeds released from live ownership')
    await opened.registry.close()
  } catch (error) {
    await opened.registry.close().catch(() => {})
    await opened.store.close().catch(() => {})
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
  await opened.store.close()

  const restarted = await openRegistry(directory, { maxOpenCatalogs, deviceSeed: 21 })
  try {
    let cursor = null
    const seen = new Set()
    let pages = 0
    let transientSeen = 0
    let retainedSeen = 0
    const retainedControls = []
    do {
      const page = await restarted.registry.listBindingPage({ cursor, limit: 2 })
      pages += 1
      t.ok(pages <= 8, 'page walk over real mappings stays finite')
      const pageItems = [...(page.items || [])]
      const transientCatalogs = []
      for (const item of pageItems) {
        await item.catalog.ready()
        t.ok(item.catalog.key, 'real catalog handle is live until release')
        seen.add(hex(item.publisherId))
        if (item.transient) {
          transientSeen += 1
          transientCatalogs.push(item.catalog)
        } else {
          retainedSeen += 1
          retainedControls.push(item.catalog)
        }
      }
      await page.release()
      await page.release() // idempotent

      for (const catalog of transientCatalogs) {
        t.is(catalog.base, null, 'page-leased transient clears Autobase base on release')
        t.is(catalog.key, null, 'page-leased transient has no bootstrap key after release')
      }
      for (const catalog of retainedControls) {
        t.ok(catalog.key, 'retained writable still exposes key after page release')
        t.ok(catalog.base, 'retained writable keeps Autobase base after page release')
      }

      cursor = page.nextCursor
    } while (cursor)

    t.is(seen.size, total, 'every real persisted mapping is reachable across pages')
    t.ok(retainedSeen >= 1, 'some writables are retained under localWritable capacity')
    t.ok(transientSeen >= 1, 'over-capacity writables are page-leased for complete walk')
    for (const idHex of publisherIds) t.ok(seen.has(idHex), `mapping ${idHex.slice(0, 8)} visited`)

    // Retained controls remain usable after the full walk.
    for (const catalog of retainedControls) {
      t.ok(catalog.key, 'retained control still live at end of walk')
      await catalog.ready()
    }
  } finally {
    await restarted.registry.close()
    await restarted.store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})


test('real-core full follower cache still cold-discovers local writable and uploads without eviction', async (t) => {
  const directory = tempDir('pt-reg-fullcache-')
  const followerDirs = []
  const maxOpenCatalogs = 2

  const followerMappings = []
  for (let i = 0; i < maxOpenCatalogs; i++) {
    const dir = tempDir(`pt-reg-follower-${i}-`)
    followerDirs.push(dir)
    const store = new Corestore(dir)
    await store.ready()
    const root = crypto.keyPair(bytes(32, 80 + i))
    const publisherId = derivePublisherId(root.publicKey)
    const catalog = new PublisherCatalog(store, { publisherId })
    await catalog.ready()
    followerMappings.push({
      publisherId,
      genesisRootKey: root.publicKey,
      catalogBootstrapKey: b4a.from(catalog.key),
    })
    await catalog.close()
    await store.close()
  }

  const first = await openRegistry(directory, { maxOpenCatalogs, deviceSeed: 41 })
  let localPublisherId = null
  try {
    for (const mapping of followerMappings) {
      await first.metaDb.put(`publisher-catalog:v1:${hex(mapping.publisherId)}`, {
        version: 1,
        publisherId: hex(mapping.publisherId),
        genesisRootKey: hex(mapping.genesisRootKey),
        catalogBootstrapKey: hex(mapping.catalogBootstrapKey),
      })
    }

    const local = await seedLocalPublisher(first.registry, {
      rootSeed: 99,
      device: first.device,
      publicationSeed: 40,
      payload: 'local-before-cache-fill',
    })
    localPublisherId = local.publisherId
    await first.registry.close()
  } finally {
    await first.store.close().catch(() => {})
  }

  const second = await openRegistry(directory, { maxOpenCatalogs, deviceSeed: 41 })
  try {
    const followerBindings = []
    for (const mapping of followerMappings) {
      followerBindings.push(await second.registry.resolve(mapping.publisherId))
    }
    for (const binding of followerBindings) {
      t.ok(binding.catalog)
      t.is(binding.catalog.writable, false)
    }

    const writables = await second.registry.getWritableBindings()
    t.is(writables.length, 1, 'cold local writable discovered with full follower cache')
    t.alike(writables[0].publisherId, localPublisherId)

    for (const binding of followerBindings) {
      await binding.catalog.ready()
      t.ok(binding.catalog.key, 'active follower remains usable (not evicted)')
    }

    const catalog = writables[0].catalog
    const uploadId = id(250)
    await catalog.append(await catalog.createLocalOperation({
      recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
      policyEpoch: 0,
      sequence: 2,
      signedAt: NOW + 5,
      body: {
        publicationId: uploadId,
        manifestId: id(350),
        payload: b4a.from('upload-with-full-follower-cache'),
      },
    }))
    await catalog.update?.()
    t.ok(await catalog.getProjection('publication', uploadId), 'cold upload works at full follower cache')

    const resolved = await second.registry.resolve(localPublisherId)
    t.is(resolved.catalog, catalog)
  } finally {
    await second.registry.close()
    await second.store.close()
    fs.rmSync(directory, { recursive: true, force: true })
    for (const dir of followerDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('listBindingPage aborts after ready on the sole streamed mapping and releases it', async (t) => {
  const values = new Map()
  const rootKey = b4a.alloc(32, 7)
  const pubId = derivePublisherId(rootKey)
  const pubHex = hex(pubId)
  values.set(`publisher-catalog:v1:${pubHex}`, {
    version: 1,
    publisherId: pubHex,
    genesisRootKey: hex(rootKey),
    catalogBootstrapKey: hex(b4a.alloc(32, 17)),
  })

  let closed = false
  const ac = new AbortController()
  const registry = publisherApiModule.createPublisherCatalogRegistry(
    {
      store: {},
      metaDb: {
        async get (key) { return values.has(key) ? { value: values.get(key) } : null },
        async put (key, value) { values.set(key, value) },
        async * createReadStream (options = {}) {
          const gte = options.gte || ''
          const lt = options.lt || '\xff'
          for (const key of [...values.keys()].sort()) {
            if (key >= gte && key < lt) yield { key, value: values.get(key) }
          }
        },
      },
    },
    {
      maxOpenCatalogs: 4,
      catalogFactory () {
        return {
          key: b4a.alloc(32, 17),
          localWriterKey: null,
          writable: false,
          async ready () {
            ac.abort(new Error('aborted-after-ready'))
          },
          async close () { closed = true },
        }
      },
    }
  )

  await t.exception(registry.listBindingPage({ limit: 4, signal: ac.signal }))
  t.is(closed, true, 'sole mapping opened then aborted is released')
  t.is((await registry.listBindings()).length, 0)
  await registry.close()
})

test('getWritableBindings fails closed when discovery page reports errors', async (t) => {
  const values = new Map()
  const rootKey = b4a.alloc(32, 8)
  const pubId = derivePublisherId(rootKey)
  const pubHex = hex(pubId)
  values.set(`publisher-catalog:v1:${pubHex}`, {
    version: 1,
    publisherId: pubHex,
    genesisRootKey: hex(rootKey),
    catalogBootstrapKey: hex(b4a.alloc(32, 18)),
  })

  const registry = publisherApiModule.createPublisherCatalogRegistry(
    {
      store: {},
      metaDb: {
        async get (key) { return values.has(key) ? { value: values.get(key) } : null },
        async put (key, value) { values.set(key, value) },
        async * createReadStream (options = {}) {
          const gte = options.gte || ''
          const lt = options.lt || '\xff'
          for (const key of [...values.keys()].sort()) {
            if (key >= gte && key < lt) yield { key, value: values.get(key) }
          }
        },
      },
    },
    {
      maxOpenCatalogs: 4,
      catalogFactory () {
        return {
          key: b4a.alloc(32, 18),
          localWriterKey: b4a.alloc(32, 19),
          writable: true,
          async ready () { throw new Error('disk failed') },
          async close () {},
        }
      },
    }
  )

  await t.exception(registry.getWritableBindings(), /PUBLISHER_CATALOG_UNAVAILABLE|disk failed/)
  t.is((await registry.listBindings()).length, 0, 'failed discovery does not retain partial authority')
  await registry.close()
})

test('>64 real persisted writables: later publisher advertises and can write after restart', async (t) => {
  // Soft bulk retain = min(64, max(maxOpen,1)). maxOpen=64 → soft cap 64; seed 65.
  const directory = tempDir('pt-reg-gt64-')
  const maxOpenCatalogs = 64
  const total = 65
  const first = await openRegistry(directory, { maxOpenCatalogs, deviceSeed: 91 })
  /** @type {Map<string, { publisherId: Uint8Array, publicationId: Uint8Array }>} */
  const seededByHex = new Map()
  try {
    for (let i = 0; i < total; i++) {
      const seeded = await seedLocalPublisher(first.registry, {
        rootSeed: 100 + i,
        device: first.device,
        publicationSeed: 400 + i,
        payload: `gt64-seed-${i}`,
      })
      seededByHex.set(hex(seeded.publisherId), {
        publisherId: seeded.publisherId,
        publicationId: seeded.publicationId,
      })
      // Release after each seed so soft/hard capacity never blocks seeding.
      t.is(await first.registry.release(seeded.publisherId), true)
    }
    t.is((await first.registry.listBindings()).length, 0, 'all seeds released before restart')
    await first.registry.close()
  } catch (error) {
    await first.registry.close().catch(() => {})
    await first.store.close().catch(() => {})
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
  await first.store.close()

  const second = await openRegistry(directory, { maxOpenCatalogs, deviceSeed: 91 })
  const swarm = fakeSwarm()
  let runtime = null
  try {
    // Full page walk; capture a publisher that is actually page-leased (over soft cap).
    let cursor = null
    const seen = new Set()
    let transientSeen = 0
    let retainedSeen = 0
    let overCapPublisherId = null
    let overCapCatalog = null
    do {
      const page = await second.registry.listBindingPage({ cursor, limit: 16, writableOnly: true })
      t.is((page.errors || []).length, 0, 'writable page walk does not capacity-fail excess')
      for (const item of page.items || []) {
        const idHex = hex(item.publisherId)
        seen.add(idHex)
        if (item.transient) {
          transientSeen += 1
          if (!overCapPublisherId) {
            overCapPublisherId = b4a.from(item.publisherId)
            overCapCatalog = item.catalog
            t.ok(overCapCatalog?.key, 'transient over-cap catalog is live under the page lease')
          }
        } else {
          retainedSeen += 1
        }
      }
      await page.release()
      if (overCapCatalog) {
        t.is(overCapCatalog.base, null, 'page-leased over-cap catalog clears Autobase base after release')
        t.is(overCapCatalog.key, null, 'page-leased over-cap catalog has no key after release')
        overCapCatalog = null // only assert disposal once
      }
      cursor = page.nextCursor
    } while (cursor)

    t.is(seen.size, total, 'every persisted writable is reachable across pages')
    t.ok(retainedSeen <= 64, 'soft bulk retain stays within maxLocalWritables')
    t.ok(transientSeen >= 1, 'excess writables are page-leased not capacity-rejected')
    t.ok(overCapPublisherId, 'captured a publisher ID that was observed as transient')
    for (const idHex of seededByHex.keys()) t.ok(seen.has(idHex), `mapping ${idHex.slice(0, 8)} visited`)

    const overCapHex = hex(overCapPublisherId)
    const overCapSeed = seededByHex.get(overCapHex)
    t.ok(overCapSeed, 'observed transient maps to a seeded publisher')

    // getWritableBindings returns only the warm retained set, not all 65.
    const warm = await second.registry.getWritableBindings()
    t.ok(warm.length <= 64, 'getWritableBindings is warm-cache only, not full restore')
    t.ok(warm.length >= 1, 'cold discovery retained some writables under the soft cap')
    t.is(warm.some(b => b4a.equals(b.publisherId, overCapPublisherId)), false,
      'observed over-cap publisher is not in warm retained set')

    // Over-cap publisher: acquire lease, write, release — no unbounded retain.
    const lease = await second.registry.acquireWritableBinding(overCapPublisherId)
    try {
      t.ok(lease.binding?.catalog, 'acquireWritableBinding opens over-cap writable')
      t.is(lease.binding.transient, true, 'observed over-cap acquire is a transient lease')
      t.ok(lease.binding.catalog.writable || lease.binding.catalog.localWriterKey != null)
      const uploadId = id(900)
      await lease.binding.catalog.append(await lease.binding.catalog.createLocalOperation({
        recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
        policyEpoch: 0,
        sequence: 2,
        signedAt: NOW + 9,
        body: {
          publicationId: uploadId,
          manifestId: id(901),
          payload: b4a.from('gt64-after-restart-write'),
        },
      }))
      await lease.binding.catalog.update?.()
      t.ok(await lease.binding.catalog.getProjection('publication', uploadId), 'over-cap writable can write under lease')
      t.ok(
        await lease.binding.catalog.getProjection('publication', overCapSeed.publicationId),
        'pre-restart publication readable under lease for observed over-cap publisher'
      )
    } finally {
      await lease.release()
    }

    // After release, over-cap handle must not join the retained warm set.
    const afterLease = await second.registry.listBindings()
    t.is(afterLease.some(b => b4a.equals(b.publisherId, overCapPublisherId)), false,
      'over-cap lease release leaves observed publisher out of retained warm set')
    t.ok(afterLease.length <= 64, 'lease path does not grow retained set past soft cap')

    runtime = createScopedNetworkRuntime({
      swarm,
      store: second.store,
      catalogRegistry: second.registry,
      initialNetworkPolicy: contributionPolicy(),
    })
    await runtime.start()

    // Startup restore advertises the observed over-cap publisher topic (not truncated).
    const topicLease = await second.registry.acquireWritableBinding(overCapPublisherId)
    let expectedTopicHex = null
    try {
      const descriptor = await topicLease.binding.catalog.getNamespaceDescriptor()
      expectedTopicHex = hex(derivePublisherTopic({
        protocolMajor: PROTOCOL_MAJOR,
        publisherId: overCapHex,
        catalogEpoch: descriptor.catalogEpoch,
      }))
    } finally {
      await topicLease.release()
    }

    const publisherJoin = swarm.joins.find(join =>
      join.options?.server === true &&
      hex(join.topic) === expectedTopicHex &&
      join.destroyed === 0
    )
    t.ok(publisherJoin, 'startup restore advertises observed over-cap publisher topic')

    // Warm set remains bounded after full restore + lease write path.
    t.ok((await second.registry.listBindings()).length <= 64, 'restore/lease paths keep soft retain bound')
  } finally {
    try { await runtime?.close?.() } catch {}
    await second.registry.close()
    await second.store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('acquireWritableBinding lease release and abort do not leak over-cap handles', async (t) => {
  const values = new Map()
  const pubs = []
  for (let i = 1; i <= 6; i++) {
    const rootKey = b4a.alloc(32, i)
    const pubId = derivePublisherId(rootKey)
    const pubHex = hex(pubId)
    const bootKey = b4a.alloc(32, 50 + i)
    values.set(`publisher-catalog:v1:${pubHex}`, {
      version: 1,
      publisherId: pubHex,
      genesisRootKey: hex(rootKey),
      catalogBootstrapKey: hex(bootKey),
    })
    pubs.push({ pubId, pubHex, bootKey })
  }

  const states = new Map()
  const registry = publisherApiModule.createPublisherCatalogRegistry(
    {
      store: {},
      metaDb: {
        async get (key) { return values.has(key) ? { value: values.get(key) } : null },
        async put (key, value) { values.set(key, value) },
        async * createReadStream (options = {}) {
          const gte = options.gte || ''
          const lt = options.lt || '\xff'
          for (const key of [...values.keys()].sort()) {
            if (key >= gte && key < lt) yield { key, value: values.get(key) }
          }
        },
      },
    },
    {
      maxOpenCatalogs: 2,
      catalogFactory (_store, options) {
        const pubHex = b4a.toString(options.publisherId, 'hex')
        const state = {
          key: options.key ? b4a.from(options.key) : b4a.alloc(32, 1),
          localWriterKey: b4a.alloc(32, 88),
          writable: true,
          closed: false,
          async ready () {},
          async close () { this.closed = true },
        }
        states.set(pubHex, state)
        return state
      },
    }
  )

  // Fill soft writable cap (maxLocalWritables = max(2,1) capped at 64 → 2).
  const first = await registry.acquireWritableBinding(pubs[0].pubId)
  const second = await registry.acquireWritableBinding(pubs[1].pubId)
  t.is(first.binding.transient, undefined, 'under-cap acquire retains')
  t.is(second.binding.transient, undefined, 'under-cap acquire retains')
  await first.release()
  await second.release()
  t.is((await registry.listBindings()).length, 2, 'under-cap acquires stay retained after no-op release')

  // Over-cap leases close on release.
  const third = await registry.acquireWritableBinding(pubs[2].pubId)
  t.is(third.binding.transient, true, 'over-cap acquire is leased')
  t.is(states.get(pubs[2].pubHex).closed, false)
  await third.release()
  t.is(states.get(pubs[2].pubHex).closed, true, 'over-cap lease closes on release')
  t.is((await registry.listBindings()).length, 2, 'over-cap lease did not join retained set')

  // Page abort: first soft-cap writables retain; the aborting/current transient must close.
  // Sorted hex order of pubs[0..5] determines stream order — track by ready order.
  const ac = new AbortController()
  let readyCount = 0
  /** @type {Array<{ pubHex: string, state: object }>} */
  const abortReadyOrder = []
  const abortStates = new Map()
  const abortRegistry = publisherApiModule.createPublisherCatalogRegistry(
    {
      store: {},
      metaDb: {
        async get (key) { return values.has(key) ? { value: values.get(key) } : null },
        async put (key, value) { values.set(key, value) },
        async * createReadStream (options = {}) {
          const gte = options.gte || ''
          const lt = options.lt || '\xff'
          for (const key of [...values.keys()].sort()) {
            if (key >= gte && key < lt) yield { key, value: values.get(key) }
          }
        },
      },
    },
    {
      maxOpenCatalogs: 2,
      catalogFactory (_store, options) {
        const pubHex = b4a.toString(options.publisherId, 'hex')
        const state = {
          key: options.key ? b4a.from(options.key) : b4a.alloc(32, 1),
          localWriterKey: b4a.alloc(32, 88),
          writable: true,
          closed: false,
          async ready () {
            readyCount += 1
            abortReadyOrder.push({ pubHex, state })
            if (readyCount >= 3) ac.abort(new Error('page-aborted'))
          },
          async close () { this.closed = true },
        }
        abortStates.set(pubHex, state)
        return state
      },
    }
  )

  const firstPage = await abortRegistry.listBindingPage({ limit: 4, writableOnly: true, signal: ac.signal })
  await firstPage.release()
  await t.exception(abortRegistry.listBindingPage({ cursor: firstPage.nextCursor, limit: 4, writableOnly: true, signal: ac.signal }))
  t.ok(readyCount >= 3, 'abort fired after soft-cap retain plus a further open')
  // First two ready candidates are retained under soft cap (maxLocalWritables=2).
  const retainedReady = abortReadyOrder.slice(0, 2)
  for (const { state } of retainedReady) {
    t.is(state.closed, false, 'soft-cap retained writable stays open across page abort')
  }
  // The third (aborting) open is a page transient and must be closed by abort cleanup.
  const aborting = abortReadyOrder[2]
  t.ok(aborting, 'third ready candidate existed when abort fired')
  t.is(aborting.state.closed, true, 'aborting/current transient is closed')
  // Any further catalogs opened in the same aborted page must also be closed.
  for (const { state } of abortReadyOrder.slice(2)) {
    t.is(state.closed, true, 'post-cap opens on aborted page are released')
  }
  const retained = await abortRegistry.listBindings()
  t.is(retained.length, 2, 'abort leaves soft-cap retained writables, not zero bindings')
  t.ok(retained.every(b => !b.transient), 'listBindings only reports retained controls')

  await registry.close()
  // registry.close closes retained controls from the first registry.
  t.is(states.get(pubs[0].pubHex).closed, true, 'registry.close closes retained controls')
  t.is(states.get(pubs[1].pubHex).closed, true, 'registry.close closes retained controls')
  await abortRegistry.close()
  for (const { state } of retainedReady) {
    t.is(state.closed, true, 'abortRegistry.close closes its retained controls')
  }
})

test('acquireWritableBinding closes the just-created catalog when ready rejects, even when close rejects too', async (t) => {
  const values = new Map()
  const rootKey = b4a.alloc(32, 21)
  const pubId = derivePublisherId(rootKey)
  const pubHex = hex(pubId)
  values.set(`publisher-catalog:v1:${pubHex}`, {
    version: 1,
    publisherId: pubHex,
    genesisRootKey: hex(rootKey),
    catalogBootstrapKey: hex(b4a.alloc(32, 61)),
  })

  const readyFailure = new Error('catalog readiness failed')
  const createdCatalogs = []
  const registry = publisherApiModule.createPublisherCatalogRegistry(
    {
      store: {},
      metaDb: {
        async get (key) { return values.has(key) ? { value: values.get(key) } : null },
        async put (key, value) { values.set(key, value) },
      },
    },
    {
      maxOpenCatalogs: 2,
      catalogFactory (_store, options) {
        const catalog = {
          key: b4a.from(options.key),
          localWriterKey: b4a.alloc(32, 88),
          writable: true,
          closeAttempts: 0,
          async ready () { throw readyFailure },
          async close () {
            catalog.closeAttempts += 1
            throw new Error('close failed during ready rejection')
          },
        }
        createdCatalogs.push(catalog)
        return catalog
      },
    }
  )

  const failure = await registry.acquireWritableBinding(pubId).then(() => null, error => error)
  t.is(failure, readyFailure, 'the original ready failure survives a rejecting close')
  t.is(createdCatalogs.length, 1, 'exactly one catalog was created for the failed open')
  t.is(createdCatalogs[0].closeAttempts, 1, 'the failed open closes the exact catalog it created')
  t.is((await registry.listBindings()).length, 0, 'rejected open retains nothing')
  await registry.close()
})

test('acquireWritableBinding abort during in-flight ready closes it exactly once and a later acquire reopens fresh', async (t) => {
  const values = new Map()
  const rootKey = b4a.alloc(32, 22)
  const pubId = derivePublisherId(rootKey)
  const pubHex = hex(pubId)
  values.set(`publisher-catalog:v1:${pubHex}`, {
    version: 1,
    publisherId: pubHex,
    genesisRootKey: hex(rootKey),
    catalogBootstrapKey: hex(b4a.alloc(32, 62)),
  })

  const createdCatalogs = []
  let settleFirstReady = null
  let markFirstReadyStarted = null
  const firstReadyStarted = new Promise((resolve) => { markFirstReadyStarted = resolve })
  const registry = publisherApiModule.createPublisherCatalogRegistry(
    {
      store: {},
      metaDb: {
        async get (key) { return values.has(key) ? { value: values.get(key) } : null },
        async put (key, value) { values.set(key, value) },
      },
    },
    {
      maxOpenCatalogs: 2,
      catalogFactory (_store, options) {
        const index = createdCatalogs.length
        const catalog = {
          key: b4a.from(options.key),
          localWriterKey: b4a.alloc(32, 88),
          writable: true,
          closes: 0,
          async ready () {
            if (index === 0) {
              markFirstReadyStarted()
              await new Promise((resolve) => { settleFirstReady = resolve })
            }
          },
          async close () { catalog.closes += 1 },
        }
        createdCatalogs.push(catalog)
        return catalog
      },
    }
  )

  const ac = new AbortController()
  const inFlight = registry.acquireWritableBinding(pubId, { signal: ac.signal })
  await firstReadyStarted
  ac.abort(new Error('aborted-during-ready'))
  settleFirstReady()

  await t.exception(inFlight, /aborted-during-ready/, 'abort while ready is in flight rejects with the abort reason')
  t.is(createdCatalogs[0].closes, 1, 'the ready-settled abort closes the just-created catalog exactly once')
  t.is((await registry.listBindings()).length, 0, 'aborted open retains nothing')

  const reopened = await registry.acquireWritableBinding(pubId, { signal: new AbortController().signal })
  try {
    t.is(createdCatalogs.length, 2, 'a later legitimate acquisition reopens rather than inheriting a leaked entry')
    t.not(reopened.binding.catalog, createdCatalogs[0], 'the aborted catalog is never adopted')
    t.is(reopened.binding.catalog, createdCatalogs[1], 'reopen runs through the normal ownership path')
    t.is(reopened.binding.transient, undefined, 'reopen under the soft cap retains normally')
    t.is(createdCatalogs[0].closes, 1, 'reopen does not double-close the aborted catalog')
  } finally {
    await reopened.release()
  }
  await registry.close()
  t.is(createdCatalogs[1].closes, 1, 'registry.close disposes the reopened retained catalog')
})
