// End to end through the mobile app's P2P stack: a relay publishes a file; the
// app's Bare worklet, driven from Rust by mobile/examples/smoke.rs exactly as
// the UI drives it, joins the tracker, finds the entry and streams it back.
// Once connected, the relay publishes a second entry under the same id and then
// removes it; the app must see both changes through update events alone, as
// the UI does. The first test meets over a local testnet DHT, the second over
// LAN discovery alone. Needs cargo and `sh mobile/setup.sh`. Leaves its
// evidence in mobile/target/e2e/.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createLan, lanAddress } from '../src/lan.js'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const tmp = name => mkdtempSync(join(tmpdir(), `peartube-${name}-`))

test('the mobile worklet streams a relay entry and follows the tracker live', async t => {
  const testnet = await createTestnet(3)
  const relay = await createNode({ storage: tmp('relay'), bootstrap: testnet.bootstrap })
  t.after(async () => { await relay.close(); await testnet.destroy() })
  // Any peer can announce a title that is not well-formed UTF-16 (here a lone
  // surrogate); the app must still list the tracker. It goes first, so it has
  // synced by the time the app sees the real entry.
  const hostile = await relay.put({ id: 'imdb:tt0000666' }, Readable.from([randomBytes(10)]))
  await relay.append({ ...hostile, title: 'Hostile \ud83d' })
  const bytes = randomBytes(3 * 1024 * 1024 + 7)
  const published = await relay.publish({ id: 'imdb:tt0111161', title: 'Mobile E2E' }, Readable.from([bytes]))

  const bootstrap = testnet.bootstrap.map(node => `${node.host}:${node.port}`)
  const { stages, secondKey } = await drive(t, relay, published, { bootstrap })
  verify(stages, relay, published, bytes, secondKey)
  assert.deepEqual(stages.streamed.titles.toSorted(), ['Hostile \ufffd', 'Mobile E2E'], 'the whole tracker lists, the bad title repaired')
  save('result.json', { test: 'mobile worklet streams a relay entry and follows the tracker live', published, relay, stages })
})

// Where the public DHT cannot connect two peers (two randomized NATs, as on a
// phone's home Wi-Fi), the app finds relays on the network over mDNS. Here no
// DHT is reachable at all: both sides bootstrap to a dead address, so every
// byte must come over LAN discovery. The worklet picks this machine's Wi-Fi or
// Ethernet address itself; the relay listens on the same address, as
// PEARTUBE_LAN_HOST would make it. The LAN ports must be free: 49799 for the
// relay, 49798 for the app, so quit the desktop app and any local relay first.
test('the mobile worklet finds a relay on the LAN and streams from it', async t => {
  const host = lanAddress(networkInterfaces())
  if (!host) return t.skip('no Wi-Fi or Ethernet IPv4 on this machine')
  const dead = '127.0.0.1:9'
  const relay = await createNode({
    storage: tmp('lan-relay'),
    bootstrap: [{ host: '127.0.0.1', port: 9 }],
    lan: keyPair => createLan({ host, keyPair })
  })
  t.after(() => relay.close())
  const bytes = randomBytes(3 * 1024 * 1024 + 7)
  const published = await relay.publish({ id: 'imdb:tt0068646', title: 'LAN E2E' }, Readable.from([bytes]))

  const { stages, secondKey } = await drive(t, relay, published, { bootstrap: [dead], lanDiscovery: true })
  verify(stages, relay, published, bytes, secondKey)
  assert.equal(stages.streamed.relay.peers, 0, 'no DHT connection')
  assert.ok(stages.streamed.relay.lanPeers >= 1, 'the app reached the relay over LAN discovery')
  save('lan-result.json', { test: 'mobile worklet finds a relay on the LAN and streams from it', host, published, relay, stages })
})

// Runs the app's P2P stack against relay with these settings. When the app has
// streamed the entry, the relay publishes a second one under the same id; when
// the app lists that, the relay removes it. Returns every stage the app reported.
async function drive (t, relay, published, settings) {
  const storage = tmp('app')
  writeFileSync(join(storage, 'settings.json'), JSON.stringify({ tracker: relay.status().tracker, ...settings }))
  const cargo = ['run', '--quiet', '--manifest-path', 'mobile/Cargo.toml', '--no-default-features', '--features', 'desktop', '--example', 'smoke', '--', published.id]
  const smoke = spawn('cargo', cargo, { env: { ...process.env, PEARTUBE_STORAGE: storage }, stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => smoke.kill())

  const stages = {}
  let secondKey = null
  for await (const line of createInterface({ input: smoke.stdout })) {
    const stage = JSON.parse(line)
    stages[stage.stage] = stage
    if (stage.stage === 'streamed') {
      stage.relay = relay.status()
      const second = await relay.publish({ id: published.id, title: published.title }, Readable.from([randomBytes(1024)]))
      secondKey = `${second.id}/${relay.status().writer}/${second.blobs}:${second.blob.blockOffset}`
    } else if (stage.stage === 'second') {
      await relay.remove(secondKey)
    } else {
      break
    }
  }
  assert.equal(stages.timeout, undefined, `the app saw no update while waiting for ${stages.timeout?.waitingFor}`)
  return { stages, secondKey }
}

function verify (stages, relay, published, bytes, secondKey) {
  const app = stages.streamed
  assert.equal(app.tracker, relay.status().tracker)
  assert.notEqual(app.writer, relay.status().writer, 'the app is a peer of its own')
  assert.equal(app.entry.sha256, published.sha256)
  assert.equal(app.entry.local, false, 'the bytes come from the relay')
  assert.equal(app.rangeStatus, 206)
  assert.equal(app.rangeSha256, sha256(bytes.subarray(1000000, 1065536)))
  assert.equal(app.fullBytes, bytes.length)
  assert.equal(app.fullSha256, sha256(bytes))
  assert.deepEqual(stages.second.keys.toSorted(), [app.entry.key, secondKey].toSorted(), 'a later entry with the same id is listed next to the first')
  assert.deepEqual(stages.removed.keys, [app.entry.key], 'a removed entry leaves the list')
}

function save (file, { test, host, published, relay, stages }) {
  const dir = join('mobile', 'target', 'e2e')
  mkdirSync(dir, { recursive: true })
  const result = { test, at: new Date().toISOString(), host, published: { id: published.id, size: published.size, sha256: published.sha256 }, relay: relay.status(), stages }
  writeFileSync(join(dir, file), JSON.stringify(result, null, 2) + '\n')
}
