import test from 'brittle'
import c from 'compact-encoding'
import HypercoreID from 'hypercore-id-encoding'
import z32 from 'z32'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import Hyperblobs from 'hyperblobs'
import b4a from 'b4a'

import {
  registerBlobPlaybackProfile,
  getBlobPlaybackProfile,
  clearBlobPlaybackProfiles,
  saveBlobPlaybackProfile,
  loadBlobPlaybackProfile,
  attachBlobPlaybackProfile,
  probeRemoteBlobPlaybackProfile,
} from '../src/blob-playback-profile.js'
import {
  getPrioritizedBlobDownloadRange,
  prioritizeBlobServerRangeRequest,
  releaseAllPrioritizedBlobRanges,
} from '../src/blob-range-priority.js'

const CORE_KEY_HEX = 'a'.repeat(64)

function makeBlob({ blockOffset = 10, blockLength = 100, byteOffset = 4096, byteLength = 100 * 65536 } = {}) {
  return { blockOffset, blockLength, byteOffset, byteLength }
}

function makeProfile(overrides = {}) {
  return {
    version: 1,
    container: 'mp4',
    source: 'probe',
    moovPosition: 'front',
    moovStart: 16,
    moovEnd: 512,
    fragmented: false,
    keyframeTimesMs: [0, 2000, 4000],
    keyframeOffsets: [1024, 2 * 65536, 50 * 65536],
    ...overrides,
  }
}

function makeMetaDbCtx() {
  const entries = new Map()
  return {
    metaDb: {
      async put(key, value) {
        // JSON round-trip mirrors the hyperbee json valueEncoding.
        entries.set(key, JSON.parse(JSON.stringify(value)))
      },
      async get(key) {
        return entries.has(key) ? { value: entries.get(key) } : null
      },
    },
    _entries: entries,
  }
}

test('profile registry stores, retrieves, and evicts LRU', (t) => {
  clearBlobPlaybackProfiles()

  const blob = makeBlob()
  const profile = makeProfile()
  t.ok(registerBlobPlaybackProfile(CORE_KEY_HEX, blob, profile))
  t.is(getBlobPlaybackProfile(CORE_KEY_HEX, blob), profile)
  t.is(getBlobPlaybackProfile('b'.repeat(64), blob), null, 'different core misses')

  // Fill past capacity; the first entry was just refreshed by the get above,
  // so the second-registered entry is evicted first.
  const earliest = makeBlob({ blockOffset: 9999 })
  registerBlobPlaybackProfile(CORE_KEY_HEX, earliest, makeProfile())
  for (let i = 0; i < 16; i++) {
    registerBlobPlaybackProfile(CORE_KEY_HEX, makeBlob({ blockOffset: i * 1000 + 1 }), makeProfile())
  }
  t.is(getBlobPlaybackProfile(CORE_KEY_HEX, earliest), null, 'oldest entry evicted')

  t.absent(registerBlobPlaybackProfile(CORE_KEY_HEX, blob, { junk: true }), 'unusable profiles rejected')
  clearBlobPlaybackProfiles()
})

test('profiles persist through the metaDb and round-trip via attach', async (t) => {
  clearBlobPlaybackProfiles()
  const ctx = makeMetaDbCtx()
  const blob = makeBlob()
  const blobId = `${blob.blockOffset}:${blob.blockLength}:${blob.byteOffset}:${blob.byteLength}`
  const profile = makeProfile()

  t.ok(await saveBlobPlaybackProfile(ctx, { blobsCoreKey: CORE_KEY_HEX, blobId }, profile))
  t.alike(await loadBlobPlaybackProfile(ctx, { blobsCoreKey: CORE_KEY_HEX, blobId }), profile)
  t.is(await loadBlobPlaybackProfile(ctx, { blobsCoreKey: CORE_KEY_HEX, blobId: '0:1:0:1' }), null)

  // attach loads the stored profile and registers it for range priority.
  const attached = await attachBlobPlaybackProfile(ctx, {
    blobsCoreKey: CORE_KEY_HEX,
    blobId,
    mimeType: 'video/mp4',
  }, { allowRemoteProbe: false })
  t.alike(attached, profile)
  t.alike(getBlobPlaybackProfile(CORE_KEY_HEX, blob), profile, 'registered after attach')

  clearBlobPlaybackProfiles()
})

test('attach without a stored profile does not remote-probe non-mp4 blobs', async (t) => {
  clearBlobPlaybackProfiles()
  const ctx = makeMetaDbCtx()
  // No ctx.store: a remote probe attempt would return null rather than throw,
  // but for non-mp4 it must not even be attempted.
  const result = await attachBlobPlaybackProfile(ctx, {
    blobsCoreKey: CORE_KEY_HEX,
    blobId: '0:10:0:655360',
    mimeType: 'video/webm',
  })
  t.is(result, null)
  clearBlobPlaybackProfiles()
})

test('probeRemoteBlobPlaybackProfile reads an mp4 blob through hyperblobs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-profile-test-'))
  const store = new Corestore(dir)
  t.teardown(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const core = store.get({ name: 'blobs' })
  await core.ready()
  const blobs = new Hyperblobs(core)

  // Minimal front-moov MP4 (same shape the probe unit tests use).
  const { buildTestMp4 } = await import('./helpers/build-test-mp4.mjs')
  const file = buildTestMp4()
  const blobId = await blobs.put(file)

  const ctx = { store }
  const profile = await probeRemoteBlobPlaybackProfile(ctx, {
    blobsCoreKey: b4a.toString(core.key, 'hex'),
    blob: blobId,
  })

  t.ok(profile, 'remote probe parsed the blob')
  t.is(profile.source, 'remote-probe')
  t.is(profile.moovPosition, 'front')
  t.ok(profile.keyframeOffsets.length > 0, 'keyframe index extracted')
})

// ─── Range-priority integration ──────────────────────────────────────────────

const blobIdEncoding = {
  preencode(state, blob) {
    c.uint.preencode(state, blob.blockOffset)
    c.uint.preencode(state, blob.blockLength)
    c.uint.preencode(state, blob.byteOffset)
    c.uint.preencode(state, blob.byteLength)
  },
  encode(state, blob) {
    c.uint.encode(state, blob.blockOffset)
    c.uint.encode(state, blob.blockLength)
    c.uint.encode(state, blob.byteOffset)
    c.uint.encode(state, blob.byteLength)
  },
  decode(state) {
    return {
      blockOffset: c.uint.decode(state),
      blockLength: c.uint.decode(state),
      byteOffset: c.uint.decode(state),
      byteLength: c.uint.decode(state),
    }
  },
}

function createRangeRequest({ keyHex = 'b'.repeat(64), rangeStart, rangeEnd } = {}) {
  const key = Buffer.from(keyHex, 'hex')
  const blob = makeBlob()
  const encodedBlob = z32.encode(c.encode(blobIdEncoding, blob))
  const req = {
    method: 'GET',
    url: `/?key=${HypercoreID.encode(key)}&blob=${encodedBlob}&type=video%2Fmp4&token=test-token`,
    headers: { range: `bytes=${rangeStart}-${rangeEnd}` },
  }
  return { key, blob, req }
}

function createMockBlobServer(calls) {
  return {
    token: 'test-token',
    async _getCore(requestKey, info, active) {
      calls.push(['_getCore'])
      return {
        closed: false,
        download(options) {
          calls.push(['download', options])
          return {
            done: () => Promise.resolve(),
            destroy: () => calls.push(['destroy', options.start]),
          }
        },
        close() {
          calls.push(['close'])
        },
      }
    },
  }
}

test('getPrioritizedBlobDownloadRange snaps the window start back to a keyframe offset', (t) => {
  const blob = makeBlob()
  const snapOffsets = [0, 10 * 65536, 40 * 65536]

  // Seek to byte 45*65536: nearest preceding keyframe is at 40*65536.
  t.alike(
    getPrioritizedBlobDownloadRange(blob, { start: 45 * 65536, end: 46 * 65536 - 1 }, { readAheadBytes: 0, snapOffsets }),
    { start: 10 + 40, end: 10 + 46, blocks: 6 },
    'window start snapped to the keyframe block'
  )

  // Exactly on a keyframe: no change.
  t.alike(
    getPrioritizedBlobDownloadRange(blob, { start: 40 * 65536, end: 41 * 65536 - 1 }, { readAheadBytes: 0, snapOffsets }),
    { start: 50, end: 51, blocks: 1 }
  )

  // Keyframe further back than the snap budget: no snap.
  t.alike(
    getPrioritizedBlobDownloadRange(blob, { start: 45 * 65536, end: 46 * 65536 - 1 }, { readAheadBytes: 0, snapOffsets, maxSnapBackBytes: 65536 }),
    { start: 55, end: 56, blocks: 1 },
    'distant keyframe outside snap budget is ignored'
  )

  // Range start 0 never snaps (nothing precedes it).
  t.alike(
    getPrioritizedBlobDownloadRange(blob, { start: 0, end: 65536 - 1 }, { readAheadBytes: 0, snapOffsets }),
    { start: 10, end: 11, blocks: 1 }
  )
})

test('prioritizeBlobServerRangeRequest snaps using a registered playback profile', async (t) => {
  releaseAllPrioritizedBlobRanges()
  clearBlobPlaybackProfiles()
  const calls = []
  const blobServer = createMockBlobServer(calls)

  const keyHex = 'c'.repeat(64)
  const { blob, req } = createRangeRequest({ keyHex, rangeStart: 45 * 65536, rangeEnd: 46 * 65536 - 1 })
  registerBlobPlaybackProfile(keyHex, blob, makeProfile({
    keyframeOffsets: [0, 40 * 65536],
  }))

  const result = await prioritizeBlobServerRangeRequest(blobServer, req, { readAheadBytes: 0 })
  t.alike(result, { start: 50, end: 56, blocks: 6 }, 'download range starts at the keyframe block')

  releaseAllPrioritizedBlobRanges()
  clearBlobPlaybackProfiles()
})

test('a back-moov profile triggers a one-shot moov tail boost download', async (t) => {
  releaseAllPrioritizedBlobRanges()
  clearBlobPlaybackProfiles()
  const calls = []
  const blobServer = createMockBlobServer(calls)

  const keyHex = 'd'.repeat(64)
  const first = createRangeRequest({ keyHex, rangeStart: 0, rangeEnd: 65536 - 1 })
  const blob = first.blob
  // moov occupies the last two blocks of the blob.
  registerBlobPlaybackProfile(keyHex, blob, makeProfile({
    moovPosition: 'back',
    moovStart: 98 * 65536,
    moovEnd: 100 * 65536,
    keyframeOffsets: [],
  }))

  await prioritizeBlobServerRangeRequest(blobServer, first.req, { readAheadBytes: 0 })
  await Promise.resolve()

  const downloads = calls.filter((call) => call[0] === 'download').map((call) => call[1])
  t.is(downloads.length, 2, 'head window plus moov boost')
  t.alike(downloads[0], { start: 10 + 98, end: 10 + 100, linear: true }, 'moov tail blocks prioritized first')
  t.alike(downloads[1], { start: 10, end: 11, linear: true }, 'requested head window still prioritized')

  // A later request for the same blob must not re-boost.
  const second = createRangeRequest({ keyHex, rangeStart: 8 * 65536, rangeEnd: 9 * 65536 - 1 })
  await prioritizeBlobServerRangeRequest(blobServer, second.req, { readAheadBytes: 0 })
  const downloadsAfter = calls.filter((call) => call[0] === 'download')
  t.is(downloadsAfter.length, 3, 'moov boost fires once per profile')

  releaseAllPrioritizedBlobRanges()
  clearBlobPlaybackProfiles()
})

test('front-moov profiles do not trigger a boost download', async (t) => {
  releaseAllPrioritizedBlobRanges()
  clearBlobPlaybackProfiles()
  const calls = []
  const blobServer = createMockBlobServer(calls)

  const keyHex = 'e'.repeat(64)
  const { blob, req } = createRangeRequest({ keyHex, rangeStart: 0, rangeEnd: 65536 - 1 })
  registerBlobPlaybackProfile(keyHex, blob, makeProfile({ moovPosition: 'front', keyframeOffsets: [] }))

  await prioritizeBlobServerRangeRequest(blobServer, req, { readAheadBytes: 0 })
  t.is(calls.filter((call) => call[0] === 'download').length, 1, 'only the requested window downloads')

  releaseAllPrioritizedBlobRanges()
  clearBlobPlaybackProfiles()
})
