#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import HyperDHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createPrivateGuard } from '../src/private-overlay.js'

const HELP = `Private-routing repeatable load/churn E2E (Node.js >=22)

Usage: node test/private-scale.mjs [options]
  --readers N       Independent uncached readers (default 4; minimum 1)
  --relays N        Stateless private guard relays (default 3; minimum 2)
  --bytes N         Deterministic fixture bytes (default 1048593)
  --churn-ms N      Replace a relay every N ms; 0 disables churn (default 0)
  --duration-ms N   Keep optional churn active for at least N ms (default 0)
  --timeout-ms N    Per-operation deadline (default 120000)
  --artifact PATH   Structured evidence JSON (default /tmp/peartube-private-scale.json)
  --help            Show this help

This default is a co-located smoke/load run: it starts a fresh loopback HyperDHT
testnet and fresh private tracker/storage. It is not an externally impaired or
multi-namespace result. The script never applies netem. For a separate Linux
container experiment, put reader containers behind dedicated veth interfaces
and apply (inside each reader namespace/container, with CAP_NET_ADMIN):
  tc qdisc replace dev eth0 root netem delay 80ms 15ms loss 1%
Remove it afterwards with:
  tc qdisc del dev eth0 root
This harness cannot join an external bootstrap or place nodes in separate
namespaces. Run any multi-namespace experiment with separate orchestration
against a reachable shared DHT bootstrap, and record its topology and tc
commands with that experiment's evidence. Do not label a run impaired unless
tc was actually applied; loopback cannot prove external impairment.
`

function parseArgs (argv) {
  const values = { readers: 4, relays: 3, bytes: 1024 * 1024 + 17, churnMs: 0, durationMs: 0, timeoutMs: 120000, artifact: '/tmp/peartube-private-scale.json' }
  const keys = { '--readers': 'readers', '--relays': 'relays', '--bytes': 'bytes', '--churn-ms': 'churnMs', '--duration-ms': 'durationMs', '--timeout-ms': 'timeoutMs', '--artifact': 'artifact' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help') return { help: true }
    const key = keys[arg]
    if (!key) throw new Error(`Unknown argument: ${arg}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
    if (key === 'artifact') {
      if (!value.trim()) throw new Error('--artifact must not be empty')
      values[key] = resolve(value)
      continue
    }
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${arg} must be a safe non-negative integer`)
    values[key] = Number(value)
  }
  if (values.readers < 1) throw new Error('--readers must be at least 1')
  if (values.relays < 2) throw new Error('--relays must be at least 2')
  if (values.bytes < 1) throw new Error('--bytes must be at least 1')
  if (values.timeoutMs < 1000) throw new Error('--timeout-ms must be at least 1000')
  if (values.churnMs > 0 && values.churnMs < 1000) throw new Error('--churn-ms must be 0 or at least 1000')
  return values
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function within (promise, ms, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) })])
  } finally { clearTimeout(timer) }
}
async function until (fn, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await wait(250)
  }
  throw new Error(`${label} timed out after ${ms}ms`)
}
function fixture (size) {
  const bytes = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >>> 8) * 17 + 23) & 255
  return bytes
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const errorText = err => ({ name: err?.name || 'Error', message: err?.message || String(err), stack: err?.stack || null })

async function run (options) {
  const startedAt = new Date().toISOString()
  const runDir = await mkdtemp(resolve(tmpdir(), 'peartube-private-scale-'))
  const artifact = {
    schema: 'peartube.private-scale.v1', startedAt, endedAt: null,
    mode: 'co-located-smoke', impairment: { appliedByHarness: false, claimed: false, details: 'No netem or namespace impairment applied.' },
    config: { ...options, artifact: options.artifact },
    externalScenario: { supportedByThisHarness: false, reason: 'Uses its own loopback testnet; cannot join an external bootstrap or place peers in separate namespaces.' },
    fixture: null, tracker: null, relays: [], readers: [], churn: [], assertions: {}, passed: false, error: null
  }
  const nodes = new Map()
  const guards = new Map()
  let testnet
  let churnTimer
  let observer
  let churnBusy = false
  let churnCount = 0
  const replaceRelay = async index => {
    if (churnBusy) return
    churnBusy = true
    const startedAt = new Date().toISOString()
    try {
      const old = guards.get(`relay-${index}`)
      if (old) await old.close()
      const guard = await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
      guards.set(`relay-${index}`, guard)
      const snapshot = { index, startedAt, finishedAt: new Date().toISOString(), publicKey: Buffer.from(guard.publicKey).toString('hex'), ...guard.stats() }
      artifact.churn.push(snapshot)
      churnCount++
    } finally { churnBusy = false }
  }
  try {
    testnet = await createTestnet(options.relays + options.readers + 3)
    for (let i = 0; i < options.relays; i++) {
      const guard = await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
      guards.set(`relay-${i}`, guard)
      artifact.relays.push({ index: i, publicKey: Buffer.from(guard.publicKey).toString('hex'), stats: guard.stats() })
    }

    const bytes = fixture(options.bytes)
    const expectedHash = sha256(bytes)
    artifact.fixture = { bytes: bytes.length, sha256: expectedHash, generator: 'byte[i] = (i*31 + (i>>>8)*17 + 23) & 255' }
    const seeder = await createNode({ storage: resolve(runDir, 'seeder'), bootstrap: testnet.bootstrap, privateRouting: true })
    nodes.set('seeder', seeder)
    artifact.tracker = seeder.status().tracker
    const entry = await within(seeder.publish({ id: 'scale:fixture', title: 'Private scale fixture' }, Readable.from([bytes])), options.timeoutMs, 'Fixture publish')
    if (entry.sha256 !== expectedHash) throw new Error('Seeder published a fixture hash different from the generated fixture')

    const readers = await Promise.all(Array.from({ length: options.readers }, async (_, index) => {
      const node = await createNode({ storage: resolve(runDir, `reader-${index}`), bootstrap: testnet.bootstrap, tracker: artifact.tracker, privateRouting: true })
      nodes.set(`reader-${index}`, node)
      return { index, node }
    }))
    if (options.churnMs > 0) churnTimer = setInterval(() => { replaceRelay(1 + (churnCount % (options.relays - 1))).catch(err => { artifact.churn.push({ at: new Date().toISOString(), error: errorText(err) }) }) }, options.churnMs)

    artifact.readers = readers.map(({ index, node }) => ({ index, completed: false, status: node.status() }))
    const outcomes = await Promise.all(readers.map(async ({ index, node }) => {
      const evidence = artifact.readers[index]
      try {
        const t0 = performance.now()
        const advertised = await within(until(async () => {
          const entries = await node.search('scale:fixture')
          return entries.find(item => item.sha256 === expectedHash)
        }, options.timeoutMs, `Reader ${index} tracker discovery`), options.timeoutMs + 1000, `Reader ${index} tracker discovery`)
        await within(until(() => node.status().routes.private.peers > 0, options.timeoutMs, `Reader ${index} private peer connection`), options.timeoutMs + 1000, `Reader ${index} private peer connection`)
        const connectedMs = performance.now() - t0
        const requestAt = performance.now()
        const requestedAt = new Date().toISOString()
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
        let transferred = 0
        let ttfbMs = 0
        const digest = createHash('sha256')
        try {
          const response = await fetch(advertised.streamUrl, { signal: controller.signal })
          if (!response.ok || !response.body) throw new Error(`Reader ${index} returned HTTP ${response.status}`)
          const stream = response.body.getReader()
          for (;;) {
            const { done, value } = await stream.read()
            if (done) break
            if (transferred === 0) ttfbMs = performance.now() - requestAt
            transferred += value.byteLength
            digest.update(value)
          }
        } finally { clearTimeout(timeout) }
        const finishedAt = performance.now()
        const completedAt = new Date().toISOString()
        const actualHash = digest.digest('hex')
        const status = node.status()
        const result = {
          index, completed: true, bytes: transferred, sha256: actualHash, expectedSha256: expectedHash,
          connectedMs: Number(connectedMs.toFixed(2)), ttfbMs: Number(ttfbMs.toFixed(2)), requestedAt, completedAt,
          transferMs: Number((finishedAt - requestAt).toFixed(2)),
          throughputBps: Math.round(transferred * 1000 / Math.max(1, finishedAt - requestAt)),
          peers: status.peers, routes: status.routes, totalRxBytes: status.rxBytes, totalTxBytes: status.txBytes,
          transportPeers: { private: status.routes.private.peers, public: status.routes.public.peers, lan: status.routes.lan.peers }
        }
        Object.assign(evidence, result)
        if (transferred !== bytes.length || actualHash !== expectedHash) throw new Error(`Reader ${index} exact-byte check failed: got ${transferred} bytes, SHA256 ${actualHash}`)
        if (status.routes.private.rxBytes < bytes.length) throw new Error(`Reader ${index} private rxBytes ${status.routes.private.rxBytes} is below fixture size ${bytes.length}`)
        if (status.routes.public.rxBytes !== 0 || status.routes.lan.rxBytes !== 0) throw new Error(`Reader ${index} used public or LAN receive path`)
        if (status.rxBytes !== status.routes.private.rxBytes + status.routes.public.rxBytes + status.routes.lan.rxBytes) throw new Error(`Reader ${index} total rxBytes do not equal route counters`)
        if (status.txBytes !== status.routes.private.txBytes + status.routes.public.txBytes + status.routes.lan.txBytes) throw new Error(`Reader ${index} total txBytes do not equal route counters`)
        return result
      } catch (err) {
        evidence.completed = false
        evidence.error = errorText(err)
        evidence.status = safeStatus(node)
        throw err
      }
    }))
    if (options.durationMs > 0) await wait(options.durationMs)
    if (options.churnMs > 0 && !artifact.churn.some(event => !event.error && outcomes.some(result =>
      Date.parse(event.startedAt) <= Date.parse(result.completedAt) && Date.parse(event.finishedAt) >= Date.parse(result.requestedAt)
    ))) throw new Error('No relay actually restarted during an active reader transfer')
    observer = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: 0 })
    for (const contentTopic of [seeder.channel.discoveryKey]) {
      const leaked = new Set()
      for await (const reply of observer.lookup(contentTopic)) {
        for (const peer of reply.peers) leaked.add(Buffer.from(peer.publicKey).toString('hex'))
      }
      if (leaked.size !== 0) throw new Error('Tracker discoveryKey had public DHT announcements in private mode')
    }
    const announced = new Set()
    for (let s = 0; s < 4; s++) {
      const guardTopic = HyperDHT.hash(Buffer.from(`peartube/private-guard/v1/${s}`))
      for await (const reply of observer.lookup(guardTopic)) {
        for (const peer of reply.peers) announced.add(Buffer.from(peer.publicKey).toString('hex'))
      }
    }
    const endpointKey = node => Buffer.from(node.swarm.keyPair.publicKey).toString('hex')
    if (announced.has(endpointKey(seeder)) || readers.some(({ node }) => announced.has(endpointKey(node)))) throw new Error('A private seeder or reader appeared in the guard directory')
    const guardSet = new Set([...guards.values()].map(g => Buffer.from(g.publicKey).toString('hex')))
    const relayAnnounced = [...announced].some(k => guardSet.has(k))
    if (!relayAnnounced) throw new Error('No designated stateless guard announced in the global guard directory')
    artifact.dhtExposure = { designatedRelayAnnounced: relayAnnounced, seederAnnounced: false, readersAnnounced: false, inspectedGuardCount: announced.size }
    artifact.circuitExposure = [...nodes.entries()].map(([name, node]) => ({ name, ...node.swarm.dht.privateRouting.exposureReport() }))
    if (artifact.circuitExposure.some(report => report.directDestinationSends !== 0)) throw new Error('A private endpoint contacted a destination directly')
    const seederStatus = seeder.status()
    if (seederStatus.routes.private.txBytes < bytes.length) throw new Error(`Seeder private txBytes ${seederStatus.routes.private.txBytes} is below fixture size ${bytes.length}`)
    if (seederStatus.routes.public.txBytes !== 0 || seederStatus.routes.lan.txBytes !== 0) throw new Error('Seeder used public or LAN transmit path')
    artifact.relays = [...guards.entries()].map(([name, g]) => ({ name, publicKey: Buffer.from(g.publicKey).toString('hex'), stats: g.stats() }))
    artifact.seeder = { writer: seederStatus.writer, status: seederStatus }
    artifact.assertions = { everyReaderExactSha256: true, everyReaderPrivateRxAtLeastFixture: true, everyReaderPublicAndLanRxZero: true, everyReaderCountersReconcile: true, seederPrivateTxAtLeastFixture: true, seederPublicAndLanTxZero: true, dhtEndpointsUnannounced: true, directDestinationSendsZero: true, churnDuringTransfer: options.churnMs > 0 ? true : null }
    artifact.passed = true
  } catch (err) {
    artifact.error = errorText(err)
    artifact.relays = [...guards.entries()].map(([name, g]) => ({ name, stats: g.stats() }))
    artifact.readers = artifact.readers.length ? artifact.readers : [...nodes.entries()].filter(([name]) => name.startsWith('reader-')).map(([name, node]) => ({ name, status: safeStatus(node) }))
    throw err
  } finally {
    clearInterval(churnTimer)
    if (churnBusy) await until(() => !churnBusy, options.timeoutMs, 'Relay churn shutdown').catch(() => {})
    for (const node of nodes.values()) await node.close().catch(err => { (artifact.cleanupErrors ||= []).push(errorText(err)) })
    for (const guard of guards.values()) await guard.close().catch(err => { (artifact.cleanupErrors ||= []).push(errorText(err)) })
    await testnet?.destroy().catch(err => { (artifact.cleanupErrors ||= []).push(errorText(err)) })
    await observer?.destroy({ force: true }).catch(err => { (artifact.cleanupErrors ||= []).push(errorText(err)) })
    artifact.endedAt = new Date().toISOString()
    artifact.churnEvents = churnCount
    await mkdir(dirname(options.artifact), { recursive: true })
    await writeFile(options.artifact, JSON.stringify(artifact, null, 2) + '\n')
    await rm(runDir, { recursive: true, force: true })
  }
  return artifact
}
function safeStatus (node) { try { return node.status() } catch (err) { return { error: errorText(err) } } }

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (err) {
    console.error(`${err.message}\nUse --help for usage.`)
    process.exitCode = 2
  }
  if (options?.help) console.log(HELP)
  else if (options) run(options).then(result => {
    console.log(`Private scale evidence: ${options.artifact}`)
    console.log(`Readers: ${result.readers.length}; exact private-route checks: ${result.passed ? 'passed' : 'failed'}`)
  }).catch(err => {
    console.error(`Private scale run failed; evidence: ${options.artifact}\n${err.message}`)
    process.exitCode = 1
  })
}
