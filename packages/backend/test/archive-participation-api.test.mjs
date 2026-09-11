import test from 'brittle'
import { EventEmitter } from 'node:events'
import crypto from 'hypercore-crypto'

import { createArchiveParticipationApi } from '../src/api/archive-participation.js'
import { createStaticAssetManifest } from '../src/assets/static-core.js'
import { createPermissionlessArchiveNetwork } from '../src/archive/permissionless-network.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'

const publicationId = 'a'.repeat(64)
const renditionId = 'b'.repeat(64)

function fixture() {
  const calls = []
  const archiveNetwork = {
    async setParticipation() {
      calls.push('participation')
      throw new Error('Invalid participation reached the network')
    },
    async requestArchive() {
      calls.push('request')
      throw new Error('Invalid archive request reached the network')
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
  return { api, calls }
}

test('archive API commits participation policy and reads it back from the live network', async (t) => {
  const keyPair = crypto.keyPair()
  const swarm = new EventEmitter()
  swarm.keyPair = keyPair
  swarm.connections = new Set()
  swarm.join = () => ({ async flushed() {}, destroy() {} })
  const scopedNetwork = createScopedNetworkRuntime({
    swarm,
    initialNetworkPolicy: {
      networkEnabled: true,
      uploadPermission: 'enabled',
      publicServingAllowed: true,
      uploadCeilingBytes: 8192,
      archiveBudgetBytes: 8192,
      contributionBudgetBytes: 8192,
      permissions: { archive: true, contribute: true },
    },
  })
  await scopedNetwork.start()
  const archiveNetwork = createPermissionlessArchiveNetwork({ keyPair, scopedNetwork })
  t.teardown(async () => {
    await archiveNetwork.close()
    await scopedNetwork.close()
  })
  await archiveNetwork.ready
  const api = createArchiveParticipationApi({ archiveNetwork })
  const enabled = await api.setArchiveParticipation({
    enabled: true,
    capacityBytes: 8192,
    maxRequestBytes: 4096,
    acceptancePermille: 375,
  })
  t.is(enabled.success, true)
  t.is(enabled.enabled, true)
  t.is(enabled.capacityBytes, 8192)
  t.is(enabled.maxRequestBytes, 4096)
  t.is(enabled.acceptancePermille, 375, 'permille survives the network probability conversion')
  t.alike(await api.getArchiveParticipation({}), enabled, 'get observes committed policy, not request defaults')
  const disabled = await api.setArchiveParticipation({
    enabled: false,
    capacityBytes: 2048,
    maxRequestBytes: 1024,
    acceptancePermille: 125,
  })
  t.is(disabled.success, true)
  t.is(disabled.enabled, false)
  t.is(disabled.capacityBytes, 2048)
  t.is(disabled.maxRequestBytes, 1024)
  t.is(disabled.acceptancePermille, 125)
  t.alike(await api.getArchiveParticipation({}), disabled, 'disable and revised limits are committed together')
})

test('archive participation rejects out-of-range probability before changing policy', async (t) => {
  const { api, calls } = fixture()
  const result = await api.setArchiveParticipation({
    enabled: true,
    capacityBytes: 8192,
    maxRequestBytes: 4096,
    acceptancePermille: 1001,
  })
  t.is(result.errorCode, 'ARCHIVE_PARTICIPATION_INVALID')
  t.alike(calls, [], 'invalid policy cannot reach the network')
})

test('archive requests reject invalid or unavailable publication and rendition identities', async (t) => {
  const { api, calls } = fixture()
  t.is((await api.requestArchivePublication({ publicationId: 'x', renditionId })).errorCode, 'ARCHIVE_REQUEST_INVALID')
  t.is((await api.requestArchivePublication({ publicationId: 'e'.repeat(64), renditionId })).errorCode, 'ARCHIVE_PUBLICATION_NOT_FOUND')
  t.is((await api.requestArchivePublication({ publicationId, renditionId: 'e'.repeat(64) })).errorCode, 'ARCHIVE_RENDITION_NOT_FOUND')
  t.alike(calls, [], 'unverified identities cannot reach archive admission')
})

test('archive APIs fail closed when the runtime has no signing identity', async (t) => {
  const api = createArchiveParticipationApi({ archiveNetwork: null, manifestStore: null })
  t.is((await api.getArchiveParticipation({})).errorCode, 'ARCHIVE_NETWORK_UNAVAILABLE')
  t.is((await api.setArchiveParticipation({ enabled: true, capacityBytes: 0, maxRequestBytes: 0, acceptancePermille: 0 })).errorCode, 'ARCHIVE_NETWORK_UNAVAILABLE')
  t.is((await api.requestArchivePublication({ publicationId, renditionId })).errorCode, 'ARCHIVE_NETWORK_UNAVAILABLE')
})
