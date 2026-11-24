// Verification of SoundCloud and Rumble source providers, audio-only page acquisition (`source.audio` + `music`),
// thumbnail proxying, unified `POST /v1/search/sources`, and web UI wiring.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createAcquirer } from '../src/acquire.js'
import { createApi } from '../src/http.js'
import { createMirrorHost } from '../src/mirror.js'
import { downloadPage, identify } from '../src/identify.js'
import { send } from '../src/art.js'
import { albumKey } from '../src/tags.js'
import { page } from '../src/ui.js'

process.env.PEARTUBE_ALLOW_PRIVATE_URLS = '1'

const until = async (fn, ms = 30_000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 100))
  }
}

// 1x1 valid PNG pixel for thumbnail proxy verification.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf00000201010018dd8d0000000049454e44ae426082',
  'hex'
)

function writeStubUbit (binDir) {
  const callsFile = join(binDir, 'calls.log')
  const script = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"), path = require("node:path");',
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");`,
    'const say = o => process.stdout.write(JSON.stringify(o) + "\\n");',
    'if (args[0] === "info") {',
    '  const url = args[1] || "";',
    '  if (url.includes("soundcloud.com")) {',
    '    say({ title: "Midnight Groove", author: "Lofi Artist", site: "SoundCloud", duration: 215, thumbnail: "https://i1.sndcdn.com/art.jpg", webpageURL: url, formats: [{ ext: "mp3", vcodec: "none", acodec: "mp3" }] });',
    '    process.exit(0);',
    '  }',
    '  if (url.includes("bandcamp.com")) {',
    '    say({ title: "Desert Echoes", author: "Synth Nomad", duration: 302, webpageURL: url, formats: [{ ext: "mp3", vcodec: "none", acodec: "mp3" }] });',
    '    process.exit(0);',
    '  }',
    '  if (url.includes("rumble.com")) {',
    '    say({ title: "Open Hardware Deep Dive", author: "Tech Lab", site: "Rumble", duration: 754, height: 1080, webpageURL: url, formats: [{ ext: "mp4", height: 1080, vcodec: "h264", acodec: "aac" }] });',
    '    process.exit(0);',
    '  }',
    '  say({ entries: [] });',
    '  process.exit(0);',
    '}',
    'const audioOnly = args.includes("-a");',
    'const out = args[args.indexOf("-o") + 1];',
    'const url = args[1] || "";',
    'const ext = audioOnly ? ".m4a" : ".mp4";',
    'const tag = audioOnly ? "ftypM4A " : "ftypisom";',
    'const body = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(tag), Buffer.from(url.padEnd(2048, "x"))]);',
    'const file = path.join(out, (audioOnly ? "track" : "video") + ext);',
    'say({ event: "progress", downloaded: body.length, total: body.length });',
    'fs.writeFileSync(file, body);',
    'say({ event: "done", path: file, size: body.length });'
  ].join('\n')
  const file = join(binDir, 'ubit')
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  return { bin: file, callsFile }
}

test('SoundCloud and Rumble providers: search, thumbnails, mirror, unified search, and audio-only acquire', { timeout: 120_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-sources-'))
  const storage = join(dir, 'storage')
  const watchDir = join(dir, 'import')
  const binDir = join(dir, 'bin')
  for (const d of [storage, watchDir, binDir]) mkdirSync(d, { recursive: true })
  const ubit = writeStubUbit(binDir)

  // Stub HTTP server simulating SoundCloud (homepage, bundle with rotating client_id, api-v2, artwork) and Rumble (search HTML + thumbnail).
  let scClientVersion = 1
  let scSearchCalls = 0
  const stubServer = createHttpServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname === '/sc-home') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end('<html><head><script src="/assets/sc-bundle.js"></script></head><body>SoundCloud</body></html>')
    }
    if (u.pathname === '/assets/sc-bundle.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      const cid = scClientVersion === 1 ? 'sc_client_id_expired_123456' : 'sc_client_id_fresh_98765432'
      return res.end(`window.__sc={client_id:"${cid}"};`)
    }
    if (u.pathname === '/sc-api/search/tracks') {
      scSearchCalls++
      const cid = u.searchParams.get('client_id')
      if (cid === 'sc_client_id_expired_123456') {
        scClientVersion = 2
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'expired client_id' }))
      }
      if (cid !== 'sc_client_id_fresh_98765432') {
        res.writeHead(403, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'bad client_id' }))
      }
      const origin = `http://127.0.0.1:${stubServer.address().port}`
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        collection: [
          {
            id: 1001,
            title: 'Sunset Tape',
            duration: 184400,
            permalink_url: 'https://soundcloud.com/lofi-artist/sunset-tape',
            artwork_url: `${origin}/art/sc-1001.png`,
            user: { username: 'Lofi Artist' }
          },
          {
            id: 1002,
            title: 'Night Drive',
            duration: 240000,
            permalink_url: 'https://soundcloud.com/lofi-artist/night-drive',
            artwork_url: `${origin}/art/sc-1002.png`,
            user: { username: 'Lofi Artist' }
          }
        ]
      }))
    }
    if (u.pathname === '/rumble-search') {
      const origin = `http://127.0.0.1:${stubServer.address().port}`
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(`<!doctype html><html><body><ol>
        <li class="video-listing-entry">
          <a class="video-item--a" href="/v5abc12-open-hardware-talk.html">
            <img class="video-item--img" src="${origin}/art/rmb-v5abc12.png" alt="Open Hardware Talk">
          </a>
          <span class="video-item--duration" data-value="12:34">12:34</span>
          <h3 class="video-item--title">Open Hardware &amp; Systems</h3>
          <address class="video-item--by"><div class="video-item--by-a">Tech Lab</div></address>
        </li>
        <li class="video-listing-entry">
          <a class="video-item--a" href="/v5def99-synth-jam.html">
            <img class="video-item--img" src="${origin}/art/rmb-v5def99.png" alt="Synth Jam">
          </a>
          <span class="video-item--duration" data-value="1:02:05">1:02:05</span>
          <h3 class="video-item--title">Modular Synth Jam</h3>
          <address class="video-item--by"><div class="video-item--by-a">Modular Hub</div></address>
        </li>
      </ol></body></html>`)
    }
    if (u.pathname.startsWith('/art/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(TINY_PNG.length) })
      return res.end(TINY_PNG)
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise(resolve => stubServer.listen(0, '127.0.0.1', resolve))
  const stubOrigin = `http://127.0.0.1:${stubServer.address().port}`

  const testnet = await createTestnet(3)
  const node = await createNode({ storage, bootstrap: testnet.bootstrap })
  const acquirer = createAcquirer(node, join(storage, 'jobs.json'), { ubit: ubit.bin, allowPrivateUrls: true })
  const guardedFetch = (url, opts = {}) => send(url, { binary: true, allowPrivate: true, timeoutMs: opts.timeoutMs || 10_000, maxBytes: opts.maxBytes || 4 * 1024 * 1024, headers: opts.headers || {} })
  const stubDownload = (url, outDir, opts) => downloadPage(url, outDir, { ubit: ubit.bin, ...opts })

  const mirror = await createMirrorHost({
    node,
    storage,
    acquirer,
    watchDir,
    pollIntervalMs: 0,
    youtube: {
      info: async () => ({ entries: [] }),
      download: stubDownload
    },
    soundcloud: {
      download: stubDownload,
      fetchBytes: guardedFetch,
      siteBase: `${stubOrigin}/sc-home`,
      apiBase: `${stubOrigin}/sc-api`
    },
    rumble: {
      download: stubDownload,
      fetchBytes: guardedFetch,
      searchBase: `${stubOrigin}/rumble-search`,
      siteOrigin: 'https://rumble.com'
    }
  })

  const state = {
    node,
    acquirer,
    mirror,
    identify: link => identify(link, { ubit: ubit.bin })
  }
  const api = createApi(state)
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${api.address().port}`

  t.after(async () => {
    await new Promise(resolve => api.close(resolve))
    await mirror.close()
    acquirer.close()
    await node.close()
    await testnet.destroy()
    await new Promise(resolve => stubServer.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    return { status: res.status, data: await res.json() }
  }

  // 1. SoundCloud search (with 401 client_id rotation + retry) + thumbnail proxy
  const scRes = await call('POST', '/v1/providers/soundcloud/search', { query: 'lofi' })
  assert.equal(scRes.status, 200, JSON.stringify(scRes.data))
  assert.equal(scSearchCalls, 2, 'retries once after 401 by re-scraping client_id')
  assert.equal(scRes.data.cap, 20)
  assert.equal(scRes.data.truncated, false)
  assert.deepEqual(scRes.data.candidates[0], {
    title: 'Sunset Tape',
    artist: 'Lofi Artist',
    length: 184,
    size: null,
    bitrate: 128,
    sample_rate: null,
    bit_depth: null,
    lossy: true,
    trackId: '1001',
    url: 'https://soundcloud.com/lofi-artist/sunset-tape',
    channel: 'Lofi Artist',
    thumbnail: '/v1/providers/soundcloud/thumb/1001'
  })

  const scThumb = await fetch(base + '/v1/providers/soundcloud/thumb/1001')
  assert.equal(scThumb.status, 200)
  assert.equal(scThumb.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await scThumb.arrayBuffer()), TINY_PNG)
  assert.equal((await fetch(base + '/v1/providers/soundcloud/thumb/1001', { headers: { origin: 'http://evil.example' } })).status, 403)
  assert.equal((await fetch(base + '/v1/providers/soundcloud/thumb/unknown')).status, 204)

  // 2. SoundCloud mirror (album + single-track) -> sc: pin + music metadata in channel
  const scMirror = await call('POST', '/v1/providers/soundcloud/mirror', {
    artist: 'Lofi Artist',
    album: 'Tape One',
    tracks: [
      { trackId: '1001', url: 'https://soundcloud.com/lofi-artist/sunset-tape', title: 'Sunset Tape' },
      { trackId: '1002', url: 'https://soundcloud.com/lofi-artist/night-drive', title: 'Night Drive' }
    ],
    wait: true
  })
  assert.equal(scMirror.status, 200, JSON.stringify(scMirror.data))
  const expectedScHex = createHash('sha256').update(albumKey({ albumArtist: 'Lofi Artist', album: 'Tape One', year: '' })).digest('hex').slice(0, 20)
  assert.equal(scMirror.data.id, `sc:${expectedScHex}`)
  assert.equal(scMirror.data.files, 2)
  const scFolder = join(watchDir, 'Lofi Artist - Tape One [SoundCloud]')
  assert.deepEqual(readdirSync(scFolder).filter(n => !n.startsWith('.')).sort(), ['01 - Sunset Tape.m4a', '02 - Night Drive.m4a'])

  const scEntries = (await call('GET', '/v1/entries')).data.results.filter(e => e.id.startsWith(`sc:${expectedScHex}:`))
  assert.deepEqual(scEntries.map(e => e.id).sort(), [`sc:${expectedScHex}:s01e01`, `sc:${expectedScHex}:s01e02`])
  assert.deepEqual(scEntries.find(e => e.id.endsWith('e01')).music, { title: 'Sunset Tape', artist: 'Lofi Artist' })

  // Single-track mirror shape on SoundCloud
  const scSingle = await call('POST', '/v1/providers/soundcloud/mirror', {
    url: 'https://soundcloud.com/lofi-artist/single-track',
    title: 'Solo Beat',
    artist: 'Lofi Artist',
    wait: true
  })
  assert.equal(scSingle.status, 200, JSON.stringify(scSingle.data))
  assert.match(scSingle.data.id, /^sc:[0-9a-f]{20}$/)
  assert.equal(scSingle.data.files, 1)

  // 3. Rumble search + thumbnail proxy
  const rmbRes = await call('POST', '/v1/providers/rumble/search', { query: 'hardware' })
  assert.equal(rmbRes.status, 200, JSON.stringify(rmbRes.data))
  assert.equal(rmbRes.data.cap, 20)
  assert.equal(rmbRes.data.candidates.length, 2)
  assert.deepEqual(rmbRes.data.candidates[0], {
    title: 'Open Hardware & Systems',
    channel: 'Tech Lab',
    length: 754,
    rumbleId: 'v5abc12',
    url: 'https://rumble.com/v5abc12-open-hardware-talk.html',
    thumbnail: '/v1/providers/rumble/thumb/v5abc12',
    video: true
  })
  assert.equal(rmbRes.data.candidates[1].length, 3725)

  const rmbThumb = await fetch(base + '/v1/providers/rumble/thumb/v5abc12')
  assert.equal(rmbThumb.status, 200)
  assert.deepEqual(Buffer.from(await rmbThumb.arrayBuffer()), TINY_PNG)
  assert.equal((await fetch(base + '/v1/providers/rumble/thumb/v5abc12', { headers: { origin: 'http://evil.example' } })).status, 403)
  assert.equal((await fetch(base + '/v1/providers/rumble/thumb/v999999')).status, 204)

  // 4. Rumble mirror: video mode (audio: false) and audio mode (audio: true with rmb: pin)
  const rmbVideo = await call('POST', '/v1/providers/rumble/mirror', {
    title: 'Open Hardware & Systems',
    url: 'https://rumble.com/v5abc12-open-hardware-talk.html',
    rumbleId: 'v5abc12',
    audio: false,
    wait: true
  })
  assert.equal(rmbVideo.status, 200, JSON.stringify(rmbVideo.data))
  assert.equal(rmbVideo.data.id, 'rmb:v5abc12')
  assert.equal(rmbVideo.data.files, 1)
  const rmbVideoEntry = (await call('GET', '/v1/entries')).data.results.find(e => e.id === 'rmb:v5abc12')
  assert.ok(rmbVideoEntry, 'Rumble video is announced as rmb:v5abc12')
  assert.equal(rmbVideoEntry.season, null, 'Rumble video lands in Watch (no season/episode)')

  const rmbAudio = await call('POST', '/v1/providers/rumble/mirror', {
    title: 'Modular Synth Jam',
    url: 'https://rumble.com/v5def99-synth-jam.html',
    rumbleId: 'v5def99',
    audio: true,
    artist: 'Modular Hub',
    album: 'Live Sessions',
    wait: true
  })
  assert.equal(rmbAudio.status, 200, JSON.stringify(rmbAudio.data))
  const expectedRmbHex = createHash('sha256').update(albumKey({ albumArtist: 'Modular Hub', album: 'Live Sessions', year: '' })).digest('hex').slice(0, 20)
  assert.equal(rmbAudio.data.id, `rmb:${expectedRmbHex}`)
  const rmbAudioEntry = (await call('GET', '/v1/entries')).data.results.find(e => e.id === `rmb:${expectedRmbHex}:s01e01`)
  assert.ok(rmbAudioEntry, 'Rumble audio track lands in Listen with rmb:<hex>:s01e01')
  assert.deepEqual(rmbAudioEntry.music, { title: 'Modular Synth Jam', artist: 'Modular Hub' })

  // 5. Unified POST /v1/search/sources across soundcloud + rumble (and default all sources)
  const unified = await call('POST', '/v1/search/sources', { query: 'synth', sources: ['soundcloud', 'rumble'] })
  assert.equal(unified.status, 200, JSON.stringify(unified.data))
  assert.deepEqual(unified.data.bySource, { soundcloud: 2, rumble: 2 })
  assert.equal(unified.data.errors.length, 0)
  assert.ok(unified.data.results.some(r => r.source === 'soundcloud' && r.trackId === '1001'))
  assert.ok(unified.data.results.some(r => r.source === 'rumble' && r.rumbleId === 'v5abc12'))

  const allSources = await call('POST', '/v1/search/sources', { query: 'synth' })
  assert.equal(allSources.status, 200)
  assert.deepEqual(Object.keys(allSources.data.bySource).sort(), ['rumble', 'soulseek', 'soundcloud', 'youtube'])

  // 6. identify() for audio-only pages + POST /v1/acquire with source.audio + music
  const idSc = await call('POST', '/v1/identify', { url: 'https://soundcloud.com/lofi-artist/midnight-groove' })
  assert.equal(idSc.status, 200, JSON.stringify(idSc.data))
  assert.equal(idSc.data.site, 'SoundCloud')
  assert.equal(idSc.data.audioOnly, true)
  assert.equal(idSc.data.suggestedAudio, true)
  assert.match(idSc.data.plain.id, /^sc:[0-9a-f]{12}:s01e01$/)
  assert.deepEqual(idSc.data.music, { title: 'Midnight Groove', artist: 'Lofi Artist' })

  const idBc = await call('POST', '/v1/identify', { url: 'https://synthnomad.bandcamp.com/track/desert-echoes' })
  assert.equal(idBc.status, 200, JSON.stringify(idBc.data))
  assert.equal(idBc.data.site, 'Bandcamp')
  assert.equal(idBc.data.audioOnly, true)
  assert.equal(idBc.data.suggestedAudio, true)
  assert.match(idBc.data.plain.id, /^clip:[0-9a-f]{12}:s01e01$/)
  assert.deepEqual(idBc.data.music, { title: 'Desert Echoes', artist: 'Synth Nomad' })

  const acq = await call('POST', '/v1/acquire', {
    id: idSc.data.plain.id,
    title: idSc.data.plain.title,
    source: { url: 'https://soundcloud.com/lofi-artist/midnight-groove', page: true, audio: true },
    music: idSc.data.music
  })
  assert.equal(acq.status, 200, JSON.stringify(acq.data))
  await until(async () => {
    const j = (await call('GET', `/v1/jobs/${acq.data.jobId}`)).data
    if (j?.status === 'failed') throw new Error(j.error)
    return j?.status === 'done'
  })
  const calls = readFileSync(ubit.callsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const acqCall = calls.find(a => a[0] === 'get' && a[1] === 'https://soundcloud.com/lofi-artist/midnight-groove')
  assert.ok(acqCall && acqCall.includes('-a'), 'POST /v1/acquire with source.audio passes -a to ubit')
  const rmbVideoCall = calls.find(a => a[0] === 'get' && a[1] === 'https://rumble.com/v5abc12-open-hardware-talk.html')
  assert.ok(rmbVideoCall && !rmbVideoCall.includes('-a'), 'Rumble video mirror does not pass -a to ubit')
  const rmbAudioCall = calls.find(a => a[0] === 'get' && a[1] === 'https://rumble.com/v5def99-synth-jam.html')
  assert.ok(rmbAudioCall && rmbAudioCall.includes('-a'), 'Rumble audio mirror passes -a to ubit')

  const acquiredEntry = (await call('GET', '/v1/entries')).data.results.find(e => e.id === idSc.data.plain.id)
  assert.ok(acquiredEntry, 'acquired SoundCloud track is in the channel')
  assert.deepEqual(acquiredEntry.music, { title: 'Midnight Groove', artist: 'Lofi Artist' })

  // 7. Web UI page reflects SoundCloud, Rumble, Audio-only preview, and removes Planned placeholder
  assert.ok(page.includes("['soundcloud', 'SoundCloud']"), 'UI SOURCES includes SoundCloud')
  assert.ok(page.includes("['rumble', 'Rumble']"), 'UI SOURCES includes Rumble')
  assert.ok(page.includes('/v1/providers/soundcloud/mirror'), 'UI calls SoundCloud mirror route')
  assert.ok(page.includes('/v1/providers/rumble/mirror'), 'UI calls Rumble mirror route')
  assert.ok(page.includes('addAudioOnly'), 'UI link preview includes Audio only switch')
  assert.equal(page.includes('Planned: Rumble, SoundCloud.'), false, 'Planned placeholder removed from Discover')
})
