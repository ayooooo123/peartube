import b4a from 'b4a'

export const INDEX_CANDIDATE_CONTRACT_LIMITS = Object.freeze({
  maxCandidates: 64,
  maxCandidateRefBytes: 64,
  maxExternalRefs: 32,
  maxSourceIndexers: 32,
  maxHdrFormats: 16,
  maxAudioTracks: 32,
  maxSubtitleTracks: 64,
  maxTrackLanguages: 32,
  maxTextBytes: 512,
})

const CANDIDATE_REF = /^[A-Za-z0-9_-]{43}$/
const ERROR_CODE = /^[A-Za-z0-9_-]{1,64}$/
const VERIFICATION_STATES = new Set(['unverified', 'source-verified', 'stale', 'rejected'])

function fail(message) {
  const error = new Error(message)
  error.code = 'INDEX_CANDIDATE_CONTRACT_INVALID'
  throw error
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`)
  return value
}

function text(value, name, maximum = INDEX_CANDIDATE_CONTRACT_LIMITS.maxTextBytes, nullable = true) {
  if (value == null && nullable) return null
  if (typeof value !== 'string' || value.length === 0 || b4a.byteLength(value) > maximum) {
    fail(`${name} must be a bounded string`)
  }
  return value
}

function uint(value, name, nullable = true) {
  if (value == null && nullable) return null
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative safe integer`)
  return value
}

function list(value, name, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${name} exceeds its bound`)
  return value
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined))
}

function externalReference(value, index) {
  value = object(value, `externalRefs[${index}]`)
  return Object.freeze({
    namespace: text(value.namespace, `externalRefs[${index}].namespace`, 64, false),
    identifier: text(value.identifier, `externalRefs[${index}].identifier`, 512, false),
  })
}

function episode(value) {
  if (value == null) return null
  value = object(value, 'episode')
  return Object.freeze({
    seriesEntityId: text(value.seriesEntityId, 'episode.seriesEntityId', 128, false),
    seasonNumber: uint(value.seasonNumber, 'episode.seasonNumber', false),
    episodeNumber: uint(value.episodeNumber, 'episode.episodeNumber', false),
  })
}

function work(value) {
  value = object(value, 'work')
  return Object.freeze(compact({
    entityId: text(value.entityId, 'work.entityId', 128, false),
    title: text(value.title, 'work.title'),
    releaseYear: uint(value.releaseYear, 'work.releaseYear'),
    externalRefs: Object.freeze(list(value.externalRefs, 'work.externalRefs', INDEX_CANDIDATE_CONTRACT_LIMITS.maxExternalRefs)
      .map(externalReference)),
    episode: episode(value.episode),
  }))
}

function edition(value) {
  if (value == null) return null
  value = object(value, 'edition')
  const result = compact({
    entityId: text(value.entityId, 'edition.entityId', 128),
    label: text(value.label, 'edition.label'),
    kind: text(value.kind, 'edition.kind', 64),
  })
  return Object.keys(result).length === 0 ? null : Object.freeze(result)
}

function publication(value) {
  value = object(value, 'publication')
  return Object.freeze(compact({
    publicationId: text(value.publicationId, 'publication.publicationId', 128, false),
    publisherId: text(value.publisherId, 'publication.publisherId', 128, false),
    manifestId: text(value.manifestId, 'publication.manifestId', 128, false),
    catalogEpoch: uint(value.catalogEpoch, 'publication.catalogEpoch'),
    catalogHead: text(value.catalogHead, 'publication.catalogHead', 128),
    title: text(value.descriptor?.title ?? value.title, 'publication.title'),
  }))
}

function audioTrack(value, trackIndex) {
  value = object(value, `audioTracks[${trackIndex}]`)
  return Object.freeze(compact({
    codec: text(value.codec, `audioTracks[${trackIndex}].codec`, 128),
    channels: uint(value.channels, `audioTracks[${trackIndex}].channels`),
    languages: Object.freeze(list(value.languages || [], `audioTracks[${trackIndex}].languages`, INDEX_CANDIDATE_CONTRACT_LIMITS.maxTrackLanguages)
      .map((language, languageIndex) => text(language, `audioTracks[${trackIndex}].languages[${languageIndex}]`, 64, false))),
  }))
}

function subtitleTrack(value, index) {
  value = object(value, `subtitleTracks[${index}]`)
  return Object.freeze(compact({
    format: text(value.format, `subtitleTracks[${index}].format`, 128),
    language: text(value.language, `subtitleTracks[${index}].language`, 64),
  }))
}

function rendition(value) {
  value = object(value, 'rendition')
  return Object.freeze(compact({
    renditionId: text(value.renditionId, 'rendition.renditionId', 128, false),
    container: text(value.container, 'rendition.container', 128),
    videoCodec: text(value.videoCodec, 'rendition.videoCodec', 128),
    width: uint(value.width, 'rendition.width'),
    height: uint(value.height, 'rendition.height'),
    resolutionLabel: text(value.resolutionLabel, 'rendition.resolutionLabel', 128),
    hdrFormats: Object.freeze(list(value.hdrFormats || [], 'rendition.hdrFormats', INDEX_CANDIDATE_CONTRACT_LIMITS.maxHdrFormats)
      .map((format, index) => text(format, `rendition.hdrFormats[${index}]`, 128, false))),
    audioTracks: Object.freeze(list(value.audioTracks || [], 'rendition.audioTracks', INDEX_CANDIDATE_CONTRACT_LIMITS.maxAudioTracks)
      .map(audioTrack)),
    subtitleTracks: Object.freeze(list(value.subtitleTracks || [], 'rendition.subtitleTracks', INDEX_CANDIDATE_CONTRACT_LIMITS.maxSubtitleTracks)
      .map(subtitleTrack)),
    purpose: text(value.purpose, 'rendition.purpose', 128),
    byteLength: uint(value.byteLength, 'rendition.byteLength', false),
  }))
}

function asset(value) {
  value = object(value, 'asset')
  return Object.freeze(compact({
    assetId: text(value.assetId, 'asset.assetId', 128, false),
    coreKey: text(value.coreKey, 'asset.coreKey', 128),
    treeHash: text(value.treeHash, 'asset.treeHash', 128),
    blockLength: uint(value.blockLength, 'asset.blockLength'),
    blockSize: uint(value.blockSize, 'asset.blockSize'),
    byteLength: uint(value.byteLength, 'asset.byteLength', false),
  }))
}

function provenance(value) {
  value = object(value, 'provenance')
  return Object.freeze(compact({
    sourceKind: text(value.sourceKind, 'provenance.sourceKind', 128),
    releaseName: text(value.releaseName, 'provenance.releaseName'),
    publicInfohash: text(value.publicInfohash, 'provenance.publicInfohash', 128),
  }))
}

function availability(value) {
  value = object(value, 'availability')
  return Object.freeze(compact({
    peers: uint(value.peers, 'availability.peers'),
    completeSeeders: uint(value.completeSeeders, 'availability.completeSeeders'),
    observedAtMs: uint(value.observedAtMs, 'availability.observedAtMs'),
    expiresAtMs: uint(value.expiresAtMs, 'availability.expiresAtMs'),
  }))
}

function publisherDescriptor(value) {
  if (value == null) return null
  value = object(value, 'verification.publisherDescriptor')
  return Object.freeze({
    publisherId: text(value.publisherId, 'verification.publisherDescriptor.publisherId', 128, false),
    genesisRootKey: text(value.genesisRootKey, 'verification.publisherDescriptor.genesisRootKey', 128, false),
    catalogBootstrapKey: text(value.catalogBootstrapKey, 'verification.publisherDescriptor.catalogBootstrapKey', 128, false),
    catalogEpoch: uint(value.catalogEpoch, 'verification.publisherDescriptor.catalogEpoch', false),
  })
}

function catalogHead(value) {
  if (value == null) return null
  value = object(value, 'verification.catalogHead')
  return Object.freeze(compact({
    viewKey: text(value.viewKey, 'verification.catalogHead.viewKey', 128, false),
    length: uint(value.length, 'verification.catalogHead.length', false),
    digest: text(value.digest, 'verification.catalogHead.digest', 128, false),
    authorizationStateDigest: text(value.authorizationStateDigest, 'verification.catalogHead.authorizationStateDigest', 128),
  }))
}

function verification(value) {
  value = object(value, 'verification')
  const state = text(value.state, 'verification.state', 32, false)
  if (!VERIFICATION_STATES.has(state)) fail('verification.state is invalid')
  return Object.freeze(compact({
    state,
    publisherDescriptor: publisherDescriptor(value.publisherDescriptor),
    catalogHead: catalogHead(value.catalogHead),
  }))
}

function sourceIndexer(value, index) {
  value = object(value, `sourceIndexers[${index}]`)
  return Object.freeze({
    indexerId: text(value.indexerId, `sourceIndexers[${index}].indexerId`, 256, false),
    observedAtMs: uint(value.observedAtMs, `sourceIndexers[${index}].observedAtMs`, false),
  })
}

export function normalizeIndexSearchSelector(value) {
  value = object(value, 'selector')
  return Object.freeze({
    namespace: text(value.namespace, 'selector.namespace', 64, false),
    identifier: text(value.identifier, 'selector.identifier', 512, false),
    kind: text(value.kind, 'selector.kind', 64, false),
  })
}

export function normalizeIndexCandidateForTransport(value) {
  value = object(value, 'candidate')
  if (value.schemaVersion !== 2) fail('candidate.schemaVersion is invalid')
  const candidateRef = text(value.candidateRef, 'candidate.candidateRef', INDEX_CANDIDATE_CONTRACT_LIMITS.maxCandidateRefBytes, false)
  if (!CANDIDATE_REF.test(candidateRef)) fail('candidate.candidateRef is invalid')
  return Object.freeze(compact({
    schemaVersion: 2,
    candidateRef,
    work: work(value.work),
    edition: edition(value.edition),
    publication: publication(value.publication),
    rendition: rendition(value.rendition),
    asset: asset(value.asset),
    provenance: provenance(value.provenance),
    availability: availability(value.availability),
    verification: verification(value.verification),
    sourceIndexers: Object.freeze(list(value.sourceIndexers, 'sourceIndexers', INDEX_CANDIDATE_CONTRACT_LIMITS.maxSourceIndexers)
      .map(sourceIndexer)),
  }))
}

function failure(error, message, candidates) {
  const errorCode = typeof error?.code === 'string' && ERROR_CODE.test(error.code)
    ? error.code
    : 'INDEX_CANDIDATE_REQUEST_FAILED'
  return Object.freeze({ success: false, ...candidates, errorCode, errorMessage: message })
}

export async function searchIndexCandidatesForTransport(api, request) {
  try {
    if (!api || typeof api.searchIndexCandidates !== 'function') fail('searchIndexCandidates is unsupported')
    const selector = normalizeIndexSearchSelector(object(request, 'request').selector)
    const values = await api.searchIndexCandidates(selector)
    return Object.freeze({
      success: true,
      candidates: Object.freeze(list(values, 'candidates', INDEX_CANDIDATE_CONTRACT_LIMITS.maxCandidates)
        .map(normalizeIndexCandidateForTransport)),
    })
  } catch (error) {
    return failure(error, 'index candidate search failed', { candidates: Object.freeze([]) })
  }
}

export async function verifyIndexCandidateForTransport(api, request) {
  try {
    if (!api || typeof api.verifyIndexCandidate !== 'function') fail('verifyIndexCandidate is unsupported')
    request = object(request, 'request')
    const candidateRef = text(request.candidateRef, 'candidateRef', INDEX_CANDIDATE_CONTRACT_LIMITS.maxCandidateRefBytes, false)
    if (!CANDIDATE_REF.test(candidateRef)) fail('candidateRef is invalid')
    const candidate = normalizeIndexCandidateForTransport(await api.verifyIndexCandidate(candidateRef))
    if (candidate.verification.state !== 'source-verified') fail('verified candidate state is invalid')
    return Object.freeze({ success: true, candidate })
  } catch (error) {
    return failure(error, 'index candidate verification failed', {})
  }
}
