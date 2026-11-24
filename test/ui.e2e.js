// End-to-end checks of the relay web UI in headless Brave (`$PUPPETEER_EXECUTABLE_PATH`), driven over CDP.
// The first test:
//   1. Settings: token gate (401), settings.json > env > default precedence with a way back to the env value, 0600 file,
//      round-trip from the UI with every change applied in the running relay, and the Restart relay action.
//   2. Every plugin as a user intent from Home, counting presses: add from URL, import a folder,
//      follow a feed, copy a channel, keep copies, ask a HiveRelay to seed; legacy migration hidden when there is none.
//   3. Content identification against a stubbed Cinemeta and a stub `ubit` (`UBIT_BIN`): an exact match is
//      published as `imdb:tt…` (the id MediaStorm searches by), an unknown file as a plain clip, a page link
//      through ubit's metadata and NDJSON downloader.
//   4. Music sources on Search against the stub `ubit`: source chips and their memory, a streamed two-source search,
//      YouTube rows with relay-fetched thumbnails and the fixed lossy label, rows that stay put when the slower group
//      lands above them (and no redraw mid-press), suggestions from messy titles, failure hints, a failing source on
//      its own, the save dialog (suggestions, reorder, single track filed into the album that has it, Escape), job
//      cards without a percentage, library labels for YouTube copies, alone and merged with a FLAC album, removing
//      the YouTube copy on its own, and words that match nothing in the library leading on to a search outside.
//   5. Taste gates on every place at 1440×900 and 390×844 in light and dark: no console errors or warnings, no
//      sideways scroll, no internal plugin ids in visible text, no hint over 12 words, every field labelled
//      with an example placeholder; again with search results on screen and with the save dialog open.
// It writes `desktop/target/e2e/ui-result.json`, screenshots to `desktop/target/e2e/ui-audit/after/`, and the sources
// screens to `desktop/target/e2e/sources-ux/` (the UX-fix evidence in its `fixes/`).
// The second test is the one library (design/unified-library.md) on a relay of its own that holds a movie, a series,
// a clip and an album. Each behaviour of the new browsing is one named check; all of them run, and the test fails
// once, at its end, with the names of the checks that failed. It writes `desktop/target/e2e/ui-design-result.json`
// and screenshots to `desktop/target/e2e/ui-audit/design/`. To run it alone: `--test-name-pattern='one library'`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { isDeepStrictEqual } from 'node:util'

const root = new URL('..', import.meta.url).pathname
const outDir = join(root, 'desktop/target/e2e')
const shotDir = join(outDir, 'ui-audit/after')
const srcShotDir = join(outDir, 'sources-ux')
const PLUGIN_IDS = ['http-acquire', 'channel-backfill', 'blob-rechunk', 'watch-dir', 'feed-mirror', 'p2p-replicate', 'hiverelay-seed', 'soulseek', 'youtube']
const TOKEN = randomBytes(16).toString('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function bytesFor (name, size = 200_000) {
  const out = Buffer.alloc(size)
  let block = createHash('sha256').update(name).digest()
  for (let i = 0; i < size; i += 32) {
    block.copy(out, i)
    block = createHash('sha256').update(block).digest()
  }
  return out
}

function freePort () {
  return new Promise(resolve => {
    const srv = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// Stub web: media files, a video page, Cinemeta's catalog/meta API, a JSON feed and images.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082', 'hex')
// A real 5 s clip for the player: H.264, English and Spanish audio, and a SubRip cue every second ("cue 0".."cue 4").
function playableClip (secs = 5) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-ui-clip-'))
  const srt = Array.from({ length: 5 }, (_, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},900\ncue ${i}\n`).join('\n')
  writeFileSync(join(dir, 'cues.srt'), srt)
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
    '-i', join(dir, 'cues.srt'), '-t', String(secs), '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=spa', '-metadata:s:s:0', 'language=eng', join(dir, 'clip.mkv')])
  const bytes = readFileSync(join(dir, 'clip.mkv'))
  rmSync(dir, { recursive: true, force: true })
  return bytes
}
// One 16:9 encode whose first four seconds bake in scope bars, then opens back up to full frame.
// It proves the WebCodecs canvas follows the picture as its aspect changes, not just the file header.
function variableAspectClip () {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-ui-aspect-'))
  const file = join(dir, 'variable.mkv')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '8', '-vf', "drawbox=x=0:y=0:w=iw:h=24:color=black:t=fill:enable='lt(t,4)',drawbox=x=0:y=156:w=iw:h=24:color=black:t=fill:enable='lt(t,4)'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', file])
  const bytes = readFileSync(file)
  rmSync(dir, { recursive: true, force: true })
  return bytes
}
// An album folder for the import folder: one tagged FLAC tone per track, `[name, hertz, name in the file name]`.
// `secs` is how long each track plays; the checks that play a whole queue need tracks that outlast them.
function flacAlbum (dir, artist, album, tracks, secs = 8) {
  mkdirSync(dir, { recursive: true })
  tracks.forEach(([name, hz, file = name], i) => {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=44100:duration=${secs}`, '-metadata', 'title=' + name, '-metadata', 'artist=' + artist,
      '-metadata', 'album=' + album, '-metadata', 'track=' + (i + 1), join(dir, `0${i + 1} - ${file}.flac`)])
  })
}

function startStub () {
  // The large file and the ffmpeg clips are made when first asked for: a test that plays none does not wait for them.
  const files = {
    '/media/Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP.mp4': bytesFor('bbb'),
    '/media/Random.Clip.Name.mp4': bytesFor('random'),
    '/media/feed-item.mp4': bytesFor('feed'),
    '/page-video.mp4': bytesFor('page'),
    '/media/long.mp4': () => bytesFor('long', 16 * 1024 * 1024),
    '/media/clip.mkv': () => playableClip(),
    '/media/clip30.mkv': () => playableClip(30),
    '/media/variable.mkv': () => variableAspectClip()
  }
  const file = path => typeof files[path] === 'function' ? (files[path] = files[path]()) : files[path]
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const base = 'http://127.0.0.1:' + srv.address().port
    const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const bytes = file(url.pathname)
    if (bytes) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length })
      return res.end(req.method === 'HEAD' ? undefined : bytes)
    }
    if (url.pathname === '/watch') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(req.method === 'HEAD' ? undefined : '<html></html>') }
    if (url.pathname === '/poster.png' || url.pathname === '/thumb.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG) }
    if (url.pathname === '/feed.json') return json([{ id: 'clip:feeditem1', title: 'Feed Item One', url: base + '/media/feed-item.mp4' }])
    if (url.pathname.startsWith('/cinemeta/catalog/movie/top/search=')) {
      const q = decodeURIComponent(url.pathname.split('search=')[1].replace(/\.json$/, ''))
      stub.searches.push(q)
      if (q === 'Big Buck Bunny') {
        return json({ metas: [
          { id: 'tt0490086', name: 'Big Stan', releaseInfo: '2008', poster: base + '/poster.png' },
          { id: 'tt1254207', name: 'Big Buck Bunny', releaseInfo: '2008', poster: base + '/poster.png' }
        ] })
      }
      return json({ metas: [] })
    }
    if (url.pathname === '/cinemeta/meta/movie/tt1254207.json') return json({ meta: { id: 'tt1254207', poster: base + '/poster.png' } })
    if (url.pathname === '/cinemeta/meta/series/tt0000002.json') return json({ meta: { id: 'tt0000002', poster: base + '/poster.png' } })
    res.writeHead(404)
    res.end()
  })
  const stub = { srv, searches: [] }
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => { stub.base = 'http://127.0.0.1:' + srv.address().port; resolve(stub) }))
}

// A `ubit` stub that speaks the real `ubit info --json` and `ubit get --json` contracts for the stub page, and for
// YouTube: `info ytsearch:<q>` answers three videos (a query with "fail" fails), `get -a` writes a short M4A.
function fakeUbit (dir, stubBase) {
  const info = {
    id: 'aqz-KE-bpKQ',
    title: 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film',
    author: 'Blender',
    duration: 635,
    thumbnail: stubBase + '/thumb.png',
    site: 'YouTube',
    webpageURL: stubBase + '/watch?v=aqz-KE-bpKQ',
    isDRM: false,
    isLive: false,
    formats: [{ id: '22', ext: 'mp4', proto: 'http', url: stubBase + '/page-video.mp4', vcodec: 'avc1', acodec: 'mp4a', height: 360 }]
  }
  const search = { entries: [
    { id: 'tbDawn00001', title: 'Test Band - Dawn (Official Audio)', duration: 200 },
    { id: 'tbDusk00002', title: 'Test Band - Dusk', duration: 190 },
    { id: 'tbFirst0003', title: 'Test Band - First Light (Full Album)', duration: 2200 }
  ] }
  const bin = join(dir, 'ubit')
  const script = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");',
    `const info = ${JSON.stringify(info)};`,
    `const search = ${JSON.stringify(search)};`,
    `const mediaUrl = ${JSON.stringify(stubBase + '/page-video.mp4')};`,
    'const args = process.argv.slice(2);',
    'if (args[0] === "info" && String(args[1]).startsWith("ytsearch:")) {',
    '  if (/fail/i.test(args[1])) { console.error("error: boom"); process.exit(1); }',
    '  console.log(JSON.stringify(search)); process.exit(0);',
    '}',
    'if (args[0] === "info") { console.log(JSON.stringify(info)); process.exit(0); }',
    'if (args[0] === "get" && args.includes("-a")) {',
    '  const o = args.indexOf("-o");',
    '  const outDir = o !== -1 ? args[o + 1] : process.cwd();',
    '  fs.mkdirSync(outDir, { recursive: true });',
    '  const id = new URL(args[1]).searchParams.get("v");',
    '  const dst = path.join(outDir, id + ".m4a");',
    // Each save is its own file (a unique comment), so two saves of one video are two copies, not one blob.
    '  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100:duration=3", "-c:a", "aac", "-b:a", "128k", "-metadata", "comment=" + id + Date.now() + Math.random(), dst]);',
    '  const size = fs.statSync(dst).size;',
    '  console.log(JSON.stringify({ event: "start", url: args[1] }));',
    '  console.log(JSON.stringify({ event: "progress", downloaded: size, total: size, fraction: 1, speed: size }));',
    '  console.log(JSON.stringify({ event: "done", path: dst, seconds: 0.01, size }));',
    '  process.exit(0);',
    '}',
    'if (args[0] === "get") {',
    '  const o = args.indexOf("-o");',
    '  const outDir = o !== -1 ? args[o + 1] : process.cwd();',
    '  fs.mkdirSync(outDir, { recursive: true });',
    '  fetch(mediaUrl).then(r => r.arrayBuffer()).then(ab => {',
    '    const buf = Buffer.from(ab);',
    '    const dst = path.join(outDir, "page-video.mp4");',
    '    fs.writeFileSync(dst, buf);',
    '    console.log(JSON.stringify({ event: "start", url: args[1] }));',
    '    console.log(JSON.stringify({ event: "progress", downloaded: buf.length, total: buf.length, fraction: 1, speed: buf.length }));',
    '    console.log(JSON.stringify({ event: "done", path: dst, seconds: 0.01, size: buf.length }));',
    '  }).catch(err => { console.log(JSON.stringify({ event: "error", error: err.message })); process.exit(1); });',
    '} else { process.exit(2); }'
  ].join('\n') + '\n'
  writeFileSync(bin, script)
  chmodSync(bin, 0o755)
  return info
}

async function startRelay (env) {
  const proc = spawn(join(root, 'node_modules/.bin/bare'), [join(root, 'bin/relay.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const errors = []
  createInterface({ input: proc.stderr }).on('line', line => errors.push(line))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start: ' + errors.join('\n'))), 60_000)
    createInterface({ input: proc.stdout }).on('line', line => { if (line.includes('relay ready')) { clearTimeout(timer); resolve() } })
    proc.once('exit', code => reject(new Error('relay exited ' + code + ': ' + errors.join('\n'))))
  })
  return proc
}

// The relay, the stub server and a test's folders, ended together: by the test's `finally`, and by a test whose
// browser did not start, which never reaches its `finally` and would leave the relay running after the run.
async function stopRelay (relay, stub, dirs) {
  relay.kill('SIGTERM')
  await new Promise(resolve => { relay.once('exit', resolve); setTimeout(resolve, 5000) })
  stub.srv.closeAllConnections()
  stub.srv.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

// Minimal CDP client for one Brave tab.
async function launchBrowser () {
  const exe = process.env.PUPPETEER_EXECUTABLE_PATH
  assert.ok(exe && existsSync(exe), 'PUPPETEER_EXECUTABLE_PATH must point at a Chromium-family browser')
  const dir = mkdtempSync(join(tmpdir(), 'peartube-ui-browser-'))
  // `--use-mock-keychain` + `--password-store=basic` + `--disable-sync` keep macOS from ever prompting
  // SecurityAgent for Brave's storage/sync/wallet keys on throwaway profiles during unattended runs.
  // `--disable-gpu` alone leaves WebGL to the platform: Chromium on a Linux machine with no GPU falls back to
  // software GL and writes a deprecation warning into the page's console, and on macOS the page gets no WebGL.
  // `--enable-unsafe-swiftshader` asks for software GL by name, so the player takes one path on every machine.
  // `--no-sandbox` and `--disable-dev-shm-usage`: the CI's Chromium starts under the runner's user without a
  // usable sandbox and with a small `/dev/shm`; with either missing it exits before it writes `DevToolsActivePort`.
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--enable-unsafe-swiftshader', '--disable-extensions', '--use-mock-keychain', '--password-store=basic', '--disable-sync', '--disable-features=BraveWallet,BraveRewards,BraveNews', '--no-sandbox', '--disable-dev-shm-usage', 'about:blank'], { stdio: 'ignore' })
  const portFile = join(dir, 'DevToolsActivePort')
  const connect = async () => {
    for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(100)
    const port = readFileSync(portFile, 'utf8').split('\n')[0]
    // The port file can be there before the first tab is: on a busy machine the list came back with no page in it.
    let target = null
    for (let i = 0; i < 100 && !target; i++) {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page')
      if (!target) await sleep(100)
    }
    assert.ok(target, 'the browser opened no tab within 10 s')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    return { port, target, ws: socket }
  }
  // A browser that cannot be driven is ended here: nothing else holds it, and it would outlive the run.
  const { port, target, ws } = await connect().catch(async err => {
    proc.kill('SIGKILL')
    await sleep(300)
    rmSync(dir, { recursive: true, force: true })
    throw err
  })
  let seq = 0
  const pending = new Map()
  const issues = []
  // Every URL the page asks for, so the run can prove it never contacts YouTube or its image host.
  const requests = []
  // Each request's life, by CDP request id, so a slow page load can name the request it waited on.
  const net = new Map()
  let replies = null
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      return
    }
    if (m.method === 'Fetch.requestPaused') {
      const id = m.params.requestId
      const body = replies?.get(m.params.request.url)
      const done = body == null ? send('Fetch.continueRequest', { requestId: id }) : send('Fetch.fulfillRequest', {
        requestId: id, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body
      })
      done.catch(err => issues.push('test HTTP reply: ' + err.message))
      return
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) issues.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '))
    if (m.method === 'Runtime.exceptionThrown') issues.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    // A GPU driver's own hint is not the page: SwiftShader in the CI writes "GPU stall due to ReadPixels" there.
    if (m.method === 'Log.entryAdded' && (m.params.entry.level === 'error' || m.params.entry.level === 'warning') && !/^\[\.WebGL-[^\]]*\]GL Driver Message/.test(m.params.entry.text)) issues.push(m.params.entry.level + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''))
    if (m.method === 'Network.requestWillBeSent') {
      requests.push(m.params.request.url)
      // A redirect reuses the id: the hop that follows starts its own life.
      net.set(m.params.requestId, { url: m.params.request.url, method: m.params.request.method, start: Date.now(), ts: m.params.timestamp, end: null, status: null })
    }
    if (m.method === 'Network.responseReceived' && net.has(m.params.requestId)) {
      const r = net.get(m.params.requestId)
      const t = m.params.response.timing
      r.status = m.params.response.status
      r.headersAt = Date.now()
      // How long it waited for a connection before it was sent, and how long the relay took to answer once sent.
      if (t) Object.assign(r, { queuedMs: Math.round((t.requestTime - r.ts) * 1000 + Math.max(0, t.sendStart)), serverMs: Math.round(t.receiveHeadersEnd - t.sendEnd) })
    }
    if ((m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') && net.has(m.params.requestId)) {
      const r = net.get(m.params.requestId)
      r.end = Date.now()
      if (m.method === 'Network.loadingFailed') r.failed = m.params.canceled ? 'cancelled' : m.params.errorText
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Network.enable', { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 100_000 })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  // Hides the page by bringing a blank tab to the front, as switching tabs or covering the window does.
  let blank = null
  const devtools = (path, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method }).then(r => r.text())
  return {
    issues,
    requests,
    // Every request alive during [from, to]: path, method, ms, status or "pending at load end", when its headers came
    // (a body that ends long after them is the relay slow to send it), slowest first. A page left behind ends its
    // event stream without CDP saying so, so an unfinished request older than 30 s is left out.
    during (from, to) {
      return [...net.values()].filter(r => r.start <= to && (r.end == null ? r.start >= from - 30_000 : r.end >= from)).map(r => {
        const u = new URL(r.url)
        const open = r.end == null || r.end > to
        return {
          path: u.protocol.startsWith('http') ? u.pathname + u.search : u.protocol,
          method: r.method,
          ms: (open ? to : r.end) - r.start,
          status: open ? 'pending at load end' : r.failed || r.status,
          ...(r.start < from ? { before: 'started on the page before' } : {}),
          ...(r.headersAt ? { headersMs: r.headersAt - r.start } : {}),
          ...(r.queuedMs != null ? { queuedMs: r.queuedMs, serverMs: r.serverMs } : {})
        }
      }).sort((a, b) => b.ms - a.ms)
    },
    async hide () { blank = blank || JSON.parse(await devtools('/json/new?about:blank', 'PUT')).id; await devtools('/json/activate/' + blank) },
    async show () { await devtools('/json/activate/' + target.id) },
    // Answer only these exact test URLs. All other requests still go to the relay, and the page runs unchanged.
    async withJson (routes, fn) {
      replies = new Map(Object.entries(routes).map(([url, data]) => [url, Buffer.from(JSON.stringify(data)).toString('base64')]))
      await send('Fetch.enable', { patterns: [...replies.keys()].map(urlPattern => ({ urlPattern })) })
      try { return await fn() } finally { await send('Fetch.disable'); replies = null }
    },
    send,
    evaluate,
    async close () {
      try { ws.close() } catch {}
      proc.kill('SIGKILL')
      await sleep(300)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// What a reader can see, and the name a control carries: its label when it is an icon, else its words. Both are
// source for Runtime.evaluate, so every check reads the page the way a reader and a screen reader do.
const VIS = `(e => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' })`
const NAME = `(e => (e.getAttribute('aria-label') || e.innerText || e.textContent || '').trim().replace(/\\s+/g, ' '))`
const seen = selector => `${VIS}(document.querySelector(${JSON.stringify(selector)}))`

// One tab driven as a reader drives it: real pointer presses and typed text, and the taste gates. `clicks` counts the
// presses, for the checks that count the way to an intent.
function drive (browser, base, result, shots) {
  const { evaluate, send } = browser
  const ui = { clicks: 0 }
  async function center (selector) {
    const at = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null })()`)
    assert.ok(at, 'visible element ' + selector)
    return at
  }
  async function click (selector) {
    const { x, y } = await center(selector)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    ui.clicks++
    await sleep(150)
  }
  // Marks the visible control whose text is `text` (inside `scope`) and clicks it. A card redraws after its Save, so
  // a control can appear late or be replaced between marking and clicking: look again for up to 5 s.
  async function clickText (text, scope = 'body') {
    const end = Date.now() + 5000
    for (;;) {
      const mark = 'e2e-' + Math.random().toString(36).slice(2)
      const found = await evaluate(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button, ' + ${JSON.stringify(scope)} + ' a, ' + ${JSON.stringify(scope)} + ' label.switch')]
        const e = els.find(x => x.offsetParent !== null && x.textContent.trim().replace(/\\s+/g, ' ').startsWith(${JSON.stringify(text)}))
        if (!e) return false
        e.setAttribute('data-e2e', ${JSON.stringify(mark)})
        e.scrollIntoView({ block: 'center' })
        return e.getBoundingClientRect().width > 0
      })()`)
      if (found) return click(`[data-e2e="${mark}"]`)
      assert.ok(Date.now() < end, 'control "' + text + '" in ' + scope)
      await sleep(100)
    }
  }
  // The same, by the name a control carries. An icon-only control has its name on aria-label, which is what the
  // design asks for and what a reader hears; `clickText` sees only words. `whole` false matches the name's start.
  async function clickName (name, scope = 'body', whole = true) {
    const end = Date.now() + 5000
    for (;;) {
      const mark = 'e2e-' + Math.random().toString(36).slice(2)
      const found = await evaluate(`(() => {
        const sel = ${JSON.stringify(scope)}
        const els = [...document.querySelectorAll(sel + ' button, ' + sel + ' a, ' + sel + ' label.switch, ' + sel + ' [role=menuitem], ' + sel + ' [role=button]')]
        const want = ${JSON.stringify(name)}
        const e = els.filter(x => ${VIS}(x)).find(x => ${whole ? 'true' : 'false'} ? ${NAME}(x) === want : ${NAME}(x).startsWith(want))
        if (!e) return false
        e.setAttribute('data-e2e', ${JSON.stringify(mark)})
        e.scrollIntoView({ block: 'center' })
        return e.getBoundingClientRect().width > 0
      })()`)
      if (found) return click(`[data-e2e="${mark}"]`)
      assert.ok(Date.now() < end, 'control named "' + name + '" in ' + scope)
      await sleep(100)
    }
  }
  async function type (selector, text) {
    await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); e.focus(); e.select?.() })()`)
    await send('Input.insertText', { text })
  }
  async function press (key) {
    const k = { Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Escape: { code: 'Escape', windowsVirtualKeyCode: 27 } }[key]
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...k })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode })
    await sleep(150)
  }
  async function waitFor (expression, what, timeout = 30_000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await evaluate(expression).catch(() => false)) return
      await sleep(200)
    }
    throw new Error('timed out waiting for ' + what)
  }
  async function waitApi (fn, what, timeout = 30_000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const v = await fn().catch(() => null)
      if (v) return v
      await sleep(300)
    }
    throw new Error('timed out waiting for ' + what)
  }
  async function viewport (width, height, scheme) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
  }
  async function open (hash = '') {
    // A new query string makes every open a full load, not a same-document hash change.
    // Park the pointer first: resting on a Play button would start the 16 MB player download on the old page.
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
    await send('Page.navigate', { url: base + '/?load=' + Date.now() + hash })
    // The page is ready once its first read of the relay has come back; a script that failed to start never is.
    await waitFor(`document.readyState === 'complete' && S.loaded === true`, 'page load')
    await sleep(400)
  }
  // The bar's rooms; the relay's own pages are links in the bar, or in its More menu below 1400 px.
  const goTab = async name => {
    if (['Home', 'Listen', 'Watch', 'Discover', 'Search'].includes(name)) return void (await clickText(name, '.rooms'), await sleep(300))
    if (await evaluate(`(() => { const a = document.querySelector('.owner a[data-tab="' + ${JSON.stringify(name.toLowerCase())} + '"]'); return !!a && a.offsetParent !== null })()`)) await clickText(name, '#ownerNav')
    else { await clickName('More', '.top'); await clickText(name, '.menu') }
    await sleep(300)
  }
  async function shot (name, viewportOnly = false, dir = shots) {
    const file = join(dir, name + '.png')
    writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !viewportOnly })).data, 'base64'))
    result.screenshots.push(file.slice(root.length))
  }
  // The taste gates, on whatever is on screen now.
  async function tasteAudit (where) {
    const audit = await evaluate(`(() => {
      const visible = e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed'
      const words = s => s.trim().split(/\\s+/).filter(Boolean).length
      const text = document.body.innerText
      const fields = [...document.querySelectorAll('input, select, textarea')].filter(e => visible(e) && !['checkbox', 'radio', 'range', 'hidden'].includes(e.type))
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        pluginIds: ${JSON.stringify(PLUGIN_IDS)}.filter(id => text.includes(id)),
        longHints: [...document.querySelectorAll('.hint, p, [title]')].filter(visible).map(e => e.matches('[title]') ? e.title : e.textContent).filter(t => words(t) > 12),
        unlabeled: fields.filter(e => !(e.labels && e.labels.length) && !e.getAttribute('aria-label')).map(e => e.id),
        noPlaceholder: fields.filter(e => e.tagName === 'INPUT' && !e.placeholder).map(e => e.id),
        rawJson: /[{]"[a-zA-Z]+":/.test(text),
        stray: text.match(/\\b(null|undefined|NaN)\\b/g) || []
      }
    })()`)
    assert.ok(audit.scrollWidth <= audit.clientWidth, where + ': sideways scroll ' + audit.scrollWidth + ' > ' + audit.clientWidth)
    assert.deepEqual(audit.pluginIds, [], where + ': internal plugin ids visible')
    assert.deepEqual(audit.longHints, [], where + ': hints over 12 words')
    assert.deepEqual(audit.unlabeled, [], where + ': unlabelled fields')
    assert.deepEqual(audit.noPlaceholder, [], where + ': fields without an example')
    assert.equal(audit.rawJson, false, where + ': raw JSON on screen')
    assert.deepEqual(audit.stray, [], where + ': a missing value printed as text')
    return audit
  }
  return Object.assign(ui, { center, click, clickText, clickName, type, press, waitFor, waitApi, viewport, open, goTab, shot, tasteAudit })
}

test('relay web UI: settings, plugins as intents, identification, music sources, and taste gates', { timeout: 420_000 }, async () => {
  mkdirSync(shotDir, { recursive: true })
  mkdirSync(srcShotDir, { recursive: true })
  const storage = mkdtempSync(join(tmpdir(), 'peartube-ui-storage-'))
  const binDir = mkdtempSync(join(tmpdir(), 'peartube-ui-bin-'))
  // The import folder is env-only; the file lands just before the scan, so the scan is what imports it.
  const watchDir = mkdtempSync(join(tmpdir(), 'peartube-ui-watch-'))
  const stub = await startStub()
  const page = fakeUbit(binDir, stub.base)
  const apiPort = await freePort()
  const dhtPort = await freePort()
  // A settings.json from an earlier run: its concurrency wins over the default.
  writeFileSync(join(storage, 'settings.json'), JSON.stringify({ acquireConcurrency: 2 }), { mode: 0o600 })
  const env = {
    PATH: binDir + ':' + process.env.PATH,
    UBIT_BIN: join(binDir, 'ubit'),
    HOME: process.env.HOME,
    PEARTUBE_STORAGE: storage,
    PEARTUBE_API_PORT: String(apiPort),
    PEARTUBE_API_HOST: '127.0.0.1',
    PEARTUBE_API_TOKEN: TOKEN,
    PEARTUBE_DHT_PORT: String(dhtPort),
    PEARTUBE_BOOTSTRAP: '127.0.0.1:1',
    PEARTUBE_WATCH_DIR: watchDir,
    // The stub Cinemeta, feeds and direct links are on loopback (src/ssrf.js refuses them otherwise).
    PEARTUBE_ALLOW_PRIVATE_URLS: '1'
  }
  let relay = await startRelay(env)
  const base = 'http://127.0.0.1:' + apiPort
  const auth = { authorization: 'Bearer ' + TOKEN }
  const getJson = async (path, headers = auth) => (await fetch(base + path, { headers })).json()
  const settingsNow = () => getJson('/v1/settings')
  const result = { pass: false, relay: base, checks: {}, interactions: {}, timings: {}, consoleIssues: [], viewports: [], screenshots: [] }
  const started = Date.now()
  const mark = name => { result.timings[name] = Date.now() - started }
  const browser = await launchBrowser().catch(async err => { await stopRelay(relay, stub, [storage, binDir, watchDir]); throw err })
  const { evaluate, send } = browser
  const ui = drive(browser, base, result, shotDir)
  const { click, clickText, clickName, type, waitFor, waitApi, viewport, open, goTab, shot, tasteAudit } = ui
  const entries = async () => (await getJson('/v1/entries')).results

  try {
    await viewport(1440, 900, 'dark')
    await open()

    // 1. Settings behind the token.
    assert.equal((await fetch(base + '/v1/settings')).status, 401)
    assert.equal((await fetch(base + '/v1/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"lan":true}' })).status, 401)
    assert.equal(await evaluate(`!document.querySelector('#authForm').hidden`), true, 'sign-in form shown when a token is required')
    await shot('signin-1440-dark')
    await type('#tokenInput', TOKEN)
    await clickText('Sign in')
    await waitFor(`document.querySelector('#authForm').hidden`, 'signed in')
    result.checks.tokenGate = true
    mark('signedIn')

    const first = await settingsNow()
    assert.deepEqual([first.settings.dhtPort.source, first.settings.dhtPort.value], ['env', dhtPort], 'env beats the default')
    assert.deepEqual([first.settings.acquireConcurrency.source, first.settings.acquireConcurrency.value], ['file', 2], 'settings.json beats the default')
    assert.deepEqual([first.settings.privateGuardPort.source, first.settings.privateGuardPort.value], ['default', 0])
    result.checks.precedence = true

    // Round-trip from the Settings tab: an env value overridden and put back, a node setting and a live one.
    await goTab('Settings')
    const otherPort = await freePort()
    await evaluate(`document.querySelector('#set-dhtPort').value = ''`)
    await type('#set-dhtPort', String(otherPort))
    await clickText('Save changes', '.card:has(#set-dhtPort)')
    const overridden = await waitApi(async () => { const s = await settingsNow(); return s.settings.dhtPort.value === otherPort && !s.restartNeeded.length && s }, 'env value overridden from the UI')
    assert.deepEqual([overridden.settings.dhtPort.source, overridden.restartNeeded], ['file', []], 'settings.json wins over the env var, applied at once')
    // Nothing on the Settings tab applies before Save: the env reset, a switch and a list edit all wait.
    await clickText('Use PEARTUBE_DHT_PORT', '.card:has(#set-dhtPort)')
    await evaluate(`document.querySelector('#set-directory').click(); true`)
    await type('#set-allowedPeers', 'ab'.repeat(32))
    await clickText('Add', '.setting:has(#set-allowedPeers)')
    await sleep(1500)
    let held = await settingsNow()
    assert.deepEqual([held.settings.dhtPort.value, held.settings.directory.value, held.settings.allowedPeers.value], [otherPort, false, []], 'nothing applied before Save')
    await clickText('Remove', '.setting:has(#set-allowedPeers)')
    await clickText('Save changes', '.card:has(#set-dhtPort)')
    await waitApi(async () => { const s = await settingsNow(); return s.settings.dhtPort.source === 'env' && s.settings.dhtPort.value === dhtPort && !s.restartNeeded.length }, 'env value back after Save')
    assert.deepEqual((await settingsNow()).settings.allowedPeers.value, [], 'a list entry added then removed is never saved')
    held = await settingsNow()
    assert.equal(held.settings.directory.value, false, 'the Library card keeps its own unsaved switch')
    await clickText('Save changes', '.card:has(#set-directory)')
    await waitApi(async () => (await settingsNow()).settings.directory.value === true, 'switch applied after Save')
    await evaluate(`document.querySelector('#set-directory').click(); true`)
    await clickText('Save changes', '.card:has(#set-directory)')
    await waitApi(async () => (await settingsNow()).settings.directory.value === false, 'switch back off after Save')
    result.checks.settingsWaitForSave = true
    // "Use PEARTUBE_DHT_PORT" and then typing a port: the typed port is what Save sends, not the env value.
    const firstPort = await freePort()
    await evaluate(`document.querySelector('#set-dhtPort').value = ''`)
    await type('#set-dhtPort', String(firstPort))
    await clickText('Save changes', '.card:has(#set-dhtPort)')
    await waitApi(async () => { const s = await settingsNow(); return s.settings.dhtPort.value === firstPort && !s.restartNeeded.length }, 'port overridden again')
    await clickText('Use PEARTUBE_DHT_PORT', '.card:has(#set-dhtPort)')
    const typedPort = await freePort()
    await evaluate(`document.querySelector('#set-dhtPort').value = ''`)
    await type('#set-dhtPort', String(typedPort))
    assert.equal(await evaluate(`[...document.querySelectorAll('.card:has(#set-dhtPort) .tag')].some(t => t.textContent.includes('after saving'))`), false, 'typing drops the pending env reset')
    await clickText('Save changes', '.card:has(#set-dhtPort)')
    const typed = await waitApi(async () => { const s = await settingsNow(); return s.settings.dhtPort.value === typedPort && !s.restartNeeded.length && s }, 'the typed port is saved')
    assert.equal(typed.settings.dhtPort.source, 'file')
    await clickText('Use PEARTUBE_DHT_PORT', '.card:has(#set-dhtPort)')
    await clickText('Save changes', '.card:has(#set-dhtPort)')
    await waitApi(async () => { const s = await settingsNow(); return s.settings.dhtPort.source === 'env' && !s.restartNeeded.length }, 'env value back again')
    result.checks.typingCancelsEnvReset = true
    await type('#set-lanHost', '192.0.2.10')
    await clickText('Save changes', '.card:has(#set-lanHost)')
    await waitApi(async () => (await settingsNow()).settings.lanHost.value === '192.0.2.10', 'LAN address saved')
    await type('#set-cinemetaUrl', stub.base + '/cinemeta')
    await clickText('Save changes', '.card:has(#set-cinemetaUrl)')
    const saved = await waitApi(async () => { const s = await settingsNow(); return s.settings.cinemetaUrl.value === stub.base + '/cinemeta' && s }, 'lookup service saved')
    assert.equal(saved.settings.lanHost.source, 'file')
    assert.deepEqual(saved.restartNeeded, [], 'a valid LAN address applies in place')
    assert.equal(await evaluate(`document.querySelectorAll('.banner').length`), 0, 'no restart banner after the listener reopens')
    await clickText('Restart relay')
    await waitFor(`document.querySelector('#toast').textContent === 'Restarted'`, 'restart action finished')
    assert.equal(relay.exitCode, null, 'restarted in place')
    // A change made elsewhere (another tab, the API) shows on this open Settings page without leaving it.
    await evaluate(`document.activeElement && document.activeElement.blur(); true`)
    await fetch(base + '/v1/settings', { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ acquireConcurrency: 3 }) })
    await waitFor(`document.querySelector('#set-acquireConcurrency').value === '3'`, 'settings page shows a change made elsewhere', 15_000)
    result.checks.settingsFollowChanges = true
    const fileMode = statSync(join(storage, 'settings.json')).mode & 0o777
    assert.equal(fileMode, 0o600)
    assert.equal(JSON.parse(readFileSync(join(storage, 'settings.json'), 'utf8')).lanHost, '192.0.2.10')
    result.checks.settingsRoundTrip = true
    mark('settings')
    result.settingsFileMode = fileMode.toString(8)

    // 2 + 3. Add from URL with an exact Cinemeta match: three presses from Home.
    await goTab('Home')
    ui.clicks = 0
    await clickText('Add to library', '.top')
    await type('#addInput', stub.base + '/media/Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP.mp4')
    await clickText('Add', '#addForm')
    await waitFor(`!document.querySelector('#preview').hidden && document.querySelector('#preview input[name=cand]:checked')`, 'identification preview')
    const preview = await evaluate(`({ checked: document.querySelector('#preview input[name=cand]:checked').value, title: document.querySelector('#addTitle').value, choices: [...document.querySelectorAll('#preview .cand')].map(c => c.textContent.trim()) })`)
    assert.equal(preview.checked, 'imdb:tt1254207', 'the exact title and year is chosen')
    assert.equal(preview.title, 'Big Buck Bunny 2008')
    assert.ok(!preview.choices.some(c => c.includes('Big Stan')), 'unrelated titles are not offered')
    await clickText('Add to library', '#preview')
    result.interactions.addFromUrl = ui.clicks
    const movie = await waitApi(async () => (await entries()).find(e => e.id === 'imdb:tt1254207'), 'identified entry')
    assert.equal(movie.title, 'Big Buck Bunny 2008')
    assert.equal((await getJson('/v1/search?id=imdb:tt1254207')).results.length, 1, 'MediaStorm finds it by imdb id')
    // The same file announced again (a second copy in its own core) is still one entry and one tile.
    const again = await (await fetch(base + '/v1/acquire', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'imdb:tt1254207', title: 'Big Buck Bunny 2008', source: { url: stub.base + '/media/Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP.mp4' } }) })).json()
    await waitApi(async () => (await getJson('/v1/jobs/' + again.jobId)).status === 'done', 'second copy announced')
    assert.equal((await getJson('/v1/search?id=imdb:tt1254207')).results.length, 1, 'two copies of one file are one entry')
    await goTab('Watch')
    await waitFor(`document.querySelectorAll('#entries .tile').length === 1`, 'one tile for the duplicated file')
    result.checks.duplicateCopiesCollapse = true

    // Players drop Range reads all the time (seeks, prefetch). A dropped read through /v1/blob used to crash the relay.
    const longJob = await (await fetch(base + '/v1/acquire', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'clip:longread', title: 'Long Read', source: { url: stub.base + '/media/long.mp4' } }) })).json()
    await waitApi(async () => (await getJson('/v1/jobs/' + longJob.jobId)).status === 'done', 'long file stored')
    const long = (await entries()).find(e => e.id === 'clip:longread')
    const blobUrl = base + '/v1/blob?' + long.streamUrl.split('?')[1]
    for (let i = 0; i < 10; i++) {
      const ac = new AbortController()
      const res = await fetch(blobUrl, { signal: ac.signal, headers: i % 2 ? { range: 'bytes=8388608-' } : {} })
      await res.body.getReader().read()
      ac.abort()
    }
    await sleep(500)
    assert.equal(relay.exitCode, null, 'the relay is still running after dropped reads')
    assert.equal((await fetch(base + '/v1/status')).status, 200)
    result.checks.droppedReadsSurvived = true

    // The player: plays, names its tracks, shows subtitles, stops at the end with Replay, and replays.
    const clipJob = await (await fetch(base + '/v1/acquire', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'clip:playable', title: 'Playable Clip', source: { url: stub.base + '/media/clip.mkv' } }) })).json()
    await waitApi(async () => (await getJson('/v1/jobs/' + clipJob.jobId)).status === 'done', 'clip stored')
    await waitFor(`[...document.querySelectorAll('.tile')].some(t => t.textContent.includes('Playable Clip'))`, 'clip tile')
    await click(`[data-tile="v:clip:playable/${(await entries()).find(e => e.id === 'clip:playable').sha256}"]`)
    const dlHref = await evaluate(`document.querySelector('#detail [data-download]')?.getAttribute('href') || ''`)
    assert.ok(dlHref.includes('/v1/blob?') && dlHref.includes('download='), 'detail sheet exposes streaming Download link: ' + dlHref)
    const dlRes = await fetch(new URL(dlHref, base), { headers: { Range: 'bytes=0-15' } })
    assert.equal(dlRes.status, 206)
    assert.match(dlRes.headers.get('content-disposition') || '', /attachment; filename="Playable Clip\.mkv"/)
    assert.equal(dlRes.headers.get('content-type'), 'video/x-matroska')
    await dlRes.arrayBuffer()
    // The sheet names what the file holds (read from its header: the relay holds it) and how well it streams.
    const infoText = `[...document.querySelectorAll('#detail .file-info .info-row')].map(r => r.textContent).join('\\n')`
    await waitFor(`${infoText}.includes('H.264')`, 'file info in the detail sheet', 15_000)
    const info = await evaluate(infoText)
    for (const line of ['FormatMKV · 0:05', 'VideoH.264 · 320×180', 'Audio 1AAC · Mono · English', 'Audio 2AAC · Mono · Spanish', 'SubtitlesSRT · English']) {
      assert.ok(info.split('\n').some(l => l.startsWith(line)), `file info shows "${line}": ${info}`)
    }
    assert.ok(info.split('\n').includes('HealthPlays from this relay'), 'the relay\'s own copy plays from the relay: ' + info)
    result.checks.fileInfo = info
    await evaluate(`(() => { window.__modalCopied = ''; document.addEventListener('copy', ev => { window.__modalCopied = ev.clipboardData?.getData('text/plain') || '' }, false); return true })()`)
    // A page keeps its less-used actions behind More: open it, then copy.
    await clickName('More', '#detail', false)
    await waitFor(`!!document.querySelector('dialog.menu[open]')`, 'the More menu', 4000)
    await clickText('Copy link', 'dialog.menu')
    const modalCopied = await evaluate(`window.__modalCopied`)
    assert.match(modalCopied, /^peartube:\/\/watch\//, 'Copy link on a title page must populate clipboardData over plain HTTP')
    // A watch link names its public channel, so whoever opens it joins that channel's swarm and finds the peers
    // that cached the video (only publishers and relays announce a video itself).
    const linkStatus = await getJson('/v1/status')
    assert.match(modalCopied, new RegExp(`[?&]source=${linkStatus.channel}&kind=channel(&|$)`), 'the watch link names its channel: ' + modalCopied)
    assert.equal(modalCopied.includes('kind=tracker'), false, 'a watch link never names a tracker')
    await click('#detail [data-play]')
    const clockSecs = `Number($('pClock').textContent.split(' / ')[0].split(':').pop())`
    await waitFor(`!!player && player.primed && ${clockSecs} >= 1`, 'clip playing', 30_000)
    const menus = await evaluate(`({ audio: [...$('pAudioSel').options].map(o => o.textContent), subs: [...$('pSubSel').options].map(o => o.textContent) })`)
    assert.ok(menus.audio.some(l => l.startsWith('English')) && menus.audio.some(l => l.startsWith('Spanish')), 'audio tracks named: ' + menus.audio)
    assert.deepEqual(menus.subs, ['Subtitles off', 'English'])
    await evaluate(`(() => { const s = $('pSubSel'); s.selectedIndex = 1; s.dispatchEvent(new Event('change')); return true })()`)
    await waitFor(`/^cue [0-4]$/.test($('pSubText').textContent)`, 'a subtitle cue on screen', 15_000)
    await waitFor(`$('pPlayBtn').textContent === 'Replay'`, 'stop at the end', 20_000)
    const ended = await evaluate(`$('pClock').textContent`)
    assert.equal(ended, '0:05 / 0:05')
    await sleep(1500)
    assert.equal(await evaluate(`$('pClock').textContent`), ended, 'the clock stays at the end')
    await click('#pPlayBtn')
    await waitFor(`$('pPlayBtn').textContent === 'Pause' && ${clockSecs} >= 1 && ${clockSecs} < 5`, 'replay from the start', 15_000)
    await evaluate(`closePlayer(); true`)
    result.checks.player = { menus, ended }
    const aspectJob = await (await fetch(base + '/v1/acquire', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'clip:variableaspect', title: 'Variable Aspect', source: { url: stub.base + '/media/variable.mkv' } }) })).json()
    await waitApi(async () => (await getJson('/v1/jobs/' + aspectJob.jobId)).status === 'done', 'variable-aspect clip stored').catch(async e => { throw new Error(e.message + ': ' + JSON.stringify(await getJson('/v1/jobs/' + aspectJob.jobId))) })
    await waitFor(`S.entries.some(e => e.id === 'clip:variableaspect')`, 'variable-aspect clip in library', 15_000)
    await evaluate(`(() => { openPlayer(S.entries.find(e => e.id === 'clip:variableaspect')); return true })()`)
    await waitFor(`!!player && player.manifest`, 'variable-aspect manifest ready', 15_000)
    await evaluate(`(() => { if (player.useMse) { player.mseSupported = false; $('pVideo').onerror(); } return true })()`)
    await waitFor(`!!player && player.primed && player.usingWebCodecs`, 'WebCodecs variable-aspect playback', 30_000)
    await waitFor(`player.videoCrop?.h < 160 && ($('pCanvas').style.display === 'block' ? $('pCanvas') : $('pGlCanvas')).height === player.videoCrop.h`, 'encoded scope picture fills the stage without second side bars', 10_000)
    await shot('player-scope-1440-dark', true)
    const cropped = await evaluate(`({ width: ($('pCanvas').style.display === 'block' ? $('pCanvas') : $('pGlCanvas')).width, height: ($('pCanvas').style.display === 'block' ? $('pCanvas') : $('pGlCanvas')).height, crop: player.videoCrop })`)
    assert.equal(cropped.width, 320, 'only encoded rows may be cropped: ' + JSON.stringify(cropped))
    assert.equal(cropped.crop.ch, 180)
    await waitFor(`player.videoCrop === null && ($('pCanvas').style.display === 'block' ? $('pCanvas') : $('pGlCanvas')).height === 180 && Number($('pClock').textContent.split(' / ')[0].split(':').pop()) >= 4`, 'full-height sequence restores all picture pixels', 12_000)
    await shot('player-fullframe-1440-dark', true)
    await evaluate(`closePlayer(); true`)
    result.checks.variableAspect = cropped

    // A hidden tab gets no animation frames and the browser pauses the muted picture: the sound used to run dry
    // after about 8 s and the picture jumped on return. Now the sound plays on and the picture rejoins it.
    const bgJob = await (await fetch(base + '/v1/acquire', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'clip:backgrounded', title: 'Backgrounded Clip', source: { url: stub.base + '/media/clip30.mkv' } }) })).json()
    await waitApi(async () => (await getJson('/v1/jobs/' + bgJob.jobId)).status === 'done', '30 s clip stored')
    await waitFor(`S.entries.some(e => e.id === 'clip:backgrounded')`, '30 s clip in the library')
    await evaluate(`(() => { openPlayer(S.entries.find(e => e.id === 'clip:backgrounded')); return true })()`)
    await waitFor(`!!player && player.primed && ${clockSecs} >= 2`, '30 s clip playing', 30_000)
    await evaluate(`(() => { window.__miniBefore = player; showPlayerChrome(); return true })()`)
    await click('#pMiniBtn')
    await waitFor(`$('playerModal').classList.contains('mini') && !$('playerModal').getAttribute('aria-modal').includes('true')`, 'player minimizes without closing', 5_000)
    await shot('player-mini-1440-dark', true)
    await waitFor(`Number($('pMiniClock').textContent.split(' / ')[0].split(':').pop()) >= 4`, 'mini player keeps playing', 10_000)
    assert.equal(await evaluate(`player === window.__miniBefore`), true, 'mini and full view share one playback session')
    await goTab('Channels')
    assert.equal(await evaluate(`player === window.__miniBefore && $('playerModal').classList.contains('mini')`), true, 'mini player survives browsing another tab')
    await goTab('Watch')
    await click('#pMiniPlay')
    assert.equal(await evaluate(`player.paused && $('pMiniPlay').textContent === 'Play'`), true, 'mini play button pauses the same player')
    await evaluate(`(() => { $('pMiniSeek').value = 300; $('pMiniSeek').dispatchEvent(new Event('change')); return true })()`)
    await waitFor(`Number($('pMiniClock').textContent.split(' / ')[0].split(':').pop()) >= 8`, 'mini seek moves the current playback session', 10_000)
    await viewport(390, 844, 'dark')
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && $('playerModal').getBoundingClientRect().right <= innerWidth`), true, 'mini player fits the mobile viewport')
    await shot('player-mini-390-dark', true)
    await viewport(1440, 900, 'dark')
    await click('#pMiniPlay')
    await click('#pMiniRestore')
    assert.equal(await evaluate(`player === window.__miniBefore && !$('playerModal').classList.contains('mini')`), true, 'expand keeps playback and returns to cinema')
    await shot('player-restored-1440-dark', true)
    await evaluate(`(() => { window.__hidden = []; window.__hiddenTimer = setInterval(() => { if (document.hidden && player) window.__hidden.push({ t: (player.audioBaseMedia + audioOutTime(player.audioCtx) - player.audioBaseCtx), lead: player.nextAudioCtxTime - player.audioCtx.currentTime }) }, 500); return true })()`)
    const hiddenFrom = await evaluate(`(player.audioBaseMedia + audioOutTime(player.audioCtx) - player.audioBaseCtx)`)
    const hideAt = Date.now()
    await browser.hide()
    assert.equal(await evaluate('document.visibilityState'), 'hidden')
    await sleep(12_000)
    const hiddenFor = (Date.now() - hideAt) / 1000
    await browser.show()
    const hidden = await evaluate(`(() => { clearInterval(window.__hiddenTimer); return window.__hidden })()`)
    const heard = hidden.at(-1).t - hiddenFrom
    // Neither stopped (the old bug) nor skipped ahead (an audio-only seek that did not move an MKV's demuxer).
    assert.ok(Math.abs(heard - hiddenFor) < 3, `hidden for ${hiddenFor.toFixed(1)} s, the clip advanced ${heard.toFixed(1)} s`)
    assert.ok(hidden.every(x => x.lead > 0), 'sound never ran dry while hidden: ' + JSON.stringify(hidden.map(x => +x.lead.toFixed(1))))
    await waitFor(`!!player && player.primed && $('pStatus').style.display === 'none'`, 'picture back after return', 15_000)
    const frame = async () => createHash('sha256').update((await send('Page.captureScreenshot', { format: 'png' })).data).digest('hex')
    const f1 = await frame()
    await sleep(800)
    assert.notEqual(await frame(), f1, 'the picture moves again after return')
    await evaluate(`setMiniPlayer(true); true`)
    await click('#pCloseBtn')
    assert.equal(await evaluate(`player === null && !$('playerModal').classList.contains('open')`), true, 'mini close tears down playback')
    result.checks.backgroundTab = { heardWhileHidden: +heard.toFixed(1), minLead: +Math.min(...hidden.map(x => x.lead)).toFixed(1) }
    // The shipped player must be built from the pinned decoders: a stale build once seeked by scanning from the start.
    const lockHash = createHash('sha256').update(readFileSync(join(root, 'web/Cargo.lock'))).digest('hex')
    assert.equal(readFileSync(join(root, 'web/assets/peartube_web.lock.sha256'), 'utf8').trim(), lockHash, 'web/assets/peartube_web.wasm is older than web/Cargo.lock: run sh web/build.sh')
    const poster = await fetch(base + '/v1/poster/tt1254207', { redirect: 'manual' })
    assert.equal(poster.status, 302)
    assert.equal(poster.headers.get('location'), stub.base + '/poster.png')
    await waitFor(`[...document.querySelectorAll('#entries img.poster')].some(i => i.complete && i.naturalWidth > 0)`, 'poster shown in the library')
    result.checks.identifyMatch = { id: movie.id, title: movie.title, searches: [...stub.searches] }
    mark('identifyMatch')

    // No match: the parsed title, under a plain clip id.
    await clickText('Add to library', '.top')
    await type('#addInput', stub.base + '/media/Random.Clip.Name.mp4')
    await clickText('Add', '#addForm')
    await waitFor(`!document.querySelector('#preview').hidden && document.querySelector('#addTitle')`, 'plain preview')
    assert.equal(await evaluate(`document.querySelector('#addTitle').value`), 'Random Clip Name')
    assert.equal(await evaluate(`document.querySelector('#preview fieldset') === null`), true, 'no suggestions when nothing matches')
    await clickText('Add to library', '#preview')
    const clip = await waitApi(async () => (await entries()).find(e => e.title === 'Random Clip Name'), 'plain entry')
    assert.match(clip.id, /^clip:[0-9a-f]{16}$/)

    // A page link goes through `ubit` for both its metadata and its muxed download.
    await type('#addInput', stub.base + '/watch?v=aqz-KE-bpKQ')
    await clickText('Add', '#addForm')
    await waitFor(`!document.querySelector('#preview').hidden && document.querySelector('#preview h3')`, 'page preview')
    const pageMeta = await evaluate(`document.querySelector('#preview .meta').textContent`)
    assert.ok(pageMeta.includes('Blender') && pageMeta.includes('10:35'), 'page preview shows uploader and length: ' + pageMeta)
    await clickText('Add to library', '#preview')
    const pageEntry = await waitApi(async () => (await entries()).find(e => e.title === page.title), 'page entry')
    assert.equal(pageEntry.size, bytesFor('page').length)
    const publicText = JSON.stringify(await getJson('/v1/entries')) + JSON.stringify(await getJson('/v1/jobs'))
    assert.ok(!publicText.includes(stub.base), 'source URLs stay out of entries and jobs')
    result.checks.identifyPlain = clip.id
    result.checks.identifyPage = { id: pageEntry.id, title: pageEntry.title }
    mark('identifyPage')

    // Scan the import folder: the page offers a scan, never a path.
    await open('#home')
    assert.equal(await evaluate(`document.querySelector('#folderInput') === null && !document.body.innerHTML.includes(${JSON.stringify(watchDir)})`), true, 'the page names no folder')
    writeFileSync(join(watchDir, 'Watched.Clip.2019.mp4'), bytesFor('watched'))
    // And one album: a folder of two tagged 8 s FLAC tracks.
    flacAlbum(join(watchDir, 'Test Band - First Light'), 'Test Band', 'First Light', [['Dawn', 440], ['Dusk', 550]])
    ui.clicks = 0
    await clickText('Add to library', '.top')
    await clickText('Import folder')
    await clickText('Scan import folder', '#folderForm')
    result.interactions.importFolder = ui.clicks
    mark('importFolderClicked')
    await waitApi(async () => (await entries()).find(e => e.title === 'Watched Clip 2019'), 'watched file imported')
    await waitApi(async () => /Scanned the import folder/.test(await evaluate(`document.querySelector('#addMsg').textContent`)), 'scan result shown')
    assert.equal('watchDir' in (await settingsNow()).settings, false, 'the import folder is not a setting')

    // Music: Play starts the album in the bar, which keeps time with the sound, seeks, skips to the next track,
    // stays through a tab switch and pauses on Space. The bar it leaves comes back paused on every later load,
    // so the taste gates below run with it on screen.
    await waitApi(async () => (await entries()).filter(e => e.music && e.title === 'Test Band · First Light').length === 2, 'album imported')
    await open('#watch')
    assert.equal(await evaluate(`[...document.querySelectorAll('#entries .tile')].some(t => t.textContent.includes('First Light'))`), false, 'albums are not tiles on the film grid')
    await open('#music')
    await waitFor(`[...document.querySelectorAll('#albums .album-card .album-name')].some(n => n.textContent === 'First Light')`, 'album on the Listen shelf')
    await evaluate(`[...document.querySelectorAll('#albums .album-card')].find(c => c.querySelector('.album-name').textContent === 'First Light').querySelector('.album-open').setAttribute('data-e2e', 'album'); true`)
    await click('[data-e2e="album"]')
    await waitFor(seen('#detail [data-album]'), 'album page')
    await click('#detail [data-album]')
    await waitFor(`!!audioEl && audioEl.currentTime > 1 && !$('np').hidden`, 'album playing in the bar', 20_000)
    const bar = await evaluate(`({ pos: $('npQText').textContent, title: $('npTitle').textContent, seek: Number($('npSeek').value), at: audioEl.currentTime })`)
    assert.deepEqual([bar.pos, bar.title], ['1 of 2', 'Dawn'], 'the bar names the track and its place in the queue')
    assert.ok(Math.abs(bar.seek - bar.at) < 1, 'the seek bar keeps time with the sound: ' + JSON.stringify(bar))
    await evaluate(`(() => { const s = $('npSeek'); s.value = '5'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); return true })()`)
    await waitFor(`audioEl.currentTime >= 5`, 'the seek bar moves playback')
    await click('#npNext')
    await waitFor(`$('npQText').textContent === '2 of 2' && $('npTitle').textContent === 'Dusk' && audioEl.currentTime > 0.5`, 'next track playing', 20_000)
    await goTab('Channels')
    assert.equal(await evaluate(`!$('np').hidden && !audioEl.paused`), true, 'the bar and the sound stay through a tab switch')
    await evaluate(`document.activeElement.blur(); true`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
    await waitFor(`audioEl.paused && !$('npPlay').classList.contains('on')`, 'Space pauses')
    await shot('music-bar-1440-dark', true)
    result.checks.musicBar = bar
    mark('musicBar')

    // 4. Music sources, on Search. Soulseek has no account here, so it offers setup; YouTube runs on the stub `ubit`.
    const issuesBefore = browser.issues.length
    const chip = name => `document.querySelector('#srcChips [data-src="${name}"]')`
    // Typing in the Search field opens Search. The page stays loaded, so the bar keeps the album it holds.
    await type('#srcInput', 'test band')
    await waitFor(`!!${chip('youtube')}`, 'source chips')
    assert.deepEqual(await evaluate(`[${chip('youtube')}.textContent, ${chip('youtube')}.getAttribute('aria-pressed')]`), ['✓ YouTube', 'true'], 'YouTube is on by default')
    assert.deepEqual(await evaluate(`[${chip('soulseek')}.textContent, ${chip('soulseek')}.getAttribute('aria-pressed')]`), ['Soulseek · Set up', null], 'Soulseek without an account offers setup, not a toggle')
    // Space on a focused chip toggles the chip, not the music the bar holds.
    const pausedBefore = await evaluate(`audioEl.paused`)
    await evaluate(`${chip('youtube')}.focus(); true`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
    await sleep(300)
    assert.equal(await evaluate(`${chip('youtube')}.getAttribute('aria-pressed')`), 'false', 'Space toggles a focused chip')
    assert.equal(await evaluate(`audioEl.paused`), pausedBefore, 'Space on a chip leaves the music alone')
    // The choice survives a reload.
    await open('#search')
    await waitFor(`!!${chip('youtube')}`, 'source chips after reload')
    assert.equal(await evaluate(`${chip('youtube')}.getAttribute('aria-pressed')`), 'false', 'a source turned off stays off')
    assert.equal(await evaluate(`localStorage.getItem('peartube.sourcesOff')`), '["youtube"]')
    await click(`#srcChips [data-src="youtube"]`)
    assert.equal(await evaluate(`${chip('youtube')}.getAttribute('aria-pressed')`), 'true', 'and back on')
    result.checks.sourceChips = true

    // One search; YouTube's part shows as soon as it lands, every row labelled as the lossy copy it would save. Only
    // YouTube is searched here (Soulseek is not set up); that a group shows while another still waits is proven below
    // with a stubbed two-source stream.
    const ytSearch = async query => {
      await type('#srcInput', query)
      await waitFor(`!$('tab-search').hidden && location.hash === '#search/' + encodeURIComponent(${JSON.stringify(query)})`, 'Search with the typed words', 5000)
      await click('#srcBtn')
    }
    await ytSearch('test band')
    await waitFor(`document.querySelectorAll('#srcGroup-youtube .yt-pick-row').length === 3`, 'YouTube rows shown', 5000)
    const rows = await evaluate(`[...document.querySelectorAll('#ytResults .item')].map(i => i.innerText)`)
    for (const row of rows) assert.ok(row.includes('YouTube') && row.includes('AAC 128 kbps') && row.includes('lossy'), 'YouTube row says what a save gives: ' + row)
    const groupText = await evaluate(`(() => { let t = $('srcGroups').innerText; for (const n of document.querySelectorAll('#srcGroups .item .name')) t = t.replace(n.firstChild.textContent, ''); return t })()`)
    assert.doesNotMatch(groupText, /lossless|\bHQ\b|high quality/i, 'no YouTube copy is called lossless or high quality')
    assert.equal(await evaluate(`[...document.querySelectorAll('#srcGroups .item')].every(i => ['Soulseek', 'YouTube'].includes((i.querySelector('.src-tag') || {}).textContent))`), true, 'every row names its source in words')
    assert.equal(await evaluate(`[...document.querySelectorAll('#srcGroups .yt-thumb')].every(t => t.querySelector('img') || t.querySelector('.yt-ph'))`), true, 'every thumbnail is a relay picture or the drawn placeholder')
    assert.equal(await evaluate(`$('ytNote').firstChild.textContent`), 'Peers not searched. YouTube copies are lossy AAC 128 kbps.', 'the advice says peers were not asked')
    // A source that is only not set up says so, with the way to set it up; "off" is kept for the owner's own choice.
    assert.match(await evaluate(`$('srcSummary').textContent`), /^Soulseek not set up: set up in Settings·YouTube 3 videos$/)
    assert.equal(await evaluate(`$('srcSummary').querySelector('a[href="#settings"]')?.textContent`), 'set up in Settings', 'the summary leads to the setup')
    const reviewShotDir = join(srcShotDir, 'review-fixes')
    mkdirSync(reviewShotDir, { recursive: true })
    await shot('04-summary-not-set-up-1440-dark', true, reviewShotDir)
    // The status line is for screen readers unless it carries an error: clipped to 1 px, still in the page.
    const msgBox = `(() => { const m = $('srcMsg'); const r = m.getBoundingClientRect(); return { text: m.textContent, err: m.classList.contains('err'), w: r.width, h: r.height, clip: getComputedStyle(m).clip, live: m.getAttribute('role') } })()`
    const quiet = await evaluate(msgBox)
    assert.ok(quiet.text && !quiet.err && quiet.w <= 1 && quiet.h <= 1 && quiet.clip.startsWith('rect(0') && quiet.live === 'status', 'a status that is no error is read, not shown: ' + JSON.stringify(quiet))
    // With every source off (the other relays too), Search says so, and that is shown.
    await click('#srcChips [data-src="relays"]')
    await evaluate(`searchSources('test band', []); true`)
    const loud = await evaluate(msgBox)
    assert.ok(loud.err && loud.w > 1 && loud.h > 1 && loud.clip === 'auto', 'an error on the status line is shown: ' + JSON.stringify(loud))
    await click('#srcChips [data-src="relays"]')
    result.checks.statusLineHidden = { quiet, loud }
    result.checks.sourcesStreamed = rows.length

    // Nothing moves under the pointer or the finger when the slower group lands on top. A stream stubbed in the page
    // (no network) answers YouTube at once and Soulseek on demand, with 30 peer folders: tall enough to push a phone's
    // rows thousands of pixels down if nothing held them. As in a real search, the first YouTube row sits mid-screen
    // under its heading and the note, and the note changes (and wraps at 390, with a button) when the peers land:
    // a heading held still would let the note push the row down by however much the note grew. Each search gets rows
    // of its own ("stub.<tag>.…"), so the wait below sees this search's YouTube rows on screen while Soulseek still
    // spins, and the stream stays open until land(): a page that waited for the whole reply fails it.
    const srcStub = `window.__srcStub = (() => {
      const real = window.fetch
      let push = null
      const files = []
      for (let f = 0; f < 30; f++) for (let k = 0; k < 6; k++) files.push({ source: 'soulseek', username: 'peer' + f, filename: 'Music/Stub Band/Album ' + f + '/0' + k + ' - Song.flac', size: 3e7, bit_depth: 16, sample_rate: 44100, slots: true, queue: 0, length: 200 })
      window.fetch = (url, opts) => {
        if (String(url) !== '/v1/search/sources') return real(url, opts)
        const tag = JSON.parse(opts.body).query.split(' ').pop()
        const yt = Array.from({ length: 12 }, (_, i) => ({ source: 'youtube', videoId: 'stub.' + tag + '.' + i, title: 'Stub Band - Song ' + (i + 1), length: 200 + i, thumbnail: '', channel: null }))
        const enc = new TextEncoder()
        const body = new ReadableStream({ start (c) {
          c.enqueue(enc.encode('event: source\\ndata: ' + JSON.stringify({ source: 'youtube', results: yt }) + '\\n\\n'))
          push = () => { c.enqueue(enc.encode('event: source\\ndata: ' + JSON.stringify({ source: 'soulseek', results: files }) + '\\n\\n')); c.close() }
        } })
        return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
      }
      return { land: () => push && push(), restore: () => { window.fetch = real } }
    })(); true`
    const fixShotDir = join(srcShotDir, 'fixes')
    mkdirSync(fixShotDir, { recursive: true })
    const firstPick = `document.querySelector('#srcGroups input[type=checkbox]')`
    const noteNow = `(() => ({ text: $('ytNote').textContent, height: $('ytNote').getBoundingClientRect().height }))()`
    const still = {}
    for (const [width, height, mouse] of [[1440, 900, true], [1440, 900, false], [390, 844, false]]) {
      const key = width + (mouse ? '-mouse' : '')
      await viewport(width, height, 'dark')
      await evaluate(srcStub)
      await evaluate(`searchSources('stub band ${key}', ['soulseek', 'youtube']); true`)
      // This search's own YouTube rows, drawn, while the peers' group still waits on the open stream.
      const firstOnly = `document.querySelectorAll('#ytResults .item[data-vid^="stub.${key}."]').length === 12 && !!document.querySelector('#srcGroup-soulseek .slsk-spin') && !document.querySelector('#slskResults')`
      await waitFor(firstOnly, 'YouTube landed, peers pending', 5000)
      const before = await evaluate(`(() => { const c = ${firstPick}; c.scrollIntoView({ block: 'center', behavior: 'instant' }); const b = c.getBoundingClientRect(); return { top: b.top, x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
      const noteBefore = await evaluate(noteNow)
      // A mouse resting on the row; else no pointer, as a phone whose finger has left the glass.
      if (mouse) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y })
      else await evaluate('srcPointer = null; true')
      await shot(`01-${key}-youtube-before-peers`, true, fixShotDir)
      await evaluate('__srcStub.land(); true')
      await waitFor(`document.querySelectorAll('#slskResults .item').length === 30 && /Soulseek: /.test($('srcMsg').textContent)`, 'peer folders landed', 5000)
      await sleep(800)
      const after = await evaluate(`${firstPick}.getBoundingClientRect().top`)
      const noteAfter = await evaluate(noteNow)
      await shot(`02-${key}-after-peers-land`, true, fixShotDir)
      still[key] = { before: before.top, after, note: [noteBefore.height, noteAfter.height], scrollY: await evaluate('scrollY') }
      assert.ok(noteAfter.text.startsWith('Peers have FLAC copies above.') && noteAfter.height > noteBefore.height, `the YouTube note changes and grows when peers land at ${key}: ${JSON.stringify([noteBefore, noteAfter])}`)
      assert.ok(Math.abs(after - before.top) <= 2, `the first YouTube row stays put at ${key}: ${before.top} → ${after}`)
      await evaluate('__srcStub.restore(); true')
    }
    // A press in progress holds the groups still; the peer folders are drawn once it ends, and the row stays put.
    await viewport(1440, 900, 'dark')
    await evaluate(srcStub)
    await evaluate(`searchSources('stub band press', ['soulseek', 'youtube']); true`)
    await waitFor(`document.querySelectorAll('#ytResults .item[data-vid^="stub.press."]').length === 12 && !!document.querySelector('#srcGroup-soulseek .slsk-spin') && !document.querySelector('#slskResults')`, 'YouTube landed for the press check, peers pending', 5000)
    const head = await evaluate(`(() => { const h = $('srcHead-youtube'); h.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = h.getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 } })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: head.x, y: head.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: head.x, y: head.y, button: 'left', clickCount: 1 })
    await evaluate('__srcStub.land(); true')
    await sleep(500)
    assert.equal(await evaluate(`!!document.querySelector('#srcGroup-soulseek .slsk-spin') && !document.querySelector('#slskResults')`), true, 'no group is redrawn while a press is in progress')
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: head.x, y: head.y, button: 'left', clickCount: 1 })
    await waitFor(`document.querySelectorAll('#slskResults .item').length === 30`, 'peer folders drawn after the press', 5000)
    const headAfter = await evaluate(`(() => { const r = $('srcHead-youtube').getBoundingClientRect(); return r.top + r.height / 2 })()`)
    assert.ok(Math.abs(headAfter - head.y) <= 3, `the YouTube heading stays under the pointer after the press: ${head.y} → ${headAfter}`)
    still.press = { before: head.y, after: headAfter }
    await evaluate('__srcStub.restore(); true')
    result.checks.groupsHoldStill = still

    // Suggestions from messy titles: brackets and trailing marketing words, combining marks and quotes go; the
    // library's spelling of an artist wins; a left side that is not a known artist (or is another video's song) is
    // never taken for one. Run in the page against a stubbed library (restored at once) and a stubbed search.
    const fakeLib = `(() => {
      const mk = (rel, album, n, name) => ({ id: 'mb:' + rel + ':s01e' + String(n).padStart(2, '0'), key: rel + n, title: 'System of a Down · ' + album, season: 1, episode: n, seriesKey: 'mb:' + rel, music: { artist: 'System of a Down', title: name }, sha256: rel + n, size: 1e7, local: true, source: 'stub' })
      return [...[[1, 'Attack'], [4, 'Hypnotize'], [11, 'Lonely Day']].map(([n, t]) => mk('hyp', 'Hypnotize', n, t)),
        ...[[1, 'Soldier Side (intro)'], [2, 'B.Y.O.B.'], [3, 'Revenga']].map(([n, t]) => mk('mez', 'Mezmerize', n, t))]
    })()`
    const critiqueTitles = ['System Of A Down - Hypnotize (Official HD Video)', 'Hypnotize - Hypnotize - HQ (2005) Lyrics', 'SOAD - Mezmerize (BLACK SCREEN) - Full Album', 'System Of A Down  Hypnotize (2005) Full Album', 'Soldier Side - Intro', 'S\u0332y\u0332stem of a D\u0332own - Toxicity (Official Video)', '"Un Amour Si Grand…" (Official Audio)']
    const searchPool = ['System Of A Down - Soldier Side', 'System Of A Down - B.Y.O.B.', 'System Of A Down - Lonely Day'].map((title, i) => ({ videoId: 'pool' + i, title, length: 240 }))
    const suggest = (withLibrary, query) => evaluate(`(() => {
      const kept = S.entries
      if (${withLibrary}) S.entries = ${fakeLib}
      try {
        return ${JSON.stringify(critiqueTitles)}.map((title, i) => {
          const s = ytSuggest([{ videoId: 'crit' + i, title, length: /Full Album/.test(title) ? 2600 : 240 }], [${JSON.stringify(query)}], ${JSON.stringify(searchPool)})
          return [s.artist, s.album, s.titles[0], s.year]
        })
      } finally { S.entries = kept }
    })()`)
    const plain = await suggest(false, 'System of a Down')
    assert.deepEqual(plain, [
      ['System Of A Down', 'Hypnotize', 'Hypnotize', ''],
      ['', 'Hypnotize', 'Hypnotize', '2005'],
      ['System of a Down', 'Mezmerize', 'Mezmerize', ''],
      ['System Of A Down', 'Hypnotize', 'Hypnotize', '2005'],
      ['', 'Soldier Side - Intro', 'Soldier Side - Intro', ''],
      ['System of a Down', 'Toxicity', 'Toxicity', ''],
      ['', 'Un Amour Si Grand…', 'Un Amour Si Grand…', '']
    ], 'clean suggestions without a library')
    const withLibrary = await suggest(true, 'System of a Down')
    assert.deepEqual(withLibrary, [
      ['System of a Down', 'Hypnotize', 'Hypnotize', ''],
      ['System of a Down', 'Hypnotize', 'Hypnotize', ''],
      ['System of a Down', 'Mezmerize', 'Mezmerize', ''],
      ['System of a Down', 'Hypnotize', 'Hypnotize', '2005'],
      ['System of a Down', 'Mezmerize', 'Soldier Side (intro)', ''],
      ['System of a Down', 'Toxicity', 'Toxicity', ''],
      ['', 'Un Amour Si Grand…', 'Un Amour Si Grand…', '']
    ], 'the library spells the artist and files a known song under its album')
    // Searching the song's name: a left side that is another video's song is no artist.
    const bySong = await suggest(false, 'soldier side')
    assert.deepEqual(bySong[4], ['', 'Soldier Side - Intro', 'Soldier Side - Intro', ''], 'a song name is not taken for an artist')
    for (const row of [...plain, ...withLibrary, ...bySong]) assert.doesNotMatch(row.join(' '), /\bHQ\b|\bHD\b|lyrics|official|full album|black screen|[\u0300-\u036f"]/i, 'no upload noise reaches a suggestion: ' + row)
    result.checks.suggestions = { titles: critiqueTitles, plain, withLibrary }

    // Unbracketed upload noise goes wherever it stands; real words that only look like it stay.
    const noisy = [
      ['Pink Floyd - Time 1080p BEST QUALITY', 'Pink Floyd - Time'],
      ['1080p BEST QUALITY Pink Floyd - Comfortably Numb', 'Pink Floyd - Comfortably Numb'],
      ['Daft Punk - Get Lucky [1080p] BEST QUALITY', 'Daft Punk - Get Lucky'],
      ['Queen - Bohemian Rhapsody 4K HD Remastered 2011', 'Queen - Bohemian Rhapsody'],
      ['Nirvana - Come As You Are | Official Music Video | 720p60', 'Nirvana - Come As You Are'],
      ['Adele - Hello Lyric Video HQ Audio', 'Adele - Hello'],
      ['Radiohead - OK Computer Full Album High Quality', 'Radiohead - OK Computer'],
      ['BTS - Dynamite M/V 60fps', 'BTS - Dynamite'],
      ['Miles Davis - So What (Live 1959) 320 kbps', 'Miles Davis - So What (Live 1959)'],
      ['Prince - 1999 (2019 Remaster)', 'Prince - 1999'],
      ['Lyrical Gangsta - HDMI Blues', 'Lyrical Gangsta - HDMI Blues'],
      ['Official Secrets - Remasters of War', 'Official Secrets - Remasters of War']
    ]
    const cleaned = await evaluate(`${JSON.stringify(noisy.map(n => n[0]))}.map(ytCleanTitle)`)
    assert.deepEqual(cleaned, noisy.map(n => n[1]), 'title noise stripped wherever it stands, real words kept')
    result.checks.titleNoise = noisy.map(([before], i) => ({ before, after: cleaned[i] }))

    // Failure sentences, matched against the relay's own words (refused network, age gate) and YouTube's; whole
    // words only: a rate limit or a full disk is none of them.
    const fails = [
      ['YouTube is refusing downloads from this relay\'s network (its bot check). Search still works; saving needs another network.', 'YouTube blocks saves from this relay’s network. Try later, or from another network.'],
      ['YouTube is refusing downloads from this network', 'YouTube blocks saves from this relay’s network. Try later, or from another network.'],
      ['YouTube did not send “Dawn”: Sign in to confirm your age. This video may be inappropriate for some users.', 'This video is age-restricted, which needs an account. Pick another upload.'],
      ['ERROR: Private video. Sign in if you have been granted access to this video', 'This video is private or was removed. Pick another upload.'],
      ['Video unavailable. This video has been removed by the uploader', 'This video is private or was removed. Pick another upload.'],
      ['Video unavailable. The uploader has not made this video available in your country', 'This video is blocked where the relay is. Pick another upload.'],
      ['The folder “Test Band - Morning [YouTube]” already holds another album', 'The album folder already holds other files. Change the album name or year.'],
      ['Source stalled', 'YouTube stopped sending. Try again.'],
      ['ERROR: Unable to download webpage: HTTP Error 429', ''],
      ['No space left on device (storage full)', '']
    ]
    assert.deepEqual(await evaluate(`${JSON.stringify(fails.map(f => f[0]))}.map(ytFailHint)`), fails.map(f => f[1]), 'failure sentences')
    // On a card the sentence leads and YouTube's words wait under "Details", also for a skipped track; the
    // opened message survives the once-a-second redraw.
    // Drawn and read in one go: the 4 s refresh puts the relay's own jobs back.
    const cards = await evaluate(`(() => { window.__keptJobs = S.jobs; S.jobs = [
      { jobId: 'e2e-age', plugin: 'youtube', status: 'failed', phase: 'failed', title: 'Test Band · Morning', fileCount: 1, error: ${JSON.stringify(fails[2][0])}, created: Date.now() },
      { jobId: 'e2e-skip', plugin: 'youtube', status: 'done', phase: 'done', title: 'Test Band · Evening', fileCount: 2, skipped: [{ track: 2, title: 'Dusk', error: ${JSON.stringify(fails[1][0])} }], created: Date.now() - 1000 }
    ]; renderSrcJobs(); document.querySelector('[data-job="e2e-age"] details').open = true; renderSrcJobs()
      document.querySelector('#srcJobs').scrollIntoView({ block: 'center', behavior: 'instant' })
      return [...document.querySelectorAll('#srcJobs [data-job^="e2e-"]')].map(c => ({ text: c.querySelector('.info').innerText, why: c.querySelector('details.why')?.open }))
    })()`)
    assert.match(cards[0].text, /This video is age-restricted, which needs an account\. Pick another upload\.\nDetails\nYouTube did not send “Dawn”: Sign in to confirm your age/, 'the sentence leads, the provider text is the detail')
    assert.equal(cards[0].why, true, 'an opened message stays open across a redraw')
    assert.match(cards[1].text, /Not saved: Dusk\. YouTube blocks saves from this relay’s network\. Try later, or from another network\.\nDetails/, 'a skipped track says why in plain words')
    assert.equal(cards[1].why, false)
    await shot('03-job-card-plain-errors-1440-dark', true, reviewShotDir)
    await evaluate(`S.jobs = window.__keptJobs; renderSrcJobs(); true`)
    result.checks.failSentences = { fails, cards }

    // A started button follows its job, and gets its normal state back when the job leaves the list (dismissed or
    // trimmed) once a list asked for after the start says so; a list older than the start changes nothing.
    const sync = await evaluate(`(() => {
      const mk = key => h('button', { 'data-src-key': key, 'data-label': 'Save album' }, 'Save album')
      const gone = mk('s:e2e-gone'), early = mk('s:e2e-early')
      slskStarted.set('e2e-gone', { id: 'e2e-none', at: S.jobsAsked - 1 })
      slskStarted.set('e2e-early', { id: 'e2e-none', at: S.jobsAsked + 1 })
      srcSyncButton(gone); srcSyncButton(early)
      const out = [gone.textContent, gone.disabled, slskStarted.has('e2e-gone'), early.textContent, early.disabled]
      slskStarted.delete('e2e-early')
      return out
    })()`)
    assert.deepEqual(sync, ['Save album', false, false, 'Saving', true], 'a finished save releases its button; a request from before the save does not')
    await viewport(1440, 900, 'dark')
    await evaluate('scrollTo(0, 0); true')

    // A source that fails says so in its own group; the search as a whole is not an error.
    await ytSearch('fail band')
    await waitFor(`($('srcGroup-youtube')?.querySelector('[role=alert]')?.textContent || '').includes('YouTube search failed')`, 'YouTube failure in its group', 5000)
    assert.equal(await evaluate(`$('srcMsg').classList.contains('err')`), false, 'one failed source is not a failed search')
    result.checks.sourceErrorIsolated = await evaluate(`$('srcGroup-youtube').querySelector('[role=alert]').textContent`)

    // Save two videos as an album: suggestions from the titles, a reorder that keeps focus, track numbers in order.
    await ytSearch('test band')
    await waitFor(`document.querySelectorAll('#ytResults .yt-pick-row').length === 3`, 'YouTube rows again', 5000)
    await click('#ytResults .item:nth-child(1) input')
    await click('#ytResults .item:nth-child(2) input')
    assert.equal(await evaluate(`$('ytPickText').textContent`), '2 selected')
    await click('#ytPickSave')
    await waitFor(`$('ytSave').open`, 'save dialog')
    ui.clicks = 0
    assert.deepEqual(await evaluate(`[$('ytArtist').value, $('ytTrack-0').value, $('ytTrack-1').value]`), ['Test Band', 'Dawn', 'Dusk'], 'artist and cleaned titles suggested')
    await type('#ytAlbum', 'Morning')
    await type('#ytYear', '2020')
    await click('[data-mv="up-1"]')
    assert.deepEqual(await evaluate(`[$('ytTrack-0').value, document.activeElement.dataset.mv]`), ['Dusk', 'up-0'], 'a moved track keeps focus on its own button')
    await click('#ytSaveBtn')
    result.interactions.ytSave = ui.clicks
    await waitFor(`!$('ytSave').open && /YouTube/.test($('srcJobs').innerText)`, 'YouTube job card', 10_000)
    // While a save runs, the page redraws the job cards and source chips every second and gives focus back to the
    // control that had it. That must not scroll: a plain focus() pulled the page back up to the card every second
    // while the owner scrolled down. The spacer makes the page longer than a screen, as a real library is.
    const scrolls = await evaluate(`(() => {
      const pad = document.body.appendChild(h('div', { style: 'height:3000px' }))
      const one = (el, box) => {
        el.focus({ preventScroll: true })
        scrollTo(0, document.documentElement.scrollHeight)
        const y = scrollY, away = box.getBoundingClientRect().bottom < 0
        renderMirrors()
        return { y, away, after: scrollY, kept: box.contains(document.activeElement) }
      }
      const out = { card: one(document.querySelector('#srcJobs [data-job] .name'), $('srcJobs')), chip: one(document.querySelector('#srcChips [data-src]'), $('srcChips')) }
      pad.remove()
      return out
    })()`)
    for (const [what, s] of Object.entries(scrolls)) {
      assert.ok(s.away && s.kept, `the focused ${what} is off screen and keeps focus across the redraw: ${JSON.stringify(s)}`)
      assert.equal(s.after, s.y, `a redraw with the ${what} focused leaves the page where the owner scrolled it`)
    }
    result.checks.redrawKeepsScroll = scrolls
    assert.ok(!(await evaluate(`$('srcJobs').innerText`)).includes('%'), 'a YouTube job never shows a percentage')
    await waitFor(`$('toast').textContent.includes('to your library')`, 'album added toast', 30_000)
    const morning = await waitApi(async () => { const list = (await entries()).filter(e => e.title === 'Test Band · Morning'); return list.length === 2 && list }, 'YouTube album imported')
    assert.ok(morning.every(e => e.id.startsWith('yt:')), 'a YouTube album is pinned to a yt: release')
    assert.deepEqual(morning.sort((a, b) => a.episode - b.episode).map(e => e.music.title), ['Dusk', 'Dawn'], 'tracks numbered in the dialog order')
    // Dismissing the finished job gives the rows' Save buttons back; they no longer wait on a job that is gone.
    const dawnSave = `document.querySelector('#ytResults [data-src-key="y:tbDawn00001"]')`
    await waitFor(`${dawnSave}?.disabled === true`, 'the Save button follows its job')
    const followed = await evaluate(`${dawnSave}.textContent`)
    await clickText('Dismiss', '#srcJobs')
    await waitFor(`!${dawnSave}.disabled && ${dawnSave}.textContent === ${dawnSave}.dataset.label`, 'a dismissed save gives its button back', 10_000)
    await shot('01-dismissed-job-button-back-1440-dark', true, reviewShotDir)
    result.checks.dismissedJobButton = { followed, after: await evaluate(`${dawnSave}.textContent`) }
    await open('#music')
    const card = name => `[...document.querySelectorAll('#albums .album-card')].find(c => c.querySelector('.album-name').textContent === '${name}')`
    await waitFor(`!!${card('Morning')}`, 'the YouTube album on the shelf')
    await evaluate(`${card('Morning')}.querySelector('.album-open').setAttribute('data-e2e', 'morning'); true`)
    await click('[data-e2e="morning"]')
    await waitFor(`${seen('#detail [data-av]')} && document.querySelector('#detail [data-av]').textContent === 'From YouTube · AAC 128 kbps'`, 'YouTube album page verdict')
    assert.equal(await evaluate(`/lossless/i.test($('detailBody').innerText)`), false, 'nothing on a YouTube album says lossless')
    await shot('album-youtube-1440-dark', true, srcShotDir)
    await click('#detailClose')
    result.checks.youtubeAlbum = morning.map(e => e.id)

    // One video, saved on its own into the FLAC album already here: the dialog files the song under that album (the
    // library has a track of its name) and says so; Escape first gives focus back, then the save takes the FLAC
    // track's number and folds into that album as a second copy of its track.
    await ytSearch('test band')
    await waitFor(`document.querySelectorAll('#ytResults .yt-pick-row').length === 3`, 'YouTube rows for one track', 5000)
    await click('#ytResults .item:nth-child(1) .acts button')
    await waitFor(`$('ytSave').open`, 'single-track dialog')
    assert.deepEqual(await evaluate(`[$('ytArtist').value, $('ytAlbum').value, $('ytTrack-0').value, $('ytSaveBtn').textContent, document.querySelector('#ytTracks .tn').textContent, document.querySelectorAll('#ytTracks .ic-btn').length, $('ytTracksHint').hidden]`),
      ['Test Band', 'First Light', 'Dawn', 'Save track', '1', 0, true], 'one song already in an album is filed under it, with its number, and nothing to reorder')
    assert.match(await evaluate(`$('ytSaveNote').innerText`), /^Dawn is already track 1 here(, in FLAC .+?)?\. This adds a second copy\.$/, 'the dialog says the song is already here')
    assert.equal(await evaluate(`document.querySelector('#ytTracks .yt-dup').hidden`), true, 'a song only here in FLAC is no duplicate')
    await shot('03-save-single-in-library-1440-dark', true, join(srcShotDir, 'fixes'))
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(`!$('ytSave').open`, 'Escape closes the dialog')
    assert.equal(await evaluate(`document.activeElement.dataset.srcKey`), 'y:tbDawn00001', 'focus returns to the button that opened it')
    await click('#ytResults .item:nth-child(1) .acts button')
    await waitFor(`$('ytSave').open`, 'single-track dialog again')
    // A new song typed into that album goes after its last track.
    await evaluate(`$('ytTrack-0').value = ''; true`)
    await type('#ytTrack-0', 'Noon')
    await waitFor(`/This saves as track 3\\./.test($('ytSaveNote').innerText) && document.querySelector('#ytTracks .tn').textContent === '3'`, 'a new song numbered after the album')
    await evaluate(`$('ytTrack-0').value = ''; true`)
    await type('#ytTrack-0', 'Dawn')
    await waitFor(`document.querySelector('#ytTracks .tn').textContent === '1'`, 'the matching song keeps its number')
    await click('#ytSaveBtn')
    const ytDawn = await waitApi(async () => (await entries()).find(e => e.title === 'Test Band · First Light' && e.id.startsWith('yt:')), 'YouTube copy of a FLAC track')
    assert.equal(ytDawn.episode, 1, 'the copy takes the FLAC track\'s number')
    await open('#music')
    await waitFor(`${card('First Light')} && document.querySelectorAll('#albums .album-card').length === 2`, 'the YouTube copy joins the FLAC album, not a new one')
    // Saving the same video into that album again: its row says it is already here from YouTube and Save sends
    // nothing, until the owner ticks "Save again".
    await ytSearch('test band')
    await waitFor(`document.querySelectorAll('#ytResults .yt-pick-row').length === 3`, 'YouTube rows for the duplicate check', 5000)
    await click('#ytResults .item:nth-child(1) .acts button')
    await waitFor(`$('ytSave').open && $('ytAlbum').value === 'First Light' && !document.querySelector('#ytTracks .yt-dup').hidden`, 'the duplicate is named on its row')
    const jobsBefore = await evaluate(`S.jobs.length`)
    assert.doesNotMatch(await evaluate(`$('ytSaveNote').innerText`), /adds a second copy/, 'a duplicate left out is not said to add a copy')
    await click('#ytSaveBtn')
    await sleep(500)
    assert.deepEqual(await evaluate(`[$('ytSave').open, S.jobs.length, $('ytSaveMsg').textContent, document.activeElement === document.querySelector('#ytTracks .yt-dup input')]`),
      [true, jobsBefore, 'This song is already saved from YouTube. Tick Save again to add another copy.', true], 'a duplicate is not sent')
    await shot('07-save-duplicate-left-out-1440-dark', true, reviewShotDir)
    await click('#ytTracks .yt-dup input')
    await waitFor(`/^Dawn is already track 1 here.*This adds a second copy\\./.test($('ytSaveNote').innerText)`, 'the override says it adds a copy')
    await click('#ytSaveCancel')
    await waitFor(`!$('ytSave').open`, 'duplicate dialog closed')
    result.checks.duplicateSave = 'left out on its row; Save sends nothing until Save again is ticked'
    // The searches above left the page on Search: the shelf is in Listen.
    await goTab('Listen')
    await waitFor(`!$('tab-listen').hidden`, 'back on Listen', 5000)
    await evaluate(`${card('First Light')}.querySelector('.album-open').setAttribute('data-e2e', 'merged'); true`)
    await click('[data-e2e="merged"]')
    await waitFor(`(document.querySelector('#detail [data-ay]')?.textContent || '').includes('FLAC plays first')`, 'merged album page says which copy plays', 20_000)
    assert.equal(await evaluate(`document.querySelector('#detail [data-av]').textContent`), 'FLAC 16-bit 44.1 kHz', 'the merged album says what it is before what else it holds')
    assert.equal(await evaluate(`(() => { const ay = document.querySelector('#detail [data-ay]'); const box = $('detailBody').getBoundingClientRect(); const r = ay.getBoundingClientRect(); return r.width > 0 && r.right <= box.right + 0.5 })()`), true, 'what else the album holds is never cut off')
    assert.equal(await evaluate(`[...document.querySelectorAll('#detailBody [data-q]')].some(m => m.textContent === 'Also from YouTube')`), true, 'the track with a YouTube copy says so')
    // Its trash names the copy it removes, and the YouTube copy has a control of its own.
    const dawnRow = `document.querySelector('#detailBody [data-track][data-name="Dawn"]')`
    await waitFor(`${dawnRow}?.querySelector('.track-del')?.getAttribute('aria-label') === 'Delete FLAC copy of Dawn'`, 'the trash says which copy it deletes')
    assert.equal(await evaluate(`${dawnRow}.querySelector('.track-alt-del').textContent`), 'Remove YouTube copy')
    await shot('album-merged-1440-dark', true, srcShotDir)
    await shot('04-album-merged-copy-controls-1440-dark', true, join(srcShotDir, 'fixes'))
    await click('#detailBody [data-track][data-name="Dawn"] .track-alt-del')
    await click('#detailBody [data-track][data-name="Dawn"] .track-alt-del')
    await waitApi(async () => { const list = await entries(); return !list.some(e => e.key === ytDawn.key) && list.some(e => e.title === 'Test Band · First Light' && !e.id.startsWith('yt:') && e.episode === 1) }, 'only the YouTube copy removed')
    await waitFor(`document.querySelector('#detail [data-av]')?.textContent === 'FLAC 16-bit 44.1 kHz' && document.querySelector('#detail [data-ay]').hidden`, 'the FLAC album stands alone again', 20_000)
    await click('#detailClose')
    await waitFor(`!!${card('First Light')}`, 'the album is back on the shelf')
    result.checks.mergedAlbum = 'FLAC 16-bit 44.1 kHz, also from YouTube, then the YouTube copy removed on its own'
    // Words that match nothing in the library say so on Search, and Search asks outside with the same words.
    await type('#srcInput', 'zzqx')
    await waitFor(`!$('tab-search').hidden && $('findLib').textContent.includes('Nothing in your library matches “zzqx”.')`, 'Search says the library has no match', 5000)
    await click('#srcBtn')
    await waitFor(`srcRun.query === 'zzqx' && document.querySelectorAll('#ytResults .yt-pick-row').length === 3`, 'the miss searched outside')
    assert.deepEqual(browser.issues.slice(issuesBefore), [], 'console errors or warnings in the sources flow')
    mark('musicSources')
    await open('#home')

    // Follow a feed.
    ui.clicks = 0
    await clickText('Add to library', '.top')
    await clickText('Mirror a catalog')
    await type('#feedInput', stub.base + '/feed.json?token=feedsecret123')
    await clickText('Mirror', '#feedForm')
    result.interactions.followFeed = ui.clicks
    mark('followFeedClicked')
    await waitApi(async () => (await entries()).find(e => e.id === 'clip:feeditem1'), 'feed item mirrored')
    const feeds = (await settingsNow()).settings.feeds.value
    assert.deepEqual(feeds.map(f => f.label), ['127.0.0.1:' + new URL(stub.base).port + '/feed.json'])

    // Copy a channel: follow it and keep a copy.
    const channelKey = randomBytes(32).toString('hex')
    await goTab('Home')
    ui.clicks = 0
    await clickText('Add to library', '.top')
    await clickText('Copy a channel')
    await type('#copyInput', 'peartube://channel/' + channelKey)
    await clickText('Copy', '#copyForm')
    result.interactions.copyChannel = ui.clicks
    mark('copyChannelClicked')
    const copied = await waitApi(async () => { const s = await settingsNow(); return s.settings.replicate.value && s }, 'replication on')
    assert.deepEqual(copied.settings.replicateSources.value, [channelKey])
    assert.ok((await getJson('/v1/sources')).sources.some(s => s.key === channelKey))

    // Following something must not cost a bare-started relay its own tracker and library on the next start.
    const before = await getJson('/v1/status')
    relay.kill('SIGTERM')
    await new Promise(resolve => relay.once('exit', resolve))
    relay = await startRelay(env)
    const after = await getJson('/v1/status')
    assert.equal(after.tracker, before.tracker, 'same tracker after following a channel and restarting')
    assert.ok((await entries()).some(e => e.id === 'imdb:tt1254207'), 'library survives the restart')
    assert.deepEqual((await settingsNow()).restartNeeded, [], 'remembering the tracker needs no restart')
    result.checks.trackerSurvivesFollowRestart = after.tracker

    // Sharing: keep copies off again, LAN discovery on, and a HiveRelay with a key.
    await open('#home')
    ui.clicks = 0
    await goTab('Sharing')
    await clickText('Keep copies of', '#copiesCard')
    result.interactions.keepCopies = ui.clicks
    await waitApi(async () => (await settingsNow()).settings.replicate.value === false, 'replication off')

    // The settings round-trip saved a documentation address (192.0.2.10) no interface holds; put the detected one
    // back, or LAN discovery has nothing to bind.
    await fetch(base + '/v1/settings', { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ lanHost: null }) })
    await clickText('Find peers on this network', '#netCard')
    await waitApi(async () => (await getJson('/v1/status')).lan, 'LAN discovery running without a restart', 15_000)
    result.checks.lanLive = (await getJson('/v1/status')).lan
    mark('lan')

    await open('#home')
    ui.clicks = 0
    await goTab('Sharing')
    await type('#hiveInput', 'http://192.168.1.50:9100')
    await type('#hiveKey', 'hr_secretkey_123')
    await clickText('Add HiveRelay')
    result.interactions.hiveRelay = ui.clicks
    const hive = await waitApi(async () => { const s = await settingsNow(); return s.settings.hiverelays.value.length && s }, 'HiveRelay saved')
    assert.deepEqual(hive.settings.hiverelays.value.map(r => r.label), ['192.168.1.50:9100'])
    assert.ok(!JSON.stringify(hive).includes('hr_secretkey_123'), 'the key never comes back from the API')
    assert.ok(readFileSync(join(storage, 'settings.json'), 'utf8').includes('192.168.1.50:9100=hr_secretkey_123'))
    // /v1/plugins is readable without a token: it must not reveal feed tokens, keys or the import folder.
    // A feed that fails keeps its error on public status too; that error must not carry its token either.
    const current = (await settingsNow()).settings.feeds.value.map(f => f.ref)
    await fetch(base + '/v1/settings', { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ feeds: [...current, stub.base + '/missing-feed.json?token=deadfeed456'] }) })
    const failed = await waitApi(async () => (await getJson('/v1/plugins', {})).plugins.find(p => p.name === 'feed-mirror' && p.lastError), 'failing feed recorded')
    assert.match(failed.lastError, /missing-feed\.json answered 404/)
    const publicPlugins = await (await fetch(base + '/v1/plugins')).text()
    for (const secret of ['feedsecret123', 'deadfeed456', 'hr_secretkey_123', watchDir]) assert.ok(!publicPlugins.includes(secret), 'public plugin status leaks ' + secret)
    result.checks.publicPluginsRedacted = true

    // No legacy blobs on a new relay: the migration stays out of sight.
    await open('#settings')
    await waitFor(`document.querySelector('#settingsBody .card')`, 'settings rendered')
    assert.equal(await evaluate(`[...document.querySelectorAll('#settingsBody h3')].some(h => h.textContent === 'Storage')`), false)
    assert.equal((await getJson('/v1/plugins')).plugins.find(p => p.name === 'blob-rechunk').remaining || 0, 0)
    result.checks.migrationHiddenWithoutLegacy = true
    mark('flows')

    for (const [name, n] of Object.entries(result.interactions)) assert.ok(n <= 3, name + ' took ' + n + ' interactions')

    // 5. Taste gates on every place, both sizes, both schemes; then Search with results on screen and with the save
    // dialog open.
    browser.issues.length = 0
    // While the pages load, this process asks the relay for its status, one request after another. A slow page
    // load beside a relay that kept answering is the page's fault; beside a relay that went quiet it is the
    // relay's (or a starved machine's), and the failure says which. It ends when the relay does.
    result.relayStalls = []
    let probing = true
    let slowestStatusMs = 0
    const probe = (async () => {
      while (probing) {
        const at = Date.now()
        try { await (await fetch(base + '/v1/status')).arrayBuffer() } catch { break }
        const ms = Date.now() - at
        slowestStatusMs = Math.max(slowestStatusMs, ms)
        if (ms > 1000) result.relayStalls.push({ at, ms })
        await sleep(250)
      }
    })()
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      for (const scheme of ['light', 'dark']) {
        await viewport(width, height, scheme)
        for (const tab of ['home', 'listen', 'watch', 'discover', 'search', 'add', 'channels', 'sharing', 'settings']) {
          const where = width + ' ' + scheme + ' ' + tab
          const loadStart = Date.now()
          // A load that never completes keeps what it waited on too.
          await open('#' + tab).catch(err => { result.viewports.push({ where, at: loadStart, loadMs: Date.now() - loadStart, slowRequests: browser.during(loadStart, Date.now()) }); throw err })
          const loadEnd = Date.now()
          const loadMs = loadEnd - loadStart
          // A load over 3 s keeps every request it saw, so a failure names what it waited on.
          const slowRequests = loadMs > 3000 ? browser.during(loadStart, loadEnd) : undefined
          await sleep(600)
          const audit = await tasteAudit(where)
          await shot(`${tab}-${width}-${scheme}`)
          result.viewports.push({ where, at: loadStart, loadMs, ...(slowRequests ? { slowRequests } : {}), ...audit })
        }
        await open('#search')
        await type('#srcInput', 'test band')
        await click('#srcBtn')
        await waitFor(`document.querySelectorAll('#ytResults .yt-pick-row').length === 3`, 'results for the taste gates', 5000)
        await click('#ytResults .item:nth-child(1) input')
        await click('#ytResults .item:nth-child(3) input')
        await sleep(400)
        await tasteAudit(width + ' ' + scheme + ' find with results')
        await shot(`find-sources-${width}-${scheme}`, false, srcShotDir)
        await click('#ytPickSave')
        await waitFor(`$('ytSave').open`, 'save dialog for the taste gates')
        await tasteAudit(width + ' ' + scheme + ' save dialog')
        await shot(`yt-save-${width}-${scheme}`, true, srcShotDir)
        await click('#ytSaveCancel')
      }
    }
    probing = false
    await probe
    const external = browser.requests.filter(u => /ytimg\.com|youtube\.com/i.test(u))
    assert.deepEqual(external, [], 'the page never contacts YouTube or its image host')
    result.consoleIssues = [...browser.issues]
    // Forty reloads in one tab: a live-update stream left open per visit would stall the sixth for about a minute.
    const slowest = result.viewports.reduce((a, v) => v.loadMs > a.loadMs ? v : a)
    // A stream the page before held open lives long by design; name the slowest request of the load itself.
    const waitedOn = slowest.slowRequests && (slowest.slowRequests.find(r => !r.before) || slowest.slowRequests[0])
    const stalled = result.relayStalls.filter(s => s.at < slowest.at + slowest.loadMs && s.at + s.ms > slowest.at)
    assert.ok(slowest.loadMs < 5000, 'slowest page load took ' + slowest.loadMs + ' ms (' + slowest.where + ')' +
      (waitedOn ? '; slowest request ' + waitedOn.method + ' ' + waitedOn.path + ' ' + waitedOn.ms + ' ms, ' + waitedOn.status + (waitedOn.headersMs != null ? ', headers after ' + waitedOn.headersMs + ' ms' : '') : '') +
      (stalled.length
        ? '; during it the relay took ' + Math.max(...stalled.map(s => s.ms)) + ' ms to answer /v1/status to this process, so the relay or the machine stalled, not the page'
        : '; the relay answered /v1/status to this process within ' + slowestStatusMs + ' ms throughout, so the wait was in the page or the browser'))
    assert.deepEqual(browser.issues, [], 'console errors or warnings')
    mark('tasteGates')

    // A stopped relay is named in the header, in sight on the place that is open, not left as a stale error under a
    // form.
    relay.kill('SIGTERM')
    await waitFor(`[...document.querySelectorAll('#pills .pill')].some(p => p.textContent.includes('The relay cannot be reached') && p.getBoundingClientRect().width > 0)`, 'offline pill in sight', 15_000)
    await shot('offline-390-dark')
    result.checks.offlineShown = true
    result.pass = true
  } catch (err) {
    result.error = err.message
    result.consoleIssues = [...browser.issues]
    throw err
  } finally {
    writeFileSync(join(outDir, 'ui-result.json'), JSON.stringify(result, null, 2))
    await browser.close()
    await stopRelay(relay, stub, [storage, binDir, watchDir])
  }
})

// The one library (design/unified-library.md). Each behaviour is one named check: `checks[name]` is true, or it is
// what the page showed in place of what the design says. Every check runs, so one run names everything that is
// missing, and the test fails once, at its end.
test('relay web UI: one library with Home, Listen, Watch, Discover and Search', { timeout: 900_000 }, async () => {
  const shots = join(outDir, 'ui-audit/design')
  mkdirSync(shots, { recursive: true })
  const storage = mkdtempSync(join(tmpdir(), 'peartube-ui-design-storage-'))
  const binDir = mkdtempSync(join(tmpdir(), 'peartube-ui-design-bin-'))
  const watchDir = mkdtempSync(join(tmpdir(), 'peartube-ui-design-watch-'))
  const stub = await startStub()
  fakeUbit(binDir, stub.base)
  const apiPort = await freePort()
  const dhtPort = await freePort()
  // No token: the page is the owner's because this machine opens it.
  const relay = await startRelay({
    PATH: binDir + ':' + process.env.PATH,
    UBIT_BIN: join(binDir, 'ubit'),
    HOME: process.env.HOME,
    PEARTUBE_STORAGE: storage,
    PEARTUBE_API_PORT: String(apiPort),
    PEARTUBE_API_HOST: '127.0.0.1',
    PEARTUBE_DHT_PORT: String(dhtPort),
    PEARTUBE_BOOTSTRAP: '127.0.0.1:1',
    PEARTUBE_WATCH_DIR: watchDir,
    PEARTUBE_CINEMETA_URL: stub.base + '/cinemeta',
    PEARTUBE_ALLOW_PRIVATE_URLS: '1'
  })
  const base = 'http://127.0.0.1:' + apiPort
  const getJson = async path => (await fetch(base + path)).json()
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(res.status, 200, 'POST ' + path)
    return res.json()
  }
  const result = { pass: false, relay: base, checks: {}, failed: [], consoleIssues: [], screenshots: [] }
  const browser = await launchBrowser().catch(async err => { await stopRelay(relay, stub, [storage, binDir, watchDir]); throw err })
  const { evaluate } = browser
  const { click, clickText, clickName, type, press, waitFor, waitApi, viewport, open, goTab, shot, tasteAudit } = drive(browser, base, result, shots)

  // One behaviour. `fn` returns true, or what it saw; an error it throws is what it saw, too.
  const check = async (name, fn) => {
    try { result.checks[name] = await fn() } catch (err) { result.checks[name] = String(err.message || err).split('\n')[0] }
    if (result.checks[name] !== true) result.failed.push(name)
  }
  const same = (saw, want) => isDeepStrictEqual(saw, want) || { saw, want }
  // Where the page is: the panel in sight, the room the bar marks, and the address.
  const place = () => evaluate(`({
    panel: [...document.querySelectorAll('[data-panel]')].filter(p => !p.hidden).map(p => p.dataset.panel).join('+'),
    room: [...document.querySelectorAll('.rooms a[aria-current="page"]')].map(a => a.innerText.trim()).join('+'),
    hash: location.hash
  })`)
  // The text of every match that is in sight, as a reader sees it.
  const texts = selector => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed').map(e => e.innerText.trim().replace(/\\s+/g, ' ')).filter(Boolean)`)
  // Types into the Search field as a reader does, and returns the library's groups: "Albums: First Light".
  const typeFind = async words => {
    await type('#srcInput', words)
    await waitFor(`!$('tab-search').hidden && location.hash === '#search/' + encodeURIComponent(${JSON.stringify(words)})`, 'Search with “' + words + '”', 4000)
    return evaluate(`[...document.querySelectorAll('#findLib .find-group')].map(g => g.querySelector('h3').textContent + ': ' + [...g.querySelectorAll('.album-name, .ft-name, .tile-title')].map(e => e.textContent).join(', '))`)
  }
  const asked = (from, part) => [...new Set(browser.requests.slice(from).map(u => new URL(u).pathname).filter(p => p.startsWith(part)))].sort()

  try {
    await viewport(1440, 900, 'dark')

    // An empty library. A first visit opens Home, and each room says why it is empty and how to fill it.
    await open()
    await check('homeFirst', async () => same(await place(), { panel: 'home', room: 'Home', hash: '' }))
    await check('emptyLibrary', async () => {
      const saw = {}
      for (const room of ['home', 'listen', 'watch']) {
        await open('#' + room)
        saw[room] = await texts('#tab-' + room + ' .empty')
      }
      saw.way = await evaluate(`[...document.querySelectorAll('#tab-watch .empty a')].map(a => a.getAttribute('href'))`)
      return same(saw, {
        home: ['Nothing in your library yet. Add to library'],
        listen: ['No albums yet. Use Search to save one, or add a folder. Add to library'],
        watch: ['Nothing in your library yet. Add to library'],
        way: ['#add']
      })
    })

    // The library for the rest: a movie, a series of two episodes, a clip, and an album of two tracks.
    const acquire = async (id, title, path) => {
      const { jobId } = await post('/v1/acquire', { id, title, source: { url: stub.base + path } })
      await waitApi(async () => (await getJson('/v1/jobs/' + jobId)).status === 'done', title + ' added')
    }
    await acquire('imdb:tt1254207', 'Big Buck Bunny 2008', '/media/Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP.mp4')
    await acquire('imdb:tt0000002:s01e01', 'Night Ferry S01E01', '/media/clip.mkv')
    await acquire('imdb:tt0000002:s01e02', 'Night Ferry S01E02', '/media/variable.mkv')
    await acquire('clip:harbourwalk', 'Harbour Walk', '/media/clip30.mkv')
    flacAlbum(join(watchDir, 'Test Band - First Light'), 'Test Band', 'First Light', [['Dawn', 440], ['Señal', 550, 'Senal']])
    await post('/v1/plugins/watch-dir/run', {})
    await waitApi(async () => (await getJson('/v1/entries')).results.length === 6, 'six files in the library')

    // Home shows the start of each room, and the room holds the rest.
    await open('#home')
    await check('homeRows', async () => same(await evaluate(`[...document.querySelectorAll('#homeRows .home-row')].map(r => ({
      title: r.querySelector('h2').textContent,
      all: r.querySelector('.row-all').textContent + ' ' + r.querySelector('.row-all').getAttribute('href'),
      shown: [...r.querySelectorAll('.album-name, .tile-title')].map(e => e.textContent)
    }))`), [
      { title: 'Albums', all: 'All albums #listen', shown: ['First Light'] },
      { title: 'Movies and series', all: 'All video #watch', shown: ['Big Buck Bunny 2008', 'Night Ferry'] }
    ]))
    await shot('home-1440-dark')
    await check('roomsByClick', async () => {
      const saw = []
      for (const room of ['Listen', 'Watch', 'Discover', 'Home']) {
        await goTab(room)
        saw.push(await place())
      }
      await clickText('All albums', '#homeRows')
      saw.push(await place())
      return same(saw, [
        { panel: 'listen', room: 'Listen', hash: '#listen' },
        { panel: 'watch', room: 'Watch', hash: '#watch' },
        { panel: 'discover', room: 'Discover', hash: '#discover' },
        { panel: 'home', room: 'Home', hash: '#home' },
        { panel: 'listen', room: 'Listen', hash: '#listen' }
      ])
    })
    // Discover: the library's artists, and a shelf list that starts empty. Nothing is asked until a press; a press
    // opens Search with the artist in the one field and asks the sources there.
    await check('discoverArtists', async () => {
      await open('#discover')
      const chips = await texts('#discArtists .chip')
      const shelves = await texts('#discShelves p')
      const from = browser.requests.length
      await clickText('Test Band', '#discArtists')
      await waitFor(`!$('tab-search').hidden && location.hash === '#search/' + encodeURIComponent('Test Band') && $('srcInput').value === 'Test Band'`, 'Search holds the artist', 5000)
      await waitFor(`document.querySelectorAll('#srcGroup-youtube .yt-pick-row').length === 3`, 'the artist was asked of the sources', 5000)
      return same({ chips, shelves, asked: asked(from, '/v1/search/'), at: (await place()).panel }, { chips: ['Test Band'], shelves: ['A Soulseek shelf you open from Search shows here.'], asked: ['/v1/search/global', '/v1/search/sources'], at: 'search' })
    })
    await check('roomContents', async () => {
      await open('#listen')
      const listen = { count: await texts('#musicCount'), artistBands: await evaluate(`document.querySelectorAll('#albums .artist-head').length`), albums: await texts('#albums .album-name') }
      await open('#watch')
      return same({ listen, watch: await texts('#entries .tile-title') }, {
        listen: { count: ['1 album'], artistBands: 0, albums: ['First Light'] },
        watch: ['Big Buck Bunny 2008', 'Night Ferry', 'Harbour Walk']
      })
    })
    await check('oldLinks', async () => {
      const saw = {}
      for (const hash of ['#library', '#music']) {
        await open(hash)
        const at = await place()
        saw[hash] = at.panel + ' ' + at.room
      }
      return same(saw, { '#library': 'home Home', '#music': 'listen Listen' })
    })
    // The bar: the rooms, one way to add, and the relay's own pages. Peers and rates are on Sharing.
    await check('topBarWords', async () => {
      await open('#home')
      return same(await texts('.top a, .top button'), ['PearTube', 'Home', 'Listen', 'Watch', 'Discover', 'Add to library', 'Channels', 'Sharing', 'Settings'])
    })
    // The More menu holds the relay's own pages and the theme. A click outside it, Escape or Back closes it, and the
    // control that opened it takes the focus back. The theme item is the one that stays open after a press.
    await check('moreMenu', async () => {
      await viewport(1280, 900, 'dark')
      await open('#home')
      await click('#moreBtn')
      await waitFor(`!!document.querySelector('dialog.menu[open]')`, 'the More menu', 4000)
      const box = await evaluate(`(() => { const r = document.querySelector('dialog.menu').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
      const saw = {
        items: await texts('dialog.menu .mi'),
        focus: await evaluate(`!!(document.activeElement && document.activeElement.closest('dialog.menu'))`),
        scroll: await evaluate(`getComputedStyle(document.documentElement).overflow`)
      }
      // A point over the dialog's backdrop, outside the menu's box: the page behind would take the press.
      assert.ok(box.x > 20 && box.y > 20, 'the menu sits away from the page corner')
      const outside = { x: 8, y: 8 }
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: outside.x, y: outside.y })
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: outside.x, y: outside.y, button: 'left', clickCount: 1 })
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: outside.x, y: outside.y, button: 'left', clickCount: 1 })
      await sleep(400)
      const shut = await evaluate(`[!!document.querySelector('dialog.menu[open]'), document.activeElement === $('moreBtn'), location.hash]`)
      // Escape and Back close it too.
      await click('#moreBtn'); await sleep(300)
      await press('Escape'); await sleep(400)
      const esc = await evaluate(`[!!document.querySelector('dialog.menu[open]'), document.activeElement === $('moreBtn')]`)
      await click('#moreBtn'); await sleep(300)
      await evaluate('history.back()')
      await sleep(600)
      const back = await evaluate(`[!!document.querySelector('dialog.menu[open]'), location.hash]`)
      // The theme item changes the theme and leaves the menu open; Escape still closes it.
      await click('#moreBtn'); await sleep(300)
      await clickName('Theme: follow this device', 'dialog.menu')
      await sleep(300)
      const stay = await evaluate(`[!!document.querySelector('dialog.menu[open]'), document.documentElement.dataset.theme, document.activeElement?.textContent]`)
      await press('Escape'); await sleep(300)
      await evaluate(`localStorage.removeItem(THEME_KEY); applyTheme('system')`)
      await viewport(1440, 900, 'dark')
      return same({ saw, shut, esc, back, stay }, {
        saw: { items: ['Channels', 'Sharing', 'Settings', 'Theme: follow this device', 'Close'], focus: true, scroll: 'hidden' },
        shut: [false, true, '#home'],
        esc: [false, true],
        back: [false, '#home'],
        stay: [true, 'dark', 'Theme: dark']
      })
    })
    // The TVs dialog: the one TV icon opens it, a relay with no paired TV says so, the code field is labelled with
    // an example, and Escape closes it back onto the icon. No TV's network address is ever on the page.
    await check('tvDialog', async () => {
      await open('#home')
      await click('#tvBtn')
      await waitFor(`$('tvsDlg').open`, 'the TVs dialog', 4000)
      const saw = {
        title: await evaluate(`$('tvsTitle').textContent`),
        says: await texts('#tvs p'),
        field: await evaluate(`[$('pairInput').getAttribute('placeholder'), document.querySelector('label[for="pairInput"]').textContent]`),
        address: await evaluate(`/\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b/.test($('tvsDlg').innerText)`)
      }
      await press('Escape')
      await sleep(400)
      return same({ saw, shut: await evaluate('[$("tvsDlg").open, document.activeElement === $("tvBtn")]') }, {
        saw: { title: 'TVs', says: ['No TVs yet.'], field: ['K7M2QX', 'Code on the TV'], address: false },
        shut: [false, true]
      })
    })
    await check('addPage', async () => {
      await open('#home')
      const onHome = await evaluate(`$('addInput').offsetParent !== null`)
      await clickText('Add to library', '.top')
      const at = await place()
      const saw = { onHome, panel: at.panel, hash: at.hash, field: await evaluate(`$('addInput').offsetParent !== null`), marked: await evaluate(`$('addLink').getAttribute('aria-current')`), ways: await texts('#tab-add .chips .chip') }
      return same(saw, { onHome: false, panel: 'add', hash: '#add', field: true, marked: 'page', ways: ['Import folder', 'Mirror a catalog', 'Copy a channel'] })
    })
    await check('peersOnSharing', async () => {
      await open('#home')
      const bar = await evaluate(`$('pills').textContent`)
      await goTab('Sharing')
      const sharing = await evaluate(`['over the internet', 'sending now', 'receiving now'].filter(w => $('tab-sharing').textContent.includes(w))`)
      return same({ bar, sharing }, { bar: '', sharing: ['over the internet', 'sending now', 'receiving now'] })
    })
    // With no place in the address the page opens the room this browser was in last; a page that is no room is not one.
    await check('lastRoom', async () => {
      await open('#watch')
      await open()
      const afterWatch = await place()
      await goTab('Settings')
      await open()
      const afterSettings = await place()
      await open('#home')
      await open()
      return same({ afterWatch, afterSettings, afterHome: await place() }, {
        afterWatch: { panel: 'watch', room: 'Watch', hash: '' },
        afterSettings: { panel: 'watch', room: 'Watch', hash: '' },
        afterHome: { panel: 'home', room: 'Home', hash: '' }
      })
    })
    // Watch: the chip that is on is part of the address, and a chip press is no step for Back.
    await check('watchKinds', async () => {
      await open('#home')
      await goTab('Watch')
      const chips = await texts('#libKinds .chip')
      await clickText('Series', '#libKinds')
      const series = { hash: await evaluate('location.hash'), on: await texts('#libKinds .chip[aria-pressed="true"]'), tiles: await texts('#entries .tile-title') }
      await evaluate('history.back(); true')
      await sleep(500)
      const back = await place()
      await open('#watch/clips')
      const direct = { on: await texts('#libKinds .chip[aria-pressed="true"]'), tiles: await texts('#entries .tile-title') }
      return same({ chips, series, back, direct }, {
        chips: ['All 3', 'Movies 1', 'Series 1', 'Clips 1'],
        series: { hash: '#watch/series', on: ['Series 1'], tiles: ['Night Ferry'] },
        back: { panel: 'home', room: 'Home', hash: '#home' },
        direct: { on: ['Clips 1'], tiles: ['Harbour Walk'] }
      })
    })
    await shot('watch-clips-1440-dark')

    // Search: one field for everything. Typing narrows the library and asks nobody.
    await check('oneFindField', async () => {
      await open('#home')
      const fields = await evaluate(`[...document.querySelectorAll('input, textarea, select')].filter(e => e.offsetParent !== null && !['checkbox', 'radio', 'range', 'hidden'].includes(e.type)).map(e => ({ id: e.id, label: e.getAttribute('aria-label'), example: e.placeholder }))`)
      return same(fields, [{ id: 'srcInput', label: 'Search', example: 'Blue Train' }])
    })
    await check('findInLibrary', async () => {
      await open('#home')
      const from = browser.requests.length
      const saw = {
        album: await typeFind('first light'),
        anyOrder: await typeFind('LIGHT  band'),
        track: await typeFind('dawn'),
        noAccent: await typeFind('senal'),
        trackAndArtist: await typeFind('test band señal'),
        series: await typeFind('ferry'),
        clip: await typeFind('harbour'),
        nothing: await typeFind('zzqx'),
        says: await texts('#findLib .empty'),
        asked: asked(from, '/v1/search/')
      }
      return same(saw, {
        album: ['Albums: First Light'],
        anyOrder: ['Albums: First Light'],
        track: ['Tracks: Dawn'],
        noAccent: ['Tracks: Señal'],
        trackAndArtist: ['Tracks: Señal'],
        series: ['Movies and series: Night Ferry'],
        clip: ['Clips: Harbour Walk'],
        nothing: [],
        says: ['Nothing in your library matches “zzqx”.'],
        asked: []
      })
    })
    // Enter asks outside the library with the same words: the sources that are on, and other relays.
    await check('enterAsksOutside', async () => {
      await open('#search')
      await typeFind('test band')
      const from = browser.requests.length
      await press('Enter')
      await waitFor(`document.querySelectorAll('#srcGroup-youtube .yt-pick-row').length === 3`, 'YouTube rows after Enter', 8000)
      await waitFor(`!$('globalWrap').hidden && $('globalMsg').textContent.startsWith('No relay has it yet')`, 'an answer from the other relays', 8000)
      return same({ asked: asked(from, '/v1/search/'), library: await texts('#findLib .find-group h3'), relays: await texts('#globalHead') }, { asked: ['/v1/search/global', '/v1/search/sources'], library: ['Albums'], relays: ['On other relays'] })
    })
    await shot('find-asked-1440-dark')
    // Other relays are a choice beside the sources. Off, the words go to no relay, and a reload keeps the choice.
    await check('relaysChip', async () => {
      const chip = `document.querySelector('#srcChips [data-src="relays"]')`
      const on = await evaluate(`[${chip}.textContent, ${chip}.getAttribute('aria-pressed')]`)
      await click('#srcChips [data-src="relays"]')
      const off = await evaluate(`[${chip}.textContent, ${chip}.getAttribute('aria-pressed'), $('globalWrap').hidden]`)
      const from = browser.requests.length
      await click('#srcBtn')
      await waitFor(`document.querySelectorAll('#srcGroup-youtube .yt-pick-row').length === 3`, 'YouTube rows with the relays off', 8000)
      await sleep(800)
      const askedOff = asked(from, '/v1/search/')
      await open('#search')
      const kept = await evaluate(`${chip}.getAttribute('aria-pressed')`)
      await click('#srcChips [data-src="relays"]')
      return same({ on, off, askedOff, kept, again: await evaluate(`${chip}.getAttribute('aria-pressed')`) }, { on: ['✓ Other relays', 'true'], off: ['Other relays', 'false', true], askedOff: ['/v1/search/sources'], kept: 'false', again: 'true' })
    })
    // A link in the field is not searched for: Search says what it is and hands it to Add to library.
    await check('linkInFind', async () => {
      await open('#home')
      const link = stub.base + '/media/Random.Clip.Name.mp4'
      const from = browser.requests.length
      await type('#srcInput', link)
      await waitFor(`!$('tab-search').hidden && !!document.querySelector('#findLib .find-link')`, 'Search with a link', 4000)
      const says = await texts('#findLib .find-link span')
      await clickText('Add to library', '#findLib')
      const at = await place()
      return same({ says, panel: at.panel, carried: await evaluate(`$('addInput').value`) === link, asked: asked(from, '/v1/').filter(p => /search|identify|acquire/.test(p)) }, { says: ['This is a link.'], panel: 'add', carried: true, asked: [] })
    })

    // ==== The rest of the design: Listen's three views, the page of an album, an artist and a title, the words a
    // save wears, and the music player with its list of coming tracks. Two more albums first: four tracks by one
    // artist and two by another, each long enough to outlast the checks that play it.
    flacAlbum(join(watchDir, 'Test Band - Night Signal'), 'Test Band', 'Night Signal', [['Beacon', 320], ['Lantern', 360], ['Mist', 400], ['Quay', 480]], 30)
    flacAlbum(join(watchDir, 'Sea Choir - Tide Songs'), 'Sea Choir', 'Tide Songs', [['Foam', 300], ['Tide', 340]], 30)
    await post('/v1/plugins/watch-dir/run', {})
    await waitApi(async () => (await getJson('/v1/entries')).results.length === 12, 'the two albums imported')
    await viewport(1440, 900, 'dark')
    const quoted = JSON.stringify
    // The names of the controls a reader can see inside `scope`.
    const names = scope => evaluate(`[...document.querySelectorAll(${quoted(scope)} + ' button, ' + ${quoted(scope)} + ' a, ' + ${quoted(scope)} + ' select, ' + ${quoted(scope)} + ' input, ' + ${quoted(scope)} + ' summary')].filter(${VIS}).map(${NAME})`)
    // Opens an album from its cover on the shelf, the way a reader does.
    const openAlbum = async name => {
      const card = `[...document.querySelectorAll('#albums .album-card')].find(c => c.querySelector('.album-name')?.textContent === ${quoted(name)})`
      await waitFor(`!!${card}`, 'the album ' + name + ' on the shelf', 5000)
      const key = await evaluate(card + '.dataset.tile')
      await click('#albums [data-tile=' + quoted(key) + '] .album-open')
      await waitFor(`$('detailTitle').textContent === ${quoted(name)} && ${seen('#detail [data-album]')}`, 'the page of ' + name, 5000)
    }
    // Nothing is playing when a check starts: the page keeps its list across a reload, and an album's Play
    // resumes its own album instead of starting it again. `Stop music` in the player empties the list.
    const stopMusic = async () => {
      await open('#music')
      if (!await evaluate(seen('#np'))) return
      // Both pages have a command to stop music. On the old page it is Clear inside the queue.
      if (await evaluate(`!!$('npStop')`)) {
        await click('#npArt')
        await clickName('Stop music', '[data-panel="playing"]')
      } else {
        await click('#npQueueBtn')
        await click('#npClear')
      }
      await waitFor(`queue.length === 0 && (!audioEl || audioEl.paused)`, 'the music stopped', 5000)
    }
    // Starts an album from its own page, from silence, and waits for sound.
    const playAlbum = async name => {
      await stopMusic()
      await open('#music')
      await openAlbum(name)
      await clickName('Play', '#detail')
      await waitFor(`!!audioEl && !audioEl.paused && audioEl.currentTime > 0.3`, 'sound from ' + name, 25_000)
    }
    // Opens the page of one title from its tile in Watch. A tile under `Keep watching` plays at once, so this
    // takes the title's own tile.
    const openTitle = async name => {
      const tile = `[...document.querySelectorAll('#entries .tile:not(:has(.tile-progress))')].find(t => t.querySelector('.tile-title')?.textContent === ${quoted(name)})`
      await waitFor(`!!${tile}`, 'the tile for ' + name, 5000)
      const key = await evaluate(tile + '.dataset.tile')
      await click('#entries .tile[data-tile=' + quoted(key) + ']:not(:has(.tile-progress))')
      await waitFor(`$('detailTitle').textContent === ${quoted(name)} && ${seen('#detail [data-play]')}`, 'the page of ' + name, 5000)
    }
    // The music player, from the dock.
    const openPlayer = async () => {
      await clickName('Open player', '#np')
      await waitFor(`[...document.querySelectorAll('[data-panel="playing"]')].some(${VIS})`, 'the music player', 8000)
    }
    // The coming tracks, wherever the page shows them. The one that plays says so. A row that only names where the
    // tracks come from (`Then · <album>`) is a label, not a track, so it is left out; `playerText` reads those.
    const queueRows = () => evaluate(`(() => {
      const box = [...document.querySelectorAll('[data-panel="playing"], #npQueue, [data-queue]')].filter(${VIS})[0]
      if (!box) return 'no list of coming tracks in sight'
      const named = r => r.querySelector('[data-name]') || (r.dataset && r.dataset.name ? r : null)
      return [...box.querySelectorAll('li, [data-track]')].filter(${VIS}).filter(r => named(r) || r.querySelector('.nq-name')).map(r => {
        const by = named(r)
        const name = by ? by.dataset.name : (r.querySelector('.nq-name') || {}).textContent
        const now = r.getAttribute('aria-current') === 'true' || !!r.querySelector('[aria-current="true"]')
        return String(name).trim().replace(/\\s+/g, ' ') + (now ? ' (playing)' : '')
      })
    })()`)
    // What the music player says, as one line, so a check can read the order of its parts.
    const playerText = () => evaluate(`(() => {
      const box = [...document.querySelectorAll('[data-panel="playing"]')].filter(${VIS})[0]
      return box ? box.innerText.replace(/\\s+/g, ' ').trim() : ''
    })()`)
    // `Play next` or `Play last`, wherever the page keeps it: in sight, or behind that page's More.
    const queueAction = async (word, scope) => {
      const there = await evaluate(`[...document.querySelectorAll(${quoted(scope)} + ' button, ' + ${quoted(scope)} + ' a')].filter(${VIS}).some(e => ${NAME}(e) === ${quoted(word)})`)
      if (!there) {
        await clickName('More', scope, false)
        await waitFor(`!!document.querySelector('dialog.menu[open]')`, 'the More menu', 4000)
        await clickName(word, 'dialog.menu')
      } else {
        await clickName(word, scope)
      }
      await sleep(500)
    }

    // Listen: one control with three views, the count, and a switch for what is saved here. Albums are one flat
    // grid of square covers, each with the album and the artist under it.
    await check('listenAlbums', async () => {
      await open('#listen')
      await shot('listen-albums-1440-dark')
      return same({
        views: await texts('#listenSeg button'),
        on: await texts('#listenSeg button[aria-pressed="true"]'),
        count: await texts('#musicCount'),
        savedSwitch: (await names('#listenCtl')).filter(n => /saved/i.test(n)),
        albums: await evaluate(`[...document.querySelectorAll('#albums .album-card')].map(c => c.querySelector('.album-name').textContent + ' — ' + ((c.querySelector('.album-artist') || {}).textContent || 'no artist under the name'))`),
        artistBands: await evaluate(`document.querySelectorAll('#albums .artist-head').length`),
        cover: await evaluate(`(() => {
          const a = document.querySelector('#albums .album-card .sleeve, #albums .album-card img')
          if (!a) return 'no cover'
          const r = a.getBoundingClientRect()
          return Math.abs(r.width - r.height) <= 1 ? 'square' : Math.round(r.width) + ' by ' + Math.round(r.height)
        })()`)
      }, {
        views: ['Albums', 'Artists', 'Tracks'],
        on: ['Albums'],
        count: ['3 albums'],
        savedSwitch: ['Saved here'],
        albums: ['First Light — Test Band', 'Night Signal — Test Band', 'Tide Songs — Sea Choir'],
        artistBands: 0,
        cover: 'square'
      })
    })
    await check('listenArtists', async () => {
      await open('#listen')
      await clickText('Artists', '#listenSeg')
      await sleep(400)
      const at = await place()
      const saw = {
        hash: at.hash,
        room: at.room,
        count: await texts('#musicCount'),
        tiles: await texts('#albums .artist-card .album-text'),
        links: await evaluate(`[...document.querySelectorAll('#albums a[href^="#artist/"]')].map(a => a.getAttribute('href'))`)
      }
      await click('#albums a[href="#artist/Sea%20Choir"]')
      await sleep(500)
      saw.went = (await place()).hash
      return same(saw, {
        hash: '#listen/artists',
        room: 'Listen',
        count: ['2 artists'],
        tiles: ['Sea Choir 1 album', 'Test Band 2 albums'],
        links: ['#artist/Sea%20Choir', '#artist/Test%20Band'],
        went: '#artist/Sea%20Choir'
      })
    })
    await check('listenTracks', async () => {
      await open('#listen')
      const from = browser.requests.length
      await clickText('Tracks', '#listenSeg')
      await sleep(400)
      const rows = `[...document.querySelectorAll('#albums [data-track]')].filter(${VIS}).map(r => r.dataset.name)`
      const saw = {
        hash: (await place()).hash,
        count: await texts('#musicCount'),
        rows: await evaluate(rows),
        field: await evaluate(`(() => {
          const f = $('trackFilter')
          if (!f || !${VIS}(f)) return 'no field to filter the tracks'
          return { label: (((f.labels || [])[0] || {}).textContent || f.getAttribute('aria-label') || '').trim(), example: f.placeholder }
        })()`)
      }
      await type('#trackFilter', 'mist')
      await sleep(600)
      saw.filtered = await evaluate(rows)
      saw.asked = asked(from, '/v1/search/')
      return same(saw, {
        hash: '#listen/tracks',
        count: ['8 tracks'],
        rows: ['Beacon', 'Dawn', 'Foam', 'Lantern', 'Mist', 'Quay', 'Señal', 'Tide'],
        field: { label: 'Filter tracks', example: 'blue in green' },
        filtered: ['Mist'],
        asked: []
      })
    })
    // An album has a page of its own, under Listen: the word, the title, the artist as a link, one line of facts,
    // a quieter line, the three actions, the tracks, and more by the same artist. Back leaves it in one step.
    await check('albumPage', async () => {
      await open('#listen')
      await openAlbum('Night Signal')
      await waitFor(`!!(document.querySelector('#detail [data-av]') || {}).textContent`, 'what the album is', 20_000)
      await shot('album-page-1440-dark')
      const at = await place()
      const saw = {
        panel: at.panel,
        room: at.room,
        page: at.hash.startsWith('#album/'),
        word: await texts('#detail .eyebrow'),
        title: await evaluate(`$('detailTitle').textContent`),
        artistLink: await evaluate(`(() => { const a = document.querySelector('#detail .page-head a[href^="#artist/"]'); return a ? a.getAttribute('href') : 'no link to the artist' })()`),
        facts: (await evaluate(`document.querySelector('#detail [data-am]').textContent`)).split(' · ')[0],
        what: await evaluate(`document.querySelector('#detail [data-av]').textContent`),
        where: (await evaluate(`document.querySelector('#detail [data-aq]').textContent`)).includes('Saved here'),
        acts: (await names('#detail .page-acts')).map(n => n.split(' ')[0]),
        tracks: await evaluate(`[...document.querySelectorAll('#detail [data-track]')].map(r => r.dataset.name)`),
        moreBy: await texts('#detail .sec-head'),
        moreCards: await evaluate(`[...document.querySelectorAll('#detail .album-grid .album-name')].map(e => e.textContent)`)
      }
      await clickName('Back', '#detail')
      await sleep(500)
      saw.back = (await place()).hash
      return same(saw, {
        panel: 'detail',
        room: 'Listen',
        page: true,
        word: ['Album'],
        title: 'Night Signal',
        artistLink: '#artist/Test%20Band',
        facts: '4 tracks',
        what: 'FLAC 16-bit 44.1 kHz',
        where: true,
        acts: ['Play', 'Shuffle', 'More'],
        tracks: ['Beacon', 'Lantern', 'Mist', 'Quay'],
        moreBy: ['More by Test Band'],
        moreCards: ['First Light'],
        back: '#listen'
      })
    })
    await check('artistPage', async () => {
      await open('#listen')
      await openAlbum('Night Signal')
      await clickText('Test Band', '#detail')
      await sleep(600)
      const at = await place()
      return same({
        panel: at.panel,
        room: at.room,
        hash: at.hash,
        word: await texts('#detail .eyebrow'),
        name: await evaluate(`$('detailTitle').textContent`),
        facts: await evaluate(`document.querySelector('#detail .facts').textContent`),
        acts: (await names('#detail .page-acts')).map(n => n.split(' ')[0]).slice(0, 2),
        albums: await evaluate(`[...document.querySelectorAll('#detail .album-name')].map(e => e.textContent)`),
        tracks: await evaluate(`[...document.querySelectorAll('#detail [data-track]')].map(r => r.dataset.name)`)
      }, {
        panel: 'detail',
        room: 'Listen',
        hash: '#artist/Test%20Band',
        word: ['Artist'],
        name: 'Test Band',
        facts: '2 albums · 6 tracks',
        acts: ['Play', 'Shuffle'],
        albums: ['First Light', 'Night Signal'],
        tracks: ['Dawn', 'Señal', 'Beacon', 'Lantern', 'Mist', 'Quay']
      })
    })
    // A title has a page of its own, under Watch. A clip says it is a clip, and nothing on it joins a music list.
    await check('titlePage', async () => {
      await open('#watch')
      await openTitle('Harbour Walk')
      const at = await place()
      // Rule 2: a film never enters the music list, so nothing on its page adds it. Look inside More as well.
      await clickName('More', '#detail', false)
      await sleep(300)
      const menuOpen = await evaluate(`!!document.querySelector('dialog.menu[open]')`)
      const acts = [...await names('#detail'), ...(menuOpen ? await names('dialog.menu') : [])]
      if (menuOpen) { await press('Escape'); await sleep(300) }
      const saw = {
        panel: at.panel,
        room: at.room,
        page: at.hash.startsWith('#title/'),
        word: await texts('#detail .eyebrow'),
        title: await evaluate(`$('detailTitle').textContent`),
        play: await evaluate(seen('#detail [data-play]')),
        download: await evaluate(seen('#detail [data-download]')),
        musicWords: acts.filter(n => /play next|play last|up next/i.test(n))
      }
      await clickName('Back', '#detail')
      await sleep(500)
      saw.back = (await place()).hash
      return same(saw, { panel: 'detail', room: 'Watch', page: true, word: ['Clip'], title: 'Harbour Walk', play: true, download: true, musicWords: [], back: '#watch' })
    })
    await check('movieVersions', async () => {
      const { results } = await getJson('/v1/entries')
      const film = results.find(e => e.id === 'imdb:tt1254207')
      const clip = results.find(e => e.id === 'clip:harbourwalk')
      // Both files exist on the relay. List them as two versions of one film and check the actual stream choices.
      return browser.withJson({ [base + '/v1/entries']: { results: [film, { ...clip, id: film.id, title: film.title }] } }, async () => {
        await open('#watch/movies')
        assert.deepEqual(await texts('#entries .tile-title'), [film.title])
        await openTitle(film.title)
        const rows = '#detail .page-body .row-item'
        const streams = await evaluate(`[...document.querySelectorAll('${rows} [data-download]')].map(a => { const u = new URL(a.href); u.searchParams.delete('download'); return u.pathname + u.search }).sort()`)
        const expected = [film, clip].map(e => { const u = new URL(e.streamUrl, base); return u.pathname + u.search }).sort()
        return same({ page: (await place()).panel, kind: await texts('#detail .eyebrow'), count: await texts('#detail .sec-head'), streams },
          { page: 'detail', kind: ['Movie'], count: ['2 versions'], streams: expected })
      })
    })
    // Play both real files. The page must use the finished first episode, not a click on a card, to pick the second.
    await check('nextEpisode', async () => {
      await open('#watch/series')
      await openTitle('Night Ferry')
      const at = await place()
      const action = '#detail .page-acts [data-play]'
      const names = await texts('#detail .page-body .label')
      assert.deepEqual(names.map(n => n.slice(0, 6)), ['S01E01', 'S01E02'])
      assert.deepEqual(await texts(action), ['Play S1 E1'])
      await click(action)
      await waitFor(`$('pPlayBtn').textContent === 'Replay'`, 'the first episode finishes', 40_000)
      await click('#pCloseBtn')
      await waitFor(`document.querySelector('${action}')?.textContent === 'Next episode S1 E2'`, 'the next episode on the series page', 8000)
      await click(action)
      await waitFor(`$('pTitle').textContent.includes('S01E02')`, 'the player opens episode two', 8000)
      await waitFor(`$('pPlayBtn').textContent === 'Replay'`, 'the second episode finishes', 40_000)
      await click('#pCloseBtn')
      return same({ kind: await texts('#detail .eyebrow'), panel: at.panel, room: at.room }, { kind: ['Series'], panel: 'detail', room: 'Watch' })
    })
    // With All: posters first and clips under their own heading. A selected kind has only that grid.
    await check('watchGroups', async () => {
      await open('#watch')
      // A `Keep watching` row rides above these when something is part-watched; this check is about the rest.
      const all = (await evaluate(`[...document.querySelectorAll('#entries section')].filter(${VIS}).map(s => s.querySelector('h2').textContent + ': ' + [...s.querySelectorAll('.tile-title')].map(e => e.textContent).join(', '))`))
        .filter(s => !s.startsWith('Keep watching'))
      await open('#watch/clips')
      const one = {
        sections: await evaluate(`[...document.querySelectorAll('#entries section')].filter(s => !/Keep watching/.test(s.textContent)).length`),
        tiles: await texts('#entries .tile-title')
      }
      return same({ all, one }, {
        all: ['Movies and series: Big Buck Bunny 2008, Night Ferry', 'Clips: Harbour Walk'],
        one: { sections: 0, tiles: ['Harbour Walk'] }
      })
    })
    await check('clipTilesAreWide', async () => {
      await open('#watch')
      return same(await evaluate(`[...document.querySelectorAll('#entries .tile')].filter(${VIS}).filter(t => !/Keep watching/.test(((t.closest('section') || {}).textContent) || '')).map(t => {
        const art = t.querySelector('.tile-art, .poster')
        if (!art) return (t.querySelector('.tile-title') || {}).textContent + ': no picture'
        const r = art.getBoundingClientRect()
        return (t.querySelector('.tile-title') || {}).textContent + ': ' + (r.width > r.height ? 'wider than tall' : 'taller than wide')
      })`), ['Big Buck Bunny 2008: taller than wide', 'Night Ferry: taller than wide', 'Harbour Walk: wider than tall'])
    })
    // A provider reply with one album and a single track. Only these three HTTP replies are fixtures. Use the
    // actual Search field and Browse control. Do not click Save: this checks the words, not a transfer from a peer.
    await check('saveWords', async () => {
      const files = ['01 Foam.flac', '02 Tide.flac', '03 Spray.flac', '01 Lone Track.flac'].map((name, i) => ({
        source: 'soulseek', username: i < 3 ? 'albumpeer' : 'trackpeer', filename: (i < 3 ? 'Shared/Tide Songs/' : 'Shared/One Off/') + name,
        size: 41_000_000, length: 240, bit_depth: 16, sample_rate: 44100, slots: true, queue: 0
      }))
      return browser.withJson({
        [base + '/v1/plugins']: { plugins: [{ name: 'soulseek', configured: true, status: 'ok' }] },
        [base + '/v1/search/sources']: { sources: ['soulseek'], results: files },
        [base + '/v1/providers/soulseek/browse']: { username: 'albumpeer', files: files.slice(0, 3), tracks: 3, size: 123_000_000 }
      }, async () => {
        // On main the same source controls are under Music. Compare the labels, not the route that holds them.
        await open('#search')
        if (!await evaluate(`document.getElementById('tab-search') !== null`)) await open('#music')
        await waitFor(`!!document.querySelector('#srcChips [data-src="soulseek"][aria-pressed="true"]')`, 'a source available to search', 5000)
        await type('#srcInput', 'tide songs')
        await press('Enter')
        await waitFor(`document.querySelectorAll('#slskResults .item').length === 2`, 'album and single track offered')
        const choices = await texts('#slskResults .item button.primary')
        await clickText('Browse', '#slskResults')
        await waitFor(seen('#slskFolders .slsk-folder'), 'the matching folder')
        const folder = await texts('#slskFolders .slsk-folder button.primary')
        if (!await evaluate(seen('#slskFolders .slsk-file'))) await clickText('Files', '#slskFolders')
        return same({ choices, folder, tracks: await texts('#slskFolders .slsk-file button') },
          { choices: ['Save album', 'Save track'], folder: ['Save folder'], tracks: ['Save track', 'Save track', 'Save track'] })
      })
    })
    // The three rows are actual imports served by this test relay. Vary which files the catalog says it holds.
    // Check the outbound requests, not the presence of a lock icon. A public saved file is the positive control.
    await check('privateAndRemoteBrowse', async () => {
      const { results } = await getJson('/v1/entries')
      const tracks = ['Dawn', 'Beacon', 'Foam'].map((name, i) => {
        const song = results.find(e => e.music?.title === name)
        assert.ok(song?.streamUrl, 'imported ' + name)
        return { ...song, private: i === 1, locked: false, local: i !== 2, cachedBytes: 0 }
      })
      return browser.withJson({ [base + '/v1/entries']: { results: tracks } }, async () => {
        const from = browser.requests.length
        // #music works on both revisions. Both must be able to open an album for the traffic comparison to count.
        for (const title of ['First Light', 'Night Signal', 'Tide Songs']) {
          await open('#music')
          const id = await evaluate(`[...document.querySelectorAll('#albums .album-card')].find(c => c.querySelector('.album-name')?.textContent === ${quoted(title)})?.dataset.tile`)
          assert.ok(id, 'the album ' + title + ' is available')
          await click('#albums [data-tile=' + quoted(id) + '] .album-open')
          await waitFor(`document.querySelector('#detailTitle')?.textContent === ${quoted(title)}`, 'the page for ' + title)
          await sleep(300)
        }
        const urls = browser.requests.slice(from).map(u => new URL(u))
        const saw = tracks.map(e => ({
          cover: urls.some(u => u.pathname === '/v1/blob' && u.search === new URL(e.streamUrl, base).search),
          details: urls.some(u => u.pathname === '/v1/entries/info' && u.searchParams.get('key') === e.key)
        }))
        return same(saw, [{ cover: true, details: true }, { cover: false, details: false }, { cover: false, details: false }])
      })
    })
    // Watch's chips carry their counts, and the room offers what is saved here.
    await check('watchChips', async () => {
      await open('#watch')
      return same({ chips: await texts('#libKinds button'), saved: await texts('#watchSaved') },
        { chips: ['All 3', 'Movies 1', 'Series 1', 'Clips 1'], saved: ['Saved here'] })
    })
    await check('savedHereFilters', async () => {
      const list = await getJson('/v1/entries')
      const results = list.results.map(e => e.music?.artist === 'Sea Choir' || e.id === 'clip:harbourwalk'
        ? { ...e, local: false, cachedBytes: 0 } : e)
      return browser.withJson({ [base + '/v1/entries']: { results } }, async () => {
        const states = []
        for (const [room, control, tiles] of [['listen', '#listenSaved', '#albums .album-name'], ['watch', '#watchSaved', '#entries .tile-title']]) {
          await open('#' + room)
          const before = await texts(tiles)
          await click(control)
          const saved = await texts(tiles)
          await click(control)
          states.push({ saved, removed: before.filter(name => !saved.includes(name)), restored: isDeepStrictEqual(before, await texts(tiles)) })
        }
        return same(states, [
          { saved: ['First Light', 'Night Signal'], removed: ['Tide Songs'], restored: true },
          { saved: ['Big Buck Bunny 2008', 'Night Ferry'], removed: ['Harbour Walk'], restored: true }
        ])
      })
    })

    // ==== The dock and the music player.
    // The dock shows whenever a list exists, wherever the reader is, and its controls carry the design's names.
    await check('dockControls', async () => {
      await playAlbum('Night Signal')
      await goTab('Watch')
      await sleep(400)
      const found = await names('#np')
      // The dock's Up next also carries how far the list is (`2 of 4`), so a name is matched by how it starts.
      const has = w => found.some(n => n === w || n.startsWith(w + ' '))
      return same({
        dock: await evaluate(seen('#np')),
        missing: ['Previous', 'Next', 'Shuffle', 'Repeat', 'Up next', 'Volume', 'Open player'].filter(w => !has(w)),
        playOrPause: has('Play') || has('Pause'),
        old: found.filter(n => ['Previous track', 'Next track', 'Queue'].includes(n))
      }, { dock: true, missing: [], playOrPause: true, old: [] })
    })
    // Its top edge is the progress line, and that line is the seek control.
    await check('dockProgressLine', async () => {
      await playAlbum('Night Signal')
      await goTab('Watch')
      await sleep(400)
      const measured = await evaluate(`(() => {
        const np = $('np').getBoundingClientRect()
        const seek = $('npSeek')
        if (!seek || !${VIS}(seek)) return 'no seek control on the dock'
        const r = seek.getBoundingClientRect()
        return { belowTheTopEdge: Math.round(r.top - np.top), narrowerThanTheDock: Math.round(np.width - r.width) }
      })()`)
      return same({ onTheTopEdge: measured.belowTheTopEdge <= 8, acrossTheDock: measured.narrowerThanTheDock <= 4, measured },
        { onTheTopEdge: true, acrossTheDock: true, measured })
    })
    // The music player is a place of its own, under Listen, and closing it leaves the music playing.
    await check('openPlayerPlace', async () => {
      await playAlbum('Night Signal')
      await goTab('Watch')
      await openPlayer()
      await shot('music-player-1440-dark')
      const at = await place()
      const saw = { panel: at.panel, room: at.room, hash: at.hash, playing: await evaluate(`!!audioEl && !audioEl.paused`) }
      await clickName('Close player', '[data-panel="playing"]')
      await sleep(700)
      saw.closed = (await place()).panel !== 'playing'
      saw.stillPlaying = await evaluate(`!!audioEl && !audioEl.paused`)
      return same(saw, { panel: 'playing', room: 'Listen', hash: '#playing', playing: true, closed: true, stillPlaying: true })
    })
    // Inside it: where the music comes from, the track, a seek bar with both times, and the list. The track that
    // plays is marked and the ones that are done read quieter.
    await check('playerParts', async () => {
      await playAlbum('Night Signal')
      await openPlayer()
      await click('#fpNext')
      await waitFor(`$('npTitle').textContent === 'Lantern'`, 'the second track', 15_000)
      await sleep(500)
      const text = await playerText()
      return same({
        playingFrom: text.includes('Playing from') && text.includes('Night Signal'),
        track: text.includes('Lantern') && text.includes('Test Band'),
        clocks: (text.match(/\d+:\d\d/g) || []).length >= 2,
        seek: await evaluate(`[...document.querySelectorAll('[data-panel="playing"] input[type=range]')].filter(${VIS}).length >= 1`),
        rows: await queueRows(),
        past: await evaluate(`(() => {
          const box = [...document.querySelectorAll('[data-panel="playing"]')].filter(${VIS})[0]
          if (!box) return 'no music player'
          const rows = [...box.querySelectorAll('li, [data-track]')].filter(${VIS}).filter(r => r.querySelector('.nq-name, [data-name]'))
          if (rows.length < 3) return 'fewer than three tracks in sight'
          const look = r => { const s = getComputedStyle(r.querySelector('.nq-name, [data-name]') || r); return s.color + ' ' + s.opacity }
          return look(rows[0]) !== look(rows[2]) ? 'the track that is done reads quieter' : 'every row reads the same: ' + look(rows[0])
        })()`),
        text
      }, {
        playingFrom: true,
        track: true,
        clocks: true,
        seek: true,
        rows: ['Beacon', 'Lantern (playing)', 'Mist', 'Quay'],
        past: 'the track that is done reads quieter',
        text
      })
    })
    // A row comes out of the list, and Clear empties what is still to come without stopping the track that plays.
    await check('queueEdits', async () => {
      await playAlbum('Night Signal')
      await openPlayer()
      const inPlayer = await names('[data-panel="playing"]')
      const saw = { canRemoveARow: inPlayer.filter(n => n.startsWith('Remove')).includes('Remove Quay'), clear: inPlayer.includes('Clear') }
      if (saw.canRemoveARow) {
        await clickName('Remove Quay', '[data-panel="playing"]')
        await sleep(500)
      }
      saw.afterRemove = await queueRows()
      if (saw.clear) {
        await clickName('Clear', '[data-panel="playing"]')
        await sleep(600)
      }
      saw.afterClear = await queueRows()
      saw.stillPlaying = await evaluate(`!!audioEl && !audioEl.paused`)
      return same(saw, {
        canRemoveARow: true,
        clear: true,
        afterRemove: ['Beacon (playing)', 'Lantern', 'Mist'],
        afterClear: ['Beacon (playing)'],
        stillPlaying: true
      })
    })
    // An album, a track row and an artist add to the list and keep the track that plays.
    await check('playNextFromAlbum', async () => {
      await playAlbum('Night Signal')
      await goTab('Listen')
      await openAlbum('Tide Songs')
      await queueAction('Play next', '#detail .page-acts')
      await openPlayer()
      return same({ rows: await queueRows(), nowPlaying: await evaluate(`$('npTitle').textContent`) },
        { rows: ['Beacon (playing)', 'Foam', 'Tide', 'Lantern', 'Mist', 'Quay'], nowPlaying: 'Beacon' })
    })
    await check('playLastFromTrack', async () => {
      await playAlbum('Night Signal')
      await goTab('Listen')
      await clickText('Tracks', '#listenSeg')
      await waitFor(`!!document.querySelector('#albums [data-track][data-name="Foam"]')`, 'the track list', 8000)
      await queueAction('Play last', '#albums [data-track][data-name="Foam"]')
      await openPlayer()
      const text = await playerText()
      return same({
        rows: await queueRows(),
        thenBeforeIt: text.includes('Then') && text.indexOf('Then') < text.indexOf('Foam'),
        text
      }, { rows: ['Beacon (playing)', 'Lantern', 'Mist', 'Quay', 'Foam'], thenBeforeIt: true, text })
    })
    await check('playLastFromArtist', async () => {
      await playAlbum('Night Signal')
      await goTab('Listen')
      await clickText('Artists', '#listenSeg')
      await waitFor(`!!document.querySelector('#albums a[href="#artist/Sea%20Choir"]')`, 'the artists', 8000)
      await click('#albums a[href="#artist/Sea%20Choir"]')
      await waitFor(seen('#detail .page-acts'), 'the artist page', 10_000)
      await queueAction('Play last', '#detail .page-acts')
      await openPlayer()
      return same(await queueRows(), ['Beacon (playing)', 'Lantern', 'Mist', 'Quay', 'Foam', 'Tide'])
    })
    // Shuffle keeps the track that plays and the same tracks; turned on it puts them in another order.
    await check('shuffleKeepsCurrent', async () => {
      await playAlbum('Night Signal')
      await click('#npNext')
      await waitFor(`$('npTitle').textContent === 'Lantern'`, 'the second track', 15_000)
      await openPlayer()
      const before = await queueRows()
      const coming = rows => JSON.stringify(rows.filter(r => !r.endsWith('(playing)')))
      let after = before
      let another = false
      for (let n = 0; n < 5 && !another; n++) {
        await clickName('Shuffle', '[data-panel="playing"]')
        await sleep(500)
        after = await queueRows()
        another = coming(after) !== coming(before)
        if (!another) { await clickName('Shuffle', '[data-panel="playing"]'); await sleep(400) }
      }
      return same({
        kept: after.filter(r => r.endsWith('(playing)')),
        sameTracks: JSON.stringify([...after].sort()) === JSON.stringify([...before].sort()),
        another,
        before,
        after
      }, { kept: ['Lantern (playing)'], sameTracks: true, another: true, before, after })
    })
    // Repeat is a control of the player, and its state comes back to where it started.
    await check('repeatControl', async () => {
      await playAlbum('Night Signal')
      await openPlayer()
      const state = () => evaluate(`(() => {
        const b = [...document.querySelectorAll('[data-panel="playing"] button, #np button')].filter(${VIS}).find(e => ${NAME}(e).startsWith('Repeat'))
        if (!b) return 'no control named Repeat'
        return ${NAME}(b) + ' / ' + (b.getAttribute('aria-pressed') || b.getAttribute('aria-checked') || b.dataset.state || b.className)
      })()`)
      const steps = [await state()]
      for (let n = 0; n < 3; n++) {
        await clickName('Repeat', '[data-panel="playing"]', false)
        await sleep(400)
        steps.push(await state())
      }
      return same({ named: !String(steps[0]).startsWith('no control'), changes: steps[1] !== steps[0], comesBack: steps.slice(1).includes(steps[0]), steps },
        { named: true, changes: true, comesBack: true, steps })
    })
    // The list, the track and its place outlast a reload, and the music waits for Play. The page keeps the place
    // without a stream (nothing is fetched until Play), so the place is read where a reader reads it: the clock.
    const clockSeconds = text => text.trim().split(':').reduce((t, n) => 60 * t + Number(n), 0)
    await check('queuePersists', async () => {
      await playAlbum('Night Signal')
      await click('#npNext')
      // Leave a place far enough from zero that a restart at the beginning cannot pass.
      await waitFor(`$('npTitle').textContent === 'Lantern' && audioEl.currentTime >= 3`, 'the second track playing', 25_000)
      await click('#npPlay')
      await waitFor(`audioEl.paused`, 'the music waits', 8000)
      const at = await evaluate(`$('npAt').textContent`)
      await open('#home')
      await waitFor(`${seen('#np')} && $('npTitle').textContent === 'Lantern'`, 'the dock after a reload', 20_000)
      await waitFor(`$('npAt').textContent !== '0:00'`, 'the track at its place again', 15_000)
      const back = await evaluate(`({ title: $('npTitle').textContent, paused: !audioEl || audioEl.paused, at: $('npAt').textContent })`)
      await openPlayer()
      const rows = await queueRows()
      const noPreload = await evaluate(`!audioEl?.getAttribute('src')`)
      await click('#fpPlay')
      await waitFor(`audioEl && !audioEl.paused && audioEl.readyState >= 2`, 'the saved song plays again')
      const resumed = await evaluate(`audioEl.currentTime`)
      return same({ title: back.title, paused: back.paused, savedPlace: clockSeconds(back.at) === clockSeconds(at), noPreload, resumesThere: Math.abs(resumed - clockSeconds(at)) < 2, rows },
        { title: 'Lantern', paused: true, savedPlace: true, noPreload: true, resumesThere: true, rows: ['Beacon', 'Lantern (playing)', 'Mist', 'Quay'] })
    })
    // A page that cannot restore the saved queue (its library arrived without the song) must not erase it when the
    // page hides: a later load still has to bring the queue back.
    await check('queueSurvivesFailedRestore', async () => {
      await playAlbum('Night Signal')
      await click('#npNext')
      await waitFor(`$('npTitle').textContent === 'Lantern' && audioEl.currentTime >= 3`, 'the second track playing', 25_000)
      await click('#npPlay')
      await waitFor(`audioEl.paused`, 'the music waits', 8000)
      const saved = JSON.parse(await evaluate(`localStorage.getItem('peartube-music')`))
      assert.equal(saved.keys?.length, 4, 'a queue waits in this browser')
      // The relay answers with a film the queue cannot use, so restoreMusic runs, finds no song of the queue, and
      // leaves the page empty. This is the page whose pagehide used to overwrite the saved queue with no keys.
      const film = (await getJson('/v1/entries')).results.find(e => e.id === 'imdb:tt1254207')
      assert.ok(film, 'the library has a film')
      await browser.withJson({ [base + '/v1/entries']: { results: [film] } }, async () => {
        await open('#home')
        const failed = await evaluate(`({ restored: musicRestored, held: queue.length, dock: ${seen('#np')} })`)
        assert.deepEqual(failed, { restored: true, held: 0, dock: false }, 'the page had nothing to restore')
      })
      // Leaving that page fires pagehide. An ordinary load must find the queue still saved.
      await open('#home')
      await waitFor(`${seen('#np')} && $('npTitle').textContent === 'Lantern'`, 'the saved queue after a later load', 20_000)
      const back = await evaluate(`({ keys: queue.length, title: $('npTitle').textContent, paused: !audioEl || audioEl.paused })`)
      return same(back, { keys: 4, title: 'Lantern', paused: true })
    })

    // ==== How music and video share the one player.
    // A video stops the music, which keeps its track, its time and its list, says why, and waits for Play.
    await check('videoPausesMusic', async () => {
      await playAlbum('Night Signal')
      await click('#npNext')
      await waitFor(`$('npTitle').textContent === 'Lantern' && audioEl.currentTime >= 3`, 'the second track playing past three seconds', 25_000)
      await goTab('Watch')
      await openTitle('Harbour Walk')
      // Record the position immediately before the video opens, past the 2 s window below:
      // a player that reset the music to zero on pause would be caught here.
      const at = await evaluate(`audioEl.currentTime`)
      await click('#detail [data-play]')
      await waitFor(`$('playerModal').classList.contains('open')`, 'the video player', 20_000)
      await waitFor(`!!audioEl && audioEl.paused`, 'the music stops for the video', 10_000)
      await waitFor(`/[1-9]/.test(($('pClock').textContent || '').split('/')[0])`, 'the video plays', 60_000)
      // The pause must hold while the video plays above zero, not only at the moment it opens.
      const during = await evaluate(`({ at: ($('pClock').textContent || '').split('/')[0], paused: !!audioEl && audioEl.paused, held: heldForVideo, musicAt: audioEl ? audioEl.currentTime : 0 })`)
      await click('#pCloseBtn')
      await sleep(900)
      const saw = {
        dock: await evaluate(seen('#np')),
        track: await evaluate(`$('npTitle').textContent`),
        kept: Math.abs(await evaluate(`(audioEl && audioEl.currentTime) || 0`) - at) <= 2,
        atPastThree: at >= 3,
        pausedWhilePlaying: during.paused,
        heldWhilePlaying: during.held,
        musicHeld: Math.abs(during.musicAt - at) <= 2,
        videoAboveZero: clockSeconds(during.at) > 0,
        says: (await evaluate(`$('np').innerText.replace(/\\s+/g, ' ')`)).includes('Paused for a video')
      }
      await openPlayer()
      saw.list = await queueRows()
      await sleep(2500)
      saw.stillWaiting = await evaluate(`!audioEl || audioEl.paused`)
      await click('#fpPlay')
      await waitFor(`!!audioEl && !audioEl.paused`, 'Play starts the music again', 10_000)
      saw.playStartsIt = true
      return same(saw, {
        dock: true,
        track: 'Lantern',
        kept: true,
        atPastThree: true,
        pausedWhilePlaying: true,
        heldWhilePlaying: true,
        musicHeld: true,
        videoAboveZero: true,
        says: true,
        list: ['Beacon', 'Lantern (playing)', 'Mist', 'Quay'],
        stillWaiting: true,
        playStartsIt: true
      })
    })
    // Music closes a video, and the video keeps its place under Keep playing.
    await check('musicClosesVideo', async () => {
      await playAlbum('Night Signal')
      await goTab('Watch')
      await openTitle('Harbour Walk')
      await click('#detail [data-play]')
      await waitFor(`$('playerModal').classList.contains('open')`, 'the video player', 20_000)
      await waitFor(`/[1-9]/.test(($('pClock').textContent || '').split('/')[0])`, 'the video plays', 60_000)
      await click('#pMiniBtn')
      await sleep(600)
      await goTab('Listen')
      await openAlbum('Night Signal')
      await waitFor(`player && player.primed && player.currentMediaTime() >= 3`, 'at least three seconds of the clip play', 12_000)
      const left = await evaluate(`player.currentMediaTime()`)
      await clickName('Resume', '#detail')
      await waitFor(`!!audioEl && !audioEl.paused`, 'the music starts', 20_000)
      const saw = { videoClosed: await evaluate(`!$('playerModal').classList.contains('open')`) }
      await goTab('Home')
      await waitFor(seen('#keep'), 'Keep playing', 15_000)
      saw.keep = (await texts('#keep .keep-name')).sort()
      await goTab('Watch')
      await openTitle('Harbour Walk')
      await click('#detail .page-acts [data-play]')
      await waitFor(`player && player.primed && !player.seeking`, 'the selected video resumes', 20_000)
      const resumed = await evaluate(`player.currentMediaTime()`)
      await click('#pCloseBtn')
      return same({ ...saw, retainedPosition: Math.abs(resumed - left) < 2, left, resumed },
        { videoClosed: true, keep: ['Harbour Walk', 'Night Signal'], retainedPosition: true, left, resumed })
    })
    // Keep playing mixes both: a video with its time left in words, the album with the track it stopped on. The
    // newest is the large one, and Watch keeps only the video under Keep watching.
    await check('keepPlayingWords', async () => {
      await open('#home')
      await waitFor(seen('#keep'), 'Keep playing', 15_000)
      if (await evaluate(`!!audioEl && !audioEl.paused`)) {
        await click('#npPlay')
        await waitFor(`audioEl.paused`, 'the music waits', 8000)
      }
      const items = await evaluate(`[...document.querySelectorAll('#keep .keep-name')].map(n => {
        const box = n.closest('.keep-big, .keep-row') || n.parentElement
        const sub = box.querySelector('.keep-sub')
        return n.textContent + ' | ' + (sub ? sub.textContent : 'nothing under the name')
      })`)
      const film = items.find(i => i.startsWith('Harbour Walk')) || 'no video under Keep playing'
      const music = items.find(i => i.startsWith('Night Signal')) || 'no album under Keep playing'
      await evaluate(`(() => {
        const n = [...document.querySelectorAll('#keep .keep-name')].find(e => e.textContent === 'Night Signal')
        if (!n) return false
        const b = n.closest('.keep-row') || n.closest('.keep-big').querySelector('button')
        b.setAttribute('data-e2e', 'keep-music')
        return true
      })()`)
      await click('[data-e2e="keep-music"]')
      await waitFor(`!!audioEl && !audioEl.paused`, 'Keep playing goes on with the music', 15_000)
      await sleep(700)
      const hero = await evaluate(`(() => { const n = document.querySelector('#keep .keep-big .keep-name'); return n ? n.textContent : 'nothing is large' })()`)
      await shot('keep-playing-1440-dark')
      const head = await texts('#keepWrap h2')
      await open('#watch')
      const watching = await evaluate(`(() => {
        const s = [...document.querySelectorAll('#entries section')].find(x => /Keep watching/.test((x.querySelector('h2') || {}).textContent || ''))
        return s ? [...s.querySelectorAll('.tile-title')].map(e => e.textContent) : 'no Keep watching in Watch'
      })()`)
      return same({
        head,
        filmLeft: /\d+ (h|min) left/.test(film) && !/\d:\d\d/.test(film),
        musicTrack: /track \d+ of \d+/i.test(music),
        newestIsLarge: hero,
        watching,
        items
      }, { head: ['Keep playing'], filmLeft: true, musicTrack: true, newestIsLarge: 'Night Signal', watching: ['Harbour Walk'], items })
    })
    // A film never enters the music list, and its page offers nothing that would add it.
    await check('filmNeverInQueue', async () => {
      await playAlbum('Night Signal')
      await goTab('Watch')
      await openTitle('Harbour Walk')
      const onThePage = await names('#detail')
      await click('#detail [data-play]')
      await waitFor(`$('playerModal').classList.contains('open')`, 'the video player', 20_000)
      await waitFor(`/[1-9]/.test(($('pClock').textContent || '').split('/')[0])`, 'the video plays', 60_000)
      await click('#pCloseBtn')
      await sleep(800)
      await openPlayer()
      return same({ rows: await queueRows(), musicWords: onThePage.filter(n => /play next|play last|up next/i.test(n)) },
        { rows: ['Beacon (playing)', 'Lantern', 'Mist', 'Quay'], musicWords: [] })
    })
    // The video player's own words.
    await check('videoPlayerWords', async () => {
      await open('#watch')
      await openTitle('Harbour Walk')
      await click('#detail [data-play]')
      await waitFor(`$('playerModal').classList.contains('open')`, 'the video player', 20_000)
      await waitFor(`/[1-9]/.test(($('pClock').textContent || '').split('/')[0])`, 'the video plays', 60_000)
      const inPlayer = await names('#playerModal')
      const saw = {
        audio: inPlayer.filter(n => n.startsWith('Audio')),
        subtitles: inPlayer.filter(n => n.startsWith('Subtitle')),
        fileInfo: inPlayer.includes('File info')
      }
      await shot('video-player-words-1440-dark')
      await click('#pCloseBtn')
      await sleep(500)
      return same(saw, { audio: ['Audio'], subtitles: ['Subtitles'], fileInfo: true })
    })

    // A narrow screen: the rooms are the row at the bottom, the bar names the place, and the relay's pages are in More.
    await viewport(390, 844, 'dark')
    await check('narrowRooms', async () => {
      await open('#home')
      return same(await evaluate(`(() => {
        const nav = document.querySelector('.rooms')
        if (!nav) return 'no rooms'
        const links = [...nav.querySelectorAll('a')].filter(a => a.offsetParent !== null)
        const name = $('placeName').getBoundingClientRect()
        return {
          row: getComputedStyle(nav).position + ' ' + Math.round(innerHeight - nav.getBoundingClientRect().bottom),
          rooms: links.map(a => a.innerText.trim()),
          tall: links.every(a => a.getBoundingClientRect().height >= 44),
          name: name.width > 1 && name.top < 60 ? $('placeName').textContent : '',
          sideways: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
        }
      })()`), { row: 'fixed 0', rooms: ['Home', 'Listen', 'Watch', 'Discover', 'Search'], tall: true, name: 'Home', sideways: 0 })
    })
    await shot('home-390-dark', true)
    await check('narrowMore', async () => {
      await open('#home')
      await click('#moreBtn')
      const pages = await texts('dialog.menu .mi')
      const open1 = { pages: pages.slice(0, 3), theme: (pages[3] || '').startsWith('Theme: '), open: await evaluate(`!!document.querySelector('dialog.menu[open]')`) }
      await press('Escape')
      const shut = await evaluate(`[!!document.querySelector('dialog.menu[open]'), $('ownerNav').offsetParent === null, document.activeElement === $('moreBtn')]`)
      await click('#moreBtn')
      await clickText('Sharing', 'dialog.menu')
      const at = await place()
      return same({ open: open1, shut, went: at.panel + ' ' + at.hash, name: await evaluate(`$('placeName').textContent`), after: await evaluate(`!!document.querySelector('dialog.menu[open]')`) }, {
        open: { pages: ['Channels', 'Sharing', 'Settings'], theme: true, open: true },
        shut: [false, true, true],
        went: 'sharing #sharing',
        name: 'Sharing',
        after: false
      })
    })
    await check('narrowFind', async () => {
      await open('#home')
      const onHome = await evaluate(`$('srcInput').offsetParent !== null`)
      await goTab('Search')
      const at = await place()
      const field = await evaluate(`(() => { const r = $('srcInput').getBoundingClientRect(); return { inSight: $('srcInput').offsetParent !== null, wide: r.width >= 240, atTop: r.top < 60 } })()`)
      const library = await typeFind('ferry')
      return same({ onHome, at: at.panel + ' ' + at.room, field, library }, { onHome: false, at: 'search Search', field: { inSight: true, wide: true, atTop: true }, library: ['Movies and series: Night Ferry'] })
    })
    await shot('search-390-dark', true)
    // The dock on a narrow screen is one row above the rooms: cover, two lines, Play or Pause and Next. The rest
    // of its controls are in the player.
    await check('narrowDock', async () => {
      await playAlbum('Night Signal')
      await sleep(600)
      const measured = await evaluate(`(() => {
        const np = $('np')
        if (!np || !${VIS}(np)) return 'no dock'
        const box = np.getBoundingClientRect()
        const rooms = document.querySelector('.rooms').getBoundingClientRect()
        const acts = [...np.querySelectorAll('#npArt, .np-text, #npPlay, #npNext')].filter(${VIS})
        const mid = acts.map(e => { const r = e.getBoundingClientRect(); return r.top + r.height / 2 })
        return {
          overTheRooms: Math.round(box.bottom - rooms.top),
          parts: acts.length,
          twoLines: $('npTitle').getBoundingClientRect().bottom <= $('npMeta').getBoundingClientRect().top + 1,
          highestToLowest: mid.length ? Math.round(Math.max(...mid) - Math.min(...mid)) : 'no controls on the dock',
          shown: [...np.querySelectorAll('button, a, input')].filter(${VIS}).map(${NAME})
        }
      })()`)
      const shown = measured.shown || []
      const has = w => shown.some(n => n === w || n.startsWith(w + ' '))
      return same({
        aboveTheRooms: measured.overTheRooms <= 1,
        oneRow: measured.parts === 4 && measured.twoLines && measured.highestToLowest <= 16,
        playOrPause: has('Play') || has('Pause'),
        next: has('Next'),
        putAway: ['Previous', 'Shuffle', 'Repeat', 'Up next', 'Volume'].filter(has),
        measured
      }, { aboveTheRooms: true, oneRow: true, playOrPause: true, next: true, putAway: [], measured })
    })
    // The music player covers the whole screen: it starts at the top, and neither the top bar, nor the rooms row,
    // nor the dock is left over it.
    await check('narrowPlayerCovers', async () => {
      await playAlbum('Night Signal')
      await openPlayer()
      await shot('music-player-390-dark', true)
      const measured = await evaluate(`(() => {
        const box = [...document.querySelectorAll('[data-panel="playing"]')].filter(${VIS})[0]
        if (!box) return 'no music player'
        const r = box.getBoundingClientRect()
        const rooms = document.querySelector('.rooms')
        const rr = rooms.getBoundingClientRect()
        const over = ${VIS}(rooms) ? document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2) : null
        return {
          startsAt: Math.round(r.top),
          roomsOverThePlayer: ${VIS}(rooms) && !(over && (over === box || box.contains(over))),
          barInSight: ${VIS}(document.querySelector('.top')),
          dockInSight: ${VIS}($('np')),
          sideways: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
        }
      })()`)
      return same({ fromTheTop: measured.startsAt <= 24, roomsOverThePlayer: measured.roomsOverThePlayer, barInSight: measured.barInSight, dockInSight: measured.dockInSight, sideways: measured.sideways, measured },
        { fromTheTop: true, roomsOverThePlayer: false, barInSight: false, dockInSight: false, sideways: 0, measured })
    })
    // A small video picture and the dock do not cover each other: the picture stands above the dock.
    await check('narrowMiniAboveDock', async () => {
      await playAlbum('Night Signal')
      await goTab('Watch')
      await openTitle('Harbour Walk')
      await click('#detail [data-play]')
      await waitFor(`$('playerModal').classList.contains('open')`, 'the video player', 20_000)
      await waitFor(`/[1-9]/.test(($('pClock').textContent || '').split('/')[0])`, 'the video plays', 60_000)
      await click('#pMiniBtn')
      await sleep(800)
      const measured = await evaluate(`(() => {
        const np = $('np')
        if (!${VIS}(np)) return 'no dock while a small picture is on screen'
        const a = np.getBoundingClientRect()
        const b = $('playerModal').getBoundingClientRect()
        return { overlap: Math.round(Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)), pictureOverTheDock: Math.round(b.bottom - a.top) }
      })()`)
      await click('#pCloseBtn')
      await sleep(400)
      return same({ apart: measured.overlap <= 0, pictureAbove: measured.pictureOverTheDock <= 1, measured },
        { apart: true, pictureAbove: true, measured })
    })
    await shot('dock-390-dark', true)

    // The taste gates of the first test, on every place of this design, at both widths and in both themes.
    await check('tasteOnNewPlaces', async () => {
      await open('#listen')
      const album = await evaluate(`(() => { const a = document.querySelector('#albums .album-open'); return a ? a.getAttribute('href') : '#listen' })()`)
      await open('#watch')
      const title = await evaluate(`(() => { const a = document.querySelector('#entries a.tile[href^="#title/"]'); return a ? a.getAttribute('href') : '#watch' })()`)
      // Each place with the panel it must show: an audit of a place that did not open would pass on the page shown in its stead.
      const places = [['home', '#home', 'home'], ['listen', '#listen', 'listen'], ['artists', '#listen/artists', 'listen'], ['tracks', '#listen/tracks', 'listen'],
        ['album', album, 'detail'], ['artist', '#artist/Test%20Band', 'detail'], ['watch', '#watch', 'watch'], ['title', title, 'detail'],
        ['discover', '#discover', 'discover'], ['search', '#search/light', 'search'], ['add', '#add', 'add'], ['playing', '#playing', 'playing']]
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        for (const scheme of ['light', 'dark']) {
          await viewport(width, height, scheme)
          for (const [name, hash, panel] of places) {
            await open(hash)
            await sleep(250)
            const shown = (await place()).panel
            if (shown !== panel) return { place: name, saw: shown, want: panel }
            await tasteAudit(width + ' ' + scheme + ' ' + name)
            if (scheme === 'light') await shot(name + '-' + width + '-light')
          }
        }
      }
      return true
    })
    await check('showAllArtistTracks', async () => {
      flacAlbum(join(watchDir, 'Test Band - After Hours'), 'Test Band', 'After Hours', [['Late', 350], ['Rain', 450], ['Porch', 500]], 1)
      await post('/v1/plugins/watch-dir/run', {})
      await waitApi(async () => (await getJson('/v1/entries')).results.some(e => e.music?.title === 'Porch'), 'one more album imported')
      await open('#artist/Test%20Band')
      const rows = '#detail [data-track] .track-name'
      const first = await texts(rows)
      await clickText('Show all 9', '#detail')
      const all = await texts(rows)
      return same({ first, all }, {
        first: ['Late', 'Rain', 'Porch', 'Dawn', 'Señal', 'Beacon', 'Lantern', 'Mist'],
        all: ['Late', 'Rain', 'Porch', 'Dawn', 'Señal', 'Beacon', 'Lantern', 'Mist', 'Quay']
      })
    })
    // Find and Artist grouping fold Latin and Greek accents, Turkish's two i's and a Greek final sigma, but keep a
    // mark where the script uses it as a letter: Cyrillic й/ё stay apart from и/е.
    await check('nonLatinFindAndArtists', async () => {
      // The narrow checks before this one leave the browser at 390 px, where the bar's field is a button; this check
      // reads the wide field and its results.
      await viewport(1440, 900, 'light')
      const albums = [
        ['Ёлка - Зима', 'Ёлка', 'Зима', [['Снег', 300]]],
        ['Елка - Весна', 'Елка', 'Весна', [['Ручей', 320]]],
        ['Άλφα - Θάλασσα', 'Άλφα', 'Θάλασσα', [['Κύμα', 340]]],
        ['Αλφα - Νησί', 'Αλφα', 'Νησί', [['Λιμάνι', 360]]],
        ['Οδός - Νύχτα', 'Οδός', 'Νύχτα', [['Φως', 380]]],
        ['IŞIK - Gece', 'IŞIK', 'Gece', [['Yıldız', 400]]],
        ['ışık - Gündüz', 'ışık', 'Gündüz', [['Güneş', 420]]]
      ]
      for (const [dir, artist, album, tracks] of albums) flacAlbum(join(watchDir, dir), artist, album, tracks)
      // The watch-dir poll may hold the folder when this check adds its albums; a run that answers `busy` scanned
      // nothing. Ask again until a run takes the folder, then wait for each album's track (an entry's title is
      // `artist · album`, and its `music.title` is the track's own name).
      const trackNames = albums.map(([, , , tracks]) => tracks[0][0])
      await waitApi(async () => {
        const run = await post('/v1/plugins/watch-dir/run', {})
        if (run?.busy) return false
        const entries = (await getJson('/v1/entries')).results
        return trackNames.every(name => entries.some(e => e.music?.title === name))
      }, 'the non-Latin albums imported', 90_000)
      await open('#listen')
      await clickText('Artists', '#listenSeg')
      const artists = await evaluate(`[...document.querySelectorAll('#albums .artist-card')].filter(a => a.offsetParent !== null).map(a => ({
        name: a.querySelector('.album-name').textContent,
        albums: a.querySelector('.album-artist').textContent
      }))`)
      const find = async query => (await typeFind(query)).join(' | ')
      const cyr = { marked: await find('ёлка'), plain: await find('елка') }
      const grk = { finalSigma: await find('οδοσ'), accent: await find('αλφα') }
      const tur = await find('ışık')
      const cyrNames = ['Ёлка', 'Елка'].filter(name => artists.some(a => a.name === name))
      const turkish = artists.filter(a => a.name === 'IŞIK' || a.name === 'ışık')
      const greek = artists.filter(a => a.name === 'Άλφα' || a.name === 'Αλφα')
      return same({
        cyrFind: [cyr.marked.includes('Зима'), !cyr.marked.includes('Весна'), cyr.plain.includes('Весна'), !cyr.plain.includes('Зима')],
        greekFind: [grk.finalSigma.includes('Νύχτα'), grk.accent.includes('Θάλασσα'), grk.accent.includes('Νησί')],
        turkishFind: [tur.includes('Gece'), tur.includes('Gündüz')],
        cyrNames,
        turkish: turkish.map(a => a.albums),
        greek: greek.map(a => a.albums)
      }, {
        cyrFind: [true, true, true, true],
        greekFind: [true, true, true],
        turkishFind: [true, true],
        cyrNames: ['Ёлка', 'Елка'],
        turkish: ['2 albums'],
        greek: ['2 albums']
      })
    })
    await check('consoleClean', async () => same(browser.issues, []))
    result.pass = result.failed.length === 0
    assert.deepEqual(result.failed, [], 'checks that failed; what each one saw is in desktop/target/e2e/ui-design-result.json')
  } catch (err) {
    result.error = err.message
    throw err
  } finally {
    result.consoleIssues = [...browser.issues]
    writeFileSync(join(outDir, 'ui-design-result.json'), JSON.stringify(result, null, 2))
    await browser.close()
    await stopRelay(relay, stub, [storage, binDir, watchDir])
  }
})
