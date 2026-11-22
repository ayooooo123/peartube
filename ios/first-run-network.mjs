// Run the engine proof with a small film, or keep its relay open for the simulator (see README.md).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { isIPv4 } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import createTestnet from 'hyperdht/testnet.js'
import { nodeOptions, normalizeAppSettings } from '../src/app-settings.js'
import { createNode, followedSources } from '../src/index.js'
import { createMirrorHost } from '../src/mirror.js'

const [file, mode, host, ...rest] = process.argv.slice(2)
if (!file || (mode && (mode !== '--serve' || !isIPv4(host ?? ''))) || rest.length) {
  throw new Error('Usage: node ios/first-run-network.mjs <film> [--serve <IPv4>]')
}
const bytes = readFileSync(file)
const hash = data => createHash('sha256').update(data).digest('hex')
const title = 'First light on the water'
const dir = mkdtempSync(join(tmpdir(), 'peartube-first-run-'))
const close = []

async function until (read, timeout, what) {
  const deadline = Date.now() + timeout
  do {
    const value = await read()
    if (value) return value
    await delay(500)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${what}`)
}

try {
  const network = await createTestnet(3, { host: host ?? '127.0.0.1' })
  close.push(() => network.destroy())
  const bootstrap = network.bootstrap.map(n => `${n.host}:${n.port}`)
  const storage = join(dir, 'relay')
  const relay = await createNode({ storage, bootstrap })
  close.push(() => relay.close())
  const film = await relay.publish({ id: 'clip:firstlight', title }, Readable.from([bytes]))
  const mirror = await createMirrorHost({ node: relay, storage, acquirer: null, mirrorChannel: false, mediaCheck: true, pollIntervalMs: 0 })
  close.push(() => mirror.close())
  await until(async () => {
    await mirror.run('media-check')
    return mirror.isMedia(`${film.blobs}:${film.blob.blockOffset}`)
  }, 30_000, 'the relay to verify the film')
  relay.serveSearch({ isMedia: mirror.isMedia })
  await relay.swarm.flush()

  if (mode === '--serve') {
    const stopped = new Promise(resolve => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
      process.stdin.once('end', resolve).resume()
    })
    // Only the test runner sees this file. Only bootstrap goes to the app.
    console.log(JSON.stringify({ bootstrap: bootstrap.join(','), firstRunTitle: title }))
    await stopped
  } else {
    const settings = normalizeAppSettings({ bootstrap })
    const opts = nodeOptions(settings, { trackersDir: join(dir, 'trackers'), defaultFolder: 'default' })
    assert.deepEqual([opts.tracker, opts.mnemonic, opts.join, opts.sources], [null, null, false, []])
    // Like worklet.start: LAN is attached after createNode, not passed as a boolean factory.
    const { lan, cacheMaxGb, ...options } = opts
    const app = await createNode({ ...options, worklet: true })
    close.push(() => app.close())
    app.setCacheMaxBytes(cacheMaxGb * 1e9)
    assert.deepEqual(await app.search(), [], 'the fresh library has no film')
    const row = await until(async () => (await app.searchGlobal({ query: title })).find(r => r.id === film.id && r.title === title), 120_000, 'the global result')
    assert.equal(row.relays, 1)
    assert.equal(new URL(row.magnetUrl).searchParams.has('source'), false)
    const { peers, writer } = app.status()
    assert.match(writer, /^[a-f0-9]{64}$/)
    assert.ok(peers > 0)
    const { entry } = await app.openUri(row.magnetUrl)
    const response = await fetch(entry.streamUrl, { signal: AbortSignal.timeout(30_000) })
    assert.equal(response.status, 200)
    const received = Buffer.from(await response.arrayBuffer())
    const sha256 = hash(received)
    assert.equal(received.length, bytes.length)
    assert.equal(sha256, hash(bytes))
    assert.deepEqual(followedSources(app.listSources()), [])
    console.log(JSON.stringify({ title: row.title, peers, relays: row.relays, bytes: received.length, sha256 }))
  }
} finally {
  try { for (const dispose of close.reverse()) await dispose() } finally { rmSync(dir, { recursive: true, force: true }) }
}
