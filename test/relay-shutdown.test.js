// A relay told to stop while it is busy still stops its plugins, then closes its node, then exits 0.
// Each case runs bin/relay.js under Bare with its API on loopback and a testnet for its DHT. Probe plugins in its
// plugins folder print what happened, in order: each plugin host they were loaded for, each plugin stop, each call of
// the node's close() and its end, and at exit whether the node's store was closed. Marker probes print work that a
// relay must not start after the signal: each run of a plugin (the startup backfill, and the runs that a live
// settings change starts), each file that the folder import puts, and each live settings change that begins.
//   1. A restart is inside a plugin stop that outlasts the 2 s shutdown waits for it. Shutdown then asks for a stop of
//      its own: it must wait for the restart's stop to close the node, not find the node taken and exit.
//   2. A restart's plugin stop ends inside those 2 s. The restart must not open a replacement node.
//   3. On a relay that keeps running, every marker appears: a start runs the backfill and the folder import, and a
//      live settings change begins and starts its runs. Without this, "no marker" below would prove nothing.
//   4. The signal arrives while a plugin is still loading at startup, before the plugin host can be closed. The host
//      must be closed as soon as it can be: every plugin stops once, no backfill and no folder import start, the node
//      closes after the stops, and the relay does not announce a node it no longer has.
//   5. The same, while a live settings change waits for the plugins to load. Shutdown gives that change 2 s before it
//      asks for a stop, so no stop has begun when the host can be closed: the host must be closed all the same, the
//      change must start no run when it goes on, and a second change that waited behind it must not begin.
//   6. A settings change that reopens the node arrives while a plugin is still loading, and the signal arrives during
//      that reopen's stop. The startup's guard step waited behind the reopen and is refused: the relay must not
//      report that as a guard that failed to start.
//   7. The guard starts but never becomes ready, its script exits 17 on the signal. The relay did try to start it, so
//      it must report the failure, even though the signal came first; only a refused step goes unreported.
// Every case also fails when a stop runs twice, or when the relay ends by its own 3 s limit instead of exiting 0.
// The relay also looks for cast receivers by mDNS on the machine's LAN address, as every relay does; no case uses it.
// Writes desktop/target/e2e/relay-shutdown-result.json.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import createTestnet from 'hyperdht/testnet.js'

const root = new URL('..', import.meta.url).pathname
const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-relay-shutdown-'))
const artifact = join(root, 'desktop/target/e2e/relay-shutdown-result.json')
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

// The probe plugins use only globals: Bare resolves no package from a plugins folder outside the repository.
// Their module state lasts as long as the process, so a replacement plugin host calls the same factory again.
const probe = `
const emit = (event, more = {}) => console.log(JSON.stringify({ msg: 'probe', event, at: Date.now(), ...more }))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const signalled = new Promise(resolve => process.once('SIGTERM', resolve))
`
// Reports each plugin host, the node's close() and the store at exit. Its stop ends `stopMs` after the shutdown
// signal, however long before the signal it was called: the relay's own 2 s wait starts at the same signal.
const slowPlugin = stopMs => probe + `
let hosts = 0
export default function ({ node }) {
  const host = ++hosts
  emit('host', { host })
  const close = node.close
  node.close = function (...args) {
    emit('node-close-entered', { host })
    const closing = close.apply(this, args)
    closing.then(() => emit('node-close-finished', { host }), () => emit('node-close-failed', { host }))
    return closing
  }
  process.on('exit', () => emit('exit', { host, storeClosed: node.store.closed }))
  return {
    name: 'probe-slow',
    async stop () {
      emit('stop-started', { plugin: 'slow', host })
      await signalled
      await sleep(${stopMs})
      emit('stop-finished', { plugin: 'slow', host })
    }
  }
}
`
const failPlugin = probe + `
export default () => ({
  name: 'probe-fail',
  stop () {
    emit('stop-started', { plugin: 'fail' })
    throw new Error('probe: this stop always fails')
  }
})
`
// Reports the signal to the case. The relay's own SIGTERM handler is registered before any plugin loads, so
// `shuttingDown` is true by the time this plugin's promise resolution runs.
const signalPlugin = probe + `
export default () => {
  signalled.then(() => emit('signal-seen'))
  return { name: 'probe-signal' }
}
`
// Its factory returns only when `release` settles: until then the plugin host has loaded only part of its plugins.
const holdPlugin = release => probe + `
export default async function () {
  emit('factory-held')
  await ${release}
  emit('factory-returned')
  return { name: 'probe-hold', stop () { emit('stop-started', { plugin: 'hold' }) } }
}
`
// 75 ms after the shutdown signal.
const afterSignal = 'signalled.then(() => sleep(75))'
// When the case calls relay.release().
const whenReleased = 'new Promise(resolve => process.once(\'SIGUSR2\', resolve))'
// Marks work that reaches the node: each file that the folder import puts, and each live settings change that begins
// (a live change applies `cacheMaxGb` before it waits for anything, and every live change in these cases sets it).
const marksPlugin = probe + `
export default function ({ node }) {
  for (const [method, event] of [['put', 'put'], ['setCacheMaxBytes', 'change-began']]) {
    const real = node[method]
    node[method] = function (...args) {
      emit(event)
      return real.apply(this, args)
    }
  }
  return { name: 'probe-marks' }
}
`
// Takes the place of a built-in plugin (the host keeps the plugin registered last under a name) and marks its runs.
const runMarker = name => probe + `
export default () => ({ name: '${name}', run () { emit('run', { plugin: '${name}' }) } })
`
// The marker probes. A case's `30-hold.mjs` loads after the node marks and before the run markers; the host can be
// closed only after all of them have loaded.
const markers = {
  '15-marks.mjs': marksPlugin,
  '40-backfill.mjs': runMarker('channel-backfill'),
  '41-rechunk.mjs': runMarker('blob-rechunk'),
  '42-media-check.mjs': runMarker('media-check')
}

// A relay process (bin/relay.js under Bare) on its own testnet, with `plugins` in its plugins folder. `script` is the
// relay file to run; the last case runs a copy, so that the relay finds its own fake private-relay.js beside it.
async function startRelay (t, plugins, extraEnv = {}, script = join(root, 'bin/relay.js')) {
  const testnet = await createTestnet(3)
  const storage = tmp()
  mkdirSync(join(storage, 'plugins'))
  for (const [file, source] of Object.entries(plugins)) writeFileSync(join(storage, 'plugins', file), source)
  const apiPort = await freePort()
  const proc = spawn(join(root, 'node_modules/.bin/bare'), [script], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: storage,
      PEARTUBE_STORAGE: storage,
      PEARTUBE_API_PORT: String(apiPort),
      PEARTUBE_API_HOST: '127.0.0.1',
      PEARTUBE_BOOTSTRAP: testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(','),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const lines = []
  const errors = []
  let wake = () => {}
  let signalAt = null
  const out = createInterface({ input: proc.stdout }).on('line', line => {
    let parsed = null
    try { parsed = JSON.parse(line) } catch {}
    lines.push(parsed && typeof parsed === 'object' ? parsed : { msg: line })
    wake()
  })
  const err = createInterface({ input: proc.stderr }).on('line', line => { errors.push(line); wake() })
  // Resolves once the process has gone and all of its output is read.
  const ended = Promise.all([once(proc, 'close'), once(out, 'close'), once(err, 'close')]).then(([[code, signal]]) => {
    const events = lines.filter(l => l.msg === 'probe').map(({ msg, at, ...e }) => ({ ...e, msAfterSignal: signalAt === null ? null : at - signalAt }))
    return { code, signal, events, ready: lines.some(l => l.msg === 'relay ready'), errors, storage }
  })
  let gone = false
  ended.then(() => { gone = true; wake() })
  t.after(async () => {
    if (!gone) proc.kill('SIGKILL')
    await ended
    await testnet.destroy()
    rmSync(storage, { recursive: true, force: true })
  })
  return {
    base: 'http://127.0.0.1:' + apiPort,
    storage,
    ended,
    // The first line of the relay's output that `match` accepts.
    async seen (label, match) {
      const end = Date.now() + 60_000
      for (;;) {
        const hit = lines.find(match)
        if (hit) return hit
        if (gone) throw new Error(`The relay ended before: ${label}\n${errors.join('\n')}`)
        if (Date.now() > end) throw new Error(`Timed out: ${label}\n${errors.join('\n')}`)
        await new Promise(resolve => { wake = resolve; setTimeout(resolve, 250) })
      }
    },
    // The first line of the relay's error output that `match` accepts, raw.
    async seenError (label, match) {
      const end = Date.now() + 60_000
      for (;;) {
        const hit = errors.find(match)
        if (hit) return hit
        if (gone) throw new Error(`The relay ended before: ${label}\n${errors.join('\n')}`)
        if (Date.now() > end) throw new Error(`Timed out: ${label}\n${errors.join('\n')}`)
        await new Promise(resolve => { wake = resolve; setTimeout(resolve, 250) })
      }
    },
    signal () {
      signalAt = Date.now()
      proc.kill('SIGTERM')
    },
    // Lets a factory held with `whenReleased` return.
    release () {
      proc.kill('SIGUSR2')
    }
  }
}

const probeEvent = (event, plugin) => l => l.msg === 'probe' && l.event === event && (!plugin || l.plugin === plugin)
const namesOf = run => run.events.map(e => e.plugin ? `${e.event}:${e.plugin}` : e.event)
const traceOf = run => `\n${namesOf(run).join(', ') || '(no probe events)'}\n${run.errors.slice(-5).join('\n')}`

// What every case must show: one plugin host, each stop run once, the node closed after the slow stop ended and
// before the process did, the store closed at exit, and an exit 0 that the relay made itself.
function checkStop (run, plugins) {
  const { code, signal, events } = run
  const names = namesOf(run)
  const trace = traceOf(run)
  assert.deepEqual(events.filter(e => e.event === 'host').map(e => e.host), [1], 'one plugin host: no replacement node was opened' + trace)
  for (const plugin of plugins) {
    assert.equal(names.filter(n => n === `stop-started:${plugin}`).length, 1, `the ${plugin} plugin's stop ran once` + trace)
  }
  const stopped = names.indexOf('stop-finished:slow')
  const entered = names.indexOf('node-close-entered')
  const finished = names.indexOf('node-close-finished')
  const exit = names.indexOf('exit')
  assert.ok(stopped !== -1, 'the slow stop finished' + trace)
  assert.ok(entered > stopped, 'node.close() was called, and only after the slow stop had finished' + trace)
  assert.ok(finished > entered, 'node.close() finished' + trace)
  assert.ok(exit > finished, 'the process exited after node.close() had finished' + trace)
  assert.equal(events[exit].storeClosed, true, 'the node\'s store was closed at exit' + trace)
  assert.equal(names.filter(n => n === 'node-close-entered').length, 1, 'node.close() was called once' + trace)
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, 'the relay exited 0 by itself' + trace)
}

// The files in the host's import ledger: the host saves a row for every file that the folder import finished. A relay
// that imported nothing has no ledger. A ledger that cannot be read fails the case.
function importedFiles (storage) {
  let ledger
  try {
    ledger = readFileSync(join(storage, 'mirror-watch.json'), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return Object.keys(JSON.parse(ledger))
}

// What a relay shows when the signal came before its plugin host could start work: no plugin run (no startup backfill,
// none from a settings change), no file put or finished by the folder import, no `relay ready`, and no warning about
// a guard that it never tried to start.
function checkNothingStarted (run) {
  const trace = traceOf(run)
  assert.deepEqual(run.events.filter(e => e.event === 'run').map(e => e.plugin), [], 'no plugin run started' + trace)
  assert.equal(run.events.filter(e => e.event === 'put').length, 0, 'the folder import put no file' + trace)
  assert.deepEqual(importedFiles(run.storage), [], 'the folder import finished no file' + trace)
  assert.equal(run.ready, false, 'a relay that is shutting down does not announce itself ready' + trace)
  assert.deepEqual(run.errors.filter(l => l.includes('private guard failed to start')), [], 'no warning about a guard that was never started' + trace)
}

// A watch folder with `count` small files for the relay's startup import.
function watchFolder (t, count) {
  const dir = tmp()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `Clip.${i}.mp4`), randomBytes(64 * 1024))
  return dir
}

const putSettings = (relay, body) => fetch(relay.base + '/v1/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// Sends a settings change and does not wait for the reply: the case goes on while the change is still applying.
function change (relay, body) {
  const sent = { answered: false }
  putSettings(relay, body).then(() => { sent.answered = true }, () => {})
  return sent
}

// Resolves once the relay has saved `key` as `value`. The relay saves a change and puts it in line to apply in one
// synchronous step, so from then on the change is applying or waiting its turn.
async function saved (relay, key, value) {
  const end = Date.now() + 60_000
  for (;;) {
    let settings = {}
    try { settings = JSON.parse(readFileSync(join(relay.storage, 'settings.json'), 'utf8')) } catch {}
    if (settings[key] === value) return
    if (Date.now() > end) throw new Error(`Timed out: the relay saved ${key}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

// POST /v1/restart, then the shutdown signal as soon as the restart is inside the slow plugin's stop.
async function signalDuringRestart (t, stopMs) {
  const relay = await startRelay(t, { '10-slow.mjs': slowPlugin(stopMs), '20-fail.mjs': failPlugin })
  await relay.seen('relay ready', l => l.msg === 'relay ready')
  // No reply is expected: shutdown closes the API while the restart runs.
  fetch(relay.base + '/v1/restart', { method: 'POST', headers: { 'content-type': 'application/json' } }).catch(() => {})
  await relay.seen('the restart reached the slow stop', probeEvent('stop-started', 'slow'))
  relay.signal()
  return relay.ended
}

test('a shutdown signal during a restart waits for the restart\'s stop to close the node', { timeout: 120_000 }, async t => {
  const result = results.overlap = { pass: false }
  // The slow stop ends 150 ms after shutdown has stopped waiting for the restart and asked for a stop of its own.
  const run = await signalDuringRestart(t, 2150)
  Object.assign(result, { code: run.code, signal: run.signal, events: run.events })
  checkStop(run, ['slow', 'fail'])
  const stopped = run.events.find(e => e.event === 'stop-finished')
  assert.ok(stopped.msAfterSignal >= 2000, `the stop outlasted the 2 s wait (${stopped.msAfterSignal} ms)`)
  result.pass = true
})

test('a restart opens no replacement node once shutdown has begun', { timeout: 120_000 }, async t => {
  const result = results.noReplacement = { pass: false }
  // The slow stop ends well inside the 2 s that shutdown gives the restart: the restart goes on by itself.
  const run = await signalDuringRestart(t, 300)
  Object.assign(result, { code: run.code, signal: run.signal, events: run.events })
  checkStop(run, ['slow', 'fail'])
  result.pass = true
})

test('the markers appear on a relay that keeps running', { timeout: 120_000 }, async t => {
  const result = results.markers = { pass: false }
  const relay = await startRelay(t, { '10-slow.mjs': slowPlugin(300), '20-fail.mjs': failPlugin, ...markers }, { PEARTUBE_WATCH_DIR: watchFolder(t, 2) })
  await relay.seen('relay ready', l => l.msg === 'relay ready')
  const res = await putSettings(relay, { cacheMaxGb: 1, rechunk: true, globalSearch: true })
  assert.equal(res.status, 200, 'the live change was applied')
  relay.signal()
  const run = await relay.ended
  const imported = importedFiles(run.storage)
  Object.assign(result, { code: run.code, signal: run.signal, events: run.events, imported: imported.length })
  checkStop(run, ['slow', 'fail'])
  const trace = traceOf(run)
  assert.deepEqual(run.events.filter(e => e.event === 'run').map(e => e.plugin), ['channel-backfill', 'blob-rechunk', 'media-check'], 'the start ran the backfill, and the change started its two runs' + trace)
  assert.equal(run.events.filter(e => e.event === 'put').length, 2, 'the folder import put both files' + trace)
  assert.equal(imported.length, 2, 'the folder import finished both files' + trace)
  assert.equal(run.events.filter(e => e.event === 'change-began').length, 1, 'the change began' + trace)
  result.pass = true
})

test('a shutdown signal during plugin loading stops every plugin before the node closes', { timeout: 120_000 }, async t => {
  const result = results.loading = { pass: false }
  const relay = await startRelay(t, { '10-slow.mjs': slowPlugin(300), '20-fail.mjs': failPlugin, '30-hold.mjs': holdPlugin(afterSignal), ...markers }, { PEARTUBE_WATCH_DIR: watchFolder(t, 8) })
  await relay.seen('a plugin factory is held open', probeEvent('factory-held'))
  relay.signal()
  const run = await relay.ended
  Object.assign(result, { code: run.code, signal: run.signal, events: run.events, ready: run.ready })
  checkStop(run, ['slow', 'fail', 'hold'])
  checkNothingStarted(run)
  result.pass = true
})

// A live settings change that waits for the plugins to load, then the signal. `behind` is a second change, sent while
// the first one waits.
for (const [name, first, behind] of [
  ['rechunk', { cacheMaxGb: 1, rechunk: true }, { cacheMaxGb: 2 }],
  ['globalSearch', { cacheMaxGb: 1, globalSearch: true }, null]
]) {
  test(`a shutdown signal while a live ${name} change waits for the plugins starts no work`, { timeout: 120_000 }, async t => {
    const result = results[`change:${name}`] = { pass: false }
    const relay = await startRelay(t, { '10-slow.mjs': slowPlugin(300), '20-fail.mjs': failPlugin, '30-hold.mjs': holdPlugin(afterSignal), ...markers }, { PEARTUBE_WATCH_DIR: watchFolder(t, 2) })
    await relay.seen('a plugin factory is held open', probeEvent('factory-held'))
    const sent = change(relay, first)
    await relay.seen('the change began', probeEvent('change-began'))
    if (behind) {
      change(relay, behind)
      await saved(relay, 'cacheMaxGb', behind.cacheMaxGb)
    }
    assert.equal(sent.answered, false, 'the change waits for the plugins to load')
    relay.signal()
    const run = await relay.ended
    Object.assign(result, { code: run.code, signal: run.signal, events: run.events, ready: run.ready })
    checkStop(run, ['slow', 'fail', 'hold'])
    checkNothingStarted(run)
    assert.equal(run.events.filter(e => e.event === 'change-began').length, 1, 'only the first change began' + traceOf(run))
    result.pass = true
  })
}

test('a reopen asked for during plugin loading, then a shutdown signal, reports no guard failure', { timeout: 120_000 }, async t => {
  const result = results.reopenWhileLoading = { pass: false }
  const relay = await startRelay(t, { '10-slow.mjs': slowPlugin(300), '20-fail.mjs': failPlugin, '30-hold.mjs': holdPlugin(whenReleased), ...markers }, { PEARTUBE_WATCH_DIR: watchFolder(t, 2) })
  await relay.seen('a plugin factory is held open', probeEvent('factory-held'))
  // Not a live setting: applying it reopens the node, and the reopen's stop waits for the plugins to load.
  change(relay, { hiverelayReplicas: 4 })
  await saved(relay, 'hiverelayReplicas', 4)
  relay.release()
  // The host is closed as soon as it can be, and the startup's guard step now waits behind the reopen.
  await relay.seen('the reopen reached the slow stop', probeEvent('stop-started', 'slow'))
  relay.signal()
  const run = await relay.ended
  Object.assign(result, { code: run.code, signal: run.signal, events: run.events, ready: run.ready })
  checkStop(run, ['slow', 'fail', 'hold'])
  checkNothingStarted(run)
  result.pass = true
})

// The last case's guard: a private-relay.js that starts but never prints a ready line. It prints its pid so the case
// can end it; it exits 17 on SIGTERM, and by itself after a minute so a stuck case cannot hold the run.
const fakeGuard = `import process from 'node:process'
// A guard that starts and never becomes ready. It exits 17 on SIGTERM, and by itself after a minute.
process.on('SIGTERM', () => process.exit(17))
setTimeout(() => process.exit(3), 60_000)
console.error(JSON.stringify({ msg: 'fake guard started', pid: process.pid }))
`

// A scratch copy of the relay's directory for the fake guard: every root entry is linked back to the repository
// except `bin`, which holds a copy of the relay and the fake guard. The relay starts the guard it finds beside itself.
function fakeGuardTree (t) {
  const tree = tmp()
  t.after(() => rmSync(tree, { recursive: true, force: true }))
  for (const name of readdirSync(root)) {
    if (name.startsWith('.') || name === 'bin') continue
    symlinkSync(join(root, name), join(tree, name))
  }
  mkdirSync(join(tree, 'bin'))
  copyFileSync(join(root, 'bin/relay.js'), join(tree, 'bin/relay.js'))
  writeFileSync(join(tree, 'bin/private-relay.js'), fakeGuard)
  return tree
}

test('a guard that started and then exits after the signal is reported', { timeout: 120_000 }, async t => {
  const result = results.guardExitedAfterSignal = { pass: false }
  const relay = await startRelay(t, { '05-signal.mjs': signalPlugin, '10-slow.mjs': slowPlugin(300), '20-fail.mjs': failPlugin }, { PEARTUBE_PRIVATE_GUARD: '1' }, join(fakeGuardTree(t), 'bin/relay.js'))
  // The fake guard never becomes ready, so this case cannot wait for `relay ready`.
  const { pid } = JSON.parse(await relay.seenError('the fake guard started', l => l.includes('fake guard started')))
  relay.signal()
  await relay.seen('the signal reached the probe', probeEvent('signal-seen'))
  // The relay has not taken the guard into `guard` yet, so its own shutdown cannot end the child. The case ends it
  // now, while the startup's guard step is still waiting for it to become ready.
  process.kill(pid, 'SIGTERM')
  const run = await relay.ended
  checkStop(run, ['slow', 'fail'])
  const reported = run.errors.filter(line => line.includes('private guard failed to start'))
  assert.equal(reported.length, 1, 'a guard that started and then exited must be reported')
  assert.match(reported[0], /privateGuard: the guard exited \(17\)/, 'the report must name the exit code')
  assert.equal(run.ready, false, 'a relay signalled before its guard was ready must not report ready')
  Object.assign(result, { code: run.code, signal: run.signal, reported: reported[0] })
  result.pass = true
})
