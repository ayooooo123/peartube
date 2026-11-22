// A relay whose node fails to close says so: it opens no other node on the same storage, and it does not exit 0.
// The node's close() ends at its first part that rejects, so a channel that fails to close leaves the store open.
// Each case runs bin/relay.js under Bare with its API on loopback and a testnet for its DHT. A probe plugin in its
// plugins folder makes the channel's close() reject, and prints each plugin host it was loaded for, each call of the
// channel's close(), its own stop, and at exit whether the node's store was closed.
//   1. A shutdown signal. The relay must print the failure and exit 1 (it used to exit 0 with the store open).
//   2. POST /v1/restart, twice. Each reply must name the failure, no second node may be opened, and the API must stay
//      up. A shutdown signal after that must still end in exit 1: the node that failed to close is still open.
//   3. A settings change that reopens the node. Its reply must carry the failure as its warning.
//   4. A shutdown signal while a restart is stopping its plugins, before that restart closes the node. The exit must
//      be 1, although the stop that shutdown itself asks for finds no node to close.
// Every case also fails when the relay ends by its own 3 s limit instead of exiting by itself.
// The relay also looks for cast receivers by mDNS on the machine's LAN address, as every relay does; no case uses it.
// Writes desktop/target/e2e/relay-close-failure-result.json.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import createTestnet from 'hyperdht/testnet.js'

const root = new URL('..', import.meta.url).pathname
const artifact = join(root, 'desktop/target/e2e/relay-close-failure-result.json')
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

const reason = 'probe: the channel did not close'
// The probe uses only globals: Bare resolves no package from a plugins folder outside the repository. Its module
// state lasts as long as the process, so a second node's plugin host calls the same factory again.
// It leaves the node's own close() in place and fails the channel's, which close() awaits just before the store's.
// Its stop ends at once, or `holdMs` after the shutdown signal when `holdMs` is given: that holds a restart in its
// plugin stops until the signal has arrived, however long the signal takes to come.
const closeFailurePlugin = holdMs => `
const emit = (event, more = {}) => console.log(JSON.stringify({ msg: 'probe', event, at: Date.now(), ...more }))
const signalled = new Promise(resolve => process.once('SIGTERM', resolve))
let hosts = 0
export default function ({ node }) {
  const host = ++hosts
  emit('host', { host })
  node.channel.close = async () => {
    emit('channel-close', { host })
    throw new Error('${reason}')
  }
  process.on('exit', () => emit('exit', { host, storeClosed: node.store.closed }))
  return {
    name: 'probe-close-failure',
    async stop () {
      emit('stop-started', { host })
      ${holdMs === null ? '' : `await signalled\n      await new Promise(resolve => setTimeout(resolve, ${holdMs}))`}
      emit('stop-finished', { host })
    }
  }
}
`

// A relay process (bin/relay.js under Bare) on its own testnet, with the probe in its plugins folder.
async function startRelay (t, holdMs = null) {
  const testnet = await createTestnet(3)
  const storage = mkdtempSync(join(tmpdir(), 'peartube-relay-close-failure-'))
  mkdirSync(join(storage, 'plugins'))
  writeFileSync(join(storage, 'plugins', 'probe.mjs'), closeFailurePlugin(holdMs))
  const apiPort = await freePort()
  const proc = spawn(join(root, 'node_modules/.bin/bare'), [join(root, 'bin/relay.js')], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: storage,
      PEARTUBE_STORAGE: storage,
      PEARTUBE_API_PORT: String(apiPort),
      PEARTUBE_API_HOST: '127.0.0.1',
      PEARTUBE_BOOTSTRAP: testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(',')
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
  const err = createInterface({ input: proc.stderr }).on('line', line => errors.push(line))
  // Resolves once the process has gone and all of its output is read.
  const ended = Promise.all([once(proc, 'close'), once(out, 'close'), once(err, 'close')]).then(([[code, signal]]) => {
    const events = lines.filter(l => l.msg === 'probe').map(({ msg, at, ...e }) => ({ ...e, msAfterSignal: signalAt === null ? null : at - signalAt }))
    return { code, signal, events, errors }
  })
  let gone = false
  ended.then(() => { gone = true; wake() })
  t.after(async () => {
    if (!gone) proc.kill('SIGKILL')
    await ended
    await testnet.destroy()
    rmSync(storage, { recursive: true, force: true })
  })
  const relay = {
    base: 'http://127.0.0.1:' + apiPort,
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
    // The probe events so far, by name.
    names: () => lines.filter(l => l.msg === 'probe').map(l => l.event),
    signal () {
      signalAt = Date.now()
      proc.kill('SIGTERM')
    }
  }
  await relay.seen('relay ready', l => l.msg === 'relay ready')
  return relay
}

const namesOf = run => run.events.map(e => e.event)
const traceOf = run => `\n${namesOf(run).join(', ') || '(no probe events)'}\n${run.errors.slice(-5).join('\n')}`
const json = { 'content-type': 'application/json' }

// What every case must show once the relay has ended: one node only, whose channel was asked to close once and whose
// store was still open at exit, the failure on stderr, and an exit 1 that the relay made itself.
function checkUncleanExit (run) {
  const { code, signal, events, errors } = run
  const trace = traceOf(run)
  assert.deepEqual(events.filter(e => e.event === 'host').map(e => e.host), [1], 'one plugin host: no second node was opened' + trace)
  assert.equal(events.filter(e => e.event === 'channel-close').length, 1, 'the node was closed once, and its close() reached the channel' + trace)
  const exit = events.find(e => e.event === 'exit')
  assert.ok(exit, 'the relay exited by itself' + trace)
  assert.equal(exit.storeClosed, false, 'the store was still open at exit, which is why an exit 0 would be wrong' + trace)
  assert.equal(errors.filter(l => l.includes('relay did not stop cleanly') && l.includes(reason)).length, 1, 'the relay printed the failure once' + trace)
  assert.deepEqual({ code, signal }, { code: 1, signal: null }, 'the relay exited 1 by itself' + trace)
}

test('a node that fails to close at shutdown is not a clean exit', { timeout: 120_000 }, async t => {
  const result = results.shutdown = { pass: false }
  const relay = await startRelay(t)
  relay.signal()
  const run = await relay.ended
  Object.assign(result, run)
  checkUncleanExit(run)
  result.pass = true
})

test('a restart whose node fails to close reports it, opens no other node, and the exit is not clean', { timeout: 120_000 }, async t => {
  const result = results.restart = { pass: false, replies: [] }
  const relay = await startRelay(t)
  for (const attempt of ['first', 'second']) {
    const res = await fetch(relay.base + '/v1/restart', { method: 'POST', headers: json })
    const reply = { status: res.status, body: await res.json() }
    result.replies.push(reply)
    assert.equal(reply.status, 500, `the ${attempt} restart failed: ${JSON.stringify(reply)}`)
    assert.ok(String(reply.body.error).includes(reason), `the ${attempt} restart's reply names the failure: ${JSON.stringify(reply)}`)
    assert.deepEqual(relay.names().filter(n => n === 'host'), ['host'], `no second node after the ${attempt} restart`)
  }
  const status = await fetch(relay.base + '/v1/status')
  assert.equal(status.status, 200, 'the API stays up without a node')
  relay.signal()
  const run = await relay.ended
  Object.assign(result, run)
  checkUncleanExit(run)
  result.pass = true
})

test('a settings change that reopens a node that fails to close carries the failure as its warning', { timeout: 120_000 }, async t => {
  const result = results.settings = { pass: false }
  const relay = await startRelay(t)
  // Not a live setting: applying it reopens the node.
  const res = await fetch(relay.base + '/v1/settings', { method: 'PUT', headers: json, body: JSON.stringify({ hiverelayReplicas: 4 }) })
  const reply = await res.json()
  result.reply = { status: res.status, changed: reply.changed, warning: reply.warning }
  assert.equal(res.status, 200, 'the change was saved')
  assert.ok(String(reply.warning).includes(reason), `the reply's warning names the failure: ${JSON.stringify(result.reply)}`)
  relay.signal()
  const run = await relay.ended
  Object.assign(result, run)
  checkUncleanExit(run)
  result.pass = true
})

test('a shutdown signal during a restart whose node then fails to close is not a clean exit', { timeout: 120_000 }, async t => {
  const result = results.signalDuringRestart = { pass: false }
  // The plugin stop ends 300 ms after the signal, well inside the 2 s that shutdown gives a restart in flight: the
  // restart closes the node, and the stop that shutdown asks for afterwards finds none.
  const relay = await startRelay(t, 300)
  // No reply is expected: shutdown closes the API while the restart runs.
  fetch(relay.base + '/v1/restart', { method: 'POST', headers: json }).catch(() => {})
  await relay.seen('the restart reached the plugin stop', l => l.msg === 'probe' && l.event === 'stop-started')
  relay.signal()
  const run = await relay.ended
  Object.assign(result, run)
  checkUncleanExit(run)
  const closed = run.events.find(e => e.event === 'channel-close')
  assert.ok(closed.msAfterSignal > 0, `the node was closed after the signal (${closed.msAfterSignal} ms)` + traceOf(run))
  result.pass = true
})
