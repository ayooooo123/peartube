// The relay's HTTP API owner guard, on a real relay process (bin/relay.js under Bare) and on an in-process API that
// sees a public client address:
// - GET /v1/resolve only reads a link: no follow, with or without the token.
// - Writes need the token (or, with none set, a private address) and are refused from another site's page, while
//   Stremio, M3U and blob reads stay open cross-origin.
// - The import folder is env-only: watch-dir ignores a folder in the request and settings refuse `watchDir`.
// - `0` turns PEARTUBE_PRIVATE_ROUTING, PEARTUBE_DIRECTORY, PEARTUBE_HIVERELAY_DISCOVER and PEARTUBE_PRIVATE_RELAY off.
// - SIGTERM ends the relay with exit code 0.
// Writes desktop/target/e2e/api-security-result.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import createTestnet from 'hyperdht/testnet.js'
import { createApi } from '../src/http.js'

const root = new URL('..', import.meta.url).pathname
const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-api-security-'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const artifact = join(root, 'desktop/target/e2e/api-security-result.json')
const results = { startedAt: new Date().toISOString() }
const TOKEN = randomBytes(16).toString('hex')
const EVIL = 'http://evil.example'

function writeResults () {
  mkdirSync(join(root, 'desktop/target/e2e'), { recursive: true })
  writeFileSync(artifact, JSON.stringify({ ...results, updatedAt: new Date().toISOString() }, null, 2) + '\n')
}

function freePort () {
  return new Promise(resolve => {
    const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

async function until (fn, ms, label) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(label)
    await wait(250)
  }
}

test('relay: read-only resolve, owner-only writes, env-only import folder, off flags, clean SIGTERM', { timeout: 180_000 }, async t => {
  const testnet = await createTestnet(3)
  const storage = tmp()
  const watchDir = tmp()
  const elsewhere = tmp()
  writeFileSync(join(watchDir, 'Watched.Clip.2019.mp4'), randomBytes(64 * 1024))
  writeFileSync(join(elsewhere, 'Outside.Clip.2020.mp4'), randomBytes(64 * 1024))
  const apiPort = await freePort()
  const proc = spawn(join(root, 'node_modules/.bin/bare'), [join(root, 'bin/relay.js')], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: storage,
      PEARTUBE_STORAGE: storage,
      PEARTUBE_API_PORT: String(apiPort),
      PEARTUBE_API_HOST: '127.0.0.1',
      PEARTUBE_API_TOKEN: TOKEN,
      PEARTUBE_BOOTSTRAP: testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(','),
      PEARTUBE_WATCH_DIR: watchDir,
      PEARTUBE_PRIVATE_RELAY: '0',
      PEARTUBE_PRIVATE_ROUTING: '0',
      PEARTUBE_DIRECTORY: 'false',
      PEARTUBE_HIVERELAY_DISCOVER: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const logs = []
  createInterface({ input: proc.stderr }).on('line', line => logs.push(line))
  const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })))
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    await testnet.destroy()
    writeResults()
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start: ' + logs.join('\n'))), 60_000)
    createInterface({ input: proc.stdout }).on('line', line => { if (line.includes('relay ready')) { clearTimeout(timer); resolve() } })
    exited.then(e => reject(new Error(`relay exited ${JSON.stringify(e)}: ${logs.join('\n')}`)))
  })
  results.started = { privateRelayZeroIsOff: true }

  const base = `http://127.0.0.1:${apiPort}`
  const auth = { authorization: `Bearer ${TOKEN}` }
  const req = (method, path, { headers = {}, body } = {}) => fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = async (...args) => {
    const res = await req(...args)
    return { status: res.status, headers: res.headers, data: await res.json() }
  }

  // Flags: `0` and `false` are off.
  const settings = (await json('GET', '/v1/settings', { headers: auth })).data.settings
  for (const key of ['privateRouting', 'directory', 'hiverelayDiscover']) {
    assert.equal(settings[key].value, false, `${key} from env "0"/"false" is off`)
    assert.equal(settings[key].source, 'env')
  }
  assert.equal('watchDir' in settings, false, 'the import folder is not a setting')
  assert.equal((await json('GET', '/v1/status')).data.privateRouting, false, 'the node runs without private routing')
  results.flags = { privateRouting: false, directory: false, hiverelayDiscover: false }

  // GET /v1/resolve reads a link and changes nothing, without the token and from another site's page.
  const channel = randomBytes(32).toString('hex')
  const resolved = await json('GET', `/v1/resolve?uri=${encodeURIComponent(`peartube://channel/${channel}?name=Probe`)}`, { headers: { origin: EVIL } })
  assert.equal(resolved.status, 200)
  assert.deepEqual(resolved.data, { action: 'source', key: channel, kind: 'channel', alias: 'Probe' })
  assert.equal(resolved.headers.get('access-control-allow-origin'), '*', 'a read stays open cross-origin')
  const pass = `peartube://access/${channel}:1:${randomBytes(32).toString('hex')}`
  assert.equal((await json('GET', `/v1/resolve?uri=${encodeURIComponent(pass)}`)).data.action, 'access')
  assert.equal((await json('GET', '/v1/resolve?uri=nonsense')).status, 400)
  await wait(500)
  const followed = (await json('GET', '/v1/sources')).data.sources.map(s => s.key)
  assert.ok(!followed.includes(channel), 'resolve followed nothing')
  assert.equal((await json('POST', '/v1/open', { body: { uri: `peartube://channel/${channel}` } })).status, 401, 'opening needs the token')
  results.resolve = { readOnly: true, openNeedsToken: true }

  // Writes: refused from another site's page even with the token; replies carry no wildcard CORS.
  for (const [method, path, body] of [
    ['POST', '/v1/plugins/watch-dir/run', {}],
    ['POST', '/v1/mirror', { plugin: 'watch-dir' }],
    ['POST', '/v1/open', { uri: `peartube://channel/${channel}` }],
    ['POST', '/v1/sources', { key: channel, kind: 'channel' }],
    ['POST', '/v1/cache/clear', {}],
    ['POST', '/v1/acquire', { id: 'clip:abcdef', title: 'x', source: { url: 'https://example.org/x.mp4' } }],
    ['PUT', '/v1/settings', { acquireConcurrency: 2 }]
  ]) {
    const res = await json(method, path, { headers: { ...auth, origin: EVIL }, body })
    assert.equal(res.status, 403, `${method} ${path} from another site's page`)
    assert.equal(res.headers.get('access-control-allow-origin'), null, `${method} ${path} reply is not readable cross-origin`)
  }
  const preflight = await req('OPTIONS', '/v1/mirror', { headers: { origin: EVIL, 'access-control-request-method': 'POST' } })
  assert.ok(!/POST|PUT|DELETE/.test(preflight.headers.get('access-control-allow-methods') || ''), 'preflight allows no write method')
  // The same writes from the relay's own page go through.
  const own = { ...auth, origin: base }
  assert.equal((await json('PUT', '/v1/settings', { headers: own, body: { acquireConcurrency: 2 } })).status, 200)
  results.origin = { crossOriginWritesRefused: 7, ownPageAllowed: true }

  // Reads for players stay open cross-origin.
  for (const path of ['/manifest.json', '/v1/playlist.m3u', '/v1/entries', '/v1/status']) {
    const res = await req('GET', path, { headers: { origin: EVIL } })
    assert.equal(res.status, 200, path)
    assert.equal(res.headers.get('access-control-allow-origin'), '*', `${path} stays open cross-origin`)
  }

  // The import folder is env-only.
  const entries = async () => (await json('GET', '/v1/entries')).data.results.map(e => e.title)
  await until(async () => (await entries()).includes('Watched Clip 2019'), 60_000, 'the env folder was imported at start')
  const refused = await json('PUT', '/v1/settings', { headers: own, body: { watchDir: elsewhere } })
  assert.equal(refused.status, 400, 'watchDir cannot be set over the API')
  writeFileSync(join(watchDir, 'Second.Clip.2021.mp4'), randomBytes(64 * 1024))
  const run = await json('POST', '/v1/plugins/watch-dir/run', { headers: own, body: { dir: elsewhere } })
  assert.equal(run.status, 200)
  assert.deepEqual(run.data.items.map(i => i.file), ['Second.Clip.2021.mp4'], 'the run scanned the env folder, not the one asked for')
  const viaMirror = await json('POST', '/v1/mirror', { headers: own, body: { plugin: 'watch-dir', dir: elsewhere } })
  assert.equal(viaMirror.data.ingested, 0)
  const titles = await entries()
  assert.ok(!titles.includes('Outside Clip 2020'), 'nothing outside the env folder was imported')
  const plugins = await (await req('GET', '/v1/plugins')).text()
  assert.ok(!plugins.includes(watchDir) && !plugins.includes(elsewhere), '/v1/plugins never names a folder')
  results.watchDir = { envFolderImported: true, payloadDirIgnored: true, settingRefused: true }

  // SIGTERM: a clean stop exits 0.
  proc.kill('SIGTERM')
  const end = await exited
  assert.deepEqual(end, { code: 0, signal: null }, 'SIGTERM exits with code 0, not a SIGKILL')
  results.sigterm = end
})

test('API: a public client without the token cannot write; with it, only a matching token passes', { timeout: 30_000 }, async t => {
  const runs = []
  const state = {
    node: null,
    acquirer: null,
    mirror: { run: async (name, payload) => { runs.push(name); return { name, payload } }, list: () => [] },
    cast: null
  }
  const listen = async apiToken => {
    const api = createApi({ ...state, apiToken })
    // The client looks like a public address (203.0.113.0/24, TEST-NET-3), as it would over the internet.
    api.prependListener('connection', socket => Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.9' }))
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
    t.after(() => api.close())
    return `http://127.0.0.1:${api.address().port}`
  }
  const post = (base, path, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })

  const open = await listen(null)
  for (const path of ['/v1/plugins/watch-dir/run', '/v1/mirror', '/v1/open', '/v1/sources', '/v1/acquire', '/v1/cache/clear', '/v1/identify']) {
    assert.equal((await post(open, path)).status, 403, `${path} from a public address without a token`)
  }
  assert.equal((await fetch(open + '/v1/settings')).status, 403)
  const status = await (await fetch(open + '/v1/status')).json()
  assert.equal(status.settingsOpen, false)
  assert.equal((await fetch(open + `/v1/resolve?uri=${randomBytes(32).toString('hex')}`)).status, 200, 'reads stay open')
  assert.deepEqual(runs, [], 'no plugin ran')

  const locked = await listen(TOKEN)
  assert.equal((await post(locked, '/v1/mirror')).status, 401, 'no token')
  assert.equal((await post(locked, '/v1/mirror', { authorization: `Bearer ${'0'.repeat(TOKEN.length)}` })).status, 401, 'wrong token of the same length')
  assert.equal((await post(locked, '/v1/mirror', { authorization: `Bearer ${TOKEN}x` })).status, 401, 'longer token')
  assert.deepEqual(runs, [])
  assert.equal((await post(locked, '/v1/mirror', { authorization: `Bearer ${TOKEN}` })).status, 200, 'the token passes')
  assert.deepEqual(runs, ['http-acquire'])
  results.publicClient = { writesRefusedWithoutToken: true, tokenCompared: true }
  writeResults()
})

test('API: a DNS-rebound Host header on a tokenless LAN/loopback socket cannot read settings or write', { timeout: 30_000 }, async t => {
  const runs = []
  const api = createApi({
    node: { status: () => ({ peers: 0 }), findEntry: async () => ({ blobs: 'a'.repeat(64), blob: { blockOffset: 0, blockLength: 1, byteLocation: 0, byteLength: 10 }, size: 10 }), entryHealth: () => ({ open: true, peers: 2 }), streamUrl: () => 'http://127.0.0.1:1/?key=x', heldBytes: async () => 0 },
    acquirer: null,
    cast: null,
    apiToken: null,
    settings: { view: () => ({ settings: { ok: true } }), update: () => ({ changed: [] }) },
    mirror: { run: async name => { runs.push(name); return { name } }, list: () => [] }
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => api.close())
  const port = api.address().port

  const raw = (method, path, headers) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => {
      let text = ''
      res.on('data', d => { text += d })
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }))
    })
    req.on('error', reject)
    if (method === 'POST') req.write('{}')
    req.end()
  })

  const rebound = `attacker.example:${port}`
  assert.equal((await raw('GET', '/v1/settings', { host: rebound, origin: `http://${rebound}` })).status, 403, 'DNS-rebound settings read refused')
  assert.equal((await raw('POST', '/v1/mirror', { host: rebound, origin: `http://${rebound}`, 'content-type': 'application/json' })).status, 403, 'DNS-rebound matching-Origin write refused')
  assert.equal((await raw('POST', '/v1/mirror', { host: rebound, 'content-type': 'application/json' })).status, 403, 'DNS-rebound simple POST without Origin refused')
  assert.equal((await raw('GET', '/v1/status', { host: rebound })).data.settingsOpen, false, 'status marks settings closed under DNS-rebound Host')
  assert.equal('health' in (await raw('GET', '/v1/entries/info?key=k', { host: rebound, origin: `http://${rebound}` })).data, false, 'DNS-rebound page gets no live entry health')
  assert.deepEqual(runs, [], 'no plugin ran under DNS rebinding')

  // Local Host forms (`127.0.0.1`, `[::1]`, `localhost`, `.local`) still work without a token on LAN.
  for (const h of [`127.0.0.1:${port}`, `[::1]:${port}`, `localhost:${port}`, `relay.local:${port}`]) {
    assert.equal((await raw('GET', '/v1/settings', { host: h, origin: `http://${h}` })).status, 200, `${h} allowed`)
  }
  assert.equal((await raw('POST', '/v1/mirror', { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' })).status, 200)
  assert.deepEqual(runs, ['http-acquire'])
  results.dnsRebinding = { reboundRefused: true, localHostsAllowed: true }
  writeResults()
})
