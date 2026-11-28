import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import b4a from 'b4a'
import Hyperblobs from 'hyperblobs'
import HyperDHT from 'hyperdht'
import hypercoreCrypto from 'hypercore-crypto'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createPrivateGuard } from '../src/private-overlay.js'
import { createSettings } from '../src/settings.js'
import { generateMnemonic } from '../src/mnemonic.js'
import { BLOB_BLOCK_SIZE, formatWatchUri } from '../src/protocol.js'

const tmp = label => mkdtempSync(join(tmpdir(), `peartube-p0e-${label}-`))
const sha256Hex = buf => createHash('sha256').update(buf).digest('hex')

async function until (fn, ms = 60_000, label = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const val = await fn()
    if (val) return val
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

function makeNetCtx (opts) {
  const registeredTopics = new Map()
  const replication = {
    registerTopic (topic, scopeId) {
      const hex = b4a.toString(topic, 'hex')
      let set = registeredTopics.get(hex)
      if (!set) { set = new Set(); registeredTopics.set(hex, set) }
      set.add(scopeId)
    },
    unregisterTopic (topic, scopeId) {
      const hex = b4a.toString(topic, 'hex')
      const set = registeredTopics.get(hex)
      if (!set) return
      set.delete(scopeId)
      if (set.size === 0) registeredTopics.delete(hex)
    },
    registerDiscoveryKey () {},
    attach () {},
    grantScopeOnPeerTopics () {},
    grantTopicsOnConn () {},
    destroy () {}
  }
  const ctx = {
    opts,
    undo: [],
    life: { closing: false, suspended: false },
    storage: { isMobileWorklet: false },
    replication,
    channel: {
      usePrimary: () => false,
      primaryKey: '',
      channel: { key: null, discoveryKey: null, update: async () => {} },
      findingPeers: () => () => {}
    },
    blobs: {
      sourcePeers: new Set(),
      cachedBlobs: new Map(),
      blobSlots: [],
      ownedBlobs: new Map(),
      blobCores: new Map(),
      isOwnedBlob: () => false,
      ensureBlockCounter () {},
      localBlocks: () => 0,
      hydrateOwned: async () => {}
    }
  }
  return { ctx, registeredTopics }
}

test('ephemeral joinEphemeralSource streams over 2-hop privateRouting without following and preserves followed channels', { timeout: 180_000 }, async t => {
  const testnet = await createTestnet(4)
  const guards = []
  const nodes = []
  const nets = []

  t.after(async () => {
    for (const net of nets.reverse()) {
      clearInterval(net.rotateTimer)
      clearInterval(net.refreshTimer)
      await net.destroySwarm()
    }
    for (const node of nodes.reverse()) await node.close()
    for (const g of guards.reverse()) await g.close()
    await testnet.destroy()
  })

  for (let i = 0; i < 2; i++) {
    guards.push(await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap }))
  }

  // Part A: Full 2-hop streaming from an unfollowed Founder via ephemeral source-swarm hold.
  const founder = await createNode({ storage: tmp('founder'), bootstrap: testnet.bootstrap, privateRouting: true })
  nodes.push(founder)
  const followed = await createNode({ storage: tmp('followed'), bootstrap: testnet.bootstrap, privateRouting: true })
  nodes.push(followed)

  const founderKey = founder.status().channel
  const followedKey = followed.status().channel
  const movieBytes = randomBytes(700 * 1024 + 17)
  const followedBytes1 = randomBytes(128 * 1024 + 11)
  const pub = await founder.publish({ id: 'imdb:tt0900001', title: 'Ephemeral Private Film' }, Readable.from([movieBytes]))
  await followed.publish({ id: 'imdb:tt0900002', title: 'Followed Film One' }, Readable.from([followedBytes1]))

  const viewer = await createNode({
    storage: tmp('viewer'),
    bootstrap: testnet.bootstrap,
    privateRouting: true,
    sources: [{ key: followedKey, kind: 'channel' }]
  })
  nodes.push(viewer)

  assert.equal(viewer.listSources().some(s => s.key === followedKey), true, 'viewer follows the followed channel')
  assert.equal(viewer.listSources().some(s => s.key === founderKey), false, 'viewer does NOT follow founder')

  await until(async () => (await viewer.search('imdb:tt0900002')).length === 1, 90_000, 'viewer syncs followed channel')

  // Open a real watch URI for an unfollowed Founder over 2-hop privateRouting without adding Founder to listSources().
  const watchUri = formatWatchUri(pub, founderKey, 'channel')
  const opened = await viewer.openUri(watchUri)
  assert.equal(opened.action, 'watch', 'openUri returns watch action')
  assert.equal(viewer.listSources().some(s => s.key === founderKey), false, 'ephemeral watch link never follows founder')
  assert.equal(viewer.swarm.topics().length, 2, 'openUri joins ephemeral source-swarm topic under privateRouting alongside followed channel')

  const url = opened.entry.streamUrl
  const rangeRes = await fetch(url, { headers: { Range: 'bytes=524200-525223' } })
  assert.equal(rangeRes.status, 206)
  assert.deepEqual(Buffer.from(await rangeRes.arrayBuffer()), movieBytes.subarray(524200, 525224))

  const fullRes = await fetch(url)
  assert.equal(fullRes.status, 200)
  assert.equal(sha256Hex(Buffer.from(await fullRes.arrayBuffer())), sha256Hex(movieBytes), 'exact movie bytes streamed via openUri ephemeral 2-hop watch')
  assert.ok(viewer.status().routes.private.rxBytes >= movieBytes.length, 'traffic carried over 2-hop private guards')
  assert.equal(viewer.status().routes.public.rxBytes, 0, 'zero public fallback bytes')

  // Leaving a duplicate source-swarm hold for the followed channel must NOT withdraw its channel:<key> slot.
  viewer.swarm.joinSource(`source-swarm:${followedKey}`, b4a.from(followedKey, 'hex'))
  await viewer.swarm.leaveSource(`source-swarm:${followedKey}`)
  await viewer.swarm.leaveSource(`source-swarm:${founderKey}`)
  assert.ok(viewer.swarm.topics().length >= 1, 'followed channel rendezvous hold survives ephemeral leave')

  const followedBytes2 = randomBytes(128 * 1024 + 23)
  await followed.publish({ id: 'imdb:tt0900003', title: 'Followed Film Two' }, Readable.from([followedBytes2]))
  const [secondHit] = await until(
    async () => {
      const hits = await viewer.search('imdb:tt0900003')
      return hits.length > 0 ? hits : null
    },
    90_000,
    'followed channel continues syncing after ephemeral source-swarm leave'
  )
  const secondRes = await fetch(secondHit.streamUrl)
  assert.equal(secondRes.status, 200)
  assert.equal(sha256Hex(Buffer.from(await secondRes.arrayBuffer())), sha256Hex(followedBytes2))

  // Part B: Verify joinEphemeralSource LRU cap of 4 and replication scope registration on both public & privateRouting.
  const { createNetwork } = await import('../src/node/network.js')
  for (const mode of [{ label: 'public', privateRouting: false }, { label: 'private', privateRouting: true }]) {
    const { ctx, registeredTopics } = makeNetCtx({ bootstrap: testnet.bootstrap, privateRouting: mode.privateRouting })
    const net = await createNetwork(ctx)
    nets.push(net)

    assert.equal(typeof net.joinEphemeralSource, 'function', `${mode.label}: exports joinEphemeralSource`)
    assert.equal(net.joinEphemeralSource('not-hex'), false, `${mode.label}: rejects invalid hex`)
    assert.equal(net.joinEphemeralSource(''), false, `${mode.label}: rejects empty key`)

    const keptChannel = randomBytes(32).toString('hex')
    const keptBuf = b4a.from(keptChannel, 'hex')
    const keptDisc = hypercoreCrypto.discoveryKey(keptBuf)
    net.joinOverlayTopic(`channel:${keptChannel}`, keptBuf, keptDisc)

    const ephemeralKeys = [keptChannel, ...Array.from({ length: 5 }, () => randomBytes(32).toString('hex'))]
    for (const k of ephemeralKeys) {
      assert.equal(net.joinEphemeralSource(k.toUpperCase()), true, `${mode.label}: accepts valid hex`)
    }

    const activeEphemeral = [...net.discoveries.keys()].filter(id => id.startsWith('source-swarm:'))
    assert.equal(activeEphemeral.length, 4, `${mode.label}: caps ephemeral source-swarm holds at 4`)
    assert.equal(net.discoveries.has(`source-swarm:${keptChannel}`), false, `${mode.label}: oldest ephemeral hold evicted`)
    assert.equal(net.discoveries.has(`source-swarm:${ephemeralKeys[1]}`), false, `${mode.label}: second-oldest ephemeral hold evicted`)
    assert.equal(net.discoveries.has(`channel:${keptChannel}`), true, `${mode.label}: followed channel topic untouched by eviction`)
    if (!mode.privateRouting) {
      assert.ok(net.swarm.status(keptDisc), 'public Hyperswarm still holds followed channel topic')
    } else {
      assert.equal(net.swarm.topics().length, 5, 'private overlay holds 1 followed + 4 ephemeral topics')
    }

    // Touching the oldest surviving ephemeral key moves it to MRU so the next key is evicted instead.
    const touched = ephemeralKeys[2]
    const nextVictim = ephemeralKeys[3]
    assert.equal(net.joinEphemeralSource(touched), true)
    const extraKey = randomBytes(32).toString('hex')
    assert.equal(net.joinEphemeralSource(extraKey), true)
    assert.equal(net.discoveries.has(`source-swarm:${touched}`), true, `${mode.label}: LRU-touched ephemeral source kept`)
    assert.equal(net.discoveries.has(`source-swarm:${nextVictim}`), false, `${mode.label}: least-recently-used ephemeral source evicted`)

    const extraDiscHex = b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(extraKey, 'hex')), 'hex')
    assert.equal(
      registeredTopics.get(extraDiscHex)?.has(`channel:${extraKey}`),
      true,
      `${mode.label}: registers ephemeral topic under channel:<key> replication scope`
    )

    assert.equal(await net.leaveEphemeralSource(extraKey), true)
    assert.equal(await net.leaveEphemeralSource(extraKey), false)
    assert.equal(net.discoveries.has(`source-swarm:${extraKey}`), false)
  }
})

test('smooth v0.5.0 in-place disk upgrade preserves channel, writer, identity, legacy/per-video blobs, and migrates settings', { timeout: 120_000 }, async t => {
  const testnet = await createTestnet(3)
  const nodes = []
  t.after(async () => {
    for (const node of nodes.reverse()) await node.close()
    await testnet.destroy()
  })

  const storageDir = tmp('v050-upgrade')
  const mnemonic = generateMnemonic(12)
  const perVideoBytes = randomBytes(600 * 1024 + 29)
  const legacySlotBytes = randomBytes(96 * 1024 + 7)
  const fakeFollowedKey = randomBytes(32).toString('hex')
  const fakeCachedBlob = randomBytes(32).toString('hex')

  // Seed storage with v0.5.0 Corestore (per-video core + legacy shared slot 0) and identity.json.
  const seedNode = await createNode({ storage: storageDir, bootstrap: testnet.bootstrap, mnemonic })
  const perVideoPub = await seedNode.publish({ id: 'imdb:tt0500001', title: 'Per-Video Movie' }, Readable.from([perVideoBytes]))

  // Append a legacy shared-slot entry into slot 0 (`blobs`) as older v0.5.0 stores could carry.
  const slotCore = seedNode.store.get({ name: 'blobs' })
  await slotCore.ready()
  const slotBlobs = new Hyperblobs(slotCore, { blockSize: BLOB_BLOCK_SIZE })
  const legacyBlobId = await slotBlobs.put(legacySlotBytes)
  const slotKeyHex = b4a.toString(slotCore.key, 'hex')
  await seedNode.append({
    type: 'announce',
    id: 'imdb:tt0500002',
    title: 'Legacy Shared-Slot Movie',
    size: legacySlotBytes.length,
    sha256: sha256Hex(legacySlotBytes),
    blobs: slotKeyHex,
    blob: legacyBlobId
  })

  const origStatus = seedNode.status()
  const origChannel = origStatus.channel
  const origWriter = origStatus.writer
  await seedNode.close()

  // Seed v0.5.0 sidecar artifacts: legacy settings.json (`tracker`, `streamHost`, `streamPort`, `watchDir`),
  // cache-lru.json, and catalog-cache.json v1.
  writeFileSync(join(storageDir, 'settings.json'), JSON.stringify({
    tracker: origChannel,
    streamHost: '127.0.0.1',
    streamPort: 8175,
    watchDir: '/tmp/v050-legacy-watch',
    lan: false,
    cacheMaxGb: 5
  }, null, 2), { mode: 0o600 })

  writeFileSync(join(storageDir, 'cache-lru.json'), JSON.stringify({
    [fakeCachedBlob]: Date.now() - 60_000
  }), { mode: 0o600 })

  const cachedSub = `imdb:tt0500099/${fakeFollowedKey}/${fakeCachedBlob}:0`
  const cachedAnnounce = {
    type: 'announce',
    id: 'imdb:tt0500099',
    title: 'Cached v1 Catalog Entry',
    size: 1024,
    sha256: sha256Hex(Buffer.from('cached-v1-entry')),
    blobs: fakeCachedBlob,
    blob: { blockOffset: 0, byteOffset: 0, blockLength: 1, byteLength: 1024 }
  }
  writeFileSync(join(storageDir, 'catalog-cache.json'), JSON.stringify({
    version: 1,
    channels: {
      [fakeFollowedKey]: {
        syncedAt: Date.now() - 30_000,
        entries: [[cachedSub, cachedAnnounce]],
        discovered: []
      }
    }
  }), { mode: 0o600 })

  // Step 1: Settings migration (`tracker` -> `channel`, legacy keys stripped, valid keys kept).
  const settings = createSettings(storageDir)
  assert.equal(settings.get('channel'), origChannel, 'settings.json migrated legacy tracker -> channel')
  assert.equal(settings.get('cacheMaxGb'), 5, 'existing settings preserved across migration')
  const rawSettings = JSON.parse(readFileSync(join(storageDir, 'settings.json'), 'utf8'))
  assert.equal(rawSettings.channel, origChannel)
  assert.equal(Object.hasOwn(rawSettings, 'tracker'), false, 'legacy tracker key removed')
  assert.equal(Object.hasOwn(rawSettings, 'streamHost'), false, 'legacy streamHost key removed')
  assert.equal(Object.hasOwn(rawSettings, 'streamPort'), false, 'legacy streamPort key removed')
  assert.equal(Object.hasOwn(rawSettings, 'watchDir'), false, 'legacy watchDir key removed')

  // Step 2: Reopen node in-place on upgraded storage.
  const upgraded = await createNode({
    storage: storageDir,
    bootstrap: testnet.bootstrap,
    tracker: settings.get('channel'),
    sources: [{ key: fakeFollowedKey, kind: 'channel' }]
  })
  nodes.push(upgraded)

  const upStatus = upgraded.status()
  assert.equal(upStatus.channel, origChannel, 'channel key survived in-place upgrade')
  assert.equal(upStatus.writer, origWriter, 'writer key survived in-place upgrade')
  assert.equal(upStatus.writable, true, 'node remains writable after upgrade')
  const upId = await upgraded.identity({ revealMnemonic: true })
  assert.equal(upId.mnemonic, mnemonic, 'identity.json recovery mnemonic preserved')
  assert.equal(upId.role, 'owner', 'owner role preserved')

  // Catalog-cache.json v1 hydrated without error.
  const [cachedHit] = await upgraded.search('imdb:tt0500099')
  assert.ok(cachedHit, 'catalog-cache.json v1 hydrated followed source snapshot')
  assert.equal(cachedHit.title, 'Cached v1 Catalog Entry')

  // Owned per-video and legacy-slot entries survive intact with zero re-download.
  const [ownPerVideo] = await upgraded.search('imdb:tt0500001')
  const [ownLegacy] = await upgraded.search('imdb:tt0500002')
  assert.ok(ownPerVideo && ownPerVideo.local, 'per-video entry stays local after upgrade')
  assert.equal(ownPerVideo.cachedBytes, perVideoBytes.length)
  assert.equal(ownPerVideo.sha256, perVideoPub.sha256)
  assert.ok(ownLegacy && ownLegacy.local, 'legacy shared-slot entry stays local after upgrade')
  assert.equal(ownLegacy.cachedBytes, legacySlotBytes.length)
  assert.equal(upgraded.status().routes.public.rxBytes, 0, 'zero network re-download on local reopen')

  const localPerVideoRes = await fetch(ownPerVideo.streamUrl)
  assert.equal(localPerVideoRes.status, 200)
  assert.deepEqual(Buffer.from(await localPerVideoRes.arrayBuffer()), perVideoBytes)
  const localLegacyRes = await fetch(ownLegacy.streamUrl)
  assert.equal(localLegacyRes.status, 200)
  assert.deepEqual(Buffer.from(await localLegacyRes.arrayBuffer()), legacySlotBytes)

  // Step 3: Fresh follower streams both migrated entries byte-for-byte with zero errors.
  const follower = await createNode({
    storage: tmp('v050-follower'),
    bootstrap: testnet.bootstrap,
    tracker: origChannel
  })
  nodes.push(follower)

  const [fPerVideo, fLegacy] = await until(async () => {
    const a = await follower.search('imdb:tt0500001')
    const b = await follower.search('imdb:tt0500002')
    return a.length > 0 && b.length > 0 ? [a[0], b[0]] : null
  }, 60_000, 'follower synced upgraded channel')

  const fRes1 = await fetch(fPerVideo.streamUrl)
  assert.equal(fRes1.status, 200)
  assert.equal(sha256Hex(Buffer.from(await fRes1.arrayBuffer())), sha256Hex(perVideoBytes), 'follower streams upgraded per-video core byte-for-byte')

  const fRes2 = await fetch(fLegacy.streamUrl)
  assert.equal(fRes2.status, 200)
  assert.equal(sha256Hex(Buffer.from(await fRes2.arrayBuffer())), sha256Hex(legacySlotBytes), 'follower streams upgraded legacy slot core byte-for-byte')
})

test('contentBucketTopic determinism, prefix bucketing, cap enforcement, and privateRouting fail-closed', { timeout: 90_000 }, async t => {
  const { createNetwork, contentBucketTopic } = await import('../src/node/network.js')
  assert.equal(typeof contentBucketTopic, 'function', 'network.js exports contentBucketTopic')
  // Deterministic 256-bucket mapping for identical 2-hex prefixes (case-insensitive).
  const shaA = 'ab' + '0'.repeat(62)
  const shaB = 'ab' + 'f'.repeat(62)
  const shaUpper = 'AB' + '1'.repeat(62)
  const shaOther = 'cd' + '0'.repeat(62)

  const topicA = contentBucketTopic(shaA)
  const topicB = contentBucketTopic(shaB)
  const topicUpper = contentBucketTopic(shaUpper)
  const topicOther = contentBucketTopic(shaOther)
  const expected = hypercoreCrypto.hash(b4a.from('peartube/content-bucket/v1/ab'))

  assert.equal(topicA.byteLength, 32)
  assert.equal(b4a.equals(topicA, expected), true, 'matches peartube/content-bucket/v1/<prefix2> hash')
  assert.equal(b4a.equals(topicA, topicB), true, 'identical 2-hex prefixes map to one bucket')
  assert.equal(b4a.equals(topicA, topicUpper), true, 'prefix bucketing is case-insensitive')
  assert.equal(b4a.equals(topicA, topicOther), false, 'distinct prefixes map to distinct buckets')

  // Invalid inputs are refused.
  for (const bad of ['', 'ab', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), null, undefined, 42]) {
    assert.throws(() => contentBucketTopic(bad), /64-character hex/, `rejects invalid input: ${String(bad)}`)
  }

  const testnet = await createTestnet(3)
  const observer = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: 0 })
  const nets = []
  t.after(async () => {
    for (const net of nets.reverse()) {
      clearInterval(net.rotateTimer)
      clearInterval(net.refreshTimer)
      await net.destroySwarm()
    }
    await observer.destroy({ force: true })
    await testnet.destroy()
  })

  // Public Hyperswarm: opt-in, deduplicated by prefix, capped at 16, clean leave.
  const pubHarness = makeNetCtx({ bootstrap: testnet.bootstrap, privateRouting: false })
  const pubNet = await createNetwork(pubHarness.ctx)
  nets.push(pubNet)

  const first = pubNet.joinContentBucket(shaA, { server: false, client: true })
  assert.ok(first && first.prefix === 'ab' && first.server === false && first.client === true)
  const upgraded = pubNet.joinContentBucket(shaB, { server: true, client: false })
  assert.equal(upgraded, first, 'same prefix reuses existing bucket entry')
  assert.equal(first.server, true, 'bucket upgrades server flag in place')
  assert.equal(pubNet.contentBuckets.size, 1)
  assert.equal(pubNet.joinContentBucket('bad-input'), null, 'invalid digest returns null')

  for (let i = 0; i < 20; i++) {
    const p = i.toString(16).padStart(2, '0')
    pubNet.joinContentBucket(p + '0'.repeat(62), { server: false, client: true })
  }
  assert.equal(pubNet.contentBuckets.size, 16, 'content buckets respect cap of 16')
  assert.equal(pubNet.leaveContentBucket('13' + '0'.repeat(62)), true)
  assert.equal(pubNet.leaveContentBucket('13'), false)

  // privateRouting = true: strictly fail-closed, joins zero DHT topics.
  const privHarness = makeNetCtx({ bootstrap: testnet.bootstrap, privateRouting: true })
  const privNet = await createNetwork(privHarness.ctx)
  nets.push(privNet)

  const privBucket = privNet.joinContentBucket(shaOther, { server: true, client: true })
  assert.equal(privBucket, null, 'joinContentBucket is disabled under privateRouting')
  assert.equal(privNet.contentBuckets.size, 0, 'privateRouting holds zero content buckets')
  assert.equal(privHarness.registeredTopics.size, 1, 'only default SEARCH_TOPIC registered; zero bucket topics registered')

  const seenOnDht = new Set()
  for await (const rep of observer.lookup(topicOther)) {
    for (const peer of rep.peers) seenOnDht.add(b4a.toString(peer.publicKey, 'hex'))
  }
  assert.equal(seenOnDht.size, 0, 'privateRouting never announces content buckets on public DHT')
})
