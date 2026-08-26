import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import Corestore from 'corestore'
import hypercoreWants from 'hypercore/lib/wants.js'
import test from 'brittle'

import {
  canonicalDurabilityRefKey,
  canonicalizeDurabilityRefs,
  evaluateDurabilityPolicy,
  intersectFullCopyHolders,
} from '../src/durability/aggregate-assessment.js'
import { assessDurableManifest, createApi } from '../src/api.js'

const CORE_A = '10'.repeat(32)
const CORE_B = '20'.repeat(32)
const CORE_C = 'f0'.repeat(32)
const PEER_A = 'a1'.repeat(32)
const PEER_B = 'b2'.repeat(32)
const PEER_C = 'c3'.repeat(32)

function ref (coreKey, start, end, kind = 'media') {
  return { coreKey, start, end, kind }
}

function peerWithBlocks (key, blocks) {
  const available = new Set(blocks)
  return {
    remotePublicKey: typeof key === 'string' ? b4a.from(key, 'hex') : key,
    remoteBitfield: {
      firstUnset (start) {
        let index = start
        while (available.has(index)) index++
        return index
      },
    },
  }
}

function createCoreHarness (peersByCore, { readyErrorByCore = new Map(), openErrorByCore = new Map() } = {}) {
  const opened = []
  const closed = []
  return {
    opened,
    closed,
    deps: {
      openCore (coreKey) {
        const openError = openErrorByCore.get(coreKey)
        if (openError) throw openError
        const peers = peersByCore.get(coreKey)
        if (!peers) return null
        opened.push(coreKey)
        return {
          peers,
          async ready () {
            const readyError = readyErrorByCore.get(coreKey)
            if (readyError) throw readyError
          },
          async close () {
            closed.push(coreKey)
          },
        }
      },
    },
  }
}

function observationsFor (entries) {
  return new Map(entries.map(([durabilityRef, holders]) => [
    canonicalDurabilityRefKey(durabilityRef),
    new Set(holders),
  ]))
}

function assessedPolicy (policy) {
  return { ...policy, status: 'ok', error: null }
}

function failedAssessment (message) {
  return {
    eligible: false,
    trusted: [],
    paired: [],
    ordinary: [],
    status: 'error',
    error: message,
  }
}

test('canonicalizeDurabilityRefs normalizes, byte-sorts, and deduplicates without mutation', (t) => {
  const input = [
    ref(CORE_C.toUpperCase(), 3, 8, 'thumbnail'),
    ref(b4a.from(CORE_A, 'hex'), 4, 9, 'media'),
    ref(CORE_A, 1, 2, 'artwork'),
    ref(CORE_A, 4, 9, 'media'),
    ref(CORE_B, 0, 1, 'thumbnail'),
  ]
  const originalFirst = { ...input[0] }

  const normalized = canonicalizeDurabilityRefs(input)

  t.alike(normalized, [
    ref(CORE_A, 1, 2, 'artwork'),
    ref(CORE_A, 4, 9, 'media'),
    ref(CORE_B, 0, 1, 'thumbnail'),
    ref(CORE_C, 3, 8, 'thumbnail'),
  ])
  t.alike(input[0], originalFirst, 'caller ref is not rewritten')
  t.not(normalized[0], input[2], 'canonical refs are new objects')

  input[2].start = 99
  t.is(normalized[0].start, 1, 'result does not alias caller objects')
})

test('canonical ref identity is structural and collision-free', (t) => {
  const media = ref(CORE_A, 1, 23, 'media')
  const thumbnail = ref(CORE_A, 12, 3, 'thumbnail')
  const artwork = ref(CORE_A, 1, 23, 'artwork')

  t.not(canonicalDurabilityRefKey(media), canonicalDurabilityRefKey(artwork))
  assert.throws(() => canonicalDurabilityRefKey(thumbnail), /range|end/i)
  t.alike(JSON.parse(canonicalDurabilityRefKey(media)), [CORE_A, 1, 23, 'media'])
})

test('canonicalizeDurabilityRefs rejects malformed and ambiguous core keys', (t) => {
  const malformed = [
    'aa',
    `0x${CORE_A}`,
    `${CORE_A} `,
    'gg'.repeat(32),
    b4a.alloc(31),
    b4a.alloc(33),
    { toString: () => CORE_A },
    null,
  ]

  for (const coreKey of malformed) {
    assert.throws(() => canonicalizeDurabilityRefs([ref(coreKey, 0, 1)]), /coreKey/i)
  }
})

test('canonicalizeDurabilityRefs rejects open, empty, reversed, negative, and unsafe ranges', (t) => {
  const invalid = [
    ref(CORE_A, 0, undefined),
    ref(CORE_A, 0, 0),
    ref(CORE_A, 2, 1),
    ref(CORE_A, -1, 1),
    ref(CORE_A, 0.5, 2),
    ref(CORE_A, 0, Number.POSITIVE_INFINITY),
    ref(CORE_A, 0, Number.MAX_SAFE_INTEGER + 1),
    ref(CORE_A, '0', 1),
  ]

  for (const durabilityRef of invalid) {
    assert.throws(() => canonicalizeDurabilityRefs([durabilityRef]), /start|end|range/i)
  }
})

test('canonicalizeDurabilityRefs accepts only known kinds and handles an empty list', (t) => {
  t.alike(canonicalizeDurabilityRefs([]), [])
  t.alike(canonicalizeDurabilityRefs([
    ref(CORE_A, 0, 1, 'media'),
    ref(CORE_B, 0, 1, 'thumbnail'),
    ref(CORE_C, 0, 1, 'artwork'),
  ]).map((entry) => entry.kind), ['media', 'thumbnail', 'artwork'])
  assert.throws(() => canonicalizeDurabilityRefs([ref(CORE_A, 0, 1, 'preview')]), /kind/i)
  assert.throws(() => canonicalizeDurabilityRefs([ref(CORE_A, 0, 1, 'Media')]), /kind/i)
})

test('sparse ref arrays are rejected or fail closed before observation/core work', async (t) => {
  const sparse = new Array(1)
  assert.throws(() => canonicalizeDurabilityRefs(sparse), /refs\[0\]/i)
  t.alike([...intersectFullCopyHolders(sparse, new Map())], [])

  let opens = 0
  const result = await assessDurableManifest(sparse, {}, {
    openCore () {
      opens++
      throw new Error('must not open')
    },
  })
  t.alike(result, failedAssessment('refs[0] must be an object'))
  t.is(opens, 0)
})

test('intersectFullCopyHolders requires one peer across media and thumbnail', (t) => {
  const refs = [
    ref(CORE_A, 0, 3, 'media'),
    ref(CORE_B, 5, 7, 'thumbnail'),
  ]
  const observations = observationsFor([
    [refs[0], [PEER_B, PEER_A, PEER_A]],
    [refs[1], [b4a.from(PEER_A, 'hex')]],
  ])

  const holders = intersectFullCopyHolders(refs, observations)
  t.alike([...holders], [PEER_A])
  t.not(holders, observations.get(canonicalDurabilityRefKey(refs[0])))
})

test('intersectFullCopyHolders rejects disjoint holders and is reorder/duplicate invariant', (t) => {
  const media = ref(CORE_A, 0, 3, 'media')
  const thumbnail = ref(CORE_B, 5, 7, 'thumbnail')
  const split = observationsFor([
    [media, [PEER_A]],
    [thumbnail, [PEER_B]],
  ])

  t.alike([...intersectFullCopyHolders([media, thumbnail], split)], [])
  t.alike([...intersectFullCopyHolders([thumbnail, media, media], split)], [])
})

test('intersectFullCopyHolders handles empty refs or observations and validates holder keys', (t) => {
  const media = ref(CORE_A, 0, 1, 'media')
  t.alike([...intersectFullCopyHolders([], new Map())], [])
  t.alike([...intersectFullCopyHolders([media], new Map())], [])

  const malformed = new Map([[canonicalDurabilityRefKey(media), new Set(['peer-a'])]])
  assert.throws(() => intersectFullCopyHolders([media], malformed), /holder|key/i)
})

test('evaluateDurabilityPolicy applies ordinary threshold boundaries deterministically', (t) => {
  t.alike(evaluateDurabilityPolicy({ holderKeys: [PEER_B] }), {
    eligible: false,
    trusted: [],
    paired: [],
    ordinary: [PEER_B],
  })
  t.alike(evaluateDurabilityPolicy({ holderKeys: [PEER_C, PEER_B, PEER_C] }), {
    eligible: true,
    trusted: [],
    paired: [],
    ordinary: [PEER_B, PEER_C],
  })
  t.is(evaluateDurabilityPolicy({ holderKeys: [], ordinaryRequired: 0 }).eligible, true)
})

test('evaluateDurabilityPolicy gives trusted then paired precedence without double-counting', (t) => {
  const result = evaluateDurabilityPolicy({
    holderKeys: [PEER_C, b4a.from(PEER_A, 'hex'), PEER_B, PEER_A],
    trustedRelayKeys: [PEER_A],
    pairedDeviceKeys: [PEER_A, PEER_B],
    ordinaryRequired: 2,
  })

  t.alike(result, {
    eligible: true,
    trusted: [PEER_A],
    paired: [PEER_B],
    ordinary: [PEER_C],
  })
})

test('evaluateDurabilityPolicy validates nonnegative finite safe ordinary thresholds and keys', (t) => {
  for (const ordinaryRequired of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '2']) {
    assert.throws(() => evaluateDurabilityPolicy({ holderKeys: [], ordinaryRequired }), /ordinaryRequired/i)
  }
  assert.throws(() => evaluateDurabilityPolicy({ holderKeys: ['soft-receipt'] }), /holder|key/i)
  assert.throws(() => evaluateDurabilityPolicy({ holderKeys: [], trustedRelayKeys: ['trusted-name'] }), /trusted|key/i)
})

test('assessDurableManifest accepts one authenticated peer holding every ref with half-open ranges', async (t) => {
  const refs = [
    ref(CORE_A, 0, 3, 'media'),
    ref(CORE_B, 5, 7, 'thumbnail'),
  ]
  const harness = createCoreHarness(new Map([
    [CORE_A, [peerWithBlocks(PEER_A, [0, 1, 2])]],
    [CORE_B, [peerWithBlocks(b4a.from(PEER_A, 'hex'), [5, 6])]],
  ]))

  const result = await assessDurableManifest(refs, {
    trustedRelayKeys: [b4a.from(PEER_A, 'hex')],
  }, harness.deps)

  t.alike(result, assessedPolicy({ eligible: true, trusted: [PEER_A], paired: [], ordinary: [] }))
  t.alike(harness.opened, [CORE_A, CORE_B])
  t.alike(harness.closed, [CORE_A, CORE_B])
})

test('assessDurableManifest actively refreshes real sparse remote bitfields before policy evaluation', async (t) => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'peartube-durability-source-'))
  const relayDir = mkdtempSync(join(tmpdir(), 'peartube-durability-relay-'))
  const sourceStore = new Corestore(sourceDir)
  const relayStore = new Corestore(relayDir)
  let sourceReplication = null
  let relayReplication = null
  let assessmentSession = null
  try {
    await Promise.all([sourceStore.ready(), relayStore.ready()])
    const source = sourceStore.get({ name: 'durability-sparse-source' })
    await source.ready()
    await source.append(Array.from({ length: 8 }, (_, index) => b4a.alloc(32 + index, index + 1)))
    const relay = relayStore.get({ key: source.key })
    await relay.ready()
    sourceReplication = sourceStore.replicate(true, { live: true })
    relayReplication = relayStore.replicate(false, { live: true })
    sourceReplication.pipe(relayReplication).pipe(sourceReplication)
    await relay.update({ wait: true })
    const download = relay.download({ start: 2, end: 8, linear: true })
    await download.done()

    const peer = source.peers[0]
    peer.remotePublicKey = b4a.from(PEER_A, 'hex')
    t.is(peer.remoteBitfield.firstUnset(2), 2, 'source does not learn sparse downloader availability passively')

    assessmentSession = sourceStore.session()
    const assessmentCore = assessmentSession.get({ key: source.key })
    await assessmentCore.ready()
    const result = await assessDurableManifest([
      ref(b4a.toString(source.key, 'hex'), 2, 8, 'media'),
    ], {
      trustedRelayKeys: [PEER_A],
    }, {
      openCore: async () => assessmentCore,
      bitfieldRefreshTimeoutMs: 1_000,
    })

    t.alike(result, assessedPolicy({ eligible: true, trusted: [PEER_A], paired: [], ordinary: [] }))
    t.ok(peer.remoteBitfield.firstUnset(2) >= 8, 'WANT/BITFIELD refresh proves every sparse block')

    const prefixDownload = relay.download({ start: 0, end: 2, linear: true })
    await prefixDownload.done()
    t.is(peer.remoteBitfield.firstUnset(0), 0, 'completed prefix remains unknown after the sparse WANT is released')
    const prefixAssessmentCore = assessmentSession.get({ key: source.key })
    await prefixAssessmentCore.ready()
    const prefixResult = await assessDurableManifest([
      ref(b4a.toString(source.key, 'hex'), 0, 8, 'media'),
    ], {
      trustedRelayKeys: [PEER_A],
    }, {
      openCore: async () => prefixAssessmentCore,
      bitfieldRefreshTimeoutMs: 1_000,
    })
    t.is(prefixResult.eligible, true, 'fresh real RANGE proves the now-contiguous relay prefix')
  } finally {
    sourceReplication?.destroy()
    relayReplication?.destroy()
    await assessmentSession?.close().catch(() => {})
    await relayStore.close().catch(() => {})
    await sourceStore.close().catch(() => {})
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(relayDir, { recursive: true, force: true })
  }
})

test('assessDurableManifest refreshes every deduplicated WANT batch crossing a ref boundary', async (t) => {
  const batchLength = hypercoreWants.WANT_BATCH
  const probeLength = batchLength / 2
  const start = batchLength - 2
  const end = batchLength + 2

  function boundaryPeer ({ missingSecond = false } = {}) {
    const known = new Set()
    const active = new Set()
    const calls = []
    const peer = {
      remotePublicKey: b4a.from(PEER_A, 'hex'),
      remoteBitfield: {
        firstUnset (index) {
          let cursor = index
          while (true) {
            const batchStart = Math.floor(cursor / probeLength) * probeLength
            if (!known.has(batchStart)) return cursor
            const availableEnd = missingSecond && batchStart === batchLength
              ? batchLength + 1
              : batchStart + probeLength
            if (cursor < availableEnd) cursor = availableEnd
            if (availableEnd < batchStart + probeLength) return cursor
          }
        },
      },
      onrange: async () => {},
      onbitfield (message) {
        known.add(message.start)
      },
      wireWant: {
        send (message) {
          calls.push(message.start)
          active.add(message.start)
          queueMicrotask(() => peer.onbitfield({
            start: message.start,
            bitfield: b4a.alloc(message.length / 8),
          }))
        },
      },
      wireUnwant: { send: message => active.delete(message.start) },
      isActive: () => true,
    }
    return { peer, calls, active }
  }

  const complete = boundaryPeer()
  const overlappingRefs = [
    ref(CORE_A, start, end, 'media'),
    ref(CORE_A, start + 1, end, 'thumbnail'),
  ]
  const completeHarness = createCoreHarness(new Map([[CORE_A, [complete.peer]]]))
  const completeResult = await assessDurableManifest(overlappingRefs, {
    trustedRelayKeys: [PEER_A],
  }, {
    ...completeHarness.deps,
    bitfieldRefreshTimeoutMs: 50,
  })
  t.is(completeResult.eligible, true, 'both batch bitfields prove the crossing range')
  t.alike(complete.calls, [probeLength, batchLength], 'overlapping refs issue one isolated WANT per intersecting half-batch')
  t.is(complete.active.size, 0, 'every complete-path WANT handle is released')

  const partial = boundaryPeer({ missingSecond: true })
  const partialHarness = createCoreHarness(new Map([[CORE_A, [partial.peer]]]))
  const partialResult = await assessDurableManifest([overlappingRefs[0]], {
    trustedRelayKeys: [PEER_A],
  }, {
    ...partialHarness.deps,
    bitfieldRefreshTimeoutMs: 20,
  })
  t.is(partialResult.eligible, false, 'a known missing block in the second batch fails closed')
  t.alike(partial.calls, [probeLength, batchLength], 'missing second-probe data still requires both isolated WANTs')
  t.is(partial.active.size, 0, 'failed refresh also releases its WANT handle')
})

test('assessDurableManifest accepts only a matching freshly solicited RANGE proof', async (t) => {
  function rangePeer ({ response = 'matching', existingDownloader = false } = {}) {
    const wants = []
    const unwants = []
    const active = new Set()
    const originalOnRange = async () => {}
    const downloaderHandle = { id: 'downloader' }
    const localWant = { start: 0, handles: new Set(existingDownloader ? [downloaderHandle] : []) }
    const peer = {
      remotePublicKey: b4a.from(PEER_A, 'hex'),
      remoteContiguousLength: 8,
      remoteBitfield: { firstUnset: start => start },
      wants: {
        add (_index, handle) {
          const existed = localWant.handles.size > 0
          localWant.handles.add(handle)
          active.add(handle)
          handle.addWant(localWant)
          return existed
            ? null
            : { want: { start: 0, length: hypercoreWants.WANT_BATCH, any: false } }
        },
        removeBatch (_batch, handle) {
          active.delete(handle)
          localWant.handles.delete(handle)
          handle.removeWant(localWant)
        },
      },
      onrange: originalOnRange,
      onbitfield () {},
      wireWant: {
        send (message) {
          wants.push(message)
          if (response === 'none') return
          const range = response === 'matching'
            ? { drop: false, start: 0, length: 8 }
            : response === 'partial'
              ? { drop: false, start: 2, length: 2 }
              : { drop: false, start: 20, length: 1 }
          queueMicrotask(() => peer.onrange(range))
        },
      },
      wireUnwant: { send: message => unwants.push(message) },
      isActive: () => true,
    }
    return { peer, wants, unwants, active, localWant, downloaderHandle, originalOnRange }
  }

  const durabilityRef = ref(CORE_A, 2, 6, 'media')
  const matching = rangePeer()
  const matchingHarness = createCoreHarness(new Map([[CORE_A, [matching.peer]]]))
  const [first, concurrent] = await Promise.all([
    assessDurableManifest([durabilityRef], { trustedRelayKeys: [PEER_A] }, {
      ...matchingHarness.deps,
      bitfieldRefreshTimeoutMs: 50,
    }),
    assessDurableManifest([durabilityRef], { trustedRelayKeys: [PEER_A] }, {
      ...matchingHarness.deps,
      bitfieldRefreshTimeoutMs: 50,
    }),
  ])
  t.is(first.eligible, true, 'fresh matching RANGE is assessment-local hard evidence')
  t.is(concurrent.eligible, true, 'concurrent assessment deduplicates the same refresh')
  t.is(matching.wants.length, 1, 'one explicit WANT bypasses stale contiguous short-circuit')
  t.alike(matching.unwants, matching.wants, 'isolated raw WANT is symmetrically released')
  t.is(matching.peer.onrange, matching.originalOnRange, 'temporary RANGE hook is restored')
  t.is(matching.active.size, 0, 'assessment probe leaves no active ownership')

  const shared = rangePeer({ existingDownloader: true })
  const sharedHarness = createCoreHarness(new Map([[CORE_A, [shared.peer]]]))
  const sharedResult = await assessDurableManifest([durabilityRef], {
    trustedRelayKeys: [PEER_A],
  }, {
    ...sharedHarness.deps,
    bitfieldRefreshTimeoutMs: 50,
  })
  t.is(sharedResult.eligible, true, 'assessment probes beside an existing downloader WANT')
  t.is(shared.localWant.handles.has(shared.downloaderHandle), true, 'downloader handle remains registered')
  t.is(shared.localWant.handles.size, 1, 'assessment never joins full-batch LocalWants ownership')
  t.alike(shared.unwants, shared.wants, 'isolated half-probe UNWANT cannot cancel the downloader batch')

  const partial = rangePeer({ response: 'partial' })
  const partialHarness = createCoreHarness(new Map([[CORE_A, [partial.peer]]]))
  const [held, absent] = await Promise.all([
    assessDurableManifest([ref(CORE_A, 2, 4, 'media')], {
      trustedRelayKeys: [PEER_A],
    }, { ...partialHarness.deps, bitfieldRefreshTimeoutMs: 50 }),
    assessDurableManifest([ref(CORE_A, 4, 6, 'media')], {
      trustedRelayKeys: [PEER_A],
    }, { ...partialHarness.deps, bitfieldRefreshTimeoutMs: 50 }),
  ])
  t.is(held.eligible, true, 'structured RANGE evidence proves the covered concurrent ref')
  t.is(absent.eligible, false, 'same-batch waiter independently rejects its uncovered ref')
  t.is(partial.wants.length, 1, 'same-batch disjoint waiters deduplicate one WANT')

  for (const response of ['none', 'unrelated']) {
    const stale = rangePeer({ response })
    const harness = createCoreHarness(new Map([[CORE_A, [stale.peer]]]))
    const result = await assessDurableManifest([durabilityRef], {
      trustedRelayKeys: [PEER_A],
    }, {
      ...harness.deps,
      bitfieldRefreshTimeoutMs: 10,
    })
    t.is(result.eligible, false, `${response} response cannot bless stale contiguous state`)
    t.is(stale.peer.onrange, stale.originalOnRange, `${response} response leaves no hook`)
  }
})

test('isolated assessment probes preserve downloader wants across repeated assessments', async (t) => {
  const remoteWants = new hypercoreWants.RemoteWants()
  const localWants = new hypercoreWants.LocalWants({})
  const downloaderHandle = {
    wants: null,
    addWant (want) {
      if (this.wants === null) this.wants = new Set()
      this.wants.add(want)
    },
    removeWant (want) {
      this.wants?.delete(want)
      if (this.wants?.size === 0) this.wants = null
    },
  }
  const downloaderRegistration = localWants.add(2, downloaderHandle)
  t.ok(downloaderRegistration?.want, 'real LocalWants creates the downloader batch')
  remoteWants.add(downloaderRegistration.want)

  const peer = {
    remotePublicKey: b4a.from(PEER_A, 'hex'),
    remoteContiguousLength: 0,
    remoteBitfield: { firstUnset: start => start },
    wants: localWants,
    onrange: async () => {},
    onbitfield () {},
    wireWant: {
      send (message) {
        remoteWants.add(message)
        queueMicrotask(() => peer.onrange({ drop: false, start: 2, length: 4 }))
      },
    },
    wireUnwant: { send: message => remoteWants.remove(message) },
    isActive: () => true,
  }
  const harness = createCoreHarness(new Map([[CORE_A, [peer]]]))
  let result = null
  for (let i = 0; i < 600; i++) {
    result = await assessDurableManifest([ref(CORE_A, 2, 6, 'media')], {
      trustedRelayKeys: [PEER_A],
    }, {
      ...harness.deps,
      bitfieldRefreshTimeoutMs: 50,
    })
    if (!result.eligible) break
  }

  t.is(result?.eligible, true, 'all 600 fresh assessments remain eligible')
  t.is(remoteWants.size, 1, 'remote WANT count returns to the downloader baseline')
  t.is(remoteWants.all, false, 'repeated probes never degrade RemoteWants to all=true')
  t.is(remoteWants.has(2), true, 'the downloader range remains remotely requested')
  t.is(localWants.wants.size, 1, 'real LocalWants retains the downloader registration')
  t.is(downloaderHandle.wants?.size, 1, 'the downloader handle remains attached and responsive')
})

test('assessDurableManifest rejects peers split across refs and partial ranges', async (t) => {
  const media = ref(CORE_A, 0, 3, 'media')
  const thumbnail = ref(CORE_B, 5, 7, 'thumbnail')
  const split = createCoreHarness(new Map([
    [CORE_A, [peerWithBlocks(PEER_A, [0, 1, 2])]],
    [CORE_B, [peerWithBlocks(PEER_B, [5, 6])]],
  ]))
  const partial = createCoreHarness(new Map([
    [CORE_A, [peerWithBlocks(PEER_A, [0, 1])]],
  ]))

  t.is((await assessDurableManifest([media, thumbnail], {}, split.deps)).eligible, false)
  t.is((await assessDurableManifest([media], { trustedRelayKeys: [PEER_A] }, partial.deps)).eligible, false)
})

test('assessDurableManifest enforces trusted, paired, and ordinary policy categories', async (t) => {
  const media = ref(CORE_A, 0, 2, 'media')
  const makeHarness = (peers) => createCoreHarness(new Map([[CORE_A, peers]]))

  const trusted = await assessDurableManifest([media], { trustedRelayKeys: [PEER_A] }, makeHarness([
    peerWithBlocks(PEER_A, [0, 1]),
  ]).deps)
  const paired = await assessDurableManifest([media], { pairedDeviceKeys: [PEER_B] }, makeHarness([
    peerWithBlocks(PEER_B, [0, 1]),
  ]).deps)
  const ordinary = await assessDurableManifest([media], {}, makeHarness([
    peerWithBlocks(PEER_B, [0, 1]),
    peerWithBlocks(PEER_C, [0, 1]),
  ]).deps)

  t.alike(trusted, assessedPolicy({ eligible: true, trusted: [PEER_A], paired: [], ordinary: [] }))
  t.alike(paired, assessedPolicy({ eligible: true, trusted: [], paired: [PEER_B], ordinary: [] }))
  t.alike(ordinary, assessedPolicy({ eligible: true, trusted: [], paired: [], ordinary: [PEER_B, PEER_C] }))
})

test('assessDurableManifest ignores receipts, connection presence, contiguous length, and duplicate identities', async (t) => {
  const media = ref(CORE_A, 0, 2, 'media')
  const softPeer = {
    remotePublicKey: b4a.from(PEER_A, 'hex'),
    remoteContiguousLength: 99,
    receipt: { complete: true },
    connected: true,
  }
  const duplicatePartialA = peerWithBlocks(PEER_B, [0])
  const duplicatePartialB = peerWithBlocks(b4a.from(PEER_B, 'hex'), [1])
  const harness = createCoreHarness(new Map([[CORE_A, [softPeer, duplicatePartialA, duplicatePartialB]]]))

  const result = await assessDurableManifest([media], {
    trustedRelayKeys: [PEER_A],
    ordinaryRequired: 1,
  }, {
    ...harness.deps,
    receipts: [{ holderKey: PEER_A, complete: true }],
  })

  t.alike(result, assessedPolicy({ eligible: false, trusted: [], paired: [], ordinary: [] }))
})

test('assessDurableManifest rejects forged textual remote peer identities', async (t) => {
  const forgedPeer = {
    remotePublicKey: PEER_A,
    remoteBitfield: { firstUnset () { return 2 } },
  }
  const harness = createCoreHarness(new Map([[CORE_A, [forgedPeer]]]))

  const result = await assessDurableManifest([
    ref(CORE_A, 0, 2, 'media'),
  ], {
    trustedRelayKeys: [PEER_A],
    ordinaryRequired: 1,
  }, harness.deps)

  t.alike(result, assessedPolicy({ eligible: false, trusted: [], paired: [], ordinary: [] }))
  t.alike(harness.closed, [CORE_A])
})

test('assessDurableManifest fails closed on empty, missing, malformed, and throwing evidence', async (t) => {
  const media = ref(CORE_A, 0, 1, 'media')
  const missing = createCoreHarness(new Map())
  const throwsInBitfield = createCoreHarness(new Map([[CORE_A, [{
    remotePublicKey: b4a.from(PEER_A, 'hex'),
    remoteBitfield: { firstUnset () { throw new Error('bitfield unavailable') } },
  }]]]))
  const readyFailure = createCoreHarness(
    new Map([[CORE_A, [peerWithBlocks(PEER_A, [0])]]]),
    { readyErrorByCore: new Map([[CORE_A, new Error('ready failed')]]) },
  )

  t.is((await assessDurableManifest([], { ordinaryRequired: 0 }, missing.deps)).eligible, false)
  t.is((await assessDurableManifest([media], { ordinaryRequired: 0 }, missing.deps)).eligible, false)
  t.is((await assessDurableManifest([ref('bad', 0, 1)], {}, missing.deps)).eligible, false)
  t.alike(
    await assessDurableManifest([media], { ordinaryRequired: 0 }, throwsInBitfield.deps),
    failedAssessment('bitfield unavailable'),
  )
  t.alike(
    await assessDurableManifest([media], { trustedRelayKeys: [PEER_A] }, readyFailure.deps),
    failedAssessment('ready failed'),
  )
  t.alike(readyFailure.closed, [CORE_A], 'opened session closes after ready throws')
})

test('assessDurableManifest closes earlier sessions when a later core is missing', async (t) => {
  const refs = [ref(CORE_A, 0, 1), ref(CORE_B, 0, 1, 'thumbnail')]
  const harness = createCoreHarness(new Map([[CORE_A, [peerWithBlocks(PEER_A, [0])]]]))

  const result = await assessDurableManifest(refs, { trustedRelayKeys: [PEER_A] }, harness.deps)

  t.is(result.eligible, false)
  t.alike(harness.closed, [CORE_A])
})

test('assessDurableManifest bounds raw refs before deduplication or core work', async (t) => {
  let opens = 0
  const duplicateRefs = Array(257).fill(ref(CORE_A, 0, 1))
  const result = await assessDurableManifest(duplicateRefs, {}, {
    openCore () {
      opens++
      throw new Error('must not open')
    },
  })

  t.alike(result, failedAssessment('refs exceeds maximum of 256'))
  t.is(opens, 0)
})

test('assessDurableManifest stops opening cores as soon as the same-holder intersection is empty', async (t) => {
  const opened = []
  const closed = []
  const result = await assessDurableManifest([
    ref(CORE_A, 0, 2, 'media'),
    ref(CORE_B, 0, 1, 'thumbnail'),
  ], {}, {
    openCore (coreKey) {
      opened.push(coreKey)
      if (coreKey === CORE_B) throw new Error('later core must not open')
      return {
        peers: [peerWithBlocks(PEER_A, [0])],
        async ready () {},
        async close () { closed.push(coreKey) },
      }
    },
  })

  t.alike(result, assessedPolicy({ eligible: false, trusted: [], paired: [], ordinary: [] }))
  t.alike(opened, [CORE_A])
  t.alike(closed, [CORE_A])
})


test('backend root exports aggregate durability helpers', async (t) => {
  const backend = await import('../src/index.js')
  t.is(backend.canonicalDurabilityRefKey, canonicalDurabilityRefKey)
  t.is(backend.canonicalizeDurabilityRefs, canonicalizeDurabilityRefs)
  t.is(backend.intersectFullCopyHolders, intersectFullCopyHolders)
  t.is(backend.evaluateDurabilityPolicy, evaluateDurabilityPolicy)
  t.is(backend.assessDurableManifest, assessDurableManifest)
})

