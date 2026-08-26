import test from 'brittle'
import b4a from 'b4a'

import {
  CompanionContractError,
  decodeIngestJobBody,
  decodeJsonBody,
  decodeOpenStreamBody,
  decodePolicyControlBody,
  decodeSearchQuery,
  errorBody
} from '../src/companion/contracts.js'
import { createCompanionRouter } from '../src/companion/routes.js'
import { createStreamCapabilityStore } from '../src/companion/stream-capabilities.js'

const CLIENT = 'client-test'
const NOW = 1_786_406_400_000
const REF = 'A'.repeat(43)

function candidate (overrides = {}) {
  return {
    candidateRef: REF,
    work: { title: 'The Matrix', releaseYear: 1999 },
    publication: { publicationId: 'publication-1', publisherId: 'publisher-1' },
    rendition: { renditionId: 'rendition-1', container: 'mkv' },
    asset: { assetId: 'asset-1' },
    sourceIndexers: [{ indexerId: 'indexer-1', playbackUrl: 'https://forbidden.invalid/play' }],
    streamUrl: 'https://forbidden.invalid/stream',
    downloadLink: 'magnet:?xt=urn:btih:forbidden',
    ...overrides
  }
}

function request (method, path, body = '') {
  return {
    method,
    url: path,
    body: b4a.from(body),
    headers: {},
    clientIdentity: CLIENT,
    serverState: { enabled: true, transport: 'unix', socketPath: '/tmp/companion.sock' }
  }
}

function hasUrlField (value) {
  if (Array.isArray(value)) return value.some(hasUrlField)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => /url/i.test(key) || hasUrlField(child))
}

test('search decoder accepts exact movie and exact episode selectors', (t) => {
  t.alike(
    decodeSearchQuery(new URLSearchParams('namespace=tmdb&identifier=348&kind=movie&limit=64')),
    { selector: { namespace: 'tmdb', identifier: '348', kind: 'movie' }, limit: 64, cursor: null }
  )
  t.alike(
    decodeSearchQuery(new URLSearchParams('namespace=tmdb&identifier=1399&kind=episode&season=1&episode=2')),
    { selector: { namespace: 'tmdb', identifier: '1399', kind: 'episode', season: 1, episode: 2 }, limit: 20, cursor: null }
  )
})

test('search decoder accepts bounded title/year fallback and pagination', (t) => {
  t.alike(
    decodeSearchQuery(new URLSearchParams('title=Arrival&year=2016&kind=movie&limit=7&cursor=next_1')),
    { selector: { title: 'Arrival', year: 2016, kind: 'movie' }, limit: 7, cursor: 'next_1' }
  )
  t.alike(
    decodeSearchQuery(new URLSearchParams('title=Pilot&kind=episode&season=1&episode=1')),
    { selector: { title: 'Pilot', kind: 'episode', season: 1, episode: 1 }, limit: 20, cursor: null }
  )
})

test('search decoder rejects partial, duplicate, unknown, and unbounded fields', (t) => {
  for (const query of [
    'season=1&kind=episode',
    'namespace=tmdb&kind=movie',
    'title=Arrival&namespace=tmdb&identifier=348&kind=movie',
    'namespace=tmdb&identifier=348&kind=movie&season=1',
    'namespace=tmdb&identifier=1399&kind=episode&season=0&episode=2',
    'namespace=tmdb&identifier=1399&kind=episode&season=1&episode=-2',
    'title=Arrival&year=10000&kind=movie',
    'title=Arrival&kind=series',
    'title=Arrival&kind=movie&limit=65',
    'title=Arrival&kind=movie&limit=1&limit=2',
    'title=Arrival&kind=movie&unknown=1'
  ]) t.exception(() => decodeSearchQuery(new URLSearchParams(query)))
  t.exception(() => decodeSearchQuery(new URLSearchParams(`title=${'x'.repeat(257)}&kind=movie`)))
  t.exception(() => decodeSearchQuery(new URLSearchParams('namespace=TMDB&identifier=348&kind=movie')))
  t.exception(() => decodeSearchQuery(new URLSearchParams('namespace=tmdb&identifier=e%CC%81&kind=movie')))
  t.exception(() => decodeSearchQuery(new URLSearchParams('namespace=tmdb&identifier=a%C2%85b&kind=movie')))
})

test('JSON body decoders reject malformed JSON, unknown fields, and invalid IDs', (t) => {
  t.exception(() => decodeJsonBody(b4a.from('{')))
  t.exception(() => decodeOpenStreamBody(b4a.from('{}')))
  t.exception(() => decodeOpenStreamBody(b4a.from('{"candidateRef":"short"}')))
  t.exception(() => decodeOpenStreamBody(b4a.from(`{"candidateRef":"${REF}","url":"https://forbidden.invalid"}`)))
  t.exception(() => decodeOpenStreamBody(b4a.from(`{"candidateRef":"${REF}","candidateRef":"${REF}"}`)))
  t.alike(decodeOpenStreamBody(b4a.from(`{"candidateRef":"${REF}"}`)), { candidateRef: REF })

  const job = decodeIngestJobBody(b4a.from('{"idempotencyKey":"watch-1","request":{"workId":"work-1"}}'))
  t.alike(job, { idempotencyKey: 'watch-1', request: { workId: 'work-1' } })
  t.exception(() => decodeIngestJobBody(b4a.from('{"idempotencyKey":"watch-1","unknown":true}')))
  t.exception(() => decodeIngestJobBody(b4a.from('{"idempotencyKey":"watch-1","request":{"sourceUrl":"https://forbidden.invalid"}}')))
  t.exception(() => decodeIngestJobBody(b4a.from('{"idempotencyKey":"watch-1","request":{"source":"magnet:?xt=urn:btih:forbidden"}}')))
  t.exception(() => decodeIngestJobBody(b4a.from('{"idempotencyKey":"watch-1","request":{"downloadLink":"opaque"}}')))
})

test('structured contract errors are bounded and include an optional field', (t) => {
  const error = new CompanionContractError(400, 'INVALID_FIELD', 'Invalid search field', 'season')
  t.alike(errorBody(error), { error: { code: 'INVALID_FIELD', message: 'Invalid search field', field: 'season' } })
  const fallback = errorBody(Object.assign(new Error('secret '.repeat(200)), { code: 'not valid!' }))
  t.is(fallback.error.code, 'INTERNAL_ERROR')
  t.ok(b4a.byteLength(JSON.stringify(fallback)) <= 512)
})

test('router dispatches search with bounded work and strips embedded locators recursively', async (t) => {
  let selector = null
  let options = null
  const router = createCompanionRouter({
    service: {
      async searchIndexCandidates (input, searchOptions) {
        selector = input
        options = searchOptions
        return [candidate({
          work: { title: 'Watch _magnet:?q=forbidden', releaseYear: 1999, externalRefs: [{ namespace: 'tmdb', identifier: 'show:95350:s1:e2' }] },
          publication: { publicationId: 'publication-1', publisherId: 'publisher-1', title: 'x:opaque' }
        })]
      }
    },
    config: { client: { id: CLIENT } },
    clock: () => NOW
  })
  const result = await router.dispatch(request('GET', '/api/v2/search?namespace=tmdb&identifier=348&kind=movie&limit=1'))
  t.is(result.statusCode, 200)
  t.alike(selector, { namespace: 'tmdb', identifier: '348', kind: 'movie' })
  t.is(options.limit, 1)
  t.is(result.body.candidates.length, 1)
  t.not(hasUrlField(result.body), true)
  const serialized = JSON.stringify(result.body)
  t.not(serialized.includes('forbidden.invalid'), true)
  t.not(serialized.includes('magnet:'), true)
  t.is(result.body.candidates[0].work.externalRefs[0].identifier, 'show:95350:s1:e2')
})

test('episode search delegates the show coordinates and its ordinals', async (t) => {
  let selector = null
  let options = null
  const router = createCompanionRouter({
    service: {
      async searchIndexCandidates (input, searchOptions) {
        selector = input
        options = searchOptions
        return [candidate({ work: { title: 'Winter Is Coming', releaseYear: 2011 } })]
      }
    },
    clock: () => NOW
  })
  const result = await router.dispatch(request('GET', '/api/v2/search?namespace=tmdb&identifier=1399&kind=episode&season=1&episode=2&limit=3&cursor=page_2'))
  t.is(result.statusCode, 200)
  t.alike(selector, { namespace: 'tmdb', identifier: '1399', kind: 'episode', season: 1, episode: 2 })
  t.is(options.limit, 3)
  t.is(options.cursor, 'page_2')
  t.is(result.body.candidates.length, 1)
  t.not(hasUrlField(result.body), true)
})

test('an episode the relay does not hold answers 200 with no candidates', async (t) => {
  const router = createCompanionRouter({
    service: {
      async searchIndexCandidates () {
        return []
      }
    },
    clock: () => NOW
  })
  const result = await router.dispatch(request('GET', '/api/v2/search?namespace=tmdb&identifier=1399&kind=episode&season=9&episode=9'))
  t.is(result.statusCode, 200)
  t.alike(result.body, { candidates: [], cursor: null })
})

test('open verifies a candidate, resolves its asset, and returns a scoped reusable capability', async (t) => {
  let verifiedRef = null
  const asset = {
    assetId: 'asset-1',
    byteLength: 8,
    async requestRange () {},
    async release () {}
  }
  const capabilities = createStreamCapabilityStore({
    now: () => NOW,
    randomBytes: () => b4a.alloc(32, 7),
    ttlMs: 1_000,
    maxEntries: 2
  })
  const router = createCompanionRouter({
    service: {
      async verifyIndexCandidate (candidateRef) {
        verifiedRef = candidateRef
        return candidate({ streamUrl: 'https://forbidden.invalid' })
      },
      async openStreamAsset () {
        return asset
      }
    },
    config: { client: { id: CLIENT } },
    clock: () => NOW,
    capabilities
  })
  const opened = await router.dispatch(request('POST', '/api/v2/streams/open', `{"candidateRef":"${REF}"}`))
  t.is(opened.statusCode, 200)
  t.is(verifiedRef, REF)
  t.is(opened.body.expiresAt, NOW + 1_000)
  t.is(opened.body.publicationId, 'publication-1')
  t.is(opened.body.renditionId, 'rendition-1')
  const token = new URL(opened.body.url, 'http://companion.invalid').searchParams.get('cap')
  t.ok(token)

  const publicRequest = capabilities.consume(token, {
    publicationId: 'publication-1',
    renditionId: 'rendition-1',
    method: 'GET'
  })
  t.is(publicRequest.asset, asset)
  publicRequest.release()
})

test('stream capability rejects wrong client, path scope, token, and expiry before acquisition', (t) => {
  let now = NOW
  const capabilities = createStreamCapabilityStore({ now: () => now, randomBytes: () => b4a.alloc(32, 8), ttlMs: 100, maxEntries: 4 })
  const granted = capabilities.issue({ clientIdentity: CLIENT, publicationId: 'pub-1', renditionId: 'rend-1', assetId: 'asset-1' })
  const exact = { publicationId: 'pub-1', renditionId: 'rend-1', method: 'GET' }

  t.exception(() => capabilities.consume(granted.token, { ...exact, clientIdentity: 'other-client' }))
  t.exception(() => capabilities.consume(granted.token, { ...exact, publicationId: 'pub-2' }))
  t.exception(() => capabilities.consume('bad', exact))
  const publicRequest = capabilities.consume(granted.token, exact)
  publicRequest.release()
  now += 101
  t.exception(() => capabilities.consume(granted.token, exact))
})

test('capability capacity fails closed without evicting live grants', (t) => {
  let byte = 1
  const capabilities = createStreamCapabilityStore({ now: () => NOW, randomBytes: () => b4a.alloc(32, byte++), ttlMs: 1_000, maxEntries: 2 })
  const first = capabilities.issue({ clientIdentity: CLIENT, publicationId: 'p1', renditionId: 'r1', assetId: 'a1' })
  capabilities.issue({ clientIdentity: CLIENT, publicationId: 'p2', renditionId: 'r2', assetId: 'a2' })
  let error = null
  try {
    capabilities.issue({ clientIdentity: CLIENT, publicationId: 'p3', renditionId: 'r3', assetId: 'a3' })
  } catch (caught) {
    error = caught
  }
  t.is(error?.code, 'CAPABILITY_CAPACITY_EXHAUSTED')
  t.is(capabilities.size, 2)
  const consumption = capabilities.consume(first.token, { clientIdentity: CLIENT, publicationId: 'p1', renditionId: 'r1', method: 'GET' })
  t.is(consumption.assetId, 'a1')
  consumption.release()
})

test('publication, job, status, method, and path routes dispatch deterministically', async (t) => {
  const calls = []
  const router = createCompanionRouter({
    service: {
      async getPublication (publicationId) { calls.push(['publication', publicationId]); return { publicationId } },
      async submitIngestJob (input) { calls.push(['submit', input.idempotencyKey]); return { jobId: 'job-1', state: 'queued' } },
      async getIngestJob (jobId) { calls.push(['get', jobId]); return { jobId, state: 'queued' } },
      async cancelIngestJob (jobId) { calls.push(['cancel', jobId]); return { jobId, state: 'cancelled' } },
      getStatus () {
        return {
          runtime: { network: { peers: 2 }, sharedSecret: 'forbidden', nested: { playbackUrl: 'https://forbidden.invalid' } },
          config: { password: 'forbidden' }
        }
      }
    },
    config: { transport: 'unix', client: { id: CLIENT, key: 'forbidden' }, sharedSecret: 'forbidden' },
    clock: () => NOW
  })

  t.is((await router.dispatch(request('GET', '/api/v2/publications/pub-1'))).statusCode, 200)
  t.is((await router.dispatch(request('POST', '/api/v2/ingest/jobs', '{"idempotencyKey":"watch-1","request":{}}'))).statusCode, 202)
  t.is((await router.dispatch(request('GET', '/api/v2/ingest/jobs/job-1'))).statusCode, 200)
  t.is((await router.dispatch(request('DELETE', '/api/v2/ingest/jobs/job-1'))).statusCode, 200)
  t.alike(calls.map(call => call[0]), ['publication', 'submit', 'get', 'cancel'])

  const status = await router.dispatch(request('GET', '/api/v2/status'))
  t.is(status.statusCode, 200)
  t.is(status.body.transport.mode, 'unix')
  t.is(status.body.auth.mode, 'mac')
  const serialized = JSON.stringify(status.body)
  t.not(serialized.includes('forbidden'), true)
  t.not(/secret|password|playbackUrl/.test(serialized), true)

  const wrongMethod = await router.dispatch(request('POST', '/api/v2/status', '{}'))
  t.is(wrongMethod.statusCode, 405)
  t.is(wrongMethod.headers.allow, 'GET')
  t.is((await router.dispatch(request('GET', '/api/v2/missing'))).statusCode, 404)
  t.is((await router.dispatch(request('GET', '/api/v2/publications/bad%2Fid'))).statusCode, 400)
})

test('policy control requires a complete current snapshot and dispatches it once', async (t) => {
  const policy = {
    policyVersion: 2,
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
    archiveEnabled: false,
    contributionBudgetBytes: 4096,
    archiveBudgetBytes: 8192,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 4096
  }
  t.alike(decodePolicyControlBody(b4a.from(JSON.stringify(policy))), policy)

  const calls = []
  const router = createCompanionRouter({
    service: {
      async applyNetworkPolicy (value) {
        calls.push(value)
        return { ...value, effectiveRole: 'contributor', permissions: { contribute: true, archive: false }, ingestReady: true }
      }
    },
    clock: () => NOW
  })
  const applied = await router.dispatch(request('PUT', '/api/v2/policy', JSON.stringify(policy)))
  t.is(applied.statusCode, 200)
  t.is(applied.body.policy.ingestReady, true)
  t.is(calls.length, 1)

  const missing = { ...policy }
  delete missing.consentVersion
  const rejected = await router.dispatch(request('PUT', '/api/v2/policy', JSON.stringify(missing)))
  t.is(rejected.statusCode, 400)
  t.is(rejected.body.error.code, 'MISSING_FIELD')
  t.is(calls.length, 1)

  const mismatched = { ...policy, uploadCeilingBytes: 8192 }
  t.is((await router.dispatch(request('PUT', '/api/v2/policy', JSON.stringify(mismatched)))).statusCode, 400)
  t.is(calls.length, 1)
})

test('router rejects malformed search candidates and mismatched verification results', async (t) => {
  const searchRouter = createCompanionRouter({
    service: { searchIndexCandidates: async () => ['malformed'] },
    clock: () => NOW
  })
  const search = await searchRouter.dispatch(request('GET', '/api/v2/search?namespace=tmdb&identifier=348&kind=movie'))
  t.is(search.statusCode, 502)
  t.is(search.body.error.code, 'BACKEND_CONTRACT_INVALID')

  const openRouter = createCompanionRouter({
    service: { verifyIndexCandidate: async () => candidate({ candidateRef: 'B'.repeat(43) }) },
    clock: () => NOW
  })
  const opened = await openRouter.dispatch(request('POST', '/api/v2/streams/open', `{"candidateRef":"${REF}"}`))
  t.is(opened.statusCode, 502)
  t.is(opened.body.error.code, 'BACKEND_CONTRACT_INVALID')
})

test('missing backend capabilities return explicit bounded unavailable errors', async (t) => {
  const router = createCompanionRouter({ service: { getStatus: () => ({}) }, config: { client: { id: CLIENT } }, clock: () => NOW })
  const search = await router.dispatch(request('GET', '/api/v2/search?namespace=tmdb&identifier=348&kind=movie'))
  const job = await router.dispatch(request('POST', '/api/v2/ingest/jobs', '{"idempotencyKey":"watch-1","request":{}}'))
  t.is(search.statusCode, 501)
  t.is(search.body.error.code, 'CAPABILITY_UNAVAILABLE')
  t.is(job.statusCode, 501)
  t.ok(b4a.byteLength(JSON.stringify(job.body)) <= 512)
})
