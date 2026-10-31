// The relay applies settings in its running process, and its opt-in guard helps private peers while it stays direct.
//   1. A value from an env var can be changed from the API (settings.json wins) and put back to the env value.
//   2. A setting that shapes the node (the stream port) applies at once: same process, nothing left to restart.
//   3. POST /v1/restart reopens the node in place with the same tracker. Turning the env-set directory off unlists the
//      followed source it listed, keeps one listed by hand, and turning it back on lists the followed source again.
//      Turning on "Convert at every start" runs the conversion at once.
//   4. A reopen that fails does not lock the relay's storage: a LAN address this machine lacks no longer stops the
//      node from opening, and after a failure that does (an unreadable saved source), fixing it and restarting works.
//   5. The peer port and the guard port cannot be set to the same port, in either order.
//   6. `privateGuard` starts bin/private-relay.js as a child process. Two private-routing peers fail closed with fewer
//      than two guards, so their sync with one standalone guard plus the relay's proves the relay's guard carried them,
//      while a public peer still syncs with the relay directly. Restart brings back a guard whose process died, and
//      turning it off withdraws the guard announcement.
// Separate relays check that a relay first run with the directory off never unlists sources listed by hand, and that
// a reopen during a folder import waits for one file, not the whole import, without losing or duplicating any.
// Writes desktop/target/e2e/relay-settings-result.json.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import HyperDHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createAcquirer } from '../src/acquire.js'
import { createPrivateGuard } from '../src/private-overlay.js'

const root = new URL('..', import.meta.url).pathname
const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-relay-settings-'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const artifact = join(root, 'desktop/target/e2e/relay-settings-result.json')
const GUARD_TOPICS = [0, 1, 2, 3].map(i => HyperDHT.hash(Buffer.from(`peartube/private-guard/v1/${i}`)))
const results = { startedAt: new Date().toISOString() }

after(() => {
  mkdirSync(join(root, 'desktop/target/e2e'), { recursive: true })
  writeFileSync(artifact, JSON.stringify({ ...results, finishedAt: new Date().toISOString() }, null, 2) + '\n')
})

function freePort () {
  return new Promise(resolve => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function listening (port) {
  return new Promise(resolve => {
    const sock = connect(port, '127.0.0.1')
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
}

async function until (fn, ms, label) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out: ' + label)
    await wait(250)
  }
}

async function guardKeysOnDht (bootstrap) {
  const dht = new HyperDHT({ bootstrap, host: '127.0.0.1' })
  const keys = new Set()
  try {
    for (const topic of GUARD_TOPICS) {
      for await (const reply of dht.lookup(topic)) for (const peer of reply.peers) keys.add(peer.publicKey.toString('hex'))
    }
  } finally {
    await dht.destroy()
  }
  return keys
}

// A relay process (bin/relay.js under Bare) on the testnet, with a small API client.
async function startRelay (testnet, extraEnv = {}) {
  const storage = tmp()
  const apiPort = await freePort()
  const proc = spawn(join(root, 'node_modules/.bin/bare'), [join(root, 'bin/relay.js')], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: storage,
      PEARTUBE_STORAGE: storage,
      PEARTUBE_API_PORT: String(apiPort),
      PEARTUBE_API_HOST: '127.0.0.1',
      PEARTUBE_STREAM_HOST: '127.0.0.1',
      PEARTUBE_BOOTSTRAP: testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(','),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const logs = []
  createInterface({ input: proc.stderr }).on('line', line => logs.push(line))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start: ' + logs.join('\n'))), 60_000)
    createInterface({ input: proc.stdout }).on('line', line => { if (line.includes('relay ready')) { clearTimeout(timer); resolve() } })
    proc.once('exit', code => reject(new Error('relay exited ' + code + ': ' + logs.join('\n'))))
  })
  const base = 'http://127.0.0.1:' + apiPort
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, data: await res.json() }
  }
  return {
    proc,
    storage,
    logs,
    get: async path => (await call('GET', path)).data,
    call,
    async send (method, path, body) {
      const { status, data } = await call(method, path, body)
      assert.equal(status, 200, `${method} ${path}: ${JSON.stringify(data)}`)
      return data
    },
    stop: () => new Promise(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      proc.once('exit', resolve)
      proc.kill('SIGTERM')
    })
  }
}

test('relay settings apply in place; its guard serves private peers while the relay stays direct', { timeout: 300_000 }, async t => {
  const result = results.main = { pass: false, checks: {} }
  const testnet = await createTestnet(3)
  const nodes = []
  let relay = null
  let soloGuard = null
  t.after(async () => {
    await relay?.stop()
    await Promise.all(nodes.map(n => n.close().catch(() => {})))
    await soloGuard?.close().catch(() => {})
    await testnet.destroy()
  })

  const envStreamPort = await freePort()
  relay = await startRelay(testnet, { PEARTUBE_STREAM_PORT: String(envStreamPort), PEARTUBE_DIRECTORY: '1' })
  const { get, send, call, storage } = relay
  const pid = relay.proc.pid
  const { tracker, writer } = await get('/v1/status')
  assert.match(tracker, /^[0-9a-f]{64}$/)

  // 1. An env value is changeable, and can be put back.
  let s = await get('/v1/settings')
  assert.deepEqual([s.settings.directory.source, s.settings.directory.value, s.settings.directory.envSet], ['env', true, true])
  s = await send('PUT', '/v1/settings', { directory: false })
  assert.deepEqual(s.changed, ['directory'])
  assert.deepEqual([s.settings.directory.source, s.settings.directory.value], ['file', false], 'settings.json wins over the env var')
  assert.equal(JSON.parse(readFileSync(join(storage, 'settings.json'), 'utf8')).directory, false)
  s = await send('PUT', '/v1/settings', { directory: null })
  assert.deepEqual([s.settings.directory.source, s.settings.directory.value], ['env', true], 'null puts the env value back')
  result.checks.envOverride = true

  // 2. A node setting applies without restarting the process.
  assert.ok(await listening(envStreamPort), 'blob server on the env port')
  let streamPort = await freePort()
  s = await send('PUT', '/v1/settings', { streamPort })
  assert.deepEqual([s.settings.streamPort.source, s.settings.streamPort.value], ['file', streamPort])
  assert.deepEqual(s.restartNeeded, [], 'nothing waits for a restart')
  assert.ok(await listening(streamPort), 'blob server moved to the new port')
  assert.equal(await listening(envStreamPort), false, 'old port closed')
  assert.equal(relay.proc.exitCode, null)
  assert.equal(relay.proc.pid, pid)
  const reopened = await get('/v1/status')
  assert.deepEqual([reopened.tracker, reopened.writer], [tracker, writer], 'same tracker and writer after the reopen')
  result.checks.liveReopen = { streamPort, pid }

  // 3. The restart action reopens in place.
  s = await send('POST', '/v1/restart')
  assert.deepEqual(s.restartNeeded, [])
  assert.equal((await get('/v1/status')).tracker, tracker)
  assert.ok(await listening(streamPort))
  assert.equal(relay.proc.exitCode, null)
  result.checks.restartAction = true

  // The directory: a followed source is listed by the setting, a hand-listed one belongs to the user.
  const other = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  nodes.push(other)
  const followed = other.status().tracker
  const byHand = randomBytes(32).toString('hex')
  const listed = async () => new Set((await get('/v1/sources')).published.map(p => p.key))
  await send('POST', '/v1/sources', { key: followed, kind: 'tracker' })
  await until(async () => (await listed()).has(followed), 30_000, 'followed source listed by the directory setting')
  await send('POST', '/v1/channel/publish', { type: 'source', sourceKey: byHand, kind: 'channel', title: 'Hand listed', target: 'both' })
  assert.ok((await listed()).has(byHand))
  await send('PUT', '/v1/settings', { directory: false })
  let now = await listed()
  assert.equal(now.has(followed), false, 'turning the directory off unlists what it listed')
  assert.equal(now.has(byHand), true, 'a hand-listed source stays listed')
  await send('PUT', '/v1/settings', { directory: null })
  now = await listed()
  assert.deepEqual([now.has(followed), now.has(byHand)], [true, true], 'back on: the followed source is listed again')
  const ledger = JSON.parse(readFileSync(join(storage, 'directory.json'), 'utf8'))
  assert.deepEqual(ledger.sort(), [followed, (await get('/v1/status')).channel].sort(), 'the setting lists followed sources and this relay\'s channel, never the hand-listed one')
  result.checks.directory = { followed, byHand }

  // "Convert at every start": turning it on runs the conversion now, in place; turning it off starts nothing.
  const conversions = async () => (await get('/v1/plugins')).plugins.find(p => p.name === 'blob-rechunk').runs
  const before = await conversions()
  await send('PUT', '/v1/settings', { rechunk: true })
  await until(async () => (await conversions()) === before + 1, 10_000, 'conversion started when turned on')
  await send('PUT', '/v1/settings', { rechunk: false })
  await wait(500)
  assert.equal(await conversions(), before + 1, 'turning it off starts nothing')
  assert.equal(relay.proc.pid, pid)
  result.checks.rechunk = { runsBefore: before, runsAfter: before + 1 }

  // 4. A LAN address this machine lacks: the live switch reports it, and the next reopen still opens the node.
  s = await send('PUT', '/v1/settings', { lan: true, lanHost: '203.0.113.5' })
  assert.ok(s.warning, 'the live LAN switch reports the bad address')
  streamPort = await freePort()
  s = await send('PUT', '/v1/settings', { streamPort })
  assert.equal(s.warning, undefined, 'the reopen opens the node without LAN: ' + s.warning)
  assert.deepEqual(s.restartNeeded, [])
  assert.equal((await get('/v1/status')).writer, writer, 'node open after the reopen')
  await send('PUT', '/v1/settings', { lan: null, lanHost: null })
  // A failure that does stop the node from opening (an unreadable saved source) must not lock its storage.
  const sourcesFile = join(storage, 'sources.json')
  const goodSources = readFileSync(sourcesFile, 'utf8')
  writeFileSync(sourcesFile, JSON.stringify([{ key: 'not-a-key', kind: 'channel' }]))
  streamPort = await freePort()
  s = await send('PUT', '/v1/settings', { streamPort })
  assert.ok(s.warning, 'the reopen reports the bad source')
  assert.deepEqual(s.restartNeeded, ['streamPort'], 'the change waits while the node is down')
  assert.equal((await get('/v1/status')).writer, '', 'no node while the source is unreadable')
  writeFileSync(sourcesFile, goodSources)
  s = await send('POST', '/v1/restart')
  assert.deepEqual(s.restartNeeded, [], 'restart applies the waiting change once the source is fixed')
  assert.equal((await get('/v1/status')).writer, writer, 'the same node opens again')
  assert.ok(await listening(streamPort))
  result.checks.failedReopenRecovers = true

  // 5. The guard port and the peer port must differ, whichever is set second.
  const clashPort = await freePort()
  await send('PUT', '/v1/settings', { privateGuard: true, privateGuardPort: clashPort })
  let clash = await call('PUT', '/v1/settings', { dhtPort: clashPort })
  assert.equal(clash.status, 400, 'peer port onto the guard port is refused')
  assert.equal((await get('/v1/settings')).settings.dhtPort.value, 0, 'peer port unchanged')
  await send('PUT', '/v1/settings', { privateGuard: false, privateGuardPort: 0 })
  const peerPort = await freePort()
  await send('PUT', '/v1/settings', { dhtPort: peerPort })
  clash = await call('PUT', '/v1/settings', { privateGuard: true, privateGuardPort: peerPort })
  assert.equal(clash.status, 400, 'guard port onto the peer port is refused')
  assert.equal((await get('/v1/status')).privateGuard, null, 'no guard started')
  await send('PUT', '/v1/settings', { dhtPort: null })
  result.checks.portClash = true

  // 6. The guard: private peers need two guards; the relay supplies the second one.
  soloGuard = await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  s = await send('PUT', '/v1/settings', { privateGuard: true })
  const guard = (await get('/v1/status')).privateGuard
  assert.match(guard?.publicKey || '', /^[0-9a-f]{64}$/, 'status names the running guard')
  assert.ok(guard.port > 0)
  assert.ok((await guardKeysOnDht(testnet.bootstrap)).has(guard.publicKey), 'the guard is announced')

  const seeder = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, privateRouting: true })
  nodes.push(seeder)
  const reader = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker: seeder.status().tracker, privateRouting: true })
  nodes.push(reader)
  const viewer = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  nodes.push(viewer)
  await seeder.publish({ id: 'imdb:tt0300001', title: 'Through two guards' }, Readable.from([randomBytes(65536)]))
  const [entry] = await until(async () => { const r = await reader.search('imdb:tt0300001'); return r.length && r }, 120_000, 'private reader synced through the relay guard')
  assert.equal(entry.title, 'Through two guards')
  assert.equal(reader.status().routes.public.rxBytes, 0, 'private peers used no direct route')
  const direct = await until(async () => { const st = await get('/v1/status'); return st.routes.public.peers > 0 && viewer.status().peers > 0 && st }, 120_000, 'public viewer connected to the relay directly')
  assert.equal(direct.privateRouting, false, 'the relay itself stays on direct connections')
  result.checks.guard = { publicKey: guard.publicKey, port: guard.port, privateEntry: entry.id, relayPublicPeers: direct.routes.public.peers }

  // The guard's process dies: status says so, and Restart relay brings a guard back.
  process.kill(Number(execFileSync('pgrep', ['-P', String(pid), '-f', 'private-relay.js']).toString().trim()), 'SIGKILL')
  await until(async () => (await get('/v1/status')).privateGuard === null, 10_000, 'status shows the guard gone')
  await send('POST', '/v1/restart')
  const restored = (await get('/v1/status')).privateGuard
  assert.match(restored?.publicKey || '', /^[0-9a-f]{64}$/, 'restart brings the guard back')
  assert.notEqual(restored.publicKey, guard.publicKey, 'a new guard process with a fresh key')
  await until(async () => (await guardKeysOnDht(testnet.bootstrap)).has(restored.publicKey), 30_000, 'restored guard announced')
  result.checks.guardRestored = restored.publicKey

  s = await send('PUT', '/v1/settings', { privateGuard: false })
  assert.equal((await get('/v1/status')).privateGuard, null)
  await until(async () => !(await guardKeysOnDht(testnet.bootstrap)).has(restored.publicKey), 30_000, 'guard announcement withdrawn')
  assert.equal(relay.proc.exitCode, null)
  result.checks.guardOff = true
  result.pass = true
})

test('a relay first run with the directory off never unlists sources listed by hand', { timeout: 120_000 }, async t => {
  const result = results.directoryFromOff = { pass: false }
  const testnet = await createTestnet(3)
  const other = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const relay = await startRelay(testnet)
  t.after(async () => {
    await relay.stop()
    await other.close()
    await testnet.destroy()
  })
  const followed = other.status().tracker
  const listed = async () => new Set((await relay.get('/v1/sources')).published.map(p => p.key))
  await relay.send('POST', '/v1/sources', { key: followed, kind: 'tracker' })
  await relay.send('POST', '/v1/channel/publish', { type: 'source', sourceKey: followed, kind: 'tracker', title: 'Hand listed', target: 'both' })
  assert.ok((await listed()).has(followed))
  await relay.send('PUT', '/v1/settings', { directory: true })
  await relay.send('PUT', '/v1/settings', { directory: false })
  assert.ok((await listed()).has(followed), 'a source listed by hand before the setting was on stays listed')
  result.pass = true
})

test('a reopen during a folder import waits for one file, and no file is lost or imported twice', { timeout: 180_000 }, async t => {
  const result = results.importReopen = { pass: false }
  const testnet = await createTestnet(3)
  const watchDir = tmp()
  const relay = await startRelay(testnet, { PEARTUBE_WATCH_DIR: watchDir, PEARTUBE_PUBLISH_CHANNEL: '0' })
  t.after(async () => {
    await relay.stop()
    await testnet.destroy()
  })
  const files = 400
  for (let i = 0; i < files; i++) writeFileSync(join(watchDir, `Clip.${String(i).padStart(3, '0')}.mp4`), randomBytes(64 * 1024))
  const imported = async () => (await relay.get('/v1/entries')).results.length
  // The import runs while the plugins start, after the first reopen.
  await relay.send('PUT', '/v1/settings', { streamPort: await freePort() })
  await until(async () => (await imported()) >= 5, 60_000, 'import under way')
  const started = Date.now()
  await relay.send('PUT', '/v1/settings', { streamPort: await freePort() })
  const reopenMs = Date.now() - started
  const atReopen = await imported()
  assert.ok(atReopen < files, 'the import was still running when the reopen finished')
  const done = await until(async () => { const n = await imported(); return n >= files && n }, 120_000, 'import finished after the reopen')
  const importMs = Date.now() - started
  assert.equal(done, files, 'every file imported exactly once')
  assert.ok(reopenMs * 3 < importMs, `the reopen (${reopenMs} ms) did not wait for the import (${importMs} ms)`)
  Object.assign(result, { files, reopenMs, importMs, importedAtReopen: atReopen, pass: true })
})

test('a closed acquirer never announces a download that finished after it closed', { timeout: 30_000 }, async t => {
  const result = results.acquirerClose = { pass: false }
  const body = randomBytes(4096)
  const source = createHttpServer((req, res) => res.end(body))
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  t.after(() => source.close())
  let finishPut = null
  const appended = []
  const node = {
    closing: false,
    async put (meta, stream) {
      for await (const chunk of stream) void chunk
      await new Promise(resolve => { finishPut = resolve })
      return { type: 'announce', id: meta.id, title: meta.title, blobs: 'a'.repeat(64), size: body.length, sha256: 'b'.repeat(64) }
    },
    async append (op) { appended.push(op) }
  }
  const jobsFile = join(tmp(), 'jobs.json')
  const acquirer = createAcquirer(node, jobsFile, { concurrency: 1 })
  acquirer.add({ id: 'clip:closerace', title: 'Close race', source: { url: `http://127.0.0.1:${source.address().port}/` } })
  await until(() => finishPut, 10_000, 'download reached the store')
  acquirer.close()
  finishPut()
  await wait(200)
  assert.deepEqual(appended, [], 'nothing announced after close')
  const [saved] = JSON.parse(readFileSync(jobsFile, 'utf8'))
  assert.equal(saved.status, 'running', 'jobs.json keeps the job for the next acquirer')
  assert.ok(saved.source, 'with its source, so the next acquirer fetches it again')
  result.pass = true
})
