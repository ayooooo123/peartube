import test from 'brittle'
import b4a from 'b4a'

import {
  CompanionContractError,
  decodeAcquisitionBody,
  decodeAcquisitionPolicyBody,
  decodeAcquisitionListQuery,
  decodeSourceGrantBody
} from '../src/companion/contracts.js'
import { COMPANION_ROUTE_SCOPES, createCompanionRouter } from '../src/companion/routes.js'

const ALL_SCOPES = new Set(Object.values(COMPANION_ROUTE_SCOPES))

function principal (scopes = ALL_SCOPES, publisherId = 'publisher-1') {
  return { id: 'machine-1', publisherId, scopes }
}

function request (method, url, body = null, overrides = {}) {
  return {
    method,
    url,
    body: body == null ? b4a.alloc(0) : b4a.from(typeof body === 'string' ? body : JSON.stringify(body)),
    principal: principal(),
    serverState: { transport: 'unix', socketPath: '/tmp/peartube.sock' },
    ...overrides
  }
}

function acquisition (overrides = {}) {
  return {
    schemaVersion: 1,
    acquisitionId: 'acq-1',
    state: 'queued',
    retentionClass: 'archive-pin',
    bytesAcquired: 0,
    expectedBytes: 1024,
    publicationId: null,
    manifestId: null,
    renditionId: null,
    assetId: null,
    errorCode: null,
    recoverable: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function acquisitionBody (overrides = {}) {
  return {
    idempotencyKey: 'idem-1',
    request: {
      schemaVersion: 1,
      resolutionRef: 'resolution-1',
      publisherId: 'publisher-1',
      retentionClass: 'archive-pin',
      ...overrides
    }
  }
}

test('acquisition contracts accept only the bounded public request and private grant envelope', (t) => {
  t.alike(decodeAcquisitionBody(b4a.from(JSON.stringify(acquisitionBody()))), acquisitionBody())
  t.alike(
    decodeAcquisitionBody(b4a.from(JSON.stringify(acquisitionBody({ sourceFileName: 'Dune.Part.Two.2024.2160p.UHD.BluRay.x265.mkv' })))),
    acquisitionBody({ sourceFileName: 'Dune.Part.Two.2024.2160p.UHD.BluRay.x265.mkv' })
  )
  t.exception(() => decodeAcquisitionBody(b4a.from(JSON.stringify(acquisitionBody({ sourceFileName: '../escape/dune.mkv' })))), CompanionContractError)
  t.exception(() => decodeAcquisitionBody(b4a.from(JSON.stringify(acquisitionBody({ sourceDescriptor: { url: 'https://forbidden.invalid' } })))), CompanionContractError)
  t.exception(() => decodeAcquisitionBody(b4a.from(JSON.stringify(acquisitionBody({ sourceCapability: 'forbidden' })))), CompanionContractError)
  t.exception(() => decodeAcquisitionBody(b4a.from(JSON.stringify(acquisitionBody({ resolutionRef: 'https://forbidden.invalid' })))), CompanionContractError)
  t.alike(decodeSourceGrantBody(b4a.from('{"grant":{"token":"private","url":"https://private.invalid"}}')), {
    grant: { token: 'private', url: 'https://private.invalid' }
  })

  const query = new URLSearchParams('cursor=next-1&limit=2&states=queued,failed')
  t.alike(decodeAcquisitionListQuery(query), { cursor: 'next-1', limit: 2, states: ['queued', 'failed'] })
  t.exception(() => decodeAcquisitionListQuery(new URLSearchParams('states=queued,queued')), CompanionContractError)
})

test('acquisition routes request, replay, get, list and cancel through ProviderService', async (t) => {
  const records = new Map()
  const idempotency = new Map()
  const calls = []
  const service = {
    async requestAcquisition ({ idempotencyKey, request, principal }) {
      calls.push(['request', principal.id, request.publisherId])
      const prior = idempotency.get(`${principal.id}\0${request.publisherId}\0${idempotencyKey}`)
      if (prior) return { acquisition: prior, replayed: true }
      const value = acquisition()
      records.set(value.acquisitionId, value)
      idempotency.set(`${principal.id}\0${request.publisherId}\0${idempotencyKey}`, value)
      return { acquisition: value, replayed: false }
    },
    async getAcquisition ({ acquisitionId, principal }) {
      calls.push(['get', principal.id, acquisitionId])
      return records.get(acquisitionId) || null
    },
    async listAcquisitions ({ cursor, limit, states, principal }) {
      calls.push(['list', principal.id, cursor, limit, states])
      return { items: [...records.values()], nextCursor: null }
    },
    async cancelAcquisition ({ acquisitionId, principal }) {
      calls.push(['cancel', principal.id, acquisitionId])
      const value = acquisition({ ...(records.get(acquisitionId) || {}), state: 'cancelled', updatedAt: 2 })
      records.set(acquisitionId, value)
      return value
    },
    async retryAcquisition ({ acquisitionId, principal }) {
      calls.push(['retry', principal.id, acquisitionId])
      const value = acquisition({ ...(records.get(acquisitionId) || {}), state: 'queued', attempts: 1, updatedAt: 3 })
      records.set(acquisitionId, value)
      return value
    },
  }
  const router = createCompanionRouter({ service })
  const created = await router.dispatch(request('POST', '/api/v2/acquisitions', acquisitionBody()))
  const replay = await router.dispatch(request('POST', '/api/v2/acquisitions', acquisitionBody()))
  const got = await router.dispatch(request('GET', '/api/v2/acquisitions/acq-1'))
  const listed = await router.dispatch(request('GET', '/api/v2/acquisitions?limit=2&states=queued'))
  const cancelled = await router.dispatch(request('DELETE', '/api/v2/acquisitions/acq-1'))
  const retried = await router.dispatch(request('POST', '/api/v2/acquisitions/acq-1/retry'))

  t.is(created.statusCode, 202)
  t.alike(replay.body.acquisition, created.body.acquisition, 'idempotent replay returns the same public acquisition')
  t.alike(got.body.acquisition, created.body.acquisition)
  t.is(retried.statusCode, 200)
  t.is(retried.body.acquisition.state, 'queued')
  t.is(listed.body.items.length, 1)
  t.is(listed.body.nextCursor, null)
  t.is(cancelled.body.acquisition.state, 'cancelled')
  t.alike(calls.map(call => call[0]), ['request', 'request', 'get', 'list', 'cancel', 'retry'])
  t.is(JSON.stringify(created.body).includes('sourceDescriptor'), false)
  t.is(JSON.stringify(created.body).includes('sourceCapability'), false)
})

test('POST /api/v2/acquisitions/contribute issues local resolution and requests acquisition', async (t) => {
  const calls = []
  const service = {
    issueLocalResolution (input) {
      calls.push(['issueLocalResolution', input])
      return { resolutionRef: 'A'.repeat(43) }
    },
    async requestAcquisition ({ idempotencyKey, request, principal }) {
      calls.push(['requestAcquisition', idempotencyKey, request])
      return {
        acquisition: acquisition({
          acquisitionId: 'acq-contribute-1',
          title: 'The Matrix',
          retentionClass: request.retentionClass,
          state: 'queued'
        })
      }
    }
  }
  const router = createCompanionRouter({ service })
  const body = {
    idempotencyKey: 'contrib-1',
    title: 'The Matrix',
    selector: { kind: 'movie', namespace: 'tmdb', identifier: '603' },
    expectedBytes: 2048,
    retentionClass: 'contribution-cache',
    sourceFileName: 'matrix.mkv'
  }
  const res = await router.dispatch(request('POST', '/api/v2/acquisitions/contribute', body))
  t.is(res.statusCode, 202)
  t.is(res.body.acquisition.acquisitionId, 'acq-contribute-1')
  t.is(res.body.acquisition.state, 'queued')
  t.alike(calls.map(call => call[0]), ['issueLocalResolution', 'requestAcquisition'])
  t.is(calls[0][1].title, 'The Matrix')
  t.is(calls[1][1], 'contrib-1')
  t.is(calls[1][2].resolutionRef, 'A'.repeat(43))
})

test('route scopes separate acquisition request, read, cancel and private grant authority', async (t) => {
  const service = {
    requestAcquisition: async () => acquisition(),
    getAcquisition: async () => acquisition(),
    cancelAcquisition: async () => acquisition({ state: 'cancelled', updatedAt: 2 }),
    attachSourceGrant: async () => acquisition(),
    retryAcquisition: async () => acquisition({ state: 'queued', updatedAt: 3 }),
  }
  const router = createCompanionRouter({ service })
  const onlyRead = principal(new Set([COMPANION_ROUTE_SCOPES.acquisitionRead]))

  t.is((await router.dispatch(request('GET', '/api/v2/acquisitions/acq-1', null, { principal: onlyRead }))).statusCode, 200)
  t.is((await router.dispatch(request('POST', '/api/v2/acquisitions', acquisitionBody(), { principal: onlyRead }))).statusCode, 403)
  t.is((await router.dispatch(request('DELETE', '/api/v2/acquisitions/acq-1', null, { principal: onlyRead }))).statusCode, 403)
  t.is((await router.dispatch(request('POST', '/api/v2/acquisitions/acq-1/source-grants', { grant: { token: 'private' } }, { principal: onlyRead }))).statusCode, 403)
  t.is((await router.dispatch(request('POST', '/api/v2/acquisitions/acq-1/retry', null, { principal: onlyRead }))).statusCode, 403)
  const onlyRequest = principal(new Set([COMPANION_ROUTE_SCOPES.acquisitionRequest]))
  t.is((await router.dispatch(request('POST', '/api/v2/acquisitions/acq-1/retry', null, { principal: onlyRequest }))).statusCode, 403)
  const onlyRetry = principal(new Set([COMPANION_ROUTE_SCOPES.acquisitionRetry]))
  t.is((await router.dispatch(request('POST', '/api/v2/acquisitions/acq-1/retry', null, { principal: onlyRetry }))).statusCode, 200)
})

test('private source grants are accepted only on Unix or in-process and never echoed', async (t) => {
  let attached = null
  const router = createCompanionRouter({
    service: {
      async attachSourceGrant (input) {
        attached = input
        return acquisition()
      }
    }
  })
  const body = { grant: { token: 'private-token', url: 'https://private.invalid/media' } }
  const local = await router.dispatch(request('POST', '/api/v2/acquisitions/acq-1/source-grants', body))
  t.is(local.statusCode, 200)
  t.is(attached.grant.token, 'private-token')
  t.is(JSON.stringify(local.body).includes('private-token'), false)
  t.is(JSON.stringify(local.body).includes('private.invalid'), false)

  attached = null
  const tcp = await router.dispatch(request('POST', '/api/v2/acquisitions/acq-1/source-grants', body, {
    serverState: { transport: 'tcp', host: '127.0.0.1', port: 8175 }
  }))
  t.is(tcp.statusCode, 403)
  t.is(attached, null)

  const inProcess = await router.dispatch(request('POST', '/api/v2/acquisitions/acq-1/source-grants', body, {
    inProcess: true,
    serverState: { transport: 'tcp' }
  }))
  t.is(inProcess.statusCode, 200)
})

test('wrong principal or publisher errors remain forbidden and bounded', async (t) => {
  const service = {
    async getAcquisition ({ principal }) {
      const error = new Error(principal.id === 'wrong-machine' ? 'principal mismatch' : 'publisher mismatch')
      error.code = principal.id === 'wrong-machine' ? 'PRINCIPAL_MISMATCH' : 'PUBLISHER_MISMATCH'
      throw error
    }
  }
  const router = createCompanionRouter({ service })
  const wrongPrincipal = await router.dispatch(request('GET', '/api/v2/acquisitions/acq-1', null, {
    principal: { id: 'wrong-machine', publisherId: 'publisher-1', scopes: ALL_SCOPES }
  }))
  const wrongPublisher = await router.dispatch(request('GET', '/api/v2/acquisitions/acq-1', null, {
    principal: principal(ALL_SCOPES, 'publisher-2')
  }))
  t.is(wrongPrincipal.statusCode, 403)
  t.is(wrongPublisher.statusCode, 403)
  t.is(b4a.byteLength(JSON.stringify(wrongPublisher.body)) <= 512, true)
})

test('status strips private source, capability, locator and authentication material', async (t) => {
  const router = createCompanionRouter({
    service: {
      getStatus () {
        return {
          acquisitionsByState: { queued: 1 },
          sourceGrant: 'forbidden',
          adapter: 'private-adapter',
          token: 'forbidden-token',
          nested: { sourceUrl: 'https://forbidden.invalid/media', safe: 1 }
        }
      }
    }
  })
  const response = await router.dispatch(request('GET', '/api/v2/status'))
  const serialized = JSON.stringify(response.body)
  t.is(response.statusCode, 200)
  t.is(serialized.includes('forbidden'), false)
  t.is(serialized.includes('private-adapter'), false)
  t.is(response.body.diagnostics.nested.safe, 1)
})

test('acquisition policy updates require consent and revision and forward both', async t => {
  const policy = {
    policyVersion: 1,
    consentVersion: 1,
    migrationRequired: false,
    enabled: true,
    acceptPublicRequests: false,
    requesterMode: 'local-only',
    allowedPublisherIds: ['publisher-1'],
    allowedAdapterIds: ['local-file'],
    maxQueuedJobs: 4,
    maxConcurrentJobs: 1,
    maxConcurrentPerRequester: 1,
    maxRequestBytes: 4096,
    maxAcquireBytesPer24h: 4096,
    maxAcquireBytesPerSecond: 4096,
    maxStagingBytes: 4096,
    minFreeDiskBytes: 1,
    maxJobRuntimeMs: 60_000,
    sourceGrantTtlMs: 30_000,
    publicRequestsPerMinute: 1,
    maxAttempts: 2,
    retryBaseMs: 1,
    retryMaxMs: 10
  }
  const body = { policy, expectedRevision: 2, consent: { version: 1, granted: true } }
  t.alike(decodeAcquisitionPolicyBody(b4a.from(JSON.stringify(body))), body)
  t.exception(() => decodeAcquisitionPolicyBody(b4a.from(JSON.stringify({ policy }))), /Missing expectedRevision|Missing consent/)

  let received = null
  const router = createCompanionRouter({
    service: {
      async setAcquisitionPolicy(input) {
        received = input
        return input.policy
      }
    }
  })
  const response = await router.dispatch(request('PUT', '/api/v2/acquisition-policy', body))
  t.is(response.statusCode, 200)
  t.is(received.expectedRevision, 2)
  t.alike(received.consent, { version: 1, granted: true })
})

test('legacy ingest routes are absent', async (t) => {
  const router = createCompanionRouter({ service: {} })
  t.is((await router.dispatch(request('POST', '/api/v2/ingest/jobs', {}))).statusCode, 404)
  t.is((await router.dispatch(request('GET', '/api/v2/ingest/jobs/old-job'))).statusCode, 404)
})
