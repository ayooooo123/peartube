// End-to-end check of the relay web UI in headless Brave (`$PUPPETEER_EXECUTABLE_PATH`), driven over CDP:
//   1. Settings: token gate (401), settings.json > env > default precedence with a way back to the env value, 0600 file,
//      round-trip from the UI with every change applied in the running relay, and the Restart relay action.
//   2. Every plugin as a user intent from the first screen, counting clicks: add from URL, import a folder,
//      follow a feed, copy a channel, keep copies, ask a HiveRelay to seed; legacy migration hidden when there is none.
//   3. Content identification against a stubbed Cinemeta and a stub `ubit` (`UBIT_BIN`): an exact match is
//      published as `imdb:tt…` (the id MediaStorm searches by), an unknown file as a plain clip, a page link
//      through ubit's metadata and NDJSON downloader.
//   4. Music sources against the stub `ubit`: source chips and their memory, a streamed two-source search, YouTube
//      rows with relay-fetched thumbnails and the fixed lossy label, rows that stay put when the slower group lands
//      above them (and no redraw mid-press), suggestions from messy titles, failure hints, a failing source on its
//      own, the save dialog (suggestions, reorder, single track filed into the album that has it, Escape), job
//      cards without a percentage, library labels for YouTube copies, alone and merged with a FLAC album, removing
//      the YouTube copy on its own, and a library-filter miss that leads on to Find music.
//   5. Taste gates on every tab at 1440×900 and 390×844 in light and dark: no console errors or warnings, no
//      sideways scroll, no internal plugin ids in visible text, no hint over 12 words, every field labelled
//      with an example placeholder; again with search results on screen and with the save dialog open.
// Writes `desktop/target/e2e/ui-result.json`, screenshots to `desktop/target/e2e/ui-audit/after/`, and the sources
// screens to `desktop/target/e2e/sources-ux/` (the UX-fix evidence in its `fixes/`).
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

function startStub () {
  const files = {
    '/media/Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP.mp4': bytesFor('bbb'),
    '/media/Random.Clip.Name.mp4': bytesFor('random'),
    '/media/feed-item.mp4': bytesFor('feed'),
    '/page-video.mp4': bytesFor('page'),
    '/media/long.mp4': bytesFor('long', 16 * 1024 * 1024),
    '/media/clip.mkv': playableClip(),
    '/media/clip30.mkv': playableClip(30),
    '/media/variable.mkv': variableAspectClip()
  }
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const base = 'http://127.0.0.1:' + srv.address().port
    const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (files[url.pathname]) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': files[url.pathname].length })
      return res.end(req.method === 'HEAD' ? undefined : files[url.pathname])
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

// Minimal CDP client for one Brave tab.
async function launchBrowser () {
  const exe = process.env.PUPPETEER_EXECUTABLE_PATH
  assert.ok(exe && existsSync(exe), 'PUPPETEER_EXECUTABLE_PATH must point at a Chromium-family browser')
  const dir = mkdtempSync(join(tmpdir(), 'peartube-ui-browser-'))
  // `--use-mock-keychain` + `--password-store=basic` + `--disable-sync` keep macOS from ever prompting
  // SecurityAgent for Brave's storage/sync/wallet keys on throwaway profiles during unattended runs.
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--use-mock-keychain', '--password-store=basic', '--disable-sync', '--disable-features=BraveWallet,BraveRewards,BraveNews', 'about:blank'], { stdio: 'ignore' })
  const portFile = join(dir, 'DevToolsActivePort')
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(100)
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  const issues = []
  // Every URL the page asks for, so the run can prove it never contacts YouTube or its image host.
  const requests = []
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      return
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) issues.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '))
    if (m.method === 'Runtime.exceptionThrown') issues.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    if (m.method === 'Log.entryAdded' && (m.params.entry.level === 'error' || m.params.entry.level === 'warning')) issues.push(m.params.entry.level + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''))
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url)
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
    async hide () { blank = blank || JSON.parse(await devtools('/json/new?about:blank', 'PUT')).id; await devtools('/json/activate/' + blank) },
    async show () { await devtools('/json/activate/' + target.id) },
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
  const browser = await launchBrowser()
  const { evaluate, send } = browser

  let clicks = 0
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
    clicks++
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
  async function type (selector, text) {
    await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); e.focus(); e.select?.() })()`)
    await send('Input.insertText', { text })
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
    await waitFor(`document.readyState === 'complete' && document.querySelector('#pills').children.length > 0`, 'page load')
    await sleep(400)
  }
  const goTab = async name => { await clickText(name, '.tabs'); await sleep(300) }
  const entries = async () => (await getJson('/v1/entries')).results
  async function shot (name, viewportOnly = false, dir = shotDir) {
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

    // 2 + 3. Add from URL with an exact Cinemeta match: two clicks from the first screen.
    await goTab('Library')
    clicks = 0
    await type('#addInput', stub.base + '/media/Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP.mp4')
    await clickText('Add', '#addForm')
    await waitFor(`!document.querySelector('#preview').hidden && document.querySelector('#preview input[name=cand]:checked')`, 'identification preview')
    const preview = await evaluate(`({ checked: document.querySelector('#preview input[name=cand]:checked').value, title: document.querySelector('#addTitle').value, choices: [...document.querySelectorAll('#preview .cand')].map(c => c.textContent.trim()) })`)
    assert.equal(preview.checked, 'imdb:tt1254207', 'the exact title and year is chosen')
    assert.equal(preview.title, 'Big Buck Bunny 2008')
    assert.ok(!preview.choices.some(c => c.includes('Big Stan')), 'unrelated titles are not offered')
    await clickText('Add to library')
    result.interactions.addFromUrl = clicks
    const movie = await waitApi(async () => (await entries()).find(e => e.id === 'imdb:tt1254207'), 'identified entry')
    assert.equal(movie.title, 'Big Buck Bunny 2008')
    assert.equal((await getJson('/v1/search?id=imdb:tt1254207')).results.length, 1, 'MediaStorm finds it by imdb id')
    // The same file announced again (a second copy in its own core) is still one entry and one tile.
    const again = await (await fetch(base + '/v1/acquire', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'imdb:tt1254207', title: 'Big Buck Bunny 2008', source: { url: stub.base + '/media/Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP.mp4' } }) })).json()
    await waitApi(async () => (await getJson('/v1/jobs/' + again.jobId)).status === 'done', 'second copy announced')
    assert.equal((await getJson('/v1/search?id=imdb:tt1254207')).results.length, 1, 'two copies of one file are one entry')
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
    await clickText('Copy link', '#detail')
    const modalCopied = await evaluate(`window.__modalCopied`)
    assert.match(modalCopied, /^peartube:\/\/watch\//, 'Copy link inside open <dialog> must populate clipboardData over plain HTTP')
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
    await goTab('Library')
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
    await type('#addInput', stub.base + '/media/Random.Clip.Name.mp4')
    await clickText('Add', '#addForm')
    await waitFor(`!document.querySelector('#preview').hidden && document.querySelector('#addTitle')`, 'plain preview')
    assert.equal(await evaluate(`document.querySelector('#addTitle').value`), 'Random Clip Name')
    assert.equal(await evaluate(`document.querySelector('#preview fieldset') === null`), true, 'no suggestions when nothing matches')
    await clickText('Add to library')
    const clip = await waitApi(async () => (await entries()).find(e => e.title === 'Random Clip Name'), 'plain entry')
    assert.match(clip.id, /^clip:[0-9a-f]{16}$/)

    // A page link goes through `ubit` for both its metadata and its muxed download.
    await type('#addInput', stub.base + '/watch?v=aqz-KE-bpKQ')
    await clickText('Add', '#addForm')
    await waitFor(`!document.querySelector('#preview').hidden && document.querySelector('#preview h3')`, 'page preview')
    const pageMeta = await evaluate(`document.querySelector('#preview .meta').textContent`)
    assert.ok(pageMeta.includes('Blender') && pageMeta.includes('10:35'), 'page preview shows uploader and length: ' + pageMeta)
    await clickText('Add to library')
    const pageEntry = await waitApi(async () => (await entries()).find(e => e.title === page.title), 'page entry')
    assert.equal(pageEntry.size, bytesFor('page').length)
    const publicText = JSON.stringify(await getJson('/v1/entries')) + JSON.stringify(await getJson('/v1/jobs'))
    assert.ok(!publicText.includes(stub.base), 'source URLs stay out of entries and jobs')
    result.checks.identifyPlain = clip.id
    result.checks.identifyPage = { id: pageEntry.id, title: pageEntry.title }
    mark('identifyPage')

    // Scan the import folder: the page offers a scan, never a path.
    await open('#library')
    assert.equal(await evaluate(`document.querySelector('#folderInput') === null && !document.body.innerHTML.includes(${JSON.stringify(watchDir)})`), true, 'the page names no folder')
    writeFileSync(join(watchDir, 'Watched.Clip.2019.mp4'), bytesFor('watched'))
    // And one album: a folder of two tagged 8 s FLAC tracks.
    const albumDir = join(watchDir, 'Test Band - First Light')
    mkdirSync(albumDir)
    for (const [n, name, hz] of [[1, 'Dawn', 440], [2, 'Dusk', 550]]) {
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=44100:duration=8`, '-metadata', 'title=' + name, '-metadata', 'artist=Test Band',
        '-metadata', 'album=First Light', '-metadata', 'track=' + n, join(albumDir, `0${n} - ${name}.flac`)])
    }
    clicks = 0
    await clickText('Import folder')
    await clickText('Scan import folder', '#folderForm')
    result.interactions.importFolder = clicks
    mark('importFolderClicked')
    await waitApi(async () => (await entries()).find(e => e.title === 'Watched Clip 2019'), 'watched file imported')
    await waitApi(async () => /Scanned the import folder/.test(await evaluate(`document.querySelector('#addMsg').textContent`)), 'scan result shown')
    assert.equal('watchDir' in (await settingsNow()).settings, false, 'the import folder is not a setting')

    // Music: Play starts the album in the bar, which keeps time with the sound, seeks, skips to the next track,
    // stays through a tab switch and pauses on Space. The bar it leaves comes back paused on every later load,
    // so the taste gates below run with it on screen.
    await waitApi(async () => (await entries()).filter(e => e.music && e.title === 'Test Band · First Light').length === 2, 'album imported')
    await open('#library')
    assert.equal(await evaluate(`[...document.querySelectorAll('#entries .tile')].some(t => t.textContent.includes('First Light'))`), false, 'albums are not tiles on the film grid')
    await open('#music')
    await waitFor(`[...document.querySelectorAll('.album-card .album-name')].some(n => n.textContent === 'First Light')`, 'album on the Music shelf')
    await evaluate(`[...document.querySelectorAll('.album-card')].find(c => c.querySelector('.album-name').textContent === 'First Light').querySelector('.album-open').setAttribute('data-e2e', 'album'); true`)
    await click('[data-e2e="album"]')
    await waitFor(`!!document.querySelector('#detail[open] [data-album]')`, 'album sheet')
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

    // 4. Music sources. Soulseek has no account here, so it offers setup; YouTube runs on the stub `ubit`.
    const issuesBefore = browser.issues.length
    const chip = name => `document.querySelector('#srcChips [data-src="${name}"]')`
    await goTab('Music')
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
    await open('#music')
    await waitFor(`!!${chip('youtube')}`, 'source chips after reload')
    assert.equal(await evaluate(`${chip('youtube')}.getAttribute('aria-pressed')`), 'false', 'a source turned off stays off')
    assert.equal(await evaluate(`localStorage.getItem('peartube.sourcesOff')`), '["youtube"]')
    await click(`#srcChips [data-src="youtube"]`)
    assert.equal(await evaluate(`${chip('youtube')}.getAttribute('aria-pressed')`), 'true', 'and back on')
    result.checks.sourceChips = true

    // One search; YouTube's part shows as soon as it lands, every row labelled as the lossy copy it would save.
    const ytSearch = async query => { await type('#srcInput', query); await click('#srcBtn') }
    await ytSearch('test band')
    await waitFor(`document.querySelectorAll('#srcGroup-youtube .yt-pick-row').length === 3`, 'YouTube rows streamed in', 5000)
    const rows = await evaluate(`[...document.querySelectorAll('#ytResults .item')].map(i => i.innerText)`)
    for (const row of rows) assert.ok(row.includes('YouTube') && row.includes('AAC 128 kbps') && row.includes('lossy'), 'YouTube row says what a save gives: ' + row)
    const groupText = await evaluate(`(() => { let t = $('srcGroups').innerText; for (const n of document.querySelectorAll('#srcGroups .item .name')) t = t.replace(n.firstChild.textContent, ''); return t })()`)
    assert.doesNotMatch(groupText, /lossless|\bHQ\b|high quality/i, 'no YouTube copy is called lossless or high quality')
    assert.equal(await evaluate(`[...document.querySelectorAll('#srcGroups .item')].every(i => ['Soulseek', 'YouTube'].includes((i.querySelector('.src-tag') || {}).textContent))`), true, 'every row names its source in words')
    assert.equal(await evaluate(`[...document.querySelectorAll('#srcGroups .yt-thumb')].every(t => t.querySelector('img') || t.querySelector('.yt-ph'))`), true, 'every thumbnail is a relay picture or the drawn placeholder')
    assert.equal(await evaluate(`$('ytNote').firstChild.textContent`), 'Peers not searched. YouTube copies are lossy AAC 128 kbps.', 'the advice says peers were not asked')
    assert.match(await evaluate(`$('srcSummary').textContent`), /Soulseek off.*YouTube 3 videos/)
    result.checks.sourcesStreamed = rows.length

    // Nothing moves under the pointer or the finger when the slower group lands on top. A stream stubbed in the page
    // (no network) answers YouTube at once and Soulseek on demand, with 30 peer folders: tall enough to push a phone's
    // rows thousands of pixels down if nothing held them. As in a real search, the first YouTube row sits mid-screen
    // under its heading and the note, and the note changes (and wraps at 390, with a button) when the peers land:
    // a heading held still would let the note push the row down by however much the note grew.
    const srcStub = `window.__srcStub = (() => {
      const real = window.fetch
      let push = null
      const yt = Array.from({ length: 12 }, (_, i) => ({ source: 'youtube', videoId: 'stubVid' + String(i).padStart(4, '0'), title: 'Stub Band - Song ' + (i + 1), length: 200 + i, thumbnail: '', channel: null }))
      const files = []
      for (let f = 0; f < 30; f++) for (let k = 0; k < 6; k++) files.push({ source: 'soulseek', username: 'peer' + f, filename: 'Music/Stub Band/Album ' + f + '/0' + k + ' - Song.flac', size: 3e7, bit_depth: 16, sample_rate: 44100, slots: true, queue: 0, length: 200 })
      window.fetch = (url, opts) => {
        if (String(url) !== '/v1/search/sources') return real(url, opts)
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
      await waitFor(`document.querySelectorAll('#ytResults .item').length === 12 && !!document.querySelector('#srcGroup-soulseek .slsk-spin')`, 'YouTube landed, peers pending', 5000)
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
    await waitFor(`document.querySelectorAll('#ytResults .item').length === 12`, 'YouTube landed for the press check', 5000)
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

    // Failure hints match whole words only: a rate limit or a full disk is not an age gate.
    const hints = await evaluate(`[ytFailHint('ERROR: Unable to download webpage: HTTP Error 429'), ytFailHint('No space left on device (storage full)'), ytFailHint('Sign in to confirm your age. This video may be inappropriate'), ytFailHint('ERROR: Private video. Sign in if you have been granted access')]`)
    assert.deepEqual(hints, ['', '', 'Needs a signed-in account; this relay has none.', 'Private or members-only video.'], 'failure hints')
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
    clicks = 0
    assert.deepEqual(await evaluate(`[$('ytArtist').value, $('ytTrack-0').value, $('ytTrack-1').value]`), ['Test Band', 'Dawn', 'Dusk'], 'artist and cleaned titles suggested')
    await type('#ytAlbum', 'Morning')
    await type('#ytYear', '2020')
    await click('[data-mv="up-1"]')
    assert.deepEqual(await evaluate(`[$('ytTrack-0').value, document.activeElement.dataset.mv]`), ['Dusk', 'up-0'], 'a moved track keeps focus on its own button')
    await click('#ytSaveBtn')
    result.interactions.ytSave = clicks
    await waitFor(`!$('ytSave').open && /YouTube/.test($('srcJobs').innerText)`, 'YouTube job card', 10_000)
    assert.ok(!(await evaluate(`$('srcJobs').innerText`)).includes('%'), 'a YouTube job never shows a percentage')
    await waitFor(`$('toast').textContent.includes('to your library')`, 'album added toast', 30_000)
    const morning = await waitApi(async () => { const list = (await entries()).filter(e => e.title === 'Test Band · Morning'); return list.length === 2 && list }, 'YouTube album imported')
    assert.ok(morning.every(e => e.id.startsWith('yt:')), 'a YouTube album is pinned to a yt: release')
    assert.deepEqual(morning.sort((a, b) => a.episode - b.episode).map(e => e.music.title), ['Dusk', 'Dawn'], 'tracks numbered in the dialog order')
    await open('#music')
    const card = name => `[...document.querySelectorAll('.album-card')].find(c => c.querySelector('.album-name').textContent === '${name}')`
    await waitFor(`${card('Morning')}?.querySelector('[data-aq]').textContent === 'YouTube · AAC 128 kbps'`, 'YouTube album labelled on the shelf')
    await evaluate(`${card('Morning')}.querySelector('.album-open').setAttribute('data-e2e', 'morning'); true`)
    await click('[data-e2e="morning"]')
    await waitFor(`document.querySelector('#detail[open] [data-av]')?.textContent === 'From YouTube · AAC 128 kbps'`, 'YouTube album sheet verdict')
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
    await waitFor(`/^FLAC 16-bit 44.1 kHz · also YouTube$/.test(${card('First Light')}?.querySelector('[data-aq]').textContent || '')`, 'merged album says what it is, then also YouTube')
    assert.equal(await evaluate(`(() => { const yt = ${card('First Light')}.querySelector('.aq-yt'); const line = yt.parentElement.getBoundingClientRect(); const r = yt.getBoundingClientRect(); return r.width > 0 && r.right <= line.right + 0.5 })()`), true, '"also YouTube" is never cut off on the card')
    assert.equal(await evaluate(`document.querySelectorAll('.album-card').length`), 2, 'the YouTube copy joins the FLAC album, not a new one')
    await evaluate(`${card('First Light')}.querySelector('.album-open').setAttribute('data-e2e', 'merged'); true`)
    await click('[data-e2e="merged"]')
    await waitFor(`(document.querySelector('#detail[open] [data-ay]')?.textContent || '').includes('FLAC plays first')`, 'merged sheet says which copy plays', 20_000)
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
    await click('#detailClose')
    await waitFor(`${card('First Light')}?.querySelector('[data-aq]').textContent === 'FLAC 16-bit 44.1 kHz'`, 'the FLAC album stands alone again')
    result.checks.mergedAlbum = 'FLAC 16-bit 44.1 kHz · also YouTube, then the YouTube copy removed on its own'
    // A miss in the library filter leads on to Find music with the same words.
    await type('#musicFilter', 'zzqx')
    await waitFor(`$('albums').querySelector('.empty button')?.textContent === 'Search YouTube for “zzqx”'`, 'the library miss offers a search')
    await click('#albums .empty button')
    await waitFor(`$('srcInput').value === 'zzqx' && document.querySelectorAll('#ytResults .yt-pick-row').length === 3`, 'the miss searched Find music')
    await evaluate(`$('musicFilter').value = ''; renderMusic(); true`)
    assert.deepEqual(browser.issues.slice(issuesBefore), [], 'console errors or warnings in the sources flow')
    mark('musicSources')
    await open('#library')

    // Follow a feed.
    clicks = 0
    await clickText('Mirror a catalog')
    await type('#feedInput', stub.base + '/feed.json?token=feedsecret123')
    await clickText('Mirror', '#feedForm')
    result.interactions.followFeed = clicks
    mark('followFeedClicked')
    await waitApi(async () => (await entries()).find(e => e.id === 'clip:feeditem1'), 'feed item mirrored')
    const feeds = (await settingsNow()).settings.feeds.value
    assert.deepEqual(feeds.map(f => f.label), ['127.0.0.1:' + new URL(stub.base).port + '/feed.json'])

    // Copy a channel: follow it and keep a copy.
    const channelKey = randomBytes(32).toString('hex')
    clicks = 0
    await clickText('Copy a channel')
    await type('#copyInput', 'peartube://channel/' + channelKey)
    await clickText('Copy', '#copyForm')
    result.interactions.copyChannel = clicks
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
    await open('#library')
    clicks = 0
    await goTab('Sharing')
    await clickText('Keep copies of', '#copiesCard')
    result.interactions.keepCopies = clicks
    await waitApi(async () => (await settingsNow()).settings.replicate.value === false, 'replication off')

    // The settings round-trip saved a documentation address (192.0.2.10) no interface holds; put the detected one
    // back, or LAN discovery has nothing to bind.
    await fetch(base + '/v1/settings', { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ lanHost: null }) })
    await clickText('Find peers on this network', '#netCard')
    await waitApi(async () => (await getJson('/v1/status')).lan, 'LAN discovery running without a restart', 15_000)
    result.checks.lanLive = (await getJson('/v1/status')).lan
    mark('lan')

    await open('#library')
    clicks = 0
    await goTab('Sharing')
    await type('#hiveInput', 'http://192.168.1.50:9100')
    await type('#hiveKey', 'hr_secretkey_123')
    await clickText('Add HiveRelay')
    result.interactions.hiveRelay = clicks
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

    // 5. Taste gates on every tab, both sizes, both schemes; then the Music tab with results on screen and with the
    // save dialog open.
    browser.issues.length = 0
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      for (const scheme of ['light', 'dark']) {
        await viewport(width, height, scheme)
        for (const tab of ['library', 'music', 'channels', 'sharing', 'tv', 'settings']) {
          const loadStart = Date.now()
          await open('#' + tab)
          const loadMs = Date.now() - loadStart
          await sleep(600)
          const where = width + ' ' + scheme + ' ' + tab
          const audit = await tasteAudit(where)
          await shot(`${tab}-${width}-${scheme}`)
          result.viewports.push({ where, loadMs, ...audit })
        }
        await open('#music')
        await type('#srcInput', 'test band')
        await click('#srcBtn')
        await waitFor(`document.querySelectorAll('#ytResults .yt-pick-row').length === 3`, 'results for the taste gates', 5000)
        await click('#ytResults .item:nth-child(1) input')
        await click('#ytResults .item:nth-child(3) input')
        await sleep(400)
        await tasteAudit(width + ' ' + scheme + ' music with results')
        await shot(`music-sources-${width}-${scheme}`, false, srcShotDir)
        await click('#ytPickSave')
        await waitFor(`$('ytSave').open`, 'save dialog for the taste gates')
        await tasteAudit(width + ' ' + scheme + ' save dialog')
        await shot(`yt-save-${width}-${scheme}`, true, srcShotDir)
        await click('#ytSaveCancel')
      }
    }
    const external = browser.requests.filter(u => /ytimg\.com|youtube\.com/i.test(u))
    assert.deepEqual(external, [], 'the page never contacts YouTube or its image host')
    result.consoleIssues = [...browser.issues]
    // Twenty reloads in one tab: a live-update stream left open per visit would stall the sixth for about a minute.
    const slowest = Math.max(...result.viewports.map(v => v.loadMs))
    assert.ok(slowest < 5000, 'slowest page load took ' + slowest + ' ms')
    assert.deepEqual(browser.issues, [], 'console errors or warnings')
    mark('tasteGates')

    // A stopped relay is named in the header, not left as a stale error under a form.
    relay.kill('SIGTERM')
    await waitFor(`document.querySelector('#pills').textContent.includes('Relay unreachable')`, 'offline pill', 15_000)
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
    relay.kill('SIGTERM')
    await new Promise(resolve => { relay.once('exit', resolve); setTimeout(resolve, 5000) })
    stub.srv.closeAllConnections()
    stub.srv.close()
    for (const dir of [storage, binDir, watchDir]) rmSync(dir, { recursive: true, force: true })
  }
})
