import test from 'brittle'

import { createArchiveParticipationApi } from '../src/api/archive-participation.js'
import { createStaticAssetManifest } from '../src/assets/static-core.js'

const publicationId = 'a'.repeat(64)
const renditionId = 'b'.repeat(64)
const coreKey = 'c'.repeat(64)

function fixture() {
  const calls = []
  const status = {
    enabled: false,
    capacityBytes: 0,
    maxRequestBytes: 8192,
    acceptanceProbability: 0.25,
    reservedBytes: 0,
    availableBytes: 0,
    acceptedRequests: 0,
    knownRequests: 0,
    receivedPledges: 0,
    randomRejections: 0,
    capacityRejections: 0,
    authorizationRejections: 0,
  }
  const archiveNetwork = {
    getStatus: () => ({ ...status }),
    async setParticipation(policy) {
      calls.push(['participation', policy])
      Object.assign(status, policy, { availableBytes: policy.capacityBytes ?? status.capacityBytes })
      return { ...status }
    },
    async requestArchive(request) {
      calls.push(['request', request])
      return { status: 'published', requestId: 'd'.repeat(64) }
    },
  }
  const core = createStaticAssetManifest({
    treeHash: 'c'.repeat(64),
    blockLength: 8,
    byteLength: 8 * 262144,
  })
  const manifest = {
    publicationId,
    body: {
      renditions: [{
        renditionId,
        core,
      }],
    },
  }
  const api = createArchiveParticipationApi({
    archiveNetwork,
    manifestStore: { getManifest: id => id === publicationId ? manifest : null },
  })
  return { api, calls, core }
}

test('archive participation is explicit, capacity-bounded, and observable', async (t) => {
  const { api, calls } = fixture()
  t.alike(await api.getArchiveParticipation({}), {
    success: true,
    enabled: false,
    capacityBytes: 0,
    maxRequestBytes: 8192,
    acceptancePermille: 250,
    reservedBytes: 0,
    availableBytes: 0,
    acceptedRequests: 0,
    knownRequests: 0,
    receivedPledges: 0,
    randomRejections: 0,
    capacityRejections: 0,
    authorizationRejections: 0,
  })
  const enabled = await api.setArchiveParticipation({
    enabled: true,
    capacityBytes: 8192,
    maxRequestBytes: 4096,
    acceptancePermille: 500,
  })
  t.is(enabled.success, true)
  t.alike(calls[0], ['participation', {
    enabled: true,
    capacityBytes: 8192,
    maxRequestBytes: 4096,
    acceptanceProbability: 0.5,
  }])
  t.is((await api.setArchiveParticipation({ enabled: true, acceptancePermille: 1001 })).errorCode, 'ARCHIVE_PARTICIPATION_INVALID')
})

test('archive requests derive a complete rendition range and byte count from the accepted manifest', async (t) => {
  const { api, calls, core } = fixture()
  const result = await api.requestArchivePublication({ publicationId, renditionId, retentionUntil: 50_000 })
  t.alike(result, { success: true, status: 'published', requestId: 'd'.repeat(64) })
  t.alike(calls[0], ['request', {
    publicationId,
    renditionId,
    ranges: [{ coreKey: core.assetId, start: 0, end: 8 }],
    requestedBytes: core.byteLength,
    retentionUntil: 50_000,
  }])
  t.is((await api.requestArchivePublication({ publicationId: 'x', renditionId })).errorCode, 'ARCHIVE_REQUEST_INVALID')
  t.is((await api.requestArchivePublication({ publicationId: 'e'.repeat(64), renditionId })).errorCode, 'ARCHIVE_PUBLICATION_NOT_FOUND')
})

test('archive APIs fail closed when the runtime has no signing identity', async (t) => {
  const api = createArchiveParticipationApi({ archiveNetwork: null, manifestStore: null })
  t.is((await api.getArchiveParticipation({})).errorCode, 'ARCHIVE_NETWORK_UNAVAILABLE')
  t.is((await api.setArchiveParticipation({ enabled: true, capacityBytes: 0, maxRequestBytes: 0, acceptancePermille: 0 })).errorCode, 'ARCHIVE_NETWORK_UNAVAILABLE')
  t.is((await api.requestArchivePublication({ publicationId, renditionId })).errorCode, 'ARCHIVE_NETWORK_UNAVAILABLE')
})
