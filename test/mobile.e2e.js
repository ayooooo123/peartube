// End to end through the mobile app's P2P stack: a relay on a local testnet
// publishes a file; the app's Bare worklet, driven from Rust by
// mobile/examples/smoke.rs exactly as the UI drives it, joins the tracker,
// finds the entry and streams it back. Once connected, the relay publishes a
// second entry under the same id and then removes it; the app must see both
// changes through update events alone, as the UI does. Needs cargo and
// `sh mobile/setup.sh`. Leaves its evidence in mobile/target/e2e/result.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const tmp = name => mkdtempSync(join(tmpdir(), `peartube-${name}-`))

test('the mobile worklet streams a relay entry and follows the tracker live', async t => {
  const testnet = await createTestnet(3)
  const relay = await createNode({ storage: tmp('relay'), bootstrap: testnet.bootstrap })
  t.after(async () => { await relay.close(); await testnet.destroy() })
  const bytes = randomBytes(3 * 1024 * 1024 + 7)
  // Any peer can announce a title that is not well-formed UTF-16 (here a lone
  // surrogate); the app must still list the tracker. It goes first, so it has
  // synced by the time the app sees the real entry.
  const hostile = await relay.put({ id: 'imdb:tt0000666' }, Readable.from([randomBytes(10)]))
  await relay.append({ ...hostile, title: 'Hostile \ud83d' })
  const published = await relay.publish({ id: 'imdb:tt0111161', title: 'Mobile E2E' }, Readable.from([bytes]))

  const storage = tmp('app')
  const bootstrap = testnet.bootstrap.map(node => `${node.host}:${node.port}`)
  writeFileSync(join(storage, 'settings.json'), JSON.stringify({ tracker: relay.status().tracker, bootstrap }))
  const cargo = ['run', '--quiet', '--manifest-path', 'mobile/Cargo.toml', '--no-default-features', '--features', 'desktop', '--example', 'smoke', '--', published.id]
  const smoke = spawn('cargo', cargo, { env: { ...process.env, PEARTUBE_STORAGE: storage }, stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => smoke.kill())

  const stages = {}
  let secondKey = null
  for await (const line of createInterface({ input: smoke.stdout })) {
    const stage = JSON.parse(line)
    stages[stage.stage] = stage
    if (stage.stage === 'streamed') {
      const second = await relay.publish({ id: published.id, title: 'Mobile E2E' }, Readable.from([randomBytes(1024)]))
      secondKey = `${second.id}/${relay.status().writer}/${second.blobs}:${second.blob.blockOffset}`
    } else if (stage.stage === 'second') {
      await relay.remove(secondKey)
    } else {
      break
    }
  }
  assert.equal(stages.timeout, undefined, `the app saw no update while waiting for ${stages.timeout?.waitingFor}`)

  const app = stages.streamed
  assert.equal(app.tracker, relay.status().tracker)
  assert.notEqual(app.writer, relay.status().writer, 'the app is a peer of its own')
  assert.equal(app.entry.sha256, published.sha256)
  assert.equal(app.entry.local, false, 'the bytes come from the relay')
  assert.equal(app.rangeStatus, 206)
  assert.equal(app.rangeSha256, sha256(bytes.subarray(1000000, 1065536)))
  assert.equal(app.fullBytes, bytes.length)
  assert.equal(app.fullSha256, sha256(bytes))
  assert.deepEqual(app.titles.toSorted(), ['Hostile \ufffd', 'Mobile E2E'], 'the whole tracker lists, the bad title repaired')
  assert.deepEqual(stages.second.keys.toSorted(), [app.entry.key, secondKey].toSorted(), 'a later entry with the same id is listed next to the first')
  assert.deepEqual(stages.removed.keys, [app.entry.key], 'a removed entry leaves the list')

  const dir = join('mobile', 'target', 'e2e')
  mkdirSync(dir, { recursive: true })
  const result = { test: 'mobile worklet streams a relay entry and follows the tracker live', at: new Date().toISOString(), published: { id: published.id, size: published.size, sha256: published.sha256 }, relay: relay.status(), stages }
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n')
})
