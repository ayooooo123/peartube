// The relay closes its node after the plugin host. Observe the host's stops and its listeners on a real node.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createMirrorHost } from '../src/mirror.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('close() waits for every plugin to stop and stops the traffic gate, then reports what failed, once per host', { timeout: 120_000 }, async t => {
  const storage = mkdtempSync(join(tmpdir(), 'pt-mirror-close-'))
  const testnet = await createTestnet(3)
  const node = await createNode({ storage, bootstrap: testnet.bootstrap })
  t.after(async () => {
    await node.close()
    await testnet.destroy()
    rmSync(storage, { recursive: true, force: true })
  })
  // Every listener the host puts on the node's connections, and whether it was taken off again.
  const listeners = []
  const onConnection = node.onConnection.bind(node)
  node.onConnection = fn => {
    const entry = { off: false }
    listeners.push(entry)
    const off = onConnection(fn)
    return () => { entry.off = true; off() }
  }

  const host = () => createMirrorHost({ node, storage, acquirer: null, pollIntervalMs: 0 })
  const slowPlugin = state => ({ name: 'stops-slowly', description: '', stop: async () => { await sleep(300); state.done = true } })

  // One stop fails at once, another takes 300 ms.
  let mirror = await host()
  assert.ok(listeners.length >= 1, 'the host listens to the node\'s connections')
  const one = { done: false }
  const diskGone = new Error('disk gone')
  mirror.register({ name: 'fails-at-once', description: '', stop: async () => { throw diskGone } })
  mirror.register(slowPlugin(one))
  await assert.rejects(mirror.close(), err => err === diskGone, 'a single failure is thrown as it is')
  assert.equal(one.done, true, 'close() settled only after the slow plugin had stopped')
  assert.deepEqual(listeners.map(l => l.off), listeners.map(() => true), 'the traffic gate was stopped: no listener left on the node')

  await t.test('close preserves a synchronous error and a rejection with no object prototype', async () => {
    listeners.length = 0
    const mirror = await host()
    const notAsync = new Error('not async')
    const record = Object.assign(Object.create(null), { code: 'EIO' })
    mirror.register({ name: 'throws-in-stop', stop () { throw notAsync } })
    mirror.register({ name: 'rejects-with-record', stop: () => Promise.reject(record) })
    await assert.rejects(mirror.close(), err => {
      assert.ok(err instanceof AggregateError, 'multiple failures must reach the caller as an AggregateError')
      assert.equal(err.errors.length, 2)
      assert.ok(err.errors.includes(notAsync) && err.errors.includes(record), 'both original reasons must survive')
      return true
    })
    assert.ok(listeners.every(l => l.off))
  })

  await t.test('overlapping close calls wait for the first stop', async () => {
    listeners.length = 0
    const mirror = await host()
    const starts = { drain: 0, fail: 0 }
    let drained = false
    let fromStop
    mirror.register({ name: 'drain', async stop () {
      if (++starts.drain !== 1) return
      fromStop = mirror.close()
      await new Promise(resolve => setImmediate(resolve))
      drained = true
    } })
    mirror.register({ name: 'fail', stop () { starts.fail++; throw diskGone } })
    const restart = mirror.close()
    const startedAtReturn = { ...starts }
    const shutdown = mirror.close()
    const callers = [restart, shutdown]
    const finished = await Promise.all(callers.map(async closing => {
      await assert.rejects(closing, err => err === diskGone)
      return drained
    }))
    assert.deepEqual(finished, [true, true], 'no outside caller may leave before the first stop finishes')
    assert.deepEqual(startedAtReturn, { drain: 1, fail: 1 }, 'each stop must start once, in the first call')
    assert.equal(shutdown, restart)
    assert.notEqual(fromStop, restart, 'a stop that calls close() must not get the promise that waits for that stop')
    assert.equal(await fromStop, undefined, 'close() inside a stop reports no failure to that stop')
    await assert.rejects(mirror.close(), err => err === diskGone)
    assert.deepEqual(starts, startedAtReturn, 'a later caller must not run the stops again')
    assert.ok(listeners.every(l => l.off))
  })

  await t.test('a stop that awaits close() finishes its cleanup', async () => {
    listeners.length = 0
    const mirror = await host()
    const calls = { cleanup: 0, other: 0 }
    let cleaning = false
    let otherStopped = false
    let otherStoppedAtCleanup = null
    mirror.register({ name: 'awaits-close', async stop () {
      // The guard against a second cleanup: main ran every stop twice in this case.
      if (cleaning) return
      cleaning = true
      await mirror.close()
      otherStoppedAtCleanup = otherStopped
      calls.cleanup++
    } })
    mirror.register({ name: 'other', async stop () { calls.other++; await sleep(100); otherStopped = true } })
    const outcome = await Promise.race([mirror.close().then(() => 'closed'), sleep(2000).then(() => 'still waiting after 2 s')])
    assert.equal(outcome, 'closed', 'close() must settle when a stop awaits close()')
    assert.equal(calls.cleanup, 1, 'the cleanup after close() must run once')
    assert.equal(otherStoppedAtCleanup, true, 'close() inside a stop must wait for the other plugin')
    assert.equal(calls.other, 1, 'the other stop must run once')
    assert.ok(listeners.every(l => l.off), 'no listener may stay on the node')
  })

  await t.test('a host closed as soon as it can be closed starts no backfill and no folder import', async () => {
    listeners.length = 0
    const watchDir = mkdtempSync(join(tmpdir(), 'pt-mirror-close-watch-'))
    t.after(() => rmSync(watchDir, { recursive: true, force: true }))
    writeFileSync(join(watchDir, 'Clip.mp4'), Buffer.alloc(4096, 1))
    // The relay does this when a stop began while the plugins were still loading.
    const mirror = await createMirrorHost({ node, storage, acquirer: null, pollIntervalMs: 0, mirrorChannel: true, watchDir, onstarting: host => host.close() })
    const runs = Object.fromEntries(mirror.list().map(p => [p.name, p.runs]))
    assert.deepEqual({ backfill: runs['channel-backfill'], folder: runs['watch-dir'] }, { backfill: 0, folder: 0 }, 'a closed host must start nothing')
    // The close began inside `onstarting`: the same promise, awaited here as the relay awaits it.
    await mirror.close()
    assert.ok(listeners.length >= 1 && listeners.every(l => l.off))
  })

  // Nothing fails: close() resolves.
  listeners.length = 0
  mirror = await host()
  const three = { done: false }
  mirror.register(slowPlugin(three))
  await mirror.close()
  assert.equal(three.done, true)
  assert.deepEqual(listeners.map(l => l.off), listeners.map(() => true))
})
