import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import Corestore from 'corestore'

import {
  decodeControlBlock,
  isMediaFragmentBlock,
  parseInitSegmentTimescale,
  parseFragmentDecodeTime,
  encodeStreamDescriptor,
  encodeEndOfStream,
  DESCRIPTOR_BLOCK,
  INIT_SEGMENT_BLOCK,
  FIRST_MEDIA_BLOCK,
} from '../src/live/live-core-format.js'
import { LiveBroadcastService } from '../src/live/live-broadcast-service.js'
import { LivePlaybackService } from '../src/live/live-playback-service.js'
import { createLiveApi } from '../src/api/live.js'
import { createBackendLifecycle } from '../src/storage.js'
import { buildTestFmp4Init, buildTestFmp4Fragment } from './helpers/build-test-mp4.mjs'

function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-live-test-'))
  const store = new Corestore(dir)
  t.teardown(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }))
      res.on('error', reject)
    }).on('error', reject)
  })
}

/**
 * Drive a broadcast session with a synthetic fMP4 stream.
 *
 * Note: the segmenter flushes a fragment only when the NEXT moof arrives (a
 * fragment is complete once its successor begins) or on finish(), so a live
 * session that has been fed N fragments exposes N-1 segments until sealed.
 */
function feedTestStream(session, { fragments = 3, timescale = 1000, fragmentUnits = 1000 } = {}) {
  const init = buildTestFmp4Init({ timescale })
  session.write(init)
  for (let i = 0; i < fragments; i++) {
    session.notifyKeyframe(i * fragmentUnits, { numerator: 1, denominator: timescale })
    const fragment = buildTestFmp4Fragment({ sequence: i + 1, decodeTime: i * fragmentUnits })
    // Split mid-fragment to exercise the segmenter's box buffering.
    const splitAt = Math.min(13, fragment.length)
    session.write(fragment.subarray(0, splitAt))
    session.write(fragment.subarray(splitAt))
  }
}

test('live core format helpers round-trip control blocks and parse media boxes', (t) => {
  const descriptor = decodeControlBlock(encodeStreamDescriptor({ videoId: 'vid1', title: 'hello', targetFragmentDuration: 2 }))
  t.is(descriptor.type, 'descriptor')
  t.is(descriptor.videoId, 'vid1')
  t.is(descriptor.targetFragmentDuration, 2)

  const eos = decodeControlBlock(encodeEndOfStream({ mediaBlocks: 7 }))
  t.is(eos.type, 'eos')
  t.is(eos.mediaBlocks, 7)

  t.is(decodeControlBlock(Buffer.from('{"random":"json"}')), null, 'foreign JSON rejected')
  t.is(decodeControlBlock(buildTestFmp4Fragment({})), null, 'media block is not a control block')

  const fragment = buildTestFmp4Fragment({ decodeTime: 1234 })
  t.ok(isMediaFragmentBlock(fragment))
  t.absent(isMediaFragmentBlock(encodeEndOfStream({ mediaBlocks: 1 })))
  t.absent(isMediaFragmentBlock(buildTestFmp4Init({})), 'init segment is not a media fragment')
  t.is(parseFragmentDecodeTime(fragment), 1234)
  t.is(parseInitSegmentTimescale(buildTestFmp4Init({ timescale: 90000 })), 90000)
})

test('broadcast session writes the live core block layout', async (t) => {
  const store = makeStore(t)
  const service = new LiveBroadcastService({ ctx: { store, swarm: null } })

  const session = await service.startBroadcast({ title: 'first stream', targetFragmentDuration: 1 })
  t.is(session.state, 'live')
  t.ok(/^[0-9a-f]{64}$/.test(session.liveCoreKey))

  feedTestStream(session)
  const stats = await session.stop()

  t.is(stats.state, 'finished')
  t.is(stats.mediaBlocks, 3)
  t.is(stats.durationS, 3, 'PTS-derived durations: 1s per fragment')

  const core = session.core
  // descriptor + init + 3 fragments + eos
  t.is(core.length, FIRST_MEDIA_BLOCK + 3 + 1)

  const descriptor = decodeControlBlock(await core.get(DESCRIPTOR_BLOCK))
  t.is(descriptor.type, 'descriptor')
  t.is(descriptor.title, 'first stream')
  t.is(descriptor.videoId, session.videoId)

  const init = await core.get(INIT_SEGMENT_BLOCK)
  t.is(init.toString('latin1', 4, 8), 'ftyp', 'block 1 is the init segment')

  for (let i = 0; i < 3; i++) {
    const block = await core.get(FIRST_MEDIA_BLOCK + i)
    t.ok(isMediaFragmentBlock(block), `block ${FIRST_MEDIA_BLOCK + i} is a media fragment`)
    t.is(parseFragmentDecodeTime(block), i * 1000)
  }

  const eos = decodeControlBlock(await core.get(core.length - 1))
  t.is(eos.type, 'eos')
  t.is(eos.mediaBlocks, 3)
})

test('a live core refuses to resume a non-fresh core', async (t) => {
  const store = makeStore(t)
  const service = new LiveBroadcastService({ ctx: { store, swarm: null } })
  const session = await service.startBroadcast({})
  feedTestStream(session, { fragments: 1 })
  await session.stop()

  const { LiveCoreWriter } = await import('../src/live/live-core-writer.js')
  const writer = new LiveCoreWriter(session.core, { videoId: 'other' })
  await t.exception(() => writer.open(), /not fresh/)
})

test('playback service serves live HLS from the core and seals to VOD', async (t) => {
  const store = makeStore(t)
  const ctx = { store, swarm: null }
  const broadcast = new LiveBroadcastService({ ctx })
  const playback = new LivePlaybackService({ ctx })
  t.teardown(() => playback.close())

  const session = await broadcast.startBroadcast({ targetFragmentDuration: 1 })
  feedTestStream(session)
  await session.writer.flush()

  const url = await playback.getPlaybackUrl(session.liveCoreKey)
  t.ok(url.endsWith('/playlist.m3u8'))

  // Live playlist: fragments 0-1 are flushed, fragment 2 is still open at
  // the live edge; no ENDLIST.
  const live = await httpGet(url)
  t.is(live.status, 200)
  const livePlaylist = live.body.toString()
  t.ok(livePlaylist.startsWith('#EXTM3U'), 'valid playlist header')
  t.ok(livePlaylist.includes('#EXT-X-MAP:URI="init.mp4"'), 'init map present')
  t.ok(livePlaylist.includes('#EXT-X-MEDIA-SEQUENCE:0'))
  t.ok(livePlaylist.includes('seg-0.m4s'))
  t.ok(livePlaylist.includes('seg-1.m4s'))
  t.absent(livePlaylist.includes('seg-2.m4s'), 'open fragment not yet flushed to the core')
  t.absent(livePlaylist.includes('#EXT-X-ENDLIST'), 'stream is still live')
  t.ok(livePlaylist.includes('#EXTINF:1.000,'), 'tfdt-derived segment duration')

  // Init segment and a media segment over HTTP.
  const base = url.slice(0, url.lastIndexOf('/') + 1)
  const init = await httpGet(base + 'init.mp4')
  t.is(init.status, 200)
  t.is(init.body.toString('latin1', 4, 8), 'ftyp')

  const seg = await httpGet(base + 'seg-1.m4s')
  t.is(seg.status, 200)
  t.ok(isMediaFragmentBlock(seg.body))
  t.is(parseFragmentDecodeTime(seg.body), 1000)

  // Seal the stream: the trailing fragment flushes and the playlist becomes
  // a finite VOD with full DVR.
  await session.stop()
  const sealed = await httpGet(url)
  const sealedPlaylist = sealed.body.toString()
  t.ok(sealedPlaylist.includes('#EXT-X-ENDLIST'), 'sealed stream has ENDLIST')
  t.ok(sealedPlaylist.includes('#EXT-X-PLAYLIST-TYPE:VOD'))
  t.ok(sealedPlaylist.includes('seg-2.m4s'), 'trailing fragment flushed by seal')
  t.ok(sealedPlaylist.includes('#EXT-X-MEDIA-SEQUENCE:0'), 'full recording exposed from the start')

  // The EOS control block is never served as media.
  const eosSeg = await httpGet(base + 'seg-3.m4s')
  t.is(eosSeg.status, 404, 'eos marker is not a media segment')
})

test('a viewer serves live HLS from a replicated core it did not write', async (t) => {
  const broadcasterStore = makeStore(t)
  const viewerStore = makeStore(t)

  // Wire the two stores together the way hyperswarm would.
  const a = broadcasterStore.replicate(true)
  const b = viewerStore.replicate(false)
  a.pipe(b).pipe(a)
  t.teardown(() => {
    try { a.destroy() } catch { /* best effort */ }
    try { b.destroy() } catch { /* best effort */ }
  })

  const broadcast = new LiveBroadcastService({ ctx: { store: broadcasterStore, swarm: null } })
  const session = await broadcast.startBroadcast({ targetFragmentDuration: 1 })
  feedTestStream(session)
  await session.writer.flush()

  const playback = new LivePlaybackService({ ctx: { store: viewerStore, swarm: null } })
  t.teardown(() => playback.close())

  const url = await playback.getPlaybackUrl(session.liveCoreKey)
  const live = await httpGet(url)
  t.is(live.status, 200)
  const playlist = live.body.toString()
  t.ok(playlist.includes('seg-0.m4s'), 'viewer playlist lists replicated segments')
  t.absent(playlist.includes('#EXT-X-ENDLIST'), 'still live from the viewer side')

  // Segment bytes arrive over replication on demand.
  const base = url.slice(0, url.lastIndexOf('/') + 1)
  const seg = await httpGet(base + 'seg-1.m4s')
  t.is(seg.status, 200)
  t.ok(isMediaFragmentBlock(seg.body))
  t.is(parseFragmentDecodeTime(seg.body), 1000)

  const init = await httpGet(base + 'init.mp4')
  t.is(init.body.toString('latin1', 4, 8), 'ftyp', 'init segment replicated')

  await session.stop()
})

test('playback service slides the live window and ignores unknown routes', async (t) => {
  const store = makeStore(t)
  const ctx = { store, swarm: null }
  const broadcast = new LiveBroadcastService({ ctx })
  const playback = new LivePlaybackService({ ctx, liveWindowSegments: 2 })
  t.teardown(() => playback.close())

  const session = await broadcast.startBroadcast({ targetFragmentDuration: 1 })
  feedTestStream(session, { fragments: 5 })
  await session.writer.flush()

  const url = await playback.getPlaybackUrl(session.liveCoreKey)
  const res = await httpGet(url)
  const playlist = res.body.toString()

  // 5 fragments fed → 4 flushed (seg-0..3); window of 2 → seg-2, seg-3.
  t.ok(playlist.includes('#EXT-X-MEDIA-SEQUENCE:2'), 'window starts at the live edge minus window size')
  t.absent(playlist.includes('seg-1.m4s'), 'old segments outside the window')
  t.ok(playlist.includes('seg-2.m4s'))
  t.ok(playlist.includes('seg-3.m4s'))

  const base = url.slice(0, url.lastIndexOf('/') + 1)
  t.is((await httpGet(base + 'nonsense.txt')).status, 404)
  t.is((await httpGet(`http://127.0.0.1:${playback.port}/other/path`)).status, 404)

  await session.stop()
})

test('lazy live services are owned immediately and broadcast resources close on shutdown', async (t) => {
  const lifecycle = createBackendLifecycle()
  const ownedLabels = []
  let coreCloseCalls = 0
  let discoveryDestroyCalls = 0
  const core = {
    key: Buffer.alloc(32, 7),
    discoveryKey: Buffer.alloc(32, 8),
    length: 0,
    peers: [],
    async ready() {},
    async append() {
      this.length += 1
    },
    async close() {
      coreCloseCalls += 1
    },
  }
  const ctx = {
    lifecycle,
    store: { get: () => core },
    swarm: {
      join() {
        return {
          async destroy() {
            discoveryDestroyCalls += 1
          },
        }
      },
    },
    ownResource(label, resource, methods, timeoutMs) {
      ownedLabels.push(label)
      return lifecycle.ownResource(label, resource, methods, timeoutMs)
    },
  }
  const api = createLiveApi({ ctx })
  const started = await api.startLivestream()
  t.is(started.success, true)
  await api.prepareLivePlayback('invalid')

  t.ok(ownedLabels.includes('live broadcast service'))
  t.ok(ownedLabels.includes('live playback service'))
  await lifecycle.shutdown()
  t.is(coreCloseCalls, 1)
  t.is(discoveryDestroyCalls, 1)
})

test('broadcast core closes when shutdown interrupts readiness', async (t) => {
  const lifecycle = createBackendLifecycle()
  let releaseReady = null
  const readyGate = new Promise((resolve) => {
    releaseReady = resolve
  })
  let closeCalls = 0
  const core = {
    key: Buffer.alloc(32, 9),
    discoveryKey: Buffer.alloc(32, 10),
    length: 0,
    ready: () => readyGate,
    async append() {},
    async close() {
      closeCalls += 1
    },
  }
  const ctx = {
    lifecycle,
    store: { get: () => core },
    swarm: null,
    ownResource(label, resource, methods, timeoutMs) {
      return lifecycle.ownResource(label, resource, methods, timeoutMs)
    },
  }
  const api = createLiveApi({ ctx })
  const started = api.startLivestream()
  await new Promise((resolve) => setImmediate(resolve))
  await lifecycle.shutdown()
  t.is(closeCalls, 1)
  releaseReady()
  t.is((await started).success, false)
})

test('playback core closes when shutdown interrupts readiness', async (t) => {
  const lifecycle = createBackendLifecycle()
  let releaseReady = null
  const readyGate = new Promise((resolve) => {
    releaseReady = resolve
  })
  let closeCalls = 0
  const core = {
    discoveryKey: Buffer.alloc(32, 11),
    ready: () => readyGate,
    async close() {
      closeCalls += 1
    },
  }
  const ctx = {
    lifecycle,
    store: { get: () => core },
    swarm: null,
    ownResource(label, resource, methods, timeoutMs) {
      return lifecycle.ownResource(label, resource, methods, timeoutMs)
    },
  }
  const playback = new LivePlaybackService({ ctx })
  const opening = playback._getSession('12'.repeat(32))
  await new Promise((resolve) => setImmediate(resolve))
  await lifecycle.shutdown()
  t.is(closeCalls, 1)
  releaseReady()
  await t.exception(opening, /shutting down/)
  t.is(playback._sessions.size, 0)
})
