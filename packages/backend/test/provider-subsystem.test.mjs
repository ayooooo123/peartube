import test from 'brittle'

import {
  CLOSED_ACQUISITION_POLICY,
} from '../src/acquisition/index.js'
import { createProviderSubsystem } from '../src/provider/subsystem.js'

const NOW = 1_787_788_800_000
const PUBLISHER_ID = 'a'.repeat(64)

function fakeBee() {
  const entries = new Map()
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
  const apply = operations => {
    for (const [operation, key, value] of operations) {
      if (operation === 'put') entries.set(key, clone(value))
      else entries.delete(key)
    }
  }
  return {
    entries,
    async get(key) { return entries.has(key) ? { value: clone(entries.get(key)) } : null },
    async put(key, value) { apply([['put', key, value]]) },
    async del(key) { apply([['del', key]]) },
    batch() {
      const operations = []
      return {
        async put(key, value) { operations.push(['put', key, value]) },
        async del(key) { operations.push(['del', key]) },
        async flush() { apply(operations) },
      }
    },
    async * createReadStream({ gte, lt }) {
      for (const key of [...entries.keys()].sort()) {
        if (key >= gte && key < lt) yield { key, value: clone(entries.get(key)) }
      }
    },
  }
}

function queryView() {
  return {
    async query() { return { results: [], nextCursor: null } },
    async getEntity() { return null },
    async getPublication() { return null },
    async getManifest() { return null },
    async getRendition() { return null },
    async authorizeRendition() { return false },
    async isVisible() { return true },
  }
}

function openPolicy() {
  return {
    ...CLOSED_ACQUISITION_POLICY,
    migrationRequired: false,
    enabled: true,
    allowedPublisherIds: [PUBLISHER_ID],
    allowedAdapterIds: ['local-file'],
    maxQueuedJobs: 8,
    maxConcurrentJobs: 1,
    maxConcurrentPerRequester: 1,
    maxRequestBytes: 4096,
    maxAcquireBytesPer24h: 1024,
    maxAcquireBytesPerSecond: 1024,
    maxStagingBytes: 1024,
    minFreeDiskBytes: 1,
    maxJobRuntimeMs: 60_000,
    sourceGrantTtlMs: 30_000,
    publicRequestsPerMinute: 1,
    maxAttempts: 2,
    retryBaseMs: 1,
    retryMaxMs: 10,
  }
}

async function fixture() {
  const metaDb = fakeBee()
  const subsystem = await createProviderSubsystem({
    ctx: { metaDb, store: {} },
    verifiedQueryView: queryView(),
    indexVerificationRuntime: {
      async searchIndexCandidates() { return [] },
      async verifyIndexCandidate() { throw new Error('not found') },
    },
    uploadManager: {
      async hasPublisherAuthority() { return true },
      async getAuthorizedPublisherIds() { return [PUBLISHER_ID] },
      async getAcquiredPublication() { return null },
      async publishAcquiredAsset() { throw new Error('not used') },
    },
    mediaApi: { async openMediaRenditionUrl() { return { success: false } } },
    config: {},
    now: () => NOW,
  })
  return { metaDb, subsystem }
}

test('provider subsystem persists acquisition policy and revision with one CAS winner', async t => {
  const { metaDb, subsystem } = await fixture()
  const initial = await subsystem.api.getAcquisitionPolicy()
  t.is(initial.success, true)
  t.is(initial.policy.revision, 0)

  const request = {
    expectedRevision: 0,
    policy: { ...openPolicy(), revision: 0 },
    consent: { version: 1, granted: true },
  }
  const results = await Promise.all([
    subsystem.api.setAcquisitionPolicy(request),
    subsystem.api.setAcquisitionPolicy(request),
  ])
  t.is(results.filter(result => result.success).length, 1)
  t.is(results.filter(result => !result.success && result.error.code === 'ACQUISITION_POLICY_REVISION_CONFLICT').length, 1)
  t.is((await metaDb.get('acquisition/policy-revision/v1')).value, 1)
  t.alike((await metaDb.get('acquisition/policy/v1')).value, openPolicy())

  const current = await subsystem.api.getAcquisitionPolicy()
  t.is(current.policy.revision, 1)
  t.is(current.policy.enabled, true)
  await subsystem.close()
})

test('provider subsystem issues bounded local resolutions without storing source material', async t => {
  const { subsystem } = await fixture()
  const input = {
    title: 'Local title',
    selector: { namespace: 'catalog', identifier: 'title-1', kind: 'movie' },
    publisherId: PUBLISHER_ID,
    expectedBytes: 8,
    idempotencyKey: 'local-smoke-1',
  }
  const resolution = subsystem.issueLocalResolution(input)
  const replayedResolution = subsystem.issueLocalResolution(input)
  t.is(resolution.kind, 'acquirable')
  t.is(resolution.publisherId, PUBLISHER_ID)
  t.is(resolution.expected.byteLength, 8)
  t.is(replayedResolution.resolutionRef, resolution.resolutionRef)
  t.absent(JSON.stringify(resolution).match(/(?:file|https?):/i))
  await subsystem.close()
})
