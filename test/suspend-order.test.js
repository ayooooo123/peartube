// A resume that is called while a suspend is still running must wait for it. The apps' worklet starts a suspend and
// does not wait for it (worklet/worker.js), and Hyperswarm sets `suspended` at once but suspends its DHT later: a
// resume that overtook the suspend found nothing to resume, then the suspend stopped the DHT under a node that
// reported itself resumed, and that node could connect to nobody.
// Two nodes on a testnet each connect to one peer, suspend and resume: one waits for its suspend, one does not.
// Both must connect again and read a block of the peer that they never had.
// The result is written to desktop/target/e2e/suspend-order-result.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import b4a from 'b4a'
import { createNode } from '../src/index.js'

const tmp = label => mkdtempSync(join(tmpdir(), `peartube-suspend-order-${label}-`))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A node whose store stayed suspended may never finish closing, so each step of the cleanup gets `ms` and no more.
function within (promise, ms) {
  let timer
  const limit = new Promise(resolve => { timer = setTimeout(resolve, ms) })
  return Promise.race([promise.catch(() => {}), limit]).finally(() => clearTimeout(timer))
}

// The connection from `a` to `b`, once both nodes hold it open; null when that takes longer than `ms`.
async function link (a, b, ms) {
  const held = (node, key) => [...node.peerConnections()].find(c => !c.destroyed && c.remotePublicKey && b4a.toString(c.remotePublicKey, 'hex') === key)
  const end = Date.now() + ms
  for (;;) {
    const conn = held(a, b.peerKey)
    if (conn && held(b, a.peerKey)) return conn
    if (Date.now() > end) return null
    await sleep(250)
  }
}

const outcome = settled => settled.status === 'fulfilled' ? { ok: true, ...settled.value } : { ok: false, error: String(settled.reason?.message ?? settled.reason) }

test('a resume called while a suspend is still running waits for it, and the node connects and reads again', { timeout: 300_000 }, async () => {
  const testnet = await createTestnet(4)
  const nodes = []
  const open = async label => {
    const node = await createNode({ storage: tmp(label), bootstrap: testnet.bootstrap })
    nodes.push(node)
    return node
  }
  try {
    const peer = await open('peer')
    const a = await open('waited')
    const b = await open('raced')
    // One block that neither node under test has read: they read it only after their resume.
    const core = peer.store.get({ name: 'suspend-order' })
    await core.ready()
    await core.append(b4a.from('after resume'))

    async function run (node, order) {
      const start = Date.now()
      node.joinPeer(peer.peerKey)
      const before = await link(node, peer, 90_000)
      assert.ok(before, 'the test network did not connect the nodes')
      const linked = Date.now()

      if (order === 'waited') {
        await node.suspend()
        await node.resume()
      } else {
        const pending = node.suspend()
        await node.resume()
        await pending
      }
      assert.equal(before.destroyed, true, 'suspend did not close the open connection')
      const cycled = Date.now()

      node.joinPeer(peer.peerKey)
      assert.ok(await link(node, peer, 90_000), 'the node did not connect again after the resume')
      const relinked = Date.now()

      const copy = node.store.get(core.key)
      const block = await copy.get(0, { timeout: 60_000 }).catch(() => null)
      assert.equal(block && b4a.toString(block), 'after resume', 'the store did not read a new block after the resume')
      return { linkMs: linked - start, suspendResumeMs: cycled - linked, relinkMs: relinked - cycled, readMs: Date.now() - relinked }
    }

    const [waited, raced] = await Promise.allSettled([run(a, 'waited'), run(b, 'raced')])
    mkdirSync(join('desktop', 'target', 'e2e'), { recursive: true })
    writeFileSync(join('desktop', 'target', 'e2e', 'suspend-order-result.json'), JSON.stringify({ waited: outcome(waited), raced: outcome(raced) }, null, 2))
    assert.equal(waited.status, 'fulfilled', `the node that waited for its suspend failed, so the test says nothing about the order: ${waited.reason}`)
    if (raced.status === 'rejected') throw raced.reason
  } finally {
    await Promise.all(nodes.map(node => within(node.close(), 5_000)))
    await within(testnet.destroy(), 5_000)
  }
})
