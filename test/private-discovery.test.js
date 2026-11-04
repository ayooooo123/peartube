import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import HyperDHT from 'hyperdht'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { attemptDirectHopBypass, createPrivateGuard, diversityBucketForAddress, publishStandaloneRouteCard } from '../src/private-overlay.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-private-discovery-'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha256Hex = buf => createHash('sha256').update(buf).digest('hex')
const artifactPath = join(process.cwd(), 'desktop/target/e2e/private-discovery-result.json')
const evidence = { startedAt: new Date().toISOString(), scenarios: {} }

function writeArtifact () {
  mkdirSync(join(process.cwd(), 'desktop/target/e2e'), { recursive: true })
  writeFileSync(artifactPath, JSON.stringify({ ...evidence, updatedAt: new Date().toISOString() }, null, 2) + '\n')
}

async function until (fn, ms = 90_000, label = 'Private peers did not converge') {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(label)
    await wait(250)
  }
}

function spawnGuardDaemon ({ cwd, bootstrap }) {
  return new Promise((resolve, reject) => {
    const script = join(process.cwd(), 'bin/private-relay.js')
    const proc = spawn(process.execPath, [script], {
      cwd,
      env: {
        PATH: process.env.PATH || '',
        HOME: cwd,
        TMPDIR: cwd,
        PEARTUBE_BOOTSTRAP: bootstrap.map(b => `${b.host}:${b.port}`).join(','),
        PEARTUBE_PRIVATE_HOST: '127.0.0.1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    const rl = createInterface({ input: proc.stdout })
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`bin/private-relay.js timed out starting: ${stderr}`))
    }, 20_000)
    rl.on('line', line => {
      try {
        const msg = JSON.parse(line)
        if (msg.msg === 'private-guard ready' && msg.publicKey) {
          clearTimeout(timer)
          resolve({
            info: msg,
            close: () => new Promise(res => {
              if (proc.exitCode !== null) return res()
              proc.once('exit', () => res())
              proc.kill('SIGTERM')
              setTimeout(() => { try { proc.kill('SIGKILL') } catch {}; res() }, 3000).unref()
            })
          })
        }
      } catch {}
    })
    proc.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`bin/private-relay.js exited early (${code}): ${stderr}`))
    })
  })
}

test('fail-closed <2 guards and non-loopback /24 prefix diversity enforcement', { timeout: 90_000 }, async t => {
  await assert.rejects(
    () => createNode({ storage: tmp(), privateRelay: true }),
    /Embedded privateRelay was removed/,
    'createNode refuses embedded privateRelay so guards never share a Corestore process'
  )
  // Non-loopback IPv4 addresses in the same /24 share one diversity bucket and cannot form a 2-hop pair;
  // loopback ports are isolated ONLY when allowLoopback=true for local 127.0.0.1 testnets.
  assert.equal(
    diversityBucketForAddress('198.51.100.11', 4001, false),
    diversityBucketForAddress('198.51.100.220', 4002, false),
    'same /24 public IPv4 addresses collapse to one diversity bucket'
  )
  assert.notEqual(
    diversityBucketForAddress('198.51.100.11', 4001, false),
    diversityBucketForAddress('203.0.113.11', 4001, false),
    'distinct /24 public IPv4 prefixes yield distinct diversity buckets'
  )
  assert.equal(
    diversityBucketForAddress('127.0.0.1', 4001, false),
    null,
    'loopback is rejected when allowLoopback is false'
  )
  assert.notEqual(
    diversityBucketForAddress('127.0.0.1', 4001, true),
    diversityBucketForAddress('127.0.0.1', 4002, true),
    'local 127.0.0.1 testnet explicitly isolates distinct loopback guard ports'
  )

  const testnet = await createTestnet(3)
  let loneGuard = null
  const nodes = []
  t.after(async () => {
    await Promise.all(nodes.map(n => n.close()))
    if (loneGuard) await loneGuard.close()
    await testnet.destroy()
  })

  loneGuard = await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  const seeder = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, privateRouting: true })
  nodes.push(seeder)
  const reader = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker: seeder.status().tracker, privateRouting: true })
  nodes.push(reader)

  await seeder.publish({ id: 'imdb:tt0000001', title: 'Single guard fail-closed' }, Readable.from([randomBytes(65536)]))
  await wait(4000)

  assert.equal(reader.status().peers, 0, 'strict 2-hop mode refuses 1-hop fallback when only 1 guard exists')
  assert.equal(reader.status().routes.public.rxBytes, 0, 'zero public fallback bytes')
  assert.equal(seeder.swarm.dht.privateRouting.exposureReport().directDestinationSends, 0)

  // End-to-end non-loopback /24 WAN simulation (`allowLoopback: false`):
  // Two guards in the SAME /24 (198.51.100.10 & 198.51.100.20) MUST fail closed;
  // once a second /24 guard (203.0.113.40) joins, OP_DIAL_OPEN succeeds across distinct /24s with allowLoopback=false!
  const wanTestnet = await createTestnet(4)
  const seedSame1 = randomBytes(32), seedSame2 = randomBytes(32), seedDiverse = randomBytes(32)
  const keyToWanIp = new Map([
    [Buffer.from(HyperDHT.keyPair(seedSame1).publicKey).toString('hex'), '198.51.100.10'],
    [Buffer.from(HyperDHT.keyPair(seedSame2).publicKey).toString('hex'), '198.51.100.20'],
    [Buffer.from(HyperDHT.keyPair(seedDiverse).publicKey).toString('hex'), '203.0.113.40']
  ])
  const resolveWan = (_host, _port, pk) => (pk && keyToWanIp.get(Buffer.from(pk).toString('hex'))) || '192.0.2.50'
  const wanGuards = []
  const wanNodes = []
  t.after(async () => {
    await Promise.all(wanNodes.map(n => n.close()))
    await Promise.all(wanGuards.map(g => g.close()))
    await wanTestnet.destroy()
  })
  wanGuards.push(await createPrivateGuard({ host: '127.0.0.1', bootstrap: wanTestnet.bootstrap, seed: seedSame1, allowLoopback: false, resolveAddress: resolveWan }))
  wanGuards.push(await createPrivateGuard({ host: '127.0.0.1', bootstrap: wanTestnet.bootstrap, seed: seedSame2, allowLoopback: false, resolveAddress: resolveWan }))

  const wanOpts = { allowLoopback: false, resolveAddress: resolveWan }
  const wanSeeder = await createNode({ storage: tmp(), bootstrap: wanTestnet.bootstrap, privateRouting: wanOpts })
  wanNodes.push(wanSeeder)
  const wanReader = await createNode({ storage: tmp(), bootstrap: wanTestnet.bootstrap, tracker: wanSeeder.status().tracker, privateRouting: wanOpts })
  wanNodes.push(wanReader)
  const wanBytes = randomBytes(128 * 1024 + 3)
  await wanSeeder.publish({ id: 'imdb:tt0000002', title: 'WAN /24 test' }, Readable.from([wanBytes]))
  await wait(4000)
  assert.equal(wanReader.status().peers, 0, 'two guards in the same /24 (198.51.100.0/24) fail closed under allowLoopback=false')

  wanGuards.push(await createPrivateGuard({ host: '127.0.0.1', bootstrap: wanTestnet.bootstrap, seed: seedDiverse, allowLoopback: false, resolveAddress: resolveWan }))
  const [wanEntry] = await until(async () => (await wanReader.search('imdb:tt0000002')).length && wanReader.search('imdb:tt0000002'), 60_000, 'WAN /24 diverse guards converged with allowLoopback=false')
  const wanRes = await fetch(wanEntry.streamUrl)
  assert.equal(wanRes.status, 200)
  assert.equal(sha256Hex(Buffer.from(await wanRes.arrayBuffer())), sha256Hex(wanBytes), 'exact bytes streamed across distinct /24 guards with allowLoopback=false')

  evidence.scenarios.failClosedAndDiversity = {
    passed: true,
    loneGuardPeers: reader.status().peers,
    same24SubnetBlocked: true,
    distinct24SubnetStreamedBytes: wanBytes.length,
    publicFallbackBytes: reader.status().routes.public.rxBytes,
    directDestinationSends: seeder.swarm.dht.privateRouting.exposureReport().directDestinationSends
  }
  writeArtifact()
})

test('standalone bin/private-relay.js forwarders: zero disk writes, fresh-boot 2-hop streaming, 206 Range seek, and LAN refusal', { timeout: 180_000 }, async t => {
  const testnet = await createTestnet(4)
  const guardDaemons = []
  const guardDirs = [tmp(), tmp()]
  const nodes = []
  let observer = null

  t.after(async () => {
    await Promise.all(nodes.map(n => n.close()))
    await Promise.all(guardDaemons.map(g => g.close()))
    await observer?.destroy({ force: true })
    await testnet.destroy()
  })

  for (const dir of guardDirs) {
    guardDaemons.push(await spawnGuardDaemon({ cwd: dir, bootstrap: testnet.bootstrap }))
  }

  const seederDir = tmp()
  const readerDir = tmp()
  const seeder = await createNode({ storage: seederDir, bootstrap: testnet.bootstrap, privateRouting: true })
  nodes.push(seeder)
  const tracker = seeder.status().tracker
  const reader = await createNode({ storage: readerDir, bootstrap: testnet.bootstrap, tracker, privateRouting: true })
  nodes.push(reader)

  assert.equal(existsSync(join(seederDir, 'private-guards.json')), false, 'no sticky private-guards.json created on seeder')
  assert.equal(existsSync(join(readerDir, 'private-guards.json')), false, 'no sticky private-guards.json created on reader')

  let lanFactoryCalled = false
  await seeder.setLan(() => { lanFactoryCalled = true; throw new Error('LAN must stay disabled in private mode') })
  assert.equal(lanFactoryCalled, false, 'setLan refuses cleartext LAN mDNS under privateRouting')
  assert.equal(seeder.hasLan(), false)
  assert.equal(seeder.lanEndpoint(), null)

  const bytes = randomBytes(1024 * 1024 + 17)
  await seeder.publish({ id: 'imdb:tt0100001', title: 'Private 2-hop seeder' }, Readable.from([bytes]))
  const [entry] = await until(async () => (await reader.search('imdb:tt0100001')).length && reader.search('imdb:tt0100001'), 90_000, 'reader synced tracker via 2-hop guard daemons')

  const rangeRes = await fetch(entry.streamUrl, { headers: { Range: 'bytes=524200-525000' } })
  assert.equal(rangeRes.status, 206)
  assert.deepEqual(Buffer.from(await rangeRes.arrayBuffer()), bytes.subarray(524200, 525001))

  const response = await fetch(entry.streamUrl)
  assert.equal(response.status, 200)
  assert.equal(sha256Hex(Buffer.from(await response.arrayBuffer())), entry.sha256)
  assert.equal(entry.sha256, sha256Hex(bytes))

  // Verify the actual bin/private-relay.js daemon working/HOME/TMPDIR directories stayed 100% empty after streaming!
  for (const dir of guardDirs) {
    assert.deepEqual(readdirSync(dir), [], 'standalone forwarder daemon created zero files in cwd/HOME/TMPDIR during active video streaming')
  }

  const transferred = reader.status()
  assert.ok(transferred.routes.private.rxBytes >= bytes.length)
  assert.equal(transferred.routes.public.rxBytes, 0)
  assert.equal(transferred.routes.lan.rxBytes, 0)
  assert.equal(transferred.rxBytes, transferred.routes.private.rxBytes)
  assert.ok(seeder.status().routes.private.txBytes >= bytes.length)

  observer = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: 0 })
  const seederPubHex = Buffer.from(seeder.swarm.keyPair.publicKey).toString('hex')
  const readerPubHex = Buffer.from(reader.swarm.keyPair.publicKey).toString('hex')
  const guardPubSet = new Set(guardDaemons.map(g => g.info.publicKey))

  for (const contentTopic of [
    seeder.tracker.discoveryKey,
    createHash('sha256').update('peartube/blob/v1/').update(Buffer.from(seeder.status().blobs, 'hex')).digest()
  ]) {
    const leaked = new Set()
    for await (const reply of observer.lookup(contentTopic)) {
      for (const peer of reply.peers) leaked.add(Buffer.from(peer.publicKey).toString('hex'))
    }
    assert.equal(leaked.size, 0, 'content/tracker topics have zero public DHT announcements in private mode')
  }
  const epoch = String(Math.floor(Date.now() / 3_600_000))
  const rvTopic = createHash('sha256').update('peartube/private-rv/v1/').update(Buffer.from(tracker, 'hex')).update(epoch).digest()
  const rvPeers = new Set()
  for await (const reply of observer.lookup(rvTopic)) {
    for (const peer of reply.peers) rvPeers.add(Buffer.from(peer.publicKey).toString('hex'))
  }
  assert.ok(rvPeers.size >= 1, 'consenting guards announce the blinded hourly rendezvous topic on behalf of registered endpoints')
  assert.equal(rvPeers.has(seederPubHex), false, 'seeder never announces itself on rvTopic')
  assert.equal(rvPeers.has(readerPubHex), false, 'reader never announces itself on rvTopic')
  for (const k of rvPeers) assert.ok(guardPubSet.has(k), 'rvTopic exposes only Guard forwarder public keys')

  // Second independent private seeder joins & publishes, then a brand-new cold joiner with ONLY tracker+bootstrap
  // discovers both live seeders and streams from the second seeder without any pre-shared peer keys.
  const seeder2 = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker, privateRouting: true })
  nodes.push(seeder2)
  await seeder.grantWriter(seeder2.status().writer)
  const secondSeederBytes = randomBytes(300 * 1024 + 19)
  await seeder2.publish({ id: 'imdb:tt0100077', title: 'Second private seeder' }, Readable.from([secondSeederBytes]))
  const coldJoiner = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker, privateRouting: true })
  nodes.push(coldJoiner)
  const [coldHit] = await until(async () => (await coldJoiner.search('imdb:tt0100077')).length && coldJoiner.search('imdb:tt0100077'), 60_000, 'cold joiner with only tracker+bootstrap synced multi-seeder tracker')
  const coldRes = await fetch(coldHit.streamUrl)
  assert.equal(coldRes.status, 200)
  assert.equal(sha256Hex(Buffer.from(await coldRes.arrayBuffer())), sha256Hex(secondSeederBytes))

  const discoveredGuards = new Set()
  for (let s = 0; s < 4; s++) {
    for await (const reply of observer.lookup(HyperDHT.hash(Buffer.from(`peartube/private-guard/v1/${s}`)))) {
      for (const peer of reply.peers) discoveredGuards.add(Buffer.from(peer.publicKey).toString('hex'))
    }
  }
  assert.equal(discoveredGuards.has(seederPubHex), false)
  assert.equal(discoveredGuards.has(readerPubHex), false)
  for (const k of guardPubSet) assert.ok(discoveredGuards.has(k), 'stateless guard forwarders are discoverable on global guard topics')
  evidence.scenarios.statelessDaemonStreaming = {
    passed: true,
    guardDirFileCounts: guardDirs.map(d => readdirSync(d).length),
    bytes: bytes.length,
    sha256: entry.sha256,
    routes: transferred.routes,
    privateEndpointsAnnounced: false
  }
  writeArtifact()
})

test('adversarial scanPeers outbound joinPeer trap and wrong inner Noise key rejection', { timeout: 150_000 }, async t => {
  const testnet = await createTestnet(4)
  const guards = []
  const nodes = []
  t.after(async () => {
    await Promise.all(nodes.map(n => n.close()))
    await Promise.all(guards.map(g => g.close()))
    await testnet.destroy()
  })

  for (let i = 0; i < 2; i++) {
    guards.push(await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap }))
  }
  const seeder = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, privateRouting: true })
  nodes.push(seeder)
  const tracker = seeder.status().tracker
  const reader = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker, privateRouting: true })
  nodes.push(reader)
  await seeder.grantWriter(reader.status().writer)
  await seeder.publish({ id: 'imdb:tt0100009', title: 'Warmup sync' }, Readable.from([randomBytes(32768)]))
  await until(async () => (await reader.search('imdb:tt0100009')).length > 0, 60_000, 'initial sync before outbound trap')

  const seederReport = seeder.swarm.dht.privateRouting.exposureReport()
  const honestGuardTransportKeys = new Set(guards.map(g => Buffer.from(g.publicKey).toString('hex')))
  const honestGuardPorts = new Set(guards.flatMap(g => g.boundPorts()))

  const attackerObservedPeers = []
  const attackerGuard = await createPrivateGuard({
    host: '127.0.0.1',
    bootstrap: testnet.bootstrap,
    announceGuard: false,
    onControlPeer: info => attackerObservedPeers.push(info)
  })
  guards.push(attackerGuard)

  const seederPubHex = Buffer.from(seeder.swarm.keyPair.publicKey).toString('hex')
  const maliciousKeyPair = NoiseSecretStream.keyPair()
  const maliciousPeerHex = Buffer.from(maliciousKeyPair.publicKey).toString('hex')
  const spoofAdvertisedKeyPair = NoiseSecretStream.keyPair()
  const spoofWrongResponderKeyPair = NoiseSecretStream.keyPair()
  const spoofPeerHex = Buffer.from(spoofAdvertisedKeyPair.publicKey).toString('hex')

  let attackerAcceptedFromSeeder = false
  const cleanupMalicious = await publishStandaloneRouteCard({
    bootstrap: testnet.bootstrap,
    guardPublicKey: attackerGuard.publicKey,
    advertisedKeyPair: maliciousKeyPair,
    responderKeyPair: maliciousKeyPair,
    onInnerConnection: conn => {
      if (Buffer.from(conn.remotePublicKey).toString('hex') === seederPubHex) attackerAcceptedFromSeeder = true
      conn.destroy()
    }
  })

  let wrongKeyConnectedOnSeeder = false
  seeder.swarm.on('connection', conn => {
    const rk = Buffer.from(conn.remotePublicKey || []).toString('hex')
    if (rk === Buffer.from(spoofWrongResponderKeyPair.publicKey).toString('hex') || rk === spoofPeerHex) {
      wrongKeyConnectedOnSeeder = true
    }
  })
  const cleanupSpoof = await publishStandaloneRouteCard({
    bootstrap: testnet.bootstrap,
    guardPublicKey: attackerGuard.publicKey,
    advertisedKeyPair: spoofAdvertisedKeyPair,
    responderKeyPair: spoofWrongResponderKeyPair,
    onInnerConnection: conn => conn.destroy()
  })

  try {
    await reader.append({ type: 'peer', publicKey: spoofPeerHex, expiresAt: Date.now() + 60_000 })
    await wait(3000)
    assert.equal(wrongKeyConnectedOnSeeder, false, 'seeder rejected responder presenting wrong inner Noise key')

    await reader.append({ type: 'peer', publicKey: maliciousPeerHex, expiresAt: Date.now() + 60_000 })
    await until(() => attackerAcceptedFromSeeder, 30_000, 'seeder outbound-dialed malicious peer via seeder guard')

    // Filter out the trap client's own registration connection to attackerGuard; inspect hop connections from the network.
    const hopPeers = attackerObservedPeers.filter(p => p.role === 'hop')
    assert.ok(hopPeers.length > 0, 'attacker guard observed incoming hop connection')
    for (const hp of hopPeers) {
      assert.ok(honestGuardTransportKeys.has(hp.remotePublicKey), `hop peer key ${hp.remotePublicKey} belongs to an honest Guard, never seeder`)
      assert.notEqual(hp.remotePort, seederReport.transportPort, 'attacker guard NEVER saw seeder transport UDP port')
      assert.ok(honestGuardPorts.has(hp.remotePort), `hop source port ${hp.remotePort} belongs to an honest Guard`)
    }
  } finally {
    await cleanupMalicious()
    await cleanupSpoof()
  }

  // Direct 1-hop token-bypass probe: hostile monitor decrypts seeder's route card and tries calling OP_HOP_OPEN
  // directly on seeder's Guard (both as an 'endpoint' session and spoofing 'hop' from an unadvertised keypair).
  const bypassProbe = await attemptDirectHopBypass({
    bootstrap: testnet.bootstrap,
    targetPeerPublicKey: seeder.swarm.keyPair.publicKey
  })
  assert.equal(bypassProbe.endpointBypassAccepted, false, 'destination guard rejects OP_HOP_OPEN from endpoint sessions')
  assert.equal(bypassProbe.spoofedHopAccepted, false, 'destination guard rejects OP_HELLO(hop) + OP_HOP_OPEN from unadvertised non-guard callers')

  evidence.scenarios.outboundTrapAndKeyPin = {
    passed: true,
    wrongInnerKeyRejected: !wrongKeyConnectedOnSeeder,
    seederTransportPort: seederReport.transportPort,
    attackerHopObservations: attackerObservedPeers.filter(p => p.role === 'hop'),
    directHopBypassBlocked: !bypassProbe.endpointBypassAccepted && !bypassProbe.spoofedHopAccepted
  }
  writeArtifact()
})

test('suspend and resume reconstructs 2-hop guard circuits and streams newly published entries', { timeout: 150_000 }, async t => {
  const testnet = await createTestnet(4)
  const guards = []
  const nodes = []
  const warnings = []
  const onWarning = w => warnings.push(`${w.name}: ${w.message}`)
  process.on('warning', onWarning)
  t.after(async () => {
    process.off('warning', onWarning)
    await Promise.all(nodes.map(n => n.close()))
    await Promise.all(guards.map(g => g.close()))
    await testnet.destroy()
  })

  for (let i = 0; i < 2; i++) {
    guards.push(await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap }))
  }
  const seeder = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, privateRouting: true })
  nodes.push(seeder)
  const reader = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker: seeder.status().tracker, privateRouting: true })
  nodes.push(reader)

  const firstBytes = randomBytes(256 * 1024 + 7)
  await seeder.publish({ id: 'imdb:tt0200001', title: 'Pre-suspend' }, Readable.from([firstBytes]))
  await until(async () => (await reader.search('imdb:tt0200001')).length > 0, 60_000, 'pre-suspend sync')

  await reader.swarm.suspend()
  assert.equal(reader.swarm.dht.privateRouting.status(), 'SUSPENDED')
  await reader.swarm.resume()
  await until(() => reader.swarm.dht.privateRouting.status() === 'READY', 30_000, 'resumed to READY')

  const secondBytes = randomBytes(512 * 1024 + 99)
  await seeder.publish({ id: 'imdb:tt0200002', title: 'Post-resume' }, Readable.from([secondBytes]))
  const [entry2] = await until(async () => (await reader.search('imdb:tt0200002')).length && reader.search('imdb:tt0200002'), 60_000, 'post-resume sync')
  // Repeated Range-seek storm + 14 circuit teardowns across the same long-lived Guard control channels
  // must not leak close listeners or trigger MaxListenersExceededWarning.
  for (let i = 0; i < 16; i++) {
    const off = (i * 16384) % (secondBytes.length - 4096)
    const r = await fetch(entry2.streamUrl, { headers: { Range: `bytes=${off}-${off + 2047}` } })
    assert.equal(r.status, 206)
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), secondBytes.subarray(off, off + 2048))
  }
  for (let i = 0; i < 14; i++) {
    const prev = [...reader.swarm.connections]
    assert.ok(prev.length > 0, `active connection present before reconnect ${i}`)
    for (const c of prev) c.destroy()
    await until(() => prev.every(c => !reader.swarm.connections.has(c)), 5000, `old circuit closed ${i}`)
    for (const t of reader.swarm.topics()) await t.refresh()
    await until(
      () => reader.swarm.connections.size > 0 && [...reader.swarm.connections].every(c => !prev.includes(c)),
      15_000,
      `fresh circuit reconnect ${i}`
    )
  }
  const res2 = await fetch(entry2.streamUrl)
  assert.equal(res2.status, 200)
  assert.equal(sha256Hex(Buffer.from(await res2.arrayBuffer())), sha256Hex(secondBytes))
  assert.deepEqual(warnings, [], 'zero MaxListenersExceededWarning across repeated seeks and 14 circuit teardowns')
  assert.equal(guards.every(g => g.stats().activeCircuits <= 2), true, 'closed circuits leave zero stale activeCircuits on guards')

  // Verify mutable DHT & RV registrations stay strictly bounded across 10s (2-3 background poll cycles)
  // instead of re-publishing on every 4s discovery poll.
  const mutBefore = guards.reduce((n, g) => n + g.stats().putMutableCount, 0)
  const rvBefore = guards.reduce((n, g) => n + g.stats().rvRegisterCount, 0)
  await wait(9500)
  const mutAfter = guards.reduce((n, g) => n + g.stats().putMutableCount, 0)
  const rvAfter = guards.reduce((n, g) => n + g.stats().rvRegisterCount, 0)
  assert.equal(mutAfter, mutBefore, 'steady-state discovery polls perform zero redundant mutablePut writes before TTL renewal')
  assert.equal(rvAfter, rvBefore, 'steady-state discovery polls perform zero redundant rvRegister writes before TTL renewal')

  // Failure-then-retry check: if guards return [0] on OP_PUT_MUTABLE during resume, publishPresence
  // MUST NOT cache a bogus 5-minute renewal window — the next 4s poll must retry and reach READY.
  await reader.swarm.suspend()
  for (const g of guards) g.failNextMutablePut(1)
  await reader.swarm.resume()
  assert.equal(reader.swarm.dht.privateRouting.status(), 'UNAVAILABLE', 'failed mutablePut ACK leaves node UNAVAILABLE instead of caching 5m blackhole')
  await until(() => reader.swarm.dht.privateRouting.status() === 'READY', 12_000, 'next 4s poll retried mutablePut after [0] ACK and reached READY')

  evidence.scenarios.suspendResume = {
    passed: true,
    postResumeBytes: secondBytes.length,
    repeatedRangeSeeks: 16,
    repeatedCircuitReconnects: 14,
    processWarnings: warnings.length,
    sha256: entry2.sha256
  }
  writeArtifact()
  console.log(`Private 2-hop discovery evidence: ${artifactPath}`)
})
