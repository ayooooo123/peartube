// Persistent relay swarm identity and playback-time channel topic refresh.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import b4a from 'b4a'
import { createNode } from '../src/index.js'
import { relayKeyPair } from '../src/settings.js'

const tmp = label => mkdtempSync(join(tmpdir(), `peartube-refresh-${label}-`))
const sha256 = buf => createHash('sha256').update(buf).digest('hex')

async function until (fn, ms, label) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

test('relayKeyPair persists the same Ed25519 identity across restarts with 0600 permissions', () => {
  const dir = tmp('keypair')
  const first = relayKeyPair(dir)
  assert.equal(first.publicKey.byteLength, 32)
  assert.equal(first.secretKey.byteLength, 64)
  assert.equal(statSync(join(dir, 'swarm-key.json')).mode & 0o777, 0o600)

  const second = relayKeyPair(dir)
  assert.ok(b4a.equals(first.publicKey, second.publicKey), 'same publicKey across restarts')
  assert.ok(b4a.equals(first.secretKey, second.secretKey), 'same secretKey across restarts')

  // Malformed file regenerates cleanly without throwing.
  writeFileSync(join(dir, 'swarm-key.json'), '{not-json', { mode: 0o600 })
  const recovered = relayKeyPair(dir)
  assert.equal(recovered.publicKey.byteLength, 32)
  assert.ok(!b4a.equals(first.publicKey, recovered.publicKey))
})

test('focusSource refreshes an already-awake channel topic and discovers a late publisher', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const nodes = []
  t.after(async () => {
    for (const node of nodes.reverse()) await node.close()
    await testnet.destroy()
  })
  const open = async opts => {
    const node = await createNode({ bootstrap: testnet.bootstrap, ...opts })
    nodes.push(node)
    return node
  }

  // Create and close a publisher first so we know its channel key, then start the follower while it is offline.
  const pubDir = tmp('pub')
  const pubKey = relayKeyPair(pubDir)
  const initialPub = await open({ storage: pubDir, keyPair: pubKey })
  const payload = randomBytes(512 * 1024 + 17)
  await initialPub.publish({ id: 'imdb:tt0000401', title: 'Late Publisher' }, Readable.from([payload]))
  const channelKey = initialPub.status().tracker
  await initialPub.close()
  nodes.pop()

  const follower = await open({ storage: tmp('follower'), sources: [{ key: channelKey, kind: 'channel' }] })
  await follower.swarm.flush()
  assert.equal(follower.status().peers, 0, 'follower starts with no peers while publisher is offline')

  // Publisher comes back online AFTER the follower's initial lookup finished.
  const restartedPub = await open({ storage: pubDir, keyPair: relayKeyPair(pubDir), tracker: channelKey })
  assert.equal(restartedPub.peerKey, initialPub.peerKey, 'restarted relay kept its swarm peerKey')
  await restartedPub.swarm.flush()

  // focusSource on an already-awake channel must refresh its DHT topic instead of waiting 10 minutes.
  const ok = await follower.focusSource(channelKey)
  assert.equal(ok, true)

  const entry = await until(async () => (await follower.search('imdb:tt0000401'))[0], 20_000, 'late publisher catalog synced after focusSource')
  const body = Buffer.from(await (await fetch(entry.streamUrl)).arrayBuffer())
  assert.equal(sha256(body), sha256(payload))
})
