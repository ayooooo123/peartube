// Isolated, short-lived private tracker and video seeder for a cellular phone test.
// Run an anchor first, then run a seeder with its printed tracker key. Neither
// process opens the production Corestore or accepts network acquisition requests.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { createNode } from '../src/index.js'
import { createPrivateGuard } from '../src/private-overlay.js'
import HyperDHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'

const { values: opts, positionals: [role] } = parseArgs({
  allowPositionals: true,
  options: {
    tracker: { type: 'string' },
    bootstrap: { type: 'string' },
    'private-host': { type: 'string' },
    sha256: { type: 'string' },
    bytes: { type: 'string' },
    out: { type: 'string' },
    media: { type: 'string' },
    seconds: { type: 'string' },
    help: { type: 'boolean', short: 'h' }
  }
})
const usage = 'node test/private-wan.mjs testnet|probe|guard|anchor|seeder|reader [--tracker <64-hex-key>] [--bootstrap host:port,...] [--private-host auto|loopback] [--out fresh-directory] [--media mp4] [--sha256 <hex> --bytes N] [--seconds N]'
if (opts.help) { console.log(usage); process.exit(0) }
if (!['testnet', 'probe', 'guard', 'anchor', 'seeder', 'reader'].includes(role) || (['probe', 'reader'].includes(role) && !opts.tracker) ||
    (opts.tracker && !/^[0-9a-f]{64}$/i.test(opts.tracker)) || (role !== 'seeder' && opts.media) ||
    (role === 'testnet' && (opts.tracker || opts.bootstrap)) || (role === 'probe' && !opts.bootstrap)) throw new Error(usage)
if (role === 'reader' && (!/^[0-9a-f]{64}$/i.test(opts.sha256 || '') ||
    !/^[1-9]\d*$/.test(opts.bytes || '') || !Number.isSafeInteger(Number(opts.bytes)))) throw new Error(usage)
if (opts['private-host'] && !['auto', 'loopback'].includes(opts['private-host'])) throw new Error('--private-host only accepts auto or loopback for isolated network tests')
const seconds = opts.seconds == null ? 0 : Number(opts.seconds)
if (!Number.isInteger(seconds) || seconds < 0) throw new Error('--seconds must be a nonnegative integer; 0 waits for Ctrl-C')
const out = resolve(opts.out || join('android', 'build', 'private-wan', `${role}-${Date.now()}`))
if (existsSync(join(out, 'storage'))) throw new Error(`Refusing to reuse an existing tracker/reader storage: ${out}`)
mkdirSync(out, { recursive: true })
const bootstrap = opts.bootstrap?.split(',').map(address => {
  const [host, value] = address.split(':')
  const port = Number(value)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid bootstrap: ${address}`)
  return { host, port }
})

function fixture () {
  if (opts.media) {
    if (!existsSync(opts.media)) throw new Error(`No media at ${opts.media}`)
    return resolve(opts.media)
  }
  const file = join(out, 'fixture.mp4')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', file
  ], { stdio: 'inherit' })
  return file
}

async function main () {
  if (role === 'testnet') {
    const host = opts['private-host'] === 'loopback' ? '127.0.0.1' : Object.values(networkInterfaces()).flat().find(addr => (addr.family === 'IPv4' || addr.family === 4) && !addr.internal)?.address
    if (!host) throw new Error('Testnet needs a private IPv4 address reachable by the other test containers')
    const testnet = await createTestnet(3, { host })
    let stopping = false
    const quit = () => { stopping = true }
    process.once('SIGINT', quit)
    process.once('SIGTERM', quit)
    const info = { role, bootstrap: testnet.bootstrap, at: new Date().toISOString() }
    writeFileSync(join(out, 'result.json'), JSON.stringify(info, null, 2) + '\n')
    console.log(JSON.stringify(info))
    try {
      const until = seconds ? Date.now() + seconds * 1000 : Infinity
      while (!stopping && Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(5000, until - Date.now())))
    } finally { await testnet.destroy() }
    return
  }
  if (role === 'probe') {
    const observer = new HyperDHT({ bootstrap, port: 0 })
    try {
      const keys = async topic => {
        const peers = new Map()
        for await (const reply of observer.lookup(topic)) {
          for (const peer of reply.peers) {
            const key = Buffer.from(peer.publicKey).toString('hex')
            peers.set(key, { key, relayAddresses: peer.relayAddresses })
          }
        }
        return [...peers.values()]
      }
      const directoryMap = new Map()
      for (let s = 0; s < 4; s++) {
        for (const p of await keys(HyperDHT.hash(Buffer.from(`peartube/private-guard/v1/${s}`)))) directoryMap.set(p.key, p)
      }
      const directory = [...directoryMap.values()]
      const epoch = String(Math.floor(Date.now() / 3_600_000))
      const topic = createHash('sha256').update('peartube/private-rv/v1/').update(Buffer.from(opts.tracker, 'hex')).update(epoch).digest()
      const announced = await keys(topic)
      const info = { role, at: new Date().toISOString(), tracker: opts.tracker, directoryCount: directory.length,
        trackerTopicPeerCount: announced.length, directory, announced }
      writeFileSync(join(out, 'result.json'), JSON.stringify(info, null, 2) + '\n')
      console.log(JSON.stringify(info))
    } finally { await observer.destroy({ force: true }) }
    return
  }
  const media = role === 'seeder' ? fixture() : null
  const privateHost = opts['private-host'] === 'loopback' ? '127.0.0.1' : opts['private-host'] === 'auto'
    ? Object.values(networkInterfaces()).flat().find(addr => (addr.family === 'IPv4' || addr.family === 4) && !addr.internal)?.address
    : undefined
  if (opts['private-host'] && !privateHost) throw new Error('No isolated IPv4 address to bind the private test node')
  if (role === 'guard' || role === 'anchor') {
    const guard = await createPrivateGuard({ host: privateHost, bootstrap })
    let stopping = false
    const quit = () => { stopping = true }
    process.once('SIGINT', quit)
    process.once('SIGTERM', quit)
    const writeGuard = () => {
      const proof = { at: new Date().toISOString(), phase: 'serving', role, publicKey: Buffer.from(guard.publicKey).toString('hex'), address: guard.address(), stats: guard.stats() }
      writeFileSync(join(out, 'result.json'), JSON.stringify(proof, null, 2) + '\n')
    }
    writeGuard()
    const pulse = setInterval(writeGuard, 5000)
    try {
      const until = seconds ? Date.now() + seconds * 1000 : Infinity
      while (!stopping && Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(5000, until - Date.now())))
    } finally { clearInterval(pulse); await guard.close() }
    return
  }
  const node = await createNode({
    storage: join(out, 'storage'),
    tracker: opts.tracker,
    bootstrap,
    privateHost,
    privateRouting: true
  })
  let stopping = false
  const quit = () => { stopping = true }
  process.once('SIGINT', quit)
  process.once('SIGTERM', quit)
  const started = new Date().toISOString()
  let listening = 'pending'
  node.swarm.listening?.then(() => { listening = 'ready' }, err => { listening = err.code || err.message })
  const epoch = () => String(Math.floor(Date.now() / 3_600_000))
  let phase = role === 'reader' ? 'discovering' : media ? 'publishing' : 'serving'
  let published = null
  let received = null
  let progress = null
  let error = null
  const record = () => {
    const status = node.status()
    const exposure = node.swarm.dht.privateRouting.exposureReport()
    const topic = createHash('sha256').update('peartube/private-rv/v1/').update(Buffer.from(status.tracker, 'hex')).update(epoch()).digest()
    const discovery = node.swarm.status(topic)
    const proof = { at: new Date().toISOString(), started, phase, error, role, tracker: status.tracker, published, received, progress,
      status, routingState: node.swarm.dht.privateRouting.status(), discovery: { listening, server: !!discovery?.isServer, client: !!discovery?.isClient },
      exposure, directTrackerAnnouncement: node.swarm.status(node.channel.discoveryKey) !== null }
    writeFileSync(join(out, 'result.json'), JSON.stringify(proof, null, 2) + '\n')
    if (exposure.directDestinationSends !== 0 || proof.directTrackerAnnouncement) throw new Error('Private-only endpoint leaked a direct destination or tracker announcement')
  }
  record()
  const pulse = setInterval(record, 5000)
  try {
    if (media) {
      const id = 'imdb:tt0000999'
      console.log(`Joining isolated tracker ${node.status().tracker}; publishing uncached playback fixture...`)
      let publishTimeout
      try {
        published = await Promise.race([
          node.publish({ id, title: 'PearTube private WAN fixture' }, createReadStream(media)),
          new Promise((_, reject) => { publishTimeout = setTimeout(reject, 120_000, new Error('Seeder could not sync with the isolated anchor within 120 seconds')) })
        ])
      } finally { clearTimeout(publishTimeout) }
      published = { id, size: statSync(media).size, sha256: published.sha256 }
      phase = 'serving'
      record()
    }
    if (role === 'reader') {
      let entry
      const deadline = Date.now() + 120_000
      while (!entry && Date.now() < deadline) {
        entry = (await node.search('imdb:tt0000999')).find(item => item.sha256 === opts.sha256)
        if (!entry) await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (!entry) throw new Error('The isolated fixture did not appear in the tracker within 120 seconds')
      phase = 'reading'
      record()
      const requestAt = performance.now()
      const requestedAt = new Date().toISOString()
      progress = { requestedAt, bytes: 0, lastByteAt: null }
      const response = await fetch(entry.streamUrl, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok || !response.body) throw new Error(`Fixture stream returned HTTP ${response.status}`)
      const body = response.body.getReader()
      const digest = createHash('sha256')
      let bytes = 0, ttfbMs = 0, nextMiB = 1024 * 1024
      const milestones = []
      for (;;) {
        const { done, value } = await body.read()
        if (done) break
        if (!bytes) ttfbMs = performance.now() - requestAt
        bytes += value.byteLength
        digest.update(value)
        progress.bytes = bytes
        progress.lastByteAt = Date.now()
        if (bytes >= nextMiB) {
          const elapsedMs = Math.round(performance.now() - requestAt)
          do { milestones.push({ bytes: nextMiB, elapsedMs }); nextMiB += 1024 * 1024 } while (bytes >= nextMiB)
        }
      }
      received = { bytes, sha256: digest.digest('hex'), requestedAt, completedAt: new Date().toISOString(),
        ttfbMs: Math.round(ttfbMs), transferMs: Math.round(performance.now() - requestAt), milestones }
      progress = null
      phase = 'verified'
      record()
      const routes = node.status().routes
      if (bytes !== Number(opts.bytes) || received.sha256 !== opts.sha256.toLowerCase() || routes.private.rxBytes < bytes ||
          routes.public.rxBytes !== 0 || routes.lan.rxBytes !== 0) throw new Error('Fixture bytes, hash, or private-only path did not match the seeder evidence')
    }
    console.log(JSON.stringify({ role, out, tracker: node.status().tracker, published, received }, null, 2))
    const until = seconds ? Date.now() + seconds * 1000 : role === 'reader' ? Date.now() : Infinity
    while (!stopping && Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(5000, until - Date.now())))
  } catch (err) {
    phase = 'failed'
    error = err.message
    record()
    throw err
  } finally {
    clearInterval(pulse)
    await node.close()
    console.log(`Stopped ${role}; evidence: ${join(out, 'result.json')}`)
  }
}
main().catch(err => { console.error(err); process.exitCode = 1 })
