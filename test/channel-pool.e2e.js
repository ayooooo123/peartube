// 1,000-channel O(1) active Autobee pool + 50,000-video paged search + live rotation E2E suite.
// Runs under both Node (`node test/channel-pool.e2e.js`) and Bare (`./node_modules/.bin/bare test/channel-pool.e2e.js`),
// writing repeatable evidence to `desktop/target/e2e/channel-pool-result.json`.
import proc from 'node:process'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'streamx'
import b4a from 'b4a'

globalThis.process ??= proc
const { createNode } = await import('../src/index.js')
const { createApi } = await import('../src/http.js')

const isBare = typeof Bare !== 'undefined'
const sha256 = buf => createHash('sha256').update(buf).digest('hex')
const hexKey = tag => sha256(b4a.from(tag))
const check = (cond, msg) => { if (!cond) throw new Error(msg) }
const eq = (actual, expected, msg) => {
  if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`)
}

function getJson (url) {
  return new Promise((resolveReq, rejectReq) => {
    http.get(url, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.once('end', () => resolveReq({ status: res.statusCode, data: JSON.parse(b4a.toString(b4a.concat(chunks))) }))
      res.once('error', rejectReq)
    }).once('error', rejectReq)
  })
}

function getBytes (url, rangeHdr) {
  return new Promise((resolveReq, rejectReq) => {
    http.get(url, rangeHdr ? { headers: { range: rangeHdr } } : {}, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.once('end', () => resolveReq({ status: res.statusCode, body: b4a.concat(chunks) }))
      res.once('error', rejectReq)
    }).once('error', rejectReq)
  })
}

async function run () {
  const t0 = Date.now()
  const report = { runtime: isBare ? 'bare' : 'node', stages: {} }

  // Stage 1: 1,000 subscribed channels x 50 videos = 50,000 catalog items under an 8-channel worklet cap!
  {
    const dir = join(os.tmpdir(), `pt-1000ch-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const sources = []
    const channels = {}
    const channelCount = 1000
    const videosPerChannel = 50

    for (let c = 0; c < channelCount; c++) {
      const chKey = hexKey(`channel-seed-${c}`)
      sources.push({ key: chKey, kind: 'channel', alias: `Ch ${c}` })
      const entries = []
      for (let v = 0; v < videosPerChannel; v++) {
        const id = `imdb:tt${String(c * 100 + v + 1000000).padStart(7, '0')}`
        const blobs = hexKey(`blob-${c}-${v}`)
        const fileSha = hexKey(`sha-${c}-${v}`)
        const sub = `${id}/${chKey}/${blobs}:0`
        entries.push([sub, {
          type: 'announce',
          id,
          title: `Channel ${c} Episode ${v} 2026`,
          size: 104857600,
          sha256: fileSha,
          blobs,
          blob: { blockOffset: 0, blockLength: 200, byteOffset: 0, byteLength: 104857600 }
        }])
      }
      channels[chKey] = { syncedAt: 1700000000000 + c, entries, discovered: [], peers: [] }
    }
    writeFileSync(join(dir, 'catalog-cache.json'), JSON.stringify({ version: 1, channels }), { mode: 0o600 })

    const rssBefore = proc.memoryUsage?.().rss || 0
    const openStart = Date.now()
    const node = await createNode({
      storage: dir,
      sources,
      bootstrap: [{ host: '127.0.0.1', port: 1 }],
      worklet: true,
      maxActiveSources: 8
    })
    const bootMs = Date.now() - openStart
    const api = createApi({ node, acquirer: null })
    await new Promise(r => api.listen(0, '127.0.0.1', r))
    const apiPort = api.address().port

    try {
      eq(node.listSources().length, 1000, 'all 1,000 channels listed')
      eq(node.activeSourceCount(), 8, 'open Autobee instances collared at 8')
      eq(node.overlayTopicCount(), 8, 'joined swarm/LAN channel topics collared at 8')

      // Instant O(1) ID lookup on hibernated Channel #742 without waking its Autobee!
      const targetId = `imdb:tt${String(742 * 100 + 25 + 1000000).padStart(7, '0')}`
      const idStart = Date.now()
      const byIdHits = await node.search(targetId)
      const idSearchMs = Date.now() - idStart
      eq(byIdHits.length, 1, 'found exact entry in hibernated channel #742')
      eq(byIdHits[0].title, 'Channel 742 Episode 25 2026', 'exact title from hibernated channel #742')
      eq(node.activeSourceCount(), 8, 'active Autobees stayed at 8 after hibernated ID lookup')

      // Instant O(1) findEntry on hibernated Channel #999 without waking its Autobee!
      const ch999 = sources[999].key
      const ch999EntryKey = `channel:${ch999}/${channels[ch999].entries[49][0]}`
      const found999 = await node.findEntry(ch999EntryKey)
      eq(found999?.title, 'Channel 999 Episode 49 2026', 'findEntry hit hibernated channel #999 cache without waking Autobee')
      eq(node.activeSourceCount(), 8, 'active Autobees stayed at 8 after hibernated findEntry')

      // Paged + text-filtered query across all 50,000 entries over HTTP `/v1/entries`!
      const pagedStart = Date.now()
      const paged = await getJson(`http://127.0.0.1:${apiPort}/v1/entries?q=${encodeURIComponent('Channel 742')}&limit=20&offset=10`)
      const pagedMs = Date.now() - pagedStart
      eq(paged.status, 200, '/v1/entries paged status')
      eq(paged.data.results.length, 20, 'paged slice returned exact 20 entries')
      eq(paged.data.results[0].title, 'Channel 742 Episode 10 2026', 'paged offset=10 aligned')

      const rssAfter = proc.memoryUsage?.().rss || 0
      report.stages.thousandChannels = {
        ok: true,
        subscribedChannels: 1000,
        totalCatalogVideos: 50000,
        activeAutobees: node.activeSourceCount(),
        overlayTopics: node.overlayTopicCount(),
        bootMs,
        idSearchMs,
        paged50kQueryMs: pagedMs,
        rssDeltaMiB: rssAfter && rssBefore ? +((rssAfter - rssBefore) / 1048576).toFixed(1) : null
      }
    } finally {
      await new Promise(r => api.close(r))
      await node.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // Stage 2: 12 live P2P publisher channels vs 1 viewer with maxActiveSources=4 (on-demand wake, background rotation, and cold-restart cache survival)!
  {
    const baseDir = join(os.tmpdir(), `pt-rot-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(baseDir, { recursive: true })
    const pubs = []
    const clips = []
    const pipes = []
    let follower = null

    try {
      for (let i = 0; i < 12; i++) {
        const pDir = join(baseDir, `pub-${i}`)
        mkdirSync(pDir, { recursive: true })
        const p = await createNode({ storage: pDir, bootstrap: [{ host: '127.0.0.1', port: 1 }] })
        const buf = b4a.alloc(65536, (i + 1) * 11)
        await p.publish({ id: `imdb:tt99000${String(i).padStart(2, '0')}`, title: `Live Pub ${i} 2026` }, Readable.from([buf]))
        pubs.push(p)
        clips.push({ key: p.status().channel, buf, sha: sha256(buf) })
      }

      const vDir = join(baseDir, 'viewer')
      mkdirSync(vDir, { recursive: true })
      const viewer = await createNode({
        storage: vDir,
        sources: clips.map((c, i) => ({ key: c.key, kind: 'channel', alias: `Pub ${i}` })),
        bootstrap: [{ host: '127.0.0.1', port: 1 }],
        worklet: true,
        maxActiveSources: 4
      })

      eq(viewer.listSources().length, 12, 'viewer tracks all 12 live channels')
      eq(viewer.activeSourceCount(), 4, 'viewer collars active Autobees strictly at 4')
      eq(viewer.overlayTopicCount(), 4, 'viewer collars joined channel topics strictly at 4')

      // Connect replication streams from all 12 publishers into viewer's Corestore/wakeup multiplex!
      for (const p of pubs) {
        const s1 = p.channel.replicate(true)
        const s2 = viewer.channel.replicate(false)
        s1.on('error', () => {})
        s2.on('error', () => {})
        s1.pipe(s2).pipe(s1)
        pipes.push(s1, s2)
      }

      // Immediately focus initially-hibernated Channel #11 -> must wake into the 4-slot pool and stream exact bytes!
      const ch11Key = clips[11].key
      let ch11Entries = []
      const focusDeadline = Date.now() + 6000
      while (Date.now() < focusDeadline) {
        ch11Entries = await viewer.search(null, { source: ch11Key })
        check(viewer.activeSourceCount() <= 4, `pool exceeded 4 during focus: ${viewer.activeSourceCount()}`)
        if (ch11Entries.length === 1) break
        await new Promise(r => setTimeout(r, 100))
      }
      eq(ch11Entries.length, 1, 'hibernated channel #11 woke on demand and synced live')
      const streamed11 = await getBytes(ch11Entries[0].streamUrl, 'bytes=0-65535')
      eq(streamed11.status, 206, 'streamed 206 bytes from newly woken channel #11')
      eq(sha256(streamed11.body), clips[11].sha, 'channel #11 video bytes SHA-256 exact')

      // Let the background rotator sweep the remaining unhydrated channels while never exceeding 4 open Autobees!
      let syncedAll = []
      let maxObservedActive = viewer.activeSourceCount()
      const rotDeadline = Date.now() + 18000
      while (Date.now() < rotDeadline) {
        maxObservedActive = Math.max(maxObservedActive, viewer.activeSourceCount())
        check(maxObservedActive <= 4, `rotator exceeded active cap 4: ${maxObservedActive}`)
        syncedAll = await viewer.search()
        if (syncedAll.length === 12) break
        await new Promise(r => setTimeout(r, 400))
      }
      eq(syncedAll.length, 12, 'background rotator hydrated all 12 channels through 4-slot active pool')

      // Disconnect before an offline publisher changes its channel. A cold viewer must
      // keep its old catalog while catching up, then replace it with the newly applied view.
      for (const s of pipes) s.destroy()
      pipes.length = 0
      await viewer.close()
      const newBuf = b4a.alloc(65536, 93)
      await pubs[0].publish({ id: 'imdb:tt99130000', title: 'Late Channel Entry 2026' }, Readable.from([newBuf]))

      const coldViewer = await createNode({
        storage: vDir,
        sources: clips.map((c, i) => ({ key: c.key, kind: 'channel', alias: `Pub ${i}` })),
        bootstrap: [{ host: '127.0.0.1', port: 1 }],
        worklet: true,
        maxActiveSources: 4
      })
      const coldEntries = await coldViewer.search()
      eq(coldViewer.activeSourceCount(), 4, 'cold-reopened viewer stays collared at 4 active Autobees')
      eq(coldEntries.length, 12, 'all 12 channels restored immediately from the offline snapshot')
      const s1 = pubs[0].channel.replicate(true)
      const s2 = coldViewer.channel.replicate(false)
      s1.on('error', () => {})
      s2.on('error', () => {})
      s1.pipe(s2).pipe(s1)
      pipes.push(s1, s2)
      let late = []
      const catchupDeadline = Date.now() + 8000
      while (Date.now() < catchupDeadline) {
        late = await coldViewer.search('imdb:tt99130000', { source: clips[0].key })
        if (late.length === 1) break
        await new Promise(r => setTimeout(r, 100))
      }
      eq(late.length, 1, 'cached channel replaces offline snapshot after its view catches up')
      const lateBytes = await getBytes(late[0].streamUrl, 'bytes=0-65535')
      eq(lateBytes.status, 206, 'late channel entry streams after cache refresh')
      eq(sha256(lateBytes.body), sha256(newBuf), 'late channel entry serves exact bytes')
      for (const s of pipes) s.destroy()
      pipes.length = 0
      await pubs[0].close()
      pubs[0] = null
      follower = await createNode({
        storage: join(baseDir, 'follower'),
        sources: [{ key: clips[0].key, kind: 'channel' }],
        bootstrap: [{ host: '127.0.0.1', port: 1 }],
        worklet: true,
        maxActiveSources: 1
      })
      const f1 = coldViewer.channel.replicate(true)
      const f2 = follower.channel.replicate(false)
      f1.on('error', () => {})
      f2.on('error', () => {})
      f1.pipe(f2).pipe(f1)
      pipes.push(f1, f2)
      let followerHits = []
      const followerDeadline = Date.now() + 8000
      while (Date.now() < followerDeadline) {
        followerHits = await follower.search('imdb:tt99130000', { source: clips[0].key })
        if (followerHits.length === 1) break
        await new Promise(r => setTimeout(r, 100))
      }
      eq(followerHits.length, 1, 'fresh subscriber gets the publisher feed from another subscriber')
      await follower.close()
      follower = null
      for (const s of pipes) s.destroy()
      pipes.length = 0
      await coldViewer.close()
      for (const p of pubs) if (p) await p.close()
      pubs.length = 0

      report.stages.livePoolRotation = {
        ok: true,
        totalLiveChannels: 12,
        poolCap: 4,
        maxObservedActiveAutobees: maxObservedActive,
        coldRestartEntries: coldEntries.length,
        lateEntryAfterCatchup: late.length,
        followerViaFollower: followerHits.length
      }
    } finally {
      for (const s of pipes) s.destroy()
      await follower?.close().catch(() => {})
      for (const p of pubs) if (p) await p.close().catch(() => {})
      rmSync(baseDir, { recursive: true, force: true })
    }
  }

  // Stage 3: a phone's shape — one followed channel nobody focuses, and no search call at all.
  // The background rotator alone must fill the library and keep its view current; otherwise the
  // saved snapshot is all the app ever shows, stale blob keys included.
  {
    const baseDir = join(os.tmpdir(), `pt-phone-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const phoneDir = join(baseDir, 'phone')
    const cachePath = join(phoneDir, 'catalog-cache.json')
    const cachedText = () => { try { return readFileSync(cachePath, 'utf8') } catch { return '' } }
    const stageStart = Date.now()
    mkdirSync(baseDir, { recursive: true })
    let pub = null
    let phone = null
    let s1 = null
    let s2 = null
    try {
      pub = await createNode({ storage: join(baseDir, 'pub'), bootstrap: [{ host: '127.0.0.1', port: 1 }] })
      const firstBuf = b4a.alloc(65536, 31)
      await pub.publish({ id: 'imdb:tt99010001', title: 'Phone One 2026' }, Readable.from([firstBuf]))
      const key = pub.status().channel

      phone = await createNode({
        storage: phoneDir,
        sources: [{ key, kind: 'channel' }],
        bootstrap: [{ host: '127.0.0.1', port: 1 }],
        worklet: true,
        maxActiveSources: 8
      })
      s1 = pub.channel.replicate(true)
      s2 = phone.channel.replicate(false)
      s1.on('error', () => {})
      s2.on('error', () => {})
      s1.pipe(s2).pipe(s1)

      // Not one search call: only the rotator can put this in the saved library.
      let bornAt = 0
      const bornDeadline = Date.now() + 15000
      while (Date.now() < bornDeadline) {
        if (cachedText().includes('imdb:tt99010001')) { bornAt = Date.now(); break }
        await new Promise(r => setTimeout(r, 200))
      }
      check(bornAt > 0, 'the rotator put an unfocused channel into the saved library without a search')
      eq(phone.activeSourceCount(), 1, 'the phone keeps its one followed Autobee open')

      const secondBuf = b4a.alloc(65536, 32)
      await pub.publish({ id: 'imdb:tt99010002', title: 'Phone Two 2026' }, Readable.from([secondBuf]))
      let refreshMs = 0
      const refreshDeadline = Date.now() + 40000
      while (Date.now() < refreshDeadline) {
        if (cachedText().includes('imdb:tt99010002')) { refreshMs = Date.now() - bornAt; break }
        await new Promise(r => setTimeout(r, 250))
      }
      check(refreshMs > 0, 'a later announce reached the saved library with no search and no focus')

      const grown = await phone.search()
      eq(grown.length, 2, 'the refreshed library lists both announces')
      const late = grown.find(e => e.id === 'imdb:tt99010002')
      const lateBytes = await getBytes(late.streamUrl, 'bytes=0-65535')
      eq(lateBytes.status, 206, 'the later announce streams Range bytes')
      eq(sha256(lateBytes.body), sha256(secondBuf), 'the later announce serves exact bytes')

      report.stages.phoneBackgroundSync = {
        ok: true,
        firstSyncMs: bornAt - stageStart,
        refreshWithNoSearchMs: refreshMs,
        entries: grown.length,
        activeAutobees: phone.activeSourceCount()
      }
    } finally {
      s1?.destroy()
      s2?.destroy()
      await phone?.close().catch(() => {})
      await pub?.close().catch(() => {})
      rmSync(baseDir, { recursive: true, force: true })
    }
  }

  report.ok = true
  report.durationMs = Date.now() - t0
  const outPath = resolve('desktop/target/e2e/channel-pool-result.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}

run().then(
  () => { if (isBare) Bare.exit(0); else process.exit(0) },
  err => { console.error(err); if (isBare) Bare.exit(1); else process.exit(1) }
)
