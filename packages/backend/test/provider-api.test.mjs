import test from 'brittle'

import { createProviderApi } from '../src/api/provider.js'

const REF = 'A'.repeat(43)
const PUBLISHER_ID = 'b'.repeat(64)

function service(overrides = {}) {
  return {
    async search() { return { candidates: [], nextCursor: null } },
    async resolve() { return { schemaVersion: 1, resolutionRef: REF, publisherId: PUBLISHER_ID, title: 'Title', kind: 'acquirable', mediaContext: { kind: 'movie' }, expected: { byteLength: 8 }, acquisitionAvailable: true } },
    async requestAcquisition() { return { schemaVersion: 1, acquisitionId: 'acquisition-1', state: 'queued', retentionClass: 'archive-pin', bytesAcquired: 0, expectedBytes: 8, publicationId: null, manifestId: null, renditionId: null, assetId: null, errorCode: null, recoverable: false, createdAt: 1, updatedAt: 1 } },
    async attachSourceGrant() { return null },
    async getAcquisition() { return null },
    async listAcquisitions() { return { items: [], cursor: null } },
    async cancelAcquisition() { return null },
    async retryAcquisition() { return null },
    async forgetAcquisition() { return { acquisitionId: 'acquisition-1', forgotten: false, state: null } },
    async getPublication() { return null },
    async openStream() { return { schemaVersion: 1, publicationId: 'publication-1', renditionId: 'rendition-1', assetId: 'asset-1', url: 'http://127.0.0.1:8080/media', byteLength: 8, mimeType: 'video/mp4' } },
    async getStatus() { return { ready: true, searchAvailable: true, acquisitionAvailable: false, queuedAcquisitions: 0, activeAcquisitions: 0 } },
    async getPolicy() { return { schemaVersion: 1, revision: 0, searchEnabled: true, resolveEnabled: true, acquisitionEnabled: false } },
    async setPolicy(value) { return value },
    async getAcquisitionPolicy() { return { policyVersion: 1 } },
    async setAcquisitionPolicy({ policy }) { return policy },
    async migrateLegacyIngest() { return { migrated: 0, skipped: 0 } },
    ...overrides,
  }
}

test('provider RPC adapter maps consumer search and resolution without leaking backend records', async t => {
  const calls = []
  const api = createProviderApi({
    providerService: service({
      async search(request) {
        calls.push(request)
        return {
          candidates: [{
            schemaVersion: 1,
            ref: REF,
            title: 'The Matrix',
            mediaContext: { kind: 'movie', workEntityId: 'work-1', releaseYear: 1999 },
            kind: 'published',
            publicationId: 'publication-1',
            expectedBytes: 8,
          }],
          nextCursor: 'cursor-1',
        }
      },
    }),
    resolveTrustedPublisherId: async () => PUBLISHER_ID,
  })

  const searched = await api.providerSearch({ query: 'The Matrix', limit: 10 })
  t.alike(calls, [{ selector: { title: 'The Matrix', kind: 'movie' }, limit: 10 }])
  t.alike(searched, {
    success: true,
    hits: [{
      schemaVersion: 1,
      resolutionRef: REF,
      title: 'The Matrix',
      mediaKind: 'movie',
      subtitle: '1999',
      published: true,
      acquirable: false,
      entityId: 'work-1',
      publicationId: 'publication-1',
      expectedBytes: 8,
    }],
    nextCursor: 'cursor-1',
  })

  const resolved = await api.resolveProviderRef({ resolutionRef: REF })
  t.is(resolved.success, true)
  t.is(resolved.resolution.publisherId, PUBLISHER_ID)
  t.is(resolved.resolution.acquirable, true)
})

test('provider RPC adapter injects one stable local principal and preserves policy CAS', async t => {
  const calls = []
  const api = createProviderApi({
    providerService: service({
      async requestAcquisition(input) {
        calls.push(input)
        return service().requestAcquisition()
      },
      async setAcquisitionPolicy(input) {
        calls.push(input)
        return input.policy
      },
      async setPolicy(input) {
        calls.push(input)
        return input.policy
      },
    }),
    resolveTrustedPublisherId: async () => PUBLISHER_ID,
    principalId: 'device-1',
    acquisitionPolicyRevision: { async get() { return 4 } },
  })

  const requested = await api.requestAcquisition({
    idempotencyKey: 'request-1',
    request: {
      schemaVersion: 1,
      resolutionRef: REF,
      publisherId: PUBLISHER_ID,
      retentionClass: 'archive-pin',
      retentionUntil: 0,
      retentionUntilPresent: false,
    },
  })
  t.is(requested.success, true)
  t.absent(requested.replayed)
  t.alike(calls[0].principal, {
    principalId: 'device-1',
    publisherId: PUBLISHER_ID,
    isLocal: true,
    publisherIds: [PUBLISHER_ID],
  })
  t.absent(calls[0].request.retentionUntil)

  const policy = await api.setAcquisitionPolicy({
    expectedRevision: 3,
    policy: { policyVersion: 1, revision: 3 },
    consent: { version: 1, granted: true },
  })

  const forbidden = await api.requestAcquisition({
    idempotencyKey: 'request-2',
    request: {
      schemaVersion: 1,
      resolutionRef: REF,
      publisherId: 'c'.repeat(64),
      retentionClass: 'archive-pin',
    },
  })
  t.is(forbidden.success, false)
  t.is(forbidden.error.code, 'ACQUISITION_FORBIDDEN')
  t.alike(calls[1], {
    policy: { policyVersion: 1 },
    consent: { version: 1, granted: true },
    expectedRevision: 3,
  })
  t.is(policy.success, true)
  t.is(policy.policy.revision, 4)
  const providerPolicy = await api.setProviderPolicy({
    expectedRevision: 7,
    policy: { schemaVersion: 1, revision: 7, searchEnabled: true, resolveEnabled: true, acquisitionEnabled: false },
  })
  t.alike(calls[2], {
    policy: { schemaVersion: 1, searchEnabled: true, resolveEnabled: true, acquisitionEnabled: false },
    expectedRevision: 7,
  })
  t.is(providerPolicy.success, true)
})

test('provider RPC adapter returns bounded structured errors and stream descriptors', async t => {
  const api = createProviderApi({
    providerService: service({
      async search() {
        const error = new Error('Index is offline')
        error.code = 'SOURCE_UNAVAILABLE'
        error.retryable = true
        throw error
      },
    }),
  })

  const failed = await api.providerSearch({ query: 'title' })
  t.alike(failed, {
    success: false,
    hits: [],
    error: { code: 'SOURCE_UNAVAILABLE', message: 'Index is offline', retryable: true },
  })

  const opened = await createProviderApi({ providerService: service() }).openProviderStream({ publicationId: 'publication-1' })
  t.alike(opened, {
    success: true,
    stream: {
      schemaVersion: 1,
      url: 'http://127.0.0.1:8080/media',
      publicationId: 'publication-1',
      renditionId: 'rendition-1',
      assetId: 'asset-1',
      byteLength: 8,
      mimeType: 'video/mp4',
    },
  })
})
