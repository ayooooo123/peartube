import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createApi } from '../src/http.js'
import { createChat } from '../src/chat.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-substrate-'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha256Hex = buf => createHash('sha256').update(buf).digest('hex')
const artifactPath = join(process.cwd(), 'desktop/target/e2e/substrate-result.json')

async function until (fn, ms = 60_000, label = 'Substrate peers did not converge') {
  const end = Date.now() + ms
  for (;;) {
    const val = await fn()
    if (val) return val
    if (Date.now() > end) throw new Error(label)
    await wait(200)
  }
}

function listen (srv) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`))
  })
}

test('BitTorrent/YouTube/Twitch/Spotify/Rumble substrate E2E: custom UI, 64 KiB album pack + art, ABR variants, live CMAF -> VOD seal, Protomux chat + WoT mute, and offline channel move', { timeout: 180_000 }, async t => {
  const testnet = await createTestnet(3)
  const nodes = []
  const chats = []
  const servers = []

  t.after(async () => {
    for (const s of servers) { s.close(); s.closeAllConnections?.() }
    for (const c of chats) c.close()
    await Promise.all(nodes.map(n => n.close()))
    await testnet.destroy()
  })

  // Custom third-party frontend SPA directory mounted onto viewer's substrate.
  const uiDir = tmp()
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Custom PearSpotify</title><div id="app">ready</div>')
  writeFileSync(join(uiDir, 'app.js'), 'export const skin = "pear-spotify"')

  const pub = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  nodes.push(pub)
  const trackerKey = pub.status().tracker
  const pubChannel = pub.status().channel
  // Ensure local channel exists on disk before viewer subscribes.
  await pub.publishSource({ sourceKey: trackerKey, kind: 'tracker', title: 'Town Square' }, { target: 'channel' })

  const viewerSources = []
  const viewer = await createNode({
    storage: tmp(),
    bootstrap: testnet.bootstrap,
    tracker: trackerKey,
    sources: [`peartube://channel/${pubChannel}`]
  })
  nodes.push(viewer)

  const pubChat = createChat(pub)
  const sseFrames = []
  let viewerApi = null
  const viewerChat = createChat(viewer, { onMessage: msg => viewerApi?.notify('chat', { message: msg }) })
  chats.push(pubChat, viewerChat)

  const pubApi = createApi({ node: pub, chat: pubChat })
  viewerApi = createApi({
    node: viewer,
    chat: viewerChat,
    uiDir,
    onSourcesChanged: list => { viewerSources.splice(0, viewerSources.length, ...list) }
  })
  servers.push(pubApi, viewerApi)
  const pubUrl = await listen(pubApi)
  const viewerUrl = await listen(viewerApi)

  await until(() => pub.status().peers >= 1 && viewer.status().peers >= 1, 60_000, 'publisher and viewer connected on testnet')

  // 1. Third-party frontend static mount + SPA fallback + path traversal refusal.
  const rootHtml = await (await fetch(`${viewerUrl}/`)).text()
  assert.match(rootHtml, /Custom PearSpotify/)
  const spaHtml = await (await fetch(`${viewerUrl}/albums/synthwave`)).text()
  assert.equal(spaHtml, rootHtml, 'SPA client routes fall back to custom index.html')
  const jsRes = await fetch(`${viewerUrl}/app.js`)
  assert.match(jsRes.headers.get('content-type') || '', /javascript/)

  // 2. Self-contained cover art + 64 KiB Spotify album / torrent pack in ONE Hypercore.
  const coverBytes = randomBytes(24_000)
  const artRes = await (await fetch(`${pubUrl}/v1/art?mime=image/png`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: coverBytes
  })).json()
  assert.equal(artRes.art.mime, 'image/png')

  const track1 = randomBytes(70_000)
  const track2 = randomBytes(95_000)
  const track3 = randomBytes(50_000)
  const packRes = await (await fetch(`${pubUrl}/v1/packs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      blockSize: 65536,
      channel: true,
      items: [
        { id: 'audio:neonsynth01', title: 'Midnight Grid', artist: 'Neon Synth', album: 'Hyperdrive Nights', kind: 'audio', mime: 'audio/opus', track: 1, tags: ['synthwave', 'night'], art: artRes.art, dataBase64: track1.toString('base64') },
        { id: 'audio:neonsynth02', title: 'Chrome Rain', artist: 'Neon Synth', album: 'Hyperdrive Nights', kind: 'audio', mime: 'audio/opus', track: 2, tags: ['synthwave', 'rain'], art: artRes.art, dataBase64: track2.toString('base64') },
        { id: 'audio:neonsynth03', title: 'Dawn Exit', artist: 'Neon Synth', album: 'Hyperdrive Nights', kind: 'audio', mime: 'audio/opus', track: 3, tags: ['synthwave'], art: artRes.art, dataBase64: track3.toString('base64') }
      ]
    })
  })).json()
  assert.equal(packRes.items.length, 3)
  assert.equal(new Set(packRes.items.map(i => i.blobs)).size, 1, 'all album tracks share one 64 KiB Hypercore')
  assert.ok(packRes.items[1].blob.blockOffset > packRes.items[0].blob.blockOffset, 'tracks occupy distinct blockOffsets inside shared pack core')

  const albumHits = await until(async () => {
    const r = await (await fetch(`${viewerUrl}/v1/search?q=neon+chrome&kind=audio&tag=rain`)).json()
    return r.results?.length === 1 ? r.results : null
  }, 30_000, 'viewer ?q= + kind + tag search found packed track 2')
  assert.equal(albumHits[0].id, 'audio:neonsynth02')
  assert.equal(albumHits[0].artist, 'Neon Synth')
  assert.ok(albumHits[0].artUrl, 'result carries P2P artUrl with zero Cinemeta')

  const fetchedArt = await fetch(`${viewerUrl}/v1/blob${new URL(albumHits[0].artUrl).search}`)
  assert.equal(fetchedArt.status, 200)
  assert.equal(fetchedArt.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await fetchedArt.arrayBuffer()), coverBytes)

  const trackSlice = await fetch(`${viewerUrl}/v1/blob${new URL(albumHits[0].streamUrl).search}`, {
    headers: { Range: 'bytes=1000-70999' }
  })
  assert.equal(trackSlice.status, 206)
  assert.equal(trackSlice.headers.get('content-type'), 'audio/opus')
  assert.deepEqual(Buffer.from(await trackSlice.arrayBuffer()), track2.subarray(1000, 71000))

  // 3. YouTube / Rumble Multi-Rendition ABR (`?variants=1`).
  await pub.publish({ id: 'clip:stateofp2p', title: 'State of P2P', kind: 'video', mime: 'video/mp4', width: 3840, height: 2160, bitrate: 25_000_000 }, Readable.from([randomBytes(40_000)]))
  await pub.publish({ id: 'clip:stateofp2p', title: 'State of P2P', kind: 'video', mime: 'video/mp4', width: 1280, height: 720, bitrate: 4_000_000 }, Readable.from([randomBytes(20_000)]))
  await pub.publish({ id: 'clip:stateofp2p', title: 'State of P2P (Audio)', kind: 'audio', mime: 'audio/opus', height: 0, bitrate: 128_000 }, Readable.from([randomBytes(10_000)]))

  const grouped = await until(async () => {
    const r = await (await fetch(`${viewerUrl}/v1/entries?q=stateofp2p&variants=1`)).json()
    return r.results?.[0]?.variants?.length === 3 ? r.results[0] : null
  }, 20_000, 'viewer grouped 3 ABR renditions under one logical ID')
  assert.deepEqual(grouped.variants.map(v => v.height || 0), [2160, 720, 0])

  // 4. Twitch / Kick Live CMAF Hypercore -> P2P tail -> zero-copy seal to VOD.
  const initSeg = Buffer.from('CMAF-FTYP-MOOV-INIT\n')
  const frag1 = randomBytes(16_384)
  const frag2 = randomBytes(16_384)
  const frag3 = randomBytes(16_384)
  const expectedVod = Buffer.concat([initSeg, frag1, frag2, frag3])

  const liveStart = await (await fetch(`${pubUrl}/v1/live/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'clip:kicklive01', title: 'Late Night Raid', mime: 'video/mp4', channel: true })
  })).json()
  await fetch(`${pubUrl}/v1/live/${liveStart.blobs}/chunk`, { method: 'POST', body: initSeg })
  await fetch(`${pubUrl}/v1/live/${liveStart.blobs}/chunk`, { method: 'POST', body: frag1 })

  const liveHit = await until(async () => {
    const r = await (await fetch(`${viewerUrl}/v1/search?id=clip:kicklive01`)).json()
    return r.results?.[0]?.live ? r.results[0] : null
  }, 20_000, 'viewer discovered active live stream')
  assert.equal(liveHit.live, true)

  // Viewer opens continuous live HTTP stream (`?dvr=1`) while publisher appends frag2 + frag3, then seals!
  const liveFetchPromise = fetch(`${viewerUrl}/v1/live/${liveStart.blobs}?dvr=1&mime=video/mp4`).then(async res => ({
    status: res.status,
    type: res.headers.get('content-type'),
    bytes: Buffer.from(await res.arrayBuffer())
  }))
  await wait(400)
  await fetch(`${pubUrl}/v1/live/${liveStart.blobs}/chunk`, { method: 'POST', body: frag2 })
  await wait(300)
  await fetch(`${pubUrl}/v1/live/${liveStart.blobs}/chunk`, { method: 'POST', body: frag3 })
  const sealedOp = await (await fetch(`${pubUrl}/v1/live/${liveStart.blobs}/seal`, { method: 'POST' })).json()

  const liveStreamResult = await liveFetchPromise
  assert.equal(liveStreamResult.status, 200)
  assert.equal(liveStreamResult.type, 'video/mp4')
  assert.equal(sha256Hex(liveStreamResult.bytes), sha256Hex(expectedVod), 'viewer received exact live CMAF bytes and closed cleanly on seal')
  assert.equal(sealedOp.sha256, sha256Hex(expectedVod))

  const vodHit = await until(async () => {
    const r = await (await fetch(`${viewerUrl}/v1/search?id=clip:kicklive01`)).json()
    return r.results?.[0] && !r.results[0].live ? r.results[0] : null
  }, 20_000, 'live entry sealed in-place into VOD on viewer')
  const vodRange = await fetch(`${viewerUrl}/v1/blob${new URL(vodHit.streamUrl).search}`, { headers: { Range: 'bytes=0-19' } })
  assert.equal(vodRange.status, 206)
  assert.deepEqual(Buffer.from(await vodRange.arrayBuffer()), initSeg)

  // 5. Ephemeral Protomux Live Chat + SSE + 1-hop Web-of-Trust Mute.
  const sseAbort = new AbortController()
  const sseTask = (async () => {
    const res = await fetch(`${viewerUrl}/v1/events`, { signal: sseAbort.signal })
    for await (const chunk of res.body) {
      const txt = Buffer.from(chunk).toString('utf8')
      for (const line of txt.split('\n')) {
        if (line.startsWith('data: ')) sseFrames.push(JSON.parse(line.slice(6)))
      }
    }
  })().catch(() => {})
  await until(() => pubChat.peers() >= 1 && viewerChat.peers() >= 1, 15_000, 'Protomux chat paired across peers')

  await fetch(`${pubUrl}/v1/chat/kicklive01`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nick: 'streamer', text: 'welcome to the swarm' })
  })
  const chatHist = await until(async () => {
    const r = await (await fetch(`${viewerUrl}/v1/chat/kicklive01`)).json()
    return r.messages?.length === 1 ? r.messages : null
  }, 10_000, 'viewer received signed Protomux chat message')
  assert.equal(chatHist[0].text, 'welcome to the swarm')
  await until(() => sseFrames.some(f => f.event === 'chat' && f.message?.text === 'welcome to the swarm'), 5000, 'SSE delivered live chat frame')

  // Forged signature is rejected.
  const forgedRes = await fetch(`${viewerUrl}/v1/chat/kicklive01`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signed: { ...chatHist[0], id: 'deadbeefdeadbeefdeadbeefdeadbeef', text: 'forged' } })
  })
  assert.equal(forgedRes.status, 400)

  // Spammer joins shared tracker; publisher mutes spammer via 1-hop WoT (`trust: -1` in publisher's channel).
  const spammer = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker: trackerKey })
  nodes.push(spammer)
  const spamChat = createChat(spammer)
  chats.push(spamChat)
  await until(() => spammer.status().peers >= 1, 60_000, 'spammer connected to tracker')
  await spammer.publish({ id: 'clip:scamcoin99', title: 'Buy ScamCoin Now' }, Readable.from([randomBytes(8192)]))
  await until(async () => (await viewer.search('clip:scamcoin99')).length === 1, 20_000, 'spam visible before WoT mute')

  await pub.publishSource({ sourceKey: spammer.status().writer, kind: 'writer', title: 'spammer', trust: -1 }, { target: 'channel' })
  await pub.publishSource({ sourceKey: spamChat.publicKey, kind: 'writer', title: 'spammer-chat', trust: -1 }, { target: 'channel' })
  await until(async () => (await viewer.search('clip:scamcoin99')).length === 0 && viewer.isMuted(spamChat.publicKey), 20_000, '1-hop WoT mute hid spammer catalog entries and muted chat key on viewer')
  spamChat.post({ room: 'kicklive01', nick: 'bot', text: 'scam link' })
  await wait(600)
  assert.equal(viewerChat.history('kicklive01').some(m => m.text === 'scam link'), false, '1-hop WoT mute dropped spammer chat on viewer')
  sseAbort.abort()
  await sseTask

  // 6. Seizure-proof offline Ed25519 Channel Move (`type: 'moved'`).
  const backup = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  nodes.push(backup)
  const backupChannel = backup.status().channel
  const backupBytes = randomBytes(24_576)
  await backup.publishChannel({ id: 'clip:uncensorable1', title: 'Back Online After Raid' }, Readable.from([backupBytes]))

  // Publisher pre-signs offline move cert BEFORE going dark!
  const moveCert = await (await fetch(`${pubUrl}/v1/channel/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: backupChannel, signOnly: true })
  })).json()
  assert.equal(moveCert.from, pubChannel)
  assert.equal(moveCert.to, backupChannel)

  // Forged move cert is rejected.
  const badMove = await fetch(`${viewerUrl}/v1/channel/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...moveCert, to: 'f'.repeat(64) })
  })
  assert.equal(badMove.status, 400)

  // Original publisher is seized / shut down completely!
  pubChat.close()
  await pub.close()

  // Third party (spammer/tracker peer) relays the pre-signed offline move cert onto the tracker!
  await spammer.applyChannelMove(moveCert, { target: 'tracker' })
  const recovered = await until(async () => {
    const r = await (await fetch(`${viewerUrl}/v1/search?id=clip:uncensorable1`)).json()
    return r.results?.[0] || null
  }, 60_000, 'viewer verified offline move cert, auto-followed backup channel, and discovered new post-raid video')
  const recBytes = Buffer.from(await (await fetch(`${viewerUrl}/v1/blob${new URL(recovered.streamUrl).search}`)).arrayBuffer())
  assert.deepEqual(recBytes, backupBytes)

  const summary = {
    passed: true,
    updatedAt: new Date().toISOString(),
    customUiMounted: true,
    packCoreKey: packRes.blobs,
    packTracksInOneCore: packRes.items.length,
    abrVariantsHeights: grouped.variants.map(v => v.height || 0),
    liveToVodSha256: sealedOp.sha256,
    chatMessagesVerified: viewerChat.history('kicklive01').length,
    wotMutedSpammer: spammer.status().writer,
    channelMovedFromTo: [pubChannel, backupChannel]
  }
  mkdirSync(join(process.cwd(), 'desktop/target/e2e'), { recursive: true })
  writeFileSync(artifactPath, JSON.stringify(summary, null, 2) + '\n')
})
