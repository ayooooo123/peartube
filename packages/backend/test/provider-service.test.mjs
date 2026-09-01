import test from 'brittle'

import { createProviderService } from '../src/provider/service.js'

const NOW = 1_800_000_000_000
const PUBLISHER = '11'.repeat(32)
const OTHER_PUBLISHER = '22'.repeat(32)
const PUBLICATION = '33'.repeat(32)
const ACQUIRABLE_PUBLICATION = '44'.repeat(32)
const MANIFEST = '55'.repeat(32)
const RENDITION = '66'.repeat(32)
const ASSET = '77'.repeat(32)
const WORK = '88'.repeat(32)
const RAW_CANDIDATE_REF = 'C'.repeat(43)
const SELECTOR = Object.freeze({ namespace: 'tmdb', identifier: '348', kind: 'movie' })
const PRINCIPAL = Object.freeze({ principalId: 'machine-a', publisherId: PUBLISHER })

function manifest(publicationId = PUBLICATION) {
  return {
    publicationId,
    body: {
      publisherId: PUBLISHER,
      manifestId: MANIFEST,
      title: 'Verified title',
      provenance: [{ sourceUrl: 'https://private.invalid/source', credential: 'source-secret' }],
      renditions: [{
        renditionId: RENDITION,
        purpose: 'main',
        format: 'video/mp4',
        core: {
          assetId: ASSET,
          key: 'private-core-key',
          treeHash: 'private-tree-hash',
          length: 1,
          byteLength: 12,
        },
      }],
    },
  }
}

function publication(publicationId = PUBLICATION) {
  return {
    publicationId,
    publisherId: PUBLISHER,
    manifestId: MANIFEST,
    workEntityId: WORK,
    normalizedTitle: 'Verified title',
    sourceRecordRef: 'private-source-reference',
    adapterName: 'premium-provider',
  }
}

function candidate() {
  return {
    schemaVersion: 2,
    candidateRef: RAW_CANDIDATE_REF,
    work: {
      entityId: WORK,
      title: 'Acquirable title',
      releaseYear: 1999,
      externalRefs: [{ namespace: 'tmdb', identifier: '348' }],
    },
    publication: {
      publicationId: ACQUIRABLE_PUBLICATION,
      publisherId: PUBLISHER,
      manifestId: MANIFEST,
      title: 'Acquirable title',
    },
    rendition: {
      renditionId: RENDITION,
      purpose: 'main',
      byteLength: 12,
    },
    asset: {
      assetId: ASSET,
      coreKey: 'private-core-key',
      treeHash: 'private-tree-hash',
      byteLength: 12,
    },
    availability: {
      peers: 3,
      completeSeeders: 1,
      observedAtMs: NOW,
      expiresAtMs: NOW + 30_000,
    },
    provenance: {
      sourceKind: 'premium-provider',
      publicInfohash: 'private-infohash',
      sourceUrl: 'https://private.invalid/source',
    },
    verification: { state: 'source-verified' },
    sourceIndexers: [{ indexerId: 'premium-provider', observedAtMs: NOW }],
  }
}

function acquisition(overrides = {}) {
  return {
    schemaVersion: 1,
    acquisitionId: 'acquisition-a',
    state: 'queued',
    retentionClass: 'contribution-cache',
    bytesAcquired: 0,
    expectedBytes: 12,
    publicationId: null,
    manifestId: null,
    renditionId: null,
    assetId: null,
    errorCode: null,
    recoverable: false,
    createdAt: NOW,
    updatedAt: NOW,
    sourceUrl: 'https://private.invalid/source',
    providerName: 'premium-provider',
    ...overrides,
  }
}

function request(resolutionRef, publisherId = PUBLISHER) {
  return {
    idempotencyKey: 'request-a',
    request: {
      schemaVersion: 1,
      resolutionRef,
      publisherId,
      retentionClass: 'contribution-cache',
    },
    principal: { ...PRINCIPAL },
  }
}

function fixture({ published = false, visible = true, titleIndexed = true, providerLimits = { referenceLeaseMs: 30_000, cursorLeaseMs: 30_000 } } = {}) {
  let time = NOW
  let entropy = 0
  let moderationVisible = visible
  const calls = {
    verify: 0,
    request: [],
    attachGrant: [],
    get: [],
    list: [],
    cancel: [],
    stream: [],
    migrate: [],
  }
  const localPublication = publication()
  const localManifest = manifest()
  const jobs = new Map()
  const idempotent = new Map()

  const verifiedQueryView = {
    async query() {
      return {
        results: published && titleIndexed ? [{ entityId: WORK }] : [],
        nextCursor: null,
        sourceRevision: '0:1',
      }
    },
    async getEntity() {
      return published
        ? { entityId: WORK, publications: [{ ...localPublication, manifest: localManifest }] }
        : null
    },
    async listEntities() {
      return published
        ? [{ entityId: WORK, resolved: { metadata: { title: 'Title' } }, publications: [{ ...localPublication, manifest: localManifest }] }]
        : []
    },
    async getPublication({ publicationId }) {
      return published && moderationVisible && publicationId === PUBLICATION ? localPublication : null
    },
    async getManifest({ publicationId }) {
      return published && moderationVisible && publicationId === PUBLICATION ? localManifest : null
    },
    async getRendition({ publicationId, renditionId }) {
      if (!published || !moderationVisible || publicationId !== PUBLICATION || renditionId !== RENDITION) return null
      return {
        publication: localPublication,
        manifest: localManifest,
        rendition: localManifest.body.renditions[0],
      }
    },
    async authorizeRendition() {
      return moderationVisible
    },
    async isVisible() {
      return moderationVisible
    },
  }

  const indexVerificationRuntime = {
    async searchIndexCandidates(input) {
      if (input?.selector?.identifier && input.selector.identifier !== '348') return []
      return published ? [] : [candidate()]
    },
    async verifyIndexCandidate({ candidateRef }) {
      calls.verify++
      if (candidateRef !== RAW_CANDIDATE_REF) throw new Error('unexpected candidate')
      return candidate()
    },
  }

  const acquisitionManager = {
    async findRequest(input) {
      const key = `${input.principal.principalId}:${input.request.publisherId}:${input.idempotencyKey}:${JSON.stringify(input.request)}`
      return idempotent.get(key) || null
    },
    async request(input) {
      calls.request.push(input)
      const key = `${input.principal.principalId}:${input.request.publisherId}:${input.idempotencyKey}:${JSON.stringify(input.request)}`
      if (!idempotent.has(key)) idempotent.set(key, acquisition())
      const job = idempotent.get(key)
      jobs.set(job.acquisitionId, job)
      return job
    },
    async attachGrant(input) {
      calls.attachGrant.push(input)
      return jobs.get(input.acquisitionId) || acquisition({ acquisitionId: input.acquisitionId })
    },
    async get(input) {
      calls.get.push(input)
      return jobs.get(input.acquisitionId) || null
    },
    async list(input = {}) {
      calls.list.push(input)
      let values = [...jobs.values()]
      if (Array.isArray(input.states)) {
        const stateSet = new Set(input.states)
        values = values.filter(job => stateSet.has(job.state))
      }
      const limit = input.limit || 64
      return { items: values.slice(0, limit), cursor: values.length > limit ? values[limit - 1].acquisitionId : null }
    },
    async listActive() {
      return [...jobs.values()].filter(job => ['queued', 'acquiring', 'verifying', 'publishing'].includes(job.state))
    },
    async cancel(input) {
      calls.cancel.push(input)
      const current = jobs.get(input.acquisitionId)
      return current ? { ...current, state: 'cancelled', updatedAt: NOW + 1 } : null
    },
    async migrateLegacyIngest(input) {
      calls.migrate.push(input)
      return { migrated: 2, skipped: 1 }
    },
  }

  const service = createProviderService({
    verifiedQueryView,
    indexVerificationRuntime,
    acquisitionManager,
    streamOpener: async input => {
      calls.stream.push(input)
      return {
        url: 'http://127.0.0.1:8080/media',
        etag: 'etag-a',
        sourceUrl: 'https://private.invalid/stream',
        secret: 'stream-secret',
        providerName: 'premium-provider',
      }
    },
    statusSource: async () => ({
      ready: true,
      activeAcquisitions: 0,
      sourceUrl: 'https://private.invalid/status',
      providerName: 'premium-provider',
    }),
    now: () => time,
    randomBytes: size => Buffer.alloc(size, ++entropy),
    limits: providerLimits,
  })

  return {
    service,
    calls,
    jobs,
    setVisible(value) { moderationVisible = value },
    advance(milliseconds) { time += milliseconds },
  }
}

function privateOutput(value) {
  const encoded = JSON.stringify(value)
  return [
    'private-source-reference',
    'private-core-key',
    'private-tree-hash',
    'private-infohash',
    'source-secret',
    'stream-secret',
    'premium-provider',
    'https://private.invalid',
    RAW_CANDIDATE_REF,
  ].find(secret => encoded.includes(secret)) || null
}

test('published search opens verified playback without acquisition', async t => {
  const f = fixture({ published: true })
  const page = await f.service.search({ selector: SELECTOR })

  t.is(page.candidates.length, 1)
  t.is(page.candidates[0].kind, 'published')
  const opened = await f.service.openStream({ ref: page.candidates[0].ref, principal: PRINCIPAL })
  t.is(opened.publicationId, PUBLICATION)
  t.is(opened.renditionId, RENDITION)
  t.is(f.calls.request.length, 0)
  t.is(f.calls.stream.length, 1)
})

test('published title search falls back to verified entities when a legacy title edge is absent', async t => {
  const f = fixture({ published: true, titleIndexed: false })
  const page = await f.service.search({ selector: { kind: 'movie', title: 'Title', year: 2026 } })

  t.is(page.candidates.length, 1)
  t.is(page.candidates[0].kind, 'published')
  t.is(page.candidates[0].publicationId, PUBLICATION)
})

test('a local miss resolves a source-verified candidate as acquirable', async t => {
  const f = fixture()
  const page = await f.service.search({ selector: SELECTOR })
  const hit = page.candidates[0]
  const resolved = await f.service.resolve({ ref: hit.ref })

  t.is(hit.kind, 'acquirable')
  t.not(hit.ref, RAW_CANDIDATE_REF)
  t.is(resolved.kind, 'acquirable')
  t.is(resolved.resolutionRef, hit.ref)
  t.is(resolved.acquisitionAvailable, true)
  t.is(f.calls.verify, 1)
})

test('local moderation blocks resolve and acquisition before manager delegation', async t => {
  const f = fixture()
  const page = await f.service.search({ selector: SELECTOR })
  const ref = page.candidates[0].ref
  f.setVisible(false)

  const resolved = await f.service.resolve({ ref })
  t.is(resolved.kind, 'unavailable')
  t.is(resolved.denialCode, 'MODERATION_BLOCKED')
  await t.exception(f.service.requestAcquisition(request(ref)), { code: 'MODERATION_BLOCKED' })
  t.is(f.calls.request.length, 0)
})

test('acquisition request enforces principal target scope without conflating source publisher', async t => {
  const f = fixture()
  const page = await f.service.search({ selector: SELECTOR })
  const ref = page.candidates[0].ref

  await t.exception(
    f.service.requestAcquisition(request(ref, OTHER_PUBLISHER)),
    { code: 'ACQUISITION_FORBIDDEN' },
  )
  const accepted = await f.service.requestAcquisition({
    ...request(ref, OTHER_PUBLISHER),
    principal: { principalId: 'machine-b', publisherId: OTHER_PUBLISHER },
  })
  t.is(accepted.state, 'queued')
  t.is(f.calls.request.length, 1)
  t.is(f.calls.request[0].request.publisherId, OTHER_PUBLISHER)
})

test('idempotency is delegated unchanged with principal and publisher context', async t => {
  const f = fixture()
  const page = await f.service.search({ selector: SELECTOR })
  const input = request(page.candidates[0].ref)

  const first = await f.service.requestAcquisition(input)
  f.advance(30_001)
  const second = await f.service.requestAcquisition(input)
  t.alike(first, second)
  t.is(f.calls.request.length, 2)
  t.is(f.calls.request[0].idempotencyKey, input.idempotencyKey)
  t.alike(f.calls.request[0].request, input.request)
  t.is(f.calls.request[0].principal.principalId, PRINCIPAL.principalId)
  t.is(f.calls.request[0].principal.publisherId, PUBLISHER)
})


test('acquisition pagination accepts durable acquisition-id cursors', async t => {
  const f = fixture()
  f.jobs.set('acquisition-a', acquisition({ acquisitionId: 'acquisition-a' }))
  f.jobs.set('acquisition-b', acquisition({ acquisitionId: 'acquisition-b' }))
  const first = await f.service.listAcquisitions({ limit: 1, principal: PRINCIPAL })
  t.is(first.items.length, 1)
  t.is(first.cursor, 'acquisition-a')
  const next = await f.service.listAcquisitions({ limit: 1, cursor: first.cursor, principal: PRINCIPAL })
  t.is(f.calls.list.at(-1).cursor, 'acquisition-a')
  t.is(next.items.length, 1)
})
test('failed acquisition never opens a stream even with publication fields', async t => {
  const f = fixture({ published: true })
  f.jobs.set('failed-a', acquisition({
    acquisitionId: 'failed-a',
    state: 'failed',
    publicationId: PUBLICATION,
    renditionId: RENDITION,
    assetId: ASSET,
    errorCode: 'VERIFY_FAILED',
  }))

  await t.exception(
    f.service.openStream({ acquisitionId: 'failed-a', publicationId: PUBLICATION, principal: PRINCIPAL }),
    { code: 'ACQUISITION_NOT_COMPLETED' },
  )
  t.is(f.calls.stream.length, 0)
})

test('public records omit source locators, secrets, provider names, and raw candidate refs', async t => {
  const remote = fixture()
  const remotePage = await remote.service.search({ selector: SELECTOR })
  const resolved = await remote.service.resolve({ ref: remotePage.candidates[0].ref })
  const job = await remote.service.requestAcquisition(request(remotePage.candidates[0].ref))
  const status = await remote.service.getStatus()

  const local = fixture({ published: true })
  const localPage = await local.service.search({ selector: SELECTOR })
  const publicationRecord = await local.service.getPublication({ publicationId: PUBLICATION })
  const stream = await local.service.openStream({ ref: localPage.candidates[0].ref, principal: PRINCIPAL })

  for (const value of [remotePage, resolved, job, status, localPage, publicationRecord, stream]) {
    t.is(privateOutput(value), null)
  }
})

test('opaque resolution references and search cursors have bounded leases', async t => {
  const f = fixture()
  const page = await f.service.search({ selector: SELECTOR, limit: 1 })
  t.ok(/^[A-Za-z0-9_-]{43}$/.test(page.candidates[0].ref))

  f.advance(30_001)
  await t.exception(f.service.resolve({ ref: page.candidates[0].ref }), { code: 'RESOLUTION_EXPIRED' })
  await t.exception(
    f.service.search({ selector: { ...SELECTOR, identifier: '349' }, cursor: 'A'.repeat(43) }),
    { code: 'INVALID_CURSOR' },
  )
})
test('default published references remain valid while a person chooses and starts playback', async t => {
  const f = fixture({ published: true, providerLimits: {} })
  const page = await f.service.search({ selector: SELECTOR })

  f.advance(2 * 60_000)
  const resolved = await f.service.resolve({ ref: page.candidates[0].ref })
  t.is(resolved.kind, 'published')
  t.is(resolved.publicationId, PUBLICATION)
})


test('legacy ingest migration stays behind the provider service seam', async t => {
  const f = fixture()
  const legacyStore = { async list() { return [] } }
  const result = await f.service.migrateLegacyIngest({
    legacyStore,
    legacyPrincipalId: 'legacy-machine',
    legacyPublisherId: 'legacy-publisher',
    now: NOW,
  })

  t.alike(result, { migrated: 2, skipped: 1 })
  t.is(f.calls.migrate.length, 1)
  t.is(f.calls.migrate[0].legacyStore, legacyStore)
  t.is(f.service.acquisitionStore, undefined)
})

test('in-flight active acquisition search immediately returns matching candidates by external reference', async t => {
  const f = fixture()
  f.jobs.set('acq-active-1', acquisition({
    acquisitionId: 'acq-active-1',
    state: 'acquiring',
    expectedBytes: 4096,
    publisherId: PUBLISHER,
    publicationMetadata: {
      title: 'Active Movie Title',
      mediaContext: { namespace: 'tmdb', identifier: '348', kind: 'movie' },
    },
  }))

  const page = await f.service.search({ selector: SELECTOR })
  t.ok(page.candidates.length >= 1)
  const inFlightHit = page.candidates.find(c => c.title === 'Active Movie Title')
  t.ok(inFlightHit)
  t.is(inFlightHit.kind, 'acquirable')
  t.is(inFlightHit.expectedBytes, 4096)

  const resolved = await f.service.resolve({ ref: inFlightHit.ref })
  t.is(resolved.kind, 'acquirable')
  t.is(resolved.acquisitionAvailable, true)
  t.is(resolved.expected?.byteLength, 4096)
  t.is(resolved.publisherId, PUBLISHER)
})

test('in-flight active acquisition search matches by title token prefix and sourceFileName', async t => {
  const f = fixture()
  f.jobs.set('acq-title-1', acquisition({
    acquisitionId: 'acq-title-1',
    state: 'queued',
    expectedBytes: 8192,
    publisherId: PUBLISHER,
    publicationMetadata: {
      title: 'Alien: Covenant',
      mediaContext: { kind: 'movie' },
    },
  }))
  f.jobs.set('acq-filename-1', acquisition({
    acquisitionId: 'acq-filename-1',
    state: 'verifying',
    expectedBytes: 16384,
    publisherId: PUBLISHER,
    request: {
      sourceFileName: 'Matrix.Reloaded.1999.1080p.mkv',
    },
    publicationMetadata: {
      mediaContext: { kind: 'movie' },
    },
  }))

  const alienPage = await f.service.search({ selector: { title: 'Alien', kind: 'movie' } })
  t.is(alienPage.candidates.length, 1)
  t.is(alienPage.candidates[0].title, 'Alien: Covenant')
  t.is(alienPage.candidates[0].kind, 'acquirable')

  const matrixPage = await f.service.search({ selector: { title: 'mat', kind: 'movie' } })
  t.is(matrixPage.candidates.length, 1)
  t.is(matrixPage.candidates[0].title, 'Matrix.Reloaded.1999.1080p.mkv')
  t.is(matrixPage.candidates[0].kind, 'acquirable')

  const unknownPage = await f.service.search({ selector: { title: 'Nonexistent', kind: 'movie' } })
  t.is(unknownPage.candidates.length, 0)
})

test('in-flight search filters non-active states and handles episodic matching', async t => {
  const f = fixture()
  f.jobs.set('acq-failed', acquisition({
    acquisitionId: 'acq-failed',
    state: 'failed',
    publicationMetadata: {
      title: 'Failed Movie',
      mediaContext: { namespace: 'tmdb', identifier: '348', kind: 'movie' },
    },
  }))
  f.jobs.set('acq-cancelled', acquisition({
    acquisitionId: 'acq-cancelled',
    state: 'cancelled',
    publicationMetadata: {
      title: 'Cancelled Movie',
      mediaContext: { namespace: 'tmdb', identifier: '348', kind: 'movie' },
    },
  }))
  f.jobs.set('acq-ep-1', acquisition({
    acquisitionId: 'acq-ep-1',
    state: 'publishing',
    expectedBytes: 2048,
    publisherId: PUBLISHER,
    publicationMetadata: {
      title: 'Episode 1',
      mediaContext: { namespace: 'tmdb', identifier: '1399', kind: 'episode', season: 1, episode: 1 },
    },
  }))

  const moviePage = await f.service.search({ selector: SELECTOR })
  t.absent(moviePage.candidates.some(c => c.title === 'Failed Movie' || c.title === 'Cancelled Movie'))

  const ep1Page = await f.service.search({
    selector: { namespace: 'tmdb', identifier: '1399', kind: 'episode', season: 1, episode: 1 },
  })
  t.is(ep1Page.candidates.length, 1)
  t.is(ep1Page.candidates[0].title, 'Episode 1')

  const ep2Page = await f.service.search({
    selector: { namespace: 'tmdb', identifier: '1399', kind: 'episode', season: 1, episode: 2 },
  })
  t.is(ep2Page.candidates.length, 0)
})

test('in-flight resolution reflects published status once completed and verified', async t => {
  const f = fixture({ published: true })
  f.jobs.set('acq-completing', acquisition({
    acquisitionId: 'acq-completing',
    state: 'publishing',
    publisherId: PUBLISHER,
    publicationMetadata: {
      title: 'Published Title',
      mediaContext: { namespace: 'tmdb', identifier: '348', kind: 'movie' },
    },
  }))

  const page = await f.service.search({ selector: SELECTOR })
  const candidate = page.candidates[0]
  t.ok(candidate)

  // Simulate job completing with publication
  f.jobs.set('acq-completing', acquisition({
    acquisitionId: 'acq-completing',
    state: 'completed',
    publisherId: PUBLISHER,
    publicationId: PUBLICATION,
    renditionId: RENDITION,
  }))

  const resolved = await f.service.resolve({ ref: candidate.ref })
  t.is(resolved.kind, 'published')
  t.is(resolved.publicationId, PUBLICATION)
  t.is(resolved.renditionId, RENDITION)
})
