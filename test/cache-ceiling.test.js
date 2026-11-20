// The playback cache had no ceiling: one 102 GB remux accumulated 40 GB of
// blocks on a 97 %-full disk, because `clearCache` was only reachable by hand
// and the receiver's low-disk wipe never fires on a client. This pins the
// budget: eviction goes oldest-served first, the film being played is never a
// victim, `0` means unlimited, and the bulk clear shares the same body.
//
// The two nodes are wired with a direct store pipe instead of a channel sync:
// the ceiling is about the local ledger, and a DHT hop only adds flake.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'

const MiB = 1024 * 1024
// Per-video cores use 512 KiB pieces, so 1.5 MiB is three whole blocks and the
// byte estimate has no tail-block ambiguity.
const VIDEO_BYTES = 1536 * 1024
const tmp = label => mkdtempSync(join(tmpdir(), `peartube-cache-${label}-`))

test('cache ceiling evicts oldest-served, spares the playing film, and 0 is unlimited', { timeout: 180_000 }, async () => {
  const testnet = await createTestnet(3)
  const pub = await createNode({ storage: tmp('pub'), bootstrap: testnet.bootstrap })
  let viewer = null
  try {
    const hexes = []
    for (let i = 0; i < 3; i++) {
      const announced = await pub.put({ id: `imdb:tt910000${i + 1}`, title: `Cache Ceiling ${i + 1}` }, Readable.from([randomBytes(VIDEO_BYTES)]))
      hexes.push(announced.blobs)
    }

    viewer = await createNode({ storage: tmp('viewer'), bootstrap: testnet.bootstrap })
    const upstream = pub.store.replicate(true, { keepAlive: false })
    const downstream = viewer.store.replicate(false, { keepAlive: false })
    upstream.pipe(downstream).pipe(upstream)

    const fill = async hex => {
      const core = await viewer.blobCore(hex)
      await core.update({ wait: true })
      await core.download({ start: 0, end: core.length }).done()
      return core
    }
    const blocksOf = async hex => {
      const core = await viewer.blobCore(hex)
      await core.ready()
      return core.count(0, core.length)
    }

    // Serve every film in order: this is the node's only recency signal.
    for (const hex of hexes) await fill(hex)
    const filled = viewer.status().cachedBytes
    assert.ok(filled >= VIDEO_BYTES * 3 - MiB, `three films cached (${filled})`)

    // Budget of four MiB against four and a half: only the coldest goes.
    viewer.setCacheMaxBytes(4 * MiB)
    assert.equal(viewer.status().cacheMaxBytes, 4 * MiB, 'status reports the budget')
    await viewer.enforceCacheCeiling()

    const [victim, survivor, newest] = hexes
    const afterBudget = viewer.status().cachedBytes
    assert.ok(afterBudget <= 3.6 * MiB, `down to 90 % of the budget (${afterBudget})`)
    assert.equal(await blocksOf(victim), 0, 'oldest-served film was evicted')
    assert.ok(await blocksOf(survivor) > 0, 'next-oldest survived')
    assert.ok(await blocksOf(newest) > 0, 'newest survived')

    // The film being played is never a victim, even under a tiny budget.
    const beforePlaying = await blocksOf(survivor)
    viewer.setCacheMaxBytes(1 * MiB)
    await viewer.enforceCacheCeiling({ keepHex: survivor })
    assert.equal(await blocksOf(survivor), beforePlaying, 'the playing film kept every block')

    // A kept copy (16 MiB = 32 blocks, so clearTo = 16 > headGuard 8) neither counts toward cachedBytes nor gets trimmed.
    const bigAnnounced = await pub.put({ id: 'imdb:tt9100099', title: 'Kept Film' }, Readable.from([randomBytes(16 * MiB)]))
    const keptHex = bigAnnounced.blobs
    await fill(keptHex)
    const keptBlocks = await blocksOf(keptHex)
    assert.equal(keptBlocks, 32, 'kept film has 32 blocks (clearTo 16 > headGuard 8)')
    viewer.keepCopy(keptHex, true)
    assert.equal(viewer.status().cachedBytes, VIDEO_BYTES, 'kept copy does not count toward cache budget')
    await viewer.evictBehind(keptHex, { blockOffset: 0, blockLength: keptBlocks, byteLength: 16 * MiB }, { playheadByte: 16 * MiB, keepBehindBytes: 0 })
    assert.equal(await blocksOf(keptHex), keptBlocks, 'evictBehind never trims blocks of a kept copy')
    // Put `survivor` over a 512 KiB budget so `total > target` holds, then pass `keepHex: keptHex` to exercise `!kept.has(playing)`.
    viewer.setCacheMaxBytes(512 * 1024)
    await viewer.enforceCacheCeiling({ keepHex: keptHex })
    assert.equal(await blocksOf(keptHex), keptBlocks, 'enforceCacheCeiling never trims a playing kept copy')
    viewer.setCacheMaxBytes(0)
    await fill(survivor)
    const beforeUnlimited = viewer.status().cachedBytes
    await viewer.enforceCacheCeiling()
    assert.equal(viewer.status().cachedBytes, beforeUnlimited, 'unlimited budget evicts nothing')

    // The bulk clear now shares the ceiling's per-hex body and spares kept copies until un-kept.
    const cleared = await viewer.clearCache()
    assert.ok(cleared.clearedBytes > 0, 'bulk clear evicts through the shared body')
    assert.equal(viewer.status().cachedBytes, 0, 'nothing cached after a full clear')
    assert.equal(await blocksOf(keptHex), keptBlocks, 'kept copy survives clearCache()')
    viewer.keepCopy(keptHex, false)
    await viewer.clearCache()
    assert.equal(await blocksOf(keptHex), 0, 'once un-kept, clearCache() clears it')
  } finally {
    if (viewer) await viewer.close().catch(() => {})
    await pub.close().catch(() => {})
    await testnet.destroy()
  }
})
