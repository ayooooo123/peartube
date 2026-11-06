// End-to-end verification of PearTube's 1-Hypercore-per-video (`blockOffset: 0`) architecture:
//   1. Concurrent `acquire` ingests mint distinct per-video Hypercores (`blockOffset: 0`) immune to post-put `clearCache()`,
//      close their write sessions at rest, survive node restarts, and wake lazily via Corestore `ondiscoverykey` for viewers.
//   2. Shared-reference safety: removing one catalog entry while another entry still references the same video core preserves
//      playback; removing the final reference `core.purge()`s the video core and shrinks `blobBytes` + `seedableCores()`.
//   3. Legacy shared-slot migration (`blob-rechunk`): splits both variable-block and multi-entry shared `blobSlots` spans into
//      dedicated `512 KiB`-piece per-video cores, deduplicates identical `sha256:size` entries, repoints `jobs.json`, clears
//      the old slot, and lets a small capacity-capped HiveRelay pin & serve individual movies after origin shuts down.
// Writes repeatable evidence artifact to `desktop/target/e2e/per-video-blobs-result.json`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperblobs from 'hyperblobs'
import Protomux from 'protomux'
import c from 'compact-encoding'
import sodium from 'sodium-native'
import b4a from 'b4a'
import { createNode } from '../src/index.js'
import { parseUri } from '../src/protocol.js'
import { createAcquirer } from '../src/acquire.js'
import { createMirrorHost } from '../src/mirror.js'
import { signSeedRequest } from '../src/hiverelay.js'

const tmp = label => mkdtempSync(join(tmpdir(), `peartube-pvb-${label}-`))
const sha256 = buf => createHash('sha256').update(buf).digest('hex')

const RELAY_DISCOVERY_TOPIC = (() => {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.from('hiverelay-discovery-v1'))
  return out
})()

async function until (fn, ms = 90_000, label = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const val = await fn()
    if (val) return val
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

const seedReqDec = {
  preencode () {},
  encode () {},
  decode (s) {
    const appKey = c.fixed32.decode(s)
    const n = c.uint.decode(s)
    const discoveryKeys = []
    for (let i = 0; i < n; i++) discoveryKeys.push(c.fixed32.decode(s))
    return {
      appKey,
      discoveryKeys,
      replicationFactor: c.uint.decode(s),
      geoPreference: c.string.decode(s),
      maxStorageBytes: c.uint.decode(s),
      bountyRate: c.uint.decode(s),
      ttlSeconds: c.uint.decode(s),
      publisherPubkey: c.fixed32.decode(s),
      publisherSignature: c.fixed64.decode(s),
      revocable: s.start < s.end ? c.uint.decode(s) : 1,
      unseedFreezeMs: s.start < s.end ? c.uint.decode(s) : 0,
      durability: s.start < s.end ? c.uint.decode(s) : 0
    }
  }
}

const seedAccEnc = {
  preencode (s, m) {
    c.fixed32.preencode(s, m.appKey)
    c.fixed32.preencode(s, m.relayPubkey)
    c.string.preencode(s, m.region)
    c.uint.preencode(s, m.availableStorageBytes)
    c.fixed64.preencode(s, m.relaySignature)
  },
  encode (s, m) {
    c.fixed32.encode(s, m.appKey)
    c.fixed32.encode(s, m.relayPubkey)
    c.string.encode(s, m.region)
    c.uint.encode(s, m.availableStorageBytes)
    c.fixed64.encode(s, m.relaySignature)
  },
  decode: () => ({})
}

const noopEnc = { preencode () {}, encode () {}, decode: () => ({}) }

const seedDenyEnc = {
  preencode (s, m) {
    c.fixed32.preencode(s, m.appKey)
    c.fixed32.preencode(s, m.relayPubkey)
    c.string.preencode(s, m.reasonCode)
    c.string.preencode(s, m.detail)
    c.fixed64.preencode(s, m.relaySignature)
  },
  encode (s, m) {
    c.fixed32.encode(s, m.appKey)
    c.fixed32.encode(s, m.relayPubkey)
    c.string.encode(s, m.reasonCode)
    c.string.encode(s, m.detail)
    c.fixed64.encode(s, m.relaySignature)
  },
  decode: () => ({})
}

async function startCappedHiveRelay ({ bootstrap, availableBytes }) {
  const store = new Corestore(tmp('hr'))
  await store.ready()
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  const swarm = new Hyperswarm({ bootstrap, keyPair: { publicKey, secretKey } })
  const seeded = new Map()
  let usedBytes = 0
  const msgTimes = []
  let maxBurstSeen = 0

  swarm.on('connection', conn => {
    store.replicate(conn)
    const mux = Protomux.from(conn)
    let accMsg, denyMsg
    const ch = mux.createChannel({ protocol: 'hiverelay-seed', id: null, handshake: c.raw })
    ch.addMessage({
      encoding: seedReqDec,
      async onmessage (msg) {
        const sendDeny = (code, detail) => {
          const sig = b4a.alloc(64)
          sodium.crypto_sign_detached(sig, b4a.concat([msg.appKey, publicKey, b4a.from(code)]), secretKey)
          denyMsg.send({ appKey: msg.appKey, relayPubkey: publicKey, reasonCode: code, detail, relaySignature: sig })
        }
        const now = Date.now()
        while (msgTimes.length && now - msgTimes[0] > 500) msgTimes.shift()
        msgTimes.push(now)
        if (msgTimes.length > maxBurstSeen) maxBurstSeen = msgTimes.length
        if (msgTimes.length > 20) return sendDeny('rate-limited', `burst ${msgTimes.length} > 20`)
        const rem = Math.max(0, availableBytes - usedBytes)
        if (msg.maxStorageBytes > rem) return sendDeny('insufficient-storage', `avail ${rem} < ${msg.maxStorageBytes}`)
        for (const dk of msg.discoveryKeys) {
          const hex = b4a.toString(dk, 'hex')
          if (!seeded.has(hex)) {
            const core = store.get({ key: dk })
            await core.ready()
            swarm.join(core.discoveryKey, { server: true, client: true })
            await until(async () => { await core.update({ wait: false }).catch(() => {}); return core.length > 0 }, 30_000, `hr sync ${hex.slice(0, 8)}`)
            usedBytes += core.byteLength
            seeded.set(hex, { core, range: core.download({ start: 0, end: -1 }) })
          }
        }
        const sig = b4a.alloc(64)
        sodium.crypto_sign_detached(sig, b4a.concat([msg.appKey, publicKey, b4a.from('NA')]), secretKey)
        accMsg.send({ appKey: msg.appKey, relayPubkey: publicKey, region: 'NA', availableStorageBytes: Math.max(0, availableBytes - usedBytes), relaySignature: sig })
      }
    })
    accMsg = ch.addMessage({ encoding: seedAccEnc })
    ch.addMessage({ encoding: noopEnc })
    denyMsg = ch.addMessage({ encoding: seedDenyEnc })
    ch.open(b4a.from('{"major":1,"minor":0}'))
  })
  swarm.join(RELAY_DISCOVERY_TOPIC, { server: true, client: false })
  await swarm.flush()

  return {
    pubkey: b4a.toString(publicKey, 'hex'),
    seeded,
    get maxBurstSeen () { return maxBurstSeen },
    hasAllBlocks: async keys => {
      for (const k of keys) {
        const e = seeded.get(k)
        if (!e || e.core.length === 0 || !(await e.core.has(0, e.core.length))) return false
      }
      return true
    },
    async close () {
      for (const e of seeded.values()) { try { e.range.destroy() } catch {} await e.core.close().catch(() => {}) }
      await swarm.destroy({ force: true })
      await store.close()
    }
  }
}

test('1-Hypercore-per-video ingests, lazy wakeup, shared-ref purge guard, and legacy-slot split migration work end to end', { timeout: 240_000 }, async t => {
  void signSeedRequest
  const testnet = await createTestnet(3)
  const cleanups = []
  t.after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {})
    await testnet.destroy()
  })

  const v1Bytes = randomBytes(1100 * 1024 + 17) // 3 x 512 KiB pieces
  const v2Bytes = randomBytes(620 * 1024 + 29) // 2 x 512 KiB pieces
  const legacyVarBytes = randomBytes(400 * 1024 + 11)
  const legacySharedUniformBytes = randomBytes(1050 * 1024 + 7)

  const origin = createServer((req, res) => {
    if (req.url === '/v1.mp4') return res.end(v1Bytes)
    if (req.url === '/v2.mp4') return res.end(v2Bytes)
    res.writeHead(404).end()
  })
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => origin.close())
  const base = `http://127.0.0.1:${origin.address().port}`

  // ── 1. Concurrent per-video ingests + post-put clearCache() immunity + restart persistence ──
  const pubDir = tmp('pub')
  const jobsFile = join(pubDir, 'jobs.json')
  let pub = await createNode({ storage: pubDir, bootstrap: testnet.bootstrap })
  let pubOpen = true
  cleanups.push(async () => { if (pubOpen) await pub.close() })

  let acq = createAcquirer(pub, jobsFile, { concurrency: 2, defaultChannel: true })
  const j1 = acq.add({ id: 'imdb:tt0111161', title: 'Per-Video One', source: { url: `${base}/v1.mp4` }, channel: true })
  const j2 = acq.add({ id: 'imdb:tt0068646', title: 'Per-Video Two', source: { url: `${base}/v2.mp4` }, channel: true })
  await until(() => acq.get(j1.jobId)?.status === 'done' && acq.get(j2.jobId)?.status === 'done', 60_000, 'concurrent per-video acquires')

  const initialEntries = await pub.search()
  assert.equal(initialEntries.length, 2)
  const p1 = parseUri(initialEntries.find(e => e.id === 'imdb:tt0111161').magnetUrl).entry
  const p2 = parseUri(initialEntries.find(e => e.id === 'imdb:tt0068646').magnetUrl).entry
  assert.notEqual(p1.blobs, p2.blobs, 'each video owns its own distinct Hypercore')
  assert.equal(p1.blob.blockOffset, 0, 'video 1 starts at blockOffset 0')
  assert.equal(p2.blob.blockOffset, 0, 'video 2 starts at blockOffset 0')
  assert.notEqual(p1.blobs, pub.status().blobs, 'video 1 is not packed into legacy slot 0')
  assert.equal(pub.status().blobBytes, v1Bytes.byteLength + v2Bytes.byteLength, 'status().blobBytes tracks owned per-video cores')
  const clearRes = await pub.clearCache()
  assert.equal(clearRes.clearedBytes, 0, 'clearCache() never mistakes owned per-video cores for foreign cache')
  assert.equal(pub.status().blobBytes, v1Bytes.byteLength + v2Bytes.byteLength, 'owned per-video bytes survive explicit clearCache()')
  const v1LocalStream = Buffer.from(await (await fetch(initialEntries.find(e => e.id === 'imdb:tt0111161').streamUrl)).arrayBuffer())
  assert.equal(sha256(v1LocalStream), sha256(v1Bytes), 'owned per-video core still streams locally after clearCache()')

  // Restart publisher from disk to prove owned per-video cores rehydrate without losing local=true or blobBytes!
  const savedTracker = pub.status().tracker
  await pub.close()
  pubOpen = false
  pub = await createNode({ storage: pubDir, tracker: savedTracker, bootstrap: testnet.bootstrap })
  pubOpen = true
  assert.equal(pub.status().blobBytes, v1Bytes.byteLength + v2Bytes.byteLength, 'blobBytes survives restart')
  const afterRestart = await pub.search()
  assert.equal(afterRestart.every(e => e.local === true), true, 'owned per-video entries stay local=true after restart')

  // Viewer connects via Channel ONLY and streams both closed-at-rest per-video cores via Corestore lazy wakeup!
  const viewer = await createNode({
    storage: tmp('viewer'),
    bootstrap: testnet.bootstrap,
    sources: [{ key: pub.status().channel, kind: 'channel', alias: 'Per-Video Channel' }]
  })
  let viewerOpen = true
  cleanups.push(async () => { if (viewerOpen) await viewer.close() })

  await until(async () => (await viewer.search()).length === 2, 90_000, 'viewer channel sync')
  for (const [id, raw] of [['imdb:tt0111161', v1Bytes], ['imdb:tt0068646', v2Bytes]]) {
    const [hit] = await viewer.search(id)
    const range = await fetch(hit.streamUrl, { headers: { Range: 'bytes=524000-530000' } })
    assert.equal(range.status, 206)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), raw.subarray(524000, 530001))
    const full = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
    assert.equal(sha256(full), sha256(raw))
  }
  await viewer.close()
  viewerOpen = false

  // ── 2. Shared-reference purge guard + full purge on final reference removal ──
  const aliasPub = await pub.publishChannel({
    type: 'announce',
    id: 'imdb:tt0099999',
    title: 'Shared Core Alias',
    size: p1.size,
    sha256: p1.sha256,
    blobs: p1.blobs,
    blob: p1.blob
  })
  const origEntry1 = (await pub.search('imdb:tt0111161'))[0]
  await pub.remove(origEntry1.key)
  assert.equal(pub.status().blobBytes, v1Bytes.byteLength + v2Bytes.byteLength, 'shared per-video core preserved while alias entry still references it')
  const aliasStreamed = Buffer.from(await (await fetch(aliasPub.streamUrl)).arrayBuffer())
  assert.equal(sha256(aliasStreamed), sha256(v1Bytes), 'alias entry still streams intact bytes after first reference removed')

  await pub.removeChannel(aliasPub.key)
  assert.equal(pub.status().blobBytes, v2Bytes.byteLength, 'final reference removal purges dedicated per-video core from blobBytes')
  assert.equal(pub.seedableCores().some(c => c.key === p1.blobs), false, 'purged per-video core removed from seedableCores()')

  // ── 3. Legacy shared-slot split + deduplication migration (`blob-rechunk`) -> HiveRelay seeding ──
  // Manually populate legacy shared slot 0 (`blobs`) with 1 variable-block blob, 1 duplicate reference, and 1 shared uniform 512 KiB blob!
  const legacySlotCore = pub.store.get({ name: 'blobs' })
  await legacySlotCore.ready()
  const legacyVarBlobs = new Hyperblobs(legacySlotCore, { blockSize: 64 * 1024 })
  const varBlobId = await legacyVarBlobs.put(legacyVarBytes)
  const legacyUniBlobs = new Hyperblobs(legacySlotCore, { blockSize: 512 * 1024 })
  const uniBlobId = await legacyUniBlobs.put(legacySharedUniformBytes)
  const slot0Key = b4a.toString(legacySlotCore.key, 'hex')
  await legacySlotCore.close()

  const legacyOp1 = { type: 'announce', id: 'imdb:tt0088763', title: 'Legacy Var Back To Future', size: legacyVarBytes.byteLength, sha256: sha256(legacyVarBytes), blobs: slot0Key, blob: varBlobId }
  const legacyOp1Dup = { type: 'announce', id: 'imdb:tt0088764', title: 'Legacy Var Dup Cut', size: legacyVarBytes.byteLength, sha256: sha256(legacyVarBytes), blobs: slot0Key, blob: varBlobId }
  const legacyOp2 = { type: 'announce', id: 'imdb:tt0133093', title: 'Shared Slot Uniform Matrix', size: legacySharedUniformBytes.byteLength, sha256: sha256(legacySharedUniformBytes), blobs: slot0Key, blob: uniBlobId }
  for (const op of [legacyOp1, legacyOp1Dup, legacyOp2]) {
    await pub.append(op)
    await pub.publishChannel(op)
  }
  const fakeJobs = JSON.parse(readFileSync(jobsFile, 'utf8'))
  fakeJobs.push({ jobId: '00000000-0000-4000-8000-000000000099', id: legacyOp2.id, title: legacyOp2.title, status: 'done', size: legacyOp2.size, sha256: legacyOp2.sha256, announce: legacyOp2 })
  writeFileSync(jobsFile, JSON.stringify(fakeJobs))
  acq = createAcquirer(pub, jobsFile, { defaultChannel: true })

  const hrSmall = await startCappedHiveRelay({ bootstrap: testnet.bootstrap, availableBytes: 2 * 1024 * 1024 * 1024 })
  cleanups.push(() => hrSmall.close())

  const mirror = await createMirrorHost({
    node: pub,
    storage: pubDir,
    acquirer: acq,
    rechunk: false,
    hiverelay: { discover: true, replicas: 1 },
    pollIntervalMs: 0
  })
  let mirrorOpen = true
  cleanups.push(async () => { if (mirrorOpen) await mirror.close() })

  const origCompact = pub.store.storage?.compact
  let compactCalledDuringRechunk = false
  if (pub.store.storage && typeof origCompact === 'function') {
    pub.store.storage.compact = async () => {
      compactCalledDuringRechunk = true
      throw new Error('blob-rechunk must not block on DB-wide RocksDB compaction')
    }
  }
  const heldAbort = new AbortController()
  const unseededRangeUrl = pub.blobServer.getLink(randomBytes(32), { blob: { blockOffset: 0, blockLength: 4, byteOffset: 0, byteLength: 2097152 } })
  let heldSettled = false
  const heldFetch = fetch(unseededRangeUrl, { headers: { Range: 'bytes=0-524287' }, signal: heldAbort.signal }).then(() => { heldSettled = true }, () => { heldSettled = true })
  await until(() => pub.blobServer.connections.size >= 1, 5000, 'Range request reached the blob server')
  let mig
  try {
    mig = await mirror.run('blob-rechunk', { foreground: true })
    assert.equal(heldSettled, false, 'Range request stayed open throughout foreground rechunk')
  } finally {
    heldAbort.abort()
    await heldFetch
    if (pub.store.storage && typeof origCompact === 'function') pub.store.storage.compact = origCompact
  }
  assert.equal(compactCalledDuringRechunk, false, 'blob-rechunk returned immediately without waiting on DB-wide compaction')
  assert.equal(mig.total, 2, 'queued both shared-slot spans (variable-block AND shared uniform-block)')
  assert.equal(mig.migrated, 2)

  const postMig = await pub.search()
  const m1 = parseUri(postMig.find(e => e.id === 'imdb:tt0088763').magnetUrl).entry
  const m1Dup = parseUri(postMig.find(e => e.id === 'imdb:tt0088764').magnetUrl).entry
  const m2 = parseUri(postMig.find(e => e.id === 'imdb:tt0133093').magnetUrl).entry
  assert.notEqual(m1.blobs, slot0Key, 'variable-block entry split out of shared slot 0')
  assert.equal(m1.blob.blockLength, Math.ceil(legacyVarBytes.byteLength / 524288), 'migrated legacy entry uses exact 512 KiB piece count')
  assert.equal(m2.blob.blockLength, Math.ceil(legacySharedUniformBytes.byteLength / 524288), 'migrated uniform entry uses exact 512 KiB piece count')
  assert.notEqual(m2.blobs, slot0Key, 'uniform shared-slot entry split out of shared slot 0 into its own core')
  assert.notEqual(m1.blobs, m2.blobs, 'different videos received distinct per-video cores')
  assert.equal(m1.blobs, m1Dup.blobs, 'identical sha256:size entries deduplicated onto one per-video core')
  assert.equal(m1.blob.blockOffset, 0)
  assert.equal(m2.blob.blockOffset, 0)

  const repointedJobs = JSON.parse(readFileSync(jobsFile, 'utf8'))
  assert.equal(repointedJobs.find(j => j.id === 'imdb:tt0133093')?.announce?.blobs, m2.blobs, 'jobs.json announce repointed to dedicated per-video core')

  // Publish 68 more dedicated per-video clips so total seedable cores = 72 (1 channel + 71 video cores > old 64 cap)!
  const extraClips = []
  for (let i = 1; i <= 68; i++) {
    const clipBuf = randomBytes(4096 + i)
    const id = `clip:batchvideo${String(i).padStart(3, '0')}`
    const cp = await pub.publishChannel({ id, title: `Paginated Clip ${i}` }, Readable.from([clipBuf]))
    extraClips.push({ id, raw: clipBuf, blobs: cp.blobs })
  }
  assert.equal(pub.seedableCores().length, 72, 'catalog exposes all 72 cores (1 channel + 71 per-video cores > 64)')
  const lastClip = extraClips[extraClips.length - 1]

  // Paginated `hiverelay-seed` passes push all 72 cores across pages without exceeding the 20-msg burst cap!
  const expectedCores = [pub.status().channel, p2.blobs, m1.blobs, m2.blobs, ...extraClips.map(x => x.blobs)]
  assert.equal(new Set(expectedCores).size, 72, 'all 72 expected cores are strictly distinct')
  await until(async () => {
    await mirror.run('hiverelay-seed')
    return hrSmall.hasAllBlocks(expectedCores)
  }, 120_000, 'HiveRelay downloading all 72 paginated per-video cores')
  assert.ok(hrSmall.maxBurstSeen <= 20, `paced P2P requests stayed under 20-msg burst cap (saw ${hrSmall.maxBurstSeen})`)

  await mirror.close()
  mirrorOpen = false
  await pub.close()
  pubOpen = false

  const offViewer = await createNode({
    storage: tmp('off-viewer'),
    bootstrap: testnet.bootstrap,
    sources: [{ key: expectedCores[0], kind: 'channel', alias: 'Offline HiveRelay Feed' }]
  })
  cleanups.push(() => offViewer.close())

  await until(async () => (await offViewer.search()).length === 72, 90_000, 'offline viewer channel sync of all 72 entries from HiveRelay')
  for (const [id, raw] of [
    ['imdb:tt0068646', v2Bytes],
    ['imdb:tt0088763', legacyVarBytes],
    ['imdb:tt0088764', legacyVarBytes],
    ['imdb:tt0133093', legacySharedUniformBytes],
    [lastClip.id, lastClip.raw]
  ]) {
    const [hit] = await offViewer.search(id)
    const got = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
    assert.equal(sha256(got), sha256(raw), `offline viewer verified exact bytes for ${id} (including >64th paginated core) from HiveRelay`)
  }
  const artifactDir = join('desktop', 'target', 'e2e')
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, 'per-video-blobs-result.json'), JSON.stringify({
    test: 'per-video-blobs e2e',
    at: new Date().toISOString(),
    distinctCoresVerified: true,
    sharedReferencePurgeGuardVerified: true,
    finalReferencePurgeVerified: true,
    legacySlotSplitMigrated: mig.migrated,
    offlineHiveRelaySeededCores: expectedCores.length,
    maxBurstSeen: hrSmall.maxBurstSeen,
    offlineSha256Verified: true
  }, null, 2) + '\n')
})
