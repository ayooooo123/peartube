import test from 'brittle'

import { projectSourceSelectionDiagnostics } from '../src/media-graph/selection-diagnostics.js'
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

function createService(indexerId, queryPage) {
  const calls = []
  return {
    indexerId,
    calls,
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

  const results = await pending
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
  const results = await createFederation([first, second], {
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

  const results = await createFederation([good, malformed], {
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
  const results = await pending

  t.alike(results.map(candidate => cachedLocator(cache, candidate).sourceRecordRef), ['available'])
  t.is(timeoutAbort, true)
  t.is(timers[0].cleared, true)
})

test('default real deadline settles stalled searches and preserves isolated successful results', async t => {
  const stalled = createService('stalled', ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const emptyFederation = createFederation([stalled], { limits: { deadlineMs: 20 } })
  t.alike(await emptyFederation.search({ selector: SELECTOR, limit: 1 }), [])

  const good = createService('good', ({ query }) => page(query, typedResults(query, [exactResult('available')])))
  const mixedFederation = createFederation([good, stalled], { limits: { deadlineMs: 20 } })
  const results = await mixedFederation.search({ selector: SELECTOR, limit: 1 })
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
  t.alike(await federation.search({ selector: SELECTOR, limit: 1 }), [])
  const services = ['a', 'b', 'c'].map(indexerId =>
    createService(indexerId, ({ query }) => page(query, typedResults(query, [exactResult('late-source')]))))
  retained.push(...services)
  const results = await federation.search({ selector: SELECTOR, limit: 1 })
  t.is(requestedMaximum, 2)
  t.alike(results[0].sourceIndexers.map(value => value.indexerId), ['a', 'b'])
  t.is(services[2].calls.length, 0)
  retained.length = 0
  t.alike(await federation.search({ selector: SELECTOR, limit: 1 }), [])
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

  const first = (await federation.search({ selector: SELECTOR, limit: 1 }))[0]
  const second = (await federation.search({ selector: SELECTOR, limit: 1 }))[0]
  const third = (await federation.search({ selector: SELECTOR, limit: 1 }))[0]

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
  const results = await federation.search({ selector: SELECTOR, limit: 4 })
  t.is(endless.calls.length, 2)
  t.is(results.length, 0)
  await t.exception(federation.search({ selector: SELECTOR, limit: 5 }), {
    message: 'search limit is outside its bounded limit',
  })
})
