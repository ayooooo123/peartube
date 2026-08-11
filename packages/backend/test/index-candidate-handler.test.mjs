import test from 'brittle'

import { attachMobileHandlers } from '../src/mobile-handlers.js'
import { buildSharedSystemHandlers } from '../src/runtime.js'
import {
  INDEX_CANDIDATE_CONTRACT_LIMITS,
  normalizeIndexCandidateForTransport,
} from '../src/search/candidate-contract.js'

const CANDIDATE_REF = 'A'.repeat(43)

function candidate(state = 'unverified') {
  const verified = state === 'source-verified'
  return {
    schemaVersion: 2,
    candidateRef: CANDIDATE_REF,
    work: {
      entityId: 'work-1',
      title: 'Pilot',
      releaseYear: null,
      externalRefs: [{ namespace: 'tmdb', identifier: '348', streamUrl: 'https://forbidden.invalid/work' }],
      episode: null,
    },
    edition: null,
    publication: {
      publicationId: '11'.repeat(32),
      publisherId: '22'.repeat(32),
      manifestId: '33'.repeat(32),
      catalogEpoch: verified ? 3 : null,
      catalogHead: verified ? '44'.repeat(32) : null,
    },
    rendition: {
      renditionId: '55'.repeat(32),
      container: 'video/mp4',
      videoCodec: null,
      width: null,
      height: null,
      resolutionLabel: null,
      hdrFormats: [],
      audioTracks: [],
      subtitleTracks: [],
      purpose: verified ? 'original' : null,
      byteLength: 1024,
      downloadUrl: 'https://forbidden.invalid/rendition',
    },
    asset: {
      assetId: '66'.repeat(32),
      coreKey: verified ? '66'.repeat(32) : null,
      treeHash: verified ? '77'.repeat(32) : null,
      blockLength: verified ? 1 : null,
      blockSize: verified ? 1024 : null,
      byteLength: 1024,
      credential: 'forbidden',
    },
    provenance: { sourceKind: null, releaseName: null, publicInfohash: null },
    availability: verified
      ? { peers: 2, completeSeeders: 1, observedAtMs: 10, expiresAtMs: 20 }
      : { peers: null, completeSeeders: null, observedAtMs: null, expiresAtMs: null },
    verification: verified
      ? {
          state,
          publisherDescriptor: {
            publisherId: '22'.repeat(32),
            genesisRootKey: '88'.repeat(32),
            catalogBootstrapKey: '99'.repeat(32),
            catalogEpoch: 3,
          },
          catalogHead: {
            viewKey: 'aa'.repeat(32),
            length: 7,
            digest: '44'.repeat(32),
            authorizationStateDigest: 'bb'.repeat(32),
          },
        }
      : { state },
    sourceIndexers: [{ indexerId: 'cc'.repeat(32), observedAtMs: 5 }],
    streamUrl: 'https://forbidden.invalid/play',
    sourceRecordRef: 'forbidden-source-ref',
  }
}

function forbiddenKeys(value, path = '') {
  if (!value || typeof value !== 'object') return []
  const found = []
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key
    if (/url|credential|cookie|controlcapability|sourcerecordref/i.test(key)) found.push(next)
    found.push(...forbiddenKeys(child, next))
  }
  return found
}

test('candidate transport is bounded, typed, and strips non-contract capabilities', (t) => {
  const value = normalizeIndexCandidateForTransport(candidate())
  t.alike(forbiddenKeys(value), [])
  t.is(value.candidateRef, CANDIDATE_REF)
  t.is(value.verification.state, 'unverified')
  t.absent(Object.hasOwn(value.publication, 'catalogEpoch'))
  t.absent(Object.hasOwn(value.publication, 'catalogHead'))
  t.absent(Object.hasOwn(value.rendition, 'videoCodec'))
  t.absent(Object.hasOwn(value.availability, 'observedAtMs'))
  t.absent(Object.hasOwn(value, 'edition'))
  const partial = candidate()
  partial.work.title = null
  partial.rendition.container = null
  const partialValue = normalizeIndexCandidateForTransport(partial)
  t.absent(Object.hasOwn(partialValue.work, 'title'))
  t.absent(Object.hasOwn(partialValue.rendition, 'container'))

  const oversized = candidate()
  oversized.sourceIndexers = Array.from(
    { length: INDEX_CANDIDATE_CONTRACT_LIMITS.maxSourceIndexers + 1 },
    () => ({ indexerId: 'index', observedAtMs: 1 }),
  )
  t.exception(() => normalizeIndexCandidateForTransport(oversized), /sourceIndexers exceeds its bound/)
  t.exception(() => normalizeIndexCandidateForTransport({ ...candidate(), candidateRef: 'network-identity' }), /candidateRef is invalid/)
})

test('shared runtime handlers defer selected verification and preserve structured codes', async (t) => {
  const calls = []
  const api = {
    async searchIndexCandidates(selector) {
      calls.push(['search', selector])
      return [candidate()]
    },
    async verifyIndexCandidate(candidateRef) {
      calls.push(['verify', candidateRef])
      return candidate('source-verified')
    },
  }
  const handlers = buildSharedSystemHandlers({ api }, { protocolVersion: 1 })
  const searched = await handlers.SearchIndexCandidates({ selector: { namespace: 'tmdb', identifier: '348', kind: 'movie' } })
  t.ok(searched.success)
  t.is(searched.candidates.length, 1)
  t.alike(calls.map(call => call[0]), ['search'])
  t.alike(forbiddenKeys(searched), [])

  const verified = await handlers.VerifyIndexCandidate({ candidateRef: CANDIDATE_REF })
  t.ok(verified.success)
  t.is(verified.candidate.verification.state, 'source-verified')
  t.alike(calls.map(call => call[0]), ['search', 'verify'])
  t.alike(forbiddenKeys(verified), [])

  const failureHandlers = buildSharedSystemHandlers({
    api: {
      async searchIndexCandidates() {
        return Array.from({ length: INDEX_CANDIDATE_CONTRACT_LIMITS.maxCandidates + 1 }, () => candidate())
      },
      async verifyIndexCandidate() {
        const error = new Error('secret https://forbidden.invalid/play')
        error.code = 'source-not-current'
        throw error
      },
    },
  }, { protocolVersion: 1 })
  const oversized = await failureHandlers.SearchIndexCandidates({ selector: { namespace: 'tmdb', identifier: '348', kind: 'movie' } })
  t.is(oversized.success, false)
  t.alike(oversized.candidates, [])
  t.is(oversized.errorCode, 'INDEX_CANDIDATE_CONTRACT_INVALID')
  const stale = await failureHandlers.VerifyIndexCandidate({ candidateRef: CANDIDATE_REF })
  t.is(stale.success, false)
  t.is(stale.errorCode, 'source-not-current')
  t.is(stale.errorMessage, 'index candidate verification failed')
  t.absent(JSON.stringify(stale).includes('forbidden.invalid'))
})

test('mobile HRPC handlers call the same bounded backend adapter', async (t) => {
  const calls = []
  const api = {
    async searchIndexCandidates(selector) {
      calls.push(['search', selector])
      return [candidate()]
    },
    async verifyIndexCandidate(candidateRef) {
      calls.push(['verify', candidateRef])
      return candidate('source-verified')
    },
  }
  const backend = {}
  attachMobileHandlers(backend, { api, identityManager: {}, rpc: {} })

  const searched = await backend.searchIndexCandidates({ selector: { namespace: 'tmdb', identifier: '348', kind: 'movie' } })
  const verified = await backend.verifyIndexCandidate({ candidateRef: CANDIDATE_REF })
  t.ok(searched.success)
  t.ok(verified.success)
  t.alike(calls.map(call => call[0]), ['search', 'verify'])
  t.alike(forbiddenKeys({ searched, verified }), [])
})
