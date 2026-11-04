// End to end through the Mac app's P2P stack: a relay publishes a file; the
// app's Bare worklet, driven from Rust by desktop/examples/smoke.rs exactly as
// the UI drives it, joins the tracker, finds the entry and streams it back.
// Once connected, the relay publishes a second entry under the same id and then
// removes it; the app must see both changes through update events alone, as
// the UI does. The first test meets over a local testnet DHT and also plays
// the entry through the app's player (peartube-media), over the worklet's
// stream: every frame and every audio sample must equal FFmpeg's decode of the
// file. The second test meets over LAN discovery alone. Needs cargo, ffmpeg
// and `sh worklet/bare-kit.sh darwin`. Leaves its evidence in desktop/target/e2e/.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createLan, lanAddress } from '../src/lan.js'
import { createPrivateGuard } from '../src/private-overlay.js'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const tmp = name => mkdtempSync(join(tmpdir(), `peartube-${name}-`))

test('the app worklet streams a relay entry and follows the tracker live', async t => {
  const testnet = await createTestnet(3)
  const relay = await createNode({ storage: tmp('relay'), bootstrap: testnet.bootstrap })
  t.after(async () => { await relay.close(); await testnet.destroy() })
  // Any peer can announce a title that is not well-formed UTF-16 (here a lone
  // surrogate); the app must still list the tracker. It goes first, so it has
  // synced by the time the app sees the real entry.
  const hostile = await relay.put({ id: 'imdb:tt0000666' }, Readable.from([randomBytes(10)]))
  await relay.append({ ...hostile, title: 'Hostile \ud83d' })
  const bytes = media(tmp('media'))
  const published = await relay.publish({ id: 'imdb:tt0111161', title: 'Desktop E2E' }, Readable.from([bytes]))

  // By name, so the worklet resolves each bootstrap node through udx-native's
  // DNS lookup, as it does for the public DHT whenever the nodes' listed IPs
  // do not answer. On QuickJS that lookup once freed its own request mid-call.
  const bootstrap = testnet.bootstrap.map(node => `localhost:${node.port}`)
  const { stages, secondKey } = await drive(t, relay, published, { bootstrap }, { PEARTUBE_PLAY: '1' })
  verify(stages, relay, published, bytes, secondKey)
  verifyPlayed(stages.streamed.played, bytes)
  assert.deepEqual(stages.streamed.titles.toSorted(), ['Desktop E2E', 'Hostile \ufffd'], 'the whole tracker lists, the bad title repaired')
  save('result.json', { test: 'app worklet streams a relay entry and follows the tracker live', published, relay, stages })
})

// Where the public DHT cannot connect two peers (two randomized NATs, as on a
// phone's home Wi-Fi), the app finds relays on the network over mDNS. Here no
// DHT is reachable at all: both sides bootstrap to a dead address, so every
// byte must come over LAN discovery. The worklet picks this machine's Wi-Fi or
// Ethernet address itself; the relay listens on the same address, as
// PEARTUBE_LAN_HOST would make it, over ephemeral UDP ports advertised in mDNS.
test('the app worklet finds a relay on the LAN and streams from it', async t => {
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
  assert.equal(stages.streamed.lan, `on ${host}`, 'the status line names the address LAN discovery uses')
  assert.ok(stages.streamed.relay.routes.lan.txBytes >= bytes.length, 'the file traveled over LAN')
  assert.equal(stages.streamed.relay.routes.public.txBytes + stages.streamed.relay.routes.private.txBytes, 0, 'no DHT stream carried it')
  save('lan-result.json', { test: 'app worklet finds a relay on the LAN and streams from it', host, published, relay, stages })
})

test('the app worklet streams and decodes over 2-hop stateless guards in privateRouting mode', async t => {
  const testnet = await createTestnet(4)
  const guards = [
    await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap }),
    await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  ]
  const relay = await createNode({ storage: tmp('priv-relay'), bootstrap: testnet.bootstrap, privateRouting: true })
  t.after(async () => {
    await relay.close()
    await Promise.all(guards.map(g => g.close()))
    await testnet.destroy()
  })
  const bytes = media(tmp('priv-media'))
  const published = await relay.publish({ id: 'imdb:tt0133093', title: 'Private QuickJS E2E' }, Readable.from([bytes]))

  const bootstrap = testnet.bootstrap.map(node => `127.0.0.1:${node.port}`)
  const { stages, secondKey } = await drive(t, relay, published, { bootstrap, lanDiscovery: true, privateRouting: true }, { PEARTUBE_PLAY: '1' })
  verify(stages, relay, published, bytes, secondKey)
  verifyPlayed(stages.streamed.played, bytes)
  assert.ok(stages.streamed.relay.routes.private.txBytes >= bytes.length, 'bytes left seeder over 2-hop private guard circuits')
  assert.equal(stages.streamed.relay.routes.public.txBytes, 0, 'zero public DHT bytes')
  assert.equal(stages.streamed.relay.routes.lan.txBytes, 0, 'LAN discovery suppressed in privateRouting mode even when settings.lanDiscovery is true')
  save('private-result.json', { test: 'app worklet streams and decodes over 2-hop stateless guards in privateRouting mode', published, relay, stages })
})

test('the QuickJS app worklet links via 12-word recovery phrase and decodes an epoch-encrypted video frame-exact', async t => {
  const testnet = await createTestnet(3)
  const relay = await createNode({ storage: tmp('mnemonic-relay'), bootstrap: testnet.bootstrap })
  t.after(async () => { await relay.close(); await testnet.destroy() })
  const { mnemonic } = await relay.identity({ revealMnemonic: true })
  const bytes = media(tmp('enc-media'))
  const published = await relay.publish({ id: 'imdb:tt0816692', title: 'Encrypted QuickJS E2E', private: true }, Readable.from([bytes]))
  assert.equal(published.epoch, 1)
  assert.equal(published.wrappedKey.length, 144)

  const bootstrap = testnet.bootstrap.map(node => `localhost:${node.port}`)
  const storage = tmp('mnemonic-app')
  writeFileSync(join(storage, 'settings.json'), JSON.stringify({ mnemonic, bootstrap }))
  const cargo = ['run', '--quiet', '--manifest-path', 'desktop/Cargo.toml', '--example', 'smoke', '--', published.id]
  const smoke = spawn('cargo', cargo, { env: { ...process.env, PEARTUBE_PLAY: '1', PEARTUBE_STORAGE: storage }, stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => smoke.kill())

  let streamed = null
  for await (const line of createInterface({ input: smoke.stdout })) {
    const stage = JSON.parse(line)
    if (stage.stage === 'streamed') {
      streamed = stage
      smoke.kill()
      break
    }
  }
  assert.ok(streamed, 'QuickJS worklet linked via 12-word phrase and streamed encrypted entry')
  assert.equal(streamed.channel, relay.status().channel, '12-word phrase resolved exact Channel key in QuickJS')
  assert.notEqual(streamed.writer, relay.status().writer, 'QuickJS device uses distinct fork-proof writer core')
  assert.equal(streamed.mnemonicWords, 12, 'QuickJS worklet persisted 12-word phrase')
  assert.equal(streamed.fullSha256, sha256(bytes), 'QuickJS worklet decrypted exact bytes')
  verifyPlayed(streamed.played, bytes)
  save('mnemonic-encrypted-result.json', { test: 'QuickJS 12-word recovery + epoch-encrypted decode', published, relay, stages: { streamed } })
})

// Runs the app's P2P stack against relay with these settings. When the app has
// streamed the entry, the relay publishes a second one under the same id; when
// the app lists that, the relay removes it. Returns every stage the app reported.
async function drive (t, relay, published, settings, env = {}) {
  const storage = tmp('app')
  writeFileSync(join(storage, 'settings.json'), JSON.stringify({ tracker: relay.status().tracker, ...settings }))
  const cargo = ['run', '--quiet', '--manifest-path', 'desktop/Cargo.toml', '--example', 'smoke', '--', published.id]
  const smoke = spawn('cargo', cargo, { env: { ...process.env, ...env, PEARTUBE_STORAGE: storage }, stdio: ['ignore', 'pipe', 'inherit'] })
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
  assert.equal(app.manifestId, 'org.peartube.p2p', 'the QuickJS worklet serves the loopback Stremio manifest')
  assert.ok(app.entry.magnetUrl.startsWith('peartube://watch/'), 'every entry carries a zero-subscription magnet URI')
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

// 8 s of H.264 (x264, 640x360) and FLAC in Matroska: a common video codec and
// a lossless audio one, so the player's output can be compared exactly.
function media (dir) {
  const file = join(dir, 'e2e.mkv')
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '8', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'flac', '-y', file])
  return readFileSync(file)
}

function verifyPlayed (played, bytes) {
  assert.ok(played, 'the app played the entry')
  assert.equal(played.error, null, `playback error: ${played.error}`)
  assert.equal(played.ended, true, 'playback reached the end')
  const file = join(tmp('reference'), 'e2e.mkv')
  writeFileSync(file, bytes)
  const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', '-i', file, ...args], { maxBuffer: 1 << 30 })
  const frames = ffmpeg(['-map', '0:v:0', '-fps_mode', 'passthrough', '-pix_fmt', 'yuv420p', '-f', 'framemd5', '-']).toString()
    .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim())
  assert.equal(played.video.codec, 'h264')
  assert.equal(played.video.frameMd5.length, frames.length, 'every frame reached the video sink')
  assert.deepEqual(played.video.frameMd5, frames, 'every frame equals FFmpeg\'s')
  const pcm = ffmpeg(['-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'f32le', '-'])
  assert.equal(played.audio.samples, pcm.length / 4, 'every audio sample reached the audio sink')
  assert.equal(played.audio.pcmSha256, sha256(pcm), 'the audio equals FFmpeg\'s')
}

function save (file, { test, host, published, relay, stages }) {
  const dir = join('desktop', 'target', 'e2e')
  mkdirSync(dir, { recursive: true })
  const result = { test, at: new Date().toISOString(), host, published: { id: published.id, size: published.size, sha256: published.sha256 }, relay: relay.status(), stages }
  writeFileSync(join(dir, file), JSON.stringify(result, null, 2) + '\n')
}
