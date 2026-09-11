import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { projectSourceSelectionDiagnostics } from '../src/media-graph/selection-diagnostics.js'
import { createIndexServiceAnnouncement, deriveIndexerId } from '../src/indexer/service-announcement.js'
import { createIndexFederation } from '../src/search/index-federation.js'

const PUBLISHER_A = '11'.repeat(32)
const SELECTOR = Object.freeze({ namespace: 'tmdb', identifier: '348', kind: 'movie' })
const WORK_ID = '22'.repeat(32)
const PUBLICATION_ID = '33'.repeat(32)
const MANIFEST_ID = '66'.repeat(32)
const RENDITION_ID = '44'.repeat(32)
const ASSET_ID = '55'.repeat(32)
const PUBLICATION_SOURCE = 'publication-source'

function immediate() {
  return new Promise(resolve => setImmediate(resolve))
}

const ANNOUNCEMENT_SIGNER = crypto.keyPair(b4a.alloc(32, 9))

function signedAnnouncement(overrides = {}, signer = ANNOUNCEMENT_SIGNER) {
  return createIndexServiceAnnouncement({
    indexerId: deriveIndexerId(signer.publicKey),
    transportPublicKey: b4a.alloc(32, 8),
    dimensions: ['external-ref'],
    shardRanges: [{ dimension: 'external-ref', start: null, end: null }],
    queryCapabilities: ['exact-external-ref', 'publication-by-work', 'rendition-by-publication'],
    policyDigest: b4a.alloc(32, 7),
    sequence: 1,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
    ...overrides,
  }, signer)
}

function randomSource() {
  let value = 0
  return size => Buffer.alloc(size, ++value)
}

function exactResult(sourceRecordRef = 'source-a', entityId = WORK_ID, evidenceWeight = 10) {
  return {
    type: 'external-ref',
    publisherId: PUBLISHER_A,
    sourceRecordRef,
    namespace: SELECTOR.namespace,
    identifier: SELECTOR.identifier,
    entityKind: SELECTOR.kind,
    entityId,
    evidenceWeight,
  }
}

function publicationResult(overrides = {}) {
  return {
    type: 'publication',
    publisherId: PUBLISHER_A,
    sourceRecordRef: PUBLICATION_SOURCE,
    publicationId: PUBLICATION_ID,
    workEntityId: WORK_ID,
    normalizedTitle: 'Pilot',
    releaseYear: 2020,
    manifestId: MANIFEST_ID,
    provenanceSummary: null,
    ...overrides,
  }
}

function renditionResult(overrides = {}) {
  return {
    type: 'rendition',
    publisherId: PUBLISHER_A,
    sourceRecordRef: PUBLICATION_SOURCE,
    publicationId: PUBLICATION_ID,
    renditionId: RENDITION_ID,
    assetId: ASSET_ID,
    format: 'video/mp4',
    codec: 'avc1',
    dimensions: '1920x1080',
    mediaFeatures: null,
    byteLength: 1024,
    ...overrides,
  }
}

function typedResults(query, exact = [exactResult()], publications = [publicationResult()], renditions = [renditionResult()]) {
  const type = query.selectors[0].type
  if (type === 'exact-external-ref') return exact
  if (type === 'publication-by-work') return publications
  if (type === 'rendition-by-publication') return renditions
  throw new Error(`unexpected selector ${type}`)
}

function page(query, results, nextCursor = null, sourceRevision = '0:1') {
  return { queryId: query.queryId, results, nextCursor, sourceRevision }
}

function createService(indexerId, queryPage, options = {}) {
  const calls = []
  return {
    indexerId,
    calls,
    isLocal: options.isLocal ?? (options.announcement ? false : true),
    announcement: options.announcement || null,
    async queryIndexService(request) {
      calls.push(request)
      return queryPage(request, calls.length - 1)
    },
  }
}

function createFederation(services, options = {}) {
  return createIndexFederation({
    services,
    cache: options.cache || new Map(),
    now: options.now || (() => 1_700_000_000_000),
    limits: {
      randomBytes: options.randomBytes || randomSource(),
      ...options.limits,
    },
  })
}

function unsafeKeys(value, path = '') {
  if (!value || typeof value !== 'object') return []
  const found = []
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    if (/(?:url|credential|cookie|header|capability|control|score|rank)/i.test(key)) found.push(childPath)
    found.push(...unsafeKeys(child, childPath))
  }
  return found
}

function cachedLocator(cache, candidate) {
  return cache.get(candidate.candidateRef)?.locator || null
}

test('federation returns exact URL-less CompanionCandidateV2 facts', async t => {
  let started = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const cache = new Map()
  const services = ['i1', 'i2'].map(indexerId => createService(indexerId, async ({ query }) => {
    started++
    await gate
    return page(query, typedResults(query))
  }))
  const federation = createFederation(services, { cache, limits: { maxServices: 2 } })

  const pending = federation.search({ selector: SELECTOR, limit: 64 })
  await immediate()
  t.is(started, 2)
  release()

  const { candidates: results } = await pending
  t.is(results.length, 1)
  t.ok(results[0].candidateRef)
  t.alike({
    ...results[0],
    candidateRef: 'opaque',
    sourceIndexers: results[0].sourceIndexers.slice().sort((a, b) => a.indexerId.localeCompare(b.indexerId)),
  }, {
    schemaVersion: 2,
    candidateRef: 'opaque',
    work: {
      entityId: WORK_ID,
      title: 'Pilot',
      releaseYear: 2020,
      externalRefs: [{ namespace: 'tmdb', identifier: '348' }],
      episode: null,
    },
    edition: { entityId: null, label: null, kind: null },
    publication: {
      publicationId: PUBLICATION_ID,
      publisherId: PUBLISHER_A,
      manifestId: '66'.repeat(32),
      catalogEpoch: null,
      catalogHead: null,
    },
    rendition: {
      renditionId: RENDITION_ID,
      container: 'video/mp4',
      videoCodec: 'avc1',
      width: null,
      height: null,
      resolutionLabel: '1920x1080',
      hdrFormats: [],
      audioTracks: [],
      subtitleTracks: [],
      byteLength: 1024,
    },
    asset: {
      assetId: ASSET_ID,
      coreKey: null,
      blockLength: null,
      byteLength: 1024,
    },
    provenance: {
      sourceKind: null,
      releaseName: null,
      publicInfohash: null,
    },
    availability: {
      peers: null,
      completeSeeders: null,
      observedAtMs: null,
      expiresAtMs: null,
    },
    verification: { state: 'unverified' },
    sourceIndexers: [
      { indexerId: 'i1', observedAtMs: 1_700_000_000_000 },
      { indexerId: 'i2', observedAtMs: 1_700_000_000_000 },
    ],
  })
  t.alike(cachedLocator(cache, results[0]), {
    publisherId: PUBLISHER_A,
    sourceRecordRef: 'source-a',
    publicationSourceRecordRef: PUBLICATION_SOURCE,
    publicationId: PUBLICATION_ID,
    candidateManifestId: MANIFEST_ID,
    renditionId: RENDITION_ID,
    assetId: ASSET_ID,
    discovery: { type: 'external-ref' },
  })
  t.alike(unsafeKeys(results[0]), [])
  t.is(results[0].sourceRecordRef, undefined)
  t.is(results[0].evidenceWeight, undefined)
  t.is(results[0].streamUrl, undefined)
  t.is(results[0].score, undefined)
  t.is(results[0].ranking, undefined)
})

test('federation merges only identical cached locator tuples and preserves conflicts', async t => {
  const cache = new Map()
  const firstExact = [exactResult('same-source'), exactResult('conflicting-source')]
  const secondExact = [exactResult('same-source', WORK_ID, 20), exactResult('other-conflicting-source')]
  const first = createService('i1', ({ query }) => page(query, typedResults(query, firstExact)))
  const second = createService('i2', ({ query }) => page(query, typedResults(query, secondExact)))
  const { candidates: results } = await createFederation([first, second], {
    cache,
    limits: { maxPagesPerService: 16 },
  }).search({ selector: SELECTOR, limit: 64 })

  t.is(results.length, 3)
  const exact = results.find(candidate => cachedLocator(cache, candidate)?.sourceRecordRef === 'same-source')
  t.alike(cachedLocator(cache, exact), {
    publisherId: PUBLISHER_A,
    sourceRecordRef: 'same-source',
    publicationSourceRecordRef: PUBLICATION_SOURCE,
    publicationId: PUBLICATION_ID,
    candidateManifestId: MANIFEST_ID,
    renditionId: RENDITION_ID,
    assetId: ASSET_ID,
    discovery: { type: 'external-ref' },
  })
  t.alike(exact.sourceIndexers.map(row => row.indexerId).sort(), ['i1', 'i2'])
  t.is(exact.sourceIndexers.every(row => Object.keys(row).sort().join(',') === 'indexerId,observedAtMs'), true)
  t.is(results.filter(candidate => cachedLocator(cache, candidate)?.sourceRecordRef.includes('conflicting-source')).length, 2)
})

test('federation validates every page and isolates malformed pagination to its service', async t => {
  const cache = new Map()
  const good = createService('good', ({ query }) => {
    if (query.selectors[0].type !== 'exact-external-ref') return page(query, typedResults(query))
    return query.cursor === null
      ? page(query, [exactResult('good-a')], 'next-good')
      : page(query, [exactResult('good-b')])
  })
  const malformed = createService('bad', ({ query }) => {
    if (query.selectors[0].type !== 'exact-external-ref') return page(query, typedResults(query))
    return query.cursor === null
      ? page(query, [exactResult('bad-a')], 'next-bad')
      : { ...page(query, [exactResult('bad-b')]), queryId: 'ff'.repeat(32) }
  })

  const { candidates: results } = await createFederation([good, malformed], {
    cache,
    limits: { maxPagesPerService: 6 },
  }).search({ selector: SELECTOR, limit: 4 })
  t.alike(results.map(candidate => cachedLocator(cache, candidate).sourceRecordRef).sort(), ['good-a', 'good-b'])
  t.is(good.calls.length, 6)
  t.is(good.calls[0].query.cursor, null)
  t.is(good.calls[1].query.cursor, 'next-good')
  t.is(good.calls[2].query.sourceRevision, '0:1')
  t.unlike(good.calls[0].query.queryId, good.calls[1].query.queryId)
  t.is(malformed.calls.length, 2)
})

test('one service error or shared-deadline timeout cannot erase successful results', async t => {
  const timers = []
  const cache = new Map()
  let timeoutAbort = false
  const good = createService('good', ({ query }) => page(query, typedResults(query, [exactResult('available')])))
  const failed = createService('failed', async () => { throw new Error('private remote failure') })
  const unsafe = createService('unsafe', ({ query }) => page(query, [{
    ...exactResult('unsafe'),
    streamUrl: 'https://example.invalid/private',
    credentials: 'secret',
    controlCapability: 'delete',
    score: 1,
  }]))
  const stalled = createService('stalled', ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      timeoutAbort = true
      reject(signal.reason)
    }, { once: true })
  }))
  const federation = createFederation([good, failed, unsafe, stalled], {
    cache,
    limits: {
      deadlineMs: 100,
      setTimeout(callback, delay) {
        const timer = { callback, delay, cleared: false, unref() {} }
        timers.push(timer)
        return timer
      },
      clearTimeout(timer) {
        timer.cleared = true
      },
    },
  })

  const pending = federation.search({ selector: SELECTOR, limit: 4 })
  await immediate()
  t.is(timers.length, 1)
  t.is(timers[0].delay, 100)
  timers[0].callback()
  const { candidates: results, diagnostics } = await pending
  t.is(diagnostics.partial, true)
  t.alike(results.map(candidate => cachedLocator(cache, candidate).sourceRecordRef), ['available'])
  t.is(timeoutAbort, true)
  t.is(timers[0].cleared, true)
})

test('default real deadline settles stalled searches and preserves isolated successful results', async t => {
  const stalled = createService('stalled', ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const emptyFederation = createFederation([stalled], { limits: { deadlineMs: 20 } })
  t.alike((await emptyFederation.search({ selector: SELECTOR, limit: 1 })).candidates, [])

  const good = createService('good', ({ query }) => page(query, typedResults(query, [exactResult('available')])))
  const mixedFederation = createFederation([good, stalled], { limits: { deadlineMs: 20 } })
  const { candidates: results } = await mixedFederation.search({ selector: SELECTOR, limit: 1 })
  t.alike(results.map(candidate => candidate.work.entityId), [WORK_ID])
})

test('federation resolves the bounded retained-service provider at each deferred search', async t => {
  const retained = []
  let requestedMaximum = null
  const federation = createIndexFederation({
    services: maximum => {
      requestedMaximum = maximum
      return retained.slice(0, maximum)
    },
    cache: new Map(),
    now: () => 1_700_000_000_000,
    limits: { randomBytes: randomSource(), maxServices: 2 },
  })
  t.alike((await federation.search({ selector: SELECTOR, limit: 1 })).candidates, [])
  const services = ['a', 'b', 'c'].map(indexerId =>
    createService(indexerId, ({ query }) => page(query, typedResults(query, [exactResult('late-source')]))))
  retained.push(...services)
  const { candidates: results } = await federation.search({ selector: SELECTOR, limit: 1 })
  t.is(requestedMaximum, 2)
  t.alike(results[0].sourceIndexers.map(value => value.indexerId), ['a', 'b'])
  t.is(services[2].calls.length, 0)
  retained.length = 0
  t.alike((await federation.search({ selector: SELECTOR, limit: 1 })).candidates, [])
})

test('caller abort rejects search and removes the shared deadline', async t => {
  const timers = []
  let serviceAbort = false
  const stalled = createService('stalled', ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      serviceAbort = true
      reject(signal.reason)
    }, { once: true })
  }))
  const controller = new AbortController()
  const federation = createFederation([stalled], {
    limits: {
      setTimeout(callback, delay) {
        const timer = { callback, delay, cleared: false, unref() {} }
        timers.push(timer)
        return timer
      },
      clearTimeout(timer) {
        timer.cleared = true
      },
    },
  })

  const pending = federation.search({ selector: SELECTOR, limit: 1, signal: controller.signal })
  await immediate()
  controller.abort()
  await t.exception(pending, { name: 'AbortError' })
  t.is(serviceAbort, true)
  t.is(timers.length, 1)
  t.is(timers[0].cleared, true)
})

test('candidate refs are opaque, expiring, and evicted within the cache bound', async t => {
  let now = 10_000
  let source = 0
  const cache = new Map()
  const service = createService('i1', ({ query }) => page(
    query,
    query.selectors[0].type === 'exact-external-ref'
      ? [exactResult(`source-${++source}`)]
      : typedResults(query),
  ))
  const federation = createFederation([service], {
    cache,
    now: () => now,
    limits: { candidateTtlMs: 50, maxCachedCandidates: 2 },
  })

  const first = (await federation.search({ selector: SELECTOR, limit: 1 })).candidates[0]
  const second = (await federation.search({ selector: SELECTOR, limit: 1 })).candidates[0]
  const third = (await federation.search({ selector: SELECTOR, limit: 1 })).candidates[0]

  t.is(cache.size, 2)
  t.is(first.candidateRef.length, 43)
  t.is(/^[A-Za-z0-9_-]{43}$/.test(first.candidateRef), true)
  t.is(federation.resolveCandidate(first.candidateRef), null)
  t.is(cachedLocator(cache, second)?.sourceRecordRef, 'source-2')
  t.is(cachedLocator(cache, third)?.sourceRecordRef, 'source-3')
  t.is(federation.resolveCandidate(second.candidateRef)?.work.entityId, WORK_ID)
  t.is(federation.resolveCandidate(second.candidateRef)?.sourceRecordRef, undefined)

  now += 51
  t.is(federation.resolveCandidate(third.candidateRef), null)
  t.is(cache.size, 0)
})

test('diagnostics retain bounded provenance from nested candidates', t => {
  const diagnostics = projectSourceSelectionDiagnostics([{
    publication: { publicationId: null, publisherId: PUBLISHER_A },
    sourceIndexers: [
      { indexerId: 'i2', observedAtMs: 20 },
      { indexerId: 'i1', observedAtMs: 10 },
      { indexerId: 'i2', observedAtMs: 20 },
    ],
  }])
  t.alike(diagnostics[0].introductionPublisherIds, [PUBLISHER_A])
  t.alike(diagnostics[0].introductionIndexIds, ['i1', 'i2'])
})

test('configuration, requested counts, and page counts remain bounded', async t => {
  const services = Array.from({ length: 3 }, (_, index) => createService(`i${index}`, ({ query }) => page(query, [])))
  t.exception(() => createFederation(services, { limits: { maxServices: 2 } }), {
    message: 'services exceed their bounded limit',
  })
  const overflowingProvider = createFederation(() => services, { limits: { maxServices: 2 } })
  await t.exception(overflowingProvider.search({ selector: SELECTOR, limit: 1 }), {
    message: 'services exceed their bounded limit',
  })

  const endless = createService('endless', ({ query }, index) => page(query, [exactResult(`source-${index}`)], `cursor-${index}`))
  const federation = createFederation([endless], { limits: { maxPagesPerService: 2, maxCandidates: 4 } })
  const { candidates: results } = await federation.search({ selector: SELECTOR, limit: 4 })
  t.is(endless.calls.length, 2)
  t.is(results.length, 0)
  await t.exception(federation.search({ selector: SELECTOR, limit: 5 }), {
    message: 'search limit is outside its bounded limit',
  })
})

test('federation filters services by announcement shard range and capability', async t => {
  const signerMatched = crypto.keyPair(b4a.alloc(32, 11))
  const signerOutOfRange = crypto.keyPair(b4a.alloc(32, 12))
  const signerLackingCap = crypto.keyPair(b4a.alloc(32, 13))
  const matchingAnnouncement = signedAnnouncement({
    dimensions: ['external-ref'],
    queryCapabilities: ['exact-external-ref', 'publication-by-work', 'rendition-by-publication'],
    shardRanges: [{ dimension: 'external-ref', start: 'tmdb:300', end: 'tmdb:400' }],
  }, signerMatched)
  const nonMatchingRange = signedAnnouncement({
    dimensions: ['external-ref'],
    queryCapabilities: ['exact-external-ref', 'publication-by-work', 'rendition-by-publication'],
    shardRanges: [{ dimension: 'external-ref', start: 'tmdb:500', end: 'tmdb:600' }],
  }, signerOutOfRange)
  const missingCapability = signedAnnouncement({
    dimensions: ['external-ref'],
    queryCapabilities: ['text-prefix'],
    shardRanges: [{ dimension: 'external-ref', start: null, end: null }],
  }, signerLackingCap)

  const matchedService = {
    indexerId: b4a.toString(matchingAnnouncement.indexerId, 'hex'),
    announcement: matchingAnnouncement,
    calls: [],
    async queryIndexService(req) {
      matchedService.calls.push(req)
      return page(req.query, typedResults(req.query, [exactResult('matched-source')]))
    },
  }
  const outOfRangeService = {
    indexerId: b4a.toString(nonMatchingRange.indexerId, 'hex'),
    announcement: nonMatchingRange,
    calls: [],
    async queryIndexService(req) {
      outOfRangeService.calls.push(req)
      return page(req.query, [])
    },
  }
  const lackingCapService = {
    indexerId: b4a.toString(missingCapability.indexerId, 'hex'),
    announcement: missingCapability,
    calls: [],
    async queryIndexService(req) {
      lackingCapService.calls.push(req)
      return page(req.query, [])
    },
  }

  const federation = createFederation([matchedService, outOfRangeService, lackingCapService])
  const { candidates, diagnostics } = await federation.search({ selector: SELECTOR, limit: 10 })
  t.is(candidates.length, 1)
  t.is(matchedService.calls.length, 3)
  t.is(outOfRangeService.calls.length, 0, 'out-of-range service was filtered before query fanout')
  t.is(lackingCapService.calls.length, 0, 'lacking-capability service was filtered before query fanout')
  t.is(diagnostics.totalEligibleServices, 1)
})

test('federation rejects forged, malformed, future and expired remote announcements before dispatch', async t => {
  const signerAccepted = crypto.keyPair(b4a.alloc(32, 14))
  const signerForged = crypto.keyPair(b4a.alloc(32, 15))
  const signerFuture = crypto.keyPair(b4a.alloc(32, 16))
  const signerExpired = crypto.keyPair(b4a.alloc(32, 17))
  const signerMalformed = crypto.keyPair(b4a.alloc(32, 18))
  const signerNull = crypto.keyPair(b4a.alloc(32, 19))

  const acceptedAnnouncement = signedAnnouncement({}, signerAccepted)
  const acceptedId = b4a.toString(acceptedAnnouncement.indexerId, 'hex')

  const forged = signedAnnouncement({}, signerForged)
  forged.envelope.signature[0] ^= 1

  const rejectedConfigs = [
    { announcement: forged, indexerId: b4a.toString(forged.indexerId, 'hex') },
    { announcement: { dimensions: ['external-ref'], queryCapabilities: ['exact-external-ref'] }, indexerId: b4a.toString(deriveIndexerId(signerMalformed.publicKey), 'hex') },
    { announcement: signedAnnouncement({ issuedAt: 1_700_000_000_001 }, signerFuture), indexerId: b4a.toString(deriveIndexerId(signerFuture.publicKey), 'hex') },
    { announcement: signedAnnouncement({ issuedAt: 1_699_999_999_000, expiresAt: 1_700_000_000_000 }, signerExpired), indexerId: b4a.toString(deriveIndexerId(signerExpired.publicKey), 'hex') },
    { announcement: null, indexerId: b4a.toString(deriveIndexerId(signerNull.publicKey), 'hex') },
  ]
  const rejected = rejectedConfigs.map(({ announcement, indexerId }) =>
    createService(indexerId, ({ query }) => page(query, typedResults(query)), { announcement, isLocal: false }))
  const accepted = createService(acceptedId, ({ query }) => page(query, typedResults(query)), {
    announcement: acceptedAnnouncement,
  })
  const local = createService('local', ({ query }) => page(query, typedResults(query)), {
    announcement: forged,
    isLocal: true,
  })
  const federation = createFederation([...rejected, accepted, local])
  const result = await federation.search({ selector: SELECTOR })
  t.is(result.diagnostics.totalEligibleServices, 2)
  t.alike(result.candidates[0].sourceIndexers.map(entry => entry.indexerId).sort(), [acceptedId, 'local'].sort())
  t.alike(rejected.map(service => service.calls.length), [0, 0, 0, 0, 0])
})

test('static remote freshness is checked again on search and cursor resume', async t => {
  let time = 1_700_000_000_000
  const announcement = signedAnnouncement({ expiresAt: time + 1 })
  const remoteId = b4a.toString(announcement.indexerId, 'hex')
  const remote = createService(remoteId, ({ query }) => page(query, [exactResult()], 'remote-next'), {
    announcement,
  })
  const federation = createFederation([remote], { now: () => time, limits: { maxPagesPerService: 1 } })
  const first = await federation.search({ selector: SELECTOR })
  t.ok(first.nextCursor)
  const beforeExpiry = remote.calls.length
  time++
  const expired = await federation.search({ selector: SELECTOR })
  t.alike(expired.candidates, [])
  t.is(expired.diagnostics.queriedServices, 0)
  await t.exception(federation.search({ selector: SELECTOR, cursor: first.nextCursor }), {
    message: 'cursor service eligibility changed',
  })
  t.is(remote.calls.length, beforeExpiry, 'neither fresh nor resumed search dispatches the expired adapter')
})

test('default federation traverses one local and 32 signed remotes with eight-service fanout', async t => {
  const local = createService('local', ({ query }) => page(query, []))
  const remotes = Array.from({ length: 32 }, (_, index) => {
    const signer = crypto.keyPair(b4a.alloc(32, index + 1))
    const announcement = signedAnnouncement({}, signer)
    return createService(b4a.toString(announcement.indexerId, 'hex'), ({ query }) => page(query, []), { announcement })
  })
  const federation = createFederation([local, ...remotes])
  const fanouts = []
  let cursor = null
  do {
    const result = await federation.search({ selector: SELECTOR, cursor })
    t.is(result.diagnostics.totalEligibleServices, 33)
    fanouts.push(result.diagnostics.queriedServices)
    cursor = result.nextCursor
  } while (cursor && fanouts.length < 6)
  t.is(cursor, null)
  t.alike(fanouts, [8, 8, 8, 8, 1])
  t.alike([local, ...remotes].map(service => service.calls.length), Array(33).fill(1))
})

test('federation supports fair bounded fanout and continuation cursor', async t => {
  const services = ['s1', 's2', 's3', 's4'].map(indexerId => ({
    indexerId,
    isLocal: true,
    calls: [],
    async queryIndexService(req) {
      this.calls.push(req)
      return page(req.query, typedResults(req.query, [exactResult(`source-${indexerId}`)]))
    },
  }))

  const federation = createFederation(services, {
    limits: { maxFanout: 2, maxServices: 4 },
  })

  // First search with maxFanout: 2 queries s1 and s2
  const firstPage = await federation.search({ selector: SELECTOR, limit: 10 })
  t.ok(firstPage.nextCursor, 'continuation cursor exists when more eligible services remain')
  t.is(firstPage.diagnostics.queriedServices, 2)
  t.is(services[0].calls.length, 3)
  t.is(services[1].calls.length, 3)
  t.is(services[2].calls.length, 0)
  t.is(services[3].calls.length, 0)

  // Resume from cursor queries s3 and s4
  const secondPage = await federation.search({ selector: SELECTOR, limit: 10, cursor: firstPage.nextCursor })
  t.is(services[2].calls.length, 3)
  t.is(services[3].calls.length, 3)
  t.is(secondPage.diagnostics.queriedServices, 2)
})

test('federation resumes traversal when every stage exhausts the page budget', async t => {
  const service = {
    indexerId: 'staged-service',
    isLocal: true,
    calls: [],
    async queryIndexService(req) {
      this.calls.push(req)
      const selector = req.query.selectors[0]
      if (selector.type === 'exact-external-ref') {
        return page(req.query, [exactResult('stage-source')])
      }
      if (selector.type === 'publication-by-work') {
        return page(req.query, [publicationResult({ sourceRecordRef: 'stage-source' })])
      }
      if (selector.type === 'rendition-by-publication') {
        return page(req.query, [renditionResult({ sourceRecordRef: 'stage-source' })])
      }
      return page(req.query, [])
    },
  }

  // Each request has room for exactly one of discovery, publication, and rendition.
  const federation = createFederation([service], {
    limits: { maxPagesPerService: 1 },
  })

  const firstResult = await federation.search({ selector: SELECTOR, limit: 10 })
  t.is(firstResult.candidates.length, 0, 'discovery consumes the first request budget')
  t.ok(firstResult.nextCursor, 'continuation cursor captures in-flight multi-stage traversal state')
  t.is(service.calls.length, 1)

  // Each continuation advances one stage without repeating or dropping work.
  const secondResult = await federation.search({ selector: SELECTOR, limit: 10, cursor: firstResult.nextCursor })
  t.is(secondResult.candidates.length, 0)
  t.ok(secondResult.nextCursor, 'publication traversal preserves the pending rendition')
  const thirdResult = await federation.search({ selector: SELECTOR, limit: 10, cursor: secondResult.nextCursor })
  t.is(thirdResult.candidates.length, 1, 'the candidate survives both stage boundaries')
  t.is(service.calls.length, 3)
})

test('title eligibility and wire queries route on the canonical first token, not the raw title', async t => {
  const calls = []
  const signerMatched = crypto.keyPair(b4a.alloc(32, 21))
  const signerOutOfRange = crypto.keyPair(b4a.alloc(32, 22))
  const announcementMatched = signedAnnouncement({
    dimensions: ['text'],
    queryCapabilities: ['text-prefix', 'publication-by-work', 'rendition-by-publication'],
    shardRanges: [{ dimension: 'text', start: 'zulu', end: 'zulv' }],
  }, signerMatched)
  const announcementOutOfRange = signedAnnouncement({
    dimensions: ['text'],
    queryCapabilities: ['text-prefix', 'publication-by-work', 'rendition-by-publication'],
    shardRanges: [{ dimension: 'text', start: 'aaaa', end: 'm' }],
  }, signerOutOfRange)
  const matched = {
    indexerId: b4a.toString(announcementMatched.indexerId, 'hex'),
    announcement: announcementMatched,
    calls,
    async queryIndexService(req) {
      calls.push(req)
      return page(req.query, [])
    },
  }
  const outOfRange = {
    indexerId: b4a.toString(announcementOutOfRange.indexerId, 'hex'),
    announcement: announcementOutOfRange,
    calls: [],
    async queryIndexService(req) {
      outOfRange.calls.push(req)
      return page(req.query, [])
    },
  }

  const federation = createFederation([matched, outOfRange], {
    limits: { maxPagesPerService: 1 },
  })
  const { candidates, diagnostics } = await federation.search({ selector: { title: 'Zulu Movie', kind: 'movie' }, limit: 10 })
  t.is(candidates.length, 0)
  t.is(diagnostics.totalEligibleServices, 1, 'mixed-case multiword title routes on its lowercase first token')
  t.is(matched.calls.length, 1)
  t.alike(matched.calls[0].query.selectors, [{ type: 'title-token-prefix', prefix: 'zulu' }])
  t.is(outOfRange.calls.length, 0)
})

test('title-token results outside the requested canonical prefix never issue candidates', async t => {
  const service = createService('i1', ({ query }) => {
    if (query.selectors[0].type !== 'title-token-prefix') return page(query, [])
    return page(query, [{
      type: 'title-token',
      publisherId: PUBLISHER_A,
      sourceRecordRef: 'ab'.repeat(32),
      token: 'zeta',
      targetId: WORK_ID,
    }])
  })
  const { candidates } = await createFederation([service], {
    limits: { maxPagesPerService: 1 },
  }).search({ selector: { title: 'Zulu Movie', kind: 'movie' }, limit: 10 })
  t.is(candidates.length, 0)
  t.is(service.calls.length, 1)
})

test('continuation cursors are bound to the full normalized title selector', async t => {
  const service = {
    indexerId: 'title-cursor',
    isLocal: true,
    calls: [],
    async queryIndexService(req) {
      service.calls.push(req)
      if (req.query.selectors[0].type !== 'title-token-prefix') return page(req.query, [])
      const index = service.calls.length - 1
      return page(req.query, [{
        type: 'title-token',
        publisherId: PUBLISHER_A,
        sourceRecordRef: 'ab'.repeat(32),
        token: `alpha${index}`,
        targetId: WORK_ID,
      }], `cursor-${index}`)
    },
  }
  const federation = createFederation([service], { limits: { maxPagesPerService: 2 } })

  const first = await federation.search({ selector: { title: 'Alpha', kind: 'movie' }, limit: 1 })
  t.ok(first.nextCursor, 'title search leaves continuation state')
  const before = service.calls.length

  await t.exception(federation.search({
    selector: { title: 'Beta', kind: 'movie' },
    limit: 1,
    cursor: first.nextCursor,
  }), { message: 'cursor fingerprint mismatch' })
  t.is(service.calls.length, before, 'cross-title cursor is rejected before any query fanout')

  const resumed = await federation.search({
    selector: { title: 'Alpha', kind: 'movie' },
    limit: 1,
    cursor: first.nextCursor,
  })
  t.ok(service.calls.length > before, 'same-title cursor resumes the saved traversal')
  t.is(resumed.candidates.length, 0)
})

test('opaque continuation cannot replace the title-bound traversal state', async t => {
  const cache = new Map()
  const service = createService('title-resume', ({ query }) => {
    if (query.selectors[0].type === 'title-token-prefix') {
      return page(query, [{
        type: 'title-token', publisherId: PUBLISHER_A,
        sourceRecordRef: 'ab'.repeat(32), token: 'current', targetId: WORK_ID,
      }])
    }
    return page(query, typedResults(query))
  })
  const federation = createFederation([service], { cache, limits: { maxPagesPerService: 1 } })
  const selector = { title: 'Current Foo', kind: 'movie' }
  const first = await federation.search({ selector, limit: 1 })
  const callsBeforeForgery = service.calls.length
  const forged = first.nextCursor.slice(0, -1) + (first.nextCursor.endsWith('A') ? 'B' : 'A')
  await t.exception(federation.search({ selector, limit: 1, cursor: forged }), { code: 'INDEX_FEDERATION_REJECTED' })
  t.is(service.calls.length, callsBeforeForgery, 'forged state never reaches an index service')
  const second = await federation.search({ selector, limit: 1, cursor: first.nextCursor })
  const resumed = await federation.search({ selector, limit: 1, cursor: second.nextCursor })
  t.is(resumed.candidates.length, 1)
  t.alike(cachedLocator(cache, resumed.candidates[0]).discovery, {
    type: 'title-token', token: 'current', targetId: WORK_ID, queryTokens: ['current', 'foo'],
  })
})

test('one-result pages neither drop distinct services nor replay completed ones', async t => {
  const publicationIds = ['71'.repeat(32), '72'.repeat(32)]
  const services = publicationIds.map((publicationId, index) => createService(`service-${index}`, ({ query }) => page(
    query,
    typedResults(query, [exactResult()], [publicationResult({ publicationId })], [renditionResult({ publicationId })]),
  )))
  const federation = createFederation(services)
  const seen = []
  let cursor = null
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const result = await federation.search({ selector: SELECTOR, limit: 1, cursor })
    seen.push(...result.candidates.map(candidate => candidate.publication.publicationId))
    cursor = result.nextCursor
    if (cursor === null) break
  }
  t.alike(seen.sort(), publicationIds)
  t.is(cursor, null, 'all services finish without repeating an already-consumed page')
})

test('service failure preserves both initial and staged traversal for retry', async t => {
  const failures = new Set(['exact-external-ref', 'publication-by-work'])
  const cache = new Map()
  const service = createService('recovering-service', ({ query }) => {
    if (failures.delete(query.selectors[0].type)) throw new Error('temporary service outage')
    return page(query, typedResults(query))
  })
  const federation = createFederation([service], { cache, limits: { maxPagesPerService: 1 } })
  const first = await federation.search({ selector: SELECTOR, limit: 1 })
  t.is(first.diagnostics.partial, true)
  t.ok(first.nextCursor)
  const discovered = await federation.search({ selector: SELECTOR, limit: 1, cursor: first.nextCursor })
  const interrupted = await federation.search({ selector: SELECTOR, limit: 1, cursor: discovered.nextCursor })
  t.is(interrupted.diagnostics.partial, true)
  t.ok(interrupted.nextCursor)
  const publication = await federation.search({ selector: SELECTOR, limit: 1, cursor: interrupted.nextCursor })
  const result = await federation.search({ selector: SELECTOR, limit: 1, cursor: publication.nextCursor })
  t.is(result.candidates.length, 1)
  t.is(cachedLocator(cache, result.candidates[0]).publicationId, PUBLICATION_ID)
  t.is(result.nextCursor, null)
  await federation.close()
})

test('same-id changed local service incarnation rejects before querying the replacement', async t => {
  let current = createService('same-id', ({ query }) => page(query, [exactResult('old-service')], 'old-next'), { isLocal: true })
  const federation = createFederation(() => [current], { limits: { maxPagesPerService: 1 } })
  const first = await federation.search({ selector: SELECTOR, limit: 1 })
  t.ok(first.nextCursor)

  const replacement = createService('same-id', ({ query }) => page(query, [exactResult('replacement-service')], 'replacement-next'), { isLocal: true })
  current = replacement
  await t.exception(
    federation.search({ selector: SELECTOR, limit: 1, cursor: first.nextCursor }),
    { message: 'cursor service identity mismatch' },
  )
  t.is(replacement.calls.length, 0, 'the changed same-ID service is rejected before fanout')
})

test('same-id changed authenticated announcement rejects before querying the replacement', async t => {
  const announcement = signedAnnouncement()
  const announcedId = b4a.toString(announcement.indexerId, 'hex')
  let current = createService(announcedId, ({ query }) => page(query, [exactResult('old-announcement')], 'old-next'), {
    announcement,
  })
  const federation = createFederation(() => [current], { limits: { maxPagesPerService: 1 } })
  const first = await federation.search({ selector: SELECTOR, limit: 1 })
  t.ok(first.nextCursor)

  const replacement = createService(announcedId, ({ query }) => page(query, [exactResult('replacement-announcement')], 'replacement-next'), {
    announcement: signedAnnouncement({ sequence: 2, transportPublicKey: b4a.alloc(32, 6) }),
  })
  current = replacement
  await t.exception(
    federation.search({ selector: SELECTOR, limit: 1, cursor: first.nextCursor }),
    { message: 'cursor service identity mismatch' },
  )
  t.is(replacement.calls.length, 0, 'the changed authenticated resource is rejected before fanout')
})

test('federation continuation cursors are single-use and abort restores the legitimate retry', async t => {
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const service = createService('single-use', async ({ query }) => {
    calls++
    if (calls === 1) return page(query, [exactResult('first')], 'resume')
    if (calls === 2) {
      await gate
      return page(query, [])
    }
    return page(query, [])
  }, { isLocal: true })
  const federation = createFederation([service], { limits: { maxPagesPerService: 1 } })
  const first = await federation.search({ selector: SELECTOR, limit: 1 })
  t.ok(first.nextCursor)

  const controller = new AbortController()
  const pending = federation.search({ selector: SELECTOR, limit: 1, cursor: first.nextCursor, signal: controller.signal })
  await immediate()
  await t.exception(
    federation.search({ selector: SELECTOR, limit: 1, cursor: first.nextCursor }),
    { message: 'continuation cursor is already in use' },
  )
  controller.abort()
  await t.exception(pending, { name: 'AbortError' })

  release()
  const retry = await federation.search({ selector: SELECTOR, limit: 1, cursor: first.nextCursor })
  t.alike(retry.candidates, [])
  t.is(calls, 3, 'the aborted cursor was restored exactly once for a later retry')
  await t.exception(
    federation.search({ selector: SELECTOR, limit: 1, cursor: first.nextCursor }),
    { code: 'INDEX_FEDERATION_REJECTED' },
  )
})

test('federation authenticates outer service identity against signed announcement before dispatch', async t => {
  const announcement = signedAnnouncement()
  const canonicalId = b4a.toString(announcement.indexerId, 'hex')
  const service = (indexerId, isLocal = false) => createService(indexerId,
    ({ query }) => page(query, typedResults(query, [exactResult(indexerId)])),
    { announcement: isLocal ? null : announcement, isLocal })
  const rejected = [
    service('12'.repeat(32)),
    service(canonicalId.toUpperCase()),
    service(`${canonicalId}junk`),
  ]
  const remote = service(canonicalId)
  const local = service('local-explicit-service', true)
  const federation = createFederation([...rejected, remote, local])
  t.teardown(() => federation.close())
  const result = await federation.search({ selector: SELECTOR })
  for (const invalid of rejected) t.is(invalid.calls.length, 0, 'invalid outer identity never receives a query')
  const sources = result.candidates.flatMap(candidate => candidate.sourceIndexers.map(source => source.indexerId))
  t.alike(sources.sort(), [canonicalId, local.indexerId].sort(), 'only authenticated remote and explicit local provenance survives')
})

test('continuation rejects dynamic identity mutation preventing cross-identity attribution', async t => {
  const signer1 = crypto.keyPair(b4a.alloc(32, 41))
  const signer2 = crypto.keyPair(b4a.alloc(32, 42))

  const announcement1 = signedAnnouncement({}, signer1)
  const id1 = b4a.toString(announcement1.indexerId, 'hex')
  const announcement2 = signedAnnouncement({ sequence: 1 }, signer2)
  const id2 = b4a.toString(announcement2.indexerId, 'hex')

  let currentService = createService(id1, ({ query }) => page(query, typedResults(query, [exactResult('service-1')]),
    query.selectors[0].type === 'rendition-by-publication' ? 'cursor-1' : null), {
    announcement: announcement1,
    isLocal: false,
  })

  const federation = createFederation(() => [currentService], { limits: { maxPagesPerService: 3 } })
  t.teardown(() => federation.close())
  const first = await federation.search({ selector: SELECTOR, limit: 1 })
  t.ok(first.nextCursor)
  t.alike(first.candidates.map(c => c.sourceIndexers[0].indexerId), [id1])

  // Subcase A: dynamic mutation to valid announcement under mismatched valid outer ID
  const mismatched = createService(id2, ({ query }) => page(query, [exactResult('mismatched')], 'cursor-mismatched'), {
    announcement: announcement1,
    isLocal: false,
  })
  currentService = mismatched
  await t.exception(
    federation.search({ selector: SELECTOR, limit: 1, cursor: first.nextCursor }),
    { message: 'cursor service eligibility changed' },
  )
  t.is(mismatched.calls.length, 0, 'no dispatch to mismatched outer ID service on resume')

  // Subcase B: dynamic mutation to noncanonical outer ID (uppercase)
  const noncanonical = createService(id1.toUpperCase(), ({ query }) => page(query, [exactResult('noncanonical')], 'cursor-noncanonical'), {
    announcement: announcement1,
    isLocal: false,
  })
  currentService = noncanonical
  await t.exception(
    federation.search({ selector: SELECTOR, limit: 1, cursor: first.nextCursor }),
    { message: 'cursor service eligibility changed' },
  )
  t.is(noncanonical.calls.length, 0, 'no dispatch to noncanonical outer ID service on resume')

  // Subcase C: dynamic mutation to distinct authenticated service (different ID and matching announcement)
  const distinct = createService(id2, ({ query }) => page(query, [exactResult('service-2')], 'cursor-2'), {
    announcement: announcement2,
    isLocal: false,
  })
  currentService = distinct
  await t.exception(
    federation.search({ selector: SELECTOR, limit: 1, cursor: first.nextCursor }),
    { message: 'cursor service identity mismatch' },
  )
  t.is(distinct.calls.length, 0, 'no dispatch to replaced distinct service on resume')

  // Legitimate retry with original authenticated service succeeds without cross-attribution
  const legitimate = createService(id1, ({ query }) => page(query, typedResults(query, [exactResult('service-1-retry')])), {
    announcement: announcement1,
    isLocal: false,
  })
  currentService = legitimate
  const resumed = await federation.search({ selector: SELECTOR, limit: 1, cursor: first.nextCursor })
  t.alike(resumed.candidates.map(c => c.sourceIndexers[0].indexerId), [id1], 'resumed candidates attributed strictly to original service')
})

test('remote casing aliases are rejected before duplicate admission without folding local identities', async t => {
  const announcement = signedAnnouncement()
  const indexerId = b4a.toString(announcement.indexerId, 'hex')
  const queryPage = ({ query }) => page(query, typedResults(query))
  const canonical = createService(indexerId, queryPage, { announcement })
  const alias = createService(indexerId.toUpperCase(), queryPage, { announcement })
  const locals = ['Local-adapter', 'local-adapter'].map(id => createService(id, queryPage))
  const federation = createFederation([alias, canonical, alias, ...locals])
  t.teardown(() => federation.close())

  const result = await federation.search({ selector: SELECTOR, limit: 64 })
  t.alike(result.candidates.flatMap(candidate => candidate.sourceIndexers.map(source => source.indexerId)).sort(),
    [indexerId, 'Local-adapter', 'local-adapter'].sort())
  t.is(alias.calls.length, 0, 'noncanonical aliases never dispatch')
})
