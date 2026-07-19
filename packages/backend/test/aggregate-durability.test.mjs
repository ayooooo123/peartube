import assert from 'node:assert/strict'

import b4a from 'b4a'
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

test('assessUploadOffload keeps its legacy single-core response while using verified holders', async (t) => {
  const closed = []
  const core = {
    peers: [peerWithBlocks(PEER_A, [4, 5])],
    async ready () {},
    async close () { closed.push(true) },
  }
  const channel = { async listWriters () { return [] } }
  const ctx = {
    channels: new Map([['drive', channel]]),
    trustedRelayKeys: [PEER_A],
    store: { get () { return core } },
  }
  const api = createApi({ ctx })
  api.getVideoData = async () => ({
    blobsCoreKey: CORE_A,
    blobId: { blockOffset: 4, blockLength: 2, byteOffset: 0, byteLength: 1234 },
  })

  const assessment = await api.assessUploadOffload('drive', 'videos/example.mp4')

  t.alike(assessment, {
    eligible: true,
    fullCopyPeers: 1,
    relayHasFullCopy: true,
    ownDeviceHasFullCopy: false,
    minFullCopyPeers: 2,
    reasons: ['relay-full-copy'],
    blobsCoreKey: CORE_A,
    byteLength: 1234,
    reason: null,
  })
  t.alike(Object.keys(assessment), [
    'eligible',
    'fullCopyPeers',
    'relayHasFullCopy',
    'ownDeviceHasFullCopy',
    'minFullCopyPeers',
    'reasons',
    'blobsCoreKey',
    'byteLength',
    'reason',
  ])
  t.is(closed.length, 1)
})

test('assessUploadOffload preserves mixed trusted/ordinary legacy redundancy reasons', async (t) => {
  const core = {
    peers: [
      peerWithBlocks(PEER_A, [4, 5]),
      peerWithBlocks(PEER_B, [4, 5]),
    ],
    async ready () {},
    async close () {},
  }
  const ctx = {
    channels: new Map([['drive', { async listWriters () { return [] } }]]),
    trustedRelayKeys: [PEER_A],
    store: { get () { return core } },
  }
  const api = createApi({ ctx })
  api.getVideoData = async () => ({
    blobsCoreKey: CORE_A,
    blobId: { blockOffset: 4, blockLength: 2, byteOffset: 0, byteLength: 1234 },
  })

  t.alike(await api.assessUploadOffload('drive', 'videos/example.mp4'), {
    eligible: true,
    fullCopyPeers: 2,
    relayHasFullCopy: true,
    ownDeviceHasFullCopy: false,
    minFullCopyPeers: 2,
    reasons: ['relay-full-copy', 'peer-redundancy:2'],
    blobsCoreKey: CORE_A,
    byteLength: 1234,
    reason: null,
  })
})

test('assessUploadOffload preserves exact legacy empty responses for operational errors', async (t) => {
  let readyCloses = 0
  let bitfieldCloses = 0
  const readyCore = {
    peers: [peerWithBlocks(PEER_A, [4, 5])],
    async ready () { throw new Error('ready exploded') },
    async close () { readyCloses++ },
  }
  const bitfieldCore = {
    peers: [{
      remotePublicKey: b4a.from(PEER_A, 'hex'),
      remoteBitfield: { firstUnset () { throw new Error('bitfield exploded') } },
    }],
    async ready () {},
    async close () { bitfieldCloses++ },
  }

  async function assessWithStore (store) {
    const ctx = {
      channels: new Map([['drive', { async listWriters () { return [] } }]]),
      trustedRelayKeys: [PEER_A],
      store,
    }
    const api = createApi({ ctx })
    api.getVideoData = async () => ({
      blobsCoreKey: CORE_A,
      blobId: { blockOffset: 4, blockLength: 2, byteOffset: 0, byteLength: 1234 },
    })
    return api.assessUploadOffload('drive', 'videos/example.mp4')
  }

  const expected = (reason) => ({
    eligible: false,
    fullCopyPeers: 0,
    relayHasFullCopy: false,
    ownDeviceHasFullCopy: false,
    byteLength: 0,
    blobsCoreKey: null,
    reason,
  })

  t.alike(await assessWithStore({ get () { throw new Error('open exploded') } }), expected('open exploded'))
  t.alike(await assessWithStore({ get () { return readyCore } }), expected('ready exploded'))
  t.alike(await assessWithStore({ get () { return bitfieldCore } }), expected('bitfield exploded'))
  t.is(readyCloses, 1)
  t.is(bitfieldCloses, 1)
})

test('backend root exports aggregate durability helpers', async (t) => {
  const backend = await import('../src/index.js')
  t.is(backend.canonicalDurabilityRefKey, canonicalDurabilityRefKey)
  t.is(backend.canonicalizeDurabilityRefs, canonicalizeDurabilityRefs)
  t.is(backend.intersectFullCopyHolders, intersectFullCopyHolders)
  t.is(backend.evaluateDurabilityPolicy, evaluateDurabilityPolicy)
  t.is(backend.assessDurableManifest, assessDurableManifest)
})
