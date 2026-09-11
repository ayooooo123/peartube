import { extname } from '#path'
import * as fs from '#fs'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import { normalizePrivateArtwork } from './artwork-sources.js'

const MIME_BY_EXT = Object.freeze({
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo'
})

export function mimeTypeForPath (filePath, fallback = 'video/mp4') {
  if (typeof filePath !== 'string' || !filePath) return fallback
  const ext = extname(filePath).toLowerCase()
  return MIME_BY_EXT[ext] || fallback
}


export function canonicalLocalFileIdempotencyKey (sha256) {
  const hex = String(sha256 || '').trim().toLowerCase().replace(/^sha256:/, '')
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('sha256 must be a 64-hex content digest for canonical local file idempotency key')
  }
  return `local_${hex.slice(0, 32)}`
}

function normalizeKind (kind) {
  if (kind === 'episode') return 'episode'
  if (kind === 'video' || !kind) return 'movie'
  return kind
}

function isEpisodic (kind, season, episode) {
  return kind === 'episode' &&
    Number.isSafeInteger(season) && season > 0 &&
    Number.isSafeInteger(episode) && episode > 0
}

export function canonicalLocalFileSelector ({
  sha256,
  kind = 'movie',
  namespace = null,
  identifier = null,
  season = null,
  episode = null
} = {}) {
  const hex = String(sha256 || '').trim().toLowerCase().replace(/^sha256:/, '')
  namespace = typeof namespace === 'string' ? namespace.trim() : ''
  identifier = typeof identifier === 'string' ? identifier.trim() : ''
  const externalIdentity = namespace.length > 0 && identifier.length > 0
  if (!/^[0-9a-f]{64}$/.test(hex) && !externalIdentity) {
    throw new Error('sha256 must be a 64-hex content digest when selector identifier is absent')
  }
  const selectedNamespace = externalIdentity ? namespace : 'peartube'
  const selectedIdentifier = externalIdentity ? identifier : hex.slice(0, 32)

  if (isEpisodic(kind, season, episode)) {
    return Object.freeze({
      kind: 'episode',
      namespace: selectedNamespace,
      identifier: selectedIdentifier,
      season,
      episode
    })
  }
  return Object.freeze({
    kind: normalizeKind(kind),
    namespace: selectedNamespace,
    identifier: selectedIdentifier
  })
}
export function canonicalLocalResolutionRecord ({
  sha256,
  byteLength,
  title = null,
  fileName = null,
  kind = 'movie',
  namespace = null,
  identifier = null,
  season = null,
  episode = null,
  retentionClass = 'archive-pin'
} = {}) {
  const hex = String(sha256 || '').trim().toLowerCase().replace(/^sha256:/, '')
  if (!hex) throw new Error('sha256 is required for canonical local resolution record')

  const safeFileName = sourceFileNameOf(fileName) || `${hex.slice(0, 16)}.mp4`
  const safeTitle = title && String(title).trim() !== ''
    ? String(title).trim()
    : safeFileName.replace(/\.[^.]+$/, '') || 'Local video'
  const normalizedKind = (kind === 'episode') ? 'episode' : (kind === 'video' || !kind ? 'movie' : kind)
  const selector = canonicalLocalFileSelector({
    sha256: hex,
    kind: normalizedKind,
    namespace,
    identifier,
    season,
    episode
  })

  return Object.freeze({
    idempotencyKey: canonicalLocalFileIdempotencyKey(hex),
    title: safeTitle,
    selector,
    expectedBytes: Number(byteLength),
    retentionClass,
    sourceFileName: safeFileName
  })
}


export async function sha256File (filePath, fsModule = fs) {
  const state = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
  sodium.crypto_hash_sha256_init(state)
  for await (const chunk of fsModule.createReadStream(filePath)) {
    let bytes = chunk
    if (typeof bytes === 'string') bytes = b4a.from(bytes)
    else if (!(bytes instanceof Uint8Array) && ArrayBuffer.isView(bytes)) {
      // Sodium's native span conversion does not read DataView metadata.
      bytes = b4a.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    }
    sodium.crypto_hash_sha256_update(state, bytes)
  }
  const digest = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256_final(state, digest)
  return b4a.toString(digest, 'hex')
}

const MAX_LOCAL_DURATION_SECONDS = 10_000_000
const TERMINAL_ACQUISITION_STATES = new Set(['verified', 'completed', 'failed', 'cancelled'])

export function normalizeLocalDurationSeconds (value) {
  if (value == null || value === '') return null
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const rounded = Math.round(seconds)
  if (!Number.isSafeInteger(rounded) || rounded < 1 || rounded > MAX_LOCAL_DURATION_SECONDS) return null
  return rounded
}

function sourceFileNameOf (fileName) {
  if (typeof fileName !== 'string' || !fileName) return null
  const base = fileName.split(/[/\\]/).filter(Boolean).pop() || ''
  const trimmed = base.trim()
  return trimmed ? trimmed.slice(0, 255) : null
}

function buildLocalResolution (runtime, { input, publisherId, requestKey, durationSeconds, artwork }) {
  return runtime.issueLocalProviderResolution({
    title: input.title,
    selector: input.selector,
    publisherId,
    idempotencyKey: requestKey,
    expectedBytes: input.expectedBytes,
    sourceFileName: sourceFileNameOf(input.sourceFileName),
    ...(input.description != null ? { description: input.description } : {}),
    ...(input.tags != null ? { tags: input.tags } : {}),
    ...(input.creatorName != null ? { creatorName: input.creatorName } : {}),
    ...(input.creatorHandle != null ? { creatorHandle: input.creatorHandle } : {}),
    ...(durationSeconds != null ? { duration: durationSeconds } : {}),
    artworkRoles: artwork.map(entry => entry.role),
  })
}

function assertAcquisitionRequested (acquisition) {
  if (!acquisition) {
    throw new Error('Local acquisition request did not return a result')
  }
  if (acquisition.state === 'cancelled' || (acquisition.state === 'failed' && acquisition.recoverable !== true)) {
    const error = new Error(acquisition.errorCode || 'Local acquisition failed')
    error.code = acquisition.errorCode || 'ACQUISITION_FAILED'
    error.acquisition = acquisition
    throw error
  }
}

function createAcquisitionCanceller ({ runtime, acquisitionId, effectivePrincipal }) {
  let cancellationPromise = null
  return function cancelCanonicalAcquisition () {
    if (!acquisitionId) return Promise.resolve(null)
    if (!cancellationPromise) {
      cancellationPromise = (async () => {
        if (typeof runtime.provider.cancelAcquisition !== 'function') {
          const error = new Error('Local acquisition cancellation is unavailable')
          error.code = 'ACQUISITION_CANCEL_UNAVAILABLE'
          throw error
        }
        const cancelled = await runtime.provider.cancelAcquisition({
          acquisitionId,
          principal: effectivePrincipal
        })
        const latest = cancelled || await runtime.provider.getAcquisition?.({
          acquisitionId,
          principal: effectivePrincipal
        })
        if (latest?.state && !TERMINAL_ACQUISITION_STATES.has(latest.state)) {
          const error = new Error(`Local acquisition cancellation returned a running job: ${latest.state}`)
          error.code = 'ACQUISITION_CANCEL_INCOMPLETE'
          error.acquisition = latest
          throw error
        }
        return latest
      })()
      cancellationPromise.catch(() => {})
    }
    return cancellationPromise
  }
}

async function attachSourceGrantOrRecover ({
  runtime,
  acquisitionId,
  effectivePrincipal,
  input,
  artwork,
  now,
  policy,
  signal,
  cancelCanonicalAcquisition
}) {
  const ttl = policy?.sourceGrantTtlMs || 24 * 60 * 60 * 1000
  const grant = runtime.localFileSourceGrants.issue({
    acquisitionId,
    principalId: effectivePrincipal.principalId,
    path: input.path,
    mimeType: input.mimeType || 'application/octet-stream',
    artwork,
    expiresAt: now() + ttl,
    dispose: input.dispose || null
  })

  try {
    const attached = await runtime.provider.attachSourceGrant({
      acquisitionId,
      grant,
      principal: effectivePrincipal
    })
    return { attached }
  } catch (error) {
    if (signal?.aborted) {
      const cancelled = await cancelCanonicalAcquisition()
      await runtime.localFileSourceGrants.revoke(grant.token).catch(() => {})
      if (!cancelled) throw new Error('Local acquisition cancellation returned no job')
      return { terminalResult: { ...cancelled, sourceAccepted: false } }
    }
    await runtime.localFileSourceGrants.revoke(grant.token).catch(() => {})
    if (error?.code === 'ACQUISITION_NOT_QUEUED') {
      const latest = await runtime.provider.getAcquisition({
        acquisitionId,
        principal: effectivePrincipal
      })
      if (latest) return { terminalResult: { ...latest, sourceAccepted: false } }
    }
    await runtime.provider.cancelAcquisition({
      acquisitionId,
      principal: effectivePrincipal
    }).catch(() => {})
    throw error
  }
}

async function waitForAcquisitionCompletion ({
  runtime,
  acquisitionId,
  effectivePrincipal,
  attached,
  signal,
  cancelCanonicalAcquisition,
  throwOnFailure
}) {
  let latest = attached
  while (latest && !TERMINAL_ACQUISITION_STATES.has(latest.state)) {
    if (signal?.aborted) {
      const cancelled = await cancelCanonicalAcquisition()
      if (!cancelled) throw new Error('Local acquisition cancellation returned no job')
      return { ...cancelled, sourceAccepted: true }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
    latest = await runtime.provider.getAcquisition({
      acquisitionId,
      principal: effectivePrincipal
    })
  }
  if (signal?.aborted) {
    const cancelled = await cancelCanonicalAcquisition()
    if (!cancelled) throw new Error('Local acquisition cancellation returned no job')
    return { ...cancelled, sourceAccepted: true }
  }
  if (latest?.state === 'failed' && throwOnFailure !== false) {
    const error = new Error(latest.errorCode || 'Local file acquisition failed')
    error.code = latest.errorCode || 'ACQUISITION_FAILED'
    error.acquisition = latest
    throw error
  }
  return { ...latest, sourceAccepted: true }
}

function effectiveLocalPrincipal(principal, publisherId) {
  if (principal) return principal
  return {
    id: 'local-provider',
    principalId: 'local-provider',
    isLocal: true,
    publisherIds: [publisherId],
    scopes: new Set(['*'])
  }
}

function requireLocalIdempotencyKey(input) {
  const rawKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : ''
  if (!rawKey) {
    const error = new Error('idempotencyKey is required for local file acquisition')
    error.code = 'IDEMPOTENCY_KEY_INVALID'
    throw error
  }
  return rawKey
}

async function requestLocalFileAcquisition({ runtime, effectivePrincipal, publisherId, requestKey, resolution, input }) {
  const acquisition = await runtime.provider.requestAcquisition({
    idempotencyKey: requestKey,
    request: {
      schemaVersion: 1,
      resolutionRef: resolution.resolutionRef,
      publisherId,
      retentionClass: input.retentionClass || 'archive-pin',
      sourceFileName: sourceFileNameOf(input.sourceFileName)
    },
    principal: effectivePrincipal
  })
  assertAcquisitionRequested(acquisition)
  return acquisition
}

function registerAcquisitionAbortListener(signal, cancelCanonicalAcquisition) {
  if (!signal?.addEventListener) return null
  const onAbort = () => {
    cancelCanonicalAcquisition().catch(() => {})
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  return () => {
    signal.removeEventListener?.('abort', onAbort)
  }
}

async function cancelledLocalAcquisitionResult(signal, cancelCanonicalAcquisition) {
  if (!signal?.aborted) return null
  const cancelled = await cancelCanonicalAcquisition()
  if (!cancelled) throw new Error('Local acquisition cancellation returned no job')
  return { ...cancelled, sourceAccepted: false }
}

export async function executeLocalFileAcquisition ({
  runtime,
  publisherId,
  principal,
  policy = null,
  input = {},
  now = Date.now
} = {}) {
  if (!runtime?.provider) throw new Error('runtime provider is required for local file acquisition')
  if (!publisherId) throw new Error('publisherId is required for local file acquisition')

  const effectivePrincipal = effectiveLocalPrincipal(principal, publisherId)
  const requestKey = requireLocalIdempotencyKey(input)
  const durationSeconds = normalizeLocalDurationSeconds(input.duration)
  const artwork = normalizePrivateArtwork(input.artwork || [])

  const resolution = buildLocalResolution(runtime, { input, publisherId, requestKey, durationSeconds, artwork })

  const acquisition = await requestLocalFileAcquisition({ runtime, effectivePrincipal, publisherId, requestKey, resolution, input })

  const acquisitionId = acquisition.acquisitionId
  const signal = input.signal || null
  const cancelCanonicalAcquisition = createAcquisitionCanceller({ runtime, acquisitionId, effectivePrincipal })
  const unregisterAbort = registerAcquisitionAbortListener(signal, cancelCanonicalAcquisition)

  try {
    const cancelled = await cancelledLocalAcquisitionResult(signal, cancelCanonicalAcquisition)
    if (cancelled) return cancelled

    if (acquisition.state !== 'queued') {
      return { ...acquisition, sourceAccepted: false }
    }

    const { attached, terminalResult } = await attachSourceGrantOrRecover({
      runtime,
      acquisitionId,
      effectivePrincipal,
      input,
      artwork,
      now,
      policy,
      signal,
      cancelCanonicalAcquisition
    })
    if (terminalResult) return terminalResult

    if (input.awaitCompletion === true) {
      return await waitForAcquisitionCompletion({
        runtime,
        acquisitionId,
        effectivePrincipal,
        attached,
        signal,
        cancelCanonicalAcquisition,
        throwOnFailure: input.throwOnFailure
      })
    }

    return { ...attached, sourceAccepted: true }
  } finally {
    if (signal?.aborted) await cancelCanonicalAcquisition()
    unregisterAbort?.()
  }
}
