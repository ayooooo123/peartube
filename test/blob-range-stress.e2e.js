// Adversarial HTTP Range, scrub-storm, paused-window, and mid-stream clearCache E2E stress suite.
// Runs cleanly under both Node (`node test/blob-range-stress.e2e.js`) and Bare (`./node_modules/.bin/bare test/blob-range-stress.e2e.js`),
// writing repeatable evidence to `desktop/target/e2e/blob-range-stress-result.json`.
import proc from 'node:process'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'streamx'
import Corestore from 'corestore'
import Hyperblobs from 'hyperblobs'
import b4a from 'b4a'

globalThis.process ??= proc
const { createBlobRangeServer } = await import('../src/blob-server.js')
const { createNode } = await import('../src/index.js')
const { createApi } = await import('../src/http.js')
const { generateMnemonic } = await import('../src/mnemonic.js')
const isBare = typeof Bare !== 'undefined'
const sha256 = buf => createHash('sha256').update(buf).digest('hex')
const check = (cond, msg) => { if (!cond) throw new Error(msg) }
const eq = (actual, expected, msg) => {
  if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`)
}

function getRange (url, rangeHdr) {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.get(url, rangeHdr ? { headers: { range: rangeHdr } } : {}, res => {
      const chunks = []
      res.on('data', ch => chunks.push(ch))
      res.once('end', () => resolveReq({ status: res.statusCode, headers: res.headers, body: b4a.concat(chunks) }))
      res.once('error', rejectReq)
    })
    req.once('error', rejectReq)
  })
}

async function run () {
  const startedAt = Date.now()
  const report = { runtime: isBare ? 'bare' : 'node', stages: {} }

  // Stage 1: Partial-last-block 512 KiB tail seeks, suffix/416 boundaries, paused window cap, and irregular variable-block legacy slices.
  {
    const d1 = join(os.tmpdir(), `pt-stress-s1a-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const d2 = join(os.tmpdir(), `pt-stress-s1b-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(d1, { recursive: true })
    mkdirSync(d2, { recursive: true })
    const writer = new Corestore(d1)
    const reader = new Corestore(d2)
    await writer.ready()
    await reader.ready()
    const s1 = writer.replicate(true)
    const s2 = reader.replicate(false)
    s1.on('error', () => {})
    s2.on('error', () => {})
    s1.pipe(s2).pipe(s1)

    try {
      // 3-block 512 KiB blob whose final block is 17 bytes (catches average-block-size tail-seek drift).
      const cTail = writer.get({ name: 'tail' })
      const bTail = new Hyperblobs(cTail)
      const tailBuf = b4a.alloc(2 * 524288 + 17)
      for (let i = 0; i < tailBuf.length; i++) tailBuf[i] = (i * 31 + 7) & 0xff
      const tailId = await bTail.put(tailBuf, { blockSize: 524288 })

      // Irregular variable-block shared slot `[7B, 130KB, 19B, 600KB, 3B]` at non-zero blockOffset + byteOffset.
      const cVar = writer.get({ name: 'var' })
      await cVar.append([b4a.alloc(999, 1), b4a.alloc(33, 2)])
      const prefixBytes = cVar.byteLength
      const varChunks = [b4a.alloc(7), b4a.alloc(130000), b4a.alloc(19), b4a.alloc(600000), b4a.alloc(3)]
      for (let c = 0; c < varChunks.length; c++) {
        for (let i = 0; i < varChunks[c].length; i++) varChunks[c][i] = (i * 17 + c) & 0xff
      }
      const varFull = b4a.concat(varChunks)
      await cVar.append(varChunks)
      const varBlob = { blockOffset: 2, blockLength: 5, byteOffset: prefixBytes, byteLength: varFull.length }

      // 32 MiB uniform blob (`512` x `64 KiB` blocks) to verify paused open sockets obey `windowBytes` (`4 MiB` = `64` blocks).
      const cWin = writer.get({ name: 'win' })
      const bWin = new Hyperblobs(cWin)
      const winId = await bWin.put(b4a.alloc(32 * 1024 * 1024, 0x42), { blockSize: 65536 })

      const srv = createBlobRangeServer(reader.session(), {
        host: '127.0.0.1',
        port: 0,
        token: null,
        windowBytes: 4 * 1024 * 1024
      })
      await srv.listen()
      const tailLink = srv.getLink(cTail.key, { blob: tailId })
      const varLink = srv.getLink(cVar.key, { blob: varBlob })
      const winLink = srv.getLink(cWin.key, { blob: winId })

      const rTail = await getRange(tailLink, 'bytes=1048576-1048592')
      eq(rTail.status, 206, 'partial-last-block tail status')
      eq(sha256(rTail.body), sha256(tailBuf.subarray(1048576, 1048593)), 'partial-last-block tail sha256')

      const rSuf = await getRange(tailLink, 'bytes=-17')
      eq(rSuf.status, 206, 'suffix range status')
      eq(sha256(rSuf.body), sha256(tailBuf.subarray(tailBuf.length - 17)), 'suffix range sha256')

      for (const bad of ['bytes=-0', 'bytes=1048593-1048600', 'bytes=500-100']) {
        const rBad = await getRange(tailLink, bad)
        eq(rBad.status, 416, `expected 416 for ${bad}`)
      }

      for (const p of ['/', '/?foo=bar', '/?key=notz32']) {
        const r404 = await getRange(`http://127.0.0.1:${srv.port}${p}`, null)
        eq(r404.status, 404, `expected 404 for ${p}`)
      }

      for (const [a, b] of [[0, 6], [6, 10], [7, 130025], [130007, 130026], [130026, varFull.length - 1], [0, varFull.length - 1]]) {
        const rv = await getRange(varLink, `bytes=${a}-${b}`)
        eq(rv.status, 206, `var slice ${a}-${b} status`)
        eq(sha256(rv.body), sha256(varFull.subarray(a, b + 1)), `var slice ${a}-${b} sha256`)
      }

      // Abort after 1st chunk -> zero zombie block downloads after socket close.
      await new Promise(resolveAbort => {
        const req = http.get(winLink, { headers: { range: 'bytes=0-' } }, res => {
          res.once('data', () => { req.destroy(); resolveAbort() })
        })
      })
      await new Promise(r => setTimeout(r, 120))
      const vWin = reader.get({ key: cWin.key, active: false })
      await vWin.ready()
      const blocksAt120ms = await vWin.count(0, vWin.length)
      await new Promise(r => setTimeout(r, 900))
      const blocksAt1020ms = await vWin.count(0, vWin.length)
      eq(blocksAt1020ms, blocksAt120ms, 'zero blocks downloaded after client aborts Range stream')

      // Paused open socket -> bounded to ~windowBytes instead of pulling all 512 blocks.
      await vWin.clear(0, vWin.length)
      let pausedReq = null
      await new Promise(resolvePause => {
        pausedReq = http.get(winLink, { headers: { range: 'bytes=0-' } }, res => {
          res.pause()
          resolvePause()
        })
      })
      await new Promise(r => setTimeout(r, 900))
      const whilePaused = await vWin.count(0, vWin.length)
      check(whilePaused > 0 && whilePaused <= 160, `paused window exceeded cap: ${whilePaused}/512`)
      await srv.abortStreams()
      pausedReq.destroy()
      await vWin.close()
      await srv.close()

      report.stages.boundariesAndWindow = {
        ok: true,
        abortedDeltaBlocks: blocksAt1020ms - blocksAt120ms,
        pausedWindowBlocks: whilePaused,
        totalWindowTestBlocks: 512
      }
    } finally {
      s1.destroy()
      s2.destroy()
      await reader.close().catch(() => {})
      await writer.close().catch(() => {})
      rmSync(d1, { recursive: true, force: true })
      rmSync(d2, { recursive: true, force: true })
    }
  }

  // Stage 2: Full PearTube publisher + worklet viewer, encrypted access pass, six concurrent viewers, 80-way scrub storm, and mid-stream clearCache race.
  {
    const d1 = join(os.tmpdir(), `pt-stress-n1-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const d2 = join(os.tmpdir(), `pt-stress-n2-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(d1, { recursive: true })
    mkdirSync(d2, { recursive: true })
    const pub = await createNode({ storage: d1, mnemonic: generateMnemonic(), bootstrap: [{ host: '127.0.0.1', port: 1 }] })
    const sub = await createNode({
      storage: d2,
      sources: [{ key: pub.status().channel, kind: 'channel' }],
      bootstrap: [{ host: '127.0.0.1', port: 1 }],
      worklet: true
    })

    const throttle = () => {
      const t = new Transform({ transform (d, cb) { setTimeout(() => cb(null, d), 12) } })
      t.on('error', () => {})
      return t
    }
    const c1 = pub.channel.replicate(true)
    const c2 = sub.channel.replicate(false)
    c1.on('error', () => {})
    c2.on('error', () => {})
    const t1 = throttle()
    const t2 = throttle()
    c1.pipe(t1).pipe(c2).pipe(t2).pipe(c1)

    const api = createApi({ node: sub, acquirer: null })
    await new Promise(r => api.listen(0, '127.0.0.1', r))
    const apiPort = api.address().port

    try {
      const video = b4a.alloc(16 * 1024 * 1024)
      for (let i = 0; i < video.length; i++) video[i] = (i * 13 + 3) & 0xff
      await pub.publish({ id: 'imdb:tt1234567', title: 'Public Stress 2026' }, Readable.from([video]))

      const pass = await pub.rotateEpoch()
      const privVideo = b4a.alloc(2 * 1024 * 1024, 0x77)
      await pub.publish({ id: 'imdb:tt7654321', title: 'Private Stress 2026', private: true }, Readable.from([privVideo]))

      const deadline = Date.now() + 5000
      let entries = []
      while (Date.now() < deadline) {
        entries = await sub.search()
        if (entries.length === 2) break
        await new Promise(r => setTimeout(r, 100))
      }
      eq(entries.length, 2, 'synced both public and private entries')
      const pubEntry = entries.find(e => e.id === 'imdb:tt1234567')
      const privLocked = entries.find(e => e.id === 'imdb:tt7654321')
      eq(privLocked.locked, true, 'private entry starts locked')
      eq((await getRange(privLocked.streamUrl, 'bytes=0-1023')).status, 404, 'locked private stream 404s')

      await sub.openUri(pass.accessUri)
      const privUnlocked = (await sub.search('imdb:tt7654321'))[0]
      eq(privUnlocked.locked, false, 'private entry unlocks after accessUri')
      const dec = await getRange(privUnlocked.streamUrl, 'bytes=0-65535')
      eq(dec.status, 206, 'unlocked private stream 206')
      eq(dec.body.length, 65536, 'unlocked private slice length')
      check(dec.body.every(b => b === 0x77), 'unlocked private slice decrypted cleanly')

      // Six overlapping browser-style viewers share one cold P2P source, each seeking through 2 MiB Range slices.
      const proxyUrl = `http://127.0.0.1:${apiPort}/v1/blob${new URL(pubEntry.streamUrl).search}`
      let peakStreams = 0
      const sample = setInterval(() => { peakStreams = Math.max(peakStreams, sub.blobServer.activeStreams) }, 5)
      try {
        await Promise.all(Array.from({ length: 6 }, async (_, viewer) => {
          for (let part = 0; part < 4; part++) {
            const start = ((viewer + part) % 8) * 2 * 1024 * 1024
            const url = viewer % 2 ? pubEntry.streamUrl : proxyUrl
            const got = await getRange(url, `bytes=${start}-${start + 2 * 1024 * 1024 - 1}`)
            eq(got.status, 206, `viewer ${viewer} part ${part} Range status`)
            eq(sha256(got.body), sha256(video.subarray(start, start + 2 * 1024 * 1024)), `viewer ${viewer} part ${part} bytes`)
          }
        }))
      } finally {
        clearInterval(sample)
      }
      check(peakStreams >= 2, `overlapping playback did not overlap: ${peakStreams}`)
      eq(sub.blobServer.activeStreams, 0, 'all six playback sessions released their streams')
      report.stages.concurrentPlayback = { ok: true, viewers: 6, rangesPerViewer: 4, peakStreams }

      const storm = []
      for (let i = 0; i < 80; i++) {
        const u = i % 3 === 0 ? pubEntry.streamUrl : (i % 3 === 1 ? proxyUrl : `${proxyUrl}&download=Movie`)
        const off = (i % 16) * 524288
        const abortMs = (i % 6) * 7
        storm.push(new Promise(resolveItem => {
          const req = http.get(u, { headers: { connection: 'close', range: `bytes=${off}-` } }, res => {
            res.on('data', () => { if (abortMs >= 14) req.destroy() })
            res.once('close', resolveItem)
            res.once('end', resolveItem)
            res.once('error', resolveItem)
          })
          req.on('error', resolveItem)
          setTimeout(() => { req.destroy(); resolveItem() }, abortMs)
        }))
      }
      await Promise.all(storm)
      await new Promise(r => setTimeout(r, 250))
      eq(sub.blobServer.activeStreams, 0, '0 leaked active ByteStreams after 80-way scrub storm')

      // Mid-stream clearCache(null) while paused direct + active /v1/blob readers have wire blocks in flight!
      const pausedDirect = http.get(pubEntry.streamUrl, { headers: { range: 'bytes=0-' } }, res => res.pause())
      pausedDirect.on('error', () => {})
      const midOutcome = await new Promise(resolveMid => {
        const req = http.get(proxyUrl, { headers: { range: 'bytes=0-' } }, res => {
          res.once('data', () => {
            setTimeout(() => { sub.clearCache(null).catch(() => {}) }, 15)
          })
          res.on('data', () => {})
          res.once('close', () => resolveMid('CLOSED_CLEAN'))
          res.once('end', () => resolveMid('ENDED'))
          res.once('error', () => resolveMid('ERR_CLEAN'))
        })
        req.setTimeout(3000, () => { req.destroy(); resolveMid('HUNG') })
        req.on('error', () => resolveMid('REQ_ERR_CLEAN'))
      })
      pausedDirect.destroy()
      check(midOutcome !== 'HUNG', '/v1/blob hung during mid-stream clearCache')
      await new Promise(r => setTimeout(r, 700))
      const afterClearBytes = sub.status().cachedBytes
      eq(afterClearBytes, 0, 'cachedBytes stays 0 after mid-stream clearCache wire-inflight race')
      eq(sub.blobServer.activeStreams, 0, '0 active streams after clearCache')

      report.stages.fullNodeStormAndClear = {
        ok: true,
        scrubRequests: 80,
        activeStreamsAfterStorm: sub.blobServer.activeStreams,
        midStreamClearOutcome: midOutcome,
        cachedBytes700msAfterClear: afterClearBytes
      }
    } finally {
      c1.destroy()
      c2.destroy()
      t1.destroy()
      t2.destroy()
      await new Promise(r => api.close(r))
      await sub.close().catch(() => {})
      await pub.close().catch(() => {})
      rmSync(d1, { recursive: true, force: true })
      rmSync(d2, { recursive: true, force: true })
    }
  }

  report.ok = true
  report.durationMs = Date.now() - startedAt
  const outPath = resolve('desktop/target/e2e/blob-range-stress-result.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}

run().then(
  () => { if (isBare) Bare.exit(0); else process.exit(0) },
  err => { console.error(err); if (isBare) Bare.exit(1); else process.exit(1) }
)
