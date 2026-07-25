import b4a from 'b4a'
import test from 'brittle'

import { assessDurableManifest } from '../src/api.js'
import { createDurableManifest } from '../src/seed-pin/manifest.js'
import { createContentReplication } from '../src/content-replication.js'

const CHANNEL_KEY = '11'.repeat(32)
const PUBLIC_BEE_KEY = '22'.repeat(32)
const CORE_MEDIA = '33'.repeat(32)
const CORE_THUMB = '44'.repeat(32)
const PEER_A = 'a1'.repeat(32)
const PEER_B = 'b2'.repeat(32)
const PEER_C = 'c3'.repeat(32)
const CHECKPOINT_VERSION = 1

function clone (value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function baseInput (overrides = {}) {
  return {
    channelKey: CHANNEL_KEY,
    rowId: 'video-1',
    refs: [
      { coreKey: CORE_MEDIA, start: 0, end: 4, kind: 'media' },
      { coreKey: CORE_THUMB, start: 8, end: 10, kind: 'thumbnail' },
    ],
    assets: {
      media: [0],
      thumbnail: 1,
      artwork: { avatar: null, poster: null, banner: null, backdrop: null },
    },
    totalBytes: 600,
    expiresAt: Date.now() + 60_000,
    deviceKeyPair: { publicKey: b4a.alloc(32, 1), secretKey: b4a.alloc(64, 2) },
    deviceProof: b4a.alloc(64, 3),
    signedDescriptor: { test: true },
    idempotencyKey: 'job-1',
    stagedDescriptor: { title: 'Video' },
    ...overrides,
  }
}

function peerWithBlocks (peerKey, blocks) {
  const held = new Set(blocks)
  return {
    remotePublicKey: b4a.from(peerKey, 'hex'),
    remoteBitfield: {
      firstUnset (start) {
        let index = start
        while (held.has(index)) index++
        return index
      },
    },
  }
}

function createLiveRangeHarness () {
  const blocksByCoreAndPeer = new Map()
  let assessments = 0
  let closes = 0

  function setRanges (entries) {
    blocksByCoreAndPeer.clear()
    for (const [coreKey, peerKey, start, end] of entries) {
      let peers = blocksByCoreAndPeer.get(coreKey)
      if (!peers) blocksByCoreAndPeer.set(coreKey, peers = new Map())
      let blocks = peers.get(peerKey)
      if (!blocks) peers.set(peerKey, blocks = new Set())
      for (let index = start; index < end; index++) blocks.add(index)
    }
  }

  function setFullHolders (peerKeys) {
    setRanges(peerKeys.flatMap(peerKey => [
      [CORE_MEDIA, peerKey, 0, 4],
      [CORE_THUMB, peerKey, 8, 10],
    ]))
  }

  async function openCore (coreKey) {
    const peers = blocksByCoreAndPeer.get(coreKey) || new Map()
    return {
      peers: [...peers].map(([peerKey, blocks]) => peerWithBlocks(peerKey, blocks)),
      async ready () {},
      async close () { closes++ },
    }
  }

  async function assess (refs, trust, deps) {
    assessments++
    return assessDurableManifest(refs, trust, { ...deps, openCore })
  }

  return {
    setRanges,
    setFullHolders,
    assess,
    get assessments () { return assessments },
    get closes () { return closes },
  }
}

function statusFor (manifest, { state = 'accepted', bytes = 0 } = {}) {
  return {
    requestId: manifest.requestId,
    state,
    acceptedAt: 1,
    updatedAt: 1,
    completedAt: state === 'complete' ? 1 : null,
    errorCode: null,
    error: null,
    refs: manifest.refs.map((ref, index) => ({
      ...ref,
      state: state === 'complete' ? 'complete' : state === 'pinning' ? 'pinning' : 'pending',
      bytesPinned: Array.isArray(bytes) ? (bytes[index] || 0) : (index === 0 ? bytes : 0),
    })),
  }
}

function makeClient ({ onPin, onStatus, pinError, statusError, closed = false } = {}) {
  const calls = { pin: [], status: [] }
  return {
    authEnabled: true,
    closed,
    calls,
    async pin (request, options) {
      calls.pin.push({ request, options })
      if (pinError) throw pinError
      return onPin ? onPin(request, options) : statusFor(request.manifest)
    },
    async status (requestId, options) {
      calls.status.push({ requestId, options })
      if (statusError) throw statusError
      if (onStatus) return onStatus(requestId, options)
      throw new Error('status unavailable')
    },
  }
}

function createPublicationHarness ({
  announceFailures = 0,
  holdProject = null,
  onMark = null,
  onProject = null,
  onAnnounce = null,
  onFinalize = null,
} = {}) {
  const calls = []
  let remainingAnnounceFailures = announceFailures
  return {
    calls,
    publication: {
      async markDurabilityVerified (rowId, context) {
        calls.push({ method: 'markDurabilityVerified', rowId, context: clone(context) })
        if (onMark) return onMark(rowId, context)
        return { id: rowId, publicationState: 'durabilityVerified' }
      },
      async project (input) {
        calls.push({ method: 'project', input: clone(input) })
        if (holdProject) await holdProject()
        if (onProject) return onProject(input)
        return { channelKey: input.channelKey, publicBeeKey: PUBLIC_BEE_KEY, videoId: input.videoId }
      },
      async announce (input) {
        calls.push({ method: 'announce', input: clone(input) })
        if (remainingAnnounceFailures-- > 0) throw new Error('feed unavailable: secret detail')
        if (onAnnounce) return onAnnounce(input)
        return { status: 'authoritative', videos: [{ id: input.videoId }] }
      },
      async finalize (rowId, context) {
        calls.push({ method: 'finalize', rowId, context: clone(context) })
        if (onFinalize) return onFinalize(rowId, context)
        return { id: rowId, publicationState: 'published' }
      },
    },
  }
}

function checkpointFor (input, phase, overrides = {}) {
  const manifest = createDurableManifest(input)
  const projected = ['projected', 'announcing', 'announced', 'published'].includes(phase)
  const checkpoint = {
    version: CHECKPOINT_VERSION,
    revision: 1,
    phase,
    channelKey: manifest.channelKey,
    rowId: manifest.rowId,
    idempotencyKey: input.idempotencyKey,
    requestId: manifest.requestId,
    manifest: clone(manifest),
    acceptedPeerKeys: [],
    peerResults: [],
    projection: projected
      ? { channelKey: manifest.channelKey, publicBeeKey: PUBLIC_BEE_KEY, videoId: manifest.rowId }
      : null,
    announceError: null,
    ...clone(overrides),
  }
  checkpoint.peerResults = checkpoint.peerResults.map(result => ({
    ...result,
    lastInteractionRevision: result.lastInteractionRevision ?? 1,
  }))
  return checkpoint
}

function createHarness ({
  input = baseInput(),
  clients = new Map(),
  trustedRelayKeys = [],
  pairedDeviceKeys = [],
  liveRanges = createLiveRangeHarness(),
  publicationHarness = createPublicationHarness(),
  initialCheckpoint = null,
  assessDurability = null,
  onProgress = null,
  writeCheckpoint = null,
  readCheckpoint = null,
  createManifest = createDurableManifest,
  options = {},
} = {}) {
  let checkpoint = initialCheckpoint ? clone(initialCheckpoint) : null
  const checkpointWrites = []
  let pinRequestBuilds = 0
  const progress = []

  const replication = createContentReplication({
    publication: publicationHarness.publication,
    clients,
    createManifest,
    async createPinRequest ({ manifest }) {
      pinRequestBuilds++
      return Object.freeze({ requestId: manifest.requestId, manifest })
    },
    assessDurability: assessDurability || liveRanges.assess,
    assessmentDeps: {},
    getTrustedRelayKeys: () => trustedRelayKeys,
    getPairedDeviceKeys: () => pairedDeviceKeys,
    async readCheckpoint (...args) {
      if (readCheckpoint) return readCheckpoint(...args)
      return checkpoint ? clone(checkpoint) : null
    },
    async writeCheckpoint (next, context) {
      checkpointWrites.push({ checkpoint: next, context })
      if (writeCheckpoint) {
        const result = await writeCheckpoint(next, context, checkpoint)
        if (result === false) return false
        if (result && typeof result === 'object') checkpoint = clone(result)
        else checkpoint = clone(next)
        return result
      }
      const expected = checkpoint ? checkpoint.revision : null
      if (context.expectedRevision !== expected) return false
      checkpoint = clone(next)
      return clone(checkpoint)
    },
    onProgress (event) {
      progress.push(clone(event))
      if (onProgress) onProgress(event)
    },
    ordinaryRequired: 2,
    maxClients: 8,
    maxStatusAttempts: 2,
    maxPeerConcurrency: 2,
    maxConcurrentRows: 2,
    pollIntervalMs: 1,
    requestTimeoutMs: 25,
    operationTimeoutMs: 1_000,
    ...options,
  })

  return {
    input,
    clients,
    liveRanges,
    publicationHarness,
    replication,
    progress,
    checkpointWrites,
    get checkpoint () { return checkpoint },
    get pinRequestBuilds () { return pinRequestBuilds },
  }
}

test('trusted live full-range holder gates exact project, announce, and finalize order', async (t) => {
  const input = baseInput()
  const liveRanges = createLiveRangeHarness()
  const client = makeClient({
    onPin (request) {
      liveRanges.setFullHolders([PEER_A])
      return statusFor(request.manifest, { state: 'accepted', bytes: 100 })
    },
  })
  const harness = createHarness({ input, liveRanges, clients: new Map([[PEER_A, client]]), trustedRelayKeys: [PEER_A] })

  const result = await harness.replication.replicate(input)

  t.alike(result, { status: 'published', phase: 'published', requestId: harness.checkpoint.requestId })
  t.is(client.calls.pin.length, 1)
  t.is(harness.pinRequestBuilds, 1)
  t.alike(harness.publicationHarness.calls.map(call => call.method), [
    'markDurabilityVerified', 'project', 'announce', 'finalize',
  ])
  t.alike(harness.checkpointWrites.map(write => write.checkpoint.phase), [
    'replicating', 'replicating', 'durabilityVerified', 'projected', 'announcing', 'announced', 'published',
  ])
  t.alike(harness.publicationHarness.calls[0], {
    method: 'markDurabilityVerified',
    rowId: input.rowId,
    context: { channelKey: CHANNEL_KEY, idempotencyKey: input.idempotencyKey, requestId: result.requestId },
  })
  t.alike(harness.publicationHarness.calls[1].input, {
    videoId: input.rowId,
    channelKey: CHANNEL_KEY,
    idempotencyKey: input.idempotencyKey,
    requestId: result.requestId,
    stagedDescriptor: input.stagedDescriptor,
  })
  t.alike(harness.publicationHarness.calls[2].input, {
    channelKey: CHANNEL_KEY,
    publicBeeKey: PUBLIC_BEE_KEY,
    videoId: input.rowId,
    idempotencyKey: input.idempotencyKey,
    requestId: result.requestId,
  })
  t.alike(harness.publicationHarness.calls[3], {
    method: 'finalize',
    rowId: input.rowId,
    context: { channelKey: CHANNEL_KEY, idempotencyKey: input.idempotencyKey, requestId: result.requestId },
  })
  t.ok(harness.progress.some(event => event.phase === 'verifying' && event.qualifyingHolders === 1 && event.requiredHolders === 1))
  t.alike(harness.progress.at(-1), { phase: 'published' })
})

test('paired holder passes while one ordinary, split holders, and an untrusted complete relay remain pending', async (t) => {
  const cases = [
    { name: 'paired', holders: [PEER_A], paired: [PEER_A], expected: 'published' },
    { name: 'one ordinary', holders: [PEER_A], expected: 'replicationPending' },
    { name: 'untrusted relay status', holders: [PEER_A], trusted: [PEER_B], expected: 'replicationPending' },
  ]

  for (const policyCase of cases) {
    const input = baseInput({ rowId: policyCase.name })
    const liveRanges = createLiveRangeHarness()
    const client = makeClient({
      onPin (request) {
        liveRanges.setFullHolders(policyCase.holders)
        return statusFor(request.manifest, { state: 'complete', bytes: input.totalBytes })
      },
      onStatus () {
        return statusFor(createDurableManifest(input), { state: 'complete', bytes: input.totalBytes })
      },
    })
    const harness = createHarness({
      input,
      liveRanges,
      clients: new Map([[PEER_A, client]]),
      trustedRelayKeys: policyCase.trusted || [],
      pairedDeviceKeys: policyCase.paired || [],
    })
    const result = await harness.replication.replicate(input)
    t.is(result.status, policyCase.expected, policyCase.name)
  }

  const splitInput = baseInput({ rowId: 'split' })
  const splitRanges = createLiveRangeHarness()
  const splitClientA = makeClient({ onPin (request) {
    splitRanges.setRanges([
      [CORE_MEDIA, PEER_A, 0, 4],
      [CORE_THUMB, PEER_B, 8, 10],
    ])
    return statusFor(request.manifest, { state: 'complete', bytes: splitInput.totalBytes })
  }, onStatus () { return statusFor(createDurableManifest(splitInput), { state: 'complete', bytes: splitInput.totalBytes }) } })
  const splitClientB = makeClient({ onPin (request) { return statusFor(request.manifest, { state: 'complete', bytes: splitInput.totalBytes }) }, onStatus () { return statusFor(createDurableManifest(splitInput), { state: 'complete', bytes: splitInput.totalBytes }) } })
  const splitHarness = createHarness({
    input: splitInput,
    liveRanges: splitRanges,
    clients: new Map([[PEER_A, splitClientA], [PEER_B, splitClientB]]),
  })
  t.is((await splitHarness.replication.replicate(splitInput)).status, 'replicationPending')
})

test('two ordinary same full holders pass and exact canonical refs reach every assessment', async (t) => {
  const input = baseInput()
  const manifest = createDurableManifest(input)
  const liveRanges = createLiveRangeHarness()
  const calls = []
  const assess = async (refs, trust, deps) => {
    calls.push({ refs: clone(refs), trust: clone(trust) })
    return liveRanges.assess(refs, trust, deps)
  }
  const clients = new Map([PEER_A, PEER_B].map(peerKey => [peerKey, makeClient({
    onPin (request) {
      liveRanges.setFullHolders([PEER_A, PEER_B])
      return statusFor(request.manifest)
    },
  })]))
  const harness = createHarness({ input, liveRanges, clients, assessDurability: assess })

  t.is((await harness.replication.replicate(input)).status, 'published')
  t.ok(calls.length >= 2)
  for (const call of calls) {
    t.alike(call.refs, manifest.refs)
    t.alike(call.trust, { trustedRelayKeys: [], pairedDeviceKeys: [], ordinaryRequired: 2 })
  }
})

test('accepted, complete, and receipt-like hints never substitute for live bitfields', async (t) => {
  const input = baseInput()
  const client = makeClient({
    onPin (request) {
      const status = statusFor(request.manifest, { state: 'accepted', bytes: input.totalBytes })
      status.receipt = 'forged-complete-receipt'
      return status
    },
    onStatus () {
      const status = statusFor(createDurableManifest(input), { state: 'complete', bytes: input.totalBytes * 10 })
      status.contiguousLength = Number.MAX_SAFE_INTEGER
      return status
    },
  })
  const harness = createHarness({ input, clients: new Map([[PEER_A, client]]), trustedRelayKeys: [PEER_A] })

  const result = await harness.replication.replicate(input)
  t.alike(result, { status: 'replicationPending', phase: 'replicationPending', requestId: harness.checkpoint.requestId })
  t.is(harness.publicationHarness.calls.length, 0)
  t.is(harness.checkpoint.phase, 'replicating')
})

test('accepted peer disconnected before assessment remains pending', async (t) => {
  const input = baseInput()
  const clients = new Map()
  const client = makeClient({ onPin (request) {
    clients.delete(PEER_A)
    return statusFor(request.manifest, { state: 'complete', bytes: input.totalBytes })
  } })
  clients.set(PEER_A, client)
  const harness = createHarness({ input, clients, trustedRelayKeys: [PEER_A] })

  t.is((await harness.replication.replicate(input)).status, 'replicationPending')
  t.is(client.calls.status.length, 0)
  t.is(harness.publicationHarness.calls.length, 0)
})

test('assessment throw fails closed and leaves a retryable replication checkpoint', async (t) => {
  const input = baseInput()
  const client = makeClient({ onPin: request => statusFor(request.manifest) })
  const harness = createHarness({
    input,
    clients: new Map([[PEER_A, client]]),
    trustedRelayKeys: [PEER_A],
    assessDurability: async () => { throw new Error('bitfield proof secret') },
  })

  const result = await harness.replication.replicate(input)
  t.is(result.status, 'replicationPending')
  t.is(harness.checkpoint.phase, 'replicating')
  t.is(harness.publicationHarness.calls.length, 0)
})

test('restart resumes each checkpoint stage without repeating completed boundaries', async (t) => {
  const phases = [
    ['durabilityVerified', ['markDurabilityVerified', 'project', 'announce', 'finalize']],
    ['projected', ['announce', 'finalize']],
    ['announcing', ['announce', 'finalize']],
    ['announced', ['finalize']],
    ['published', []],
  ]

  for (const [phase, expectedMethods] of phases) {
    const input = baseInput({ rowId: `restart-${phase}` })
    const initialCheckpoint = checkpointFor(input, phase)
    const harness = createHarness({ input, initialCheckpoint })
    const result = await harness.replication.replicate(input)
    t.is(result.status, 'published', phase)
    t.alike(harness.publicationHarness.calls.map(call => call.method), expectedMethods, phase)
    t.is(harness.liveRanges.assessments, 0, phase)
    t.is(harness.pinRequestBuilds, 0, phase)
  }

  const input = baseInput({ rowId: 'restart-replicating' })
  const liveRanges = createLiveRangeHarness()
  const client = makeClient({ onStatus () {
    liveRanges.setFullHolders([PEER_A])
    return statusFor(createDurableManifest(input), { state: 'complete', bytes: input.totalBytes })
  } })
  const initialCheckpoint = checkpointFor(input, 'replicating', {
    acceptedPeerKeys: [PEER_A],
    peerResults: [{ peerKey: PEER_A, outcome: 'accepted' }],
  })
  const harness = createHarness({ input, liveRanges, clients: new Map([[PEER_A, client]]), trustedRelayKeys: [PEER_A], initialCheckpoint })
  t.is((await harness.replication.replicate(input)).status, 'published')
  t.is(client.calls.pin.length, 0)
  t.is(client.calls.status.length, 1)
})

test('announce failure persists bounded retry state and restart retries announce only', async (t) => {
  const input = baseInput()
  const liveRanges = createLiveRangeHarness()
  const client = makeClient({ onPin (request) {
    liveRanges.setFullHolders([PEER_A])
    return statusFor(request.manifest)
  } })
  const publicationHarness = createPublicationHarness({ announceFailures: 1 })
  const harness = createHarness({ input, liveRanges, publicationHarness, clients: new Map([[PEER_A, client]]), trustedRelayKeys: [PEER_A] })

  const first = await harness.replication.replicate(input)
  t.alike(first, { status: 'announceRetryable', phase: 'announcing', requestId: harness.checkpoint.requestId, retryable: true })
  t.is(harness.checkpoint.phase, 'announcing')
  t.alike(harness.checkpoint.announceError, { code: 'ANNOUNCE_FAILED', attempts: 1 })
  t.absent(JSON.stringify(harness.checkpoint).includes('secret detail'))

  const second = await harness.replication.replicate(input)
  t.is(second.status, 'published')
  t.is(client.calls.pin.length, 1)
  t.is(harness.liveRanges.assessments, 2)
  t.alike(publicationHarness.calls.map(call => call.method), [
    'markDurabilityVerified', 'project', 'announce', 'announce', 'finalize',
  ])
})

test('publication phases require authoritative Plan1 result shapes before checkpoint advance', async (t) => {
  const announceInput = baseInput({ rowId: 'announce-deferred', idempotencyKey: 'announce-deferred-job' })
  let announceCalls = 0
  const announcePublication = createPublicationHarness({
    onAnnounce (input) {
      announceCalls++
      if (announceCalls === 1) return { status: 'deferred', videos: [] }
      return { status: 'authoritative', videos: [{ id: input.videoId }] }
    },
  })
  const announceHarness = createHarness({
    input: announceInput,
    initialCheckpoint: checkpointFor(announceInput, 'projected'),
    publicationHarness: announcePublication,
  })
  t.is((await announceHarness.replication.replicate(announceInput)).status, 'announceRetryable')
  t.is(announceHarness.checkpoint.phase, 'announcing')
  t.is((await announceHarness.replication.replicate(announceInput)).status, 'published')
  t.is(announceCalls, 2)

  const finalizeInput = baseInput({ rowId: 'finalize-pending', idempotencyKey: 'finalize-pending-job' })
  let finalizeCalls = 0
  const finalizePublication = createPublicationHarness({
    onFinalize (rowId) {
      finalizeCalls++
      return {
        id: rowId,
        publicationState: finalizeCalls === 1 ? 'durabilityVerified' : 'published',
      }
    },
  })
  const finalizeHarness = createHarness({
    input: finalizeInput,
    initialCheckpoint: checkpointFor(finalizeInput, 'announced'),
    publicationHarness: finalizePublication,
  })
  t.is((await finalizeHarness.replication.replicate(finalizeInput)).status, 'replicationPending')
  t.is(finalizeHarness.checkpoint.phase, 'announced')
  t.is((await finalizeHarness.replication.replicate(finalizeInput)).status, 'published')
  t.is(finalizeCalls, 2)

  const markInput = baseInput({ rowId: 'mark-malformed', idempotencyKey: 'mark-malformed-job' })
  const markPublication = createPublicationHarness({
    onMark: rowId => ({ id: rowId, publicationState: 'replicationPending' }),
  })
  const markHarness = createHarness({
    input: markInput,
    initialCheckpoint: checkpointFor(markInput, 'durabilityVerified'),
    publicationHarness: markPublication,
  })
  t.is((await markHarness.replication.replicate(markInput)).status, 'replicationPending')
  t.is(markHarness.checkpoint.phase, 'durabilityVerified')
  t.alike(markPublication.calls.map(call => call.method), ['markDurabilityVerified'])

  const projectInput = baseInput({ rowId: 'project-malformed', idempotencyKey: 'project-malformed-job' })
  const projectPublication = createPublicationHarness({
    onProject: input => ({ channelKey: input.channelKey, publicBeeKey: PUBLIC_BEE_KEY, videoId: 'wrong-row' }),
  })
  const projectHarness = createHarness({
    input: projectInput,
    initialCheckpoint: checkpointFor(projectInput, 'durabilityVerified'),
    publicationHarness: projectPublication,
  })
  t.is((await projectHarness.replication.replicate(projectInput)).status, 'replicationPending')
  t.is(projectHarness.checkpoint.phase, 'durabilityVerified')
  t.alike(projectPublication.calls.map(call => call.method), ['markDurabilityVerified', 'project'])
})

test('publication confirmation inspects only bounded allowlisted own data fields', async (t) => {
  const largeInput = baseInput({ rowId: 'large-channel', idempotencyKey: 'large-channel-job' })
  let unrelatedReads = 0
  const unrelatedVideo = {}
  Object.defineProperty(unrelatedVideo, 'id', {
    enumerable: true,
    get () {
      unrelatedReads++
      throw new Error('unrelated channel video must not be inspected')
    },
  })
  const videos = new Array(9000).fill(null)
  videos[0] = unrelatedVideo
  const largePublication = createPublicationHarness({
    onAnnounce () {
      const result = { status: 'authoritative', videos }
      Object.defineProperty(result, 'unrelated', {
        enumerable: true,
        get () {
          unrelatedReads++
          throw new Error('unrelated result field must not be inspected')
        },
      })
      return result
    },
  })
  const largeHarness = createHarness({
    input: largeInput,
    initialCheckpoint: checkpointFor(largeInput, 'projected'),
    publicationHarness: largePublication,
  })
  t.is((await largeHarness.replication.replicate(largeInput)).status, 'published')
  t.is(unrelatedReads, 0)

  const accessorInput = baseInput({ rowId: 'announce-accessor', idempotencyKey: 'announce-accessor-job' })
  let statusReads = 0
  const accessorPublication = createPublicationHarness({
    onAnnounce () {
      const result = {}
      Object.defineProperty(result, 'status', {
        enumerable: true,
        get () {
          statusReads++
          return 'authoritative'
        },
      })
      return result
    },
  })
  const accessorHarness = createHarness({
    input: accessorInput,
    initialCheckpoint: checkpointFor(accessorInput, 'projected'),
    publicationHarness: accessorPublication,
  })
  t.is((await accessorHarness.replication.replicate(accessorInput)).status, 'announceRetryable')
  t.is(accessorHarness.checkpoint.phase, 'announcing')
  t.is(statusReads, 0)
})

test('a concurrent higher checkpoint returned by CAS cannot be regressed by announce failure', async (t) => {
  const input = baseInput({ rowId: 'cas-announce', idempotencyKey: 'cas-announce-job' })
  const initialCheckpoint = checkpointFor(input, 'announcing')
  const publicationHarness = createPublicationHarness({ announceFailures: 1 })
  let returnedConcurrentAnnounce = false
  const harness = createHarness({
    input,
    initialCheckpoint,
    publicationHarness,
    writeCheckpoint (next, context, current) {
      if (!returnedConcurrentAnnounce && next.phase === 'announcing' && next.announceError !== null) {
        returnedConcurrentAnnounce = true
        return checkpointFor(input, 'announced', { revision: current.revision + 1 })
      }
      return next
    },
  })

  const result = await harness.replication.replicate(input)
  t.is(result.status, 'published')
  t.is(harness.checkpoint.phase, 'published')
  t.alike(publicationHarness.calls.map(call => call.method), ['announce', 'finalize'])
})

test('authoritative CAS winners replace live peer history before further work', async (t) => {
  for (const winnerPhase of ['replicating', 'durabilityVerified']) {
    const input = baseInput({
      rowId: `cas-history-${winnerPhase}`,
      idempotencyKey: `cas-history-${winnerPhase}-job`,
    })
    const manifest = createDurableManifest(input)
    const rejectedA = makeClient({
      onPin: request => statusFor(request.manifest, { state: 'rejected' }),
    })
    const acceptedB = makeClient({
      onStatus: () => statusFor(manifest, { state: 'pinning', bytes: 1 }),
    })
    let returnedWinner = false
    const harness = createHarness({
      input,
      clients: new Map([[PEER_A, rejectedA], [PEER_B, acceptedB]]),
      initialCheckpoint: checkpointFor(input, 'replicating', { revision: 1 }),
      options: { maxClients: 1, maxStatusAttempts: 1 },
      writeCheckpoint (next) {
        if (!returnedWinner && next.peerResults.some(result => result.peerKey === PEER_A)) {
          returnedWinner = true
          return checkpointFor(input, winnerPhase, {
            revision: next.revision + 1,
            acceptedPeerKeys: [PEER_B],
            peerResults: [
              { peerKey: PEER_A, outcome: 'rejected', lastInteractionRevision: 2 },
              { peerKey: PEER_B, outcome: 'accepted', lastInteractionRevision: 1 },
            ],
          })
        }
        return next
      },
    })

    const result = await harness.replication.replicate(input)
    t.is(rejectedA.calls.pin.length, 1, winnerPhase)
    t.is(acceptedB.calls.pin.length, 0, winnerPhase)
    if (winnerPhase === 'replicating') {
      t.is(result.status, 'replicationPending')
      t.is(acceptedB.calls.status.length, 1)
    } else {
      t.is(result.status, 'published')
      t.is(acceptedB.calls.status.length, 0)
    }
    t.ok(harness.checkpoint.acceptedPeerKeys.includes(PEER_B), winnerPhase)
    t.ok(harness.checkpoint.peerResults.some(entry =>
      entry.peerKey === PEER_A && entry.outcome === 'rejected'), winnerPhase)
    t.ok(harness.checkpoint.peerResults.some(entry =>
      entry.peerKey === PEER_B && entry.outcome === 'accepted'), winnerPhase)
  }
})

test('same row calls serialize, while different rows obey max concurrency', async (t) => {
  const input = baseInput()
  const liveRanges = createLiveRangeHarness()
  const client = makeClient({ onPin (request) {
    liveRanges.setFullHolders([PEER_A])
    return statusFor(request.manifest)
  } })
  const harness = createHarness({ input, liveRanges, clients: new Map([[PEER_A, client]]), trustedRelayKeys: [PEER_A] })
  const [first, second] = await Promise.all([
    harness.replication.replicate(input),
    harness.replication.replicate(input),
  ])
  t.is(first.status, 'published')
  t.is(second.status, 'published')
  t.is(client.calls.pin.length, 1)
  t.alike(harness.publicationHarness.calls.map(call => call.method), ['markDurabilityVerified', 'project', 'announce', 'finalize'])

  const checkpoints = new Map()
  const releases = []
  let active = 0
  let maximum = 0
  const publication = createPublicationHarness()
  const replication = createContentReplication({
    publication: publication.publication,
    clients: new Map(),
    createManifest: createDurableManifest,
    createPinRequest: async () => { throw new Error('unreachable') },
    assessDurability: async () => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise(resolve => releases.push(resolve))
      active--
      return { eligible: false, trusted: [], paired: [], ordinary: [], status: 'ok', error: null }
    },
    getTrustedRelayKeys: () => [],
    getPairedDeviceKeys: () => [],
    readCheckpoint: ({ rowId }) => clone(checkpoints.get(rowId) || null),
    writeCheckpoint: (next) => { checkpoints.set(next.rowId, clone(next)); return clone(next) },
    maxConcurrentRows: 2,
    maxClients: 1,
    maxStatusAttempts: 1,
    maxPeerConcurrency: 1,
    pollIntervalMs: 1,
    requestTimeoutMs: 20,
    operationTimeoutMs: 1_000,
  })
  const runs = ['a', 'b', 'c'].map(rowId => replication.replicate(baseInput({ rowId, idempotencyKey: `job-${rowId}` })))
  for (let index = 0; index < 20 && releases.length < 2; index++) await Promise.resolve()
  t.is(releases.length, 2)
  t.is(maximum, 2)
  releases.splice(0).forEach(resolve => resolve())
  for (let index = 0; index < 100 && releases.length < 1; index++) await Promise.resolve()
  t.is(releases.length, 1)
  releases.splice(0).forEach(resolve => resolve())
  await Promise.all(runs)
  t.is(maximum, 2)
})

test('manifest builders run inside bounded row locks and aborted waiters unlink cleanly', async (t) => {
  const waitUntil = async predicate => {
    for (let index = 0; index < 100 && !predicate(); index++) await Promise.resolve()
    return predicate()
  }
  const createReplication = ({ createManifest, maxConcurrentRows = 2 }) => {
    const checkpoints = new Map()
    return createContentReplication({
      publication: createPublicationHarness().publication,
      clients: new Map(),
      createManifest,
      createPinRequest: async () => { throw new Error('unreachable') },
      assessDurability: async () => ({
        eligible: false,
        trusted: [],
        paired: [],
        ordinary: [],
        status: 'ok',
        error: null,
      }),
      getTrustedRelayKeys: () => [],
      getPairedDeviceKeys: () => [],
      readCheckpoint: ({ rowId }) => clone(checkpoints.get(rowId) || null),
      writeCheckpoint: next => {
        checkpoints.set(next.rowId, clone(next))
        return clone(next)
      },
      maxConcurrentRows,
      maxClients: 1,
      maxStatusAttempts: 1,
      maxPeerConcurrency: 1,
      requestTimeoutMs: 20,
      operationTimeoutMs: 1_000,
    })
  }

  const sameWaiters = []
  let sameActive = 0
  let sameMaximum = 0
  const sameReplication = createReplication({
    async createManifest (input) {
      sameActive++
      sameMaximum = Math.max(sameMaximum, sameActive)
      await new Promise(resolve => sameWaiters.push(resolve))
      sameActive--
      return createDurableManifest(input)
    },
  })
  const sameInput = baseInput({ rowId: 'builder-same', idempotencyKey: 'builder-same-job' })
  const sameFirst = sameReplication.replicate(sameInput)
  const sameSecond = sameReplication.replicate(baseInput({ rowId: 'builder-same', idempotencyKey: 'builder-same-job' }))
  t.ok(await waitUntil(() => sameWaiters.length === 1))
  t.is(sameMaximum, 1)
  sameWaiters.shift()()
  t.ok(await waitUntil(() => sameWaiters.length === 1))
  t.is(sameMaximum, 1)
  sameWaiters.shift()()
  await Promise.all([sameFirst, sameSecond])

  const differentWaiters = []
  let differentActive = 0
  let differentMaximum = 0
  const differentReplication = createReplication({
    maxConcurrentRows: 2,
    async createManifest (input) {
      differentActive++
      differentMaximum = Math.max(differentMaximum, differentActive)
      await new Promise(resolve => differentWaiters.push(resolve))
      differentActive--
      return createDurableManifest(input)
    },
  })
  const differentRuns = ['builder-a', 'builder-b', 'builder-c'].map(rowId =>
    differentReplication.replicate(baseInput({ rowId, idempotencyKey: `${rowId}-job` })))
  t.ok(await waitUntil(() => differentWaiters.length === 2))
  t.is(differentMaximum, 2)
  differentWaiters.splice(0).forEach(resolve => resolve())
  t.ok(await waitUntil(() => differentWaiters.length === 1))
  differentWaiters.shift()()
  await Promise.all(differentRuns)

  const abortWaiters = []
  let abortBuilds = 0
  const abortReplication = createReplication({
    maxConcurrentRows: 1,
    async createManifest (input) {
      abortBuilds++
      await new Promise(resolve => abortWaiters.push(resolve))
      return createDurableManifest(input)
    },
  })
  const abortInput = baseInput({ rowId: 'builder-abort', idempotencyKey: 'builder-abort-job' })
  const owner = abortReplication.replicate(abortInput)
  t.ok(await waitUntil(() => abortWaiters.length === 1))
  const controller = new AbortController()
  const aborted = abortReplication.replicate(
    baseInput({ rowId: 'builder-abort', idempotencyKey: 'builder-abort-job' }),
    { signal: controller.signal },
  )
  const third = abortReplication.replicate(
    baseInput({ rowId: 'builder-abort', idempotencyKey: 'builder-abort-job' }),
  )
  controller.abort()
  const abortedResult = await Promise.race([
    aborted,
    new Promise(resolve => setTimeout(() => resolve({ status: 'test-timeout' }), 50)),
  ])
  t.is(abortedResult.status, 'replicationPending')
  t.is(abortBuilds, 1, 'aborted keyed waiter never enters the builder')
  abortWaiters.shift()()
  await owner
  t.ok(await waitUntil(() => abortWaiters.length === 1))
  abortWaiters.shift()()
  await third
  const afterCleanup = abortReplication.replicate(
    baseInput({ rowId: 'builder-abort', idempotencyKey: 'builder-abort-job' }),
  )
  t.ok(await waitUntil(() => abortWaiters.length === 1))
  abortWaiters.shift()()
  await afterCleanup
  t.is(abortBuilds, 3, 'later calls proceed after cancelled and completed keyed waiters')
})

test('mismatched, stale, or malformed checkpoints fail closed before network or publication work', async (t) => {
  const input = baseInput()
  const valid = checkpointFor(input, 'replicating')
  const invalid = [
    { ...valid, version: 2 },
    { ...valid, phase: 'uploading' },
    { ...valid, requestId: 'ff'.repeat(32) },
    { ...valid, manifest: { ...valid.manifest, rowId: 'other-row' } },
    { ...valid, idempotencyKey: 'other-job' },
    {
      ...valid,
      peerResults: [{ peerKey: PEER_A, outcome: 'transportError', lastInteractionRevision: 0 }],
    },
    {
      ...valid,
      peerResults: [{ peerKey: PEER_A, outcome: 'transportError', lastInteractionRevision: 2 }],
    },
    {
      ...valid,
      peerResults: [{ peerKey: PEER_A, outcome: 'transportError', lastInteractionRevision: Number.MAX_SAFE_INTEGER + 1 }],
    },
  ]

  for (const initialCheckpoint of invalid) {
    const client = makeClient()
    const harness = createHarness({ input, initialCheckpoint, clients: new Map([[PEER_A, client]]) })
    await t.exception(harness.replication.replicate(input), /checkpoint/i)
    t.is(client.calls.pin.length, 0)
    t.is(harness.liveRanges.assessments, 0)
    t.is(harness.publicationHarness.calls.length, 0)
  }
})

test('descriptor snapshots reject accessors and dangerous data before side effects', async (t) => {
  const input = baseInput({ rowId: 'descriptor-checkpoint', idempotencyKey: 'descriptor-checkpoint-job' })
  const accessorCheckpoint = checkpointFor(input, 'projected')
  let phaseReads = 0
  Object.defineProperty(accessorCheckpoint, 'phase', {
    enumerable: true,
    get () {
      phaseReads++
      return phaseReads === 1 ? 'projected' : 'published'
    },
  })
  const checkpointHarness = createHarness({
    input,
    readCheckpoint: () => accessorCheckpoint,
  })
  await t.exception(checkpointHarness.replication.replicate(input), /checkpoint/i)
  t.is(phaseReads, 0)
  t.is(checkpointHarness.publicationHarness.calls.length, 0)

  const accessorInput = baseInput({ rowId: 'descriptor-input', idempotencyKey: 'descriptor-input-job' })
  let rowReads = 0
  Object.defineProperty(accessorInput, 'rowId', {
    enumerable: true,
    get () {
      rowReads++
      return 'descriptor-input'
    },
  })
  const inputHarness = createHarness()
  let inputError = null
  try {
    inputHarness.replication.replicate(accessorInput)
  } catch (error) {
    inputError = error
  }
  t.ok(/data propert|unsupported/i.test(inputError?.message || ''))
  t.is(rowReads, 0)
  t.is(inputHarness.publicationHarness.calls.length, 0)

  const dangerousInput = baseInput({ rowId: 'dangerous-input', idempotencyKey: 'dangerous-input-job' })
  Object.defineProperty(dangerousInput.signedDescriptor, '__proto__', {
    value: { polluted: true },
    enumerable: true,
  })
  let dangerousError = null
  try {
    inputHarness.replication.replicate(dangerousInput)
  } catch (error) {
    dangerousError = error
  }
  t.ok(/unsupported key/i.test(dangerousError?.message || ''))

  const extendedBytesInput = baseInput({ rowId: 'extended-bytes', idempotencyKey: 'extended-bytes-job' })
  Object.defineProperty(extendedBytesInput.deviceProof, Symbol('hidden'), {
    value: true,
    enumerable: true,
  })
  let byteError = null
  try {
    inputHarness.replication.replicate(extendedBytesInput)
  } catch (error) {
    byteError = error
  }
  t.ok(/unextended byte view/i.test(byteError?.message || ''))

  const manifestInput = baseInput({ rowId: 'descriptor-manifest', idempotencyKey: 'descriptor-manifest-job' })
  let requestReads = 0
  const manifestHarness = createHarness({
    input: manifestInput,
    createManifest () {
      const result = { ...createDurableManifest(manifestInput) }
      Object.defineProperty(result, 'requestId', {
        enumerable: true,
        get () {
          requestReads++
          return createDurableManifest(manifestInput).requestId
        },
      })
      return result
    },
  })
  let manifestError = null
  try {
    await manifestHarness.replication.replicate(manifestInput)
  } catch (error) {
    manifestError = error
  }
  t.ok(/data propert|manifest builder/i.test(manifestError?.message || ''))
  t.is(requestReads, 0)
  t.is(manifestHarness.publicationHarness.calls.length, 0)
})

test('status timeouts, aborts, closed clients, and transport errors are bounded soft failures', async (t) => {
  const input = baseInput()
  const hanging = makeClient({
    onPin: request => statusFor(request.manifest),
    onStatus: () => new Promise(() => {}),
  })
  const timeoutHarness = createHarness({
    input,
    clients: new Map([[PEER_A, hanging]]),
    trustedRelayKeys: [PEER_A],
    options: { maxStatusAttempts: 1, requestTimeoutMs: 5, operationTimeoutMs: 100 },
  })
  t.is((await timeoutHarness.replication.replicate(input)).status, 'replicationPending')
  t.is(hanging.calls.status.length, 1)
  t.is(hanging.calls.status[0].options.timeout, 5)

  const controller = new AbortController()
  const aborting = makeClient({
    onPin: request => statusFor(request.manifest),
    onStatus: () => new Promise(() => {}),
  })
  const abortHarness = createHarness({
    input: baseInput({ rowId: 'abort', idempotencyKey: 'abort-job' }),
    clients: new Map([[PEER_A, aborting]]),
    trustedRelayKeys: [PEER_A],
    options: { maxStatusAttempts: 3, requestTimeoutMs: 100, operationTimeoutMs: 500 },
  })
  setTimeout(() => controller.abort(), 5)
  t.is((await abortHarness.replication.replicate(abortHarness.input, { signal: controller.signal })).status, 'replicationPending')
  t.is(aborting.calls.status.length, 1)

  const closed = makeClient({ closed: true })
  const transport = makeClient({ pinError: new Error('transport secret') })
  const errorsHarness = createHarness({
    input: baseInput({ rowId: 'errors', idempotencyKey: 'errors-job' }),
    clients: new Map([[PEER_A, closed], [PEER_B, transport]]),
  })
  t.is((await errorsHarness.replication.replicate(errorsHarness.input)).status, 'replicationPending')
  t.is(closed.calls.pin.length, 0)
  t.is(transport.calls.pin.length, 1)
  t.alike(errorsHarness.checkpoint.peerResults, [{ peerKey: PEER_B, outcome: 'transportError', lastInteractionRevision: 2 }])
})

test('max clients and status attempts bound work with one canonical request per run', async (t) => {
  const input = baseInput()
  const clients = new Map()
  for (const peerKey of [PEER_C, PEER_A, PEER_B, 'd4'.repeat(32)]) {
    clients.set(peerKey, makeClient({
      onPin: request => statusFor(request.manifest),
      onStatus: () => statusFor(createDurableManifest(input), { state: 'pinning', bytes: 1 }),
    }))
  }
  clients.set('NOT-A-REMOTE-KEY', makeClient())
  const harness = createHarness({
    input,
    clients,
    options: { maxClients: 2, maxStatusAttempts: 3, maxPeerConcurrency: 1 },
  })

  t.is((await harness.replication.replicate(input)).status, 'replicationPending')
  t.is(harness.pinRequestBuilds, 1)
  t.alike([...clients].filter(([, client]) => client.calls.pin.length > 0).map(([key]) => key), [PEER_A, PEER_B])
  t.is(clients.get(PEER_A).calls.status.length, 3)
  t.is(clients.get(PEER_B).calls.status.length, 3)
  t.is(clients.get(PEER_C).calls.status.length, 0)
})

test('client cap gives first chance by trusted, paired, ordinary policy before attempted peers', async (t) => {
  const cases = [
    { name: 'trusted', trusted: [PEER_C, 'e5'.repeat(32)], paired: [], initialCheckpoint: null },
    { name: 'paired', trusted: [], paired: [PEER_C, 'e5'.repeat(32)], initialCheckpoint: null },
    {
      name: 'unattempted-trusted-before-accepted-ordinary',
      trusted: [PEER_C],
      paired: [],
      initialCheckpoint: 'accepted-ordinary',
    },
    {
      name: 'unattempted-paired-before-accepted-trusted',
      trusted: [PEER_A],
      paired: [PEER_C],
      initialCheckpoint: 'accepted-trusted',
    },
  ]

  for (const policyCase of cases) {
    const input = baseInput({
      rowId: `priority-${policyCase.name}`,
      idempotencyKey: `priority-${policyCase.name}-job`,
    })
    const liveRanges = createLiveRangeHarness()
    const ordinary = makeClient({
      onPin: request => statusFor(request.manifest),
      onStatus: () => statusFor(createDurableManifest(input), { state: 'pinning', bytes: 1 }),
    })
    const priority = makeClient({
      onPin (request) {
        liveRanges.setFullHolders([PEER_C])
        return statusFor(request.manifest, { state: 'complete', bytes: input.totalBytes })
      },
    })
    const clients = new Map([
      [PEER_A, ordinary],
      ['MALFORMED-REMOTE-KEY', makeClient()],
      [PEER_C, priority],
    ])
    const initialCheckpoint = policyCase.initialCheckpoint
      ? checkpointFor(input, 'replicating', {
          acceptedPeerKeys: [PEER_A],
          peerResults: [{ peerKey: PEER_A, outcome: 'accepted' }],
        })
      : null
    const harness = createHarness({
      input,
      clients,
      liveRanges,
      trustedRelayKeys: policyCase.trusted,
      pairedDeviceKeys: policyCase.paired,
      initialCheckpoint,
      options: { maxClients: 1, maxStatusAttempts: 1 },
    })

    const expectedStatus = policyCase.expectedStatus || 'published'
    t.is((await harness.replication.replicate(input)).status, expectedStatus, policyCase.name)
    t.is(priority.calls.pin.length, expectedStatus === 'published' ? 1 : 0, policyCase.name)
    t.is(ordinary.calls.pin.length, 0, policyCase.name)
    t.is(ordinary.calls.status.length, expectedStatus === 'published' ? 0 : 1, policyCase.name)
  }
})

test('status interactions rotate accepted peers and never-attempted policy peers get first chance', async (t) => {
  const laterInput = baseInput({ rowId: 'later-trusted', idempotencyKey: 'later-trusted-job' })
  const laterRanges = createLiveRangeHarness()
  const trustedKeys = []
  const acceptedOrdinary = makeClient({
    onPin: request => statusFor(request.manifest),
    onStatus: () => statusFor(createDurableManifest(laterInput), { state: 'pinning', bytes: 1 }),
  })
  const laterTrusted = makeClient({ onPin (request) {
    laterRanges.setFullHolders([PEER_C])
    return statusFor(request.manifest, { state: 'complete', bytes: laterInput.totalBytes })
  } })
  const laterClients = new Map([[PEER_A, acceptedOrdinary]])
  const laterHarness = createHarness({
    input: laterInput,
    clients: laterClients,
    liveRanges: laterRanges,
    trustedRelayKeys: trustedKeys,
    options: { maxClients: 1, maxStatusAttempts: 1 },
  })

  t.is((await laterHarness.replication.replicate(laterInput)).status, 'replicationPending')
  t.is(acceptedOrdinary.calls.status.length, 1)
  t.is(laterHarness.checkpoint.peerResults[0].lastInteractionRevision, 3)
  trustedKeys.push(PEER_C)
  laterClients.set(PEER_C, laterTrusted)
  t.is((await laterHarness.replication.replicate(laterInput)).status, 'published')
  t.is(laterTrusted.calls.pin.length, 1)
  t.is(acceptedOrdinary.calls.status.length, 1, 'attempted accepted ordinary yields to unattempted trusted peer')

  const rotateInput = baseInput({ rowId: 'accepted-rotation', idempotencyKey: 'accepted-rotation-job' })
  const rotateManifest = createDurableManifest(rotateInput)
  const acceptedA = makeClient({
    onStatus: () => statusFor(rotateManifest, { state: 'pinning', bytes: 1 }),
  })
  const acceptedB = makeClient({
    onStatus: () => statusFor(rotateManifest, { state: 'pinning', bytes: 1 }),
  })
  const rotateHarness = createHarness({
    input: rotateInput,
    clients: new Map([[PEER_A, acceptedA], [PEER_B, acceptedB]]),
    initialCheckpoint: checkpointFor(rotateInput, 'replicating', {
      revision: 3,
      acceptedPeerKeys: [PEER_A, PEER_B],
      peerResults: [
        { peerKey: PEER_A, outcome: 'accepted', lastInteractionRevision: 1 },
        { peerKey: PEER_B, outcome: 'accepted', lastInteractionRevision: 2 },
      ],
    }),
    options: { maxClients: 1, maxStatusAttempts: 1 },
  })

  t.is((await rotateHarness.replication.replicate(rotateInput)).status, 'replicationPending')
  t.is(acceptedA.calls.status.length, 1)
  t.is(acceptedB.calls.status.length, 0)
  t.is((await rotateHarness.replication.replicate(rotateInput)).status, 'replicationPending')
  t.is(acceptedA.calls.status.length, 1)
  t.is(acceptedB.calls.status.length, 1, 'oldest accepted interaction rotates into the bounded slot')
})

test('progress is per-peer monotonic, clamped, structured, and callback throws are ignored', async (t) => {
  const input = baseInput()
  const liveRanges = createLiveRangeHarness()
  let statusCalls = 0
  const client = makeClient({
    onPin: request => statusFor(request.manifest, { state: 'accepted', bytes: 100 }),
    onStatus () {
      statusCalls++
      if (statusCalls === 2) liveRanges.setFullHolders([PEER_A])
      return statusFor(createDurableManifest(input), {
        state: statusCalls === 1 ? 'pinning' : 'complete',
        bytes: statusCalls === 1 ? 50 : 9_999,
      })
    },
  })
  const harness = createHarness({
    input,
    liveRanges,
    clients: new Map([[PEER_A, client]]),
    trustedRelayKeys: [PEER_A],
    onProgress () { throw new Error('UI callback failed with secret') },
  })

  t.is((await harness.replication.replicate(input)).status, 'published')
  const replicating = harness.progress.filter(event => event.phase === 'replicating')
  t.alike(replicating.map(event => event.completedBytes), [100, 100, 600])
  for (const event of replicating) {
    t.alike(Object.keys(event).sort(), ['completedBytes', 'peerKey', 'phase', 'totalBytes'])
    t.is(event.peerKey, PEER_A)
    t.is(event.totalBytes, input.totalBytes)
  }
  const serialized = JSON.stringify(harness.progress)
  t.absent(serialized.includes('secret'))
  t.absent(serialized.includes('proof'))
  t.absent(serialized.includes('error'))
})

test('checkpoint CAS failure stops at the boundary and no bypass or direct writer is touched', async (t) => {
  const input = baseInput()
  const client = makeClient()
  let bypassCalls = 0
  const harness = createHarness({
    input,
    clients: new Map([[PEER_A, client]]),
    writeCheckpoint: async () => false,
    options: {
      publishAnyway () { bypassCalls++ },
      publicBee: { put () { bypassCalls++ } },
    },
  })

  await t.exception(harness.replication.replicate(input), /checkpoint/i)
  t.is(client.calls.pin.length, 0)
  t.is(harness.liveRanges.assessments, 0)
  t.is(harness.publicationHarness.calls.length, 0)
  t.is(bypassCalls, 0)
})

test('manifest and byte inputs are exact, deterministic, and detached from caller mutation', async (t) => {
  const input = baseInput()
  const originalRefs = clone(input.refs)
  const originalAssets = clone(input.assets)
  const harness = createHarness({ input })
  const pending = await harness.replication.replicate(input)
  input.refs[0].end = 999
  input.assets.media[0] = 1

  t.alike(harness.checkpoint.manifest.refs, createDurableManifest({ ...baseInput(), refs: originalRefs, assets: originalAssets }).refs)
  t.is(harness.checkpoint.requestId, pending.requestId)
  t.ok(Object.isFrozen(harness.checkpointWrites[0].checkpoint))
  let invalidBytesError = null
  try {
    await harness.replication.replicate(baseInput({ rowId: 'bad-bytes', idempotencyKey: 'bad', totalBytes: Infinity }))
  } catch (error) {
    invalidBytesError = error
  }
  t.ok(/totalBytes/i.test(invalidBytesError?.message || ''))
})

test('replicate snapshots queued inputs, auth bytes, stages, and trust before its first await', async (t) => {
  const input = baseInput({
    rowId: 'snapshot-queued',
    idempotencyKey: 'snapshot-queued-job',
    stagedDescriptor: { title: 'original', bytes: b4a.alloc(4, 7) },
    deviceKeyPair: { publicKey: b4a.alloc(32, 8), secretKey: b4a.alloc(64, 8) },
    deviceProof: b4a.alloc(64, 9),
    signedDescriptor: { proof: b4a.alloc(64, 10), nested: { label: 'original' } },
  })
  const secondInput = {
    ...input,
    refs: clone(input.refs),
    assets: clone(input.assets),
    stagedDescriptor: { title: 'original', bytes: b4a.alloc(4, 7) },
    deviceKeyPair: {
      publicKey: b4a.from(input.deviceKeyPair.publicKey),
      secretKey: b4a.from(input.deviceKeyPair.secretKey),
    },
    deviceProof: b4a.from(input.deviceProof),
    signedDescriptor: {
      proof: b4a.from(input.signedDescriptor.proof),
      nested: { label: 'original' },
    },
  }
  const liveRanges = createLiveRangeHarness()
  const trusted = [PEER_C]
  let checkpoint = null
  let assessCalls = 0
  let releaseFirstAssessment
  let firstAssessmentEntered
  const firstAssessmentGate = new Promise(resolve => { releaseFirstAssessment = resolve })
  const firstAssessmentReady = new Promise(resolve => { firstAssessmentEntered = resolve })
  const requestSnapshots = []
  let pinCalls = 0
  const client = makeClient({
    onPin (request) {
      pinCalls++
      if (pinCalls === 1) throw new Error('first run transport failure')
      liveRanges.setFullHolders([PEER_C])
      return statusFor(request.manifest, { state: 'complete', bytes: input.totalBytes })
    },
  })
  const publicationHarness = createPublicationHarness()
  const replication = createContentReplication({
    publication: publicationHarness.publication,
    clients: new Map([[PEER_C, client]]),
    createManifest: createDurableManifest,
    createPinRequest: async args => {
      requestSnapshots.push({
        publicKey: b4a.from(args.deviceKeyPair.publicKey),
        secretKey: b4a.from(args.deviceKeyPair.secretKey),
        deviceProof: b4a.from(args.deviceProof),
        descriptorProof: b4a.from(args.signedDescriptor.proof),
        descriptorLabel: args.signedDescriptor.nested.label,
      })
      return { requestId: args.manifest.requestId, manifest: args.manifest }
    },
    async assessDurability (refs, trust, deps) {
      assessCalls++
      if (assessCalls === 1) {
        firstAssessmentEntered()
        await firstAssessmentGate
        return { eligible: false, trusted: [], paired: [], ordinary: [], status: 'ok', error: null }
      }
      return liveRanges.assess(refs, trust, deps)
    },
    getTrustedRelayKeys: () => trusted,
    getPairedDeviceKeys: () => [],
    readCheckpoint: () => clone(checkpoint),
    writeCheckpoint: next => { checkpoint = clone(next); return clone(next) },
    maxClients: 1,
    maxStatusAttempts: 1,
    maxPeerConcurrency: 1,
    maxConcurrentRows: 1,
    pollIntervalMs: 1,
    requestTimeoutMs: 50,
    operationTimeoutMs: 1_000,
  })

  const first = replication.replicate(input)
  await firstAssessmentReady
  const second = replication.replicate(secondInput)
  secondInput.refs[0].end = 999
  secondInput.assets.media[0] = 1
  secondInput.stagedDescriptor.title = 'mutated'
  secondInput.stagedDescriptor.bytes.fill(0)
  secondInput.deviceKeyPair.publicKey.fill(0)
  secondInput.deviceKeyPair.secretKey.fill(0)
  secondInput.deviceProof.fill(0)
  secondInput.signedDescriptor.proof.fill(0)
  secondInput.signedDescriptor.nested.label = 'mutated'
  trusted.length = 0
  releaseFirstAssessment()

  t.is((await first).status, 'replicationPending')
  t.is((await second).status, 'published')
  const captured = requestSnapshots.at(-1)
  t.is(captured.publicKey[0], 8)
  t.is(captured.secretKey[0], 8)
  t.is(captured.deviceProof[0], 9)
  t.is(captured.descriptorProof[0], 10)
  t.is(captured.descriptorLabel, 'original')
  t.is(publicationHarness.calls.find(call => call.method === 'project').input.stagedDescriptor.title, 'original')
})

test('terminal accepted-peer statuses are checkpointed and alternatives rotate into the next bounded run', async (t) => {
  const input = baseInput({ rowId: 'terminal-rotation', idempotencyKey: 'terminal-rotation-job' })
  const manifest = createDurableManifest(input)
  const failedA = makeClient({ onStatus: () => statusFor(manifest, { state: 'failed' }) })
  const releasedB = makeClient({ onStatus: () => statusFor(manifest, { state: 'released' }) })
  const clients = new Map([
    [PEER_A, failedA],
    [PEER_B, releasedB],
  ])
  const initialCheckpoint = checkpointFor(input, 'replicating', {
    acceptedPeerKeys: [PEER_A, PEER_B],
    peerResults: [
      { peerKey: PEER_A, outcome: 'accepted' },
      { peerKey: PEER_B, outcome: 'accepted' },
    ],
  })
  const liveRanges = createLiveRangeHarness()
  const harness = createHarness({
    input,
    clients,
    liveRanges,
    initialCheckpoint,
    options: { maxClients: 2, maxStatusAttempts: 1 },
  })

  t.is((await harness.replication.replicate(input)).status, 'replicationPending')
  t.alike(harness.checkpoint.acceptedPeerKeys, [])
  t.alike(harness.checkpoint.peerResults, [
    { peerKey: PEER_A, outcome: 'rejected', lastInteractionRevision: 2 },
    { peerKey: PEER_B, outcome: 'rejected', lastInteractionRevision: 2 },
  ])

  const healthyC = makeClient({ onPin (request) {
    liveRanges.setFullHolders([PEER_C, 'd4'.repeat(32)])
    return statusFor(request.manifest, { state: 'complete', bytes: input.totalBytes })
  } })
  const healthyD = makeClient({ onPin: request => statusFor(request.manifest, { state: 'complete', bytes: input.totalBytes }) })
  clients.set(PEER_C, healthyC)
  clients.set('d4'.repeat(32), healthyD)

  t.is((await harness.replication.replicate(input)).status, 'published')
  t.is(healthyC.calls.pin.length, 1)
  t.is(healthyD.calls.pin.length, 1)
  t.is(failedA.calls.pin.length, 0)
  t.is(releasedB.calls.pin.length, 0)
})

test('retryable PIN errors and status not-found are retried once on a later invocation', async (t) => {
  const busyInput = baseInput({ rowId: 'busy-retry', idempotencyKey: 'busy-retry-job' })
  const busyRanges = createLiveRangeHarness()
  let busyAttempts = 0
  const busyClient = makeClient({ onPin (request) {
    busyAttempts++
    if (busyAttempts === 1) {
      const error = new Error('busy')
      error.name = 'SeedPinProtocolError'
      error.code = 'BUSY'
      throw error
    }
    busyRanges.setFullHolders([PEER_A])
    return statusFor(request.manifest, { state: 'complete', bytes: busyInput.totalBytes })
  } })
  const busyHarness = createHarness({
    input: busyInput,
    liveRanges: busyRanges,
    clients: new Map([[PEER_A, busyClient]]),
    trustedRelayKeys: [PEER_A],
    options: { maxClients: 1, maxStatusAttempts: 3 },
  })

  t.is((await busyHarness.replication.replicate(busyInput)).status, 'replicationPending')
  t.is(busyClient.calls.pin.length, 1, 'BUSY does not loop within one invocation')
  t.alike(busyHarness.checkpoint.peerResults, [{ peerKey: PEER_A, outcome: 'retryable', lastInteractionRevision: 2 }])
  t.is((await busyHarness.replication.replicate(busyInput)).status, 'published')
  t.is(busyClient.calls.pin.length, 2, 'BUSY is retried once on the next invocation')

  const missingInput = baseInput({ rowId: 'not-found-retry', idempotencyKey: 'not-found-retry-job' })
  const missingManifest = createDurableManifest(missingInput)
  const missingRanges = createLiveRangeHarness()
  const missingClient = makeClient({
    onStatus () {
      const error = new Error('not found')
      error.name = 'SeedPinProtocolError'
      error.code = 'NOT_FOUND'
      throw error
    },
    onPin (request) {
      missingRanges.setFullHolders([PEER_A])
      return statusFor(request.manifest, { state: 'complete', bytes: missingInput.totalBytes })
    },
  })
  const missingHarness = createHarness({
    input: missingInput,
    liveRanges: missingRanges,
    clients: new Map([[PEER_A, missingClient]]),
    trustedRelayKeys: [PEER_A],
    initialCheckpoint: checkpointFor(missingInput, 'replicating', {
      acceptedPeerKeys: [PEER_A],
      peerResults: [{ peerKey: PEER_A, outcome: 'accepted' }],
    }),
    options: { maxClients: 1, maxStatusAttempts: 3 },
  })

  t.is(missingManifest.requestId, missingHarness.checkpoint.requestId)
  t.is((await missingHarness.replication.replicate(missingInput)).status, 'replicationPending')
  t.is(missingClient.calls.pin.length, 0, 'NOT_FOUND does not re-pin in the status invocation')
  t.alike(missingHarness.checkpoint.acceptedPeerKeys, [])
  t.alike(missingHarness.checkpoint.peerResults, [{ peerKey: PEER_A, outcome: 'notFound', lastInteractionRevision: 2 }])
  t.is((await missingHarness.replication.replicate(missingInput)).status, 'published')
  t.is(missingClient.calls.pin.length, 1, 'NOT_FOUND re-pins on the next invocation')
})
test('durable attempt order rotates capped peers without starving policy fallbacks', async (t) => {
  const ordinaryInput = baseInput({ rowId: 'ordinary-fairness', idempotencyKey: 'ordinary-fairness-job' })
  const ordinaryRanges = createLiveRangeHarness()
  const ordinaryA = makeClient({ onPin: request => statusFor(request.manifest, { state: 'rejected' }) })
  const ordinaryB = makeClient({ onPin: request => statusFor(request.manifest) })
  const ordinaryC = makeClient({ onPin (request) {
    ordinaryRanges.setFullHolders([PEER_B, PEER_C])
    return statusFor(request.manifest, { state: 'complete', bytes: ordinaryInput.totalBytes })
  } })
  const ordinaryHarness = createHarness({
    input: ordinaryInput,
    liveRanges: ordinaryRanges,
    clients: new Map([[PEER_A, ordinaryA], [PEER_B, ordinaryB], [PEER_C, ordinaryC]]),
    options: { maxClients: 2, maxStatusAttempts: 1 },
  })

  t.is((await ordinaryHarness.replication.replicate(ordinaryInput)).status, 'replicationPending')
  t.is(ordinaryA.calls.pin.length, 1)
  t.is(ordinaryB.calls.pin.length, 1)
  t.is(ordinaryC.calls.pin.length, 0)
  t.is((await ordinaryHarness.replication.replicate(ordinaryInput)).status, 'published')
  t.is(ordinaryA.calls.pin.length, 2, 'oldest attempted rejection may retry after unattempted C takes first slot')
  t.is(ordinaryB.calls.pin.length, 1, 'accepted B is retained for status/assessment')
  t.is(ordinaryC.calls.pin.length, 1)

  const relayInput = baseInput({ rowId: 'relay-fairness', idempotencyKey: 'relay-fairness-job' })
  const relayRanges = createLiveRangeHarness()
  const relay = makeClient({ onPin () {
    const error = new Error('busy')
    error.name = 'SeedPinProtocolError'
    error.code = 'BUSY'
    throw error
  } })
  const fallbackB = makeClient({ onPin: request => statusFor(request.manifest) })
  const fallbackC = makeClient({ onPin (request) {
    relayRanges.setFullHolders([PEER_B, PEER_C])
    return statusFor(request.manifest, { state: 'complete', bytes: relayInput.totalBytes })
  } })
  const relayHarness = createHarness({
    input: relayInput,
    liveRanges: relayRanges,
    clients: new Map([[PEER_A, relay], [PEER_B, fallbackB], [PEER_C, fallbackC]]),
    trustedRelayKeys: [PEER_A],
    options: { maxClients: 2, maxStatusAttempts: 1 },
  })

  t.is((await relayHarness.replication.replicate(relayInput)).status, 'replicationPending')
  t.is((await relayHarness.replication.replicate(relayInput)).status, 'published')
  t.is(relay.calls.pin.length, 2, 'unattempted C takes priority while the oldest BUSY relay uses the remaining slot')
  t.is(fallbackB.calls.pin.length, 1)
  t.is(fallbackC.calls.pin.length, 1)

  const oldestInput = baseInput({ rowId: 'oldest-fairness', idempotencyKey: 'oldest-fairness-job' })
  const oldestRanges = createLiveRangeHarness()
  let oldestRelayAttempts = 0
  const oldestRelay = makeClient({ onPin (request) {
    oldestRelayAttempts++
    if (oldestRelayAttempts === 1) {
      const error = new Error('busy')
      error.name = 'SeedPinProtocolError'
      error.code = 'BUSY'
      throw error
    }
    oldestRanges.setFullHolders([PEER_A])
    return statusFor(request.manifest, { state: 'complete', bytes: oldestInput.totalBytes })
  } })
  const rejectedFallback = makeClient({ onPin: request => statusFor(request.manifest, { state: 'rejected' }) })
  const oldestHarness = createHarness({
    input: oldestInput,
    liveRanges: oldestRanges,
    clients: new Map([[PEER_A, oldestRelay], [PEER_B, rejectedFallback]]),
    trustedRelayKeys: [PEER_A],
    options: { maxClients: 1, maxStatusAttempts: 1 },
  })

  t.is((await oldestHarness.replication.replicate(oldestInput)).status, 'replicationPending')
  t.is((await oldestHarness.replication.replicate(oldestInput)).status, 'replicationPending')
  t.is(oldestRelay.calls.pin.length, 1)
  t.is(rejectedFallback.calls.pin.length, 1)
  t.is((await oldestHarness.replication.replicate(oldestInput)).status, 'published')
  t.is(oldestRelay.calls.pin.length, 2, 'oldest attempted trusted relay rotates back after all peers were tried')
})

test('checkpoint peer history is pruned before CAS while preserving a viable prioritized peer', async (t) => {
  const input = baseInput({ rowId: 'history-prune', idempotencyKey: 'history-prune-job' })
  const oldKeys = Array.from({ length: 1024 }, (_, index) => (index + 1).toString(16).padStart(64, '0'))
  const viableKey = 'ff'.repeat(32)
  const initialCheckpoint = checkpointFor(input, 'replicating', {
    acceptedPeerKeys: oldKeys,
    peerResults: oldKeys.map(peerKey => ({ peerKey, outcome: 'accepted' })),
  })
  const liveRanges = createLiveRangeHarness()
  const viable = makeClient({ onPin (request) {
    liveRanges.setFullHolders([viableKey])
    return statusFor(request.manifest, { state: 'complete', bytes: input.totalBytes })
  } })
  const observedWrites = []
  const harness = createHarness({
    input,
    liveRanges,
    clients: new Map([[viableKey, viable]]),
    trustedRelayKeys: [viableKey],
    initialCheckpoint,
    options: { maxClients: 1, maxStatusAttempts: 1 },
    writeCheckpoint (next) {
      observedWrites.push(clone(next))
      return next
    },
  })

  t.is((await harness.replication.replicate(input)).status, 'published')
  t.ok(observedWrites.every(next => next.acceptedPeerKeys.length <= 1024 && next.peerResults.length <= 1024))
  t.ok(harness.checkpoint.acceptedPeerKeys.includes(viableKey))
  t.ok(harness.checkpoint.peerResults.some(result => result.peerKey === viableKey && result.outcome === 'accepted'))
  const restart = createHarness({ input, initialCheckpoint: harness.checkpoint })
  t.is((await restart.replication.replicate(input)).status, 'published')
})

test('checkpoint pruning preserves the current attempt and oldest durable fairness history', async (t) => {
  const input = baseInput({ rowId: 'history-fairness', idempotencyKey: 'history-fairness-job' })
  const oldKeys = Array.from({ length: 1024 }, (_, index) => (index + 1).toString(16).padStart(64, '0'))
  const currentKey = 'ff'.repeat(32)
  const initialCheckpoint = checkpointFor(input, 'replicating', {
    revision: 1024,
    peerResults: oldKeys.map((peerKey, index) => ({
      peerKey,
      outcome: 'rejected',
      lastInteractionRevision: index + 1,
    })),
  })
  const current = makeClient({
    onPin: request => statusFor(request.manifest, { state: 'rejected' }),
  })
  const harness = createHarness({
    input,
    clients: new Map([[currentKey, current]]),
    initialCheckpoint,
    options: { maxClients: 1, maxStatusAttempts: 1 },
  })

  t.is((await harness.replication.replicate(input)).status, 'replicationPending')
  t.is(current.calls.pin.length, 1)
  t.is(harness.checkpoint.peerResults.length, 1024)
  t.ok(harness.checkpoint.peerResults.some(result =>
    result.peerKey === currentKey && result.lastInteractionRevision === 1025))
  t.ok(harness.checkpoint.peerResults.some(result => result.peerKey === oldKeys[0]))
  t.absent(harness.checkpoint.peerResults.some(result => result.peerKey === oldKeys.at(-1)))
})

test('CAS readback requires a strictly newer revision even when it claims a higher phase', async (t) => {
  const input = baseInput({ rowId: 'stale-cas-revision', idempotencyKey: 'stale-cas-revision-job' })
  const initialCheckpoint = checkpointFor(input, 'replicating', { revision: 7 })
  const harness = createHarness({
    input,
    initialCheckpoint,
    assessDurability: async () => ({
      eligible: true,
      trusted: [PEER_A],
      paired: [],
      ordinary: [],
      status: 'ok',
      error: null,
    }),
    writeCheckpoint () {
      return checkpointFor(input, 'published', { revision: 7 })
    },
  })

  await t.exception(harness.replication.replicate(input), /checkpoint|revision/i)
  t.is(harness.publicationHarness.calls.length, 0)
})

test('every awaited dependency is deadline-bounded and releases the row lock', async (t) => {
  const cases = [
    { name: 'manifest', phase: null },
    { name: 'read', phase: null },
    { name: 'write', phase: null },
    { name: 'assess', phase: 'replicating' },
    { name: 'request', phase: 'replicating', client: true },
    { name: 'mark', phase: 'durabilityVerified' },
    { name: 'project', phase: 'durabilityVerified' },
    { name: 'announce', phase: 'announcing' },
    { name: 'finalize', phase: 'announced' },
  ]
  const settleWithin = (promise, timeout = 80) => {
    let timer
    return Promise.race([
      promise.then(
        value => ({ kind: 'resolved', value }),
        error => ({ kind: 'rejected', error }),
      ),
      new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'test-timeout' }), timeout) }),
    ]).finally(() => clearTimeout(timer))
  }

  for (const awaitCase of cases) {
    const input = baseInput({
      rowId: `deadline-${awaitCase.name}`,
      idempotencyKey: `deadline-${awaitCase.name}-job`,
    })
    let checkpoint = awaitCase.phase ? checkpointFor(input, awaitCase.phase) : null
    let hanging = true
    const never = () => new Promise(() => {})
    const maybeHang = (name, value) => hanging && awaitCase.name === name ? never() : value
    const publicationHarness = createPublicationHarness()
    const publication = {
      async markDurabilityVerified (...args) {
        await maybeHang('mark')
        return publicationHarness.publication.markDurabilityVerified(...args)
      },
      async project (...args) {
        await maybeHang('project')
        return publicationHarness.publication.project(...args)
      },
      async announce (...args) {
        await maybeHang('announce')
        return publicationHarness.publication.announce(...args)
      },
      async finalize (...args) {
        await maybeHang('finalize')
        return publicationHarness.publication.finalize(...args)
      },
    }
    const client = makeClient({ onPin: request => statusFor(request.manifest) })
    const replication = createContentReplication({
      publication,
      clients: awaitCase.client ? new Map([[PEER_A, client]]) : new Map(),
      createManifest: value => maybeHang('manifest', createDurableManifest(value)),
      createPinRequest: args => maybeHang('request', { requestId: args.manifest.requestId, manifest: args.manifest }),
      assessDurability: () => maybeHang('assess', {
        eligible: false,
        trusted: [],
        paired: [],
        ordinary: [],
        status: 'ok',
        error: null,
      }),
      getTrustedRelayKeys: () => [],
      getPairedDeviceKeys: () => [],
      readCheckpoint: () => maybeHang('read', clone(checkpoint)),
      writeCheckpoint: next => maybeHang('write', (() => {
        checkpoint = clone(next)
        return clone(next)
      })()),
      maxClients: 1,
      maxStatusAttempts: 1,
      maxPeerConcurrency: 1,
      maxConcurrentRows: 1,
      pollIntervalMs: 1,
      requestTimeoutMs: 10,
      operationTimeoutMs: 12,
    })

    const first = await settleWithin(replication.replicate(input))
    t.not(first.kind, 'test-timeout', `${awaitCase.name} first call settles`)
    hanging = false
    const second = await settleWithin(replication.replicate(input))
    t.not(second.kind, 'test-timeout', `${awaitCase.name} releases same-row lock`)
  }
})

test('backend root and package subpath export createContentReplication', async (t) => {
  const root = await import('../src/index.js')
  const subpath = await import('@peartube/backend/content-replication')
  t.is(root.createContentReplication, createContentReplication)
  t.is(subpath.createContentReplication, createContentReplication)
})
