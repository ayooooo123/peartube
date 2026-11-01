// End-to-end verification of PearTube Cast & TV Receivers (peartube-cast/v1):
//   1. Thin Portable Receiver Daemon (Bare subprocess `bin/receiver.js --thin --player headless`):
//      PIN rejection, 6-char TV code pairing, token-gated LAN HTTP 206 Range streaming, SSE state sync,
//      and seek/pause/stop remote control.
//   2. Native P2P mDNS Receiver with mid-stream initiator loss:
//      streams directly from its local 1-hop P2P BlobServer (`mode: 'p2p'`), survives mid-stream initiator
//      shutdown with zero byte drop, and seeds cached blocks to a 3rd peer as a normal peer.
//   3. Cross-subnet Noise P2P Keypair Pairing (`peartube://receiver/<64-hex-pubkey>?token=...`):
//      with zero LAN HTTP path given, pairs and casts over HyperDHT Noise encryption and streams directly
//      from the P2P swarm.
// Writes repeatable verification evidence to `desktop/target/e2e/cast-result.json`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createPrivateGuard } from '../src/private-overlay.js'
import { createCastController, createReceiver, formatReceiverUri, parseReceiverUri } from '../src/cast.js'
import { mdnsBus } from './mdns.js'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const tmp = name => mkdtempSync(join(tmpdir(), `peartube-cast-${name}-`))

function fetchRange (url, rangeHeader = null) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: rangeHeader ? { range: rangeHeader } : {} }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.once('end', () => {
        const body = Buffer.concat(chunks)
        resolve({ status: res.statusCode, body, sha256: sha256(body), contentRange: res.headers['content-range'] || null })
      })
      res.once('error', reject)
    })
    req.once('error', reject)
    req.end()
  })
}

async function waitFor (fn, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const val = await fn()
    if (val) return val
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const evidence = { ranAt: new Date().toISOString(), scenarios: {} }

test('thin portable receiver daemon pairs by 6-char TV code, streams 206 HTTP Range bytes, and obeys remote control', async t => {
  const testnet = await createTestnet(3)
  const sender = await createNode({ storage: tmp('sender-thin'), bootstrap: testnet.bootstrap })
  const recDir = tmp('daemon-thin')
  const daemon = spawn(
    process.execPath,
    ['bin/receiver.js', '--thin', '--player', 'headless', '--port', '0', '--name', 'Bedroom Roku TV', '--storage', recDir],
    { env: { ...process.env, PEARTUBE_LAN_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] }
  )
  t.after(async () => {
    daemon.kill('SIGTERM')
    await sender.close()
    await testnet.destroy()
  })

  const rl = createInterface({ input: daemon.stdout })
  const boot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Receiver daemon did not print ready JSON')), 15_000)
    rl.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)) })
  })
  assert.equal(boot.msg, 'receiver ready')
  assert.equal(boot.thin, true)
  assert.equal(boot.capabilities.p2p, false, 'thin network-stack receiver runs without a P2P node')
  assert.equal(boot.pairCode.length, 6)

  const cast = createCastController({
    storage: tmp('sender-cast-thin'),
    getNode: () => sender,
    getLanHost: () => '127.0.0.1'
  })
  t.after(() => cast.close())

  const bytes = randomBytes(2 * 1024 * 1024 + 333)
  const published = await sender.publish({ id: 'imdb:tt0133093', title: 'Thin Receiver Matrix' }, Readable.from([bytes]))
  const entries = await sender.search('imdb:tt0133093')
  const entryKey = entries[0].key

  // Wrong TV PIN must be rejected cleanly before pairing succeeds.
  await assert.rejects(
    () => cast.pairReceiver({ host: '127.0.0.1', port: boot.port, code: '000000' }),
    /Invalid TV pairing code/i
  )

  const paired = await cast.pairReceiver({ host: '127.0.0.1', port: boot.port, code: boot.pairCode })
  assert.equal(paired.name, 'Bedroom Roku TV')
  assert.ok(paired.token.length >= 16)

  const playing = await cast.castPlay({ receiverId: paired.id, key: entryKey, preferMode: 'auto', startPositionMs: 5000 })
  assert.equal(playing.session.receiverName, 'Bedroom Roku TV')
  assert.equal(playing.session.state.mode, 'http')

  const artifactPath = join(recDir, 'last-playback.json')
  const playback = await waitFor(() => existsSync(artifactPath) && JSON.parse(readFileSync(artifactPath, 'utf8')), 'thin daemon stream verification')
  assert.equal(playback.rangeStatus, 206)
  assert.equal(playback.rangeBytes, 4096)
  assert.equal(playback.fullBytes, bytes.length)
  assert.equal(playback.fullSha256, sha256(bytes))

  await cast.castControl({ action: 'seek', positionMs: 24_000 })
  await waitFor(() => cast.status().session?.state?.positionMs >= 24_000, 'SSE seek sync')
  await cast.castControl({ action: 'pause' })
  await waitFor(() => cast.status().session?.state?.playing === false, 'SSE pause sync')
  await cast.castStop({ stopPlayback: true })
  assert.equal(cast.status().session, null)

  evidence.scenarios.thinDaemon = { boot, playback }
})

test('native P2P mDNS receiver streams from local BlobServer across mid-stream initiator loss and seeds to a 3rd peer', { timeout: 180_000 }, async t => {
  const testnet = await createTestnet(3)
  const bus = mdnsBus()
  const relay = await createNode({ storage: tmp('hybrid-relay'), bootstrap: testnet.bootstrap })
  const sender = await createNode({ storage: tmp('hybrid-sender'), tracker: relay.status().tracker, bootstrap: testnet.bootstrap })
  const receiverNode = await createNode({ storage: tmp('hybrid-tv-node'), bootstrap: testnet.bootstrap })
  let thirdPeer = null

  let receivedCmd = null
  const tv = await createReceiver({
    storage: tmp('hybrid-tv-cast'),
    name: 'Living Room Shield TV',
    port: 0,
    lanHost: '127.0.0.1',
    node: receiverNode,
    adapter: bus(),
    onCommand: async (cmd, ctx) => {
      receivedCmd = cmd
      if (cmd.action === 'load') {
        ctx.updateState({ status: 'playing', playing: true, buffering: false, positionMs: cmd.startPositionMs || 0, durationMs: 90_000 })
      }
    }
  })
  const cast = createCastController({
    storage: tmp('hybrid-sender-cast'),
    getNode: () => sender,
    getLanHost: () => '127.0.0.1',
    adapter: bus()
  })
  await cast.setLanHost('127.0.0.1')

  t.after(async () => {
    await cast.close()
    await thirdPeer?.close()
    await tv.close()
    await receiverNode.close()
    await sender.close()
    await relay.close()
    await testnet.destroy()
  })

  const bytes = randomBytes(2560 * 1024 + 19)
  await relay.publish({ id: 'imdb:tt0111161', title: 'Hybrid Swarm Survival' }, Readable.from([bytes]))

  const entry = await waitFor(async () => (await sender.search('imdb:tt0111161'))[0], 'sender synced tracker entry', 60_000)
  const discoveredTv = await waitFor(() => cast.listReceivers().find(r => r.name === 'Living Room Shield TV'), 'mDNS discovered Shield TV')
  assert.equal(discoveredTv.p2p, true)

  await cast.pairReceiver({ id: discoveredTv.id, code: tv.info().pairCode })
  await cast.castPlay({ receiverId: discoveredTv.id, key: entry.key, preferMode: 'auto' })
  assert.ok(receivedCmd?.streamUrl?.startsWith('http://127.0.0.1:'), 'native P2P receiver streams directly from local 1-hop BlobServer')

  // Open ONE single continuous HTTP stream (just as OxideAV ReadAheadSource does),
  // then kill the cast initiator mid-flight after the first 128 KiB arrives!
  const midStreamContinuous = await new Promise((resolve, reject) => {
    let killedInitiator = false
    let readSoFar = 0
    const chunks = []
    const req = httpRequest(receivedCmd.streamUrl, { headers: { range: 'bytes=0-' } }, res => {
      res.on('data', chunk => {
        chunks.push(chunk)
        readSoFar += chunk.length
        if (!killedInitiator && readSoFar >= 128 * 1024) {
          killedInitiator = true
          res.pause()
          Promise.all([cast.close(), sender.close()]).then(() => res.resume()).catch(reject)
        }
      })
      res.once('end', () => {
        const full = Buffer.concat(chunks)
        resolve({ status: res.statusCode, length: full.length, sha256: sha256(full) })
      })
      res.once('error', reject)
    })
    req.once('error', reject)
    req.end()
  })

  assert.equal(midStreamContinuous.status, 206)
  assert.equal(midStreamContinuous.length, bytes.length, 'single open player stream completed 100% of bytes across mid-stream initiator death')
  assert.equal(midStreamContinuous.sha256, sha256(bytes))
  assert.equal(tv.state().mode, 'p2p', 'receiver upgraded stream mode to p2p swarm')

  // Wait for TV receiver's retained linear download to hold 100% of the blob, then kill the original relay too
  // so the TV receiver is the ONLY peer on earth holding the movie!
  await waitFor(() => (tv.peerStatus()?.cachedBytes || 0) >= bytes.length, 'TV cached 100% of blob for seeding', 60_000)
  await relay.close()

  // A brand-new 3rd peer joins and downloads the entire movie directly from the TV receiver!
  thirdPeer = await createNode({ storage: tmp('third-public-peer'), bootstrap: testnet.bootstrap })
  const openedOnThird = await thirdPeer.openUri(entry.magnetUrl)
  const fromTvOnly = await fetchRange(openedOnThird.entry.streamUrl)
  assert.equal(fromTvOnly.status, 200)
  assert.equal(fromTvOnly.body.length, bytes.length)
  assert.equal(fromTvOnly.sha256, sha256(bytes), '3rd peer streamed exact video bytes solely from the TV receiver')
  assert.ok((tv.peerStatus()?.txBytes || 0) >= bytes.length, 'TV receiver transmitted the full video as a normal P2P seeder')

  evidence.scenarios.hybridFailoverAndSeeding = {
    tvPublicKey: tv.publicKey,
    finalMode: tv.state().mode,
    midStreamSpliceBytes: midStreamContinuous.length,
    seededByTvTxBytes: tv.peerStatus()?.txBytes,
    verifiedSha256: fromTvOnly.sha256
  }
})

test('cross-subnet Noise P2P keypair pairing casts and controls a remote receiver with no LAN HTTP path', async t => {
  const testnet = await createTestnet(3)
  const sender = await createNode({ storage: tmp('noise-sender'), bootstrap: testnet.bootstrap })
  const tvNode = await createNode({ storage: tmp('noise-tv-node'), bootstrap: testnet.bootstrap })

  let loadedUrl = null
  const tv = await createReceiver({
    storage: tmp('noise-tv-cast'),
    name: 'Remote Mountain Apple TV',
    port: 0,
    lanHost: null,
    node: tvNode,
    onCommand: async (cmd, ctx) => {
      if (cmd.action === 'load') {
        loadedUrl = cmd.streamUrl
        ctx.updateState({ status: 'playing', playing: true, buffering: false, positionMs: 0, durationMs: 120_000 })
      }
    }
  })

  const cast = createCastController({
    storage: tmp('noise-sender-cast'),
    getNode: () => sender,
    getLanHost: () => null // No LAN IPv4 / cross-subnet: forces pure Noise P2P control + P2P swarm media!
  })

  t.after(async () => {
    await cast.close()
    await tv.close()
    await tvNode.close()
    await sender.close()
    await testnet.destroy()
  })

  const bytes = randomBytes(1024 * 1024 + 77)
  await sender.publish({ id: 'imdb:tt0088763', title: 'Noise Encrypted Cast' }, Readable.from([bytes]))
  const [entry] = await sender.search('imdb:tt0088763')

  // Pair strictly via publicKey + token URI (zero host/port metadata!).
  const { token: pairToken } = parseReceiverUri(tv.info().pairingUri)
  const remoteUri = formatReceiverUri({
    publicKey: tv.publicKey,
    deviceId: tv.deviceId,
    name: 'Remote Mountain Apple TV',
    token: pairToken,
    p2p: true
  })
  const paired = await cast.pairReceiver({ uri: remoteUri })
  assert.equal(paired.host, '')
  assert.equal(paired.publicKey, tv.publicKey)

  const st = await cast.castPlay({ receiverId: paired.id, key: entry.key, preferMode: 'p2p' })
  assert.equal(st.session.transport, 'p2p', 'control plane runs over HyperDHT Noise SecretStream')
  assert.equal(st.session.state.mode, 'p2p', 'media plane runs over P2P Hyperblobs swarm')
  assert.ok(loadedUrl?.startsWith('http://127.0.0.1:'), 'remote TV streams from its own local P2P BlobServer')

  const streamed = await fetchRange(loadedUrl)
  assert.equal(streamed.body.length, bytes.length)
  assert.equal(streamed.sha256, sha256(bytes))

  await cast.castControl({ action: 'seek', positionMs: 42_000 })
  await waitFor(() => cast.status().session?.state?.positionMs === 42_000, 'Noise push state update after seek')
  tv.reportState({ idle: true, playing: false, buffering: false, ended: true, positionMs: 0 })
  assert.equal(tv.state().status, 'idle')
  assert.equal(tv.state().entry, null)
  await waitFor(() => cast.status().session?.state?.status === 'idle', 'Noise push sync after local TV stop')
  await cast.castStop({ stopPlayback: false })

  evidence.scenarios.noiseP2P = {
    publicKey: tv.publicKey,
    transport: 'p2p',
    verifiedBytes: streamed.body.length,
    verifiedSha256: streamed.sha256
  }
})

test('a native receiver reads ahead one bounded window, not to the end of the film, and streams exact bytes', { timeout: 240_000 }, async t => {
  const testnet = await createTestnet(3)
  const relay = await createNode({ storage: tmp('window-relay'), bootstrap: testnet.bootstrap })
  const receiverNode = await createNode({ storage: tmp('window-tv-node'), bootstrap: testnet.bootstrap })
  // 160 MiB "film" said to run 1280 s: 128 KiB/s, so 120 s of read-ahead is 15 MiB (30 MiB at the read-rate cap).
  const bytes = randomBytes(160 * 1024 * 1024)
  const durationMs = 1_280_000
  let loadCmd = null
  const tv = await createReceiver({
    storage: tmp('window-tv-cast'),
    name: 'Window TV',
    port: 0,
    lanHost: null,
    node: receiverNode,
    onCommand: async (cmd, ctx) => {
      if (cmd.action !== 'load') return
      loadCmd = cmd
      ctx.updateState({ status: 'playing', playing: true, buffering: false, positionMs: 0, durationMs })
    }
  })
  t.after(async () => {
    await tv.close()
    await receiverNode.close()
    await relay.close()
    await testnet.destroy()
  })

  await relay.publish({ id: 'imdb:tt0499549', title: 'Window Avatar' }, Readable.from([bytes]))
  const [entry] = await relay.search('imdb:tt0499549')
  await tv.command({ action: 'load', magnetUrl: entry.magnetUrl, entry: { key: entry.key, id: entry.id, title: entry.title, size: entry.size } })
  assert.match(loadCmd?.streamUrl || '', /^http:\/\/127\.0\.0\.1:\d+\/cast\/v1\/p2p\/[0-9a-f]{32}$/, 'the player gets the windowed route')

  // The player opens one `bytes=0-` stream (as oxideav-http does) and stops reading at 8 MiB for a while.
  const stops = [8 * 1024 * 1024]
  const chunks = []
  let read = 0
  let res = null
  let resume = null
  const done = new Promise((resolve, reject) => {
    const req = httpRequest(loadCmd.streamUrl, { headers: { range: 'bytes=0-' } }, r => {
      res = r
      r.on('data', chunk => {
        chunks.push(chunk)
        read += chunk.length
        if (resume === null && stops.length && read >= stops[0]) {
          stops.shift()
          r.pause()
          resume = () => { resume = null; r.resume() }
        }
      })
      r.once('end', () => resolve(r.statusCode))
      r.once('error', reject)
    })
    req.once('error', reject)
    req.end()
  })
  const cached = () => tv.peerStatus()?.cachedBytes || 0

  await waitFor(() => resume, 'player read its first 8 MiB', 120_000)
  let settled = 0
  await waitFor(async () => {
    const before = cached()
    await new Promise(resolve => setTimeout(resolve, 3000))
    settled = cached()
    return settled === before && settled > read
  }, 'read-ahead settled while the player paused', 120_000)
  const pausedAt = read
  const aheadOfPlayer = settled - pausedAt
  assert.ok(aheadOfPlayer >= 10 * 1024 * 1024, `read ahead of the player: ${aheadOfPlayer} bytes`)
  assert.ok(settled <= 48 * 1024 * 1024, `cache bounded to about one window, not the 160 MiB film: ${settled} bytes`)

  resume()
  assert.equal(await done, 206)
  const full = Buffer.concat(chunks)
  assert.equal(full.length, bytes.length)
  assert.equal(sha256(full), sha256(bytes), 'the windowed stream delivers the exact film')
  res.destroy()

  evidence.scenarios.boundedReadAhead = { filmBytes: bytes.length, playerPausedAt: pausedAt, cachedWhilePaused: settled, aheadOfPlayer, verifiedSha256: sha256(full) }
})

// Trimming only starts when the disk needs the space, so it needs a small disk: a 1 GiB macOS disk image.
test('a receiver on a 1 GiB disk plays a 1.2 GiB film: watched blocks are trimmed as it plays', { timeout: 420_000, skip: process.platform !== 'darwin' }, async t => {
  const image = join(tmp('lowdisk-image'), 'tv.dmg')
  execFileSync('hdiutil', ['create', '-size', '1g', '-fs', 'JHFS+', '-volname', 'pt-cast-lowdisk', image], { stdio: 'ignore' })
  const volume = execFileSync('hdiutil', ['attach', image, '-nobrowse'], { encoding: 'utf8' }).trim().split('\n').pop().split('\t').pop().trim()
  const freeOnVolume = () => { const s = statfsSync(volume); return Number(s.bavail) * Number(s.bsize) }
  const testnet = await createTestnet(3)
  const relay = await createNode({ storage: tmp('lowdisk-relay'), bootstrap: testnet.bootstrap })
  const receiverNode = await createNode({ storage: join(volume, 'node'), bootstrap: testnet.bootstrap })
  const size = 1200 * 1024 * 1024
  const chunks = []
  const hash = createHash('sha256')
  for (let i = 0; i < size / (8 << 20); i++) {
    const c = randomBytes(8 << 20)
    hash.update(c)
    chunks.push(c)
  }
  const want = hash.digest('hex')
  let loadCmd = null
  const tv = await createReceiver({
    storage: join(volume, 'cast'),
    name: 'Small Disk TV',
    port: 0,
    lanHost: null,
    node: receiverNode,
    onCommand: async (cmd, ctx) => {
      if (cmd.action !== 'load') return
      loadCmd = cmd
      // 8 MiB/s, a 4K remux's rate
      ctx.updateState({ status: 'playing', playing: true, buffering: false, positionMs: 0, durationMs: 150_000 })
    }
  })
  t.after(async () => {
    await tv.close()
    await receiverNode.close()
    await relay.close()
    await testnet.destroy()
    execFileSync('hdiutil', ['detach', volume, '-force'], { stdio: 'ignore' })
  })

  await relay.publish({ id: 'imdb:tt0499549', title: 'Small Disk Avatar' }, Readable.from(chunks))
  chunks.length = 0
  const [entry] = await relay.search('imdb:tt0499549')
  await tv.command({ action: 'load', magnetUrl: entry.magnetUrl, entry: { key: entry.key, id: entry.id, title: entry.title, size: entry.size } })

  // The player reads at 16 MB/s, twice the film's rate, so trimming has to keep up with it.
  let minFree = Infinity
  let maxCached = 0
  const sampler = setInterval(() => {
    minFree = Math.min(minFree, freeOnVolume())
    maxCached = Math.max(maxCached, tv.peerStatus()?.cachedBytes || 0)
  }, 250)
  const got = createHash('sha256')
  let read = 0
  const started = Date.now()
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(loadCmd.streamUrl, { headers: { range: 'bytes=0-' } }, r => {
      r.on('data', c => {
        got.update(c)
        read += c.length
        const early = (read / (16 << 20)) * 1000 - (Date.now() - started)
        if (early > 50) {
          r.pause()
          setTimeout(() => r.resume(), early)
        }
      })
      r.once('end', () => resolve(r.statusCode))
      r.once('error', reject)
    })
    req.once('error', reject)
    req.end()
  })
  clearInterval(sampler)

  assert.equal(status, 206)
  assert.equal(read, size)
  assert.equal(got.digest('hex'), want, 'the film comes out exact on a disk smaller than the film')
  assert.ok(minFree > 256 * 1024 * 1024, `free space stayed above the 256 MiB floor (lowest ${minFree})`)
  assert.ok(maxCached < 768 * 1024 * 1024, `watched blocks were trimmed as it played (most cached ${maxCached})`)

  evidence.scenarios.smallDiskTrim = { volumeBytes: 1024 * 1024 * 1024, filmBytes: size, lowestFreeBytes: minFree, mostCachedBytes: maxCached, seconds: Math.round((Date.now() - started) / 1000) }
})

test('private-routing cast initiator goes offline: TV receiver becomes a 2-hop private P2P peer, seeds privately, and fails closed on HTTP fallback', { timeout: 240_000 }, async t => {
  const testnet = await createTestnet(3)
  const bus = mdnsBus()
  const guards = []
  const privateNodes = []
  t.after(async () => {
    await Promise.all(privateNodes.map(n => n.close()))
    await Promise.all(guards.map(g => g.close()))
    await testnet.destroy()
  })

  // Only 2 stateless Guard forwarders are needed — zero tracker-member anchor nodes!
  for (let i = 0; i < 2; i++) {
    guards.push(await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap }))
  }
  const seeder = await createNode({ storage: tmp('priv-seeder'), bootstrap: testnet.bootstrap, privateRouting: true })
  privateNodes.push(seeder)
  const tracker = seeder.status().tracker
  const initiator = await createNode({ storage: tmp('priv-initiator'), bootstrap: testnet.bootstrap, tracker, privateRouting: true })
  privateNodes.push(initiator)

  // Start TV receiver with NO pre-configured private node (simulating an out-of-the-box TV on home Wi-Fi!).
  let tvLoadedUrl = null
  const tvMetaDir = tmp('priv-tv-meta')
  const tvExternalSsd = tmp('priv-tv-ssd')
  const tv = await createReceiver({
    storage: tvMetaDir,
    peerStorage: tvExternalSsd,
    name: 'Private Bedroom TV',
    port: 0,
    lanHost: '127.0.0.1',
    allowPeerNode: true,
    adapter: bus(),
    onCommand: async (cmd, ctx) => {
      if (cmd.action === 'load') {
        tvLoadedUrl = cmd.streamUrl
        ctx.updateState({ status: 'playing', playing: true, buffering: false, positionMs: 0, durationMs: 60_000 })
      }
    }
  })
  t.after(() => tv.close())
  assert.equal(tv.info().externalStorage, true, 'receiver adopts external SSD volume for P2P peer seed storage')
  assert.ok(tv.info().storageFreeBytes > 0)
  assert.equal(existsSync(join(tvMetaDir, 'receiver.json')), true, 'private pairing identity stays on internal storage')
  assert.equal(existsSync(join(tvExternalSsd, 'receiver.json')), false, 'private pairing tokens never touch removable SSD')

  const castDir = tmp('priv-initiator-cast')
  const cast = createCastController({
    storage: castDir,
    getNode: () => initiator,
    getLanHost: () => '127.0.0.1',
    adapter: bus()
  })
  await cast.setLanHost('127.0.0.1')
  t.after(() => cast.close())

  const bytes = randomBytes(1024 * 1024 + 55)
  await seeder.publish({ id: 'imdb:tt0100001', title: 'Private 2-Hop Cast' }, Readable.from([bytes]))
  const entry = await waitFor(async () => (await initiator.search('imdb:tt0100001'))[0], 'private initiator synced tracker', 90_000)

  const discoveredTv = await waitFor(() => cast.listReceivers().find(r => r.name === 'Private Bedroom TV'), 'discovered TV')
  await cast.pairReceiver({ id: discoveredTv.id, code: tv.info().pairCode })

  // Strict-private fail-closed check: if P2P watch setup fails while a raw httpStreamUrl is supplied
  // under privateRouting: true & lan: false (or preferMode: 'p2p'), receiver MUST reject rather than play cleartext HTTP!
  const savedReceivers = JSON.parse(readFileSync(join(castDir, 'cast-receivers.json'), 'utf8'))
  const pairedToken = (Array.isArray(savedReceivers) ? savedReceivers[0]?.token : Object.values(savedReceivers || {})[0]?.token) || ''
  assert.ok(pairedToken.length > 0, 'extracted paired bearer token from sender cast-receivers.json')
  const failOpenProbe = await fetch(`http://127.0.0.1:${tv.info().port}/cast/v1/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pairedToken}` },
    body: JSON.stringify({
      action: 'load',
      preferMode: 'p2p',
      httpStreamUrl: 'http://127.0.0.1:9/cleartext-origin-leak.mp4',
      magnetUrl: 'peartube://watch/bad_hex_pointer',
      network: { privateRouting: true, lan: false, bootstrap: testnet.bootstrap.map(b => `${b.host}:${b.port}`) }
    })
  })
  assert.notEqual(failOpenProbe.status, 401, 'fail-open probe passed bearer authentication')
  assert.notEqual(failOpenProbe.status, 200, 'strict-private Cast refuses to fail open to raw httpStreamUrl when P2P load fails')

  await cast.castPlay({ receiverId: discoveredTv.id, key: entry.key, preferMode: 'auto' })
  assert.equal(tv.state().mode, 'private-p2p', 'TV receiver matched initiator privateRouting and entered 2-hop private-p2p mode')
  // Shut down the cast initiator BEFORE the TV even starts reading the video!
  await cast.close()
  await initiator.close()

  // TV streams 100% of the video over 2-hop encrypted private circuits with ZERO public or LAN bytes!
  const tvStreamed = await fetchRange(tvLoadedUrl)
  assert.equal(tvStreamed.status, 200)
  assert.equal(tvStreamed.body.length, bytes.length)
  assert.equal(tvStreamed.sha256, sha256(bytes))

  const tvPeerSt = tv.peerStatus()
  assert.ok(tvPeerSt.routes.private.rxBytes >= bytes.length, 'TV received video bytes over 2-hop private circuits')
  assert.equal(tvPeerSt.routes.public.rxBytes, 0, 'zero public DHT bytes on private cast receiver')
  assert.equal(tvPeerSt.routes.lan.rxBytes, 0, 'zero cleartext LAN bytes when initiator had LAN off')

  // Now shut down the original seeder too — leaving ONLY the TV receiver seeding privately on the tracker!
  await waitFor(() => (tv.peerStatus()?.cachedBytes || 0) >= bytes.length, 'TV cached 100% of private blob', 60_000)
  await seeder.close()

  const latePrivateReader = await createNode({ storage: tmp('priv-late-reader'), bootstrap: testnet.bootstrap, tracker, privateRouting: true })
  privateNodes.push(latePrivateReader)
  const lateEntry = await waitFor(async () => (await latePrivateReader.search('imdb:tt0100001'))[0], 'late private reader synced tracker', 90_000)
  const fromTvPrivately = await fetchRange(lateEntry.streamUrl)
  assert.equal(fromTvPrivately.status, 200)
  assert.equal(fromTvPrivately.body.length, bytes.length)
  assert.equal(fromTvPrivately.sha256, sha256(bytes), 'late private peer streamed exact bytes privately from the TV receiver')
  assert.ok((tv.peerStatus()?.routes.private.txBytes || 0) >= bytes.length, 'TV receiver seeded full video over 2-hop private circuits')
  assert.equal(tv.peerStatus()?.routes.public.txBytes || 0, 0, 'TV receiver leaked zero public bytes while seeding privately')

  evidence.scenarios.privateP2PAutonomousSeeding = {
    mode: tv.state().mode,
    tvPrivateRxBytes: tv.peerStatus()?.routes.private.rxBytes,
    tvPrivateTxBytes: tv.peerStatus()?.routes.private.txBytes,
    publicBytes: (tv.peerStatus()?.routes.public.rxBytes || 0) + (tv.peerStatus()?.routes.public.txBytes || 0),
    verifiedSha256: fromTvPrivately.sha256
  }

  const outDir = join(process.cwd(), 'desktop/target/e2e')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'cast-result.json'), JSON.stringify(evidence, null, 2))
})
