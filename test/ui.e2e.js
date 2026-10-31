// End-to-end check of the relay web UI in headless Brave (`$PUPPETEER_EXECUTABLE_PATH`), driven over CDP:
//   1. Settings: token gate (401), settings.json > env > default precedence with a way back to the env value, 0600 file,
//      round-trip from the UI with every change applied in the running relay, and the Restart relay action.
//   2. Every plugin as a user intent from the first screen, counting clicks: add from URL, import a folder,
//      follow a feed, copy a channel, keep copies, ask a HiveRelay to seed; legacy migration hidden when there is none.
//   3. Content identification against a stubbed Cinemeta and a stub `yt-dlp` on PATH: an exact match is
//      published as `imdb:tt…` (the id MediaStorm searches by), an unknown file as a plain clip, a page link
//      through yt-dlp's metadata.
//   4. Taste gates on every tab at 1440×900 and 390×844 in light and dark: no console errors or warnings, no
//      sideways scroll, no internal plugin ids in visible text, no hint over 12 words, every field labelled
//      with an example placeholder.
// Writes `desktop/target/e2e/ui-result.json` and screenshots to `desktop/target/e2e/ui-audit/after/`.
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
const PLUGIN_IDS = ['http-acquire', 'channel-backfill', 'blob-rechunk', 'watch-dir', 'feed-mirror', 'p2p-replicate', 'hiverelay-seed']
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

function startStub () {
  const files = {
    '/media/Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP.mp4': bytesFor('bbb'),
    '/media/Random.Clip.Name.mp4': bytesFor('random'),
    '/media/feed-item.mp4': bytesFor('feed'),
    '/page-video.mp4': bytesFor('page'),
    '/media/long.mp4': bytesFor('long', 16 * 1024 * 1024),
    '/media/clip.mkv': playableClip(),
    '/media/clip30.mkv': playableClip(30)
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

// A `yt-dlp` that answers for the stub page the way the real one answers for YouTube.
function fakeYtdlp (dir, stubBase) {
  const info = {
    title: 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film',
    uploader: 'Blender',
    duration: 635,
    thumbnail: stubBase + '/thumb.png',
    url: stubBase + '/page-video.mp4',
    http_headers: { 'user-agent': 'stub' },
    extractor_key: 'Youtube',
    webpage_url: stubBase + '/watch?v=aqz-KE-bpKQ',
    height: 360
  }
  const bin = join(dir, 'yt-dlp')
  writeFileSync(bin, '#!/bin/sh\ncat <<\'EOF\'\n' + JSON.stringify(info) + '\nEOF\n')
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
  // `--use-mock-keychain` keeps macOS from asking the login keychain for Brave's storage key on every
  // throwaway profile; an automation run must never put a system dialog in front of the machine.
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--use-mock-keychain', 'about:blank'], { stdio: 'ignore' })
  const portFile = join(dir, 'DevToolsActivePort')
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(100)
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  const issues = []
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
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
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

test('relay web UI: settings, plugins as intents, identification, and taste gates', { timeout: 300_000 }, async () => {
  mkdirSync(shotDir, { recursive: true })
  const storage = mkdtempSync(join(tmpdir(), 'peartube-ui-storage-'))
  const binDir = mkdtempSync(join(tmpdir(), 'peartube-ui-bin-'))
  const watchDir = mkdtempSync(join(tmpdir(), 'peartube-ui-watch-'))
  writeFileSync(join(watchDir, 'Watched.Clip.2019.mp4'), bytesFor('watched'))
  const stub = await startStub()
  const page = fakeYtdlp(binDir, stub.base)
  const apiPort = await freePort()
  const streamPort = await freePort()
  // A settings.json from an earlier run: its concurrency wins over the default.
  writeFileSync(join(storage, 'settings.json'), JSON.stringify({ acquireConcurrency: 2 }), { mode: 0o600 })
  const env = {
    PATH: binDir + ':' + process.env.PATH,
    HOME: process.env.HOME,
    PEARTUBE_STORAGE: storage,
    PEARTUBE_API_PORT: String(apiPort),
    PEARTUBE_API_HOST: '127.0.0.1',
    PEARTUBE_API_TOKEN: TOKEN,
    PEARTUBE_STREAM_PORT: String(streamPort),
    PEARTUBE_BOOTSTRAP: '127.0.0.1:1'
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
  // Marks the visible control whose text is `text` (inside `scope`) and clicks it.
  async function clickText (text, scope = 'body') {
    const mark = 'e2e-' + Math.random().toString(36).slice(2)
    const found = await evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button, ' + ${JSON.stringify(scope)} + ' a, ' + ${JSON.stringify(scope)} + ' label.switch')]
      const e = els.find(x => x.offsetParent !== null && x.textContent.trim().replace(/\\s+/g, ' ').startsWith(${JSON.stringify(text)}))
      if (!e) return false
      e.setAttribute('data-e2e', ${JSON.stringify(mark)})
      return true
    })()`)
    assert.ok(found, 'control "' + text + '" in ' + scope)
    await click(`[data-e2e="${mark}"]`)
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
  async function shot (name) {
    const file = join(shotDir, name + '.png')
    writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'))
    result.screenshots.push(file.slice(root.length))
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
    assert.deepEqual([first.settings.streamPort.source, first.settings.streamPort.value], ['env', streamPort], 'env beats the default')
    assert.deepEqual([first.settings.acquireConcurrency.source, first.settings.acquireConcurrency.value], ['file', 2], 'settings.json beats the default')
    assert.deepEqual([first.settings.dhtPort.source, first.settings.dhtPort.value], ['default', 0])
    result.checks.precedence = true

    // Round-trip from the Settings tab: an env value overridden and put back, a node setting and a live one.
    await goTab('Settings')
    const otherPort = await freePort()
    await evaluate(`document.querySelector('#set-streamPort').value = ''`)
    await type('#set-streamPort', String(otherPort))
    await clickText('Save changes', '.card:has(#set-streamPort)')
    const overridden = await waitApi(async () => { const s = await settingsNow(); return s.settings.streamPort.value === otherPort && s }, 'env value overridden from the UI')
    assert.deepEqual([overridden.settings.streamPort.source, overridden.restartNeeded], ['file', []], 'settings.json wins over the env var, applied at once')
    // Nothing on the Settings tab applies before Save: the env reset, a switch and a list edit all wait.
    await clickText('Use PEARTUBE_STREAM_PORT', '.card:has(#set-streamPort)')
    await evaluate(`document.querySelector('#set-directory').click(); true`)
    await type('#set-allowedPeers', 'ab'.repeat(32))
    await clickText('Add', '.setting:has(#set-allowedPeers)')
    await sleep(1500)
    let held = await settingsNow()
    assert.deepEqual([held.settings.streamPort.value, held.settings.directory.value, held.settings.allowedPeers.value], [otherPort, false, []], 'nothing applied before Save')
    await clickText('Remove', '.setting:has(#set-allowedPeers)')
    await clickText('Save changes', '.card:has(#set-streamPort)')
    await waitApi(async () => { const s = await settingsNow(); return s.settings.streamPort.source === 'env' && s.settings.streamPort.value === streamPort }, 'env value back after Save')
    assert.deepEqual((await settingsNow()).settings.allowedPeers.value, [], 'a list entry added then removed is never saved')
    held = await settingsNow()
    assert.equal(held.settings.directory.value, false, 'the Library card keeps its own unsaved switch')
    await clickText('Save changes', '.card:has(#set-directory)')
    await waitApi(async () => (await settingsNow()).settings.directory.value === true, 'switch applied after Save')
    await evaluate(`document.querySelector('#set-directory').click(); true`)
    await clickText('Save changes', '.card:has(#set-directory)')
    await waitApi(async () => (await settingsNow()).settings.directory.value === false, 'switch back off after Save')
    result.checks.settingsWaitForSave = true
    // "Use PEARTUBE_STREAM_PORT" and then typing a port: the typed port is what Save sends, not the env value.
    const firstPort = await freePort()
    await evaluate(`document.querySelector('#set-streamPort').value = ''`)
    await type('#set-streamPort', String(firstPort))
    await clickText('Save changes', '.card:has(#set-streamPort)')
    await waitApi(async () => (await settingsNow()).settings.streamPort.value === firstPort, 'port overridden again')
    await clickText('Use PEARTUBE_STREAM_PORT', '.card:has(#set-streamPort)')
    const typedPort = await freePort()
    await evaluate(`document.querySelector('#set-streamPort').value = ''`)
    await type('#set-streamPort', String(typedPort))
    assert.equal(await evaluate(`[...document.querySelectorAll('.card:has(#set-streamPort) .tag')].some(t => t.textContent.includes('after saving'))`), false, 'typing drops the pending env reset')
    await clickText('Save changes', '.card:has(#set-streamPort)')
    const typed = await waitApi(async () => { const s = await settingsNow(); return s.settings.streamPort.value === typedPort && s }, 'the typed port is saved')
    assert.equal(typed.settings.streamPort.source, 'file')
    await clickText('Use PEARTUBE_STREAM_PORT', '.card:has(#set-streamPort)')
    await clickText('Save changes', '.card:has(#set-streamPort)')
    await waitApi(async () => (await settingsNow()).settings.streamPort.source === 'env', 'env value back again')
    result.checks.typingCancelsEnvReset = true
    await type('#set-streamHost', '192.168.1.20')
    await clickText('Save changes', '.card:has(#set-streamHost)')
    await waitApi(async () => (await settingsNow()).settings.streamHost.value === '192.168.1.20', 'stream host saved')
    await type('#set-cinemetaUrl', stub.base + '/cinemeta')
    await clickText('Save changes', '.card:has(#set-cinemetaUrl)')
    const saved = await waitApi(async () => { const s = await settingsNow(); return s.settings.cinemetaUrl.value === stub.base + '/cinemeta' && s }, 'lookup service saved')
    assert.equal(saved.settings.streamHost.source, 'file')
    assert.deepEqual(saved.restartNeeded, [], 'every change applied without a restart')
    assert.equal(await evaluate(`document.querySelectorAll('.banner').length`), 0, 'no restart banner')
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
    assert.equal(JSON.parse(readFileSync(join(storage, 'settings.json'), 'utf8')).streamHost, '192.168.1.20')
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

    // A hidden tab gets no animation frames and the browser pauses the muted picture: the sound used to run dry
    // after about 8 s and the picture jumped on return. Now the sound plays on and the picture rejoins it.
    const bgJob = await (await fetch(base + '/v1/acquire', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'clip:backgrounded', title: 'Backgrounded Clip', source: { url: stub.base + '/media/clip30.mkv' } }) })).json()
    await waitApi(async () => (await getJson('/v1/jobs/' + bgJob.jobId)).status === 'done', '30 s clip stored')
    await waitFor(`S.entries.some(e => e.id === 'clip:backgrounded')`, '30 s clip in the library')
    await evaluate(`(() => { openPlayer(S.entries.find(e => e.id === 'clip:backgrounded')); return true })()`)
    await waitFor(`!!player && player.primed && ${clockSecs} >= 2`, '30 s clip playing', 30_000)
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
    await evaluate(`closePlayer(); true`)
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

    // A page link goes through yt-dlp for both its metadata and its file.
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

    // Import a folder.
    await open('#library')
    clicks = 0
    await clickText('Import a folder')
    await type('#folderInput', watchDir)
    await clickText('Import', '#folderForm')
    result.interactions.importFolder = clicks
    mark('importFolderClicked')
    await waitApi(async () => (await entries()).find(e => e.title === 'Watched Clip 2019'), 'watched file imported')
    assert.equal((await settingsNow()).settings.watchDir.value, watchDir)

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

    // 4. Taste gates on every tab, both sizes, both schemes.
    browser.issues.length = 0
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      for (const scheme of ['light', 'dark']) {
        await viewport(width, height, scheme)
        for (const tab of ['library', 'channels', 'sharing', 'tv', 'settings']) {
          const loadStart = Date.now()
          await open('#' + tab)
          const loadMs = Date.now() - loadStart
          await sleep(600)
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
              rawJson: /[{]"[a-zA-Z]+":/.test(text)
            }
          })()`)
          const where = width + ' ' + scheme + ' ' + tab
          assert.ok(audit.scrollWidth <= audit.clientWidth, where + ': sideways scroll ' + audit.scrollWidth + ' > ' + audit.clientWidth)
          assert.deepEqual(audit.pluginIds, [], where + ': internal plugin ids visible')
          assert.deepEqual(audit.longHints, [], where + ': hints over 12 words')
          assert.deepEqual(audit.unlabeled, [], where + ': unlabelled fields')
          assert.deepEqual(audit.noPlaceholder, [], where + ': fields without an example')
          assert.equal(audit.rawJson, false, where + ': raw JSON on screen')
          await shot(`${tab}-${width}-${scheme}`)
          result.viewports.push({ where, loadMs, ...audit })
        }
      }
    }
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
