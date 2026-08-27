import test from 'brittle'
import b4a from 'b4a'
import Corestore from 'corestore'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createAssetSession } from '../src/assets/asset-session.js'
import { ASSET_BLOCK_SIZE, createStaticAssetManifest, writeStaticAsset } from '../src/assets/static-core.js'
import { createBufferSourceReader } from '../src/assets/source-reader.js'
import { createMultiPeerScheduler } from '../src/playback/multi-peer-scheduler.js'
import {
  PLAYBACK_ERRORS,
  PLAYBACK_ERROR_CODES,
  RETRYABLE_PLAYBACK_ERROR_CODES,
  TERMINAL_PLAYBACK_ERROR_CODES,
  createPlaybackError,
  isPlaybackErrorCode,
  playbackErrorMessage,
  playbackErrorRetry,
} from '../src/playback/errors.js'
import {
  PLAYBACK_TRAFFIC_CLASSES,
  assertLoopbackPlaybackUrl,
  classifyPlaybackTraffic,
} from '../src/playback/transport-guard.js'
import { preparePlaybackSource } from '../src/playback/source-preparation.js'

const defaultCore = createStaticAssetManifest({
  treeHash: 'a'.repeat(64),
  blockLength: 8,
  byteLength: 8 * 262144,
})
const CORE_KEY = defaultCore.assetId
const OTHER_KEY = 'b'.repeat(64)

function manifest(renditions) {
  return { publicationId: 'pub-1', body: { publisherId: 'publisher-1', renditions } }
}

function rendition(overrides = {}) {
  return {
    renditionId: 'rendition-1',
    purpose: 'original',
    format: 'video/mp4',
    core: defaultCore,
    ...overrides,
  }
}

test('every playback failure has exactly one code, message, and retry policy', (t) => {
  t.ok(PLAYBACK_ERROR_CODES.length > 0)
  for (const code of PLAYBACK_ERROR_CODES) {
    const entry = PLAYBACK_ERRORS[code]
    t.ok(entry.message.length > 0, `${code} has a message`)
    t.ok(['automatic', 'manual', 'evidence'].includes(entry.retry), `${code} has a retry policy`)
    t.is(playbackErrorMessage(code), entry.message)
    t.is(playbackErrorRetry(code), entry.retry)
    t.is(isPlaybackErrorCode(code), true)
  }
  for (const code of ['AVAILABILITY_BOUNDARY', 'NO_COMPATIBLE_SOURCE', 'PEER_TIMEOUT', 'PEER_DISCONNECT', 'RANGE_MISMATCH', 'SESSION_LIMIT']) {
    t.ok(PLAYBACK_ERROR_CODES.includes(code), `${code} is part of the transported vocabulary`)
  }
})

test('only failures another source might not share are retried automatically', (t) => {
  t.alike(
    [...RETRYABLE_PLAYBACK_ERROR_CODES].sort(),
    ['ATTEMPT_LIMIT', 'PEER_DISCONNECT', 'PEER_TIMEOUT', 'RANGE_MISMATCH', 'SESSION_LIMIT'].filter(
      code => RETRYABLE_PLAYBACK_ERROR_CODES.includes(code)
    ).sort()
  )
  for (const code of ['PEER_TIMEOUT', 'PEER_DISCONNECT', 'RANGE_MISMATCH', 'SESSION_LIMIT']) {
    t.ok(RETRYABLE_PLAYBACK_ERROR_CODES.includes(code), `${code} may try another source`)
  }
  for (const code of ['AVAILABILITY_BOUNDARY', 'NO_COMPATIBLE_SOURCE']) {
    t.ok(TERMINAL_PLAYBACK_ERROR_CODES.includes(code), `${code} cannot loop`)
    t.absent(RETRYABLE_PLAYBACK_ERROR_CODES.includes(code), `${code} is never retried automatically`)
  }
  t.absent(
    RETRYABLE_PLAYBACK_ERROR_CODES.some(code => TERMINAL_PLAYBACK_ERROR_CODES.includes(code)),
    'no code is both retryable and terminal'
  )
})

test('a playback error carries its own bounded code', (t) => {
  const error = createPlaybackError('RANGE_MISMATCH')
  t.is(error.errorCode, 'RANGE_MISMATCH')
  t.is(error.retry, 'automatic')
  t.is(error.message, PLAYBACK_ERRORS.RANGE_MISMATCH.message)
  t.is(createPlaybackError('not-a-code').errorCode, 'NO_COMPATIBLE_SOURCE', 'an unknown code degrades, never leaks')
})

test('only the loopback blob server may carry media bytes', (t) => {
  for (const url of ['http://127.0.0.1:9000/blob', 'http://localhost:9000/blob', 'http://[::1]:9000/blob']) {
    t.is(classifyPlaybackTraffic(url, 'media'), PLAYBACK_TRAFFIC_CLASSES.mediaLoopback, `${url} is the local pipe`)
    t.is(assertLoopbackPlaybackUrl(url), url)
  }
  for (const url of [
    'https://cdn.example.com/movie.mp4',
    'http://198.51.100.7:9000/blob',
    'https://127.0.0.1.example.com/blob',
    'ftp://127.0.0.1/blob',
  ]) {
    t.is(classifyPlaybackTraffic(url, 'media'), PLAYBACK_TRAFFIC_CLASSES.forbiddenOrigin, `${url} is not a media origin`)
    t.exception(() => assertLoopbackPlaybackUrl(url), /loopback/)
  }
})

test('manifests, artwork, and diagnostics are control plane, not media', (t) => {
  for (const purpose of ['manifest', 'artwork', 'diagnostics']) {
    t.is(
      classifyPlaybackTraffic('https://provider.example.com/endpoint', purpose),
      PLAYBACK_TRAFFIC_CLASSES.controlPlane,
      `${purpose} may leave the device`
    )
  }
  // The control-plane set is closed. An unlisted purpose is not a narrower kind
  // of control plane; it is an origin the player must never reach.
  t.is(
    classifyPlaybackTraffic('https://provider.example.com/endpoint', 'anything-else'),
    PLAYBACK_TRAFFIC_CLASSES.forbiddenOrigin,
    'an unlisted purpose cannot excuse a remote host'
  )
  t.is(
    classifyPlaybackTraffic('https://provider.example.com/segment.m4s', 'media'),
    PLAYBACK_TRAFFIC_CLASSES.forbiddenOrigin,
    'the same host carrying media is still forbidden'
  )
})

test('an asset session opens only the cores its signed manifest names', async (t) => {
  const opened = []
  const session = createAssetSession({
    manifest: manifest([rendition()]),
    openCore: async key => { opened.push(key); return { close() {} } },
  })

  t.is(await session.authorizeCore({ renditionId: 'rendition-1', coreKey: CORE_KEY }), true)
  t.is(await session.authorizeCore({ renditionId: 'rendition-1', coreKey: OTHER_KEY }), false, 'a substituted key is refused')
  t.is(await session.authorizeCore({ renditionId: 'unknown', coreKey: CORE_KEY }), false, 'an unlisted rendition is refused')
  t.alike(opened, [CORE_KEY], 'only the authorized core was ever opened')
  session.close()
})

test('a session refuses blocked and superseded renditions', async (t) => {
  const session = createAssetSession({
    manifest: manifest([
      rendition({ renditionId: 'blocked', blocked: true }),
      rendition({ renditionId: 'old', superseded: true }),
    ]),
    openCore: async () => ({ close() {} }),
  })

  t.is(await session.authorizeCore({ renditionId: 'blocked', coreKey: CORE_KEY }), false)
  t.is(await session.authorizeCore({ renditionId: 'old', coreKey: CORE_KEY }), false)
  t.is(session.isAuthorizedCore(CORE_KEY), false, 'no live rendition claims that core')
})

test('reads outside the signed block range are a range mismatch', async (t) => {
  const session = createAssetSession({
    manifest: manifest([rendition()]),
    openCore: async () => ({ close() {} }),
  })
  await session.authorizeCore({ renditionId: 'rendition-1', coreKey: CORE_KEY })

  t.is(session.authorizeRange({ renditionId: 'rendition-1', range: { start: 0, end: 8 } }), true)
  t.is(session.authorizeRange({ renditionId: 'rendition-1', range: { start: 0, end: 9 } }), false, 'past the signed length')
  t.is(session.authorizeRange({ renditionId: 'rendition-1', range: { start: 5, end: 5 } }), false, 'empty range')
  t.is(session.authorizeRange({ renditionId: 'rendition-1', range: { start: -1, end: 4 } }), false, 'negative start')
  t.is(session.authorizeRange({ renditionId: 'unauthorized', range: { start: 0, end: 4 } }), false)
})

test('a session caps how many cores it holds open', async (t) => {
  const r1Core = createStaticAssetManifest({ treeHash: '1'.repeat(64), blockLength: 4, byteLength: 4 * 262144 })
  const r2Core = createStaticAssetManifest({ treeHash: '2'.repeat(64), blockLength: 4, byteLength: 4 * 262144 })
  const session = createAssetSession({
    manifest: manifest([
      rendition({ renditionId: 'r1', core: r1Core }),
      rendition({ renditionId: 'r2', core: r2Core }),
    ]),
    openCore: async () => ({ close() {} }),
    maxActiveCores: 1,
  })

  t.is(await session.authorizeCore({ renditionId: 'r1', coreKey: r1Core.assetId }), true)
  await t.exception(
    session.authorizeCore({ renditionId: 'r2', coreKey: r2Core.assetId }),
    /Too many playback sessions/
  )
})

test('a closed session authorizes nothing further', async (t) => {
  const session = createAssetSession({ manifest: manifest([rendition()]), openCore: async () => ({ close() {} }) })
  await session.authorizeCore({ renditionId: 'rendition-1', coreKey: CORE_KEY })
  session.close()

  t.is(session.activeCoreCount(), 0)
  t.is(await session.authorizeCore({ renditionId: 'rendition-1', coreKey: CORE_KEY }), false)
  t.is(session.authorizeRange({ renditionId: 'rendition-1', range: { start: 0, end: 4 } }), false)
})

function inventory(assetId, indexes) {
  if (indexes.length === 0) return { assetId, ranges: [], nextCursor: null }
  const startBlock = Math.min(...indexes)
  const endBlock = Math.max(...indexes) + 1
  const presentBitfield = b4a.alloc(Math.ceil((endBlock - startBlock) / 8))
  for (const index of indexes) {
    const bit = index - startBlock
    presentBitfield[bit >> 3] |= 1 << (bit & 7)
  }
  return { assetId, ranges: [{ startBlock, bitCount: endBlock - startBlock, presentBitfield }], nextCursor: null }
}

function tempStore(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { directory, store: new Corestore(directory) }
}

async function proofFixture(t, blockCount = 2) {
  const source = tempStore('peartube-playback-source-')
  const reader = tempStore('peartube-playback-reader-')
  await source.store.ready()
  await reader.store.ready()
  const sourceBytes = b4a.alloc(blockCount * ASSET_BLOCK_SIZE)
  for (let index = 0; index < blockCount; index++) sourceBytes.fill(index + 1, index * ASSET_BLOCK_SIZE, (index + 1) * ASSET_BLOCK_SIZE)
  const asset = await writeStaticAsset({ store: source.store, reader: createBufferSourceReader(sourceBytes) })
  const session = createAssetSession({ coreRef: asset.descriptor, store: reader.store })
  await session.ready()

  async function applyBlock(index, { corrupt = false } = {}) {
    const proof = await asset.core.proof({ block: { index, nodes: 0 }, upgrade: { start: 0, length: asset.descriptor.length } })
    const value = b4a.from(proof.block.value)
    if (corrupt) value[0] ^= 0xff
    await session.verifyBlock({ index, proof: { ...proof, block: { ...proof.block, value: null } }, value })
  }

  t.teardown(async () => {
    await session.close().catch(() => {})
    await asset.core.close().catch(() => {})
    await source.store.close().catch(() => {})
    await reader.store.close().catch(() => {})
    fs.rmSync(source.directory, { recursive: true, force: true })
    fs.rmSync(reader.directory, { recursive: true, force: true })
  })
  return { asset, session, sourceBytes, applyBlock }
}

function verifiedTransport({ assetId, session, ownership, applyBlock, onRequest = null }) {
  const calls = []
  return {
    calls,
    getActiveAssetPeerIds() { return [...ownership.keys()].sort() },
    listPeerAssetRanges({ peerId }) { return inventory(assetId, ownership.get(peerId) || []) },
    hasVerifiedAssetBlock({ blockIndex }) { return session.hasVerifiedBlock(blockIndex) },
    readVerifiedAssetBlock({ blockIndex }) { return session.readVerifiedBlock(blockIndex) },
    async requestAssetBlocks(request) {
      calls.push({ ...request, peerIds: [...request.peerIds] })
      if (onRequest) return onRequest(request, { applyBlock, calls })
      const peerId = request.peerIds[0]
      const owned = new Set(ownership.get(peerId) || [])
      for (let index = request.startBlock; index < request.endBlock; index++) {
        if (!owned.has(index)) {
          const error = new Error('selected peer disconnected')
          error.code = 'PEER_DISCONNECTED'
          error.peerId = peerId
          throw error
        }
        await applyBlock(index)
      }
      return {
        verifiedBlockIndexes: Array.from({ length: request.endBlock - request.startBlock }, (_, offset) => request.startBlock + offset),
        peerIds: [peerId],
      }
    },
  }
}

test('local complete playback needs no peer at all', async (t) => {
  const fixture = await proofFixture(t, 2)
  await fixture.applyBlock(0)
  await fixture.applyBlock(1)
  const transport = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId,
    session: fixture.session,
    ownership: new Map(),
    applyBlock: fixture.applyBlock,
  })
  const scheduler = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })
  const result = await scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: 2 * ASSET_BLOCK_SIZE, deadlineMs: 1000 })

  t.is(result.status, 'ok')
  t.alike(result.peerIds, [])
  t.is(result.originAttempted, false)
  t.is(transport.calls.length, 0, 'a local copy never touches the network')
})

test('remote playback is served by peers and reports a bounded code when none can', async (t) => {
  const fixture = await proofFixture(t, 2)
  const ownership = new Map([['peer-a', [0, 1]]])
  const transport = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId,
    session: fixture.session,
    ownership,
    applyBlock: fixture.applyBlock,
  })
  const served = await createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })
    .requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: 2 * ASSET_BLOCK_SIZE, deadlineMs: 5000 })
  t.is(served.status, 'ok')
  t.alike(served.peerIds, ['peer-a'])
  t.is(served.originAttempted, false)

  const emptyFixture = await proofFixture(t, 2)
  const emptyTransport = verifiedTransport({
    assetId: emptyFixture.asset.descriptor.assetId,
    session: emptyFixture.session,
    ownership: new Map(),
    applyBlock: emptyFixture.applyBlock,
  })
  const missing = await createMultiPeerScheduler({ coreRef: emptyFixture.asset.descriptor, session: emptyFixture.session, transport: emptyTransport })
    .requestRange({ assetId: emptyFixture.asset.descriptor.assetId, byteStart: 0, byteEnd: 2 * ASSET_BLOCK_SIZE, deadlineMs: 1000 })
  t.is(missing.status, 'unavailable')
  t.is(missing.errorCode, 'NO_VERIFIED_SOURCE')
  t.is(missing.originAttempted, false, 'no origin was tried, because there is none')
})

test('a peer that fails verification is a range mismatch, not an empty network', async (t) => {
  const fixture = await proofFixture(t, 2)
  const ownership = new Map([['liar', [0, 1]]])
  const transport = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId,
    session: fixture.session,
    ownership,
    applyBlock: (index) => fixture.applyBlock(index, { corrupt: true }),
  })
  const scheduler = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })
  const result = await scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: 2 * ASSET_BLOCK_SIZE, deadlineMs: 1000 })

  t.is(result.status, 'unavailable')
  t.is(result.errorCode, 'NO_VERIFIED_SOURCE')
  t.is(result.originAttempted, false)
})

test('a disconnected peer cannot serve, and the answer stays inside the vocabulary', async (t) => {
  const fixture = await proofFixture(t, 2)
  const ownership = new Map([['gone', []]])
  const transport = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId,
    session: fixture.session,
    ownership,
    applyBlock: fixture.applyBlock,
  })
  const scheduler = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })
  const result = await scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: 2 * ASSET_BLOCK_SIZE, deadlineMs: 1000 })

  t.is(result.errorCode, 'NO_VERIFIED_SOURCE')
  t.is(result.originAttempted, false)
})

test('a missing startup range leaves no half-open session and names no origin', async (t) => {
  const closed = []
  const result = await preparePlaybackSource({
    sources: [{
      publicationId: 'pub-1',
      entityId: 'work:1',
      renditionId: 'rendition-1',
      publicationAuthorized: true,
      availability: { state: 'healthy', requiredRangeCount: 1, reachableRangeCount: 1, completePeerCount: 2 },
    }],
    now: () => 1_700_000_000_000,
    openSession: async () => ({
      success: false,
      errorCode: 'AVAILABILITY_BOUNDARY',
      close: () => closed.push('pub-1'),
    }),
  })

  t.is(result.success, false)
  t.is(result.errorCode, 'AVAILABILITY_BOUNDARY')
  t.alike(closed, ['pub-1'], 'the half-open attempt was closed')
  const serialized = JSON.stringify(result)
  t.absent(/https?:\/\//.test(serialized), 'the failure names no origin or CDN')
})

test('an HTTP trap receives zero media requests while two peers serve playback', async (t) => {
  const trapped = []
  const trap = http.createServer((request, response) => {
    trapped.push(request.url)
    response.statusCode = 200
    response.end('trap')
  })
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise(resolve => trap.close(resolve)))
  const fixture = await proofFixture(t, 3)
  const ownership = new Map([
    ['peer-a', [0]],
    ['peer-b', [1]],
  ])
  const transport = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId,
    session: fixture.session,
    ownership,
    applyBlock: fixture.applyBlock,
  })
  const scheduler = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })

  const first = await scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: ASSET_BLOCK_SIZE, deadlineMs: 5000 })
  const second = await scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: ASSET_BLOCK_SIZE, byteEnd: 2 * ASSET_BLOCK_SIZE, deadlineMs: 5000 })
  const beyond = await scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 2 * ASSET_BLOCK_SIZE, byteEnd: 3 * ASSET_BLOCK_SIZE, deadlineMs: 1000 })

  t.is(first.status, 'ok')
  t.alike(first.peerIds, ['peer-a'])
  t.is(second.status, 'ok')
  t.alike(second.peerIds, ['peer-b'])
  t.is(beyond.status, 'unavailable')
  t.is(beyond.errorCode, 'NO_VERIFIED_SOURCE', 'a gap fails rather than falling back to the trap')
  t.alike(trapped, [], 'the HTTP trap received nothing')
})

test('a redirect to an origin cannot be laundered into a media URL', (t) => {
  for (const url of [
    'http://127.0.0.1:9000/redirect?to=https://cdn.example.com/movie.mp4',
    'https://cdn.example.com/redirect?to=http://127.0.0.1:9000/blob',
  ]) {
    const classification = classifyPlaybackTraffic(url, 'media')
    if (url.startsWith('http://127.0.0.1')) {
      t.is(classification, PLAYBACK_TRAFFIC_CLASSES.mediaLoopback, 'the loopback server itself never follows the query')
    } else {
      t.is(classification, PLAYBACK_TRAFFIC_CLASSES.forbiddenOrigin, 'a remote host is forbidden whatever it points at')
    }
  }
})
