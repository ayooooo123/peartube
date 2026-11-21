// End-to-end verification of the Soulseek provider plugin on a real Bare relay (`bin/relay.js`):
//   1. Unconfigured plugin is inert (`status: 'not configured'`), dials nothing, and refuses search/mirror cleanly.
//   2. Missing addon prebuild reports `status: 'unavailable'` lazily without crashing the relay process.
//   3. Search against a loopback Soulseek server + peers normalises candidates, ranks `slots && queue === 0` first,
//      then ascending `queue`, then bit depth/sample rate, and enforces `SOULSEEK_SEARCH_CAP`.
//   4. Mirror downloads tracks into `<storage>/staging/<Artist> - <Album> (<Year>)/` one level deep, reports progress
//      through `/v1/jobs`, stores peer bytes unmodified, announces the peer's own release tag when the caller names no
//      album, and pins the folder to a caller-supplied release id (which wins over the peer's tags).
//   5. Credentials (`slskUser`, `slskPass`) never appear in `/v1/plugins`, `/v1/settings`, `/v1/jobs`, `/v1/entries`,
//      or stdout/stderr logs.
// Writes `desktop/target/e2e/soulseek-plugin-result.json`.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import createTestnet from 'hyperdht/testnet.js'
import { albumKey, parseTags } from '../src/tags.js'
import { SOULSEEK_SEARCH_CAP, createSoulseekPlugin, normalizeSoulseekCandidates, placeSingleTrack } from '../src/providers/soulseek.js'
import { removeEntries } from '../src/http.js'

test('a lone track is placed in its album folder as NN - Title, or refused with the reason', () => {
  const tagged = placeSingleTrack({ tags: { album: 'Giant Steps', albumArtist: 'John Coltrane', title: 'Naima', year: 1960, track: 6 }, filename: '@@m\\x\\y\\zz.flac' })
  assert.equal(tagged.folder, 'John Coltrane - Giant Steps (1960)')
  assert.equal(tagged.file, '06 - Naima.flac')
  assert.equal(tagged.from, 'tags')
  assert.equal(tagged.release, `album:${createHash('sha256').update(albumKey({ albumArtist: 'John Coltrane', album: 'Giant Steps', year: 1960 })).digest('hex').slice(0, 20)}`)
  // A disc folder is a disc of the album above it; a year-first folder names its album after the year.
  const disc = placeSingleTrack({ tags: null, filename: '@@m\\Bill Evans - Sunday at the Village Vanguard (1961)\\CD2\\04. Jade Visions.flac' })
  assert.deepEqual([disc.folder, disc.file, disc.from], ['Bill Evans - Sunday at the Village Vanguard (1961)', '04 - Jade Visions.flac', 'peer folder'])
  const yearFirst = placeSingleTrack({ tags: null, filename: '@@m\\John Coltrane\\1958 - Blue Train\\02 Moment\'s Notice.mp3' })
  assert.deepEqual([yearFirst.folder, yearFirst.file], ['John Coltrane - Blue Train (1958)', '02 - Moment\'s Notice.mp3'])
  // A caller that names the track gives a number to a file with none; a release id alone still gets its own folder.
  const named = placeSingleTrack({ tags: null, filename: '@@m\\Mix\\tune.flac', release: 'mb:0123456789abcdef0123456789abcdef', track: 9 })
  assert.deepEqual([named.file, named.release, named.from], ['09 - tune.flac', 'mb:0123456789abcdef0123456789abcdef', 'release'])
  assert.match(placeSingleTrack({ tags: null, filename: '@@share\\untitled.flac' }).error, /no album tag/)
  assert.match(placeSingleTrack({ tags: { album: 'A', artist: 'B' }, filename: '@@m\\B - A\\intro.flac' }).error, /track number/)
})

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifact = join(root, 'desktop/target/e2e/soulseek-plugin-result.json')
const results = { startedAt: new Date().toISOString(), checks: {} }
const sleep = ms => new Promise(r => setTimeout(r, ms))

after(() => {
  mkdirSync(join(root, 'desktop/target/e2e'), { recursive: true })
  writeFileSync(artifact, JSON.stringify({ ...results, finishedAt: new Date().toISOString() }, null, 2) + '\n')
})

function u32le (n) {
  const b = Buffer.allocUnsafe(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

function u64le (n) {
  const b = Buffer.allocUnsafe(8)
  b.writeBigUInt64LE(BigInt(n), 0)
  return b
}

function packStr (s) {
  const raw = Buffer.from(s, 'utf8')
  return Buffer.concat([u32le(raw.byteLength), raw])
}

function frameU32 (code, parts) {
  const body = Buffer.concat([u32le(code), ...parts])
  return Buffer.concat([u32le(body.byteLength), body])
}

function frameU8 (code, parts) {
  const body = Buffer.concat([Buffer.from([code]), ...parts])
  return Buffer.concat([u32le(body.byteLength), body])
}

function freePort () {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolvePort(port))
    })
  })
}

function listenLoopback (srv) {
  return new Promise((resolvePort, reject) => {
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => resolvePort(srv.address().port))
  })
}

function buildFlac (tags, audioBytes = 96 * 1024) {
  const enc = s => Buffer.from(s, 'utf8')
  const vendor = enc('peartube-slsk-stub')
  const entries = Object.entries(tags).map(([k, v]) => enc(`${k}=${v}`))
  const parts = [u32le(vendor.length), vendor, u32le(entries.length)]
  for (const e of entries) parts.push(u32le(e.length), e)
  const comment = Buffer.concat(parts)
  const header = Buffer.from([0x84, (comment.length >> 16) & 0xff, (comment.length >> 8) & 0xff, comment.length & 0xff])
  const payload = Buffer.alloc(audioBytes)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff
  return Buffer.concat([enc('fLaC'), header, comment, payload])
}

async function startStubSoulseekNetwork ({ filesByPeer, searchPeers }) {
  const sockets = new Set()
  const stats = { connections: 0, logins: 0, searches: 0, downloads: 0 }
  let clientListenPort = 0
  let nextTransferToken = 900_100

  const peerServers = new Map()
  for (const [peerName, fileMap] of Object.entries(filesByPeer)) {
    const peerSrv = createServer(sock => {
      sockets.add(sock)
      sock.on('close', () => sockets.delete(sock))
      let buf = Buffer.alloc(0)
      let seenInit = false
      let pendingToken = 0
      let pendingBytes = null
      sock.on('data', chunk => {
        buf = Buffer.concat([buf, chunk])
        while (buf.length >= 4) {
          const len = buf.readUInt32LE(0)
          if (buf.length < 4 + len) break
          const payload = buf.subarray(4, 4 + len)
          buf = buf.subarray(4 + len)
          if (!seenInit) {
            seenInit = true
            continue
          }
          const code = payload.readUInt32LE(0)
          if (code === 43) {
            const fnLen = payload.readUInt32LE(4)
            const filename = payload.subarray(8, 8 + fnLen).toString('utf8')
            const fileBytes = fileMap[filename]
            if (!fileBytes) continue
            stats.downloads++
            pendingToken = ++nextTransferToken
            pendingBytes = fileBytes
            sock.write(frameU32(44, [packStr(filename), u32le(1)]))
            sock.write(frameU32(40, [
              u32le(1),
              u32le(pendingToken),
              packStr(filename),
              u64le(fileBytes.length)
            ]))
          } else if (code === 41) {
            const tok = payload.readUInt32LE(4)
            const allowed = payload[8]
            if (tok !== pendingToken || allowed !== 1 || !pendingBytes) continue
            const bytesToSend = pendingBytes
            const fSock = createServer().unref() // unused dummy; dial outbound F socket to clientListenPort
            void fSock
            import('node:net').then(({ connect }) => {
              const out = connect(clientListenPort, '127.0.0.1', () => {
                sockets.add(out)
                out.on('close', () => sockets.delete(out))
                out.write(frameU8(1, [packStr(peerName), packStr('F'), u32le(0)]))
                out.write(u32le(tok))
              })
              let fBuf = Buffer.alloc(0)
              out.on('data', d => {
                fBuf = Buffer.concat([fBuf, d])
                if (fBuf.length >= 8) {
                  const offset = Number(fBuf.readBigUInt64LE(0))
                  const rest = bytesToSend.subarray(offset)
                  const mid = Math.floor(rest.length / 2)
                  out.write(rest.subarray(0, mid))
                  setTimeout(() => {
                    if (!out.destroyed) out.write(rest.subarray(mid))
                  }, 15)
                }
              })
            })
          }
        }
      })
    })
    const port = await listenLoopback(peerSrv)
    peerServers.set(peerName, { srv: peerSrv, port })
  }

  const central = createServer(sock => {
    stats.connections++
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    let buf = Buffer.alloc(0)
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0)
        if (buf.length < 4 + len) break
        const payload = buf.subarray(4, 4 + len)
        buf = buf.subarray(4 + len)
        const code = payload.readUInt32LE(0)
        if (code === 1) {
          stats.logins++
          sock.write(frameU32(1, [
            Buffer.from([1]),
            packStr('Welcome'),
            Buffer.from([1, 0, 0, 127]),
            packStr('0123456789abcdef0123456789abcdef'),
            Buffer.from([1])
          ]))
        } else if (code === 2) {
          clientListenPort = payload.readUInt32LE(4)
        } else if (code === 92) {
          sock.write(frameU32(92, [u32le(3600)]))
        } else if (code === 3) {
          const uLen = payload.readUInt32LE(4)
          const uname = payload.subarray(8, 8 + uLen).toString('utf8')
          const pPort = peerServers.get(uname)?.port || 0
          const obf = Buffer.alloc(2)
          sock.write(frameU32(3, [
            packStr(uname),
            Buffer.from([1, 0, 0, 127]),
            u32le(pPort),
            u32le(0),
            obf
          ]))
        } else if (code === 26) {
          stats.searches++
          const searchTok = payload.readUInt32LE(4)
          import('node:net').then(({ connect }) => {
            for (const peer of searchPeers) {
              const p = connect(clientListenPort, '127.0.0.1', () => {
                sockets.add(p)
                p.on('close', () => sockets.delete(p))
                p.write(frameU8(1, [packStr(peer.username), packStr('P'), u32le(0)]))
                const fileEntries = peer.files.map(f => {
                  const attrs = []
                  if (f.bitrate != null) attrs.push([0, f.bitrate])
                  if (f.length != null) attrs.push([1, f.length])
                  if (f.sample_rate != null) attrs.push([4, f.sample_rate])
                  if (f.bit_depth != null) attrs.push([5, f.bit_depth])
                  const attrBufs = [u32le(attrs.length)]
                  for (const [k, v] of attrs) attrBufs.push(u32le(k), u32le(v))
                  return Buffer.concat([
                    Buffer.from([1]),
                    packStr(f.filename),
                    u64le(f.size),
                    packStr('flac'),
                    ...attrBufs
                  ])
                })
                const rawSearch = Buffer.concat([
                  packStr(peer.username),
                  u32le(searchTok),
                  u32le(fileEntries.length),
                  ...fileEntries,
                  Buffer.from([peer.slots ? 1 : 0]),
                  u32le(peer.speed || 2_000_000),
                  u32le(peer.queue || 0),
                  u32le(0)
                ])
                p.write(frameU32(9, [deflateSync(rawSearch)]))
                p.end()
              })
            }
          })
        }
      }
    })
  })
  const port = await listenLoopback(central)

  return {
    port,
    stats,
    async close () {
      for (const s of sockets) s.destroy()
      for (const { srv } of peerServers.values()) srv.close()
      central.close()
    }
  }
}

test('ranking, search cap, release-id precedence, and graceful unavailable addon fallback', async () => {
  // 1. Candidate ranking and cap enforcement
  const noisy = Array.from({ length: SOULSEEK_SEARCH_CAP + 35 }, (_, i) => ({
    username: `peer_${i}`,
    slots: false,
    queue: 50 + i,
    filename: `@@music\\Lossy\\${String(i + 1).padStart(3, '0')}.mp3`,
    size: 5_000_000,
    bitrate: 320,
    sample_rate: 44100,
    bit_depth: -1,
    length_secs: 200
  }))
  const ranked = normalizeSoulseekCandidates([
    ...noisy,
    { username: 'queued_hires', slots: true, queue: 4, filename: '@@flac\\Album\\01.flac', size: 40_000_000, bitrate: 2304, sample_rate: 96000, bit_depth: 24, length_secs: 240 },
    { username: 'free_cd', slots: true, queue: 0, filename: '@@flac\\Album\\01.flac', size: 25_000_000, bitrate: 1411, sample_rate: 44100, bit_depth: 16, length_secs: 240 },
    { username: 'free_hires', slots: true, queue: 0, filename: '@@flac\\Album\\01.flac', size: 45_000_000, bitrate: 2304, sample_rate: 96000, bit_depth: 24, length_secs: 240 },
    { username: 'queued_smaller', slots: false, queue: 2, filename: '@@flac\\Album\\01.flac', size: 25_000_000, bitrate: 1411, sample_rate: 44100, bit_depth: 16, length_secs: 240 }
  ])
  assert.equal(ranked.length, SOULSEEK_SEARCH_CAP, `search results capped at ${SOULSEEK_SEARCH_CAP}`)
  assert.equal(ranked[0].username, 'free_hires', 'slots && queue===0 with higher depth/rate ranks #1')
  assert.equal(ranked[1].username, 'free_cd', 'slots && queue===0 with 16/44.1 ranks #2')
  assert.equal(ranked[2].username, 'queued_smaller', 'smaller queue (2) ranks ahead of deeper queue (4)')
  assert.equal(ranked[3].username, 'queued_hires', 'queue 4 follows queue 2')
  assert.deepEqual(Object.keys(ranked[0]), ['username', 'slots', 'queue', 'filename', 'size', 'bitrate', 'sample_rate', 'bit_depth', 'length'])
  results.checks.rankingAndCap = { cap: SOULSEEK_SEARCH_CAP, top4: ranked.slice(0, 4).map(r => r.username) }

  // 2. Missing addon prebuild reports `unavailable` lazily without throwing at plugin creation
  const tmp = mkdtempSync(join(tmpdir(), 'slsk-unavail-'))
  try {
    const plug = createSoulseekPlugin({
      storage: tmp,
      slskUser: 'alice',
      slskPass: 'secret',
      loadAddon: async () => { throw new Error('No prebuild found for platform') }
    })
    await sleep(30)
    assert.equal(plug.info().status, 'unavailable')
    assert.equal(plug.info().available, false)
    await assert.rejects(() => plug.search({ query: 'coltrane' }), /unavailable/)
    await plug.stop()
    results.checks.unavailableGraceful = true
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  // 3. A release id wins whatever order the tags are stored in; a release-group id is never taken as a release id.
  const both = parseTags(buildFlac({ MUSICBRAINZ_RELEASEGROUPID: '8d18c070-adea-353f-a089-cbd2543342dd', MUSICBRAINZ_ALBUMID: 'd10b1dbb-ebdc-3f66-b8f8-5685fd5ba5d5', TRACKNUMBER: '2' }, 64))
  assert.equal(both.mbid, 'd10b1dbbebdc3f66b8f85685fd5ba5d5')
  const groupOnly = parseTags(buildFlac({ MUSICBRAINZ_RELEASEGROUPID: '8d18c070-adea-353f-a089-cbd2543342dd', TRACKNUMBER: '2' }, 64))
  assert.equal(groupOnly.mbid, null)
  results.checks.releaseOutranksGroup = true
})

// A stand-in for the native addon: browse returns a share list, and download behaves like a peer that never answers
// (no queue place, no bytes), a peer that answers and then sends, or a firewalled pair the server cannot bridge.
function fakeAddon (calls) {
  class Soulseek {
    constructor (opts) { calls.created.push(opts) }
    state () { return { connected: true, logged_in: true, listen_port: 50300 } }
    async login () { return { logged_in: true } }
    async search () { return [] }
    async browse (user) {
      calls.browse++
      await sleep(20)
      if (user === 'ghost') throw new Error('browse ghost timed out')
      // A vinyl rip: files named by side and place, no number of their own, no track tag.
      if (user === 'vinyl') {
        return ['B1 Five', 'A10 Four', 'A2 Two', 'A3 Three', 'A1 One'].map(n => ({ username: user, slots: true, queue: 0, filename: `@@v\\Artist - Record (2005)\\${n}.flac`, size: 100 }))
      }
      return [
        { username: user, slots: true, queue: 0, filename: '@@m\\Artist\\Album (2001)\\02 - Two.flac', size: 200, bitrate: 900, sample_rate: 96000, bit_depth: 24, length_secs: 61 },
        { username: user, slots: true, queue: 0, filename: '@@m\\Artist\\Album (2001)\\01 - One.flac', size: 100, bitrate: 900, sample_rate: 96000, bit_depth: 24, length_secs: 60 },
        { username: user, slots: true, queue: 0, filename: '@@m\\Artist\\Album (2001)\\cover.jpg', size: 50 }
      ]
    }
    download (user, filename, dest, onProgress) {
      onProgress({ phase: 'queued', bytes: 0, total: 100, speed: 0, queue: null })
      if (user === 'silent') return new Promise(() => {})
      if (user === 'walled') return Promise.reject(new Error('disconnected: peer could not establish indirect connection'))
      return (async () => {
        await sleep(10)
        onProgress({ phase: 'queued', bytes: 0, total: 100, speed: 0, queue: 3 })
        await sleep(10)
        onProgress({ phase: 'transferring', bytes: 50, total: 100, speed: 5000, queue: null })
        await sleep(40)
        writeFileSync(dest, buildFlac(user === 'vinyl' ? { ALBUM: 'Record', ARTIST: 'Artist', DATE: '2005' } : { TRACKNUMBER: '1', ALBUM: 'Album', ARTIST: 'Artist' }, 100))
        return { path: dest, size: statSync(dest).size }
      })()
    }
    close () {}
  }
  return { Soulseek }
}

test('browse cache, listen port, and legible queued/transferring/failed jobs (fake addon)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'slsk-fake-'))
  const calls = { created: [], browse: 0 }
  const plug = createSoulseekPlugin({
    storage: tmp,
    slskUser: 'alice',
    slskPass: 'secret',
    slskListenPort: 50300,
    noAnswerMs: 300,
    loadAddon: async () => fakeAddon(calls)
  })
  // The job watchdog is unref'd so a stuck download never holds a relay open, and the fake silent peer holds no socket.
  // A relay always has other handles; this test has none, so Node 22 ends the event loop and cancels the test before
  // the watchdog fires. Hold the loop open for the test's length, as a real peer connection would.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const first = await plug.browse({ username: 'bob' })
    assert.deepEqual(calls.created, [{ listenPort: 50300 }], 'the configured listen port reaches the addon')
    assert.equal(first.tracks, 2, 'browse keeps media files only')
    assert.equal(first.size, 300)
    assert.equal(first.cached, false)
    assert.deepEqual(first.files.map(f => f.filename.split('\\').pop()), ['01 - One.flac', '02 - Two.flac'], 'files ordered by path')
    assert.deepEqual(Object.keys(first.files[0]), ['username', 'slots', 'queue', 'filename', 'size', 'bitrate', 'sample_rate', 'bit_depth', 'length'])
    const again = await plug.browse({ username: 'bob' })
    assert.equal(again.cached, true)
    assert.equal(calls.browse, 1, 'a second browse within the TTL is served from memory')
    await assert.rejects(() => plug.browse({ username: 'ghost' }), /ghost did not answer.*port 50300/)
    assert.equal(plug.info().listenPort, 50300)
    assert.equal(plug.info().inboundFailures, 1)

    const seen = []
    const ok = await plug.mirror({ username: 'bob', files: [{ filename: '@@m\\Artist\\Album (2001)\\01 - One.flac', size: 100 }] })
    for (let i = 0; i < 100 && plug.getJob(ok.job.jobId).status !== 'done'; i++) {
      const s = plug.getJob(ok.job.jobId)
      if (seen.at(-1) !== s.status) seen.push(s.status)
      await sleep(2)
    }
    seen.push(plug.getJob(ok.job.jobId).status)
    assert.equal(seen[0], 'queued')
    assert.ok(seen.includes('transferring'), `job reports transferring: ${seen}`)
    assert.equal(seen.at(-1), 'done')
    assert.equal(plug.getJob(ok.job.jobId).peer, 'bob')

    await assert.rejects(() => plug.mirror({ username: 'silent', files: ['@@m\\A\\B\\01.flac'], wait: true }), /silent never answered.*port 50300/)
    const silentJob = plug.listJobs().find(j => j.peer === 'silent')
    assert.equal(silentJob.status, 'failed')
    assert.equal(silentJob.bytes, 0)
    await assert.rejects(() => plug.mirror({ username: 'walled', files: ['@@m\\A\\B\\01.flac'], wait: true }), /behind a firewall.*port 50300/)
    assert.equal(plug.info().inboundFailures, 3)

    // A vinyl side name ("B1") gives no number; its place in the peer's folder does (A1 A2 A3 A10 B1 -> 5).
    const vinyl = await plug.mirror({ username: 'vinyl', files: [{ filename: '@@v\\Artist - Record (2005)\\B1 Five.flac', size: 100 }], wait: true })
    assert.equal(vinyl.folder, 'Artist - Record (2005)')
    assert.equal(vinyl.placed.file, '05 - Five.flac')
    results.checks.browseAndLegibleJobs = { transitions: seen, silent: silentJob.error }
  } finally {
    clearInterval(keepAlive)
    await plug.stop()
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('relay E2E: unconfigured inert, stub search+mirror one-level staging, mb: announce, and zero credential leaks', { timeout: 240_000 }, async t => {
  const testnet = await createTestnet(3)
  const dir = mkdtempSync(join(tmpdir(), 'peartube-slsk-e2e-'))
  const storage = join(dir, 'storage')
  mkdirSync(storage, { recursive: true })

  const SECRET_USER = 'slsk_priv_user_99'
  const SECRET_PASS = 'slsk_super_secret_pw_8842'
  const PEER_MBID = '0123456789abcdef0123456789abcdef'
  const CALLER_MBID = 'abcdef0123456789abcdef0123456789'
  // The peer's copy names its own release and release group; a caller-supplied id must win over both.
  const MILES_PEER_MBID = '11112222333344445555666677778888'
  const MILES_GROUP_MBID = '99990000aaaabbbbccccddddeeeeffff'

  const track1Path = '@@lossless\\Music\\John Coltrane\\1958 - Blue Train\\01 - Blue Train.flac'
  const track2Path = '@@lossless\\Music\\John Coltrane\\1958 - Blue Train\\02 - Moment\'s Notice.flac'
  const untaggedPath = '@@lossless\\Music\\Miles Davis\\Kind of Blue (1959)\\01 - So What.flac'
  const giantPath = '@@music\\Jazz\\Coltrane\\Giant Steps\\track02.flac'
  const rollinsPath = '@@music\\Sonny Rollins - Saxophone Colossus (1956)\\03 Strode Rode.flac'
  const loosePath = '@@share\\untitled.flac'
  const milesBytes = buildFlac({
    ALBUM: 'Kind of Blue',
    ALBUMARTIST: 'Miles Davis',
    ARTIST: 'Miles Davis',
    TITLE: 'So What',
    DATE: '1959',
    DISCNUMBER: '1',
    TRACKNUMBER: '1',
    MUSICBRAINZ_RELEASEGROUPID: MILES_GROUP_MBID,
    MUSICBRAINZ_ALBUMID: MILES_PEER_MBID
  }, 128 * 1024)

  const stub = await startStubSoulseekNetwork({
    filesByPeer: {
      coltrane_peer: {
        [track1Path]: buildFlac({
          ALBUM: 'Blue Train',
          ALBUMARTIST: 'John Coltrane',
          ARTIST: 'John Coltrane',
          TITLE: 'Blue Train',
          DATE: '1958',
          DISCNUMBER: '1',
          TRACKNUMBER: '1',
          MUSICBRAINZ_ALBUMID: PEER_MBID
        }, 160 * 1024),
        [track2Path]: buildFlac({
          ALBUM: 'Blue Train',
          ALBUMARTIST: 'John Coltrane',
          ARTIST: 'John Coltrane',
          TITLE: 'Moment\'s Notice',
          DATE: '1958',
          DISCNUMBER: '1',
          TRACKNUMBER: '2',
          MUSICBRAINZ_ALBUMID: PEER_MBID
        }, 160 * 1024)
      },
      miles_peer: {
        [untaggedPath]: milesBytes
      },
      // A lone track whose name says nothing (`track02`); its tags name the album and the track.
      giant_peer: {
        [giantPath]: buildFlac({ ALBUM: 'Giant Steps', ALBUMARTIST: 'John Coltrane', ARTIST: 'John Coltrane', TITLE: 'Cousin Mary', DATE: '1960', TRACKNUMBER: '2' }, 96 * 1024)
      },
      // A lone track with no tags at all: its folder on the peer names the album, its file name the track.
      rollins_peer: {
        [rollinsPath]: buildFlac({}, 96 * 1024)
      },
      // A lone untagged track in no named folder: nothing says which album it belongs to.
      loose_peer: {
        [loosePath]: buildFlac({}, 64 * 1024)
      }
    },
    searchPeers: [
      {
        username: 'busy_peer',
        slots: false,
        queue: 9,
        files: [
          { filename: '@@lossless\\John Coltrane - Blue Train\\01 - Blue Train.flac', size: 160_000, bitrate: 1411, sample_rate: 44100, bit_depth: 16, length: 640 }
        ]
      },
      {
        username: 'coltrane_peer',
        slots: true,
        queue: 0,
        files: [
          { filename: track1Path, size: 164_000, bitrate: 2304, sample_rate: 96000, bit_depth: 24, length: 643 },
          { filename: track2Path, size: 164_000, bitrate: 2304, sample_rate: 96000, bit_depth: 24, length: 550 }
        ]
      }
    ]
  })

  const apiPort = await freePort()
  const logs = []
  const proc = spawn(join(root, 'node_modules/.bin/bare'), [join(root, 'bin/relay.js')], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: storage,
      PEARTUBE_STORAGE: storage,
      PEARTUBE_API_PORT: String(apiPort),
      PEARTUBE_API_HOST: '127.0.0.1',
      PEARTUBE_BOOTSTRAP: testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(','),
      // An OS-assigned port, so this test never collides with a relay already bound to the default 50300.
      PEARTUBE_SLSK_LISTEN_PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  createInterface({ input: proc.stdout }).on('line', line => logs.push(line))
  createInterface({ input: proc.stderr }).on('line', line => logs.push(line))

  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM')
      await new Promise(r => { proc.once('exit', r); setTimeout(r, 3000) })
      if (proc.exitCode === null) proc.kill('SIGKILL')
    }
    await stub.close()
    await testnet.destroy()
    rmSync(dir, { recursive: true, force: true })
  })

  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start: ' + logs.join('\n'))), 60_000)
    const check = line => {
      if (line.includes('relay ready')) {
        clearTimeout(timer)
        resolveReady()
      }
    }
    for (const l of logs) check(l)
    createInterface({ input: proc.stdout }).on('line', check)
    proc.once('exit', code => reject(new Error(`relay exited ${code}: ${logs.join('\n')}`)))
  })

  const base = `http://127.0.0.1:${apiPort}`
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    return { status: res.status, data: await res.json() }
  }

  // 1. Unconfigured plugin is inert: zero connections to Soulseek server, reports `not configured`.
  const initialPlugins = (await call('GET', '/v1/plugins')).data.plugins
  const slskInit = initialPlugins.find(p => p.name === 'soulseek')
  assert.ok(slskInit, 'soulseek plugin registered')
  assert.equal(slskInit.configured, false)
  assert.equal(slskInit.status, 'not configured')
  assert.equal(stub.stats.connections, 0, 'unconfigured plugin makes zero network connections')
  assert.equal((await call('POST', '/v1/providers/soulseek/search', { query: 'Blue Train' })).status, 400)
  assert.equal((await call('POST', '/v1/providers/soulseek/mirror', { username: 'coltrane_peer', files: [track1Path] })).status, 400)
  const runUnconfigured = await call('POST', '/v1/plugins/soulseek/run', {})
  assert.equal(runUnconfigured.status, 200)
  assert.equal(runUnconfigured.data.skipped, true)
  assert.equal(runUnconfigured.data.status, 'not configured')
  results.checks.unconfiguredInert = true

  // 2. Configure credentials live via PUT /v1/settings; verify /v1/plugins updates without exposing secrets.
  const putSet = await call('PUT', '/v1/settings', {
    slskUser: SECRET_USER,
    slskPass: SECRET_PASS,
    slskServer: `127.0.0.1:${stub.port}`
  })
  assert.equal(putSet.status, 200)
  assert.equal(putSet.data.settings.slskPass.value, '', 'slskPass redacted in settings view')
  assert.equal(putSet.data.settings.slskPass.set, true)
  const cfgPlugins = (await call('GET', '/v1/plugins')).data.plugins
  const slskCfg = cfgPlugins.find(p => p.name === 'soulseek')
  assert.equal(slskCfg.configured, true)
  assert.equal(slskCfg.status, 'configured')

  // 3. Search via POST /v1/providers/soulseek/search -> ranked candidates
  const searchRes = await call('POST', '/v1/providers/soulseek/search', { query: 'John Coltrane Blue Train', timeoutMs: 250 })
  assert.equal(searchRes.status, 200, JSON.stringify(searchRes.data))
  const cands = searchRes.data.candidates
  assert.equal(cands.length, 3)
  assert.equal(cands[0].username, 'coltrane_peer', 'slots && queue===0 peer ranked first')
  assert.equal(cands[0].slots, true)
  assert.equal(cands[0].queue, 0)
  assert.equal(cands[0].bit_depth, 24)
  assert.equal(cands[0].sample_rate, 96000)
  assert.equal(cands[2].username, 'busy_peer', 'queued peer ranked after free peer')
  results.checks.searchRanked = cands.map(c => ({ username: c.username, slots: c.slots, queue: c.queue, bit_depth: c.bit_depth }))

  // 4. Mirror an album with no caller id: the peer's own MusicBrainz release tag names it
  const mirrorStart = await call('POST', '/v1/providers/soulseek/mirror', {
    username: 'coltrane_peer',
    title: 'John Coltrane - Blue Train',
    files: [
      { filename: track1Path, size: 164_000 },
      { filename: track2Path, size: 164_000 }
    ]
  })
  assert.equal(mirrorStart.status, 200, JSON.stringify(mirrorStart.data))
  assert.equal(mirrorStart.data.queued, true)
  const jobId = mirrorStart.data.job.jobId
  assert.ok(jobId, 'mirror returns a jobId on the jobs surface')

  // Poll /v1/jobs/:id until done
  let finalJob = null
  for (let i = 0; i < 80; i++) {
    const jr = await call('GET', `/v1/jobs/${jobId}`)
    if (jr.data?.status === 'done' || jr.data?.status === 'failed') {
      finalJob = jr.data
      break
    }
    await sleep(100)
  }
  assert.equal(finalJob?.status, 'done', `mirror job finished: ${JSON.stringify(finalJob)}`)
  assert.ok(finalJob.bytes > 300_000)

  // Verify one-level staging layout: `<storage>/staging/John Coltrane - Blue Train (1958)/<files>`
  const stagingRoot = join(storage, 'staging')
  assert.equal(existsSync(stagingRoot), true)
  const stagingDirs = readdirSync(stagingRoot)
  assert.deepEqual(stagingDirs, ['John Coltrane - Blue Train (1958)'], 'placed one level deep under staging/<Artist> - <Album> (<Year>)/')
  // Dot files are the relay's own notes (which files it mirrored); the media walk skips them.
  const stagedFiles = readdirSync(join(stagingRoot, stagingDirs[0])).filter(n => !n.startsWith('.')).sort()
  assert.deepEqual(stagedFiles, ['01 - Blue Train.flac', '02 - Moment\'s Notice.flac'])
  assert.deepEqual(JSON.parse(readFileSync(join(stagingRoot, stagingDirs[0], '.peartube-mirrored.json'), 'utf8')).sort(), stagedFiles, 'the relay notes which files it mirrored')
  for (const f of stagedFiles) {
    assert.equal(statSync(join(stagingRoot, stagingDirs[0], f)).isFile(), true, 'one level deep files only, no nested subdirectories')
  }

  // Verify importer announced tracks under peer's MBID (`mb:0123456789abcdef0123456789abcdef:s01e01` & `s01e02`)
  const entries1 = (await call('GET', '/v1/entries')).data.results
  const coltraneRows = entries1.filter(e => e.id.startsWith(`mb:${PEER_MBID}:`))
  assert.equal(coltraneRows.length, 2, `importer announced both tracks under peer MBID: ${JSON.stringify(entries1.map(e => e.id))}`)
  assert.deepEqual(coltraneRows.map(r => r.episode).sort((a, b) => a - b), [1, 2])
  assert.equal(coltraneRows[0].title, 'John Coltrane · Blue Train')

  // 5. Mirror with a caller-supplied release id: it wins over the peer's own release and release-group tags, and the
  //    stored file is byte-for-byte what the peer served (the announce carries the id; the bytes are not rewritten)
  const mirrorUntagged = await call('POST', '/v1/providers/soulseek/mirror', {
    username: 'miles_peer',
    id: `mb:${CALLER_MBID}`,
    files: [{ filename: untaggedPath, size: 131_200 }],
    wait: true
  })
  assert.equal(mirrorUntagged.status, 200, JSON.stringify(mirrorUntagged.data))
  assert.equal(mirrorUntagged.data.folder, 'Miles Davis - Kind of Blue (1959)')

  const entries2 = (await call('GET', '/v1/entries')).data.results
  const milesRows = entries2.filter(e => e.id.startsWith(`mb:${CALLER_MBID}:`))
  assert.equal(milesRows.length, 1, `caller release id announced as mb:${CALLER_MBID}:s01e01: ${JSON.stringify(entries2.map(e => e.id))}`)
  assert.equal(milesRows[0].id, `mb:${CALLER_MBID}:s01e01`)
  assert.equal(entries2.some(e => e.id.includes(MILES_PEER_MBID) || e.id.includes(MILES_GROUP_MBID)), false, 'peer tag ids are not announced')
  assert.equal(milesRows[0].sha256, createHash('sha256').update(milesBytes).digest('hex'), 'stored bytes are exactly what the peer served')
  results.checks.mirrorAndImport = {
    stagedFolders: readdirSync(stagingRoot).sort(),
    announcedIds: entries2.map(e => e.id).sort()
  }

  // 6. A single track is a track of its album, never a clip. Tagged: its tags name the folder and the file
  //    (`NN - Title.ext`), whatever the peer called it. Untagged: its folder on the peer names the album, its file
  //    name the track, and the job says so. Neither: a plain error, and nothing is announced.
  const releaseOf = (albumArtist, album, year) => `album:${createHash('sha256').update(albumKey({ albumArtist, album, year })).digest('hex').slice(0, 20)}`
  const giant = await call('POST', '/v1/providers/soulseek/mirror', { username: 'giant_peer', files: [{ filename: giantPath, size: 98_400 }], wait: true })
  assert.equal(giant.status, 200, JSON.stringify(giant.data))
  assert.equal(giant.data.folder, 'John Coltrane - Giant Steps (1960)')
  assert.deepEqual(readdirSync(join(stagingRoot, giant.data.folder)).filter(n => !n.startsWith('.')), ['02 - Cousin Mary.flac'])
  assert.equal(giant.data.placed.from, 'tags')
  const rollins = await call('POST', '/v1/providers/soulseek/mirror', { username: 'rollins_peer', files: [{ filename: rollinsPath, size: 98_400 }], wait: true })
  assert.equal(rollins.status, 200, JSON.stringify(rollins.data))
  assert.equal(rollins.data.folder, 'Sonny Rollins - Saxophone Colossus (1956)')
  assert.deepEqual(readdirSync(join(stagingRoot, rollins.data.folder)).filter(n => !n.startsWith('.')), ['03 - Strode Rode.flac'])
  assert.equal(rollins.data.placed.from, 'peer folder')
  assert.match(rollins.data.placed.note, /from the peer's folder name/)
  const loose = await call('POST', '/v1/providers/soulseek/mirror', { username: 'loose_peer', files: [{ filename: loosePath, size: 66_000 }], wait: true })
  assert.equal(loose.status, 422, JSON.stringify(loose.data))
  assert.match(loose.data.error, /Could not place “untitled\.flac”: it has no album tag/)
  assert.equal(readdirSync(stagingRoot).some(n => /untitled/i.test(n)), false, 'an unplaced track is not staged')
  const entries3 = (await call('GET', '/v1/entries')).data.results
  const giantRow = entries3.find(e => e.id === `${releaseOf('John Coltrane', 'Giant Steps', 1960)}:s01e02`)
  assert.ok(giantRow, `tagged lone track announced as track 2 of its album: ${JSON.stringify(entries3.map(e => e.id))}`)
  assert.equal(giantRow.title, 'John Coltrane · Giant Steps')
  assert.equal(giantRow.music.title, 'Cousin Mary')
  const rollinsRow = entries3.find(e => e.id === `${releaseOf('Sonny Rollins', 'Saxophone Colossus', '1956')}:s01e03`)
  assert.ok(rollinsRow, `untagged lone track announced as track 3 of the folder's album: ${JSON.stringify(entries3.map(e => e.id))}`)
  assert.equal(rollinsRow.title, 'Sonny Rollins · Saxophone Colossus')
  assert.equal(entries3.some(e => e.id.startsWith('clip:')), false, 'no lone track lands as a clip')
  results.checks.singleTrackMirror = { giant: giantRow.id, rollins: rollinsRow.id, loose: loose.data.error }

  // 7. Deleting a whole album is one call: every row of its release goes, its staged files and their ledger rows
  //    with it, other albums stay, and a scan afterwards imports nothing again.
  const seriesKey = `mb:${PEER_MBID}`
  const ledgerKeys = () => Object.keys(JSON.parse(readFileSync(join(storage, 'mirror-watch.json'), 'utf8')))
  assert.equal(ledgerKeys().filter(k => k.includes('Blue Train')).length, 2)
  const del = await call('POST', '/v1/entries/remove', { seriesKey })
  assert.equal(del.status, 200, JSON.stringify(del.data))
  assert.equal(del.data.removed.length, 2)
  assert.deepEqual(del.data.removed.map(r => r.file), ['deleted', 'deleted'])
  assert.equal(del.data.filesDeleted, 2)
  assert.deepEqual(del.data.notRemoved, [])
  const entries4 = (await call('GET', '/v1/entries')).data.results
  assert.equal(entries4.filter(e => e.seriesKey === seriesKey).length, 0, 'no row of the deleted album is left')
  for (const id of [milesRows[0].id, giantRow.id, rollinsRow.id]) assert.ok(entries4.some(e => e.id === id), `${id} untouched`)
  assert.equal(existsSync(join(stagingRoot, 'John Coltrane - Blue Train (1958)')), false, 'the emptied album folder is gone')
  assert.equal(ledgerKeys().filter(k => k.includes('Blue Train')).length, 0, 'their mirror-watch.json rows are gone')
  const rescan = await call('POST', '/v1/plugins/watch-dir/run', {})
  assert.equal(rescan.status, 200, JSON.stringify(rescan.data))
  assert.equal(rescan.data.ingested, 0, `a scan after the delete imports nothing: ${JSON.stringify(rescan.data)}`)
  assert.equal((await call('GET', '/v1/entries')).data.results.filter(e => e.seriesKey === seriesKey).length, 0)
  // One track by key: its file goes, and with it the folder it was alone in.
  const one = await call('POST', '/v1/entries/remove', { key: rollinsRow.key })
  assert.equal(one.status, 200, JSON.stringify(one.data))
  assert.deepEqual(one.data.removed.map(r => [r.id, r.file]), [[rollinsRow.id, 'deleted']])
  assert.equal(existsSync(join(stagingRoot, 'Sonny Rollins - Saxophone Colossus (1956)')), false)
  assert.equal((await call('POST', '/v1/entries/remove', {})).status, 400, 'a remove names what to remove')
  results.checks.albumDelete = { removed: del.data.removed.map(r => r.id), rescan: rescan.data.ingested, kept: entries4.map(e => e.id).sort() }

  // 8. Security check: no credentials in /v1/plugins, /v1/jobs, /v1/entries, or relay stdout/stderr logs
  const pluginsBody = JSON.stringify((await call('GET', '/v1/plugins')).data)
  const jobsBody = JSON.stringify((await call('GET', '/v1/jobs')).data)
  const entriesBody = JSON.stringify((await call('GET', '/v1/entries')).data)
  const allLogs = logs.join('\n')
  for (const surface of [
    ['plugins', pluginsBody],
    ['jobs', jobsBody],
    ['entries', entriesBody],
    ['logs', allLogs]
  ]) {
    assert.ok(!surface[1].includes(SECRET_PASS), `${surface[0]} must never contain slskPass`)
    assert.ok(!surface[1].includes(SECRET_USER), `${surface[0]} must never contain slskUser`)
  }
  results.checks.credentialsRedacted = true
})

// A merged album tile folds every release of one artist+album, while `catalog.search` returns one record per
// id+sha256. A delete driven by the tile's own key list must still remove an announce the listing never showed, or
// the tile regroups from that survivor and the album reappears.
test('album delete removes announces the listing collapses away', async () => {
  const CH = 'aa'.repeat(32)
  const removed = []
  const node = {
    status: () => ({ channel: CH }),
    search: async () => [{
      key: 'k-shown',
      id: 'mb:0123456789abcdef0123456789abcdef:s01e01',
      sha256: 'bb'.repeat(32),
      seriesKey: 'mb:0123456789abcdef0123456789abcdef',
      source: CH,
      title: 'Shown',
      music: null,
      size: 1
    }],
    remove: async key => { removed.push(key) }
  }
  const srv = { notify: () => {} }
  const res = await removeEntries(node, {}, srv, { keys: ['k-shown', 'k-hidden'] })
  assert.deepEqual([...removed].sort(), ['k-hidden', 'k-shown'], 'the unseen announce must be removed too')
  assert.equal(res.notRemoved.length, 0)
  assert.equal(res.removed.length, 2)
})
